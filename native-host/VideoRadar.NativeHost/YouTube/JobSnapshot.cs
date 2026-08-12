namespace VideoRadar.NativeHost.YouTube;

public sealed record JobSnapshot(
    string JobId,
    string VideoId,
    string Title,
    int Height,
    string Stage,
    int? Percent,
    string? Path,
    string? ErrorCode,
    string? OperationId = null,
    long? DownloadedBytes = null,
    long? TotalBytes = null,
    long? SpeedBytesPerSecond = null,
    int? EtaSeconds = null);
