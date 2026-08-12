namespace VideoRadar.NativeHost.YouTube;

/// <summary>
/// Optional durable-download contract used by protocol v5. The legacy
/// IYouTubeService remains available to protocol-v4 tests and callers.
/// </summary>
public interface IResumableYouTubeService
{
    Task<JobResult> StartDownloadAsync(
        string jobId,
        string url,
        DownloadSelection selection,
        string? destinationFolder,
        DownloadRunOptions options,
        Func<JobProgress, Task> onProgress,
        CancellationToken cancellationToken);

    /// <summary>
    /// Stops the active process but preserves its validated job temp directory.
    /// </summary>
    Task PauseAsync(string jobId);

    /// <summary>
    /// Deletes a paused job's temp directory after an explicit cancellation.
    /// </summary>
    Task DiscardPartialAsync(
        string jobId,
        string? destinationFolder,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Releases the durable output manifest only after the queue's completed
    /// state has been atomically persisted.
    /// </summary>
    Task CommitCompletedAsync(
        string jobId,
        string? destinationFolder,
        string finalPath,
        CancellationToken cancellationToken = default);
}
