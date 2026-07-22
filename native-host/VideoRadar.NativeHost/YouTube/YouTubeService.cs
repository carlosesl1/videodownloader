using VideoRadar.NativeHost.Processes;

namespace VideoRadar.NativeHost.YouTube;

public sealed class YouTubeService(string tools, IProcessRunner processRunner) : IYouTubeService
{
    private const string MetadataLookupError = "Unable to retrieve YouTube video metadata.";

    public async Task<FormatCatalog> ListFormatsAsync(string url, CancellationToken cancellationToken)
    {
        if (!YouTubeUrl.TryCanonicalize(url, out var canonicalUrl))
            throw new InvalidDataException("Invalid YouTube URL.");

        var result = await processRunner.RunAsync(
            Path.Combine(tools, "yt-dlp.exe"),
            YtDlpArguments.Metadata(tools, canonicalUrl),
            onOutput: null,
            cancellationToken);

        if (result.ExitCode != 0) throw new InvalidOperationException(MetadataLookupError);
        return FormatCatalog.Parse(result.StandardOutput);
    }

    public Task<JobResult> StartDownloadAsync(string jobId, string url, int height, Func<JobProgress, Task> onProgress, CancellationToken cancellationToken) =>
        Task.FromException<JobResult>(new NotSupportedException("Download support is not implemented."));

    public Task CancelAsync(string jobId) =>
        Task.FromException(new NotSupportedException("Download support is not implemented."));

    public JobSnapshot? GetJob() => null;
}
