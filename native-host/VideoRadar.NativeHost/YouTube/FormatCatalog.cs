using System.Text.Json;
using System.Text.RegularExpressions;

namespace VideoRadar.NativeHost.YouTube;

public sealed record QualityOption(int Height, string Label, string Container, bool Combined)
{
    public double? Fps { get; init; }
    public bool Hdr { get; init; }
    public string? DynamicRange { get; init; }
    public string? VideoCodec { get; init; }
    public string? AudioCodec { get; init; }
    public double? BitrateKbps { get; init; }
    public long? EstimatedSizeBytes { get; init; }
    public bool EstimatedSizeApproximate { get; init; }
}

public sealed record MediaFormatOption(
    string? FormatId,
    int? Height,
    string Container,
    bool Combined,
    bool AudioOnly,
    double? Fps,
    bool Hdr,
    string? DynamicRange,
    string? VideoCodec,
    string? AudioCodec,
    double? BitrateKbps,
    long? FileSizeBytes,
    bool FileSizeApproximate,
    string? Language);

public sealed record SubtitleTrackOption(
    string Language,
    string? Label,
    bool Automatic,
    IReadOnlyList<string> Containers);

public sealed record FormatCatalog(string VideoId, string Title, double? DurationSeconds, IReadOnlyList<QualityOption> Qualities)
{
    private const string SafeMetadataError = "Invalid media metadata.";
    private const int MaximumFormats = 2_048;
    private const int MaximumPublicQualities = 32;
    private const int MaximumPublicFormats = 256;
    private const int MaximumSubtitleTracks = 128;
    private const int MaximumSubtitleContainers = 16;
    private const int MaximumMetadataStringLength = 256;
    private const long MaximumJavaScriptSafeInteger = 9_007_199_254_740_991;
    private static readonly Regex SafeMediaId = new(
        "^[A-Za-z0-9._:-]{1,128}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex SafeLanguage = new(
        "^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8}){0,3}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    public string Platform { get; init; } = "youtube";
    public IReadOnlyList<MediaFormatOption> Formats { get; init; } = [];
    public IReadOnlyList<SubtitleTrackOption> Subtitles { get; init; } = [];
    public IReadOnlyList<string> AudioLanguages { get; init; } = [];

    public static FormatCatalog Parse(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException(SafeMetadataError);

            var videoId = RequiredString(root, "id");
            if (!SafeMediaId.IsMatch(videoId)) throw new InvalidDataException(SafeMetadataError);
            var title = NormalizePublicText(RequiredString(root, "title"), 512, truncate: true);
            if (string.IsNullOrWhiteSpace(title)) throw new InvalidDataException(SafeMetadataError);
            if (IsLive(root) || !HasPublicAvailability(root)) throw new InvalidDataException(SafeMetadataError);

            var duration = TryGetPositiveNumber(root, "duration");
            if (!root.TryGetProperty("formats", out var formats) || formats.ValueKind != JsonValueKind.Array)
                throw new InvalidDataException(SafeMetadataError);
            if (formats.GetArrayLength() > MaximumFormats)
                throw new InvalidDataException(SafeMetadataError);

            var platform = PlatformName(root);
            var parsedFormats = formats.EnumerateArray().Select(ParseFormat).ToList();
            var qualities = MediaFormatPolicy.Qualities(platform, parsedFormats)
                .Take(MaximumPublicQualities)
                .ToArray();

            if (qualities.Length == 0) throw new InvalidDataException(SafeMetadataError);
            return new FormatCatalog(videoId, title, duration, qualities)
            {
                Platform = platform,
                Formats = parsedFormats
                    .Where(format => format.IsVideo || format.IsAudio)
                    .OrderByDescending(format => format.IsAudio && !format.IsVideo)
                    .ThenByDescending(format => format.Height)
                    .Take(MaximumPublicFormats)
                    .Select(ToPublicFormat)
                    .ToArray(),
                Subtitles = ParseSubtitles(root),
                AudioLanguages = parsedFormats
                    .Where(format => format.IsAudio && !string.IsNullOrWhiteSpace(format.Language))
                    .Select(format => format.Language!)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy(language => language, StringComparer.OrdinalIgnoreCase)
                    .Take(64)
                    .ToArray()
            };
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException(SafeMetadataError, exception);
        }
    }

    private static MediaFormatDescriptor ParseFormat(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) return MediaFormatDescriptor.Empty;

        var height = TryGetPositiveInt32(element, "height", 4_320);
        var videoCodec = SafeString(element, "vcodec", 128);
        var audioCodec = SafeString(element, "acodec", 128);
        var extensionValue = SafeString(element, "ext", 16);
        var extension = extensionValue is not null && extensionValue.All(char.IsAsciiLetterOrDigit)
            ? extensionValue.ToLowerInvariant()
            : null;
        var isVideo = !IsNoneOrEmpty(videoCodec);
        var isAudio = !IsNoneOrEmpty(audioCodec);
        var fileSize = TryGetPositiveInt64(element, "filesize");
        var approximateSize = fileSize is null ? TryGetPositiveInt64(element, "filesize_approx") : null;
        var dynamicRange = SafeString(element, "dynamic_range", 64);
        var colorTransfer = SafeString(element, "color_transfer", 64);

