using System.Text.RegularExpressions;
using VideoRadar.NativeHost.Files;
using VideoRadar.NativeHost.Processes;

namespace VideoRadar.NativeHost.YouTube;

public sealed partial class YouTubeService : IYouTubeService
{
    private const string MetadataLookupError = "Unable to retrieve YouTube video metadata.";
    private const string DownloadError = "Unable to download the YouTube video.";
    private const string InvalidOutputError = "The downloaded file was not reported safely.";
    private readonly string tools;
    private readonly IProcessRunner processRunner;
    private readonly Lazy<IDownloadPaths> downloadPaths;
    private readonly object stateLock = new();
    private ActiveJob? activeJob;
    private JobSnapshot? snapshot;

    public YouTubeService(string tools, IProcessRunner processRunner)
        : this(tools, processRunner, new Lazy<IDownloadPaths>(() => new DownloadPaths(), LazyThreadSafetyMode.ExecutionAndPublication))
    {
    }

    public YouTubeService(string tools, IProcessRunner processRunner, IDownloadPaths downloadPaths)
        : this(tools, processRunner, new Lazy<IDownloadPaths>(() => downloadPaths, LazyThreadSafetyMode.ExecutionAndPublication))
    {
        ArgumentNullException.ThrowIfNull(downloadPaths);
    }

