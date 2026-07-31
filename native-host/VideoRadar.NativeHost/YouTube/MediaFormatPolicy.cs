namespace VideoRadar.NativeHost.YouTube;

internal sealed record MediaFormatDescriptor(
    int Height,
    bool IsVideo,
    bool IsCombined,
    bool IsMp4,
    bool IsM4aAudio);

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
            .Select(group => CreateQuality(platform, group.Key, group, hasM4aAudio))
            .ToList();
    }

    public static string Selector(string platform, int height) => platform switch
    {
        "tiktok" => $"b[height={height}][ext=mp4][vcodec!*=h265][vcodec!*=hev]/b[height={height}][ext=mp4]/b[height={height}]",
        "instagram" or "x" => $"b[height={height}][ext=mp4]/b[height={height}]",
        _ => $"b[height={height}][ext=mp4]/bv*[height={height}][ext=mp4]+ba[ext=m4a]/b[height={height}]/bv*[height={height}]+ba"
    };

    private static bool IsSelectable(string platform, MediaFormatDescriptor format, bool hasM4aAudio)
    {
        if (format.Height <= 0 || !format.IsVideo) return false;
        return platform == "youtube" ? format.IsCombined || hasM4aAudio : format.IsCombined;
    }

    private static QualityOption CreateQuality(
        string platform,
        int height,
        IEnumerable<MediaFormatDescriptor> formats,
        bool hasM4aAudio)
    {
        var values = formats.ToList();
        var combinedMp4 = values.Any(format => format.IsCombined && format.IsMp4);
        var separateMp4 = platform == "youtube"
            && hasM4aAudio
            && values.Any(format => !format.IsCombined && format.IsMp4);
        var container = combinedMp4 || separateMp4 ? "MP4" : "WebM";
        return new QualityOption(height, $"{height}p", container, values.Any(format => format.IsCombined));
    }
}
