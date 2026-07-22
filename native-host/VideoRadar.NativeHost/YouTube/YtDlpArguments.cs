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
}
