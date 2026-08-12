namespace VideoRadar.NativeHost.YouTube;

internal sealed record MediaFormatDescriptor(
    int Height,
    bool IsVideo,
    bool IsAudio,
    bool IsCombined,
    bool IsMp4,
    bool IsM4aAudio,
    string? FormatId,
    string? Extension,
    double? Fps,
    bool Hdr,
    string? DynamicRange,
    string? VideoCodec,
    string? AudioCodec,
    double? BitrateKbps,
    long? FileSizeBytes,
    bool FileSizeApproximate,
    string? Language)
{
    public static MediaFormatDescriptor Empty { get; } = new(
        0, false, false, false, false, false, null, null, null, false,
        null, null, null, null, null, false, null);
}

internal static class MediaFormatPolicy
{
    public static IReadOnlyList<QualityOption> Qualities(
        string platform,
        IReadOnlyCollection<MediaFormatDescriptor> formats)
    {
        var hasM4aAudio = formats.Any(format => format.IsM4aAudio);
        return formats
            .Where(format => IsSelectable(platform, format, hasM4aAudio))
            .GroupBy(format => format.Height)
            .OrderByDescending(group => group.Key)
            .Select(group => CreateQuality(platform, group.Key, group, formats))
            .ToList();
    }

    public static string Selector(string platform, int height) => platform switch
    {
        "tiktok" => $"b[height={height}][ext=mp4][vcodec!*=h265][vcodec!*=hev]/b[height={height}][ext=mp4]/b[height={height}]",
        "instagram" => $"b[height={height}][ext=mp4]/bv[height={height}][ext=mp4]+ba[ext=m4a]/b[height={height}]",
        "x" => $"b[height={height}][ext=mp4]/b[height={height}]",
        _ => $"b[height={height}][ext=mp4]/bv*[height={height}][ext=mp4]+ba[ext=m4a]/b[height={height}]/bv*[height={height}]+ba"
    };

    private static bool IsSelectable(string platform, MediaFormatDescriptor format, bool hasM4aAudio)
    {
        if (format.Height <= 0 || !format.IsVideo || !IsPublicContainer(format)) return false;
        return platform switch
        {
            "youtube" => format.IsCombined || hasM4aAudio,
            "instagram" => format.IsCombined || (format.IsMp4 && hasM4aAudio),
            _ => format.IsCombined
        };
    }

    private static QualityOption CreateQuality(
        string platform,
        int height,
        IEnumerable<MediaFormatDescriptor> formats,
        IReadOnlyCollection<MediaFormatDescriptor> allFormats)
    {
        var values = formats.ToList();
        var combinedMp4 = values.Where(format => format.IsCombined && format.IsMp4);
        var selectedVideo = platform == "tiktok"
            ? Best(combinedMp4.Where(IsTikTokCompatibleCodec)) ?? Best(combinedMp4)
            : Best(combinedMp4);
        MediaFormatDescriptor? selectedAudio = null;

        // Keep this order in sync with Selector(): compatible combined MP4,
        // compatible separate MP4 + M4A, any combined stream, then the
        // YouTube-only separate fallback.
        if (selectedVideo is null && platform is "youtube" or "instagram")
        {
            selectedVideo = Best(values.Where(format => !format.IsCombined && format.IsMp4));
            if (selectedVideo is not null)
                selectedAudio = Best(allFormats.Where(format => format.IsM4aAudio));
        }
        selectedVideo ??= Best(values.Where(format => format.IsCombined));
        if (selectedVideo is null && platform == "youtube")
        {
            selectedVideo = Best(values.Where(format => !format.IsCombined));
            if (selectedVideo is not null)
                selectedAudio = Best(allFormats.Where(format => format.IsAudio && !format.IsVideo));
        }
        selectedVideo ??= Best(values)
            ?? throw new InvalidOperationException("A selectable quality requires a video stream.");

        var estimatedSize = selectedVideo.FileSizeBytes;
        if (!selectedVideo.IsCombined)
        {
            estimatedSize = selectedVideo.FileSizeBytes.HasValue && selectedAudio?.FileSizeBytes.HasValue == true
                ? SaturatingAdd(selectedVideo.FileSizeBytes.Value, selectedAudio.FileSizeBytes.Value)
                : null;
        }
        var estimatedIsApproximate = estimatedSize.HasValue
            && (!selectedVideo.IsCombined
                || selectedVideo.FileSizeApproximate
                || selectedAudio?.FileSizeApproximate == true);
        var container = string.IsNullOrWhiteSpace(selectedVideo.Extension)
            ? selectedVideo.IsMp4 ? "MP4" : "WebM"
            : selectedVideo.Extension.ToUpperInvariant();

        return new QualityOption(height, $"{height}p", container, selectedVideo.IsCombined)
        {
            Fps = selectedVideo.Fps,
            Hdr = selectedVideo.Hdr,
            DynamicRange = selectedVideo.DynamicRange,
            VideoCodec = selectedVideo.VideoCodec,
            AudioCodec = selectedVideo.IsCombined ? selectedVideo.AudioCodec : selectedAudio?.AudioCodec,
            BitrateKbps = selectedVideo.BitrateKbps,
            EstimatedSizeBytes = estimatedSize,
            EstimatedSizeApproximate = estimatedIsApproximate
        };
    }

    private static MediaFormatDescriptor? Best(IEnumerable<MediaFormatDescriptor> formats) => formats
        .OrderByDescending(format => format.BitrateKbps ?? 0)
        .ThenByDescending(format => format.FileSizeBytes ?? 0)
        .FirstOrDefault();

    private static bool IsTikTokCompatibleCodec(MediaFormatDescriptor format) =>
        format.VideoCodec is not { } codec
        || (!codec.Contains("h265", StringComparison.OrdinalIgnoreCase)
            && !codec.Contains("hev", StringComparison.OrdinalIgnoreCase));

    private static bool IsPublicContainer(MediaFormatDescriptor format) =>
        format.IsMp4
        || string.Equals(format.Extension, "webm", StringComparison.OrdinalIgnoreCase);

    private static long SaturatingAdd(long left, long right) =>
        left > long.MaxValue - right ? long.MaxValue : left + right;
}
