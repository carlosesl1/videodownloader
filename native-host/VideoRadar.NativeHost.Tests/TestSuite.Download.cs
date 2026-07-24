using System.Diagnostics;
using System.Text.Json;
using VideoRadar.NativeHost.Files;
using VideoRadar.NativeHost.Processes;
using VideoRadar.NativeHost.YouTube;

namespace VideoRadar.NativeHost.Tests;

internal static partial class TestSuite
{
    private static void DownloadTests()
    {
        DownloadArgumentsAreExactAndHardened();
        DownloadArgumentsRejectUnsafeHeights();
        DownloadPathsReserveUniqueSafeStems();
        DownloadPathsConfineJobDirectoriesAndFinalFiles();
        DownloadFileMoverMovesWithoutOverwrite();
        DownloadFileMoverRejectsUnsafeStagingPaths();
        DownloadFileMoverRejectsReparsePoints();
        DownloadFileMoverCopiesAcrossVolumesBeforeDeletingSource();
        DownloadFileMoverPreservesSourceWhenCopyFails();
        DownloadFileMoverKeepsDeliveredFileWhenSourceCleanupFails();
        YouTubeServiceUsesPerJobDestination();
        ProgressParserNormalizesKnownMessages();
        ProgressParserRejectsMalformedMessages();
        YouTubeServiceDownloadsWithHostOwnedPathsAndProgress();
        YouTubeServiceRejectsInvalidFinalPathsAndSafeFailures();
        YouTubeServiceSerializesAndCancelsTheActiveJob();
        ProcessRunnerCancellationKillsTheChildTree();
    }

    private static void DownloadArgumentsAreExactAndHardened()
    {
        var tools = @"C:\video-radar-tools";
        var home = @"C:\Users\Alice\Downloads\Video Radar";
        var temp = @"C:\Users\Alice\AppData\Local\VideoRadar\temp\job-1";
        var stem = "Me at the zoo [jNQXAC9IVRw]";
        var canonicalUrl = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
        var arguments = YtDlpArguments.Download(tools, home, temp, stem, canonicalUrl, 1080);
        var expected = new[]
        {
            "--ignore-config", "--no-playlist", "--no-plugin-dirs", "--no-remote-components",
            "--js-runtimes", $"deno:{Path.Combine(tools, "deno.exe")}",
            "--ffmpeg-location", tools,
            "--windows-filenames", "--trim-filenames", "180", "--no-overwrites",
            "--paths", home, "--paths", $"temp:{temp}",
            "--output", $"{stem}.%(ext)s",
            "--format", "b[height=1080][ext=mp4]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/bv*[height<=1080]+ba",
            "--merge-output-format", "mp4/webm",
            "--newline", "--progress", "--progress-delta", "0.5",
            "--progress-template", "download:VR_PROGRESS:{\"progress\":%(progress)j,\"vcodec\":%(info.vcodec)j,\"acodec\":%(info.acodec)j}",
            "--progress-template", "postprocess:VR_POSTPROCESS:%(progress)j",
            "--print", "after_move:VR_FILE:%(filepath)j",
            canonicalUrl
        };

        Equal(expected.Length, arguments.Count);
        for (var index = 0; index < expected.Length; index++) Equal(expected[index], arguments[index]);

        var forbidden = new[] { "cookie", "cookies-from-browser", "username", "password", "netrc", "browser-profile" };
        foreach (var value in forbidden)
            True(!arguments.Any(argument => argument.Contains(value, StringComparison.OrdinalIgnoreCase)), $"Forbidden yt-dlp option present: {value}");
    }

    private static void DownloadArgumentsRejectUnsafeHeights()
    {
        foreach (var height in new[] { int.MinValue, 0, 143, 4321, int.MaxValue })
        {
            Throws<ArgumentOutOfRangeException>(() =>
                YtDlpArguments.Download("tools", "home", "temp", "stem", "https://www.youtube.com/watch?v=jNQXAC9IVRw", height));
        }
    }

    private static void DownloadPathsReserveUniqueSafeStems()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();

        var first = paths.ReserveStem("Me at the zoo", "jNQXAC9IVRw");
        Equal("Me at the zoo [jNQXAC9IVRw]", first);
        File.WriteAllText(Path.Combine(paths.Home, $"{first}.mp4"), "existing");

