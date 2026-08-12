using VideoRadar.NativeHost.Media;

namespace VideoRadar.NativeHost.YouTube;

public static class YtDlpArguments
{
    public static IReadOnlyList<string> Metadata(string tools, string canonicalUrl) =>
    [
        "--ignore-config", "--no-playlist", "--no-plugin-dirs", "--no-remote-components",
        "--js-runtimes", $"deno:{Path.Combine(tools, "deno.exe")}",
        "--ffmpeg-location", tools,
        "--dump-single-json", "--skip-download", "--no-warnings", canonicalUrl
    ];

    public static IReadOnlyList<string> Download(
        string tools,
        string home,
        string temp,
        string reservedStem,
        string canonicalUrl,
        int height,
        string? infoJsonPath = null)
    {
        if (height is < 144 or > 4320) throw new ArgumentOutOfRangeException(nameof(height));
        if (!MediaPage.TryCanonicalize(canonicalUrl, out var page))
            throw new ArgumentException("Invalid media URL.", nameof(canonicalUrl));
        if (infoJsonPath is not null && !Path.IsPathFullyQualified(infoJsonPath))
            throw new ArgumentException("Invalid metadata path.", nameof(infoJsonPath));
        var selector = MediaFormatPolicy.Selector(page!.Platform, height);
        var arguments = new List<string>
        {
            "--ignore-config", "--no-playlist", "--no-plugin-dirs", "--no-remote-components",
            "--js-runtimes", $"deno:{Path.Combine(tools, "deno.exe")}",
            "--ffmpeg-location", tools,
            "--windows-filenames", "--trim-filenames", "180", "--no-overwrites",
            "--paths", home, "--paths", $"temp:{temp}",
            "--output", $"{reservedStem}.%(ext)s",
            "--format", selector, "--merge-output-format", "mp4/webm",
            "--newline", "--progress", "--progress-delta", "0.5",
            "--progress-template", "download:VR_PROGRESS:{\"progress\":%(progress)j,\"vcodec\":%(info.vcodec)j,\"acodec\":%(info.acodec)j}",
            "--progress-template", "postprocess:VR_POSTPROCESS:%(progress)j",
            "--print", "after_move:VR_FILE:%(filepath)j",
        };
        if (infoJsonPath is null)
        {
            arguments.Add(canonicalUrl);
        }
        else
        {
            arguments.Add("--load-info-json");
            arguments.Add(infoJsonPath);
        }
        return arguments;
    }
}
