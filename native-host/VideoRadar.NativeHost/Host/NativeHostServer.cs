using System.Text.Json;
using VideoRadar.NativeHost.Files;
using VideoRadar.NativeHost.Protocol;
using VideoRadar.NativeHost.Tools;
using VideoRadar.NativeHost.Windows;
using VideoRadar.NativeHost.YouTube;

namespace VideoRadar.NativeHost.Host;

public interface INativeHostServer
{
    Task RunAsync(CancellationToken cancellationToken);
}

public sealed class NativeHostServer(
    NativeMessageChannel channel,
    IYouTubeService youtubeService,
    IUpdatePolicy updatePolicy,
    IFolderPicker folderPicker,
    string fallbackDownloadFolder,
    IDownloadFileMover fileMover,
    TimeSpan? metadataTimeout = null) : INativeHostServer
{
    private const string UnknownRequestId = "unknown";
    private static readonly TimeSpan DefaultMetadataTimeout = TimeSpan.FromSeconds(40);
    private readonly IFolderPicker folderPicker = folderPicker ?? throw new ArgumentNullException(nameof(folderPicker));
    private readonly IDownloadFileMover fileMover = fileMover ?? throw new ArgumentNullException(nameof(fileMover));
    private readonly string fallbackDownloadFolder =
        DownloadPaths.NormalizeDestination(fallbackDownloadFolder, nameof(fallbackDownloadFolder));
    private readonly TimeSpan metadataTimeout = ValidateMetadataTimeout(metadataTimeout);
    private readonly object stateLock = new();
    private ActiveDownload? activeDownload;
    private JobSnapshot? lastSnapshot;
    private bool updateChecked;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (true)
            {
                JsonDocument? document;
                try
                {
                    document = await channel.ReadAsync(cancellationToken);
                }
                catch (JsonException)
                {
                    await WriteFailureAsync(UnknownRequestId, "INVALID_COMMAND", "Comando inválido.", "protocol", null, cancellationToken);
                    continue;
                }
                catch (InvalidDataException)
                {
                    await WriteFailureAsync(UnknownRequestId, "INVALID_COMMAND", "Comando inválido.", "protocol", null, cancellationToken);
                    continue;
                }

                if (document is null) break;
                using (document)
                {
                    var requestId = TryReadRequestId(document.RootElement);
                    HostCommand command;
                    try
                    {
                        command = HostCommand.Parse(document.RootElement);
                    }
                    catch (InvalidDataException)
                    {
                        await WriteFailureAsync(requestId, "INVALID_COMMAND", "Comando inválido.", "protocol", null, cancellationToken);
                        continue;
                    }

                    try
                    {
                        await DispatchAsync(command, cancellationToken);
                    }
                    catch (CommandFailureException failure)
                    {
                        await WriteFailureAsync(command.RequestId, failure.Code, failure.Message, command.Type, null, cancellationToken);
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch
                    {
                        await WriteFailureAsync(command.RequestId, "HOST_ERROR", "O host nativo encontrou um erro.", command.Type, null, cancellationToken);
                    }
                }
            }
        }
        finally
        {
            await StopActiveDownloadAsync();
        }
    }

    private Task DispatchAsync(HostCommand command, CancellationToken cancellationToken) => command.Type switch
    {
        "ping" => HandlePingAsync(command, cancellationToken),
        "listFormats" => HandleListFormatsAsync(command, cancellationToken),
        "startDownload" => HandleStartDownloadAsync(command, cancellationToken),
        "getJob" => HandleGetJobAsync(command, cancellationToken),
        "cancelDownload" => HandleCancelDownloadAsync(command, cancellationToken),
        "chooseDownloadFolder" => HandleChooseDownloadFolderAsync(command, cancellationToken),
        "moveDownloadedFile" => HandleMoveDownloadedFileAsync(command, cancellationToken),
        "revealDownloadedFile" => HandleRevealDownloadedFileAsync(command, cancellationToken),
        _ => throw new CommandFailureException("INVALID_COMMAND", "Comando inválido.")
    };

    private Task HandlePingAsync(HostCommand command, CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload);
        return channel.WriteAsync(new
        {
            type = "ready",
            requestId = command.RequestId,
            protocolVersion = HostInfo.ProtocolVersion,
            nativeName = HostInfo.NativeName,
            defaultFolder = fallbackDownloadFolder
        }, cancellationToken);
    }

    private async Task HandleChooseDownloadFolderAsync(HostCommand command, CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload);
        var path = await folderPicker.PickAsync(cancellationToken);
        if (path is null)
        {
            await channel.WriteAsync(new
            {
                type = "folderSelectionCancelled",
                requestId = command.RequestId
            }, cancellationToken);
            return;
        }

        var canonicalPath = DownloadPaths.NormalizeDestination(path, nameof(path));
        await channel.WriteAsync(new
        {
            type = "folderSelected",
            requestId = command.RequestId,
            path = canonicalPath
        }, cancellationToken);
    }

    private async Task HandleListFormatsAsync(HostCommand command, CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload, "url");
        var url = RequiredString(command.Payload, "url");
        if (!YouTubeUrl.TryCanonicalize(url, out var canonicalUrl))
            throw new CommandFailureException("INVALID_URL", "URL do YouTube inválida.");

        FormatCatalog catalog;
        using var metadataCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        metadataCancellation.CancelAfter(metadataTimeout);
        try
        {
            catalog = await ListFormatsWithRecoveryAsync(
                canonicalUrl,
                metadataCancellation.Token);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            await WriteFailureAsync(
                command.RequestId,
                "YOUTUBE_METADATA_TIMEOUT",
                "O YouTube demorou demais para responder.",
                command.Type,
                null,
                cancellationToken);
            return;
        }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException)
        {
            await WriteFailureAsync(command.RequestId, "YOUTUBE_METADATA", "Não foi possível obter os formatos do vídeo.", command.Type, null, cancellationToken);
            return;
        }
        catch
        {
            await WriteFailureAsync(command.RequestId, "HOST_ERROR", "O host nativo encontrou um erro.", command.Type, null, cancellationToken);
            return;
        }

        await channel.WriteAsync(new
        {
            type = "formats",
            requestId = command.RequestId,
            videoId = catalog.VideoId,
            title = catalog.Title,
            durationSeconds = catalog.DurationSeconds,
            qualities = catalog.Qualities.Select(quality => new
            {
                height = quality.Height,
                label = quality.Label,
                container = quality.Container,
                combined = quality.Combined
            }).ToArray()
        }, cancellationToken);
    }

    private async Task HandleMoveDownloadedFileAsync(HostCommand command, CancellationToken cancellationToken)
    {
        try
        {
            RequireExactProperties(command.Payload, "downloadId", "sourcePath", "destinationFolder");
            if (!command.Payload.TryGetProperty("downloadId", out var downloadIdValue)
                || downloadIdValue.ValueKind != JsonValueKind.Number
                || !downloadIdValue.TryGetInt64(out var downloadId)
                || downloadId < 0)
            {
                throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
            }

            var payload = new MoveDownloadedFilePayload(
                downloadId,
                RequiredString(command.Payload, "sourcePath"),
                RequiredString(command.Payload, "destinationFolder"));
            var delivered = fileMover.Move(
                payload.SourcePath,
                payload.DestinationFolder,
                payload.DownloadId);
            await channel.WriteAsync(new
            {
                type = "fileMoved",
                requestId = command.RequestId,
                downloadId = delivered.DownloadId,
                finalPath = delivered.FinalPath
            }, cancellationToken);
        }
        catch (CommandFailureException)
        {
            throw new CommandFailureException("DESTINATION_INVALID", "O destino do download é inválido.");
        }
        catch (ArgumentException)
        {
            throw new CommandFailureException("DESTINATION_INVALID", "O destino do download é inválido.");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new CommandFailureException("DESTINATION_MOVE_FAILED", "Não foi possível mover o arquivo.");
        }
    }

    private async Task HandleRevealDownloadedFileAsync(
        HostCommand command,
        CancellationToken cancellationToken)
    {
        try
        {
            RequireExactProperties(command.Payload, "path");
            var path = DownloadPaths.NormalizeDestination(
                RequiredString(command.Payload, "path"),
                "path");
            fileMover.Reveal(path);
            await channel.WriteAsync(new
            {
                type = "fileRevealed",
                requestId = command.RequestId
            }, cancellationToken);
        }
        catch (FileNotFoundException)
        {
            throw new CommandFailureException("FILE_NOT_FOUND", "O arquivo baixado não foi encontrado.");
        }
        catch (ArgumentException)
        {
            throw new CommandFailureException("FILE_INVALID", "O caminho do arquivo é inválido.");
        }
        catch (Exception exception) when (
            exception is IOException
            or UnauthorizedAccessException
            or System.ComponentModel.Win32Exception
            or System.Runtime.InteropServices.COMException
            or PlatformNotSupportedException)
        {
            throw new CommandFailureException("REVEAL_FAILED", "Não foi possível mostrar o arquivo.");
        }
    }

    private async Task HandleStartDownloadAsync(HostCommand command, CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload, "url", "height", "destinationFolder");
        var url = RequiredString(command.Payload, "url");
        if (!YouTubeUrl.TryCanonicalize(url, out var canonicalUrl))
            throw new CommandFailureException("INVALID_URL", "URL do YouTube inválida.");
        if (!command.Payload.TryGetProperty("height", out var heightValue)
            || heightValue.ValueKind != JsonValueKind.Number
            || !heightValue.TryGetInt32(out var height)
            || height is < 144 or > 4320)
        {
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        }
        if (!command.Payload.TryGetProperty("destinationFolder", out var destinationValue))
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");

        string? destinationFolder;
        if (destinationValue.ValueKind == JsonValueKind.Null)
        {
            destinationFolder = null;
        }
        else if (destinationValue.ValueKind == JsonValueKind.String)
        {
            try
            {
                destinationFolder = DownloadPaths.NormalizeDestination(
                    RequiredString(command.Payload, "destinationFolder"),
                    "destinationFolder");
            }
            catch (ArgumentException)
            {
                throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
            }
        }
        else
        {
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        }

        var payload = new StartDownloadPayload(canonicalUrl, height, destinationFolder);

        lock (stateLock)
        {
            if (activeDownload is not null)
                throw new CommandFailureException("YOUTUBE_BUSY", "Já existe um download do YouTube em andamento.");
        }

        var jobId = Guid.NewGuid().ToString("D");
        var cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var initialSnapshot = new JobSnapshot(jobId, string.Empty, string.Empty, payload.Height, "preparing", null, null, null);
        var job = new ActiveDownload(
            jobId,
            command.RequestId,
            payload.Height,
            payload.DestinationFolder,
            cancellation,
            initialSnapshot);
        lock (stateLock)
        {
            if (activeDownload is not null)
            {
                cancellation.Dispose();
                throw new CommandFailureException("YOUTUBE_BUSY", "Já existe um download do YouTube em andamento.");
            }

            activeDownload = job;
        }

        try
        {
            await channel.WriteAsync(new
            {
                type = "jobStarted",
                requestId = command.RequestId,
                jobId,
                job = SnapshotPayload(initialSnapshot)
            }, cancellationToken);
        }
        catch
        {
            lock (stateLock)
            {
                if (ReferenceEquals(activeDownload, job)) activeDownload = null;
            }
            cancellation.Cancel();
            cancellation.Dispose();
            job.EventWrites.Dispose();
            throw;
        }

        job.Task = Task.Run(
            () => ExecuteDownloadAsync(job, payload.Url),
            CancellationToken.None);
    }

    private Task HandleGetJobAsync(HostCommand command, CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload);
        var snapshot = CurrentSnapshot();
        return channel.WriteAsync(new
        {
            type = "ready",
            requestId = command.RequestId,
            job = snapshot is null ? null : SnapshotPayload(snapshot)
        }, cancellationToken);
    }

    private async Task HandleCancelDownloadAsync(HostCommand command, CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload, "jobId");
        var jobId = RequiredString(command.Payload, "jobId");
        ActiveDownload? job;
        lock (stateLock) job = activeDownload;
        if (job is null || !string.Equals(job.JobId, jobId, StringComparison.Ordinal))
            throw new CommandFailureException("JOB_NOT_FOUND", "O download informado não está ativo.");

        try
        {
            await RequestCancellationAsync(job);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            await WriteFailureAsync(command.RequestId, "HOST_ERROR", "O host nativo encontrou um erro.", command.Type, null, cancellationToken);
        }
    }

    private async Task ExecuteDownloadAsync(ActiveDownload job, string url)
    {
        try
        {
            var result = await youtubeService.StartDownloadAsync(
                job.JobId,
                url,
                job.Height,
                job.DestinationFolder,
                progress => EmitProgressAsync(job, progress),
                job.Cancellation.Token);
            var completed = BestSnapshot(job) with
            {
                Stage = "complete",
                Percent = 100,
                Path = result.Path,
                ErrorCode = null
            };
            SetSnapshot(job, completed);
            await WriteJobEventAsync(job, new
            {
                type = "jobCompleted",
                requestId = job.RequestId,
                jobId = job.JobId,
                path = result.Path
            });
        }
        catch (OperationCanceledException)
        {
            var cancelled = BestSnapshot(job) with { Stage = "cancelled", ErrorCode = "cancelled" };
            SetSnapshot(job, cancelled);
            await WriteJobEventAsync(job, new
            {
                type = "jobCancelled",
                requestId = job.RequestId,
                jobId = job.JobId
            });
        }
        catch (Exception exception)
        {
            var (code, message) = ClassifyDownloadFailure(exception);
            var failed = BestSnapshot(job) with { Stage = "failed", ErrorCode = code };
            SetSnapshot(job, failed);
            await WriteJobEventAsync(job, FailurePayload(job.RequestId, code, message, "download", job.JobId));
        }
        finally
        {
            lock (stateLock)
            {
                lastSnapshot = job.Snapshot;
                if (ReferenceEquals(activeDownload, job)) activeDownload = null;
            }
            job.Cancellation.Dispose();
            job.EventWrites.Dispose();
        }
    }

    private async Task EmitProgressAsync(ActiveDownload job, JobProgress progress)
    {
        var current = BestSnapshot(job);
        SetSnapshot(job, current with
        {
            Stage = progress.Stage,
            Percent = progress.Percent ?? current.Percent,
            Path = progress.Path ?? current.Path
        });
        await WriteJobEventAsync(job, new
        {
            type = "jobProgress",
            requestId = job.RequestId,
            jobId = job.JobId,
            stage = progress.Stage,
            percent = progress.Percent,
            downloadedBytes = progress.DownloadedBytes,
            totalBytes = progress.TotalBytes,
            speedBytesPerSecond = progress.SpeedBytesPerSecond,
            etaSeconds = progress.EtaSeconds
        });
    }

    private async Task WriteJobEventAsync(ActiveDownload job, object value)
    {
        try
        {
            await job.EventWrites.WaitAsync();
            try
            {
                await channel.WriteAsync(value, CancellationToken.None);
            }
            finally
            {
                job.EventWrites.Release();
            }
        }
        catch
        {
            // The browser may close stdout while a background job is stopping.
        }
    }

    private async Task EnsureUpdateCheckedAsync(CancellationToken cancellationToken)
    {
        if (updateChecked) return;
        updateChecked = true;
        try
        {
            await updatePolicy.CheckAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            // Update failures are intentionally non-blocking for YouTube commands.
        }
    }

    private async Task<FormatCatalog> ListFormatsWithRecoveryAsync(
        string canonicalUrl,
        CancellationToken cancellationToken)
    {
        try
        {
            return await youtubeService.ListFormatsAsync(canonicalUrl, cancellationToken);
        }
        catch (Exception exception) when (
            exception is InvalidDataException or InvalidOperationException)
        {
            await EnsureUpdateCheckedAsync(cancellationToken);
            return await youtubeService.ListFormatsAsync(canonicalUrl, cancellationToken);
        }
    }

    private static TimeSpan ValidateMetadataTimeout(TimeSpan? value)
    {
        var timeout = value ?? DefaultMetadataTimeout;
        if (timeout <= TimeSpan.Zero || timeout > TimeSpan.FromMinutes(5))
            throw new ArgumentOutOfRangeException(nameof(value));
        return timeout;
    }

    private JobSnapshot? CurrentSnapshot()
    {
        ActiveDownload? active;
        JobSnapshot? fallback;
        lock (stateLock)
        {
            active = activeDownload;
            fallback = active?.Snapshot ?? lastSnapshot;
        }

        var serviceSnapshot = youtubeService.GetJob();
        if (serviceSnapshot is null) return fallback;
        if (active is null || string.Equals(serviceSnapshot.JobId, active.JobId, StringComparison.Ordinal))
            return serviceSnapshot;
        return fallback;
    }

    private JobSnapshot BestSnapshot(ActiveDownload job)
    {
        JobSnapshot? serviceSnapshot;
        try
        {
            serviceSnapshot = youtubeService.GetJob();
        }
        catch
        {
            serviceSnapshot = null;
        }
        return serviceSnapshot is not null && string.Equals(serviceSnapshot.JobId, job.JobId, StringComparison.Ordinal)
            ? serviceSnapshot
            : job.Snapshot;
    }

    private void SetSnapshot(ActiveDownload job, JobSnapshot snapshot)
    {
        lock (stateLock)
        {
            job.Snapshot = snapshot;
            if (ReferenceEquals(activeDownload, job)) lastSnapshot = snapshot;
        }
    }

    private async Task StopActiveDownloadAsync()
    {
        ActiveDownload? job;
        lock (stateLock) job = activeDownload;
        if (job is null) return;

        try
        {
            await RequestCancellationAsync(job);
        }
        catch
        {
            // Shutdown still has to observe the active task.
        }

        try
        {
            await job.Task;
        }
        catch
        {
            // ExecuteDownloadAsync contains service failures; this only protects shutdown from channel teardown.
        }
    }

    private Task WriteFailureAsync(
        string requestId,
        string code,
        string message,
        string operation,
        string? jobId,
        CancellationToken cancellationToken) =>
        channel.WriteAsync(FailurePayload(requestId, code, message, operation, jobId), cancellationToken);

    private static Dictionary<string, object?> FailurePayload(
        string requestId,
        string code,
        string message,
        string operation,
        string? jobId)
    {
        var payload = new Dictionary<string, object?>
        {
            ["type"] = "jobFailed",
            ["requestId"] = requestId,
            ["code"] = code,
            ["message"] = message,
            ["details"] = new { operation }
        };
        if (jobId is not null) payload["jobId"] = jobId;
        return payload;
    }

    private static object SnapshotPayload(JobSnapshot snapshot) => new
    {
        jobId = snapshot.JobId,
        videoId = snapshot.VideoId,
        title = snapshot.Title,
        height = snapshot.Height,
        stage = snapshot.Stage,
        percent = snapshot.Percent,
        path = snapshot.Path,
        errorCode = snapshot.ErrorCode
    };

    private static (string Code, string Message) ClassifyDownloadFailure(Exception exception)
    {
        if (exception is InvalidOperationException
            && exception.Message.Contains("metadata", StringComparison.OrdinalIgnoreCase))
        {
            return ("YOUTUBE_METADATA", "Não foi possível obter os formatos do vídeo.");
        }

        if (exception is InvalidDataException or InvalidOperationException or ArgumentException)
            return ("YOUTUBE_DOWNLOAD", "Não foi possível baixar o vídeo.");
        return ("HOST_ERROR", "O host nativo encontrou um erro.");
    }

    private static void RequireExactProperties(JsonElement payload, params string[] names)
    {
        var properties = payload.EnumerateObject().Select(property => property.Name).ToArray();
        if (properties.Length != names.Length
            || properties.Distinct(StringComparer.Ordinal).Count() != names.Length
            || names.Any(name => !properties.Contains(name, StringComparer.Ordinal)))
        {
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        }
    }

    private static string RequiredString(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var value)
            || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        }
        return value.GetString()!;
    }

    private static string TryReadRequestId(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("requestId", out var value)
            || value.ValueKind != JsonValueKind.String)
        {
            return UnknownRequestId;
        }

        var requestId = value.GetString();
        if (requestId is null or { Length: 0 } || requestId.Length > 128) return UnknownRequestId;
        return requestId.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or ':' or '-')
            ? requestId
            : UnknownRequestId;
    }

    private static void TryCancel(CancellationTokenSource cancellation)
    {
        try
        {
            cancellation.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // The download completed while cancellation was being requested.
        }
    }

    private async Task RequestCancellationAsync(ActiveDownload job)
    {
        TryCancel(job.Cancellation);
        if (!job.TryMarkCancellationRequested()) return;
        await youtubeService.CancelAsync(job.JobId);
    }

    private sealed class ActiveDownload(
        string jobId,
        string requestId,
        int height,
        string? destinationFolder,
        CancellationTokenSource cancellation,
        JobSnapshot snapshot)
    {
        public string JobId { get; } = jobId;
        public string RequestId { get; } = requestId;
        public int Height { get; } = height;
        public string? DestinationFolder { get; } = destinationFolder;
        public CancellationTokenSource Cancellation { get; } = cancellation;
        public JobSnapshot Snapshot { get; set; } = snapshot;
        public SemaphoreSlim EventWrites { get; } = new(1, 1);
        public Task Task { get; set; } = Task.CompletedTask;
        private int cancellationRequested;

        public bool TryMarkCancellationRequested() => Interlocked.Exchange(ref cancellationRequested, 1) == 0;
    }

    private sealed class CommandFailureException(string code, string message) : Exception(message)
    {
        public string Code { get; } = code;
    }

    private sealed record MoveDownloadedFilePayload(
        long DownloadId,
        string SourcePath,
        string DestinationFolder);

    private sealed record StartDownloadPayload(
        string Url,
        int Height,
        string? DestinationFolder);
}
