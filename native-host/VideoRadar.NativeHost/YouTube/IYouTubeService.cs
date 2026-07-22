namespace VideoRadar.NativeHost.YouTube;

public sealed record JobProgress(string Stage, int? Percent, long? DownloadedBytes, long? TotalBytes, long? SpeedBytesPerSecond, int? EtaSeconds, string? Path = null);

public sealed record JobResult(string JobId, string Path);

public sealed record JobSnapshot(string JobId, string VideoId, string Title, int Height, string Stage, int? Percent, string? Path, string? ErrorCode);

public interface IYouTubeService
{
    Task<FormatCatalog> ListFormatsAsync(string url, CancellationToken cancellationToken);
    Task<JobResult> StartDownloadAsync(string jobId, string url, int height, Func<JobProgress, Task> onProgress, CancellationToken cancellationToken);
    Task CancelAsync(string jobId);
    JobSnapshot? GetJob();
}
