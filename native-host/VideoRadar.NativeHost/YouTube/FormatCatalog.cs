using System.Text.Json;

namespace VideoRadar.NativeHost.YouTube;

public sealed record QualityOption(int Height, string Label, string Container, bool Combined);

public sealed record FormatCatalog(string VideoId, string Title, double? DurationSeconds, IReadOnlyList<QualityOption> Qualities)
{
    private const string SafeMetadataError = "Invalid media metadata.";
    public string Platform { get; init; } = "youtube";

    public static FormatCatalog Parse(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException(SafeMetadataError);

            var videoId = RequiredString(root, "id");
            var title = RequiredString(root, "title");
            if (IsLive(root) || !HasPublicAvailability(root)) throw new InvalidDataException(SafeMetadataError);

            var duration = TryGetNumber(root, "duration");
            if (!root.TryGetProperty("formats", out var formats) || formats.ValueKind != JsonValueKind.Array)
                throw new InvalidDataException(SafeMetadataError);

            var platform = PlatformName(root);
            var parsedFormats = formats.EnumerateArray().Select(ParseFormat).ToList();
            var qualities = MediaFormatPolicy.Qualities(platform, parsedFormats);

            if (qualities.Count == 0) throw new InvalidDataException(SafeMetadataError);
            return new FormatCatalog(videoId, title, duration, qualities)
            {
                Platform = platform
            };
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException(SafeMetadataError, exception);
        }
    }

    private static MediaFormatDescriptor ParseFormat(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) return new MediaFormatDescriptor(0, false, false, false, false);

        var height = element.TryGetProperty("height", out var heightElement)
            && heightElement.ValueKind == JsonValueKind.Number
            && heightElement.TryGetInt32(out var value) ? value : 0;
        var videoCodec = GetString(element, "vcodec");
        var audioCodec = GetString(element, "acodec");
        var extension = GetString(element, "ext");
        var isVideo = !IsNone(videoCodec);
        var isAudio = !IsNone(audioCodec);
        return new MediaFormatDescriptor(height, isVideo, isVideo && isAudio, IsValue(extension, "mp4"), IsValue(extension, "m4a") && isAudio && !isVideo);
    }

    private static string RequiredString(JsonElement root, string name)
    {
        var value = GetString(root, name);
        if (string.IsNullOrWhiteSpace(value)) throw new InvalidDataException(SafeMetadataError);
        return value!;
    }

    private static bool IsLive(JsonElement root) =>
        root.TryGetProperty("is_live", out var value) && value.ValueKind == JsonValueKind.True;

    private static bool HasPublicAvailability(JsonElement root)
    {
        var availability = GetString(root, "availability");
        return string.IsNullOrWhiteSpace(availability)
            || IsValue(availability, "public")
            || IsValue(availability, "unlisted");
    }

    private static string PlatformName(JsonElement root)
    {
        var extractor = GetString(root, "extractor_key") ?? GetString(root, "extractor") ?? string.Empty;
        if (extractor.Contains("tiktok", StringComparison.OrdinalIgnoreCase)) return "tiktok";
        if (extractor.Contains("instagram", StringComparison.OrdinalIgnoreCase)) return "instagram";
        if (extractor.Contains("twitter", StringComparison.OrdinalIgnoreCase)
            || extractor.Equals("x", StringComparison.OrdinalIgnoreCase)) return "x";
        return "youtube";
    }

    private static double? TryGetNumber(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) ? number : null;

    private static string? GetString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool IsNone(string? value) => IsValue(value, "none");

    private static bool IsValue(string? value, string expected) => string.Equals(value, expected, StringComparison.OrdinalIgnoreCase);
}