        var second = paths.ReserveStem("Me at the zoo", "jNQXAC9IVRw");
        var third = paths.ReserveStem("Me at the zoo", "jNQXAC9IVRw");
        Equal($"{first} (2)", second);
        Equal($"{first} (3)", third);

        var unsafeStem = paths.ReserveStem(@"..\CON<>:\/|?*", @"..\..\NUL");
        Equal(unsafeStem, Path.GetFileName(unsafeStem));
        True(!unsafeStem.Contains("..", StringComparison.Ordinal), "Traversal survived stem sanitization.");
        True(unsafeStem.Length is > 0 and <= 180, "Sanitized stem length is unsafe.");
        True(!unsafeStem.Any(character => Path.GetInvalidFileNameChars().Contains(character)), "Invalid filename character survived sanitization.");
        True(!IsReservedWindowsName(unsafeStem), "Reserved Windows filename survived sanitization.");

        var reusable = paths.ReserveStem("Reusable", "jNQXAC9IVRw");
        paths.ReleaseStem(reusable);
        Equal(reusable, paths.ReserveStem("Reusable", "jNQXAC9IVRw"));
    }

    private static void DownloadPathsConfineJobDirectoriesAndFinalFiles()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var jobTemp = paths.CreateJobTemp("job_1-safe");

        Equal(Path.Combine(paths.TempRoot, "job_1-safe"), jobTemp);
        True(Directory.Exists(jobTemp), "Job temp directory was not created.");
        foreach (var unsafeJobId in new[] { "", ".", "..", "../outside", @"..\outside", "has space", new string('a', 129) })
            Throws<ArgumentException>(() => paths.CreateJobTemp(unsafeJobId));

        var outsideDirectory = Path.Combine(scope.Root, "outside");
        Directory.CreateDirectory(outsideDirectory);
        File.WriteAllText(Path.Combine(outsideDirectory, "keep.txt"), "keep");
        Throws<ArgumentException>(() => paths.DeleteJobTemp("../outside"));
        True(File.Exists(Path.Combine(outsideDirectory, "keep.txt")), "Unsafe temp deletion escaped TempRoot.");

        paths.DeleteJobTemp("job_1-safe");
        True(!Directory.Exists(jobTemp), "Job temp directory was not deleted.");

        var finalPath = Path.Combine(paths.Home, "video.mp4");
        File.WriteAllText(finalPath, "video");
        True(paths.ContainsFinalPath(finalPath), "Real final file under Home was rejected.");
        True(!paths.ContainsFinalPath(paths.Home), "Home directory itself was accepted as a final file.");
        True(!paths.ContainsFinalPath("video.mp4"), "Relative final path was accepted.");
        True(!paths.ContainsFinalPath(Path.Combine(paths.Home, "nested", "..", "video.mp4")), "Traversal final path was accepted.");

        var confusingHome = $"{paths.Home} evil";
        Directory.CreateDirectory(confusingHome);
        var confusingPath = Path.Combine(confusingHome, "video.mp4");
        File.WriteAllText(confusingPath, "outside");
        True(!paths.ContainsFinalPath(confusingPath), "Home prefix confusion was accepted.");
        True(!paths.ContainsFinalPath(Path.Combine(scope.Root, "outside", "keep.txt")), "File from another root was accepted.");
    }

    private static void DownloadFileMoverMovesWithoutOverwrite()
    {
        using var scope = new DownloadTestScope();
        var source = scope.CreateStagingFile("op_1", "aula.ts", "new");
        var destination = scope.CreateDestination();
        File.WriteAllText(Path.Combine(destination, "aula.ts"), "old");
        var mover = new DownloadFileMover();

        var result = mover.Move(source, destination, 42);

        Equal(42L, result.DownloadId);
        Equal(Path.Combine(destination, "aula (1).ts"), result.FinalPath);
        Equal("old", File.ReadAllText(Path.Combine(destination, "aula.ts")));
        Equal("new", File.ReadAllText(result.FinalPath));
        True(!File.Exists(source), "Successful move left the staging file.");
    }

    private static void DownloadFileMoverRejectsUnsafeStagingPaths()
    {
        using var scope = new DownloadTestScope();
        var mover = new DownloadFileMover();
        var destination = scope.CreateDestination();

        var outside = Path.Combine(scope.Root, "outside.ts");
        File.WriteAllText(outside, "keep");
        Throws<ArgumentException>(() => mover.Move(outside, destination, 1));
        True(File.Exists(outside), "Rejected source outside staging was removed.");

        var canonical = scope.CreateStagingFile("op_traversal", "traversal.ts", "keep");
        var traversal = Path.Combine(
            Path.GetDirectoryName(canonical)!,
            "..",
            "op_traversal",
            Path.GetFileName(canonical));
        Throws<ArgumentException>(() => mover.Move(traversal, destination, 2));
        True(File.Exists(canonical), "Traversal rejection removed the source.");

        var invalidOperation = scope.CreateStagingFile("bad operation", "unsafe.ts", "keep");
        Throws<ArgumentException>(() => mover.Move(invalidOperation, destination, 3));
        True(File.Exists(invalidOperation), "Invalid operation rejection removed the source.");

        var valid = scope.CreateStagingFile("op_negative", "negative.ts", "keep");
        Throws<ArgumentOutOfRangeException>(() => mover.Move(valid, destination, -1));
        True(File.Exists(valid), "Invalid download id removed the source.");

        Throws<ArgumentException>(() => mover.Move(valid, "relative", 4));
        True(File.Exists(valid), "Invalid destination removed the source.");
    }

    private static void DownloadFileMoverRejectsReparsePoints()
    {
        using var scope = new DownloadTestScope();
        var source = scope.CreateStagingFile("op_reparse", "aula.ts", "keep");
        var transfer = new RecordingFileTransfer(sameVolume: true);
        transfer.ReparsePaths.Add(Path.GetDirectoryName(Path.GetDirectoryName(source))!);
        var mover = new DownloadFileMover(transfer);

        Throws<ArgumentException>(() => mover.Move(source, scope.CreateDestination(), 5));

        True(File.Exists(source), "Reparse-point rejection removed the source.");
        Equal(0, transfer.Operations.Count);
    }

    private static void DownloadFileMoverCopiesAcrossVolumesBeforeDeletingSource()
    {
        using var scope = new DownloadTestScope();
        var source = scope.CreateStagingFile("op_2", "aula.ts", "bytes");
        var destination = scope.CreateDestination("other-volume");
        var transfer = new RecordingFileTransfer(sameVolume: false);
        var mover = new DownloadFileMover(transfer);

        var result = mover.Move(source, destination, 7);

        True(
            transfer.Operations.SequenceEqual(["copy", "promote", "delete-source"]),
            "Cross-volume delivery used an unsafe order.");
        Equal(Path.Combine(destination, "aula.ts"), result.FinalPath);
        Equal("bytes", File.ReadAllText(result.FinalPath));
        True(!File.Exists(source), "Source was not removed after promotion.");
    }

    private static void DownloadFileMoverPreservesSourceWhenCopyFails()
    {
        using var scope = new DownloadTestScope();
        var source = scope.CreateStagingFile("op_3", "aula.ts", "bytes");
        var destination = scope.CreateDestination("failing-volume");
        var transfer = new RecordingFileTransfer(sameVolume: false)
        {
            CopyError = new IOException("controlled copy failure")
        };
        var mover = new DownloadFileMover(transfer);

        Throws<IOException>(() => mover.Move(source, destination, 8));

        True(File.Exists(source), "Failed cross-volume copy removed the source.");
        Equal("bytes", File.ReadAllText(source));
        True(
            transfer.Operations.SequenceEqual(["copy", "delete-partial"]),
            "Failed copy did not clean only the partial file.");
        Equal(0, Directory.EnumerateFiles(destination).Count());
    }

    private static void DownloadFileMoverKeepsDeliveredFileWhenSourceCleanupFails()
    {
        using var scope = new DownloadTestScope();
        var source = scope.CreateStagingFile("op_4", "aula.ts", "bytes");
        var destination = scope.CreateDestination("cleanup-failure");
        var transfer = new RecordingFileTransfer(sameVolume: false)
        {
            DeleteSourceError = new IOException("controlled cleanup failure")
        };
        var mover = new DownloadFileMover(transfer);

        var result = mover.Move(source, destination, 9);

        True(
            transfer.Operations.SequenceEqual(["copy", "promote", "delete-source"]),
            "Cleanup failure changed the safe delivery order.");
        Equal("bytes", File.ReadAllText(result.FinalPath));
        True(File.Exists(source), "Cleanup failure should leave the staging copy for later maintenance.");
    }

    private static void ProgressParserNormalizesKnownMessages()
    {
        var line = "VR_PROGRESS:{\"progress\":{\"status\":\"downloading\",\"downloaded_bytes\":50,\"total_bytes\":100,\"speed\":25.75,\"eta\":2},\"vcodec\":\"avc1\",\"acodec\":\"none\"}";
        True(ProgressParser.TryParse(line, out var progress), "progress not parsed");
        Equal("video", progress!.Stage);
        Equal(50, progress.Percent);
        Equal(50L, progress.DownloadedBytes);
        Equal(100L, progress.TotalBytes);
        Equal(25L, progress.SpeedBytesPerSecond);
        Equal(2, progress.EtaSeconds);

        True(ProgressParser.TryParse("VR_PROGRESS:{\"progress\":{\"downloaded_bytes\":150,\"total_bytes\":100},\"vcodec\":\"none\",\"acodec\":\"mp4a\"}", out var audio), "audio progress not parsed");
        Equal("audio", audio!.Stage);
        Equal(100, audio.Percent);

        True(ProgressParser.TryParse("VR_PROGRESS:{\"progress\":{\"downloaded_bytes\":5,\"total_bytes\":0},\"vcodec\":\"avc1\",\"acodec\":\"mp4a\"}", out var unknown), "unknown-total progress not parsed");
        Equal("download", unknown!.Stage);
        Equal<int?>(null, unknown.Percent);
        Equal<long?>(null, unknown.TotalBytes);

        True(ProgressParser.TryParse("VR_POSTPROCESS:{\"status\":\"started\"}", out var merge), "postprocess not parsed");
        Equal("merge", merge!.Stage);
        True(ProgressParser.TryParse("VR_FILE:\"C:\\\\Downloads\\\\Video Radar\\\\file.mp4\"", out var file), "file not parsed");
        Equal("finalize", file!.Stage);
        Equal(@"C:\Downloads\Video Radar\file.mp4", file.Path);
    }

    private static void ProgressParserRejectsMalformedMessages()
    {
        foreach (var line in new[]
        {
            "", "ordinary output", "VR_UNKNOWN:{}", "VR_PROGRESS:", "VR_PROGRESS:not-json", "VR_PROGRESS:[]",
            "VR_PROGRESS:{\"progress\":null}", "VR_PROGRESS:{\"progress\":{\"downloaded_bytes\":1e100,\"total_bytes\":2}}",
            "VR_POSTPROCESS:not-json", "VR_POSTPROCESS:[]", "VR_FILE:null", "VR_FILE:{}", "VR_FILE:\"\""
        })
        {
            True(!ProgressParser.TryParse(line, out var progress), $"Malformed progress was accepted: {line}");
            Equal<JobProgress?>(null, progress);
        }
    }

    private static void YouTubeServiceDownloadsWithHostOwnedPathsAndProgress()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var expectedStem = "Me at the zoo [jNQXAC9IVRw]";
        var expectedFinalPath = Path.Combine(paths.Home, $"{expectedStem}.mp4");
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, ReadFixture(), string.Empty)),
            async call =>
            {
                File.WriteAllText(expectedFinalPath, "video");
                foreach (var line in new[]
                {
                    "VR_PROGRESS:{\"progress\":{\"downloaded_bytes\":50,\"total_bytes\":100},\"vcodec\":\"avc1\",\"acodec\":\"none\"}",
                    "VR_PROGRESS:{\"progress\":{\"downloaded_bytes\":40,\"total_bytes\":100},\"vcodec\":\"avc1\",\"acodec\":\"none\"}",
                    "VR_PROGRESS:{\"progress\":{\"downloaded_bytes\":25,\"total_bytes\":100},\"vcodec\":\"none\",\"acodec\":\"mp4a\"}",
                    "VR_POSTPROCESS:{\"status\":\"started\"}",
                    "VR_PROGRESS:{\"progress\":{\"downloaded_bytes\":90,\"total_bytes\":100},\"vcodec\":\"avc1\",\"acodec\":\"none\"}",
                    $"VR_FILE:{JsonSerializer.Serialize(expectedFinalPath)}"
                })
                {
                    await call.OnOutput!(line);
                }

                return new VideoRadar.NativeHost.Processes.ProcessResult(0, string.Empty, string.Empty);
            });
        var service = new YouTubeService("tools", runner, paths);
        var progress = new List<JobProgress>();

        var result = service.StartDownloadAsync(
            "job-1",
            "https://youtu.be/jNQXAC9IVRw",
            1080,
            value =>
            {
                progress.Add(value);
                return Task.CompletedTask;
            },
            CancellationToken.None).GetAwaiter().GetResult();

        Equal("job-1", result.JobId);
        Equal(expectedFinalPath, result.Path);
        Equal(2, runner.Calls.Count);
        Equal("https://www.youtube.com/watch?v=jNQXAC9IVRw", runner.Calls[0].Arguments[^1]);
        var expectedDownloadArguments = YtDlpArguments.Download(
            "tools",
            paths.Home,
            Path.Combine(paths.TempRoot, "job-1"),
            expectedStem,
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            1080);
        Equal(expectedDownloadArguments.Count, runner.Calls[1].Arguments.Count);
        for (var index = 0; index < expectedDownloadArguments.Count; index++)
            Equal(expectedDownloadArguments[index], runner.Calls[1].Arguments[index]);

        Equal(4, progress.Count);
        Equal("video", progress[0].Stage);
        Equal(50, progress[0].Percent);
        Equal("audio", progress[1].Stage);
        Equal("merge", progress[2].Stage);
        Equal("finalize", progress[3].Stage);
        Equal(expectedFinalPath, progress[3].Path);

        var snapshot = service.GetJob();
        Equal("job-1", snapshot!.JobId);
        Equal("jNQXAC9IVRw", snapshot.VideoId);
        Equal("Me at the zoo", snapshot.Title);
        Equal("complete", snapshot.Stage);
        Equal(100, snapshot.Percent);
        Equal(expectedFinalPath, snapshot.Path);
        Equal<string?>(null, snapshot.ErrorCode);
        True(!Directory.Exists(Path.Combine(paths.TempRoot, "job-1")), "Successful job temp was not cleaned.");

        File.Delete(expectedFinalPath);
        Equal(expectedStem, paths.ReserveStem("Me at the zoo", "jNQXAC9IVRw"));
    }

    private static void YouTubeServiceUsesPerJobDestination()
    {
        using var scope = new DownloadTestScope();
        var destination = Path.Combine(scope.Root, "chosen");
        var fallback = Path.Combine(scope.Root, "fallback");
        var tempRoot = Path.Combine(scope.Root, "temp-per-job");
        var expectedPath = Path.Combine(destination, "Me at the zoo [jNQXAC9IVRw].mp4");
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, ReadFixture(), string.Empty)),
            async call =>
            {
                Directory.CreateDirectory(destination);
                File.WriteAllText(expectedPath, "video");
                await call.OnOutput!($"VR_FILE:{JsonSerializer.Serialize(expectedPath)}");
                return new VideoRadar.NativeHost.Processes.ProcessResult(0, string.Empty, string.Empty);
            });
        var factory = new DownloadPathsFactory(fallback, tempRoot);
        var service = new YouTubeService("tools", runner, factory);

        var result = service.StartDownloadAsync(
            "job-per-destination",
            "https://youtu.be/jNQXAC9IVRw",
            720,
            destination,
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult();

        Equal(Path.GetFullPath(expectedPath), result.Path);
        Equal(Path.GetFullPath(destination), runner.Calls[1].Arguments[13]);
        True(!File.Exists(Path.Combine(fallback, Path.GetFileName(expectedPath))),
            "YouTube wrote the per-job download to the fallback folder.");
    }

    private static void YouTubeServiceRejectsInvalidFinalPathsAndSafeFailures()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var outsidePath = Path.Combine(scope.Root, "outside.mp4");
        File.WriteAllText(outsidePath, "outside");
        var invalidRunner = new ScriptedProcessRunner(
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, ReadFixture(), string.Empty)),
            async call =>
            {
                await call.OnOutput!($"VR_FILE:{JsonSerializer.Serialize(outsidePath)}");
                return new VideoRadar.NativeHost.Processes.ProcessResult(0, string.Empty, string.Empty);
            });
        var invalidService = new YouTubeService("tools", invalidRunner, paths);
        var emitted = new List<JobProgress>();

        Throws<InvalidOperationException>(() => invalidService.StartDownloadAsync(
            "invalid-path",
            "https://youtu.be/jNQXAC9IVRw",
            1080,
            value =>
            {
                emitted.Add(value);
                return Task.CompletedTask;
            },
            CancellationToken.None).GetAwaiter().GetResult());
        True(!emitted.Any(value => value.Stage == "finalize"), "Untrusted final path was emitted.");
        Equal("invalid_output", invalidService.GetJob()!.ErrorCode);

        var failureRunner = new ScriptedProcessRunner(
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, ReadFixture(), string.Empty)),
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(1, string.Empty, "secret cookie and raw diagnostics")));
        var failureService = new YouTubeService("tools", failureRunner, paths);
        try
        {
            failureService.StartDownloadAsync(
                "failed-job",
                "https://youtu.be/jNQXAC9IVRw",
                1080,
                _ => Task.CompletedTask,
                CancellationToken.None).GetAwaiter().GetResult();
        }
        catch (InvalidOperationException exception)
        {
            True(!exception.Message.Contains("secret cookie", StringComparison.Ordinal), "Raw download stderr leaked into the error.");
            Equal("download_failed", failureService.GetJob()!.ErrorCode);
            return;
        }

        throw new InvalidOperationException("Non-zero download exit should fail.");
    }

    private static void YouTubeServiceSerializesAndCancelsTheActiveJob()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var downloadStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, ReadFixture(), string.Empty)),
            async call =>
            {
                downloadStarted.TrySetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, call.CancellationToken);
                throw new InvalidOperationException("Unreachable download continuation.");
            });
        var service = new YouTubeService("tools", runner, paths);

        var active = service.StartDownloadAsync(
            "active-job",
            "https://youtu.be/jNQXAC9IVRw",
            1080,
            _ => Task.CompletedTask,
            CancellationToken.None);
        True(downloadStarted.Task.Wait(TimeSpan.FromSeconds(5)), "Download did not reach the cancellable runner.");

        Throws<InvalidOperationException>(() => service.StartDownloadAsync(
            "other-job",
            "https://youtu.be/jNQXAC9IVRw",
            1080,
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult());
        Equal(2, runner.Calls.Count);
        Equal("active-job", service.GetJob()!.JobId);

        service.CancelAsync("other-job").GetAwaiter().GetResult();
        True(!active.IsCompleted, "Wrong job id cancelled the active download.");
        service.CancelAsync("active-job").GetAwaiter().GetResult();
        service.CancelAsync("active-job").GetAwaiter().GetResult();
        Throws<OperationCanceledException>(() => active.GetAwaiter().GetResult());
        Equal("cancelled", service.GetJob()!.Stage);
        Equal("cancelled", service.GetJob()!.ErrorCode);
        True(!Directory.Exists(Path.Combine(paths.TempRoot, "active-job")), "Cancelled job temp was not cleaned.");
        Equal("Me at the zoo [jNQXAC9IVRw]", paths.ReserveStem("Me at the zoo", "jNQXAC9IVRw"));

        var invalidRunner = new ScriptedProcessRunner(_ => throw new InvalidOperationException("Runner should not be called."));
        var invalidService = new YouTubeService("tools", invalidRunner, paths);
        Throws<ArgumentException>(() => invalidService.StartDownloadAsync(
            "../unsafe",
            "https://youtu.be/jNQXAC9IVRw",
            1080,
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult());
        Throws<InvalidDataException>(() => invalidService.StartDownloadAsync(
            "safe-job",
            "https://evil.test/watch?v=jNQXAC9IVRw",
            1080,
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult());
        Throws<ArgumentOutOfRangeException>(() => invalidService.StartDownloadAsync(
            "safe-job",
            "https://youtu.be/jNQXAC9IVRw",
            143,
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult());
        Throws<ArgumentNullException>(() => invalidService.StartDownloadAsync(
            "safe-job",
            "https://youtu.be/jNQXAC9IVRw",
            1080,
            null!,
            CancellationToken.None).GetAwaiter().GetResult());
        Equal(0, invalidRunner.Calls.Count);
    }

    private static void ProcessRunnerCancellationKillsTheChildTree()
    {
        if (!OperatingSystem.IsWindows()) return;

        const string script = "$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru; Write-Output $child.Id; Wait-Process -Id $child.Id";
        var childPid = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancellation = new CancellationTokenSource();
        var runner = new VideoRadar.NativeHost.Processes.ProcessRunner();
        var run = runner.RunAsync(
            "powershell.exe",
            ["-NoProfile", "-Command", script],
            line =>
            {
                if (int.TryParse(line, out var pid)) childPid.TrySetResult(pid);
                return Task.CompletedTask;
            },
            cancellation.Token);

        True(childPid.Task.Wait(TimeSpan.FromSeconds(10)), "Controlled child process did not start.");
        var pid = childPid.Task.GetAwaiter().GetResult();
        cancellation.Cancel();
        Throws<OperationCanceledException>(() => run.GetAwaiter().GetResult());
        True(SpinWait.SpinUntil(() => !IsProcessRunning(pid), TimeSpan.FromSeconds(5)), "Cancellation did not kill the child process tree.");
    }

    private static bool IsProcessRunning(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static bool IsReservedWindowsName(string stem)
    {
        var name = stem.Split('.')[0].TrimEnd(' ', '.');
        return name.Equals("CON", StringComparison.OrdinalIgnoreCase)
            || name.Equals("PRN", StringComparison.OrdinalIgnoreCase)
            || name.Equals("AUX", StringComparison.OrdinalIgnoreCase)
            || name.Equals("NUL", StringComparison.OrdinalIgnoreCase)
            || Enumerable.Range(1, 9).Any(index =>
                name.Equals($"COM{index}", StringComparison.OrdinalIgnoreCase)
                || name.Equals($"LPT{index}", StringComparison.OrdinalIgnoreCase));
    }

    private sealed class DownloadTestScope : IDisposable
    {
        public DownloadTestScope()
        {
            Root = Path.Combine(Path.GetTempPath(), "video-radar-download-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Root);
        }

        public string Root { get; }

        public DownloadPaths CreatePaths() => new(Path.Combine(Root, "Video Radar"), Path.Combine(Root, "temp"));

        public string CreateStagingFile(string operationId, string fileName, string contents)
        {
            var directory = Path.Combine(
                Root,
                "Browser Downloads",
                "Video Radar",
                ".staging",
                operationId);
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, fileName);
            File.WriteAllText(path, contents);
            return path;
        }

        public string CreateDestination(string name = "target") =>
            Directory.CreateDirectory(Path.Combine(Root, name)).FullName;

        public void Dispose()
        {
            if (Directory.Exists(Root)) Directory.Delete(Root, recursive: true);
        }
    }

    private sealed record RunnerCall(
        string Executable,
        IReadOnlyList<string> Arguments,
        Func<string, Task>? OnOutput,
        CancellationToken CancellationToken);

    private sealed class ScriptedProcessRunner(params Func<RunnerCall, Task<VideoRadar.NativeHost.Processes.ProcessResult>>[] handlers) : IProcessRunner
    {
        private readonly Queue<Func<RunnerCall, Task<VideoRadar.NativeHost.Processes.ProcessResult>>> handlers = new(handlers);

        public List<RunnerCall> Calls { get; } = [];

        public Task<VideoRadar.NativeHost.Processes.ProcessResult> RunAsync(
            string executable,
            IReadOnlyList<string> arguments,
            Func<string, Task>? onOutput,
            CancellationToken cancellationToken)
        {
            var call = new RunnerCall(executable, arguments.ToArray(), onOutput, cancellationToken);
            Calls.Add(call);
            if (handlers.Count == 0) throw new InvalidOperationException("Unexpected process invocation.");
            return handlers.Dequeue()(call);
        }
    }

    private sealed class RecordingFileTransfer(bool sameVolume) : IFileTransfer
    {
        public List<string> Operations { get; } = [];
        public HashSet<string> ReparsePaths { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Exception? CopyError { get; init; }
        public Exception? DeleteSourceError { get; init; }

        public FileAttributes GetAttributes(string path)
        {
            var attributes = File.GetAttributes(path);
            return ReparsePaths.Contains(path) ? attributes | FileAttributes.ReparsePoint : attributes;
        }

        public bool IsSameVolume(string source, string destination) => sameVolume;

        public void MoveSameVolume(string source, string destination)
        {
            Operations.Add("move");
            File.Move(source, destination, overwrite: false);
        }

        public void CopyToPartial(string source, string partial)
        {
            Operations.Add("copy");
            File.Copy(source, partial, overwrite: false);
            if (CopyError is not null) throw CopyError;
        }

        public void PromotePartial(string partial, string destination)
        {
            Operations.Add("promote");
            File.Move(partial, destination, overwrite: false);
        }

        public void DeleteSource(string source)
        {
            Operations.Add("delete-source");
            if (DeleteSourceError is not null) throw DeleteSourceError;
            File.Delete(source);
        }

        public void DeletePartial(string partial)
        {
            Operations.Add("delete-partial");
            if (File.Exists(partial)) File.Delete(partial);
        }
    }
}
