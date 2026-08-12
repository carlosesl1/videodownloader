using VideoRadar.NativeHost.Media;
using System.Text.RegularExpressions;

namespace VideoRadar.NativeHost.YouTube;

public sealed record DownloadSelection(
    int? Height,
    bool AudioOnly = false,
    string? SubtitleLanguage = null,
    bool IncludeAutomaticSubtitles = false)
{
    public static DownloadSelection Video(int height) => new(height);
    public static DownloadSelection Audio(string? subtitleLanguage = null, bool includeAutomaticSubtitles = false) =>
        new(null, AudioOnly: true, subtitleLanguage, includeAutomaticSubtitles);
}

public sealed record DownloadRunOptions(
    bool ResumePartial = false,
    bool PreservePartialOnCancellation = false,
    bool DurableOutputIdentity = false);

public static class YtDlpArguments
{
    private static readonly Regex SafeSubtitleLanguage = new(
        "^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8}){0,3}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    public static IReadOnlyList<string> Metadata(string tools, string canonicalUrl)
    {
        if (string.IsNullOrWhiteSpace(tools))
            throw new ArgumentException("Invalid tools path.", nameof(tools));
        if (!MediaPage.TryCanonicalize(canonicalUrl, out var page)
            || !string.Equals(page!.CanonicalUrl, canonicalUrl, StringComparison.Ordinal))
        {
            throw new ArgumentException("Invalid canonical media URL.", nameof(canonicalUrl));
        }

        return
        [
            "--ignore-config", "--no-config-locations", "--no-update", "--no-playlist",
            "--no-plugin-dirs", "--no-remote-components", "--no-js-runtimes",
            "--js-runtimes", $"deno:{Path.Combine(tools, "deno.exe")}",
            "--ffmpeg-location", tools,
            "--socket-timeout", "30", "--retries", "5", "--extractor-retries", "3",
            "--retry-sleep", "http:exp=1:10:2", "--retry-sleep", "extractor:exp=1:10:2",
            "--dump-single-json", "--skip-download", "--no-warnings", canonicalUrl
        ];
    }

    public static IReadOnlyList<string> Download(
        string tools,
        string home,
        string temp,
        string reservedStem,
        string canonicalUrl,
        int height,
        string? infoJsonPath = null)
        => Download(
            tools,
            home,
            temp,
            reservedStem,
            canonicalUrl,
            DownloadSelection.Video(height),
            new DownloadRunOptions(),
            infoJsonPath);

    public static IReadOnlyList<string> Download(
        string tools,
        string home,
        string temp,
        string reservedStem,
        string canonicalUrl,
        DownloadSelection selection,
        DownloadRunOptions runOptions,
        string? infoJsonPath = null)
    {
        ArgumentNullException.ThrowIfNull(selection);
        ArgumentNullException.ThrowIfNull(runOptions);
        ValidateSelection(selection);
        if (string.IsNullOrWhiteSpace(tools))
            throw new ArgumentException("Invalid tools path.", nameof(tools));
        if (!IsFullyQualifiedPath(home))
            throw new ArgumentException("Invalid home path.", nameof(home));
        if (!IsFullyQualifiedPath(temp))
            throw new ArgumentException("Invalid temp path.", nameof(temp));
        if (string.IsNullOrWhiteSpace(reservedStem)
            || reservedStem.Length > 180
            || !string.Equals(reservedStem, Path.GetFileName(reservedStem), StringComparison.Ordinal)
            || reservedStem.Contains("..", StringComparison.Ordinal)
            || reservedStem.Any(character =>
                char.IsControl(character)
                || character is '<' or '>' or ':' or '"' or '/' or '\\' or '|' or '?' or '*'))
        {
            throw new ArgumentException("Invalid output stem.", nameof(reservedStem));
        }
        if (!MediaPage.TryCanonicalize(canonicalUrl, out var page))
            throw new ArgumentException("Invalid media URL.", nameof(canonicalUrl));
        if (!string.Equals(page!.CanonicalUrl, canonicalUrl, StringComparison.Ordinal))
            throw new ArgumentException("Media URL must already be canonical.", nameof(canonicalUrl));
        if (infoJsonPath is not null && !IsFullyQualifiedPath(infoJsonPath))
            throw new ArgumentException("Invalid metadata path.", nameof(infoJsonPath));
        var selector = selection.AudioOnly
            ? "ba[ext=m4a]/ba"
            : MediaFormatPolicy.Selector(page.Platform, selection.Height!.Value);
        var arguments = new List<string>
        {
            "--ignore-config", "--no-config-locations", "--no-update", "--no-playlist",
            "--no-plugin-dirs", "--no-remote-components", "--no-js-runtimes",
            "--js-runtimes", $"deno:{Path.Combine(tools, "deno.exe")}",
            "--ffmpeg-location", tools,
            "--socket-timeout", "30", "--retries", "5", "--fragment-retries", "5",
            "--extractor-retries", "3", "--file-access-retries", "3",
            "--retry-sleep", "http:exp=1:10:2", "--retry-sleep", "fragment:exp=1:10:2",
            "--retry-sleep", "extractor:exp=1:10:2", "--retry-sleep", "file_access:linear=1:3:1",
            "--abort-on-error", "--abort-on-unavailable-fragments",
            "--windows-filenames", "--trim-filenames", "180", "--no-overwrites",
            "--paths", home, "--paths", $"temp:{temp}",
            "--output", $"{reservedStem}.%(ext)s",
            "--format", selector,
        };
        if (selection.AudioOnly)
        {
            arguments.AddRange(["--extract-audio", "--audio-format", "m4a", "--audio-quality", "0"]);
        }
        else
        {
            arguments.AddRange(["--merge-output-format", "mp4/webm"]);
        }
        if (selection.SubtitleLanguage is not null)
        {
            arguments.Add(selection.IncludeAutomaticSubtitles
                ? "--write-auto-subs"
                : "--write-subs");
            arguments.AddRange([
                "--sub-langs", selection.SubtitleLanguage,
                "--sub-format", "vtt/best",
                "--convert-subs", "vtt"
            ]);
        }
        if (runOptions.ResumePartial)
            arguments.AddRange(["--continue", "--part"]);

        arguments.AddRange([
            "--newline", "--progress", "--progress-delta", "1",
            "--progress-template", "download:VR_PROGRESS:{\"progress\":%(progress)j,\"vcodec\":%(info.vcodec)j,\"acodec\":%(info.acodec)j}",
            "--progress-template", "postprocess:VR_POSTPROCESS:%(progress)j",
            "--print", "after_move:VR_FILE:%(filepath)j",
        ]);
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

    private static void ValidateSelection(DownloadSelection selection)
    {
        if (selection.AudioOnly)
        {
            if (selection.Height is not null)
                throw new ArgumentException("Audio-only selection cannot specify a video height.", nameof(selection));
        }
        else if (selection.Height is null or < 144 or > 4320)
        {
            throw new ArgumentOutOfRangeException(nameof(selection), "Video height is outside the supported range.");
        }

        if (selection.SubtitleLanguage is null)
        {
            if (selection.IncludeAutomaticSubtitles)
                throw new ArgumentException("Automatic subtitles require an explicit language.", nameof(selection));
            return;
        }

        if (!SafeSubtitleLanguage.IsMatch(selection.SubtitleLanguage))
            throw new ArgumentException("Invalid subtitle language.", nameof(selection));
    }

    private static bool IsFullyQualifiedPath(string path) =>
        !string.IsNullOrWhiteSpace(path)
        && (Path.IsPathFullyQualified(path)
            || (path.Length >= 3
                && char.IsAsciiLetter(path[0])
                && path[1] == ':'
                && path[2] is '\\' or '/'));
}
