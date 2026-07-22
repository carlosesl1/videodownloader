namespace VideoRadar.NativeHost.YouTube;

public sealed record JobProgress(string Stage, int? Percent, long? DownloadedBytes, long? TotalBytes, long? SpeedBytesPerSecond, int? EtaSeconds, string? Path = null);

public sealed record JobResult(string JobId, string Path);

public interface IYouTubeService
{
    Task<FormatCatalog> ListFormatsAsync(string url, CancellationToken cancellationToken);
    Task<JobResult> StartDownloadAsync(string jobId, string url, int height, Func<JobProgress, Task> onProgress, CancellationToken cancellationToken);
    Task CancelAsync(string jobId);
    JobSnapshot? GetJob();
}
