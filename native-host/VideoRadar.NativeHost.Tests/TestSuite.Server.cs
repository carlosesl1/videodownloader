using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using VideoRadar.NativeHost.Files;
using VideoRadar.NativeHost.Diagnostics;
using VideoRadar.NativeHost.Host;
using VideoRadar.NativeHost.Processes;
using VideoRadar.NativeHost.Protocol;
using VideoRadar.NativeHost.Tools;
using VideoRadar.NativeHost.Windows;
using VideoRadar.NativeHost.YouTube;

namespace VideoRadar.NativeHost.Tests;

internal static partial class TestSuite
{
    private static void ServerTests()
    {
        NativeHostServerExportsOptInDiagnostics().GetAwaiter().GetResult();
        NativeHostServerRunsTheFramedProtocol().GetAwaiter().GetResult();
        NativeHostServerStopsAfterFatalFramingError().GetAwaiter().GetResult();
        NativeHostServerReplaysOnlyMatchingStartOperations().GetAwaiter().GetResult();
        NativeHostServerReplaysDurableStartsAcrossRestarts().GetAwaiter().GetResult();
        StartOperationJournalCoordinatesProcessesAndRecoversInterruptedStarts().GetAwaiter().GetResult();
        DownloadQueueStorePersistsIdempotentlyAndRecoversRunningJobs();
        DownloadQueueStoreBoundsPendingWork();
        NativeHostServerRecoversTheQueuePumpAfterAJobPersistenceFault().GetAwaiter().GetResult();
        NativeHostServerKeepsFailedPartialsUntilExplicitCancel().GetAwaiter().GetResult();
        NativeHostServerFailsClosedWhenCompletedOutputWasReplaced().GetAwaiter().GetResult();
        NativeHostServerQueuesPausesResumesAndListsDownloads().GetAwaiter().GetResult();
        NativeHostServerRequeuesActiveDownloadsAtEof().GetAwaiter().GetResult();
        NativeHostServerReconcilesCompletedOutputManifests().GetAwaiter().GetResult();
        NativeHostServerFailsClosedWhenRebootFindsAReplacedCompletedOutput().GetAwaiter().GetResult();
        NativeHostServerDoesNotRetryDeterministicMetadataFailures().GetAwaiter().GetResult();
        NativeHostServerCancelsMetadataBeforeTheBrowserDeadline().GetAwaiter().GetResult();
        NativeHostServerStartsAndCancelsWithoutRunningUpdater().GetAwaiter().GetResult();
        NativeHostServerRejectsBusyAndCancelsTheCurrentJob().GetAwaiter().GetResult();
        NativeHostServerCancelsAndAwaitsTheJobAtEof().GetAwaiter().GetResult();
        NativeHostServerRejectsInvalidPayloadsWithoutStopping().GetAwaiter().GetResult();
        NativeHostServerMapsKnownFailuresWithoutLeakingDetails().GetAwaiter().GetResult();
        NativeHostServerPreservesSafeMediaDownloadFailures().GetAwaiter().GetResult();
        NativeHostServerChoosesAndCancelsDownloadFolder().GetAwaiter().GetResult();
        NativeHostServerPropagatesCancellationFromFolderPicker().GetAwaiter().GetResult();
        NativeHostServerMapsFolderPickerFailuresWithoutStopping().GetAwaiter().GetResult();
        NativeHostServerRejectsInvalidPickedFoldersWithoutStopping().GetAwaiter().GetResult();
        NativeHostServerRejectsInvalidFallbackFolders();
        NativeHostServerMovesDownloadedFilesAndMapsFailuresSafely().GetAwaiter().GetResult();
        NativeHostServerRevealsDownloadedFilesAndMapsFailuresSafely().GetAwaiter().GetResult();
        UpdatePolicyNeverMutatesPinnedTools().GetAwaiter().GetResult();
        ProgramPingDiagnosticIsPureAndMachineReadable();
    }