        return new MediaFormatDescriptor(
            height ?? 0,
            isVideo,
            isAudio,
            isVideo && isAudio,
            IsValue(extension, "mp4"),
            IsValue(extension, "m4a") && isAudio && !isVideo,
            SafeString(element, "format_id", 128),
            extension,
            TryGetPositiveNumber(element, "fps", 1_000),
            IsHdr(dynamicRange, colorTransfer),
            dynamicRange,
            videoCodec,
            audioCodec,
            TryGetPositiveNumber(element, "tbr", 10_000_000)
                ?? TryGetPositiveNumber(element, isVideo ? "vbr" : "abr", 10_000_000),
            fileSize ?? approximateSize,
            fileSize is null && approximateSize.HasValue,
            SafeLanguageValue(GetString(element, "language")));
    }

    private static MediaFormatOption ToPublicFormat(MediaFormatDescriptor format) => new(
        format.FormatId,
        format.Height > 0 ? format.Height : null,
        string.IsNullOrWhiteSpace(format.Extension) ? "Unknown" : format.Extension.ToUpperInvariant(),
        format.IsCombined,
        !format.IsVideo && format.IsAudio,
        format.Fps,
        format.Hdr,
        format.DynamicRange,
        format.VideoCodec,
        format.AudioCodec,
        format.BitrateKbps,
        format.FileSizeBytes,
        format.FileSizeApproximate,
        format.Language);

    private static IReadOnlyList<SubtitleTrackOption> ParseSubtitles(JsonElement root)
    {
        var result = new List<SubtitleTrackOption>();
        AddSubtitleTracks(root, "subtitles", automatic: false, result);
        AddSubtitleTracks(root, "automatic_captions", automatic: true, result);
        return result;
    }

    private static void AddSubtitleTracks(
        JsonElement root,
        string propertyName,
        bool automatic,
        ICollection<SubtitleTrackOption> target)
    {
        if (!root.TryGetProperty(propertyName, out var tracks) || tracks.ValueKind != JsonValueKind.Object) return;

        foreach (var languageProperty in tracks.EnumerateObject())
        {
            if (target.Count >= MaximumSubtitleTracks) return;
            var language = SafeLanguageValue(languageProperty.Name);
            if (language is null || languageProperty.Value.ValueKind != JsonValueKind.Array) continue;

            string? label = null;
            var containers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var track in languageProperty.Value.EnumerateArray())
            {
                if (track.ValueKind != JsonValueKind.Object) continue;
                label ??= SafeString(track, "name", 128);
                var extension = SafeString(track, "ext", 16);
                if (extension is not null && !extension.All(char.IsAsciiLetterOrDigit)) extension = null;
                if (!string.IsNullOrWhiteSpace(extension) && containers.Count < MaximumSubtitleContainers)
                    containers.Add(extension.ToUpperInvariant());
            }

            target.Add(new SubtitleTrackOption(
                language,
                label,
                automatic,
                containers.OrderBy(value => value, StringComparer.OrdinalIgnoreCase).ToArray()));
        }
    }

    private static string RequiredString(JsonElement root, string name)
    {
        var value = GetString(root, name);
        if (string.IsNullOrWhiteSpace(value)) throw new InvalidDataException(SafeMetadataError);
        return value!;
    }

    private static string TruncateScalarSafe(string value, int maximumLength)
    {
        if (value.Length <= maximumLength) return value;
        var length = maximumLength;
        if (length > 0 && char.IsHighSurrogate(value[length - 1])) length--;
        return value[..length];
    }

    private static string NormalizePublicText(string value, int maximumLength, bool truncate)
    {
        var characters = value.ToCharArray();
        for (var index = 0; index < characters.Length; index++)
        {
            if (char.IsControl(characters[index])) characters[index] = ' ';
        }
        var normalized = new string(characters).Trim();
        if (truncate) return TruncateScalarSafe(normalized, maximumLength);
        return normalized.Length <= maximumLength ? normalized : string.Empty;
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

    private static int? TryGetPositiveInt32(JsonElement root, string name, int maximum) =>
        root.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.Number
        && value.TryGetInt32(out var number)
        && number > 0
        && number <= maximum ? number : null;

    private static long? TryGetPositiveInt64(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.Number
        && value.TryGetInt64(out var number)
        && number > 0
        && number <= MaximumJavaScriptSafeInteger ? number : null;

    private static double? TryGetPositiveNumber(
        JsonElement root,
        string name,
        double maximum = double.MaxValue) =>
        root.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.Number
        && value.TryGetDouble(out var number)
        && double.IsFinite(number)
        && number > 0
        && number <= maximum ? number : null;

    private static string? SafeString(
        JsonElement element,
        string name,
        int maximumLength = MaximumMetadataStringLength) =>
        SafeValue(GetString(element, name), maximumLength);

    private static string? SafeValue(string? value, int maximumLength = MaximumMetadataStringLength)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var normalized = NormalizePublicText(value, maximumLength, truncate: false);
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized;
    }

    private static string? SafeLanguageValue(string? value) =>
        value is not null && SafeLanguage.IsMatch(value) ? value : null;

    private static string? GetString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool IsHdr(string? dynamicRange, string? colorTransfer) =>
        ContainsAny(dynamicRange, "hdr", "hlg", "dolby vision", "dv", "pq")
        || ContainsAny(colorTransfer, "smpte2084", "arib-std-b67");

    private static bool ContainsAny(string? value, params string[] fragments) =>
        value is not null && fragments.Any(fragment => value.Contains(fragment, StringComparison.OrdinalIgnoreCase));

    private static bool IsNoneOrEmpty(string? value) => string.IsNullOrWhiteSpace(value) || IsValue(value, "none");

    private static bool IsValue(string? value, string expected) => string.Equals(value, expected, StringComparison.OrdinalIgnoreCase);
}
