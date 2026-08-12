using System.Text.Json;
using VideoRadar.NativeHost.Diagnostics;
using VideoRadar.NativeHost.Files;
using VideoRadar.NativeHost.Media;
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
    TimeSpan? metadataTimeout = null,
    StartOperationJournal? startOperationJournal = null,
    DownloadQueueStore? downloadQueueStore = null,
    IDiagnosticService? diagnosticService = null) : INativeHostServer
{
    private const string UnknownRequestId = "unknown";
    private static readonly TimeSpan DefaultMetadataTimeout = TimeSpan.FromSeconds(40);
    private static readonly TimeSpan MaximumQueuePumpBackoff = TimeSpan.FromSeconds(5);
    private readonly IFolderPicker folderPicker = folderPicker ?? throw new ArgumentNullException(nameof(folderPicker));
    private readonly IDownloadFileMover fileMover = fileMover ?? throw new ArgumentNullException(nameof(fileMover));
    private readonly string fallbackDownloadFolder =
        DownloadPaths.NormalizeDestination(fallbackDownloadFolder, nameof(fallbackDownloadFolder));
    private readonly TimeSpan metadataTimeout = ValidateMetadataTimeout(metadataTimeout);
    private readonly StartOperationJournal? startOperationJournal = startOperationJournal;
    private readonly DownloadQueueStore? downloadQueueStore = downloadQueueStore;
    private readonly IResumableYouTubeService? resumableYouTubeService =
        youtubeService as IResumableYouTubeService;
    private readonly IDiagnosticService diagnosticService =
        diagnosticService ?? NullDiagnosticService.Instance;
    private readonly object stateLock = new();
    private readonly SemaphoreSlim queueSignal = new(0, 1);
    private ActiveDownload? activeDownload;
    private JobSnapshot? lastSnapshot;
    private StartDownloadPayload? lastStartPayload;
    private CancellationTokenSource? queuePumpCancellation;
    private Task? queuePumpTask;
    private bool queueShuttingDown;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        _ = updatePolicy ?? throw new ArgumentNullException(nameof(updatePolicy));
        // The dependency is retained only for constructor compatibility; pinned tools are never mutated at runtime.
        RecordDiagnostic("host_started");
        if (downloadQueueStore is not null)
        {
            if (resumableYouTubeService is null)
                throw new InvalidOperationException("The durable queue requires a resumable download service.");
            var reconciledEntries = downloadQueueStore.ReconcileAfterRestart();
            ReconcileCompletedOutputManifests(reconciledEntries);
            RecordDiagnostic("queue_reconciled");
            queuePumpCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            queuePumpTask = Task.Run(
                () => RunQueuePumpSupervisedAsync(queuePumpCancellation.Token),
                CancellationToken.None);
            SignalQueuePump();
        }
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
                catch (NativeMessageFramingException)
                {
                    // The body length is untrusted and was not consumed. Continuing would
                    // reinterpret body bytes as headers and desynchronize the connection.
                    break;
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
                        RecordDiagnostic("command_received", command.Type);
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
            if (downloadQueueStore is null)
            {
                await StopActiveDownloadAsync();
            }
            else
            {
                lock (stateLock) queueShuttingDown = true;
                await StopActiveDownloadForQueueAsync(DownloadStopIntent.Requeue);
                queuePumpCancellation?.Cancel();
                SignalQueuePump();
                if (queuePumpTask is not null)
                {
                    try
                    {
                        await queuePumpTask;
                    }
                    catch (OperationCanceledException)
                    {
                        // Expected while the browser is closing the native host.
                    }
                }
                queuePumpCancellation?.Dispose();
                queueSignal.Dispose();
            }
            RecordDiagnostic("host_stopped");
        }
    }

    private Task DispatchAsync(HostCommand command, CancellationToken cancellationToken) => command.Type switch
    {
        "ping" => HandlePingAsync(command, cancellationToken),
        "listFormats" => HandleListFormatsAsync(command, cancellationToken),
        "startDownload" => HandleStartDownloadAsync(command, cancellationToken),
        "getJob" => HandleGetJobAsync(command, cancellationToken),
        "cancelDownload" => HandleCancelDownloadAsync(command, cancellationToken),
        "pauseDownload" => HandlePauseDownloadAsync(command, cancellationToken),
        "resumeDownload" => HandleResumeDownloadAsync(command, cancellationToken),
        "listQueue" => HandleListQueueAsync(command, cancellationToken),
        "getDiagnostics" => HandleGetDiagnosticsAsync(command, cancellationToken),
        "setDiagnostics" => HandleSetDiagnosticsAsync(command, cancellationToken),
        "exportDiagnostics" => HandleExportDiagnosticsAsync(command, cancellationToken),
        "clearDiagnostics" => HandleClearDiagnosticsAsync(command, cancellationToken),
        "chooseDownloadFolder" => HandleChooseDownloadFolderAsync(command, cancellationToken),
        "moveDownloadedFile" => HandleMoveDownloadedFileAsync(command, cancellationToken),
        "revealDownloadedFile" => HandleRevealDownloadedFileAsync(command, cancellationToken),
        _ => throw new CommandFailureException("INVALID_COMMAND", "Comando inválido.")
    };

    private Task HandleGetDiagnosticsAsync(
        HostCommand command,
        CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload);
        return WriteDiagnosticsAsync(command.RequestId, cancellationToken);
    }

    private Task HandleSetDiagnosticsAsync(
        HostCommand command,
        CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload, "enabled");
        if (!command.Payload.TryGetProperty("enabled", out var value)
            || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        }
        try
        {
            diagnosticService.SetEnabled(value.GetBoolean());
            return WriteDiagnosticsAsync(command.RequestId, cancellationToken);
        }
        catch (Exception exception) when (
            exception is IOException
            or UnauthorizedAccessException
            or NotSupportedException
            or ArgumentException
            or System.Security.SecurityException)
        {
            throw new CommandFailureException(
                "DIAGNOSTICS_UNAVAILABLE",
                "Não foi possível atualizar o diagnóstico local.");
        }
    }

    private Task WriteDiagnosticsAsync(string requestId, CancellationToken cancellationToken)
    {
        DiagnosticSummary summary;
        try
        {
            summary = diagnosticService.GetSummary(fallbackDownloadFolder);
        }
        catch (Exception exception) when (
            exception is IOException
            or UnauthorizedAccessException
            or NotSupportedException
            or ArgumentException
            or System.Security.SecurityException)
        {
            throw new CommandFailureException(
                "DIAGNOSTICS_UNAVAILABLE",
                "O diagnóstico local não está disponível.");
        }

        return channel.WriteAsync(new
        {
            type = "diagnostics",
            requestId,
            generatedAt = summary.GeneratedAt,
            hostVersion = summary.HostVersion,
            protocolVersion = summary.ProtocolVersion,
            architecture = summary.Architecture,
            operatingSystem = summary.OperatingSystem,
            availableBytes = summary.AvailableBytes,
            loggingEnabled = summary.LoggingEnabled,
            logFileCount = summary.LogFileCount,
            tools = summary.Tools.Select(tool => new
            {
                name = tool.Name,
                available = tool.Available,
                version = tool.Version,
                sizeBytes = tool.SizeBytes,
                sha256 = tool.Sha256
            }).ToArray()
        }, cancellationToken);
    }

    private async Task HandleExportDiagnosticsAsync(
        HostCommand command,
        CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload, "destinationFolder");
        string destination;
        try
        {
            destination = DownloadPaths.NormalizeDestination(
                RequiredString(command.Payload, "destinationFolder"),
                "destinationFolder");
        }
        catch (ArgumentException)
        {
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        }

        try
        {
            var path = await Task.Run(
                () => diagnosticService.Export(destination, fallbackDownloadFolder),
                cancellationToken);
            await channel.WriteAsync(new
            {
                type = "diagnosticsExported",
                requestId = command.RequestId,
                path
            }, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception) when (
            exception is IOException
            or UnauthorizedAccessException
            or NotSupportedException
            or ArgumentException
            or System.Security.SecurityException)
        {
            throw new CommandFailureException(
                "DIAGNOSTICS_EXPORT_FAILED",
                "Não foi possível exportar o diagnóstico.");
        }
    }

    private Task HandleClearDiagnosticsAsync(
        HostCommand command,
        CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload);
        try
        {
            diagnosticService.Clear();
        }
        catch (Exception exception) when (
            exception is IOException
            or UnauthorizedAccessException
            or NotSupportedException
            or ArgumentException
            or System.Security.SecurityException)
        {
            throw new CommandFailureException(
                "DIAGNOSTICS_UNAVAILABLE",
                "Não foi possível apagar os registros locais.");
        }
        return channel.WriteAsync(new
        {
            type = "diagnosticsCleared",
            requestId = command.RequestId
        }, cancellationToken);
    }

    private Task HandlePingAsync(HostCommand command, CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload);
        return channel.WriteAsync(new
        {
            type = "ready",
            requestId = command.RequestId,
            protocolVersion = HostInfo.ProtocolVersion,
            nativeName = HostInfo.NativeName,
            hostVersion = HostInfo.Version,
            capabilities = HostInfo.Capabilities,
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
        if (!MediaPage.TryCanonicalize(url, out var page))
            throw new CommandFailureException("INVALID_URL", "URL de mídia inválida.");
        var canonicalUrl = page!.CanonicalUrl;

        FormatCatalog catalog;
        using var metadataCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        metadataCancellation.CancelAfter(metadataTimeout);
        try
        {
            catalog = await youtubeService.ListFormatsAsync(
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
            platform = catalog.Platform,
            videoId = catalog.VideoId,
            title = catalog.Title,
            durationSeconds = catalog.DurationSeconds,
            qualities = catalog.Qualities.Select(quality => new
            {
                height = quality.Height,
                label = quality.Label,
                container = quality.Container,
                combined = quality.Combined,
                fps = quality.Fps,
                hdr = quality.Hdr,
                dynamicRange = quality.DynamicRange,
                videoCodec = quality.VideoCodec,
                audioCodec = quality.AudioCodec,
                bitrateKbps = quality.BitrateKbps,
                estimatedSizeBytes = quality.EstimatedSizeBytes,
                estimatedSizeApproximate = quality.EstimatedSizeApproximate
            }).ToArray(),
            formats = catalog.Formats.Select(format => new
            {
                formatId = format.FormatId,
                height = format.Height,
                container = format.Container,
                combined = format.Combined,
                audioOnly = format.AudioOnly,
                fps = format.Fps,
                hdr = format.Hdr,
                dynamicRange = format.DynamicRange,
                videoCodec = format.VideoCodec,
                audioCodec = format.AudioCodec,
                bitrateKbps = format.BitrateKbps,
                fileSizeBytes = format.FileSizeBytes,
                fileSizeApproximate = format.FileSizeApproximate,
                language = format.Language
            }).ToArray(),
            subtitles = catalog.Subtitles.Select(subtitle => new
            {
                language = subtitle.Language,
                label = subtitle.Label,
                automatic = subtitle.Automatic,
                containers = subtitle.Containers
            }).ToArray(),
            audioLanguages = catalog.AudioLanguages
        }, cancellationToken);
    }

    private async Task HandleMoveDownloadedFileAsync(HostCommand command, CancellationToken cancellationToken)
    {
        try
        {
            RequireExactProperties(
                command.Payload,
                "operationId",
                "downloadId",
                "sourcePath",
                "destinationFolder");
            if (!command.Payload.TryGetProperty("downloadId", out var downloadIdValue)
                || downloadIdValue.ValueKind != JsonValueKind.Number
                || !downloadIdValue.TryGetInt64(out var downloadId)
                || downloadId < 0)
            {
                throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
            }

            var operationId = RequiredString(command.Payload, "operationId");
            if (!IsSafeFileMoveOperationId(operationId))
                throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
            var payload = new MoveDownloadedFilePayload(
                operationId,
                downloadId,
                RequiredString(command.Payload, "sourcePath"),
                RequiredString(command.Payload, "destinationFolder"));
            var delivered = fileMover.Move(
                payload.SourcePath,
                payload.DestinationFolder,
                payload.DownloadId,
                payload.OperationId);
            await channel.WriteAsync(new
            {
                type = "fileMoved",
                requestId = command.RequestId,
                operationId = payload.OperationId,
                downloadId = delivered.DownloadId,
                finalPath = delivered.FinalPath
            }, cancellationToken);
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
        var usesRichSelection = command.Payload.TryGetProperty("selection", out var selectionValue);
        if (usesRichSelection)
        {
            if (command.Payload.TryGetProperty("media", out _))
                RequireExactProperties(command.Payload, "operationId", "url", "selection", "destinationFolder", "media");
            else
                RequireExactProperties(command.Payload, "operationId", "url", "selection", "destinationFolder");
        }
        else
            RequireExactProperties(command.Payload, "operationId", "url", "height", "destinationFolder");
        var operationId = RequiredString(command.Payload, "operationId");
        if (!IsSafeId(operationId))
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        var url = RequiredString(command.Payload, "url");
        if (!MediaPage.TryCanonicalize(url, out var page))
            throw new CommandFailureException("INVALID_URL", "URL de mídia inválida.");
        var canonicalUrl = page!.CanonicalUrl;
        var selection = usesRichSelection
            ? ParseDownloadSelection(selectionValue)
            : DownloadSelection.Video(RequiredHeight(command.Payload));
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

        var media = usesRichSelection && command.Payload.TryGetProperty("media", out var mediaValue)
            ? ParseStartMedia(mediaValue)
            : null;
        var payload = new StartDownloadPayload(operationId, canonicalUrl, selection, destinationFolder);

        if (downloadQueueStore is not null)
        {
            await EnqueueDownloadAsync(command, payload, media, cancellationToken);
            return;
        }
        if (usesRichSelection)
            throw new CommandFailureException(
                "UNSUPPORTED_CAPABILITY",
                "Esta instalação não oferece a fila de downloads avançada.");

        ActiveDownload? replayedActive = null;
        JobSnapshot? replayedTerminal = null;
        lock (stateLock)
        {
            if (activeDownload is not null)
            {
                if (!string.Equals(
                    activeDownload.OperationId,
                    payload.OperationId,
                    StringComparison.Ordinal))
                {
                    throw new CommandFailureException("YOUTUBE_BUSY", "Já existe um download do YouTube em andamento.");
                }
                if (!activeDownload.Payload.Matches(payload))
                    throw new CommandFailureException("INVALID_PAYLOAD", "A operação já existe com outro payload.");
                replayedActive = activeDownload;
            }
            else if (lastSnapshot is not null
                && lastStartPayload is not null
                && string.Equals(lastStartPayload.OperationId, payload.OperationId, StringComparison.Ordinal))
            {
                if (!lastStartPayload.Matches(payload))
                    throw new CommandFailureException("INVALID_PAYLOAD", "A operação já existe com outro payload.");
                replayedTerminal = lastSnapshot;
            }
        }

        if (replayedActive is not null)
        {
            await WriteJobStartedAsync(
                command.RequestId,
                replayedActive.JobId,
                BestSnapshot(replayedActive),
                cancellationToken);
            return;
        }
        if (replayedTerminal is not null)
        {
            await WriteJobStartedAsync(
                command.RequestId,
                replayedTerminal.JobId,
                replayedTerminal,
                cancellationToken);
            return;
        }

        var durableDecision = PrepareDurableStart(
            payload,
            Guid.NewGuid().ToString("D"));
        if (durableDecision.ReplayedSnapshot is not null)
        {
            lock (stateLock)
            {
                lastSnapshot = durableDecision.ReplayedSnapshot;
                lastStartPayload = payload;
            }
            await WriteJobStartedAsync(
                command.RequestId,
                durableDecision.JobId,
                durableDecision.ReplayedSnapshot,
                cancellationToken);
            return;
        }

        var jobId = durableDecision.JobId;
        var cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var initialSnapshot = new JobSnapshot(
            jobId,
            string.Empty,
            string.Empty,
            payload.Height,
            "preparing",
            null,
            null,
            null,
            payload.OperationId);
        var job = new ActiveDownload(
            jobId,
            command.RequestId,
            payload,
            cancellation,
            initialSnapshot,
            durableDecision.ActiveLease);
        lock (stateLock)
        {
            if (activeDownload is not null)
            {
                durableDecision.ActiveLease?.Dispose();
                cancellation.Dispose();
                throw new CommandFailureException("YOUTUBE_BUSY", "Já existe um download do YouTube em andamento.");
            }

            activeDownload = job;
        }

        try
        {
            PersistSnapshot(job, initialSnapshot);
            await WriteJobStartedAsync(command.RequestId, jobId, initialSnapshot, cancellationToken);
        }
        catch
        {
            lock (stateLock)
            {
                if (ReferenceEquals(activeDownload, job)) activeDownload = null;
            }
            PersistTerminalBestEffort(
                job,
                initialSnapshot with { Stage = "failed", ErrorCode = "HOST_CHANNEL_CLOSED" });
            cancellation.Cancel();
            cancellation.Dispose();
            job.ActiveLease?.Dispose();
            job.EventWrites.Dispose();
            throw;
        }

        job.Task = Task.Run(
            () => ExecuteDownloadAsync(job, payload.Url),
            CancellationToken.None);
    }

    private async Task EnqueueDownloadAsync(
        HostCommand command,
        StartDownloadPayload payload,
        StartMediaMetadata? media,
        CancellationToken cancellationToken)
    {
        DownloadQueueEnqueueResult result;
        try
        {
            result = downloadQueueStore!.Enqueue(
                payload.OperationId,
                Guid.NewGuid().ToString("D"),
                payload.Url,
                payload.Selection,
                payload.DestinationFolder,
                media?.VideoId,
                media?.Title);
        }
        catch (DownloadQueuePayloadConflictException)
        {
            throw new CommandFailureException(
                "INVALID_PAYLOAD",
                "A operação já existe com outro payload.");
        }
        catch (DownloadQueueFullException)
        {
            throw new CommandFailureException(
                "QUEUE_FULL",
                "A fila de downloads está cheia.");
        }

        await channel.WriteAsync(new
        {
            type = "jobQueued",
            requestId = command.RequestId,
            jobId = result.Entry.JobId,
            operationId = result.Entry.OperationId,
            replayed = result.Replayed,
            position = result.Position,
            job = QueueEntryPayload(result.Entry, result.Position)
        }, cancellationToken);
        RecordDiagnostic("download_queued", result.Replayed ? "replayed" : "created");

        if (result.Entry.State == DownloadQueueStates.Queued)
            SignalQueuePump();
    }

    private async Task RunQueuePumpAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            await queueSignal.WaitAsync(cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();

            while (true)
            {
                ActiveDownload? active;
                bool shuttingDown;
                lock (stateLock)
                {
                    active = activeDownload;
                    shuttingDown = queueShuttingDown;
                }
                if (shuttingDown) return;
                if (active is not null)
                {
                    await active.Task.WaitAsync(cancellationToken);
                    continue;
                }

                var queueEntries = downloadQueueStore!.ReconcileAfterRestart();
                var next = queueEntries
                    .Where(entry => entry.State == DownloadQueueStates.Queued)
                    .OrderBy(entry => entry.Sequence)
                    .FirstOrDefault();
                if (next is null)
                {
                    if (queueEntries.Any(entry => entry.State == DownloadQueueStates.Running))
                    {
                        await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
                        SignalQueuePump();
                    }
                    break;
                }

                var runnerLease = downloadQueueStore.TryAcquireRunnerLease(
                    next.OperationId,
                    next.JobId);
                if (runnerLease is null)
                {
                    await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
                    SignalQueuePump();
                    break;
                }

                ActiveDownload? started = null;
                try
                {
                    var running = downloadQueueStore.Update(next.JobId, current =>
                    {
                        if (current.State != DownloadQueueStates.Queued) return current;
                        return current with
                        {
                            State = DownloadQueueStates.Running,
                            AttemptCount = checked(current.AttemptCount + 1),
                            Snapshot = current.Snapshot with
                            {
                                Stage = "preparing",
                                ErrorCode = null,
                                OperationId = current.OperationId
                            }
                        };
                    });
                    if (running.State != DownloadQueueStates.Running)
                    {
                        runnerLease.Dispose();
                        continue;
                    }

                    var queueCancellation = new CancellationTokenSource();
                    var payload = new StartDownloadPayload(
                        running.OperationId,
                        running.Url,
                        running.Selection,
                        running.DestinationFolder);
                    started = new ActiveDownload(
                        running.JobId,
                        $"queue:{running.JobId}",
                        payload,
                        queueCancellation,
                        running.Snapshot,
                        runnerLease,
                        isDurableQueue: true,
                        resumePartial: running.ResumePartial);
                    lock (stateLock)
                    {
                        if (queueShuttingDown || activeDownload is not null)
                        {
                            runnerLease.Dispose();
                            queueCancellation.Dispose();
                            downloadQueueStore.Update(running.JobId, entry => entry with
                            {
                                State = DownloadQueueStates.Queued,
                                Snapshot = entry.Snapshot with { Stage = DownloadQueueStates.Queued }
                            });
                            continue;
                        }
                        activeDownload = started;
                        lastSnapshot = running.Snapshot;
                        lastStartPayload = payload;
                        // Publish the active job only after its task is assigned.
                        // Control commands also take stateLock, so they can never
                        // observe Task.CompletedTask during this startup window.
                        started.Task = Task.Run(
                            () => ExecuteQueuedDownloadAsync(started),
                            CancellationToken.None);
                    }
                }
                catch
                {
                    if (started is null) runnerLease.Dispose();
                    throw;
                }

                await started.Task.WaitAsync(cancellationToken);
            }
        }
    }

    private async Task RunQueuePumpSupervisedAsync(CancellationToken cancellationToken)
    {
        var consecutiveFailures = 0;
        while (true)
        {
            try
            {
                await RunQueuePumpAsync(cancellationToken);
                return;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception) when (IsRecoverableQueuePumpFailure(exception))
            {
                consecutiveFailures = Math.Min(consecutiveFailures + 1, 6);
                RecordDiagnostic("queue_pump_recovered", SafeQueuePumpFailureCode(exception));
                var delayMilliseconds = Math.Min(
                    MaximumQueuePumpBackoff.TotalMilliseconds,
                    100 * Math.Pow(2, consecutiveFailures - 1));
                await Task.Delay(TimeSpan.FromMilliseconds(delayMilliseconds), cancellationToken);
                SignalQueuePump();
            }
        }
    }

    private async Task ExecuteQueuedDownloadAsync(ActiveDownload job)
    {
        try
        {
            await WriteJobEventAsync(job, new
            {
                type = "jobStarted",
                requestId = job.RequestId,
                jobId = job.JobId,
                operationId = job.OperationId,
                resumed = job.ResumePartial,
                job = QueueEntryPayload(
                    downloadQueueStore!.ReadByJobId(job.JobId)!,
                    1)
            });
            RecordDiagnostic("download_started", job.ResumePartial ? "resumed" : "new");

            var result = await resumableYouTubeService!.StartDownloadAsync(
                job.JobId,
                job.Payload.Url,
                job.Payload.Selection,
                job.DestinationFolder,
                new DownloadRunOptions(
                    ResumePartial: job.ResumePartial,
                    PreservePartialOnCancellation: false,
                    DurableOutputIdentity: true),
                progress => EmitProgressAsync(job, progress),
                job.Cancellation.Token);
            var completedSnapshot = BestSnapshot(job) with
            {
                Stage = DownloadQueueStates.Complete,
                Percent = 100,
                Path = result.Path,
                ErrorCode = null
            };
            SetSnapshot(job, completedSnapshot);
            var completed = downloadQueueStore!.Update(job.JobId, entry => entry with
            {
                State = DownloadQueueStates.Complete,
                Snapshot = completedSnapshot,
                // Keep the durable identity non-prunable until the validated
                // output manifest is verified and released below.
                ResumePartial = true
            });
            var manifestCommitted = false;
            try
            {
                await resumableYouTubeService.CommitCompletedAsync(
                    job.JobId,
                    job.DestinationFolder,
                    result.Path,
                    CancellationToken.None);
                manifestCommitted = true;
            }
            catch (OutputOwnershipMismatchException)
            {
                var failed = downloadQueueStore.TryMarkCompletedOutputMismatch(
                    job.JobId,
                    result.Path);
                if (failed is not null)
                {
                    SetSnapshot(job, failed.Snapshot);
                    await WriteJobEventAsync(job, new
                    {
                        type = "jobFailed",
                        requestId = job.RequestId,
                        jobId = job.JobId,
                        operationId = job.OperationId,
                        code = "OUTPUT_OWNERSHIP_MISMATCH",
                        message = "O arquivo reservado foi alterado por outro processo e foi preservado.",
                        details = new { operation = "download" },
                        job = QueueEntryPayload(failed, null)
                    });
                    RecordDiagnostic("download_failed", "OUTPUT_OWNERSHIP_MISMATCH");
                }
                return;
            }
            catch
            {
                // The queue commit is authoritative. A leftover validated manifest
                // is safe and can be removed by a later maintenance pass.
            }
            if (manifestCommitted)
            {
                completed = downloadQueueStore.TryFinalizeCompletedOutput(
                    job.JobId,
                    result.Path) ?? completed;
            }
            if (!downloadQueueStore.IsCompletedOutputStillCurrent(job.JobId, result.Path))
                return;
            await WriteJobEventAsync(job, new
            {
                type = "jobCompleted",
                requestId = job.RequestId,
                jobId = job.JobId,
                operationId = job.OperationId,
                path = result.Path,
                job = QueueEntryPayload(completed, null)
            });
            RecordDiagnostic("download_completed");
        }
        catch (OperationCanceledException)
        {
            var intent = job.StopIntent;
            var targetState = intent switch
            {
                DownloadStopIntent.Pause => DownloadQueueStates.Paused,
                DownloadStopIntent.Requeue => DownloadQueueStates.Queued,
                DownloadStopIntent.Cancel => DownloadQueueStates.Cancelled,
                _ => DownloadQueueStates.Failed
            };
            var errorCode = intent == DownloadStopIntent.None
                ? "DOWNLOAD_INTERRUPTED"
                : null;
            var stoppedSnapshot = BestSnapshot(job) with
            {
                Stage = targetState,
                Path = null,
                ErrorCode = errorCode
            };
            SetSnapshot(job, stoppedSnapshot);
            var stopped = downloadQueueStore!.Update(job.JobId, entry => entry with
            {
                State = targetState,
                Snapshot = stoppedSnapshot,
                ResumePartial = targetState != DownloadQueueStates.Cancelled
            });
            switch (targetState)
            {
                case DownloadQueueStates.Paused:
                    await WriteJobEventAsync(job, new
                    {
                        type = "jobPaused",
                        requestId = job.RequestId,
                        jobId = job.JobId,
                        operationId = job.OperationId,
                        job = QueueEntryPayload(stopped, null)
                    });
                    RecordDiagnostic("download_paused");
                    break;
                case DownloadQueueStates.Queued:
                    var position = QueuePosition(stopped);
                    await WriteJobEventAsync(job, new
                    {
                        type = "jobQueued",
                        requestId = job.RequestId,
                        jobId = job.JobId,
                        operationId = job.OperationId,
                        replayed = false,
                        position,
                        job = QueueEntryPayload(stopped, position)
                    });
                    RecordDiagnostic("download_requeued");
                    break;
                case DownloadQueueStates.Cancelled:
                    await WriteJobEventAsync(job, new
                    {
                        type = "jobCancelled",
                        requestId = job.RequestId,
                        jobId = job.JobId,
                        operationId = job.OperationId,
                        job = QueueEntryPayload(stopped, null)
                    });
                    RecordDiagnostic("download_cancelled");
                    break;
                default:
                    await WriteJobEventAsync(job, new
                    {
                        type = "jobFailed",
                        requestId = job.RequestId,
                        jobId = job.JobId,
                        operationId = job.OperationId,
                        code = errorCode!,
                        message = "O download foi interrompido inesperadamente.",
                        details = new { operation = "download" },
                        job = QueueEntryPayload(stopped, null)
                    });
                    RecordDiagnostic("download_failed", errorCode);
                    break;
            }
        }
        catch (Exception exception)
        {
            var (code, message) = ClassifyDownloadFailure(exception);
            var failedSnapshot = BestSnapshot(job) with
            {
                Stage = DownloadQueueStates.Failed,
                Path = null,
                ErrorCode = code
            };
            SetSnapshot(job, failedSnapshot);
            var failed = downloadQueueStore!.Update(job.JobId, entry => entry with
            {
                State = DownloadQueueStates.Failed,
                Snapshot = failedSnapshot,
                // Durable queue runs create their output identity before invoking
                // yt-dlp. Retain that identity for an idempotent retry; cancelling
                // the Failed entry explicitly discards it.
                ResumePartial = true
            });
            await WriteJobEventAsync(job, new
            {
                type = "jobFailed",
                requestId = job.RequestId,
                jobId = job.JobId,
                operationId = job.OperationId,
                code,
                message,
                details = new { operation = "download" },
                job = QueueEntryPayload(failed, null)
            });
            RecordDiagnostic("download_failed", code);
        }
        finally
        {
            lock (stateLock)
            {
                lastSnapshot = job.Snapshot;
                lastStartPayload = job.Payload;
                if (ReferenceEquals(activeDownload, job)) activeDownload = null;
            }
            job.Cancellation.Dispose();
            job.ActiveLease?.Dispose();
            job.EventWrites.Dispose();
            SignalQueuePump();
        }
    }

    private DurableStartDecision PrepareDurableStart(
        StartDownloadPayload payload,
        string proposedJobId)
    {
        if (startOperationJournal is null)
            return new DurableStartDecision(proposedJobId, null, null);

        var entry = startOperationJournal.Read(payload.OperationId);
        if (entry is not null)
        {
            EnsureMatchingDurablePayload(entry, payload);
            if (entry.Terminal)
                return new DurableStartDecision(entry.JobId, entry.Snapshot, null);

            var staleLease = startOperationJournal.TryAcquireActiveLock(
                entry.OperationId,
                entry.JobId);
            if (staleLease is null)
            {
                var owner = startOperationJournal.ReadActiveOwner();
                if (owner is not null
                    && string.Equals(owner.OperationId, entry.OperationId, StringComparison.Ordinal)
                    && string.Equals(owner.JobId, entry.JobId, StringComparison.Ordinal))
                {
                    return new DurableStartDecision(entry.JobId, entry.Snapshot, null);
                }

                throw new CommandFailureException(
                    "YOUTUBE_BUSY",
                    "Já existe um download do YouTube em andamento.");
            }

            using (staleLease)
            {
                var interrupted = entry.Snapshot with
                {
                    Stage = "failed",
                    ErrorCode = "HOST_RESTARTED"
                };
                startOperationJournal.Write(StartOperationJournalEntry.Create(
                    entry.OperationId,
                    entry.JobId,
                    entry.Url,
                    entry.Height,
                    entry.DestinationFolder,
                    interrupted));
                return new DurableStartDecision(entry.JobId, interrupted, null);
            }
        }

        var activeLease = startOperationJournal.TryAcquireActiveLock(
            payload.OperationId,
            proposedJobId);
        if (activeLease is not null)
            return new DurableStartDecision(proposedJobId, null, activeLease);

        // Another process can acquire the global lease just before publishing its
        // operation entry. Re-read once so an identical request can still replay it.
        entry = startOperationJournal.Read(payload.OperationId);
        var activeOwner = startOperationJournal.ReadActiveOwner();
        if (entry is not null)
        {
            EnsureMatchingDurablePayload(entry, payload);
            if (entry.Terminal)
                return new DurableStartDecision(entry.JobId, entry.Snapshot, null);
            if (activeOwner is not null
                && string.Equals(activeOwner.OperationId, entry.OperationId, StringComparison.Ordinal)
                && string.Equals(activeOwner.JobId, entry.JobId, StringComparison.Ordinal))
            {
                return new DurableStartDecision(entry.JobId, entry.Snapshot, null);
            }
        }

        throw new CommandFailureException(
            "YOUTUBE_BUSY",
            "Já existe um download do YouTube em andamento.");
    }

    private static void EnsureMatchingDurablePayload(
        StartOperationJournalEntry entry,
        StartDownloadPayload payload)
    {
        if (!string.Equals(entry.OperationId, payload.OperationId, StringComparison.Ordinal)
            || !string.Equals(entry.Url, payload.Url, StringComparison.Ordinal)
            || entry.Height != payload.Height
            || !string.Equals(
                entry.DestinationFolder,
                payload.DestinationFolder,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new CommandFailureException(
                "INVALID_PAYLOAD",
                "A operação já existe com outro payload.");
        }
    }

    private Task HandleGetJobAsync(HostCommand command, CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload);
        if (downloadQueueStore is not null)
        {
            var active = downloadQueueStore.ReadAll()
                .FirstOrDefault(entry => entry.State == DownloadQueueStates.Running);
            return channel.WriteAsync(new
            {
                type = "ready",
                requestId = command.RequestId,
                job = active is null ? null : SnapshotPayload(active.Snapshot)
            }, cancellationToken);
        }
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
        if (downloadQueueStore is not null)
        {
            await CancelQueuedDownloadAsync(command.RequestId, jobId, cancellationToken);
            return;
        }
        ActiveDownload? job;
        lock (stateLock) job = activeDownload;
        if (job is null || !string.Equals(job.JobId, jobId, StringComparison.Ordinal))
            throw new CommandFailureException("JOB_NOT_FOUND", "O download informado não está ativo.");

        try
        {
            await RequestCancellationAsync(job);
            await job.Task.WaitAsync(cancellationToken);
            await channel.WriteAsync(new
            {
                type = "jobCancelled",
                requestId = command.RequestId,
                jobId = job.JobId
            }, cancellationToken);
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

    private async Task HandlePauseDownloadAsync(
        HostCommand command,
        CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload, "jobId");
        if (downloadQueueStore is null)
            throw new CommandFailureException(
                "UNSUPPORTED_CAPABILITY",
                "Esta instalação não oferece pausa de downloads.");
        var jobId = RequiredString(command.Payload, "jobId");
        var entry = downloadQueueStore.ReadByJobId(jobId)
            ?? throw new CommandFailureException("JOB_NOT_FOUND", "O download informado não existe.");
        if (entry.Terminal)
            throw new CommandFailureException("INVALID_JOB_STATE", "O download já foi finalizado.");

        ActiveDownload? active;
        lock (stateLock) active = activeDownload;
        if (active is null && entry.State == DownloadQueueStates.Running)
        {
            await Task.Delay(25, cancellationToken);
            lock (stateLock) active = activeDownload;
        }
        if (active is not null && string.Equals(active.JobId, jobId, StringComparison.Ordinal))
        {
            active.SetStopIntent(DownloadStopIntent.Pause);
            await resumableYouTubeService!.PauseAsync(jobId);
            TryCancel(active.Cancellation);
            await active.Task.WaitAsync(cancellationToken);
            entry = downloadQueueStore.ReadByJobId(jobId)!;
        }
        else if (entry.State == DownloadQueueStates.Queued)
        {
            entry = downloadQueueStore.Update(jobId, current => current with
            {
                State = current.State == DownloadQueueStates.Queued
                    ? DownloadQueueStates.Paused
                    : current.State,
                Snapshot = current.State == DownloadQueueStates.Queued
                    ? current.Snapshot with
                    {
                        Stage = DownloadQueueStates.Paused,
                        ErrorCode = null
                    }
                    : current.Snapshot
            });
        }

        if (entry.State == DownloadQueueStates.Running)
            throw new CommandFailureException(
                "JOB_OWNED_BY_ANOTHER_HOST",
                "O download está ativo em outro processo do host.");
        if (entry.State != DownloadQueueStates.Paused)
            throw new CommandFailureException(
                "INVALID_JOB_STATE",
                "O download foi finalizado antes da pausa.");

        await channel.WriteAsync(new
        {
            type = "jobPaused",
            requestId = command.RequestId,
            jobId = entry.JobId,
            operationId = entry.OperationId,
            job = QueueEntryPayload(entry, null)
        }, cancellationToken);
    }

    private async Task HandleResumeDownloadAsync(
        HostCommand command,
        CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload, "jobId");
        if (downloadQueueStore is null)
            throw new CommandFailureException(
                "UNSUPPORTED_CAPABILITY",
                "Esta instalação não oferece retomada de downloads.");
        var jobId = RequiredString(command.Payload, "jobId");
        var entry = downloadQueueStore.ReadByJobId(jobId)
            ?? throw new CommandFailureException("JOB_NOT_FOUND", "O download informado não existe.");
        if (entry.State == DownloadQueueStates.Paused)
        {
            entry = downloadQueueStore.Update(jobId, current => current with
            {
                State = DownloadQueueStates.Queued,
                Snapshot = current.Snapshot with
                {
                    Stage = DownloadQueueStates.Queued,
                    ErrorCode = null
                },
                ResumePartial = true
            });
        }
        else if (entry.State is not (DownloadQueueStates.Queued or DownloadQueueStates.Running))
        {
            throw new CommandFailureException("INVALID_JOB_STATE", "O download não pode ser retomado.");
        }

        var position = QueuePosition(entry);
        await channel.WriteAsync(new
        {
            type = "jobQueued",
            requestId = command.RequestId,
            jobId = entry.JobId,
            operationId = entry.OperationId,
            replayed = entry.State != DownloadQueueStates.Queued,
            position,
            job = QueueEntryPayload(entry, position)
        }, cancellationToken);
        SignalQueuePump();
    }

    private Task HandleListQueueAsync(
        HostCommand command,
        CancellationToken cancellationToken)
    {
        RequireExactProperties(command.Payload);
        if (downloadQueueStore is null)
            throw new CommandFailureException(
                "UNSUPPORTED_CAPABILITY",
                "Esta instalação não oferece fila de downloads.");
        var entries = downloadQueueStore.ReadAll();
        return channel.WriteAsync(new
        {
            type = "queueSnapshot",
            requestId = command.RequestId,
            maxActive = 1,
            maxPending = DownloadQueueStore.MaximumNonTerminalEntries,
            jobs = entries.Select(entry => QueueEntryPayload(entry, QueuePosition(entry))).ToArray()
        }, cancellationToken);
    }

    private async Task CancelQueuedDownloadAsync(
        string requestId,
        string jobId,
        CancellationToken cancellationToken)
    {
        var entry = downloadQueueStore!.ReadByJobId(jobId)
            ?? throw new CommandFailureException("JOB_NOT_FOUND", "O download informado não existe.");
        if (entry.State == DownloadQueueStates.Cancelled)
        {
            if (entry.ResumePartial)
            {
                await resumableYouTubeService!.DiscardPartialAsync(
                    jobId,
                    entry.DestinationFolder,
                    cancellationToken);
                entry = downloadQueueStore.Update(jobId, current => current with
                {
                    ResumePartial = false
                });
            }
            await WriteQueueCancelledAsync(requestId, entry, cancellationToken);
            return;
        }
        if (entry.State == DownloadQueueStates.Failed)
        {
            // Preserve the durable identity until cancellation is committed. If
            // cleanup is interrupted, ResumePartial keeps the entry retryable by
            // a subsequent cancel instead of orphaning its temp directory.
            entry = downloadQueueStore.Update(jobId, current => current with
            {
                State = DownloadQueueStates.Cancelled,
                Snapshot = current.Snapshot with
                {
                    Stage = DownloadQueueStates.Cancelled,
                    Path = null,
                    ErrorCode = null
                },
                ResumePartial = true
            });
            await resumableYouTubeService!.DiscardPartialAsync(
                jobId,
                entry.DestinationFolder,
                cancellationToken);
            entry = downloadQueueStore.Update(jobId, current => current with
            {
                ResumePartial = false
            });
            await WriteQueueCancelledAsync(requestId, entry, cancellationToken);
            return;
        }
        if (entry.Terminal)
            throw new CommandFailureException("INVALID_JOB_STATE", "O download já foi finalizado.");

        ActiveDownload? active;
        lock (stateLock) active = activeDownload;
        if (active is null && entry.State == DownloadQueueStates.Running)
        {
            await Task.Delay(25, cancellationToken);
            lock (stateLock) active = activeDownload;
        }
        if (active is not null && string.Equals(active.JobId, jobId, StringComparison.Ordinal))
        {
            active.SetStopIntent(DownloadStopIntent.Cancel);
            TryCancel(active.Cancellation);
            await youtubeService.CancelAsync(jobId);
            await active.Task.WaitAsync(cancellationToken);
            entry = downloadQueueStore.ReadByJobId(jobId)!;
        }
        else
        {
            entry = downloadQueueStore.ReadByJobId(jobId)!;
            if (entry.State == DownloadQueueStates.Running)
                throw new CommandFailureException(
                    "JOB_OWNED_BY_ANOTHER_HOST",
                    "O download está ativo em outro processo do host.");
            var shouldDiscardPartial =
                entry.ResumePartial || entry.State == DownloadQueueStates.Paused;
            entry = downloadQueueStore.Update(jobId, current => current with
            {
                State = current.State is DownloadQueueStates.Queued or DownloadQueueStates.Paused
                    ? DownloadQueueStates.Cancelled
                    : current.State,
                Snapshot = current.State is DownloadQueueStates.Queued or DownloadQueueStates.Paused
                    ? current.Snapshot with
                    {
                        Stage = DownloadQueueStates.Cancelled,
                        ErrorCode = null
                    }
                    : current.Snapshot,
                ResumePartial = current.State is DownloadQueueStates.Queued or DownloadQueueStates.Paused
                    ? shouldDiscardPartial
                    : current.ResumePartial
            });
            if (entry.State == DownloadQueueStates.Running)
                throw new CommandFailureException(
                    "JOB_OWNED_BY_ANOTHER_HOST",
                    "O download está ativo em outro processo do host.");
            if (shouldDiscardPartial && entry.State == DownloadQueueStates.Cancelled)
            {
                await resumableYouTubeService!.DiscardPartialAsync(
                    jobId,
                    entry.DestinationFolder,
                    cancellationToken);
                entry = downloadQueueStore.Update(jobId, current => current with
                {
                    ResumePartial = false
                });
            }
        }

        if (entry.State != DownloadQueueStates.Cancelled)
            throw new CommandFailureException(
                "INVALID_JOB_STATE",
                "O download foi finalizado antes do cancelamento.");
        await WriteQueueCancelledAsync(requestId, entry, cancellationToken);
    }

    private Task WriteQueueCancelledAsync(
        string requestId,
        DownloadQueueEntry entry,
        CancellationToken cancellationToken) =>
        channel.WriteAsync(new
        {
            type = "jobCancelled",
            requestId,
            jobId = entry.JobId,
            operationId = entry.OperationId,
            job = QueueEntryPayload(entry, null)
        }, cancellationToken);

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
            PersistTerminalBestEffort(job, completed);
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
            PersistTerminalBestEffort(job, cancelled);
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
            PersistTerminalBestEffort(job, failed);
            await WriteJobEventAsync(job, FailurePayload(job.RequestId, code, message, "download", job.JobId));
        }
        finally
        {
            lock (stateLock)
            {
                lastSnapshot = job.Snapshot;
                lastStartPayload = job.Payload;
                if (ReferenceEquals(activeDownload, job)) activeDownload = null;
            }
            job.Cancellation.Dispose();
            job.ActiveLease?.Dispose();
            job.EventWrites.Dispose();
        }
    }

    private async Task EmitProgressAsync(ActiveDownload job, JobProgress progress)
    {
        var current = BestSnapshot(job);
        var updated = current with
        {
            Stage = progress.Stage,
            Percent = progress.Percent ?? current.Percent,
            Path = progress.Path ?? current.Path,
            DownloadedBytes = progress.DownloadedBytes ?? current.DownloadedBytes,
            TotalBytes = progress.TotalBytes ?? current.TotalBytes,
            SpeedBytesPerSecond = progress.SpeedBytesPerSecond,
            EtaSeconds = progress.EtaSeconds
        };
        SetSnapshot(job, updated);
        if (job.IsDurableQueue)
        {
            // after_move exposes the candidate path before ffprobe and before
            // the terminal queue commit. Keep it only in the in-memory active
            // snapshot; a durable non-terminal entry must never publish an
            // unvalidated final path as if it were complete.
            var durableSnapshot = updated with { Path = null };
            downloadQueueStore!.Update(job.JobId, entry => entry with
            {
                State = DownloadQueueStates.Running,
                Snapshot = durableSnapshot
            });
        }
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
        StartDownloadPayload? fallbackPayload;
        lock (stateLock)
        {
            active = activeDownload;
            fallback = active?.Snapshot ?? lastSnapshot;
            fallbackPayload = active?.Payload ?? lastStartPayload;
        }

        if (active is null
            && startOperationJournal is not null
            && (fallback is null || !IsTerminal(fallback)))
        {
            try
            {
                var durable = fallbackPayload is null
                    ? startOperationJournal.ReadMostRecent()
                    : startOperationJournal.Read(fallbackPayload.OperationId);
                if (durable is not null)
                {
                    fallback = durable.Snapshot;
                    fallbackPayload = new StartDownloadPayload(
                        durable.OperationId,
                        durable.Url,
                        DownloadSelection.Video(durable.Height),
                        durable.DestinationFolder);
                    lock (stateLock)
                    {
                        lastSnapshot = fallback;
                        lastStartPayload = fallbackPayload;
                    }
                }
            }
            catch
            {
                // Reconciliation remains available from the in-memory snapshot if
                // the durable store is temporarily inaccessible or malformed.
            }
        }

        var serviceSnapshot = youtubeService.GetJob();
        if (serviceSnapshot is null) return fallback;
        if (active is not null
            && string.Equals(serviceSnapshot.JobId, active.JobId, StringComparison.Ordinal))
        {
            return serviceSnapshot with { OperationId = active.OperationId };
        }
        if (active is null
            && fallback is not null
            && string.Equals(serviceSnapshot.JobId, fallback.JobId, StringComparison.Ordinal))
        {
            return serviceSnapshot with { OperationId = fallback.OperationId };
        }
        return fallback ?? serviceSnapshot;
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
            ? serviceSnapshot with { OperationId = job.OperationId }
            : job.Snapshot with { OperationId = job.OperationId };
    }

    private void SetSnapshot(ActiveDownload job, JobSnapshot snapshot)
    {
        snapshot = snapshot with { OperationId = job.OperationId };
        lock (stateLock)
        {
            job.Snapshot = snapshot;
            if (ReferenceEquals(activeDownload, job)) lastSnapshot = snapshot;
        }
    }

    private void PersistSnapshot(ActiveDownload job, JobSnapshot snapshot)
    {
        if (startOperationJournal is null) return;
        snapshot = snapshot with { OperationId = job.OperationId };
        startOperationJournal.Write(StartOperationJournalEntry.Create(
            job.OperationId,
            job.JobId,
            job.Payload.Url,
            job.Payload.Height,
            job.Payload.DestinationFolder,
            snapshot));
    }

    private void PersistTerminalBestEffort(ActiveDownload job, JobSnapshot snapshot)
    {
        try
        {
            PersistSnapshot(job, snapshot);
        }
        catch
        {
            // Keeping the active durable record is fail-safe: a restarted host will
            // mark it interrupted instead of starting the same operation twice.
        }
    }

    private static bool IsTerminal(JobSnapshot snapshot) =>
        snapshot.Stage is "complete" or "failed" or "cancelled";

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

    private async Task StopActiveDownloadForQueueAsync(DownloadStopIntent intent)
    {
        ActiveDownload? job;
        lock (stateLock) job = activeDownload;
        if (job is null || !job.IsDurableQueue) return;

        job.SetStopIntent(intent);
        try
        {
            if (intent is DownloadStopIntent.Pause or DownloadStopIntent.Requeue)
                await resumableYouTubeService!.PauseAsync(job.JobId);
            else
                await youtubeService.CancelAsync(job.JobId);
        }
        finally
        {
            TryCancel(job.Cancellation);
        }

        try
        {
            await job.Task;
        }
        catch
        {
            // ExecuteQueuedDownloadAsync persists all terminal/interrupted outcomes.
        }
    }

    private void SignalQueuePump()
    {
        if (downloadQueueStore is null) return;
        try
        {
            if (queueSignal.CurrentCount == 0) queueSignal.Release();
        }
        catch (ObjectDisposedException)
        {
            // Shutdown won the race with the completed job.
        }
        catch (SemaphoreFullException)
        {
            // A wake-up is already pending.
        }
    }

    private void ReconcileCompletedOutputManifests(
        IEnumerable<DownloadQueueEntry> entries)
    {
        if (resumableYouTubeService is null) return;
        foreach (var entry in entries)
        {
            if (entry.State != DownloadQueueStates.Complete
                || entry.Snapshot.Path is null)
            {
                continue;
            }

            try
            {
                resumableYouTubeService.CommitCompletedAsync(
                    entry.JobId,
                    entry.DestinationFolder,
                    entry.Snapshot.Path,
                    CancellationToken.None).GetAwaiter().GetResult();
                downloadQueueStore!.TryFinalizeCompletedOutput(
                    entry.JobId,
                    entry.Snapshot.Path);
            }
            catch (OutputOwnershipMismatchException)
            {
                downloadQueueStore!.TryMarkCompletedOutputMismatch(
                    entry.JobId,
                    entry.Snapshot.Path);
            }
            catch
            {
                // Best-effort cleanup; a validated manifest remains a safe,
                // recoverable ownership record if local storage is unavailable.
            }
        }
    }

    private Task WriteFailureAsync(
        string requestId,
        string code,
        string message,
        string operation,
        string? jobId,
        CancellationToken cancellationToken)
    {
        RecordDiagnostic("operation_failed", code);
        return channel.WriteAsync(
            FailurePayload(requestId, code, message, operation, jobId),
            cancellationToken);
    }

    private void RecordDiagnostic(string eventName, string? code = null)
    {
        try
        {
            diagnosticService.Record(eventName, code);
        }
        catch
        {
            // Opt-in diagnostics must never affect downloads or protocol delivery.
        }
    }

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
        operationId = snapshot.OperationId,
        videoId = snapshot.VideoId,
        title = snapshot.Title,
        height = snapshot.Height,
        stage = snapshot.Stage,
        percent = snapshot.Percent,
        path = snapshot.Path,
        errorCode = snapshot.ErrorCode
    };

    private int? QueuePosition(DownloadQueueEntry entry)
    {
        if (downloadQueueStore is null
            || entry.State is not (DownloadQueueStates.Queued or DownloadQueueStates.Running))
        {
            return null;
        }
        var pending = downloadQueueStore.ReadAll()
            .Where(candidate => candidate.State is DownloadQueueStates.Queued or DownloadQueueStates.Running)
            .OrderBy(candidate => candidate.State == DownloadQueueStates.Running ? 0 : 1)
            .ThenBy(candidate => candidate.Sequence)
            .ToArray();
        var index = Array.FindIndex(pending, candidate =>
            string.Equals(candidate.JobId, entry.JobId, StringComparison.Ordinal));
        return index < 0 ? null : index + 1;
    }

    private static object QueueEntryPayload(DownloadQueueEntry entry, int? position) => new
    {
        jobId = entry.JobId,
        operationId = entry.OperationId,
        url = entry.Url,
        selection = new
        {
            height = entry.Selection.Height,
            audioOnly = entry.Selection.AudioOnly,
            subtitleLanguage = entry.Selection.SubtitleLanguage,
            includeAutomaticSubtitles = entry.Selection.IncludeAutomaticSubtitles
        },
        destinationFolder = entry.DestinationFolder,
        state = entry.State,
        videoId = entry.Snapshot.VideoId,
        title = entry.Snapshot.Title,
        stage = entry.Snapshot.Stage,
        percent = entry.Snapshot.Percent,
        downloadedBytes = entry.Snapshot.DownloadedBytes,
        totalBytes = entry.Snapshot.TotalBytes,
        speedBytesPerSecond = entry.Snapshot.SpeedBytesPerSecond,
        etaSeconds = entry.Snapshot.EtaSeconds,
        path = entry.Snapshot.Path,
        errorCode = entry.Snapshot.ErrorCode,
        resumePartial = entry.ResumePartial,
        attemptCount = entry.AttemptCount,
        position,
        createdAt = entry.CreatedAt,
        updatedAt = entry.UpdatedAt
    };

    private static (string Code, string Message) ClassifyDownloadFailure(Exception exception)
    {
        if (exception is MediaDownloadException mediaFailure)
            return (mediaFailure.Code, mediaFailure.Message);

        if (exception is InvalidOperationException
            && exception.Message.Contains("metadata", StringComparison.OrdinalIgnoreCase))
        {
            return ("YOUTUBE_METADATA", "Não foi possível obter os formatos do vídeo.");
        }

        if (exception is InvalidDataException or InvalidOperationException or ArgumentException)
            return ("YOUTUBE_DOWNLOAD", "Não foi possível baixar o vídeo.");
        return ("HOST_ERROR", "O host nativo encontrou um erro.");
    }

    private static bool IsRecoverableQueuePumpFailure(Exception exception) => exception is
        IOException
        or UnauthorizedAccessException
        or InvalidDataException
        or InvalidOperationException
        or DownloadQueueJobNotFoundException;

    private static string SafeQueuePumpFailureCode(Exception exception) => exception switch
    {
        UnauthorizedAccessException => "unauthorized",
        InvalidDataException => "invalid_data",
        DownloadQueueJobNotFoundException => "job_not_found",
        InvalidOperationException => "invalid_operation",
        _ => "io_error"
    };

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

    private static int RequiredHeight(JsonElement payload)
    {
        if (!payload.TryGetProperty("height", out var value)
            || value.ValueKind != JsonValueKind.Number
            || !value.TryGetInt32(out var height)
            || height is < 144 or > 4320)
        {
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        }
        return height;
    }

    private static DownloadSelection ParseDownloadSelection(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object)
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        RequireExactProperties(
            value,
            "height",
            "audioOnly",
            "subtitleLanguage",
            "includeAutomaticSubtitles");

        int? height = null;
        var heightValue = value.GetProperty("height");
        if (heightValue.ValueKind == JsonValueKind.Number)
        {
            if (!heightValue.TryGetInt32(out var parsedHeight))
                throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
            height = parsedHeight;
        }
        else if (heightValue.ValueKind != JsonValueKind.Null)
        {
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        }

        var audioOnlyValue = value.GetProperty("audioOnly");
        var automaticValue = value.GetProperty("includeAutomaticSubtitles");
        if (audioOnlyValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
            || automaticValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        }
        var audioOnly = audioOnlyValue.GetBoolean();
        var includeAutomatic = automaticValue.GetBoolean();

        string? subtitleLanguage = null;
        var subtitleValue = value.GetProperty("subtitleLanguage");
        if (subtitleValue.ValueKind == JsonValueKind.String)
        {
            subtitleLanguage = subtitleValue.GetString();
            if (string.IsNullOrWhiteSpace(subtitleLanguage)
                || !IsSafeSubtitleLanguage(subtitleLanguage))
            {
                throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
            }
        }
        else if (subtitleValue.ValueKind != JsonValueKind.Null)
        {
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        }

        if (audioOnly ? height is not null : height is < 144 or > 4320)
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        if ((audioOnly && subtitleLanguage is not null)
            || (includeAutomatic && subtitleLanguage is null))
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        return new DownloadSelection(
            height,
            audioOnly,
            subtitleLanguage,
            includeAutomatic);
    }

    private static StartMediaMetadata ParseStartMedia(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object)
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        RequireExactProperties(value, "videoId", "title");
        var videoId = RequiredString(value, "videoId");
        var title = RequiredString(value, "title");
        if (!IsSafeId(videoId)
            || title.Length > 512
            || title.Any(char.IsControl))
        {
            throw new CommandFailureException("INVALID_PAYLOAD", "Payload inválido.");
        }
        return new StartMediaMetadata(videoId, title);
    }

    private static bool IsSafeSubtitleLanguage(string value)
    {
        if (value.Length is < 1 or > 35) return false;
        var parts = value.Split('-', StringSplitOptions.None);
        return parts.Length is >= 1 and <= 4
            && parts.All(part =>
                part.Length is >= 1 and <= 8
                && part.All(char.IsAsciiLetterOrDigit));
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

    private static bool IsSafeId(string value) =>
        value.Length is > 0 and <= 128
        && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or ':' or '-');

    private static bool IsSafeFileMoveOperationId(string value) =>
        value.Length is > 0 and <= 128
        && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '_' or '-')
        && !IsWindowsDeviceName(value);

    private static bool IsWindowsDeviceName(string value) =>
        value.Equals("CON", StringComparison.OrdinalIgnoreCase)
        || value.Equals("PRN", StringComparison.OrdinalIgnoreCase)
        || value.Equals("AUX", StringComparison.OrdinalIgnoreCase)
        || value.Equals("NUL", StringComparison.OrdinalIgnoreCase)
        || Enumerable.Range(1, 9).Any(index =>
            value.Equals($"COM{index}", StringComparison.OrdinalIgnoreCase)
            || value.Equals($"LPT{index}", StringComparison.OrdinalIgnoreCase));

    private Task WriteJobStartedAsync(
        string requestId,
        string jobId,
        JobSnapshot snapshot,
        CancellationToken cancellationToken) =>
        channel.WriteAsync(new
        {
            type = "jobStarted",
            requestId,
            jobId,
            job = SnapshotPayload(snapshot)
        }, cancellationToken);

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
        StartDownloadPayload payload,
        CancellationTokenSource cancellation,
        JobSnapshot snapshot,
        IDisposable? activeLease,
        bool isDurableQueue = false,
        bool resumePartial = false)
    {
        public string JobId { get; } = jobId;
        public string RequestId { get; } = requestId;
        public StartDownloadPayload Payload { get; } = payload;
        public string OperationId => Payload.OperationId;
        public int Height => Payload.Height;
        public string? DestinationFolder => Payload.DestinationFolder;
        public CancellationTokenSource Cancellation { get; } = cancellation;
        public IDisposable? ActiveLease { get; } = activeLease;
        public bool IsDurableQueue { get; } = isDurableQueue;
        public bool ResumePartial { get; } = resumePartial;
        public JobSnapshot Snapshot { get; set; } = snapshot;
        public SemaphoreSlim EventWrites { get; } = new(1, 1);
        public Task Task { get; set; } = Task.CompletedTask;
        private int cancellationRequested;
        private int stopIntent;

        public bool TryMarkCancellationRequested() => Interlocked.Exchange(ref cancellationRequested, 1) == 0;

        public DownloadStopIntent StopIntent =>
            (DownloadStopIntent)Volatile.Read(ref stopIntent);

        public void SetStopIntent(DownloadStopIntent intent)
        {
            if (intent == DownloadStopIntent.None) return;
            Interlocked.CompareExchange(
                ref stopIntent,
                (int)intent,
                (int)DownloadStopIntent.None);
        }
    }

    private enum DownloadStopIntent
    {
        None,
        Pause,
        Requeue,
        Cancel
    }

    private sealed class CommandFailureException(string code, string message) : Exception(message)
    {
        public string Code { get; } = code;
    }

    private sealed record MoveDownloadedFilePayload(
        string OperationId,
        long DownloadId,
        string SourcePath,
        string DestinationFolder);

    private sealed record StartDownloadPayload(
        string OperationId,
        string Url,
        DownloadSelection Selection,
        string? DestinationFolder)
    {
        public int Height => Selection.Height ?? 0;

        public bool Matches(StartDownloadPayload other) =>
            string.Equals(OperationId, other.OperationId, StringComparison.Ordinal)
            && string.Equals(Url, other.Url, StringComparison.Ordinal)
            && Selection == other.Selection
            && string.Equals(DestinationFolder, other.DestinationFolder, StringComparison.OrdinalIgnoreCase);
    }

    private sealed record StartMediaMetadata(string VideoId, string Title);

    private sealed record DurableStartDecision(
        string JobId,
        JobSnapshot? ReplayedSnapshot,
        IDisposable? ActiveLease);
}