    private YouTubeService(string tools, IProcessRunner processRunner, Lazy<IDownloadPaths> downloadPaths)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(tools);
        ArgumentNullException.ThrowIfNull(processRunner);
        this.tools = tools;
        this.processRunner = processRunner;
        this.downloadPaths = downloadPaths;
    }

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

    public async Task<JobResult> StartDownloadAsync(
        string jobId,
        string url,
        int height,
        Func<JobProgress, Task> onProgress,
        CancellationToken cancellationToken)
    {
        ValidateJobId(jobId);
        if (!YouTubeUrl.TryCanonicalize(url, out var canonicalUrl))
            throw new InvalidDataException("Invalid YouTube URL.");
        if (height is < 144 or > 4320) throw new ArgumentOutOfRangeException(nameof(height));
        ArgumentNullException.ThrowIfNull(onProgress);
        cancellationToken.ThrowIfCancellationRequested();

        var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var job = new ActiveJob(jobId, height, linkedCancellation);
        lock (stateLock)
        {
            if (activeJob is not null)
            {
                linkedCancellation.Dispose();
                throw new InvalidOperationException("Another download is already active.");
            }

            activeJob = job;
            snapshot = new JobSnapshot(jobId, string.Empty, string.Empty, height, "preparing", null, null, null);
        }

        string? reservedStem = null;
        var tempCreated = false;
        try
        {
            var catalog = await ListFormatsAsync(canonicalUrl, linkedCancellation.Token);
            if (!catalog.Qualities.Any(quality => quality.Height == height))
            {
                SetTerminal(job, "failed", "invalid_selection");
                throw new InvalidDataException("Selected quality is unavailable.");
            }

            SetMetadata(job, catalog);
            var paths = downloadPaths.Value;
            reservedStem = paths.ReserveStem(catalog.Title, catalog.VideoId);
            var temp = paths.CreateJobTemp(jobId);
            tempCreated = true;

            var result = await processRunner.RunAsync(
                Path.Combine(tools, "yt-dlp.exe"),
                YtDlpArguments.Download(tools, paths.Home, temp, reservedStem, canonicalUrl, height),
                line => HandleOutputAsync(job, paths, line, onProgress),
                linkedCancellation.Token);

            linkedCancellation.Token.ThrowIfCancellationRequested();
            if (result.ExitCode != 0)
            {
                SetTerminal(job, "failed", "download_failed");
                throw new InvalidOperationException(DownloadError);
            }

            string? finalPath;
            lock (stateLock) finalPath = job.FinalPath;
            if (finalPath is null)
            {
                SetTerminal(job, "failed", "invalid_output");
                throw new InvalidOperationException(InvalidOutputError);
            }

            SetCompleted(job, finalPath);
            return new JobResult(jobId, finalPath);
        }
        catch (OperationCanceledException)
        {
            SetTerminal(job, "cancelled", "cancelled");
            throw;
        }
        catch
        {
            SetFailureUnlessTerminal(job);
            throw;
        }
        finally
        {
            var paths = downloadPaths.IsValueCreated ? downloadPaths.Value : null;
            if (paths is not null && tempCreated) TryCleanup(() => paths.DeleteJobTemp(jobId));
            if (paths is not null && reservedStem is not null) TryCleanup(() => paths.ReleaseStem(reservedStem));
            lock (stateLock)
            {
                if (ReferenceEquals(activeJob, job)) activeJob = null;
            }

            linkedCancellation.Dispose();
        }
    }

    public Task CancelAsync(string jobId)
    {
        CancellationTokenSource? cancellation = null;
        lock (stateLock)
        {
            if (activeJob is not null && string.Equals(activeJob.JobId, jobId, StringComparison.Ordinal))
                cancellation = activeJob.Cancellation;
        }

        if (cancellation is not null)
        {
            try
            {
                cancellation.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // The job completed while cancellation was being requested.
            }
        }

        return Task.CompletedTask;
    }

    public JobSnapshot? GetJob()
    {
        lock (stateLock) return snapshot;
    }

    private async Task HandleOutputAsync(ActiveJob job, IDownloadPaths paths, string line, Func<JobProgress, Task> onProgress)
    {
        if (!ProgressParser.TryParse(line, out var parsed) || parsed is null) return;
        if (parsed.Stage == "finalize" && (parsed.Path is null || !paths.ContainsFinalPath(parsed.Path)))
            return;

        JobProgress? normalized;
        lock (stateLock)
        {
            normalized = NormalizeProgress(job, parsed);
            if (normalized?.Path is not null) job.FinalPath = normalized.Path;
            if (normalized is not null && ReferenceEquals(activeJob, job))
            {
                var current = snapshot!;
                snapshot = current with
                {
                    Stage = normalized.Stage,
                    Percent = normalized.Percent ?? current.Percent,
                    Path = normalized.Path ?? current.Path
                };
            }
        }

        if (normalized is not null) await onProgress(normalized);
    }

    private static JobProgress? NormalizeProgress(ActiveJob job, JobProgress progress)
    {
        var rank = StageRank(progress.Stage);
        if (rank < job.ProgressRank) return null;
        if (rank == job.ProgressRank)
        {
            if (!string.Equals(job.ProgressStage, progress.Stage, StringComparison.Ordinal)) return null;
            if (job.ProgressPercent.HasValue && progress.Percent.HasValue && progress.Percent.Value < job.ProgressPercent.Value)
                return null;
        }

        job.ProgressRank = rank;
        job.ProgressStage = progress.Stage;
        if (progress.Percent.HasValue) job.ProgressPercent = progress.Percent;
        return progress;
    }

    private static int StageRank(string stage) => stage switch
    {
        "video" or "download" => 1,
        "audio" => 2,
        "merge" => 3,
        "finalize" => 4,
        _ => 0
    };

    private void SetMetadata(ActiveJob job, FormatCatalog catalog)
    {
        lock (stateLock)
        {
            if (!ReferenceEquals(activeJob, job)) return;
            snapshot = new JobSnapshot(job.JobId, catalog.VideoId, catalog.Title, job.Height, "preparing", null, null, null);
        }
    }

    private void SetCompleted(ActiveJob job, string path)
    {
        lock (stateLock)
        {
            if (!ReferenceEquals(activeJob, job)) return;
            var current = snapshot!;
            snapshot = current with { Stage = "complete", Percent = 100, Path = path, ErrorCode = null };
            job.Terminal = true;
        }
    }

    private void SetTerminal(ActiveJob job, string stage, string errorCode)
    {
        lock (stateLock)
        {
            if (!ReferenceEquals(activeJob, job)) return;
            var current = snapshot!;
            snapshot = current with { Stage = stage, ErrorCode = errorCode };
            job.Terminal = true;
        }
    }

    private void SetFailureUnlessTerminal(ActiveJob job)
    {
        lock (stateLock)
        {
            if (!ReferenceEquals(activeJob, job) || job.Terminal) return;
            var current = snapshot!;
            snapshot = current with { Stage = "failed", ErrorCode = "download_failed" };
            job.Terminal = true;
        }
    }

    private static void TryCleanup(Action cleanup)
    {
        try
        {
            cleanup();
        }
        catch
        {
            // Cleanup is best-effort and must not replace the operation result or cancellation.
        }
    }

    private static void ValidateJobId(string jobId)
    {
        if (string.IsNullOrEmpty(jobId) || !SafeJobId().IsMatch(jobId))
            throw new ArgumentException("Invalid job id.", nameof(jobId));
    }

    [GeneratedRegex("^[A-Za-z0-9_-]{1,128}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeJobId();

    private sealed class ActiveJob(string jobId, int height, CancellationTokenSource cancellation)
    {
        public string JobId { get; } = jobId;
        public int Height { get; } = height;
        public CancellationTokenSource Cancellation { get; } = cancellation;
        public int ProgressRank { get; set; }
        public string? ProgressStage { get; set; }
        public int? ProgressPercent { get; set; }
        public string? FinalPath { get; set; }
        public bool Terminal { get; set; }
    }
}
