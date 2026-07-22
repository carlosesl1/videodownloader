using System.Text.Json;

namespace VideoRadar.NativeHost.YouTube;

public sealed record QualityOption(int Height, string Label, string Container, bool Combined);

public sealed record FormatCatalog(string VideoId, string Title, double? DurationSeconds, IReadOnlyList<QualityOption> Qualities)
{
    private const string SafeMetadataError = "Invalid YouTube metadata.";

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

            var parsedFormats = formats.EnumerateArray().Select(ParseFormat).ToList();
            var hasM4aAudio = parsedFormats.Any(format => format.IsM4aAudio);
            var qualities = parsedFormats
                .Where(format => format.Height > 0 && format.IsVideo)
                .GroupBy(format => format.Height)
                .OrderByDescending(group => group.Key)
                .Select(group => CreateQuality(group.Key, group, hasM4aAudio))
                .ToList();

            if (qualities.Count == 0) throw new InvalidDataException(SafeMetadataError);
            return new FormatCatalog(videoId, title, duration, qualities);
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException(SafeMetadataError, exception);
        }
    }

    private static QualityOption CreateQuality(int height, IEnumerable<ParsedFormat> formats, bool hasM4aAudio)
    {
        var values = formats.ToList();
        var combinedMp4 = values.Any(format => format.IsCombined && format.IsMp4);
        var videoMp4 = values.Any(format => format.IsVideo && format.IsMp4);
        var combined = values.Any(format => format.IsCombined);
        var container = combinedMp4 || videoMp4 && hasM4aAudio ? "MP4" : "WebM";
        return new QualityOption(height, $"{height}p", container, combined);
    }

    private static ParsedFormat ParseFormat(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) return new ParsedFormat(0, false, false, false, false);

        var height = element.TryGetProperty("height", out var heightElement)
            && heightElement.ValueKind == JsonValueKind.Number
            && heightElement.TryGetInt32(out var value) ? value : 0;
        var videoCodec = GetString(element, "vcodec");
        var audioCodec = GetString(element, "acodec");
        var extension = GetString(element, "ext");
        var isVideo = !IsNone(videoCodec);
        var isAudio = !IsNone(audioCodec);
        return new ParsedFormat(height, isVideo, isVideo && isAudio, IsValue(extension, "mp4"), IsValue(extension, "m4a") && isAudio && !isVideo);
    }

    private static string RequiredString(JsonElement root, string name)
    {
        var value = GetString(root, name);
        if (string.IsNullOrWhiteSpace(value)) throw new InvalidDataException(SafeMetadataError);
        return value!;
    }

    private static bool IsLive(JsonElement root) =>
        root.TryGetProperty("is_live", out var value) && value.ValueKind == JsonValueKind.True;

    private static bool HasPublicAvailability(JsonElement root) =>
        IsValue(GetString(root, "availability"), "public");

    private static double? TryGetNumber(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) ? number : null;

    private static string? GetString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool IsNone(string? value) => IsValue(value, "none");

    private static bool IsValue(string? value, string expected) => string.Equals(value, expected, StringComparison.OrdinalIgnoreCase);

    private sealed record ParsedFormat(int Height, bool IsVideo, bool IsCombined, bool IsMp4, bool IsM4aAudio);
}