    private static async Task NativeHostServerExportsOptInDiagnostics()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "video-radar-diagnostic-server-tests",
            Guid.NewGuid().ToString("N"));
        var tools = Path.Combine(root, "tools");
        var local = Path.Combine(root, "local");
        Directory.CreateDirectory(tools);
        Directory.CreateDirectory(root);
        try
        {
            using var input = new ControlledInputStream(FrameCommands(
                Command("getDiagnostics", "r-health", "{}"),
                Command("setDiagnostics", "r-enable", "{\"enabled\":true}"),
                Command("exportDiagnostics", "r-export", "{\"destinationFolder\":\"C:\\\\Diagnostics\"}"),
                Command("clearDiagnostics", "r-clear", "{}")));
            using var output = new SignallingOutputStream();
            var diagnostic = new FakeDiagnosticService();
            var run = new NativeHostServer(
                new NativeMessageChannel(input, output),
                new FakeYouTubeService(),
                new FakeUpdatePolicy(),
                new FakeFolderPicker(),
                DefaultDownloadFolder,
                new FakeDownloadFileMover(),
                diagnosticService: diagnostic).RunAsync(CancellationToken.None);
            input.Complete();
            await run.WaitAsync(TimeSpan.FromSeconds(5));

            var messages = ReadFrames(output);
            Equal("x64", Message(messages, "diagnostics", "r-health")
                .GetProperty("architecture").GetString());
            True(diagnostic.Enabled, "The diagnostics opt-in was not forwarded.");
            Equal(@"C:\Diagnostics", diagnostic.ExportedDestination);
            Equal("diagnosticsExported", Message(messages, "diagnosticsExported", "r-export")
                .GetProperty("type").GetString());
            True(diagnostic.Cleared, "Diagnostic logs were not cleared.");
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static void DownloadQueueStorePersistsIdempotentlyAndRecoversRunningJobs()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "video-radar-queue-store-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            const string url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
            var store = new DownloadQueueStore(root);
            var selection = new DownloadSelection(
                1080,
                AudioOnly: false,
                SubtitleLanguage: "pt-BR",
                IncludeAutomaticSubtitles: true);
            var first = store.Enqueue(
                "op-queue", "job-queue", url, selection, null,
                "jNQXAC9IVRw", "Me at the zoo");
            True(!first.Replayed, "The first durable enqueue was reported as a replay.");
            Equal(1, first.Position);
            Equal(DownloadQueueStates.Queued, first.Entry.State);

            var replay = new DownloadQueueStore(root).Enqueue(
                "op-queue",
                "unused-job-id",
                url,
                selection,
                null,
                "jNQXAC9IVRw",
                "Me at the zoo");
            True(replay.Replayed, "An identical operation was not replayed.");
            Equal("job-queue", replay.Entry.JobId);
            Equal("jNQXAC9IVRw", replay.Entry.Snapshot.VideoId);
            Equal("Me at the zoo", replay.Entry.Snapshot.Title);
            Throws<DownloadQueuePayloadConflictException>(() => store.Enqueue(
                "op-queue",
                "job-conflict",
                url,
                DownloadSelection.Video(720),
                null));

            store.Update("job-queue", entry => entry with
            {
                State = DownloadQueueStates.Running,
                AttemptCount = 1,
                Snapshot = entry.Snapshot with
                {
                    Stage = "video",
                    Percent = 42,
                    DownloadedBytes = 420,
                    TotalBytes = 1_000
                }
            });
            using (var activeLease = store.TryAcquireRunnerLease("op-queue", "job-queue"))
            {
                True(activeLease is not null, "The queue runner lease was not acquired.");
                if (OperatingSystem.IsWindows())
                {
                    var stillOwned = new DownloadQueueStore(root).ReconcileAfterRestart().Single();
                    Equal(DownloadQueueStates.Running, stillOwned.State);
                }
            }
            var recovered = new DownloadQueueStore(root).ReconcileAfterRestart().Single();
            Equal(DownloadQueueStates.Queued, recovered.State);
            Equal(DownloadQueueStates.Queued, recovered.Snapshot.Stage);
            True(recovered.ResumePartial, "An interrupted running job was not made resumable.");
            Equal(42, recovered.Snapshot.Percent);
            Equal(420L, recovered.Snapshot.DownloadedBytes);

            store.Update("job-queue", entry => entry with
            {
                State = DownloadQueueStates.Paused,
                Snapshot = entry.Snapshot with { Stage = DownloadQueueStates.Paused }
            });
            var paused = new DownloadQueueStore(root).ReconcileAfterRestart().Single();
            Equal(DownloadQueueStates.Paused, paused.State);

            store.Update("job-queue", entry => entry with
            {
                State = DownloadQueueStates.Failed,
                Snapshot = entry.Snapshot with
                {
                    Stage = DownloadQueueStates.Failed,
                    ErrorCode = "NETWORK_ERROR"
                },
                ResumePartial = false
            });
            var retried = store.Enqueue("op-queue", "unused-retry-id", url, selection, null);
            True(retried.Replayed, "A matching failed operation did not reuse its durable identity.");
            Equal("job-queue", retried.Entry.JobId);
            Equal(DownloadQueueStates.Queued, retried.Entry.State);
            Equal(DownloadQueueStates.Queued, retried.Entry.Snapshot.Stage);
            Equal(null, retried.Entry.Snapshot.ErrorCode);
            True(retried.Entry.ResumePartial, "Retrying a failed operation did not preserve resumable partials.");

            store.Update("job-queue", entry => entry with
            {
                State = DownloadQueueStates.Paused,
                Snapshot = entry.Snapshot with { Stage = DownloadQueueStates.Paused }
            });

            var entryPath = Directory.EnumerateFiles(root, "*.json", SearchOption.TopDirectoryOnly).Single();
            using var document = JsonDocument.Parse(File.ReadAllBytes(entryPath));
            var tampered = document.RootElement.EnumerateObject().ToDictionary(
                property => property.Name,
                property => property.Value.Clone());
            tampered["state"] = JsonDocument.Parse("\"queued\"").RootElement.Clone();
            File.WriteAllText(entryPath, JsonSerializer.Serialize(tampered));
            Throws<InvalidDataException>(() => new DownloadQueueStore(root).ReadAll());
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static void DownloadQueueStoreBoundsPendingWork()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "video-radar-queue-bound-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var store = new DownloadQueueStore(root);
            for (var index = 0; index < DownloadQueueStore.MaximumNonTerminalEntries; index++)
            {
                store.Enqueue(
                    $"op-{index}",
                    $"job-{index}",
                    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                    DownloadSelection.Video(720),
                    null);
            }
            Throws<DownloadQueueFullException>(() => store.Enqueue(
                "op-overflow",
                "job-overflow",
                "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                DownloadSelection.Video(720),
                null));

            var retryRoot = Path.Combine(root, "retry-at-capacity");
            Directory.CreateDirectory(retryRoot);
            var retryStore = new DownloadQueueStore(retryRoot);
            var failed = retryStore.Enqueue(
                "op-retry-capacity",
                "job-retry-capacity",
                "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                DownloadSelection.Video(720),
                null).Entry;
            retryStore.Update(failed.JobId, entry => entry with
            {
                State = DownloadQueueStates.Failed,
                Snapshot = entry.Snapshot with
                {
                    Stage = DownloadQueueStates.Failed,
                    ErrorCode = "NETWORK_ERROR"
                }
            });
            for (var index = 0; index < DownloadQueueStore.MaximumNonTerminalEntries; index++)
            {
                retryStore.Enqueue(
                    $"op-retry-fill-{index}",
                    $"job-retry-fill-{index}",
                    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                    DownloadSelection.Video(720),
                    null);
            }
            Throws<DownloadQueueFullException>(() => retryStore.Enqueue(
                failed.OperationId,
                "unused-retry-job",
                failed.Url,
                failed.Selection,
                null));
            Equal(DownloadQueueStates.Failed,
                retryStore.ReadByJobId(failed.JobId)!.State);

            var retainedRoot = Path.Combine(root, "retained-failures");
            Directory.CreateDirectory(retainedRoot);
            var retainedStore = new DownloadQueueStore(retainedRoot);
            for (var index = 0; index < DownloadQueueStore.MaximumEntries; index++)
            {
                var retained = retainedStore.Enqueue(
                    $"op-retained-{index}",
                    $"job-retained-{index}",
                    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                    DownloadSelection.Video(720),
                    null).Entry;
                retainedStore.Update(retained.JobId, entry => entry with
                {
                    State = DownloadQueueStates.Failed,
                    Snapshot = entry.Snapshot with
                    {
                        Stage = DownloadQueueStates.Failed,
                        ErrorCode = "NETWORK_ERROR"
                    },
                    ResumePartial = true
                });
            }
            Throws<DownloadQueueFullException>(() => retainedStore.Enqueue(
                "op-retained-overflow",
                "job-retained-overflow",
                "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                DownloadSelection.Video(720),
                null));
            Equal(DownloadQueueStore.MaximumEntries, retainedStore.ReadAll().Count);
            Equal(DownloadQueueStates.Failed,
                retainedStore.ReadByJobId("job-retained-0")!.State);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task NativeHostServerRecoversTheQueuePumpAfterAJobPersistenceFault()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "video-radar-queue-supervisor-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using var input = new AppendableInputStream();
            using var output = new SignallingOutputStream();
            var service = new FakeYouTubeService();
            service.StartHandler = async (jobId, _, height, _, onProgress, _) =>
            {
                if (service.StartCallCount == 1)
                {
                    service.Snapshot = new JobSnapshot(
                        jobId, "jNQXAC9IVRw", "invalid\ntitle", height,
                        "video", 10, null, null);
                    await onProgress(new JobProgress("video", 10, 100, 1_000, 50, 18));
                    throw new InvalidOperationException("The invalid snapshot unexpectedly persisted.");
                }

                const string finalPath = @"C:\Downloads\Video Radar\recovered-pump.mp4";
                service.Snapshot = new JobSnapshot(
                    jobId, "jNQXAC9IVRw", "Me at the zoo", height,
                    "finalize", 100, finalPath, null);
                await onProgress(new JobProgress(
                    "finalize", 100, 1_000, 1_000, null, null, finalPath));
                return new JobResult(jobId, finalPath);
            };
            var store = new DownloadQueueStore(root);
            var run = new NativeHostServer(
                new NativeMessageChannel(input, output),
                service,
                new FakeUpdatePolicy(),
                new FakeFolderPicker(),
                DefaultDownloadFolder,
                new FakeDownloadFileMover(),
                downloadQueueStore: store).RunAsync(CancellationToken.None);

            const string payload = "{\"operationId\":\"op-pump-recovery\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"selection\":{\"height\":720,\"audioOnly\":false,\"subtitleLanguage\":null,\"includeAutomaticSubtitles\":false},\"destinationFolder\":null}";
            input.Append(FrameCommands(Command("startDownload", "r-pump-recovery", payload)));
            await output.WaitForMessageAsync("jobQueued", "r-pump-recovery")
                .WaitAsync(TimeSpan.FromSeconds(5));
            var queued = Message(ReadFrames(output), "jobQueued", "r-pump-recovery");
            var jobId = queued.GetProperty("jobId").GetString()!;
            await output.WaitForTypeAsync("jobCompleted").WaitAsync(TimeSpan.FromSeconds(5));

            input.Complete();
            await run.WaitAsync(TimeSpan.FromSeconds(5));
            Equal(2, service.StartCallCount);
            var persisted = store.ReadByJobId(jobId)!;
            Equal(DownloadQueueStates.Complete, persisted.State);
            Equal(@"C:\Downloads\Video Radar\recovered-pump.mp4", persisted.Snapshot.Path);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task NativeHostServerKeepsFailedPartialsUntilExplicitCancel()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "video-radar-failed-partial-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using var input = new AppendableInputStream();
            using var output = new SignallingOutputStream();
            var service = new FakeYouTubeService
            {
                StartHandler = (_, _, _, _, _, _) =>
                    throw new MediaDownloadException("NETWORK_ERROR", "Falha de rede.")
            };
            var store = new DownloadQueueStore(root);
            var run = new NativeHostServer(
                new NativeMessageChannel(input, output),
                service,
                new FakeUpdatePolicy(),
                new FakeFolderPicker(),
                DefaultDownloadFolder,
                new FakeDownloadFileMover(),
                downloadQueueStore: store).RunAsync(CancellationToken.None);

            const string payload = "{\"operationId\":\"op-failed-partial\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"selection\":{\"height\":720,\"audioOnly\":false,\"subtitleLanguage\":null,\"includeAutomaticSubtitles\":false},\"destinationFolder\":null}";
            input.Append(FrameCommands(Command("startDownload", "r-failed-partial", payload)));
            await output.WaitForMessageAsync("jobQueued", "r-failed-partial")
                .WaitAsync(TimeSpan.FromSeconds(5));
            var queued = Message(ReadFrames(output), "jobQueued", "r-failed-partial");
            var jobId = queued.GetProperty("jobId").GetString()!;
            await output.WaitForMessageAsync("jobFailed", $"queue:{jobId}")
                .WaitAsync(TimeSpan.FromSeconds(5));
            var failed = store.ReadByJobId(jobId)!;
            Equal(DownloadQueueStates.Failed, failed.State);
            True(failed.ResumePartial, "A normal queue failure discarded its durable identity.");

            input.Append(FrameCommands(Command(
                "cancelDownload",
                "r-discard-failed",
                JsonSerializer.Serialize(new { jobId }))));
            await output.WaitForMessageAsync("jobCancelled", "r-discard-failed")
                .WaitAsync(TimeSpan.FromSeconds(5));
            input.Complete();
            await run.WaitAsync(TimeSpan.FromSeconds(5));

            var cancelled = store.ReadByJobId(jobId)!;
            Equal(DownloadQueueStates.Cancelled, cancelled.State);
            True(!cancelled.ResumePartial, "A cancelled failed job retained a discarded partial.");
            Equal(1, service.DiscardPartialCallCount);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task NativeHostServerFailsClosedWhenCompletedOutputWasReplaced()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "video-radar-complete-mismatch-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            const string finalPath = @"C:\Downloads\Video Radar\replaced.mp4";
            using var input = new AppendableInputStream();
            using var output = new SignallingOutputStream();
            var service = new FakeYouTubeService
            {
                StartHandler = (jobId, _, _, _, _, _) =>
                    Task.FromResult(new JobResult(jobId, finalPath)),
                CommitError = new OutputOwnershipMismatchException()
            };
            var store = new DownloadQueueStore(root);
            var run = new NativeHostServer(
                new NativeMessageChannel(input, output),
                service,
                new FakeUpdatePolicy(),
                new FakeFolderPicker(),
                DefaultDownloadFolder,
                new FakeDownloadFileMover(),
                downloadQueueStore: store).RunAsync(CancellationToken.None);

            const string payload = "{\"operationId\":\"op-complete-mismatch\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"selection\":{\"height\":720,\"audioOnly\":false,\"subtitleLanguage\":null,\"includeAutomaticSubtitles\":false},\"destinationFolder\":null}";
            input.Append(FrameCommands(Command("startDownload", "r-complete-mismatch", payload)));
            await output.WaitForMessageAsync("jobQueued", "r-complete-mismatch")
                .WaitAsync(TimeSpan.FromSeconds(5));
            var jobId = Message(ReadFrames(output), "jobQueued", "r-complete-mismatch")
                .GetProperty("jobId")
                .GetString()!;
            await output.WaitForMessageAsync("jobFailed", $"queue:{jobId}")
                .WaitAsync(TimeSpan.FromSeconds(5));
            input.Complete();
            await run.WaitAsync(TimeSpan.FromSeconds(5));

            var messages = ReadFrames(output);
            True(!messages.Any(message =>
                    message.GetProperty("type").GetString() == "jobCompleted"
                    && message.TryGetProperty("jobId", out var completedJob)
                    && completedJob.GetString() == jobId),
                "A replaced completed output was exposed as jobCompleted.");
            var failed = store.ReadByJobId(jobId)!;
            Equal(DownloadQueueStates.Failed, failed.State);
            Equal("OUTPUT_OWNERSHIP_MISMATCH", failed.Snapshot.ErrorCode);
            Equal<string?>(null, failed.Snapshot.Path);
            True(failed.ResumePartial, "The mismatched output identity was not recoverable.");
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task NativeHostServerQueuesPausesResumesAndListsDownloads()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "video-radar-queue-server-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using var input = new AppendableInputStream();
            using var output = new SignallingOutputStream();
            var service = new FakeYouTubeService();
            service.StartHandler = async (jobId, _, height, _, onProgress, cancellationToken) =>
            {
                service.Snapshot = new JobSnapshot(
                    jobId,
                    "jNQXAC9IVRw",
                    "Me at the zoo",
                    height,
                    "video",
                    20,
                    null,
                    null);
                await onProgress(new JobProgress("video", 20, 200, 1_000, 50, 16));
                if (service.StartCallCount == 1)
                    await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                const string finalPath = @"C:\Downloads\Video Radar\queued.mp4";
                await onProgress(new JobProgress(
                    "finalize", null, 1_000, 1_000, null, null, finalPath));
                return new JobResult(jobId, finalPath);
            };
            var server = new NativeHostServer(
                new NativeMessageChannel(input, output),
                service,
                new FakeUpdatePolicy(),
                new FakeFolderPicker(),
                DefaultDownloadFolder,
                new FakeDownloadFileMover(),
                downloadQueueStore: new DownloadQueueStore(root));
            var run = server.RunAsync(CancellationToken.None);

            const string payload = "{\"operationId\":\"op-queue-server\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"selection\":{\"height\":1080,\"audioOnly\":false,\"subtitleLanguage\":\"pt-BR\",\"includeAutomaticSubtitles\":true},\"destinationFolder\":null,\"media\":{\"videoId\":\"jNQXAC9IVRw\",\"title\":\"Me at the zoo\"}}";
            input.Append(FrameCommands(Command("startDownload", "r-enqueue", payload)));
            await output.WaitForMessageAsync("jobQueued", "r-enqueue")
                .WaitAsync(TimeSpan.FromSeconds(5));
            await output.WaitForTypeAsync("jobStarted").WaitAsync(TimeSpan.FromSeconds(5));
            var queued = Message(ReadFrames(output), "jobQueued", "r-enqueue");
            var jobId = queued.GetProperty("jobId").GetString()!;
            Equal("queued", queued.GetProperty("job").GetProperty("state").GetString());
            Equal("jNQXAC9IVRw", queued.GetProperty("job").GetProperty("videoId").GetString());
            Equal("Me at the zoo", queued.GetProperty("job").GetProperty("title").GetString());

            input.Append(FrameCommands(Command("getJob", "r-active-queue", "{}")));
            await output.WaitForMessageAsync("ready", "r-active-queue")
                .WaitAsync(TimeSpan.FromSeconds(5));
            var activeQueueJob = Message(ReadFrames(output), "ready", "r-active-queue")
                .GetProperty("job");
            Equal(jobId, activeQueueJob.GetProperty("jobId").GetString());
            Equal("op-queue-server", activeQueueJob.GetProperty("operationId").GetString());
            True(
                activeQueueJob.EnumerateObject().Select(property => property.Name)
                    .ToHashSet(StringComparer.Ordinal)
                    .SetEquals(["jobId", "operationId", "videoId", "title", "height", "stage", "percent", "path", "errorCode"]),
                "Queue getJob did not return the protocol-compatible job snapshot.");

            input.Append(FrameCommands(Command(
                "pauseDownload",
                "r-pause",
                JsonSerializer.Serialize(new { jobId }))));
            await output.WaitForMessageAsync("jobPaused", "r-pause")
                .WaitAsync(TimeSpan.FromSeconds(5));
            var paused = Message(ReadFrames(output), "jobPaused", "r-pause");
            Equal("paused", paused.GetProperty("job").GetProperty("state").GetString());
            Equal(1, service.PauseCallCount);

            input.Append(FrameCommands(
                Command("listQueue", "r-list", "{}"),
                Command(
                    "resumeDownload",
                    "r-resume",
                    JsonSerializer.Serialize(new { jobId }))));
            await output.WaitForMessageAsync("queueSnapshot", "r-list")
                .WaitAsync(TimeSpan.FromSeconds(5));
            await output.WaitForMessageAsync("jobQueued", "r-resume")
                .WaitAsync(TimeSpan.FromSeconds(5));
            await output.WaitForTypeAsync("jobCompleted").WaitAsync(TimeSpan.FromSeconds(5));

            input.Complete();
            await run.WaitAsync(TimeSpan.FromSeconds(5));
            var messages = ReadFrames(output);
            var list = Message(messages, "queueSnapshot", "r-list");
            Equal(1, list.GetProperty("jobs").GetArrayLength());
            Equal("paused", list.GetProperty("jobs")[0].GetProperty("state").GetString());
            Equal("pt-BR", list.GetProperty("jobs")[0]
                .GetProperty("selection")
                .GetProperty("subtitleLanguage")
                .GetString());
            Equal(2, service.StartCallCount);
            True(service.RunOptions[1].ResumePartial, "The resumed process did not receive resume options.");
            True(service.RunOptions.All(options => options.DurableOutputIdentity),
                "A queued run did not retain durable output identity.");
            Equal(1, service.CommitCompletedCallCount);
            var asynchronousPause = Message(messages, "jobPaused", $"queue:{jobId}");
            True(
                asynchronousPause.EnumerateObject().Select(property => property.Name)
                    .ToHashSet(StringComparer.Ordinal)
                    .SetEquals(["type", "requestId", "jobId", "operationId", "job"]),
                "The asynchronous pause event does not match the protocol-v5 shape.");
            var persisted = new DownloadQueueStore(root).ReadByJobId(jobId)!;
            Equal(DownloadQueueStates.Complete, persisted.State);
            Equal(100, persisted.Snapshot.Percent);
            Equal(@"C:\Downloads\Video Radar\queued.mp4", persisted.Snapshot.Path);
            True(!messages.Any(message =>
                    message.GetProperty("type").GetString() == "jobFailed"
                    && message.TryGetProperty("jobId", out var failedJobId)
                    && failedJobId.GetString() == jobId),
                "after_move incorrectly failed the durable queue before validation/commit.");
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task NativeHostServerRequeuesActiveDownloadsAtEof()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "video-radar-queue-eof-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using var input = new AppendableInputStream();
            using var output = new SignallingOutputStream();
            var service = new FakeYouTubeService();
            service.StartHandler = async (jobId, _, height, _, onProgress, cancellationToken) =>
            {
                service.Snapshot = new JobSnapshot(
                    jobId,
                    "jNQXAC9IVRw",
                    "Me at the zoo",
                    height,
                    "video",
                    30,
                    null,
                    null);
                await onProgress(new JobProgress("video", 30, 300, 1_000, 50, 14));
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                throw new InvalidOperationException("The cancelled test download unexpectedly resumed.");
            };
            var store = new DownloadQueueStore(root);
            var run = new NativeHostServer(
                new NativeMessageChannel(input, output),
                service,
                new FakeUpdatePolicy(),
                new FakeFolderPicker(),
                DefaultDownloadFolder,
                new FakeDownloadFileMover(),
                downloadQueueStore: store).RunAsync(CancellationToken.None);

            const string payload = "{\"operationId\":\"op-eof-requeue\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"selection\":{\"height\":720,\"audioOnly\":false,\"subtitleLanguage\":null,\"includeAutomaticSubtitles\":false},\"destinationFolder\":null}";
            input.Append(FrameCommands(Command("startDownload", "r-eof-enqueue", payload)));
            await output.WaitForTypeAsync("jobStarted").WaitAsync(TimeSpan.FromSeconds(5));
            var jobId = Message(ReadFrames(output), "jobQueued", "r-eof-enqueue")
                .GetProperty("jobId")
                .GetString()!;

            input.Complete();
            await run.WaitAsync(TimeSpan.FromSeconds(5));

            var messages = ReadFrames(output);
            var requeued = Message(messages, "jobQueued", $"queue:{jobId}");
            True(
                requeued.EnumerateObject().Select(property => property.Name)
                    .ToHashSet(StringComparer.Ordinal)
                    .SetEquals(["type", "requestId", "jobId", "operationId", "replayed", "position", "job"]),
                "The restart-recovery queue event does not match the protocol-v5 shape.");
            Equal(1, requeued.GetProperty("position").GetInt32());
            True(!requeued.GetProperty("replayed").GetBoolean(), "An EOF requeue was incorrectly marked as a replay.");
            Equal(DownloadQueueStates.Queued, requeued.GetProperty("job").GetProperty("state").GetString());
            True(requeued.GetProperty("job").GetProperty("resumePartial").GetBoolean(),
                "The EOF-recovered download was not marked resumable.");
            var persisted = store.ReadByJobId(jobId)!;
            Equal(DownloadQueueStates.Queued, persisted.State);
            True(persisted.ResumePartial, "The EOF recovery was not durable.");
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task NativeHostServerReconcilesCompletedOutputManifests()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "video-radar-completed-manifest-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var store = new DownloadQueueStore(root);
            var queued = store.Enqueue(
                "op-completed-manifest",
                "job-completed-manifest",
                "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                DownloadSelection.Video(720),
                null).Entry;
            store.Update(queued.JobId, entry => entry with
            {
                State = DownloadQueueStates.Complete,
                Snapshot = entry.Snapshot with
                {
                    Stage = DownloadQueueStates.Complete,
                    Percent = 100,
                    Path = @"C:\Downloads\Video Radar\completed.mp4"
                }
            });
            using var input = new MemoryStream();
            using var output = new MemoryStream();
            var service = new FakeYouTubeService();

            await new NativeHostServer(
                new NativeMessageChannel(input, output),
                service,
                new FakeUpdatePolicy(),
                new FakeFolderPicker(),
                DefaultDownloadFolder,
                new FakeDownloadFileMover(),
                downloadQueueStore: store).RunAsync(CancellationToken.None);

            Equal(1, service.CommitCompletedCallCount);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task NativeHostServerFailsClosedWhenRebootFindsAReplacedCompletedOutput()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "video-radar-reboot-complete-mismatch-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            const string finalPath = @"C:\Downloads\Video Radar\replaced-after-reboot.mp4";
            var store = new DownloadQueueStore(root);
            var queued = store.Enqueue(
                "op-reboot-mismatch",
                "job-reboot-mismatch",
                "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                DownloadSelection.Video(720),
                null).Entry;
            var completed = store.Update(queued.JobId, entry => entry with
            {
                State = DownloadQueueStates.Complete,
                Snapshot = entry.Snapshot with
                {
                    Stage = DownloadQueueStates.Complete,
                    Percent = 100,
                    Path = finalPath
                }
            });
            var previousUpdatedAt = completed.UpdatedAt;
            var service = new FakeYouTubeService
            {
                CommitError = new OutputOwnershipMismatchException()
            };
            using var input = new MemoryStream();
            using var output = new MemoryStream();

            await new NativeHostServer(
                new NativeMessageChannel(input, output),
                service,
                new FakeUpdatePolicy(),
                new FakeFolderPicker(),
                DefaultDownloadFolder,
                new FakeDownloadFileMover(),
                downloadQueueStore: store).RunAsync(CancellationToken.None);

            var failed = store.ReadByJobId(queued.JobId)!;
            Equal(DownloadQueueStates.Failed, failed.State);
            Equal("OUTPUT_OWNERSHIP_MISMATCH", failed.Snapshot.ErrorCode);
            Equal<string?>(null, failed.Snapshot.Path);
            True(failed.ResumePartial, "Reboot mismatch lost its recovery identity.");
            True(failed.UpdatedAt > previousUpdatedAt,
                "Reboot mismatch did not publish a newer durable update.");
            Equal(1, service.CommitCompletedCallCount);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task NativeHostServerReplaysDurableStartsAcrossRestarts()
    {
        var root = Path.Combine(Path.GetTempPath(), "video-radar-start-journal-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            const string payload = "{\"operationId\":\"op-durable\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720,\"destinationFolder\":null}";
            using var firstInput = new ControlledInputStream(FrameCommands(
                Command("startDownload", "r-first", payload)));
            using var firstOutput = new SignallingOutputStream();
            var firstService = new FakeYouTubeService
            {
                StartHandler = (jobId, _, _, _, _, _) => Task.FromResult(
                    new JobResult(jobId, @"C:\Downloads\Video Radar\durable.mp4"))
            };
            var journal = new StartOperationJournal(root);
            var firstRun = new NativeHostServer(
                new NativeMessageChannel(firstInput, firstOutput),
                firstService,
                new FakeUpdatePolicy(),
                new FakeFolderPicker(),
                DefaultDownloadFolder,
                new FakeDownloadFileMover(),
                startOperationJournal: journal).RunAsync(CancellationToken.None);
            await firstOutput.WaitForTypeAsync("jobCompleted").WaitAsync(TimeSpan.FromSeconds(5));
            firstInput.Complete();
            await firstRun.WaitAsync(TimeSpan.FromSeconds(5));
            var firstStarted = Message(ReadFrames(firstOutput), "jobStarted", "r-first");
            var firstJobId = firstStarted.GetProperty("jobId").GetString();

            using var replayInput = new MemoryStream(FrameCommands(
                Command("startDownload", "r-replay", payload),
                Command("getJob", "r-reconcile", "{}")));
            using var replayOutput = new MemoryStream();
            var replayService = new FakeYouTubeService();
            await new NativeHostServer(
                new NativeMessageChannel(replayInput, replayOutput),
                replayService,
                new FakeUpdatePolicy(),
                new FakeFolderPicker(),
                DefaultDownloadFolder,
                new FakeDownloadFileMover(),
                startOperationJournal: new StartOperationJournal(root)).RunAsync(CancellationToken.None);

            var replayMessages = ReadFrames(replayOutput);
            var replayed = Message(replayMessages, "jobStarted", "r-replay");
            Equal(firstJobId, replayed.GetProperty("jobId").GetString());
            Equal("complete", replayed.GetProperty("job").GetProperty("stage").GetString());
            Equal(0, replayService.StartCallCount);
            var reconciled = Message(replayMessages, "ready", "r-reconcile");
            Equal(firstJobId, reconciled.GetProperty("job").GetProperty("jobId").GetString());
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task StartOperationJournalCoordinatesProcessesAndRecoversInterruptedStarts()
    {
        var root = Path.Combine(Path.GetTempPath(), "video-radar-active-lock-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var first = new StartOperationJournal(root);
            var second = new StartOperationJournal(root);
            using (var active = first.TryAcquireActiveLock("op-interrupted", "job-interrupted"))
            {
                True(active is not null, "The first process did not acquire the durable active lease.");
                True(
                    second.TryAcquireActiveLock("op-other", "job-other") is null,
                    "A second process acquired the global download lease.");
                var owner = second.ReadActiveOwner();
                Equal("op-interrupted", owner!.OperationId);
                Equal("job-interrupted", owner.JobId);
                first.Write(StartOperationJournalEntry.Create(
                    "op-interrupted",
                    "job-interrupted",
                    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                    720,
                    null,
                    new JobSnapshot(
                        "job-interrupted",
                        string.Empty,
                        string.Empty,
                        720,
                        "preparing",
                        null,
                        null,
                        null,
                        "op-interrupted")));
            }

            const string payload = "{\"operationId\":\"op-interrupted\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720,\"destinationFolder\":null}";
            using var input = new MemoryStream(FrameCommands(
                Command("startDownload", "r-recovered", payload)));
            using var output = new MemoryStream();
            var service = new FakeYouTubeService();
            await new NativeHostServer(
                new NativeMessageChannel(input, output),
                service,
                new FakeUpdatePolicy(),
                new FakeFolderPicker(),
                DefaultDownloadFolder,
                new FakeDownloadFileMover(),
                startOperationJournal: second).RunAsync(CancellationToken.None);

            var recovered = Message(ReadFrames(output), "jobStarted", "r-recovered");
            Equal("job-interrupted", recovered.GetProperty("jobId").GetString());
            Equal("failed", recovered.GetProperty("job").GetProperty("stage").GetString());
            Equal("HOST_RESTARTED", recovered.GetProperty("job").GetProperty("errorCode").GetString());
            Equal(0, service.StartCallCount);
            using var reacquired = first.TryAcquireActiveLock("op-next", "job-next");
            True(reacquired is not null, "Interrupted-operation recovery leaked the global lease.");
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task NativeHostServerRunsTheFramedProtocol()
    {
        using var input = new ControlledInputStream(FrameCommands(
            Command("ping", "r-ping", "{}"),
            Command("listFormats", "r-formats", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\"}"),
            Command("getJob", "r-empty", "{}"),
            Command("startDownload", "r-start", "{\"operationId\":\"op-start\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":1080,\"destinationFolder\":\"C:\\\\Media\\\\Video Radar\"}"),
            Command("getJob", "r-active", "{}")));
        using var output = new SignallingOutputStream();
        var updater = new FakeUpdatePolicy { Error = new InvalidOperationException("network diagnostics") };
        var service = new FakeYouTubeService();
        service.StartHandler = async (jobId, _, height, _, onProgress, _) =>
        {
            service.Snapshot = new JobSnapshot(jobId, "jNQXAC9IVRw", "Me at the zoo", height, "video", 10, null, null);
            await onProgress(new JobProgress("video", 10, 100, 1_000, 50, 18));
            await onProgress(new JobProgress("audio", 50, 500, 1_000, 100, 5));
            service.Snapshot = service.Snapshot with { Stage = "complete", Percent = 100, Path = @"C:\Downloads\Video Radar\video.mp4" };
            return new JobResult(jobId, service.Snapshot.Path!);
        };

        var run = new NativeHostServer(
            new NativeMessageChannel(input, output),
            service,
            updater,
            new FakeFolderPicker(),
            DefaultDownloadFolder,
            new FakeDownloadFileMover()).RunAsync(CancellationToken.None);
        await output.WaitForTypeAsync("jobCompleted").WaitAsync(TimeSpan.FromSeconds(5));
        input.Complete();
        await run.WaitAsync(TimeSpan.FromSeconds(5));

        var messages = ReadFrames(output);
        True(messages.All(message => AllowedServerTypes.Contains(message.GetProperty("type").GetString()!)), "Server emitted a type outside the protocol allowlist.");

        var ready = Message(messages, "ready", "r-ping");
        Equal(5, ready.GetProperty("protocolVersion").GetInt32());
        Equal(HostInfo.NativeName, ready.GetProperty("nativeName").GetString());
        Equal(HostInfo.Version, ready.GetProperty("hostVersion").GetString());
        True(
            ready.GetProperty("capabilities").EnumerateArray().Select(value => value.GetString()).SequenceEqual(HostInfo.Capabilities),
            "ready capabilities do not match the native host contract.");
        Equal(DefaultDownloadFolder, ready.GetProperty("defaultFolder").GetString());

        var formats = Message(messages, "formats", "r-formats");
        Equal("jNQXAC9IVRw", formats.GetProperty("videoId").GetString());
        Equal("Me at the zoo", formats.GetProperty("title").GetString());
        Equal(19d, formats.GetProperty("durationSeconds").GetDouble());
        Equal(1080, formats.GetProperty("qualities")[0].GetProperty("height").GetInt32());
        Equal(0, updater.CallCount);
        Equal(1, service.ListCallCount);

        var emptyJob = Message(messages, "ready", "r-empty");
        Equal(JsonValueKind.Null, emptyJob.GetProperty("job").ValueKind);
        True(!emptyJob.TryGetProperty("defaultFolder", out _), "getJob unexpectedly exposed the fallback folder.");

        var started = Message(messages, "jobStarted", "r-start");
        var jobId = started.GetProperty("jobId").GetString()!;
        True(Guid.TryParse(jobId, out _), "startDownload did not create a UUID job id.");
        Equal(jobId, started.GetProperty("job").GetProperty("jobId").GetString());
        Equal("op-start", started.GetProperty("job").GetProperty("operationId").GetString());
        Equal("preparing", started.GetProperty("job").GetProperty("stage").GetString());

        var active = Message(messages, "ready", "r-active");
        True(active.GetProperty("job").ValueKind == JsonValueKind.Object, "getJob did not return the active snapshot.");
        Equal(jobId, active.GetProperty("job").GetProperty("jobId").GetString());

        var progress = messages.Where(message => message.GetProperty("type").GetString() == "jobProgress").ToList();
        Equal(2, progress.Count);
        Equal("video", progress[0].GetProperty("stage").GetString());
        Equal("audio", progress[1].GetProperty("stage").GetString());
        True(progress.All(message => message.GetProperty("requestId").GetString() == "r-start"), "Progress lost the start request id.");
        True(progress.All(message => message.GetProperty("jobId").GetString() == jobId), "Progress changed the stable job id.");
        True(messages.FindIndex(message => message.GetProperty("type").GetString() == "jobStarted")
            < messages.FindIndex(message => message.GetProperty("type").GetString() == "jobProgress"), "Progress preceded jobStarted.");

        var completed = Message(messages, "jobCompleted", "r-start");
        Equal(jobId, completed.GetProperty("jobId").GetString());
        Equal(@"C:\Downloads\Video Radar\video.mp4", completed.GetProperty("path").GetString());
        Equal(1, service.StartCallCount);
        Equal(SelectedDownloadFolder, service.DestinationFolders.Single());
    }

    private static async Task NativeHostServerStopsAfterFatalFramingError()
    {
        var invalidHeader = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(
            invalidHeader,
            NativeMessageChannel.MaxMessageBytes + 1U);
        var validFrame = FrameCommands(Command("ping", "r-after-invalid", "{}"));
        using var input = new MemoryStream(invalidHeader.Concat(validFrame).ToArray());
        using var output = new MemoryStream();

        await new NativeHostServer(
            new NativeMessageChannel(input, output),
            new FakeYouTubeService(),
            new FakeUpdatePolicy(),
            new FakeFolderPicker(),
            DefaultDownloadFolder,
            new FakeDownloadFileMover()).RunAsync(CancellationToken.None);

        Equal(0L, output.Length);
    }

    private static async Task NativeHostServerReplaysOnlyMatchingStartOperations()
    {
        const string payload = "{\"operationId\":\"op-idempotent\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720,\"destinationFolder\":null}";
        using var input = new AppendableInputStream();
        using var output = new SignallingOutputStream();
        var service = new FakeYouTubeService();
        service.StartHandler = async (jobId, _, height, _, _, cancellationToken) =>
        {
            service.Snapshot = new JobSnapshot(
                jobId,
                "jNQXAC9IVRw",
                "Idempotent",
                height,
                "video",
                10,
                null,
                null);
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("unreachable");
        };
        var run = new NativeHostServer(
            new NativeMessageChannel(input, output),
            service,
            new FakeUpdatePolicy(),
            new FakeFolderPicker(),
            DefaultDownloadFolder,
            new FakeDownloadFileMover()).RunAsync(CancellationToken.None);

        input.Append(FrameCommands(Command("startDownload", "r-original", payload)));
        await output.WaitForMessageAsync("jobStarted", "r-original").WaitAsync(TimeSpan.FromSeconds(5));
        var original = Message(ReadFrames(output), "jobStarted", "r-original");
        var jobId = original.GetProperty("jobId").GetString()!;

        input.Append(FrameCommands(
            Command("startDownload", "r-active-replay", payload),
            Command("startDownload", "r-active-conflict", "{\"operationId\":\"op-idempotent\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":1080,\"destinationFolder\":null}"),
            Command("startDownload", "r-busy", "{\"operationId\":\"op-other\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720,\"destinationFolder\":null}")));
        await output.WaitForMessageAsync("jobStarted", "r-active-replay").WaitAsync(TimeSpan.FromSeconds(5));
        await output.WaitForMessageAsync("jobFailed", "r-active-conflict").WaitAsync(TimeSpan.FromSeconds(5));
        await output.WaitForMessageAsync("jobFailed", "r-busy").WaitAsync(TimeSpan.FromSeconds(5));

        input.Append(FrameCommands(Command(
            "cancelDownload",
            "r-cancel-idempotent",
            JsonSerializer.Serialize(new { jobId }))));
        await output.WaitForTypeAsync("jobCancelled").WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(20);

        input.Append(FrameCommands(
            Command("startDownload", "r-terminal-replay", payload),
            Command("startDownload", "r-terminal-conflict", "{\"operationId\":\"op-idempotent\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":1080,\"destinationFolder\":null}")));
        await output.WaitForMessageAsync("jobStarted", "r-terminal-replay").WaitAsync(TimeSpan.FromSeconds(5));
        await output.WaitForMessageAsync("jobFailed", "r-terminal-conflict").WaitAsync(TimeSpan.FromSeconds(5));
        input.Complete();
        await run.WaitAsync(TimeSpan.FromSeconds(5));

        var messages = ReadFrames(output);
        Equal(jobId, Message(messages, "jobStarted", "r-active-replay").GetProperty("jobId").GetString());
        Equal(jobId, Message(messages, "jobStarted", "r-terminal-replay").GetProperty("jobId").GetString());
        Equal("INVALID_PAYLOAD", Message(messages, "jobFailed", "r-active-conflict").GetProperty("code").GetString());
        Equal("YOUTUBE_BUSY", Message(messages, "jobFailed", "r-busy").GetProperty("code").GetString());
        Equal("INVALID_PAYLOAD", Message(messages, "jobFailed", "r-terminal-conflict").GetProperty("code").GetString());
        Equal(1, service.StartCallCount);
    }

    private static async Task NativeHostServerRejectsBusyAndCancelsTheCurrentJob()
    {
        var service = new FakeYouTubeService();
        service.StartHandler = async (jobId, _, height, _, _, cancellationToken) =>
        {
            service.Snapshot = new JobSnapshot(jobId, "jNQXAC9IVRw", "Active", height, "video", 1, null, null);
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("unreachable");
        };

        // The cancel payload must contain the UUID generated by the server, so feed it after observing jobStarted.
        using var dynamicInput = new AppendableInputStream();
        using var dynamicOutput = new SignallingOutputStream();
        dynamicInput.Append(FrameCommands(
            Command("startDownload", "r-first", "{\"operationId\":\"op-first\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720,\"destinationFolder\":null}"),
            Command("startDownload", "r-second", "{\"operationId\":\"op-second\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720,\"destinationFolder\":null}")));
        var server = new NativeHostServer(
            new NativeMessageChannel(dynamicInput, dynamicOutput),
            service,
            new FakeUpdatePolicy(),
            new FakeFolderPicker(),
            DefaultDownloadFolder,
            new FakeDownloadFileMover());
        var run = server.RunAsync(CancellationToken.None);
        await dynamicOutput.WaitForTypeAsync("jobStarted").WaitAsync(TimeSpan.FromSeconds(5));
        var started = Message(ReadFrames(dynamicOutput), "jobStarted", "r-first");
        var jobId = started.GetProperty("jobId").GetString()!;
        dynamicInput.Append(FrameCommands(Command("cancelDownload", "r-cancel", JsonSerializer.Serialize(new { jobId }))));
        await dynamicOutput.WaitForTypeAsync("jobCancelled").WaitAsync(TimeSpan.FromSeconds(5));
        dynamicInput.Complete();
        await run.WaitAsync(TimeSpan.FromSeconds(5));

        var messages = ReadFrames(dynamicOutput);
        var busy = Message(messages, "jobFailed", "r-second");
        Equal("YOUTUBE_BUSY", busy.GetProperty("code").GetString());
        var cancelled = Message(messages, "jobCancelled", "r-first");
        Equal(jobId, cancelled.GetProperty("jobId").GetString());
        Equal(jobId, Message(messages, "jobCancelled", "r-cancel")
            .GetProperty("jobId").GetString());
        Equal(1, service.StartCallCount);
        Equal(1, service.CancelCallCount);
        Equal<string?>(null, service.DestinationFolders.Single());
    }

    private static async Task NativeHostServerDoesNotRetryDeterministicMetadataFailures()
    {
        using var input = new MemoryStream(FrameCommands(
            Command("listFormats", "r-formats-retry", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\"}")));
        using var output = new MemoryStream();
        var updater = new FakeUpdatePolicy();
        var service = new FakeYouTubeService
        {
            ListHandler = (_, _, _) =>
                Task.FromException<FormatCatalog>(new InvalidOperationException("outdated extractor"))
        };

        await new NativeHostServer(
            new NativeMessageChannel(input, output),
            service,
            updater,
            new FakeFolderPicker(),
            DefaultDownloadFolder,
            new FakeDownloadFileMover()).RunAsync(CancellationToken.None);

        var failure = Message(ReadFrames(output), "jobFailed", "r-formats-retry");
        Equal("YOUTUBE_METADATA", failure.GetProperty("code").GetString());
        Equal(1, service.ListCallCount);
        Equal(0, updater.CallCount);
    }

    private static async Task NativeHostServerCancelsMetadataBeforeTheBrowserDeadline()
    {
        using var input = new MemoryStream(FrameCommands(
            Command("listFormats", "r-formats-timeout", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\"}")));
        using var output = new MemoryStream();
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var updater = new FakeUpdatePolicy();
        var service = new FakeYouTubeService
        {
            ListHandler = async (_, _, cancellationToken) =>
            {
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                    throw new InvalidOperationException("unreachable");
                }
                catch (OperationCanceledException)
                {
                    cancelled.TrySetResult();
                    throw;
                }
            }
        };

        await new NativeHostServer(
            new NativeMessageChannel(input, output),
            service,
            updater,
            new FakeFolderPicker(),
            DefaultDownloadFolder,
            new FakeDownloadFileMover(),
            metadataTimeout: TimeSpan.FromMilliseconds(20)).RunAsync(CancellationToken.None);

        var failure = Message(ReadFrames(output), "jobFailed", "r-formats-timeout");
        Equal("YOUTUBE_METADATA_TIMEOUT", failure.GetProperty("code").GetString());
        True(cancelled.Task.IsCompleted, "Metadata extraction was not cancelled.");
        Equal(0, updater.CallCount);
    }

    private static async Task NativeHostServerStartsAndCancelsWithoutRunningUpdater()
    {
        using var input = new AppendableInputStream();
        using var output = new SignallingOutputStream();
        var updater = new BlockingUpdatePolicy();
        var downloadStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var service = new FakeYouTubeService();
        service.StartHandler = async (jobId, _, height, _, _, cancellationToken) =>
        {
            service.Snapshot = new JobSnapshot(
                jobId, "jNQXAC9IVRw", "Me at the zoo", height,
                "video", 1, null, null);
            downloadStarted.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("unreachable");
        };
        var server = new NativeHostServer(
            new NativeMessageChannel(input, output),
            service,
            updater,
            new FakeFolderPicker(),
            DefaultDownloadFolder,
            new FakeDownloadFileMover());
        var run = server.RunAsync(CancellationToken.None);

        input.Append(FrameCommands(
            Command("startDownload", "r-blocked", "{\"operationId\":\"op-blocked\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720,\"destinationFolder\":null}")));
        await output.WaitForMessageAsync("jobStarted", "r-blocked").WaitAsync(TimeSpan.FromSeconds(5));
        var started = Message(ReadFrames(output), "jobStarted", "r-blocked");
        var jobId = started.GetProperty("jobId").GetString()!;
        True(started.GetProperty("job").GetProperty("stage").GetString() == "preparing", "jobStarted did not persist the preparing snapshot.");

        await downloadStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        input.Append(FrameCommands(Command("getJob", "r-persisted", "{}")));
        await output.WaitForMessageAsync("ready", "r-persisted").WaitAsync(TimeSpan.FromSeconds(5));
        var persisted = Message(ReadFrames(output), "ready", "r-persisted");
        Equal(jobId, persisted.GetProperty("job").GetProperty("jobId").GetString());
        Equal("video", persisted.GetProperty("job").GetProperty("stage").GetString());

        input.Append(FrameCommands(Command("cancelDownload", "r-cancel-blocked", JsonSerializer.Serialize(new { jobId }))));
        await output.WaitForMessageAsync("jobCancelled", "r-blocked").WaitAsync(TimeSpan.FromSeconds(5));
        input.Complete();
        await run.WaitAsync(TimeSpan.FromSeconds(5));

        Equal(0, updater.CallCount);
        Equal(1, service.CancelCallCount);
        Equal(1, service.StartCallCount);
        Equal(jobId, Message(ReadFrames(output), "jobCancelled", "r-blocked").GetProperty("jobId").GetString());
    }

    private static async Task NativeHostServerCancelsAndAwaitsTheJobAtEof()
    {
        using var input = new MemoryStream(FrameCommands(
            Command("startDownload", "r-eof", "{\"operationId\":\"op-eof\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":360,\"destinationFolder\":null}")));
        using var output = new SignallingOutputStream();
        var cancellationObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var service = new FakeYouTubeService();
        service.StartHandler = async (jobId, _, height, _, _, cancellationToken) =>
        {
            service.Snapshot = new JobSnapshot(jobId, "jNQXAC9IVRw", "EOF", height, "video", null, null, null);
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                cancellationObserved.TrySetResult();
                throw;
            }

            throw new InvalidOperationException("unreachable");
        };

        await new NativeHostServer(
                new NativeMessageChannel(input, output),
                service,
                new FakeUpdatePolicy(),
                new FakeFolderPicker(),
                DefaultDownloadFolder,
                new FakeDownloadFileMover())
            .RunAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5));

        True(cancellationObserved.Task.IsCompleted, "EOF returned before the active job observed cancellation.");
        Equal(1, service.CancelCallCount);
        _ = Message(ReadFrames(output), "jobCancelled", "r-eof");
    }

    private static async Task NativeHostServerRejectsInvalidPayloadsWithoutStopping()
    {
        using var input = new MemoryStream(FrameCommands(
            "{",
            "{\"type\":\"unknown\",\"requestId\":\"r-command\",\"payload\":{}}",
            Command("ping", "r-ping-extra", "{\"extra\":true}"),
            Command("getJob", "r-get-extra", "{\"extra\":true}"),
            Command("listFormats", "r-list-missing", "{}"),
            Command("listFormats", "r-list-type", "{\"url\":42}"),
            Command("listFormats", "r-list-extra", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"extra\":true}"),
            Command("startDownload", "r-operation-missing", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720,\"destinationFolder\":null}"),
            Command("startDownload", "r-operation-invalid", "{\"operationId\":\"contains space\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720,\"destinationFolder\":null}"),
            Command("startDownload", "r-height-type", "{\"operationId\":\"op-height-type\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720.5,\"destinationFolder\":null}"),
            Command("startDownload", "r-height-range", "{\"operationId\":\"op-height-range\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":143,\"destinationFolder\":null}"),
            Command("startDownload", "r-audio-subtitle", "{\"operationId\":\"op-audio-subtitle\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"selection\":{\"height\":null,\"audioOnly\":true,\"subtitleLanguage\":\"pt-BR\",\"includeAutomaticSubtitles\":false},\"destinationFolder\":null}"),
            Command("startDownload", "r-media-title-control", "{\"operationId\":\"op-media-control\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"selection\":{\"height\":720,\"audioOnly\":false,\"subtitleLanguage\":null,\"includeAutomaticSubtitles\":false},\"destinationFolder\":null,\"media\":{\"videoId\":\"jNQXAC9IVRw\",\"title\":\"line1\\u000aline2\"}}"),
            Command("startDownload", "r-media-extra", "{\"operationId\":\"op-media-extra\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"selection\":{\"height\":720,\"audioOnly\":false,\"subtitleLanguage\":null,\"includeAutomaticSubtitles\":false},\"destinationFolder\":null,\"media\":{\"videoId\":\"jNQXAC9IVRw\",\"title\":\"Me at the zoo\",\"extra\":true}}"),
            Command("startDownload", "r-url", "{\"operationId\":\"op-url\",\"url\":\"https://example.test/video\",\"height\":720,\"destinationFolder\":null}"),
            Command("startDownload", "r-destination", "{\"operationId\":\"op-destination\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720,\"destinationFolder\":\"relative\"}"),
            Command("cancelDownload", "r-cancel-type", "{\"jobId\":42}"),
            Command("cancelDownload", "r-cancel-missing", "{\"jobId\":\"not-current\"}"),
            Command("chooseDownloadFolder", "r-choose-extra", "{\"extra\":true}"),
            Command("ping", "r-ok", "{}")));
        using var output = new MemoryStream();
        var service = new FakeYouTubeService();
        var updater = new FakeUpdatePolicy();
        var picker = new FakeFolderPicker(SelectedDownloadFolder);

        await new NativeHostServer(
            new NativeMessageChannel(input, output),
            service,
            updater,
            picker,
            DefaultDownloadFolder,
            new FakeDownloadFileMover()).RunAsync(CancellationToken.None);

        var messages = ReadFrames(output);
        Equal("INVALID_COMMAND", Message(messages, "jobFailed", "r-command").GetProperty("code").GetString());
        foreach (var requestId in new[] { "r-ping-extra", "r-get-extra", "r-list-missing", "r-list-type", "r-list-extra", "r-operation-missing", "r-operation-invalid", "r-height-type", "r-height-range", "r-audio-subtitle", "r-media-title-control", "r-media-extra", "r-destination", "r-cancel-type", "r-choose-extra" })
            Equal("INVALID_PAYLOAD", Message(messages, "jobFailed", requestId).GetProperty("code").GetString());
        Equal("INVALID_URL", Message(messages, "jobFailed", "r-url").GetProperty("code").GetString());
        Equal("JOB_NOT_FOUND", Message(messages, "jobFailed", "r-cancel-missing").GetProperty("code").GetString());
        _ = Message(messages, "ready", "r-ok");
        Equal(0, service.ListCallCount);
        Equal(0, service.StartCallCount);
        Equal(0, updater.CallCount);
        Equal(0, picker.CallCount);
    }

    private static async Task NativeHostServerMapsKnownFailuresWithoutLeakingDetails()
    {
        using var input = new ControlledInputStream(FrameCommands(
            Command("listFormats", "r-metadata", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\"}"),
            Command("startDownload", "r-download", "{\"operationId\":\"op-download\",\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":1080,\"destinationFolder\":null}")));
        using var output = new SignallingOutputStream();
        var service = new FakeYouTubeService
        {
            ListError = new InvalidOperationException("secret stderr https://sensitive.example/video")
        };
        service.StartHandler = (_, _, _, _, _, _) => throw new InvalidOperationException("secret stack and https://sensitive.example/video");

        var run = new NativeHostServer(
            new NativeMessageChannel(input, output),
            service,
            new FakeUpdatePolicy(),
            new FakeFolderPicker(),
            DefaultDownloadFolder,
            new FakeDownloadFileMover()).RunAsync(CancellationToken.None);
        await output.WaitForMessageAsync("jobFailed", "r-download").WaitAsync(TimeSpan.FromSeconds(5));
        input.Complete();
        await run.WaitAsync(TimeSpan.FromSeconds(5));

        var json = Encoding.UTF8.GetString(output.ToArray());
        True(!json.Contains("secret", StringComparison.OrdinalIgnoreCase), "A service diagnostic leaked to Native Messaging stdout.");
        True(!json.Contains("sensitive.example", StringComparison.OrdinalIgnoreCase), "A sensitive URL leaked to Native Messaging stdout.");
        var messages = ReadFrames(output);
        var metadata = Message(messages, "jobFailed", "r-metadata");
        Equal("YOUTUBE_METADATA", metadata.GetProperty("code").GetString());
        True(metadata.GetProperty("message").GetString()!.Contains("formatos", StringComparison.OrdinalIgnoreCase), "Metadata error was not user-facing PT-BR.");
        var download = Message(messages, "jobFailed", "r-download");
        Equal("YOUTUBE_DOWNLOAD", download.GetProperty("code").GetString());
        True(download.GetProperty("message").GetString()!.Contains("baixar", StringComparison.OrdinalIgnoreCase), "Download error was not user-facing PT-BR.");
    }

    private static async Task NativeHostServerPreservesSafeMediaDownloadFailures()
    {
        using var input = new ControlledInputStream(FrameCommands(
            Command("startDownload", "r-instagram", "{\"operationId\":\"op-instagram\",\"url\":\"https://www.instagram.com/reel/Chunk8-jurw/\",\"height\":960,\"destinationFolder\":null}")));
        using var output = new SignallingOutputStream();
        var service = new FakeYouTubeService();
        service.StartHandler = (_, _, _, _, _, _) =>
            throw new MediaDownloadException("MEDIA_ACCESS_DENIED", "Não foi possível acessar o arquivo de vídeo.");

        var run = new NativeHostServer(
            new NativeMessageChannel(input, output),
            service,
            new FakeUpdatePolicy(),
            new FakeFolderPicker(),
            DefaultDownloadFolder,
            new FakeDownloadFileMover()).RunAsync(CancellationToken.None);
        await output.WaitForMessageAsync("jobFailed", "r-instagram").WaitAsync(TimeSpan.FromSeconds(5));
        input.Complete();
        await run.WaitAsync(TimeSpan.FromSeconds(5));

        var failure = Message(ReadFrames(output), "jobFailed", "r-instagram");
        Equal("MEDIA_ACCESS_DENIED", failure.GetProperty("code").GetString());
        True(failure.GetProperty("message").GetString()!.Contains("arquivo", StringComparison.OrdinalIgnoreCase), "Safe media failure was not preserved.");
    }

    private static async Task NativeHostServerChoosesAndCancelsDownloadFolder()
    {
        using var input = new MemoryStream(FrameCommands(
            Command("chooseDownloadFolder", "r-folder-selected", "{}"),
            Command("chooseDownloadFolder", "r-folder-cancelled", "{}")));
        using var output = new MemoryStream();
        var picker = new FakeFolderPicker(SelectedDownloadFolder, null);

        await new NativeHostServer(
            new NativeMessageChannel(input, output),
            new FakeYouTubeService(),
            new FakeUpdatePolicy(),
            picker,
            DefaultDownloadFolder,
            new FakeDownloadFileMover()).RunAsync(CancellationToken.None);

        var messages = ReadFrames(output);
        var selected = Message(messages, "folderSelected", "r-folder-selected");
        Equal(SelectedDownloadFolder, selected.GetProperty("path").GetString());
        _ = Message(messages, "folderSelectionCancelled", "r-folder-cancelled");
        Equal(2, picker.CallCount);
    }

    private static async Task NativeHostServerMapsFolderPickerFailuresWithoutStopping()
    {
        using var input = new MemoryStream(FrameCommands(
            Command("chooseDownloadFolder", "r-picker-error", "{}"),
            Command("ping", "r-after-picker-error", "{}")));
        using var output = new MemoryStream();
        var picker = new FakeFolderPicker
        {
            Error = new InvalidOperationException("secret picker diagnostic C:\\Sensitive")
        };

        await new NativeHostServer(
            new NativeMessageChannel(input, output),
            new FakeYouTubeService(),
            new FakeUpdatePolicy(),
            picker,
            DefaultDownloadFolder,
            new FakeDownloadFileMover()).RunAsync(CancellationToken.None);

        var raw = Encoding.UTF8.GetString(output.ToArray());
        True(!raw.Contains("secret", StringComparison.OrdinalIgnoreCase), "A folder picker diagnostic leaked to Native Messaging stdout.");
        True(!raw.Contains("Sensitive", StringComparison.OrdinalIgnoreCase), "A folder picker path leaked to Native Messaging stdout.");
        var messages = ReadFrames(output);
        var failure = Message(messages, "jobFailed", "r-picker-error");
        Equal("HOST_ERROR", failure.GetProperty("code").GetString());
        Equal("chooseDownloadFolder", failure.GetProperty("details").GetProperty("operation").GetString());
        _ = Message(messages, "ready", "r-after-picker-error");
        Equal(1, picker.CallCount);
    }

    private static async Task NativeHostServerPropagatesCancellationFromFolderPicker()
    {
        using var input = new ControlledInputStream(FrameCommands(
            Command("chooseDownloadFolder", "r-picker-cancelled", "{}")));
        using var output = new MemoryStream();
        using var cancellation = new CancellationTokenSource();
        var picker = new BlockingFolderPicker();
        var run = new NativeHostServer(
            new NativeMessageChannel(input, output),
            new FakeYouTubeService(),
            new FakeUpdatePolicy(),
            picker,
            DefaultDownloadFolder,
            new FakeDownloadFileMover()).RunAsync(cancellation.Token);

        await picker.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        try
        {
            await run.WaitAsync(TimeSpan.FromSeconds(5));
            throw new InvalidOperationException("Folder picker cancellation did not stop the server.");
        }
        catch (OperationCanceledException)
        {
            // Expected: dispatch preserves cancellation from the server token.
        }

        True(picker.Cancelled.Task.IsCompleted, "The folder picker did not observe cancellation.");
        Equal(0L, output.Length);
    }

    private static async Task NativeHostServerRejectsInvalidPickedFoldersWithoutStopping()
    {
        var invalidFolders = InvalidDownloadFolders().Where(folder => folder is not null).ToArray();
        var commands = invalidFolders
            .Select((_, index) => Command("chooseDownloadFolder", $"r-invalid-folder-{index}", "{}"))
            .Append(Command("ping", "r-after-invalid-folders", "{}"))
            .ToArray();
        using var input = new MemoryStream(FrameCommands(commands));
        using var output = new MemoryStream();
        var picker = new FakeFolderPicker(invalidFolders.Cast<string?>().ToArray());

        await new NativeHostServer(
            new NativeMessageChannel(input, output),
            new FakeYouTubeService(),
            new FakeUpdatePolicy(),
            picker,
            DefaultDownloadFolder,
            new FakeDownloadFileMover()).RunAsync(CancellationToken.None);

        var messages = ReadFrames(output);
        for (var index = 0; index < invalidFolders.Length; index++)
        {
            var requestId = $"r-invalid-folder-{index}";
            var failure = messages.SingleOrDefault(message =>
                message.GetProperty("type").GetString() == "jobFailed"
                && message.GetProperty("requestId").GetString() == requestId);
            True(failure.ValueKind == JsonValueKind.Object, $"Invalid picked folder was accepted: {invalidFolders[index]}");
            Equal("HOST_ERROR", failure.GetProperty("code").GetString());
            Equal("chooseDownloadFolder", failure.GetProperty("details").GetProperty("operation").GetString());
        }
        _ = Message(messages, "ready", "r-after-invalid-folders");
        Equal(invalidFolders.Length, picker.CallCount);
    }

    private static void NativeHostServerRejectsInvalidFallbackFolders()
    {
        using var input = new MemoryStream();
        using var output = new MemoryStream();
        var channel = new NativeMessageChannel(input, output);
        var service = new FakeYouTubeService();
        var updater = new FakeUpdatePolicy();
        var picker = new FakeFolderPicker();

        foreach (var invalidFolder in InvalidDownloadFolders())
            Throws<ArgumentException>(() => new NativeHostServer(
                channel, service, updater, picker, invalidFolder, new FakeDownloadFileMover()));

        _ = new NativeHostServer(channel, service, updater, picker, @"C:\", new FakeDownloadFileMover());
        _ = new NativeHostServer(channel, service, updater, picker, @"\\server\share\Videos", new FakeDownloadFileMover());
    }

    private static async Task NativeHostServerMovesDownloadedFilesAndMapsFailuresSafely()
    {
        const string source = @"C:\Browser Downloads\Video Radar\.staging\op_42\aula.ts";
        const string destination = @"D:\Cursos";
        const string finalPath = @"D:\Cursos\aula.ts";
        using var input = new MemoryStream(FrameCommands(
            Command("moveDownloadedFile", "r-move", JsonSerializer.Serialize(new
            {
                operationId = "op_42",
                downloadId = 42,
                sourcePath = source,
                destinationFolder = destination
            })),
            Command("moveDownloadedFile", "r-extra", JsonSerializer.Serialize(new
            {
                operationId = "op_43",
                downloadId = 43,
                sourcePath = source,
                destinationFolder = destination,
                extra = true
            })),
            Command("moveDownloadedFile", "r-negative", JsonSerializer.Serialize(new
            {
                operationId = "op_negative",
                downloadId = -1,
                sourcePath = source,
                destinationFolder = destination
            })),
            Command("moveDownloadedFile", "r-empty", JsonSerializer.Serialize(new
            {
                operationId = "op_empty",
                downloadId = 44,
                sourcePath = source,
                destinationFolder = ""
            })),
            Command("moveDownloadedFile", "r-invalid-path", JsonSerializer.Serialize(new
            {
                operationId = "op_invalid",
                downloadId = 45,
                sourcePath = "relative.ts",
                destinationFolder = destination
            })),
            Command("moveDownloadedFile", "r-io", JsonSerializer.Serialize(new
            {
                operationId = "op_io",
                downloadId = 46,
                sourcePath = @"C:\Sensitive\copy-error.ts",
                destinationFolder = destination
            })),
            Command("moveDownloadedFile", "r-missing-operation", JsonSerializer.Serialize(new
            {
                downloadId = 47,
                sourcePath = source,
                destinationFolder = destination
            })),
            Command("moveDownloadedFile", "r-invalid-operation", JsonSerializer.Serialize(new
            {
                operationId = "op.invalid",
                downloadId = 48,
                sourcePath = source,
                destinationFolder = destination
            })),
            Command("ping", "r-after-move-errors", "{}")));
        using var output = new MemoryStream();
        var mover = new FakeDownloadFileMover((sourcePath, destinationFolder, downloadId, _) =>
        {
            if (sourcePath == "relative.ts")
                throw new ArgumentException("secret invalid path C:\\Sensitive");
            if (sourcePath.EndsWith("copy-error.ts", StringComparison.Ordinal))
                throw new IOException("secret IO path C:\\Sensitive");
            return new FileMoveResult(downloadId, finalPath);
        });

        await new NativeHostServer(
            new NativeMessageChannel(input, output),
            new FakeYouTubeService(),
            new FakeUpdatePolicy(),
            new FakeFolderPicker(),
            DefaultDownloadFolder,
            mover).RunAsync(CancellationToken.None);

        var raw = Encoding.UTF8.GetString(output.ToArray());
        True(!raw.Contains("secret", StringComparison.OrdinalIgnoreCase), "A mover diagnostic leaked to Native Messaging stdout.");
        True(!raw.Contains("Sensitive", StringComparison.OrdinalIgnoreCase), "A mover path leaked to Native Messaging stdout.");
        var messages = ReadFrames(output);
        var moved = Message(messages, "fileMoved", "r-move");
        Equal("op_42", moved.GetProperty("operationId").GetString());
        Equal(42L, moved.GetProperty("downloadId").GetInt64());
        Equal(finalPath, moved.GetProperty("finalPath").GetString());
        True(
            moved.EnumerateObject().Select(property => property.Name).ToHashSet(StringComparer.Ordinal)
                .SetEquals(["type", "requestId", "operationId", "downloadId", "finalPath"]),
            "fileMoved exposed an unexpected property.");

        foreach (var requestId in new[] { "r-extra", "r-negative", "r-empty", "r-missing-operation", "r-invalid-operation" })
            Equal("INVALID_PAYLOAD", Message(messages, "jobFailed", requestId).GetProperty("code").GetString());
        foreach (var requestId in new[] { "r-invalid-path" })
            Equal("DESTINATION_INVALID", Message(messages, "jobFailed", requestId).GetProperty("code").GetString());
        Equal("DESTINATION_MOVE_FAILED", Message(messages, "jobFailed", "r-io").GetProperty("code").GetString());
        _ = Message(messages, "ready", "r-after-move-errors");

        Equal(3, mover.Calls.Count);
        Equal(new FileMoveCall(source, destination, 42, "op_42"), mover.Calls[0]);
    }

    private static string[] InvalidDownloadFolders() =>
    [
        null!,
        string.Empty,
        "relative",
        @"C:/Downloads",
        @"\\?\C:\Downloads",
        @"\\.\C:\Downloads",
        @"\\??\C:\Downloads",
        @"\\server",
        @"C:\CON",
        @"C:\CON.txt",
        @"C:\Videos:Archive",
        @"C:\Videos*",
        @"C:\Videos\\Archive",
        @"C:\Videos\..\Archive",
        @"C:\Videos\Archive.",
        @"C:\Videos\Archive ",
        DefaultDownloadFolder + "\\",
        @"C:\" + new string('a', 1022)
    ];

    private static async Task NativeHostServerRevealsDownloadedFilesAndMapsFailuresSafely()
    {
        using var input = new MemoryStream(FrameCommands(
            Command("revealDownloadedFile", "r-reveal", "{\"path\":\"C:\\\\Downloads\\\\Video Radar\\\\aula.mp4\"}"),
            Command("revealDownloadedFile", "r-invalid", "{\"path\":\"relative.mp4\"}"),
            Command("ping", "r-after-reveal", "{}")));
        using var output = new MemoryStream();
        var mover = new FakeDownloadFileMover();

        await new NativeHostServer(
            new NativeMessageChannel(input, output),
            new FakeYouTubeService(),
            new FakeUpdatePolicy(),
            new FakeFolderPicker(),
            DefaultDownloadFolder,
            mover).RunAsync(CancellationToken.None);

        var messages = ReadFrames(output);
        _ = Message(messages, "fileRevealed", "r-reveal");
        Equal(@"C:\Downloads\Video Radar\aula.mp4", mover.RevealCalls.Single());
        Equal("FILE_INVALID", Message(messages, "jobFailed", "r-invalid").GetProperty("code").GetString());
        _ = Message(messages, "ready", "r-after-reveal");
    }

    private static async Task UpdatePolicyNeverMutatesPinnedTools()
    {
        var runner = new UpdateProcessRunner(
            _ => throw new InvalidOperationException("The pinned-tool policy invoked a process."));
        var policy = new UpdatePolicy(@"C:\VideoRadar\host\tools", runner);

        await policy.CheckAsync(CancellationToken.None);

        Equal(0, runner.Calls.Count);
    }

    private static void ProgramPingDiagnosticIsPureAndMachineReadable()
    {
        var root = Path.Combine(Path.GetTempPath(), "video-radar-ping-tests", Guid.NewGuid().ToString("N"));
        var tools = Path.Combine(root, "tools");
        Directory.CreateDirectory(tools);
        try
        {
            foreach (var file in new[] { "yt-dlp.exe", "deno.exe", "ffmpeg.exe", "ffprobe.exe" })
                File.WriteAllText(Path.Combine(tools, file), string.Empty);

            var diagnostic = global::VideoRadar.NativeHost.Program.CreatePingDiagnostic(tools);
            True(diagnostic.Ok, "Pure --ping diagnostic did not recognize the local tool set.");
            True(diagnostic.Tools.YtDlp && diagnostic.Tools.Deno && diagnostic.Tools.Ffmpeg && diagnostic.Tools.Ffprobe, "Tool diagnostic was incomplete.");

            File.Delete(Path.Combine(tools, "ffprobe.exe"));
            True(!global::VideoRadar.NativeHost.Program.CreatePingDiagnostic(tools).Ok, "Missing ffprobe did not fail diagnostics.");

            var executable = Path.Combine(AppContext.BaseDirectory, "video-radar-host.exe");
            var result = RunProcess(executable, ["--ping"]);
            var lines = result.StandardOutput.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries);
            Equal(1, lines.Length);
            using var json = JsonDocument.Parse(lines[0]);
            var ok = json.RootElement.GetProperty("ok").GetBoolean();
            Equal(ok ? 0 : 1, result.ExitCode);
            Equal(HostInfo.NativeName, json.RootElement.GetProperty("host").GetString());
            Equal(HostInfo.ProtocolVersion, json.RootElement.GetProperty("protocolVersion").GetInt32());
            Equal(string.Empty, result.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private const string DefaultDownloadFolder = @"C:\Downloads\Video Radar";
    private const string SelectedDownloadFolder = @"C:\Media\Video Radar";

    private static readonly HashSet<string> AllowedServerTypes =
        ["ready", "formats", "jobQueued", "jobPaused", "queueSnapshot", "jobStarted", "jobProgress", "jobCompleted", "jobCancelled", "jobFailed", "folderSelected", "folderSelectionCancelled", "fileMoved", "fileRevealed", "diagnostics", "diagnosticsExported", "diagnosticsCleared"];

    private static string Command(string type, string requestId, string payload) =>
        $"{{\"type\":{JsonSerializer.Serialize(type)},\"requestId\":{JsonSerializer.Serialize(requestId)},\"payload\":{payload}}}";

    private static byte[] FrameCommands(params string[] commands)
    {
        using var stream = new MemoryStream();
        var header = new byte[sizeof(uint)];
        foreach (var command in commands)
        {
            var body = Encoding.UTF8.GetBytes(command);
            BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)body.Length);
            stream.Write(header);
            stream.Write(body);
        }

        return stream.ToArray();
    }

    private static List<JsonElement> ReadFrames(MemoryStream stream)
    {
        var bytes = stream.ToArray();
        using var input = new MemoryStream(bytes);
        using var sink = new MemoryStream();
        var channel = new NativeMessageChannel(input, sink);
        var messages = new List<JsonElement>();
        while (true)
        {
            using var document = channel.ReadAsync(CancellationToken.None).GetAwaiter().GetResult();
            if (document is null) return messages;
            messages.Add(document.RootElement.Clone());
        }
    }

    private static JsonElement Message(IEnumerable<JsonElement> messages, string type, string requestId) =>
        messages.Single(message => message.GetProperty("type").GetString() == type
            && message.GetProperty("requestId").GetString() == requestId);

    private sealed class FakeUpdatePolicy : IUpdatePolicy
    {
        public int CallCount { get; private set; }
        public Exception? Error { get; init; }

        public Task CheckAsync(CancellationToken cancellationToken)
        {
            CallCount++;
            if (Error is not null) throw Error;
            return Task.CompletedTask;
        }
    }

    private sealed class FakeFolderPicker(params string?[] results) : IFolderPicker
    {
        public Queue<string?> Results { get; } = new(results);
        public int CallCount { get; private set; }
        public Exception? Error { get; init; }

        public Task<string?> PickAsync(CancellationToken cancellationToken)
        {
            CallCount++;
            if (Error is not null) throw Error;
            if (Results.Count == 0) throw new InvalidOperationException("No folder picker result was configured.");
            return Task.FromResult(Results.Dequeue());
        }
    }

    private sealed record FileMoveCall(
        string SourcePath,
        string DestinationFolder,
        long DownloadId,
        string OperationId);

    private sealed class FakeDownloadFileMover(
        Func<string, string, long, string, FileMoveResult>? handler = null) : IDownloadFileMover
    {
        public List<FileMoveCall> Calls { get; } = [];
        public List<string> RevealCalls { get; } = [];

        public FileMoveResult Move(string sourcePath, string destinationFolder, long downloadId)
        {
            return Move(sourcePath, destinationFolder, downloadId, "legacy-test-operation");
        }

        public FileMoveResult Move(
            string sourcePath,
            string destinationFolder,
            long downloadId,
            string operationId)
        {
            Calls.Add(new FileMoveCall(sourcePath, destinationFolder, downloadId, operationId));
            return handler?.Invoke(sourcePath, destinationFolder, downloadId, operationId)
                ?? new FileMoveResult(downloadId, Path.Combine(destinationFolder, Path.GetFileName(sourcePath)));
        }

        public void Reveal(string path)
        {
            RevealCalls.Add(path);
            if (!Path.IsPathFullyQualified(path)) throw new ArgumentException("invalid path");
        }
    }

    private sealed class BlockingFolderPicker : IFolderPicker
    {
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Cancelled { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task<string?> PickAsync(CancellationToken cancellationToken)
        {
            Started.TrySetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                throw new InvalidOperationException("Folder picker unexpectedly completed.");
            }
            catch (OperationCanceledException)
            {
                Cancelled.TrySetResult();
                throw;
            }
        }
    }

    private sealed class BlockingUpdatePolicy : IUpdatePolicy
    {
        public int CallCount { get; private set; }
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Cancelled { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task CheckAsync(CancellationToken cancellationToken)
        {
            CallCount++;
            Started.TrySetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                Cancelled.TrySetResult();
                throw;
            }
        }
    }

    private sealed class FakeYouTubeService : IYouTubeService, IResumableYouTubeService
    {
        public int ListCallCount { get; private set; }
        public int StartCallCount { get; private set; }
        public int CancelCallCount { get; private set; }
        public int PauseCallCount { get; private set; }
        public int DiscardPartialCallCount { get; private set; }
        public int CommitCompletedCallCount { get; private set; }
        public Exception? ListError { get; init; }
        public Exception? CommitError { get; init; }
        public Func<int, string, CancellationToken, Task<FormatCatalog>>? ListHandler { get; init; }
        public JobSnapshot? Snapshot { get; set; }
        public List<string?> DestinationFolders { get; } = [];
        public List<DownloadSelection> Selections { get; } = [];
        public List<DownloadRunOptions> RunOptions { get; } = [];
        public Func<string, string, int, string?, Func<JobProgress, Task>, CancellationToken, Task<JobResult>>? StartHandler { get; set; }

        public Task<FormatCatalog> ListFormatsAsync(string url, CancellationToken cancellationToken)
        {
            ListCallCount++;
            if (ListHandler is not null) return ListHandler(ListCallCount, url, cancellationToken);
            if (ListError is not null) throw ListError;
            return Task.FromResult(Catalog());
        }

        public static FormatCatalog Catalog() =>
            new(
                "jNQXAC9IVRw",
                "Me at the zoo",
                19,
                [new QualityOption(1080, "1080p", "MP4", false), new QualityOption(720, "720p", "MP4", false)]);

        public Task<JobResult> StartDownloadAsync(
            string jobId,
            string url,
            int height,
            string? destinationFolder,
            Func<JobProgress, Task> onProgress,
            CancellationToken cancellationToken)
        {
            StartCallCount++;
            DestinationFolders.Add(destinationFolder);
            return StartHandler?.Invoke(jobId, url, height, destinationFolder, onProgress, cancellationToken)
                ?? Task.FromResult(new JobResult(jobId, @"C:\Downloads\Video Radar\video.mp4"));
        }

        public Task<JobResult> StartDownloadAsync(
            string jobId,
            string url,
            DownloadSelection selection,
            string? destinationFolder,
            DownloadRunOptions options,
            Func<JobProgress, Task> onProgress,
            CancellationToken cancellationToken)
        {
            Selections.Add(selection);
            RunOptions.Add(options);
            return StartDownloadAsync(
                jobId,
                url,
                selection.Height ?? 0,
                destinationFolder,
                onProgress,
                cancellationToken);
        }

        public Task CancelAsync(string jobId)
        {
            CancelCallCount++;
            return Task.CompletedTask;
        }

        public Task PauseAsync(string jobId)
        {
            PauseCallCount++;
            return Task.CompletedTask;
        }

        public Task DiscardPartialAsync(
            string jobId,
            string? destinationFolder,
            CancellationToken cancellationToken = default)
        {
            DiscardPartialCallCount++;
            cancellationToken.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        }

        public Task CommitCompletedAsync(
            string jobId,
            string? destinationFolder,
            string finalPath,
            CancellationToken cancellationToken = default)
        {
            CommitCompletedCallCount++;
            cancellationToken.ThrowIfCancellationRequested();
            if (CommitError is not null) throw CommitError;
            return Task.CompletedTask;
        }

        public JobSnapshot? GetJob() => Snapshot;
    }

    private sealed class FakeDiagnosticService : IDiagnosticService
    {
        public bool Enabled { get; private set; }
        public bool Cleared { get; private set; }
        public string? ExportedDestination { get; private set; }

        public DiagnosticSummary GetSummary(string downloadFolder) => new(
            DateTimeOffset.Parse("2026-08-12T12:00:00Z"),
            HostInfo.Version,
            HostInfo.ProtocolVersion,
            "x64",
            "Windows fixture",
            1_000,
            Enabled,
            0,
            [new DiagnosticTool("ffprobe.exe", true, "8.0", 10, null)]);

        public void SetEnabled(bool enabled) => Enabled = enabled;
        public void Record(string eventName, string? code = null) { }
        public string Export(string destinationFolder, string downloadFolder)
        {
            ExportedDestination = destinationFolder;
            return Path.Combine(destinationFolder, "VideoRadar-Diagnostics.zip");
        }
        public void Clear() => Cleared = true;
    }

    private sealed record UpdateCall(string Executable, IReadOnlyList<string> Arguments, Func<string, Task>? OnOutput);

    private sealed class UpdateProcessRunner(Func<UpdateCall, Task<VideoRadar.NativeHost.Processes.ProcessResult>> handler) : IProcessRunner
    {
        public List<UpdateCall> Calls { get; } = [];

        public Task<VideoRadar.NativeHost.Processes.ProcessResult> RunAsync(
            string executable,
            IReadOnlyList<string> arguments,
            Func<string, Task>? onOutput,
            CancellationToken cancellationToken)
        {
            var call = new UpdateCall(executable, arguments.ToArray(), onOutput);
            Calls.Add(call);
            return handler(call);
        }
    }

    private sealed class ControlledInputStream(byte[] contents) : MemoryStream(contents, writable: false)
    {
        private readonly TaskCompletionSource eof = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void Complete() => eof.TrySetResult();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var read = await base.ReadAsync(buffer, cancellationToken);
            if (read > 0) return read;
            await eof.Task.WaitAsync(cancellationToken);
            return 0;
        }
    }

    private sealed class AppendableInputStream : Stream
    {
        private readonly Queue<byte> bytes = new();
        private readonly SemaphoreSlim available = new(0);
        private readonly object sync = new();
        private bool completed;

        public void Append(byte[] value)
        {
            lock (sync)
            {
                if (completed) throw new InvalidOperationException("Input is complete.");
                foreach (var item in value) bytes.Enqueue(item);
            }
            available.Release();
        }

        public void Complete()
        {
            lock (sync) completed = true;
            available.Release();
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            while (true)
            {
                lock (sync)
                {
                    if (bytes.Count > 0)
                    {
                        var count = Math.Min(buffer.Length, bytes.Count);
                        for (var index = 0; index < count; index++) buffer.Span[index] = bytes.Dequeue();
                        return count;
                    }

                    if (completed) return 0;
                }

                await available.WaitAsync(cancellationToken);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) available.Dispose();
            base.Dispose(disposing);
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class SignallingOutputStream : MemoryStream
    {
        private readonly Dictionary<string, TaskCompletionSource> typeSignals = [];
        private readonly Dictionary<string, TaskCompletionSource> messageSignals = [];
        private readonly HashSet<string> observedTypes = [];
        private readonly HashSet<string> observedMessages = [];
        private int scanOffset;

        public Task WaitForTypeAsync(string type)
        {
            lock (this)
            {
                if (observedTypes.Contains(type)) return Task.CompletedTask;
                if (!typeSignals.TryGetValue(type, out var signal))
                    typeSignals[type] = signal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                Scan();
                return signal.Task;
            }
        }

        public Task WaitForMessageAsync(string type, string requestId)
        {
            var key = MessageKey(type, requestId);
            lock (this)
            {
                if (observedMessages.Contains(key)) return Task.CompletedTask;
                if (!messageSignals.TryGetValue(key, out var signal))
                    messageSignals[key] = signal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                Scan();
                return signal.Task;
            }
        }

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (this)
            {
                base.Write(buffer.Span);
                Scan();
            }
            return ValueTask.CompletedTask;
        }

        private void Scan()
        {
            var value = GetBuffer();
            while (Length - scanOffset >= sizeof(uint))
            {
                var length = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(value.AsSpan(scanOffset, sizeof(uint))));
                if (Length - scanOffset - sizeof(uint) < length) return;
                using var document = JsonDocument.Parse(value.AsMemory(scanOffset + sizeof(uint), length));
                var root = document.RootElement;
                if (root.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String)
                {
                    var typeName = type.GetString()!;
                    observedTypes.Add(typeName);
                    if (typeSignals.TryGetValue(typeName, out var typeSignal)) typeSignal.TrySetResult();
                }
                if (root.TryGetProperty("requestId", out var request) && request.ValueKind == JsonValueKind.String)
                {
                    var requestId = request.GetString()!;
                    if (root.TryGetProperty("type", out var messageType) && messageType.ValueKind == JsonValueKind.String)
                    {
                        var key = MessageKey(messageType.GetString()!, requestId);
                        observedMessages.Add(key);
                        if (messageSignals.TryGetValue(key, out var messageSignal)) messageSignal.TrySetResult();
                    }
                }
                scanOffset += sizeof(uint) + length;
            }
        }

        private static string MessageKey(string type, string requestId) => $"{type}\0{requestId}";
    }
}
