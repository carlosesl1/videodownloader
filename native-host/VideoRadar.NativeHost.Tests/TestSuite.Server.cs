using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using VideoRadar.NativeHost.Host;
using VideoRadar.NativeHost.Processes;
using VideoRadar.NativeHost.Protocol;
using VideoRadar.NativeHost.Tools;
using VideoRadar.NativeHost.YouTube;

namespace VideoRadar.NativeHost.Tests;

internal static partial class TestSuite
{
    private static void ServerTests()
    {
        NativeHostServerRunsTheFramedProtocol().GetAwaiter().GetResult();
        NativeHostServerEmitsPersistentJobBeforeBlockedUpdateAndCancelsIt().GetAwaiter().GetResult();
        NativeHostServerRejectsBusyAndCancelsTheCurrentJob().GetAwaiter().GetResult();
        NativeHostServerCancelsAndAwaitsTheJobAtEof().GetAwaiter().GetResult();
        NativeHostServerRejectsInvalidPayloadsWithoutStopping().GetAwaiter().GetResult();
        NativeHostServerMapsKnownFailuresWithoutLeakingDetails().GetAwaiter().GetResult();
        UpdatePolicyChecksAtMostDailyAndRecordsFailedAttempts().GetAwaiter().GetResult();
        ProgramPingDiagnosticIsPureAndMachineReadable();
    }

    private static async Task NativeHostServerRunsTheFramedProtocol()
    {
        using var input = new ControlledInputStream(FrameCommands(
            Command("ping", "r-ping", "{}"),
            Command("listFormats", "r-formats", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\"}"),
            Command("getJob", "r-empty", "{}"),
            Command("startDownload", "r-start", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":1080}"),
            Command("getJob", "r-active", "{}")));
        using var output = new SignallingOutputStream();
        var updater = new FakeUpdatePolicy { Error = new InvalidOperationException("network diagnostics") };
        var service = new FakeYouTubeService();
        service.StartHandler = async (jobId, _, height, onProgress, _) =>
        {
            service.Snapshot = new JobSnapshot(jobId, "jNQXAC9IVRw", "Me at the zoo", height, "video", 10, null, null);
            await onProgress(new JobProgress("video", 10, 100, 1_000, 50, 18));
            await onProgress(new JobProgress("audio", 50, 500, 1_000, 100, 5));
            service.Snapshot = service.Snapshot with { Stage = "complete", Percent = 100, Path = @"C:\Downloads\Video Radar\video.mp4" };
            return new JobResult(jobId, service.Snapshot.Path!);
        };

        var run = new NativeHostServer(new NativeMessageChannel(input, output), service, updater).RunAsync(CancellationToken.None);
        await output.WaitForTypeAsync("jobCompleted").WaitAsync(TimeSpan.FromSeconds(5));
        input.Complete();
        await run.WaitAsync(TimeSpan.FromSeconds(5));

        var messages = ReadFrames(output);
        True(messages.All(message => AllowedServerTypes.Contains(message.GetProperty("type").GetString()!)), "Server emitted a type outside the protocol allowlist.");

        var ready = Message(messages, "ready", "r-ping");
        Equal(HostInfo.ProtocolVersion, ready.GetProperty("protocolVersion").GetInt32());
        Equal(HostInfo.NativeName, ready.GetProperty("nativeName").GetString());

        var formats = Message(messages, "formats", "r-formats");
        Equal("jNQXAC9IVRw", formats.GetProperty("videoId").GetString());
        Equal("Me at the zoo", formats.GetProperty("title").GetString());
        Equal(19d, formats.GetProperty("durationSeconds").GetDouble());
        Equal(1080, formats.GetProperty("qualities")[0].GetProperty("height").GetInt32());
        Equal(1, updater.CallCount);
        Equal(1, service.ListCallCount);

        var emptyJob = Message(messages, "ready", "r-empty");
        Equal(JsonValueKind.Null, emptyJob.GetProperty("job").ValueKind);

        var started = Message(messages, "jobStarted", "r-start");
        var jobId = started.GetProperty("jobId").GetString()!;
        True(Guid.TryParse(jobId, out _), "startDownload did not create a UUID job id.");
        Equal(jobId, started.GetProperty("job").GetProperty("jobId").GetString());
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
    }

    private static async Task NativeHostServerRejectsBusyAndCancelsTheCurrentJob()
    {
        var service = new FakeYouTubeService();
        service.StartHandler = async (jobId, _, height, _, cancellationToken) =>
        {
            service.Snapshot = new JobSnapshot(jobId, "jNQXAC9IVRw", "Active", height, "video", 1, null, null);
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("unreachable");
        };

        // The cancel payload must contain the UUID generated by the server, so feed it after observing jobStarted.
        using var dynamicInput = new AppendableInputStream();
        using var dynamicOutput = new SignallingOutputStream();
        dynamicInput.Append(FrameCommands(
            Command("startDownload", "r-first", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720}"),
            Command("startDownload", "r-second", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720}")));
        var server = new NativeHostServer(new NativeMessageChannel(dynamicInput, dynamicOutput), service, new FakeUpdatePolicy());
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
        Equal(1, service.StartCallCount);
        Equal(1, service.CancelCallCount);
    }

    private static async Task NativeHostServerEmitsPersistentJobBeforeBlockedUpdateAndCancelsIt()
    {
        using var input = new AppendableInputStream();
        using var output = new SignallingOutputStream();
        var updater = new BlockingUpdatePolicy();
        var service = new FakeYouTubeService();
        var server = new NativeHostServer(new NativeMessageChannel(input, output), service, updater);
        var run = server.RunAsync(CancellationToken.None);

        input.Append(FrameCommands(
            Command("startDownload", "r-blocked", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720}")));
        await output.WaitForMessageAsync("jobStarted", "r-blocked").WaitAsync(TimeSpan.FromSeconds(5));
        var started = Message(ReadFrames(output), "jobStarted", "r-blocked");
        var jobId = started.GetProperty("jobId").GetString()!;
        True(started.GetProperty("job").GetProperty("stage").GetString() == "preparing", "jobStarted did not persist the preparing snapshot.");

        await updater.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        input.Append(FrameCommands(Command("getJob", "r-persisted", "{}")));
        await output.WaitForMessageAsync("ready", "r-persisted").WaitAsync(TimeSpan.FromSeconds(5));
        var persisted = Message(ReadFrames(output), "ready", "r-persisted");
        Equal(jobId, persisted.GetProperty("job").GetProperty("jobId").GetString());
        Equal("preparing", persisted.GetProperty("job").GetProperty("stage").GetString());

        input.Append(FrameCommands(Command("cancelDownload", "r-cancel-blocked", JsonSerializer.Serialize(new { jobId }))));
        await updater.Cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await output.WaitForMessageAsync("jobCancelled", "r-blocked").WaitAsync(TimeSpan.FromSeconds(5));
        input.Complete();
        await run.WaitAsync(TimeSpan.FromSeconds(5));

        Equal(1, updater.CallCount);
        Equal(1, service.CancelCallCount);
        Equal(0, service.StartCallCount);
        Equal(jobId, Message(ReadFrames(output), "jobCancelled", "r-blocked").GetProperty("jobId").GetString());
    }

    private static async Task NativeHostServerCancelsAndAwaitsTheJobAtEof()
    {
        using var input = new MemoryStream(FrameCommands(
            Command("startDownload", "r-eof", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":360}")));
        using var output = new SignallingOutputStream();
        var cancellationObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var service = new FakeYouTubeService();
        service.StartHandler = async (jobId, _, height, _, cancellationToken) =>
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

        await new NativeHostServer(new NativeMessageChannel(input, output), service, new FakeUpdatePolicy())
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
            Command("startDownload", "r-height-type", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":720.5}"),
            Command("startDownload", "r-height-range", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":143}"),
            Command("startDownload", "r-url", "{\"url\":\"https://example.test/video\",\"height\":720}"),
            Command("cancelDownload", "r-cancel-type", "{\"jobId\":42}"),
            Command("cancelDownload", "r-cancel-missing", "{\"jobId\":\"not-current\"}"),
            Command("ping", "r-ok", "{}")));
        using var output = new MemoryStream();
        var service = new FakeYouTubeService();
        var updater = new FakeUpdatePolicy();

        await new NativeHostServer(new NativeMessageChannel(input, output), service, updater).RunAsync(CancellationToken.None);

        var messages = ReadFrames(output);
        Equal("INVALID_COMMAND", Message(messages, "jobFailed", "r-command").GetProperty("code").GetString());
        foreach (var requestId in new[] { "r-ping-extra", "r-get-extra", "r-list-missing", "r-list-type", "r-list-extra", "r-height-type", "r-height-range", "r-cancel-type" })
            Equal("INVALID_PAYLOAD", Message(messages, "jobFailed", requestId).GetProperty("code").GetString());
        Equal("INVALID_URL", Message(messages, "jobFailed", "r-url").GetProperty("code").GetString());
        Equal("JOB_NOT_FOUND", Message(messages, "jobFailed", "r-cancel-missing").GetProperty("code").GetString());
        _ = Message(messages, "ready", "r-ok");
        Equal(0, service.ListCallCount);
        Equal(0, service.StartCallCount);
        Equal(0, updater.CallCount);
    }

    private static async Task NativeHostServerMapsKnownFailuresWithoutLeakingDetails()
    {
        using var input = new ControlledInputStream(FrameCommands(
            Command("listFormats", "r-metadata", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\"}"),
            Command("startDownload", "r-download", "{\"url\":\"https://youtu.be/jNQXAC9IVRw\",\"height\":1080}")));
        using var output = new SignallingOutputStream();
        var service = new FakeYouTubeService
        {
            ListError = new InvalidOperationException("secret stderr https://sensitive.example/video")
        };
        service.StartHandler = (_, _, _, _, _) => throw new InvalidOperationException("secret stack and https://sensitive.example/video");

        var run = new NativeHostServer(new NativeMessageChannel(input, output), service, new FakeUpdatePolicy()).RunAsync(CancellationToken.None);
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

    private static async Task UpdatePolicyChecksAtMostDailyAndRecordsFailedAttempts()
    {
        var root = Path.Combine(Path.GetTempPath(), "video-radar-update-tests", Guid.NewGuid().ToString("N"));
        var statePath = Path.Combine(root, "state", "yt-dlp-update.json");
        var tools = Path.Combine(root, "tools");
        var now = new DateTimeOffset(2026, 7, 22, 12, 0, 0, TimeSpan.Zero);
        Directory.CreateDirectory(tools);
        try
        {
            True(UpdatePolicy.ShouldCheck(null, now), "Missing update timestamp was not due.");
            True(!UpdatePolicy.ShouldCheck(now, now.AddHours(23).AddMinutes(59)), "23:59 update timestamp was due.");
            True(UpdatePolicy.ShouldCheck(now, now.AddHours(24)), "24-hour update timestamp was not due.");
            True(!UpdatePolicy.ShouldCheck(now, now.AddMinutes(-1)), "Clock rollback caused an update.");

            var failedRunner = new UpdateProcessRunner(_ => throw new InvalidOperationException("offline"));
            await new UpdatePolicy(tools, statePath, failedRunner, () => now).CheckAsync(CancellationToken.None);
            Equal(1, failedRunner.Calls.Count);
            Equal(Path.Combine(tools, "yt-dlp.exe"), failedRunner.Calls[0].Executable);
            Equal("--ignore-config", failedRunner.Calls[0].Arguments[0]);
            Equal("-U", failedRunner.Calls[0].Arguments[1]);
            True(failedRunner.Calls[0].OnOutput is null, "Updater unexpectedly installed an output callback.");

            using (var state = JsonDocument.Parse(await File.ReadAllTextAsync(statePath)))
                Equal(now, state.RootElement.GetProperty("lastCheckUtc").GetDateTimeOffset());

            var earlyRunner = new UpdateProcessRunner(_ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, string.Empty, string.Empty)));
            await new UpdatePolicy(tools, statePath, earlyRunner, () => now.AddHours(23).AddMinutes(59)).CheckAsync(CancellationToken.None);
            Equal(0, earlyRunner.Calls.Count);

            var dueRunner = new UpdateProcessRunner(_ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(1, string.Empty, "network error")));
            await new UpdatePolicy(tools, statePath, dueRunner, () => now.AddHours(24)).CheckAsync(CancellationToken.None);
            Equal(1, dueRunner.Calls.Count);

            var backwardsRunner = new UpdateProcessRunner(_ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, string.Empty, string.Empty)));
            await new UpdatePolicy(tools, statePath, backwardsRunner, () => now).CheckAsync(CancellationToken.None);
            Equal(0, backwardsRunner.Calls.Count);

            await File.WriteAllTextAsync(statePath, "{ corrupt");
            var corruptRunner = new UpdateProcessRunner(_ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, string.Empty, string.Empty)));
            await new UpdatePolicy(tools, statePath, corruptRunner, () => now).CheckAsync(CancellationToken.None);
            Equal(1, corruptRunner.Calls.Count);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
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

    private static readonly HashSet<string> AllowedServerTypes =
        ["ready", "formats", "jobStarted", "jobProgress", "jobCompleted", "jobCancelled", "jobFailed"];

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

    private sealed class FakeYouTubeService : IYouTubeService
    {
        public int ListCallCount { get; private set; }
        public int StartCallCount { get; private set; }
        public int CancelCallCount { get; private set; }
        public Exception? ListError { get; init; }
        public JobSnapshot? Snapshot { get; set; }
        public Func<string, string, int, Func<JobProgress, Task>, CancellationToken, Task<JobResult>>? StartHandler { get; set; }

        public Task<FormatCatalog> ListFormatsAsync(string url, CancellationToken cancellationToken)
        {
            ListCallCount++;
            if (ListError is not null) throw ListError;
            return Task.FromResult(new FormatCatalog(
                "jNQXAC9IVRw",
                "Me at the zoo",
                19,
                [new QualityOption(1080, "1080p", "MP4", false), new QualityOption(720, "720p", "MP4", false)]));
        }

        public Task<JobResult> StartDownloadAsync(string jobId, string url, int height, Func<JobProgress, Task> onProgress, CancellationToken cancellationToken)
        {
            StartCallCount++;
            return StartHandler?.Invoke(jobId, url, height, onProgress, cancellationToken)
                ?? Task.FromResult(new JobResult(jobId, @"C:\Downloads\Video Radar\video.mp4"));
        }

        public Task CancelAsync(string jobId)
        {
            CancelCallCount++;
            return Task.CompletedTask;
        }

        public JobSnapshot? GetJob() => Snapshot;
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
