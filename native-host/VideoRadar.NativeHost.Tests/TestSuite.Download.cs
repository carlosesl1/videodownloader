using System.Diagnostics;
using System.Text;
using System.Text.Json;
using VideoRadar.NativeHost.Files;
using VideoRadar.NativeHost.Media;
using VideoRadar.NativeHost.Processes;
using VideoRadar.NativeHost.Windows;
using VideoRadar.NativeHost.YouTube;
using NativeProcessResult = VideoRadar.NativeHost.Processes.ProcessResult;

namespace VideoRadar.NativeHost.Tests;

internal static partial class TestSuite
{
    private static void DownloadTests()
    {
        DownloadArgumentsAreExactAndHardened();
        DownloadArgumentsRejectUnsafeHeights();
        DownloadArgumentsRejectUnsafeInputs();
        DownloadPathsReserveUniqueSafeStems();
        DownloadPathsConfineJobDirectoriesAndFinalFiles();
        DownloadFileMoverMovesWithoutOverwrite();
        DownloadFileMoverRejectsUnsafeStagingPaths();
        DownloadFileMoverRejectsReparsePoints();
        DownloadFileMoverCopiesAcrossVolumesBeforeDeletingSource();
        DownloadFileMoverPreservesSourceWhenCopyFails();
        DownloadFileMoverKeepsDeliveredFileWhenSourceCleanupFails();
        DownloadFileMoverReplaysCommittedOperations();
        DownloadFileMoverNamespacesAndWaitsForDeliveryLocks();
        DownloadFileMoverRejectsCrossOperationSources();
        DownloadFileMoverRecoversOnlyMatchingPreparedDeliveries();
        DownloadFileMoverAuthenticatesRecoveryWithoutTheSource();
        DownloadFileMoverMigratesLegacyJournalsOnlyWithTheSource();
        YouTubeServiceUsesPerJobDestination();
        YouTubeServiceRejectsUnavailableDestinationVolume();
        ProgressParserNormalizesKnownMessages();
        ProgressParserRejectsMalformedMessages();
        YouTubeServiceDownloadsWithHostOwnedPathsAndProgress();
        YouTubeServiceValidatesFinalMediaBeforeCompletion();
        YouTubeServiceRejectsAndRemovesInvalidFinalMedia();
        YouTubeServiceRecoversAfterMoveWithTheOriginalStem();
        YouTubeServiceRecoversWhenFfprobeWasInterrupted();
        YouTubeServiceRecoversAfterValidationBeforeQueueCommit();
        YouTubeServiceReplacesOnlyInvalidManifestOwnedOutputs();
        YouTubeServiceNeverAdoptsOrDeletesReplacedManifestOutputs();
        YouTubeServiceRequiresTheSelectedSubtitleKind();
        YouTubeServiceReusesInstagramMetadataForDownload();
        YouTubeServiceRefreshesExpiredInstagramMetadataBeforeDownload();
        YouTubeServiceRetriesInstagramAccessDeniedWithFreshMetadata();
        YouTubeServiceDoesNotRetryOtherInstagramFailures();
        YouTubeServiceRejectsInvalidFinalPathsAndSafeFailures();
        YouTubeServiceClassifiesDownloadFailuresSafely();
        YouTubeServiceSerializesAndCancelsTheActiveJob();
        YouTubeServicePausePreservesAndDiscardRemovesPartials();
        ProcessRunnerClosesChildStandardInput();
        ProcessRunnerBoundsCapturedOutputAndOversizedLines();
        ProcessRunnerCancellationKillsTheChildTree();
        ProcessRunnerHardTimeoutKillsTheChildTree();
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
            "--ignore-config", "--no-config-locations", "--no-update", "--no-playlist",
            "--no-plugin-dirs", "--no-remote-components", "--no-js-runtimes",
            "--js-runtimes", $"deno:{Path.Combine(tools, "deno.exe")}",
            "--ffmpeg-location", tools,
            "--socket-timeout", "30", "--retries", "5", "--fragment-retries", "5",
            "--extractor-retries", "3", "--file-access-retries", "3",
            "--retry-sleep", "http:exp=1:10:2", "--retry-sleep", "fragment:exp=1:10:2",
            "--retry-sleep", "extractor:exp=1:10:2", "--retry-sleep", "file_access:linear=1:3:1",
            "--abort-on-error", "--abort-on-unavailable-fragments",
            "--windows-filenames", "--trim-filenames", "180", "--no-overwrites",
            "--paths", home, "--paths", $"temp:{temp}",
            "--output", $"{stem}.%(ext)s",
            "--format", "b[height=1080][ext=mp4]/bv*[height=1080][ext=mp4]+ba[ext=m4a]/b[height=1080]/bv*[height=1080]+ba",
            "--merge-output-format", "mp4/webm",
            "--newline", "--progress", "--progress-delta", "1",
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
                YtDlpArguments.Download(
                    @"C:\video-radar-tools",
                    @"C:\Users\Alice\Downloads\Video Radar",
                    @"C:\Users\Alice\AppData\Local\VideoRadar\temp\job",
                    "stem",
                    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                    height));
        }
    }

    private static void DownloadArgumentsRejectUnsafeInputs()
    {
        var tools = @"C:\video-radar-tools";
        var home = @"C:\Users\Alice\Downloads\Video Radar";
        var temp = @"C:\Users\Alice\AppData\Local\VideoRadar\temp\job";
        var canonical = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

        Throws<ArgumentException>(() => YtDlpArguments.Download(" ", home, temp, "stem", canonical, 720));
        Throws<ArgumentException>(() => YtDlpArguments.Download(tools, "home", temp, "stem", canonical, 720));
        Throws<ArgumentException>(() => YtDlpArguments.Download(tools, home, "temp", "stem", canonical, 720));
        Throws<ArgumentException>(() => YtDlpArguments.Download(tools, home, temp, @"..\outside", canonical, 720));
        Throws<ArgumentException>(() => YtDlpArguments.Download(tools, home, temp, "bad:name", canonical, 720));
        Throws<ArgumentException>(() => YtDlpArguments.Download(
            tools,
            home,
            temp,
            "stem",
            "https://youtu.be/jNQXAC9IVRw",
            720));
        Throws<ArgumentException>(() => YtDlpArguments.Metadata(
            tools,
            "https://youtu.be/jNQXAC9IVRw"));
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

    private static void DownloadFileMoverReplaysCommittedOperations()
    {
        using var scope = new DownloadTestScope();
        const string operationId = "op_idempotent";
        var source = scope.CreateStagingFile(operationId, "aula.ts", "bytes");
        var destination = scope.CreateDestination("idempotent-target");
        var transfer = new RecordingFileTransfer(sameVolume: true);
        var mover = new DownloadFileMover(
            transfer,
            new ExplorerFileRevealer(),
            Path.Combine(scope.Root, "journal"));

        var first = mover.Move(source, destination, 10, operationId);
        var replay = mover.Move(source, destination, 10, operationId);

        Equal(first, replay);
        Equal(Path.Combine(destination, "aula.ts"), replay.FinalPath);
        Equal("bytes", File.ReadAllText(replay.FinalPath));
        True(!File.Exists(source), "Committed operation replay recreated or retained staging.");
        True(transfer.Operations.SequenceEqual(["move"]), "Committed replay delivered the file twice.");
    }

    private static void DownloadFileMoverNamespacesAndWaitsForDeliveryLocks()
    {
        using var scope = new DownloadTestScope();
        var journalRoot = Path.Combine(scope.Root, "journal");
        var firstSource = scope.CreateStagingFile("delivery", "aula.ts", "first");
        var secondSource = scope.CreateStagingFile("op_waiting", "aula.ts", "second");
        var firstDestination = scope.CreateDestination("first-lock-target");
        var secondDestination = scope.CreateDestination("second-lock-target");
        using var copyStarted = new ManualResetEventSlim();
        using var releaseCopy = new ManualResetEventSlim();
        var blockingTransfer = new RecordingFileTransfer(sameVolume: false)
        {
            CopyStartedSignal = copyStarted,
            CopyReleaseSignal = releaseCopy
        };
        var firstMover = new DownloadFileMover(
            blockingTransfer,
            new ExplorerFileRevealer(),
            journalRoot);
        var secondMover = new DownloadFileMover(
            new RecordingFileTransfer(sameVolume: true),
            new ExplorerFileRevealer(),
            journalRoot);

        var first = Task.Run(() => firstMover.Move(
            firstSource,
            firstDestination,
            20,
            "delivery"));
        Task<FileMoveResult>? second = null;
        try
        {
            True(copyStarted.Wait(TimeSpan.FromSeconds(5)), "The first delivery never acquired its global lock.");
            second = Task.Run(() => secondMover.Move(
                secondSource,
                secondDestination,
                21,
                "op_waiting"));

            Thread.Sleep(TimeSpan.FromMilliseconds(1_200));
            True(!second.IsCompleted, "A concurrent delivery did not wait for the long-running global lock.");
        }
        finally
        {
            releaseCopy.Set();
        }

        True(
            second is not null && Task.WaitAll([first, second], TimeSpan.FromSeconds(10)),
            "Delivery lock wait did not complete.");
        Equal("first", File.ReadAllText(first.Result.FinalPath));
        Equal("second", File.ReadAllText(second!.Result.FinalPath));
    }

    private static void DownloadFileMoverRejectsCrossOperationSources()
    {
        using var scope = new DownloadTestScope();
        var source = scope.CreateStagingFile("op_owner", "aula.ts", "keep");
        var destination = scope.CreateDestination("operation-owner-target");
        var transfer = new RecordingFileTransfer(sameVolume: true);
        var mover = new DownloadFileMover(
            transfer,
            new ExplorerFileRevealer(),
            Path.Combine(scope.Root, "journal"));

        Throws<ArgumentException>(() => mover.Move(source, destination, 11, "op_other"));

        True(File.Exists(source), "Cross-operation rejection removed the staging source.");
        Equal(0, transfer.Operations.Count);
    }

    private static void DownloadFileMoverRecoversOnlyMatchingPreparedDeliveries()
    {
        using (var scope = new DownloadTestScope())
        {
            const string operationId = "op_recover";
            var source = scope.CreateStagingFile(operationId, "aula.ts", "bytes");
            var destination = scope.CreateDestination("recover-target");
            var transfer = new RecordingFileTransfer(sameVolume: false)
            {
                PromoteErrorAfterMove = new IOException("controlled crash after promotion")
            };
            var mover = new DownloadFileMover(
                transfer,
                new ExplorerFileRevealer(),
                Path.Combine(scope.Root, "journal"));

            Throws<IOException>(() => mover.Move(source, destination, 12, operationId));
            True(File.Exists(source), "Interrupted prepared delivery removed the recovery source.");
            True(File.Exists(Path.Combine(destination, "aula.ts")), "Promotion did not create the recoverable destination.");

            transfer.PromoteErrorAfterMove = null;
            var recovered = mover.Move(source, destination, 12, operationId);

            Equal(Path.Combine(destination, "aula.ts"), recovered.FinalPath);
            True(!File.Exists(source), "Matching prepared delivery did not clean the staging source.");
            True(
                transfer.Operations.SequenceEqual(["copy", "promote", "delete-partial", "delete-source"]),
                "Prepared recovery performed a duplicate delivery.");
        }

        using (var scope = new DownloadTestScope())
        {
            const string operationId = "op_collision";
            var source = scope.CreateStagingFile(operationId, "aula.ts", "good");
            var destination = scope.CreateDestination("collision-target");
            var transfer = new RecordingFileTransfer(sameVolume: false)
            {
                PromoteErrorAfterMove = new IOException("controlled crash after promotion")
            };
            var mover = new DownloadFileMover(
                transfer,
                new ExplorerFileRevealer(),
                Path.Combine(scope.Root, "journal"));

            Throws<IOException>(() => mover.Move(source, destination, 13, operationId));
            File.WriteAllText(Path.Combine(destination, "aula.ts"), "evil");
            transfer.PromoteErrorAfterMove = null;

            Throws<IOException>(() => mover.Move(source, destination, 13, operationId));
            True(File.Exists(source), "Conflicting recovery deleted the staging source.");
            Equal("good", File.ReadAllText(source));
        }
    }

    private static void DownloadFileMoverAuthenticatesRecoveryWithoutTheSource()
    {
        using var scope = new DownloadTestScope();
        const string operationId = "op_hash_recovery";
        var source = scope.CreateStagingFile(operationId, "aula.ts", "good");
        var destination = scope.CreateDestination("hash-recovery-target");
        var journalRoot = Path.Combine(scope.Root, "journal");
        var mover = new DownloadFileMover(
            new RecordingFileTransfer(sameVolume: true),
            new ExplorerFileRevealer(),
            journalRoot);

        var delivered = mover.Move(source, destination, 22, operationId);
        True(!File.Exists(source), "The committed source should be absent for hash-only recovery.");
        File.WriteAllText(delivered.FinalPath, "evil");

        Throws<IOException>(() => mover.Move(source, destination, 22, operationId));
        Equal("evil", File.ReadAllText(delivered.FinalPath));

        using var journal = JsonDocument.Parse(File.ReadAllText(Path.Combine(journalRoot, $"{operationId}.json")));
        var digest = journal.RootElement.GetProperty("sourceSha256").GetString();
        True(
            digest is { Length: 64 } && digest.All(Uri.IsHexDigit),
            "The move journal did not persist a SHA-256 source digest.");
    }

    private static void DownloadFileMoverMigratesLegacyJournalsOnlyWithTheSource()
    {
        using (var scope = new DownloadTestScope())
        {
            const string operationId = "op_legacy_migrate";
            var source = scope.CreateStagingFile(operationId, "aula.ts", "legacy");
            var destination = scope.CreateDestination("legacy-migrate-target");
            var finalPath = Path.Combine(destination, "aula.ts");
            var journalRoot = Directory.CreateDirectory(Path.Combine(scope.Root, "journal")).FullName;
            var journalPath = Path.Combine(journalRoot, $"{operationId}.json");
            File.WriteAllText(journalPath, JsonSerializer.Serialize(new
            {
                operationId,
                downloadId = 23,
                sourcePath = source,
                destinationFolder = destination,
                finalPath,
                sourceLength = new FileInfo(source).Length,
                state = "prepared",
                updatedAt = DateTimeOffset.UtcNow
            }));
            var mover = new DownloadFileMover(
                new RecordingFileTransfer(sameVolume: true),
                new ExplorerFileRevealer(),
                journalRoot);

            var migrated = mover.Move(source, destination, 23, operationId);

            Equal(finalPath, migrated.FinalPath);
            using var journal = JsonDocument.Parse(File.ReadAllText(journalPath));
            Equal(64, journal.RootElement.GetProperty("sourceSha256").GetString()!.Length);
        }

        using (var scope = new DownloadTestScope())
        {
            const string operationId = "op_legacy_unverifiable";
            var source = scope.CreateStagingFile(operationId, "aula.ts", "legacy");
            var destination = scope.CreateDestination("legacy-unverifiable-target");
            var finalPath = Path.Combine(destination, "aula.ts");
            File.Move(source, finalPath);
            var journalRoot = Directory.CreateDirectory(Path.Combine(scope.Root, "journal")).FullName;
            File.WriteAllText(Path.Combine(journalRoot, $"{operationId}.json"), JsonSerializer.Serialize(new
            {
                operationId,
                downloadId = 24,
                sourcePath = source,
                destinationFolder = destination,
                finalPath,
                sourceLength = new FileInfo(finalPath).Length,
                state = "committed",
                updatedAt = DateTimeOffset.UtcNow
            }));
            var mover = new DownloadFileMover(
                new RecordingFileTransfer(sameVolume: true),
                new ExplorerFileRevealer(),
                journalRoot);

            Throws<IOException>(() => mover.Move(source, destination, 24, operationId));
            Equal("legacy", File.ReadAllText(finalPath));
        }
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
        var pathsIndex = runner.Calls[1].Arguments.ToList().IndexOf("--paths");
        Equal(Path.GetFullPath(destination), runner.Calls[1].Arguments[pathsIndex + 1]);
        True(!File.Exists(Path.Combine(fallback, Path.GetFileName(expectedPath))),
            "YouTube wrote the per-job download to the fallback folder.");
    }

    private static void YouTubeServiceValidatesFinalMediaBeforeCompletion()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var expectedPath = Path.Combine(paths.Home, "Me at the zoo [jNQXAC9IVRw].mp4");
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, ReadFixture(), string.Empty)),
            async call =>
            {
                File.WriteAllBytes(expectedPath, new byte[19_000]);
                await call.OnOutput!($"VR_FILE:{JsonSerializer.Serialize(expectedPath)}");
                return new NativeProcessResult(0, string.Empty, string.Empty);
            });
        var validator = new RecordingMediaFileValidator();
        var service = new YouTubeService(
            "tools",
            runner,
            new SinglePathsFactory(paths),
            validator);

        var result = service.StartDownloadAsync(
            "validated-job",
            "https://youtu.be/jNQXAC9IVRw",
            1080,
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult();

        Equal(expectedPath, result.Path);
        Equal(1, validator.CallCount);
        Equal(expectedPath, validator.Path);
        True(validator.Request!.ExpectVideo, "Video validation did not require a video stream.");
        True(validator.Request.ExpectAudio, "Video validation did not require an audio stream.");
        Equal(19d, validator.Request.ExpectedDurationSeconds);
        Equal(4_608_000L, validator.Request.EstimatedSizeBytes);
        Equal("complete", service.GetJob()!.Stage);
    }

    private static void YouTubeServiceRejectsAndRemovesInvalidFinalMedia()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var expectedPath = Path.Combine(paths.Home, "Me at the zoo [jNQXAC9IVRw].mp4");
        var subtitlePath = Path.Combine(paths.Home, "Me at the zoo [jNQXAC9IVRw].pt-BR.vtt");
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, ReadFixture(), string.Empty)),
            async call =>
            {
                File.WriteAllText(expectedPath, "invalid");
                File.WriteAllText(subtitlePath, "invalid subtitle sidecar");
                await call.OnOutput!($"VR_FILE:{JsonSerializer.Serialize(expectedPath)}");
                return new NativeProcessResult(0, string.Empty, string.Empty);
            });
        var validator = new RecordingMediaFileValidator { Failure = new MediaValidationException() };
        var service = new YouTubeService(
            "tools",
            runner,
            new SinglePathsFactory(paths),
            validator);

        try
        {
            service.StartDownloadAsync(
                "invalid-media-job",
                "https://youtu.be/jNQXAC9IVRw",
                new DownloadSelection(
                    1080,
                    AudioOnly: false,
                    SubtitleLanguage: "pt-BR",
                    IncludeAutomaticSubtitles: false),
                null,
                new DownloadRunOptions(),
                _ => Task.CompletedTask,
                CancellationToken.None).GetAwaiter().GetResult();
        }
        catch (MediaDownloadException exception)
        {
            Equal("MEDIA_VALIDATION_FAILED", exception.Code);
            Equal("MEDIA_VALIDATION_FAILED", service.GetJob()!.ErrorCode);
            True(!File.Exists(expectedPath), "A final file rejected by ffprobe was left as a successful-looking download.");
            True(!File.Exists(subtitlePath), "A sidecar from rejected media was left behind.");
            True(!exception.Message.Contains(expectedPath, StringComparison.OrdinalIgnoreCase), "Validation error leaked the final path.");
            return;
        }

        throw new InvalidOperationException("Invalid final media was accepted.");
    }

    private static void YouTubeServiceRecoversAfterMoveWithTheOriginalStem()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        const string jobId = "recover-after-move";
        var originalStem = "Me at the zoo [jNQXAC9IVRw]";
        var expectedPath = Path.Combine(paths.Home, $"{originalStem}.mp4");
        var firstRunner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, ReadFixture(), string.Empty)),
            async call =>
            {
                File.WriteAllBytes(expectedPath, new byte[19_000]);
                await call.OnOutput!($"VR_FILE:{JsonSerializer.Serialize(expectedPath)}");
                throw new OperationCanceledException("simulated process crash after after_move");
            });
        var first = new YouTubeService(
            "tools",
            firstRunner,
            new SinglePathsFactory(paths),
            new RecordingMediaFileValidator());

        Throws<OperationCanceledException>(() => first.StartDownloadAsync(
            jobId,
            "https://youtu.be/jNQXAC9IVRw",
            DownloadSelection.Video(1080),
            null,
            new DownloadRunOptions(
                ResumePartial: false,
                PreservePartialOnCancellation: true,
                DurableOutputIdentity: true),
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult());

        var jobTemp = Path.Combine(paths.TempRoot, jobId);
        True(File.Exists(Path.Combine(jobTemp, "output-manifest.json")),
            "The output manifest did not survive an after_move crash.");
        True(File.Exists(expectedPath), "The recoverable final output was removed after after_move.");

        var renamedMetadata = ReadFixture().Replace(
            "\"title\": \"Me at the zoo\"",
            "\"title\": \"Title changed after restart\"",
            StringComparison.Ordinal);
        var recoveryRunner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, renamedMetadata, string.Empty)));
        var validator = new RecordingMediaFileValidator();
        var recovery = new YouTubeService(
            "tools",
            recoveryRunner,
            new SinglePathsFactory(paths),
            validator);

        var result = recovery.StartDownloadAsync(
            jobId,
            "https://youtu.be/jNQXAC9IVRw",
            DownloadSelection.Video(1080),
            null,
            new DownloadRunOptions(ResumePartial: true, DurableOutputIdentity: true),
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult();

        Equal(expectedPath, result.Path);
        Equal(1, recoveryRunner.Calls.Count);
        Equal(1, validator.CallCount);
        True(!File.Exists(Path.Combine(paths.Home, "Title changed after restart [jNQXAC9IVRw].mp4")),
            "A metadata title change replaced the durable output identity.");
        recovery.CommitCompletedAsync(jobId, null, result.Path).GetAwaiter().GetResult();
        True(!Directory.Exists(jobTemp), "The committed manifest was not released.");
        recovery.CommitCompletedAsync(jobId, null, result.Path).GetAwaiter().GetResult();
        True(!Directory.Exists(jobTemp), "An idempotent commit recreated an empty job directory.");
    }

    private static void YouTubeServiceRecoversWhenFfprobeWasInterrupted()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        const string jobId = "recover-during-ffprobe";
        var expectedPath = Path.Combine(paths.Home, "Me at the zoo [jNQXAC9IVRw].mp4");
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, ReadFixture(), string.Empty)),
            async call =>
            {
                File.WriteAllBytes(expectedPath, new byte[19_000]);
                await call.OnOutput!($"VR_FILE:{JsonSerializer.Serialize(expectedPath)}");
                return new NativeProcessResult(0, string.Empty, string.Empty);
            });
        var interruptedValidator = new RecordingMediaFileValidator
        {
            Failure = new OperationCanceledException("simulated crash during ffprobe")
        };
        var first = new YouTubeService(
            "tools",
            runner,
            new SinglePathsFactory(paths),
            interruptedValidator);

        Throws<OperationCanceledException>(() => first.StartDownloadAsync(
            jobId,
            "https://youtu.be/jNQXAC9IVRw",
            DownloadSelection.Video(1080),
            null,
            new DownloadRunOptions(
                PreservePartialOnCancellation: true,
                DurableOutputIdentity: true),
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult());

        var recoveryRunner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, ReadFixture(), string.Empty)));
        var recoveryValidator = new RecordingMediaFileValidator();
        var recovery = new YouTubeService(
            "tools",
            recoveryRunner,
            new SinglePathsFactory(paths),
            recoveryValidator);
        var result = recovery.StartDownloadAsync(
            jobId,
            "https://youtu.be/jNQXAC9IVRw",
            DownloadSelection.Video(1080),
            null,
            new DownloadRunOptions(ResumePartial: true, DurableOutputIdentity: true),
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult();

        Equal(expectedPath, result.Path);
        Equal(1, recoveryRunner.Calls.Count);
        Equal(1, recoveryValidator.CallCount);
        recovery.CommitCompletedAsync(jobId, null, result.Path).GetAwaiter().GetResult();
    }

    private static void YouTubeServiceRecoversAfterValidationBeforeQueueCommit()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        const string jobId = "recover-after-validation";
        var expectedPath = Path.Combine(paths.Home, "Me at the zoo [jNQXAC9IVRw].mp4");
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, ReadFixture(), string.Empty)),
            async call =>
            {
                File.WriteAllBytes(expectedPath, new byte[19_000]);
                await call.OnOutput!($"VR_FILE:{JsonSerializer.Serialize(expectedPath)}");
                return new NativeProcessResult(0, string.Empty, string.Empty);
            });
        var firstValidator = new RecordingMediaFileValidator();
        var first = new YouTubeService(
            "tools",
            runner,
            new SinglePathsFactory(paths),
            firstValidator);
        var firstResult = first.StartDownloadAsync(
            jobId,
            "https://youtu.be/jNQXAC9IVRw",
            DownloadSelection.Video(1080),
            null,
            new DownloadRunOptions(DurableOutputIdentity: true),
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult();

        Equal(expectedPath, firstResult.Path);
        Equal(1, firstValidator.CallCount);
        True(File.Exists(Path.Combine(paths.TempRoot, jobId, "output-manifest.json")),
            "Validation removed the manifest before the queue commit.");

        var recoveryRunner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, ReadFixture(), string.Empty)));
        var recoveryValidator = new RecordingMediaFileValidator();
        var recovery = new YouTubeService(
            "tools",
            recoveryRunner,
            new SinglePathsFactory(paths),
            recoveryValidator);
        var recovered = recovery.StartDownloadAsync(
            jobId,
            "https://youtu.be/jNQXAC9IVRw",
            DownloadSelection.Video(1080),
            null,
            new DownloadRunOptions(ResumePartial: true, DurableOutputIdentity: true),
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult();

        Equal(firstResult.Path, recovered.Path);
        Equal(1, recoveryRunner.Calls.Count);
        Equal(1, recoveryValidator.CallCount);
        recovery.CommitCompletedAsync(jobId, null, recovered.Path).GetAwaiter().GetResult();
    }

    private static void YouTubeServiceReplacesOnlyInvalidManifestOwnedOutputs()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        const string jobId = "recover-invalid-output";
        var stem = "Me at the zoo [jNQXAC9IVRw]";
        var expectedPath = Path.Combine(paths.Home, $"{stem}.mp4");
        var userFile = Path.Combine(paths.Home, $"{stem}.notes.txt");
        var firstRunner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, ReadFixture(), string.Empty)),
            async call =>
            {
                File.WriteAllText(expectedPath, "invalid owned output");
                File.WriteAllText(userFile, "user data");
                await call.OnOutput!($"VR_FILE:{JsonSerializer.Serialize(expectedPath)}");
                throw new OperationCanceledException("simulated crash before validation");
            });
        var first = new YouTubeService(
            "tools",
            firstRunner,
            new SinglePathsFactory(paths),
            new RecordingMediaFileValidator());
        Throws<OperationCanceledException>(() => first.StartDownloadAsync(
            jobId,
            "https://youtu.be/jNQXAC9IVRw",
            DownloadSelection.Video(1080),
            null,
            new DownloadRunOptions(
                PreservePartialOnCancellation: true,
                DurableOutputIdentity: true),
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult());

        var recoveryRunner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, ReadFixture(), string.Empty)),
            async call =>
            {
                True(!File.Exists(expectedPath), "The invalid owned output was not removed before retry.");
                True(File.Exists(userFile), "A non-manifest user file was removed during recovery.");
                var outputIndex = call.Arguments.ToList().IndexOf("--output");
                Equal($"{stem}.%(ext)s", call.Arguments[outputIndex + 1]);
                File.WriteAllBytes(expectedPath, new byte[19_000]);
                await call.OnOutput!($"VR_FILE:{JsonSerializer.Serialize(expectedPath)}");
                return new NativeProcessResult(0, string.Empty, string.Empty);
            });
        var validator = new ScriptedMediaFileValidator(
            (_, _, _) => throw new MediaValidationException(),
            (path, _, _) => Task.FromResult(
                new MediaValidationResult("mov,mp4", 19, new FileInfo(path).Length, 1, 1)));
        var recovery = new YouTubeService(
            "tools",
            recoveryRunner,
            new SinglePathsFactory(paths),
            validator);
        var result = recovery.StartDownloadAsync(
            jobId,
            "https://youtu.be/jNQXAC9IVRw",
            DownloadSelection.Video(1080),
            null,
            new DownloadRunOptions(ResumePartial: true, DurableOutputIdentity: true),
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult();

        Equal(expectedPath, result.Path);
        Equal(2, validator.CallCount);
        Equal("user data", File.ReadAllText(userFile));
        recovery.CommitCompletedAsync(jobId, null, result.Path).GetAwaiter().GetResult();
    }

    private static void YouTubeServiceNeverAdoptsOrDeletesReplacedManifestOutputs()
    {
        VerifyReplacedManifestOutputIsPreserved("invalid", Encoding.UTF8.GetBytes("foreign file"));
        var plausibleMedia = Enumerable.Repeat((byte)0x5a, 19_000).ToArray();
        VerifyReplacedManifestOutputIsPreserved("valid", plausibleMedia);
    }

    private static void VerifyReplacedManifestOutputIsPreserved(
        string suffix,
        byte[] replacement)
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var jobId = $"replaced-output-{suffix}";
        var expectedPath = Path.Combine(paths.Home, "Me at the zoo [jNQXAC9IVRw].mp4");
        var original = Enumerable.Repeat((byte)0x11, 19_000).ToArray();
        var firstRunner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, ReadFixture(), string.Empty)),
            async call =>
            {
                File.WriteAllBytes(expectedPath, original);
                await call.OnOutput!($"VR_FILE:{JsonSerializer.Serialize(expectedPath)}");
                throw new OperationCanceledException("simulated crash after after_move");
            });
        var first = new YouTubeService(
            "tools",
            firstRunner,
            new SinglePathsFactory(paths),
            new RecordingMediaFileValidator());
        Throws<OperationCanceledException>(() => first.StartDownloadAsync(
            jobId,
            "https://youtu.be/jNQXAC9IVRw",
            DownloadSelection.Video(1080),
            null,
            new DownloadRunOptions(DurableOutputIdentity: true),
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult());

        File.WriteAllBytes(expectedPath, replacement);
        var validator = new RecordingMediaFileValidator();
        var recoveryRunner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, ReadFixture(), string.Empty)));
        var recovery = new YouTubeService(
            "tools",
            recoveryRunner,
            new SinglePathsFactory(paths),
            validator);
        MediaDownloadException? failure = null;
        try
        {
            _ = recovery.StartDownloadAsync(
                jobId,
                "https://youtu.be/jNQXAC9IVRw",
                DownloadSelection.Video(1080),
                null,
                new DownloadRunOptions(ResumePartial: true, DurableOutputIdentity: true),
                _ => Task.CompletedTask,
                CancellationToken.None).GetAwaiter().GetResult();
        }
        catch (MediaDownloadException exception)
        {
            failure = exception;
        }

        Equal("OUTPUT_OWNERSHIP_MISMATCH", failure?.Code);
        Equal(1, recoveryRunner.Calls.Count);
        Equal(0, validator.CallCount);
        True(File.ReadAllBytes(expectedPath).SequenceEqual(replacement),
            $"The {suffix} same-name replacement was adopted or modified.");

        recovery.DiscardPartialAsync(jobId, null).GetAwaiter().GetResult();
        True(File.ReadAllBytes(expectedPath).SequenceEqual(replacement),
            $"Discard deleted the {suffix} same-name replacement.");
        True(!Directory.Exists(Path.Combine(paths.TempRoot, jobId)),
            "Discard did not release the mismatched durable identity.");
    }

    private static void YouTubeServiceRequiresTheSelectedSubtitleKind()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, ReadFixture(), string.Empty)));
        var service = new YouTubeService(
            "tools",
            runner,
            new SinglePathsFactory(paths));

        Throws<InvalidDataException>(() => service.StartDownloadAsync(
            "subtitle-kind-job",
            "https://youtu.be/jNQXAC9IVRw",
            new DownloadSelection(
                720,
                SubtitleLanguage: "pt-BR",
                IncludeAutomaticSubtitles: true),
            null,
            new DownloadRunOptions(),
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult());
        Equal(1, runner.Calls.Count);
    }

    private static void YouTubeServiceRejectsUnavailableDestinationVolume()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(
                0,
                ReadFixture(),
                string.Empty)));
        var probe = new FixedVolumeSpaceProbe(VolumeSpaceStatus.Unavailable);
        var service = new YouTubeService(
            "tools",
            runner,
            new SinglePathsFactory(paths),
            TimeProvider.System,
            probe);

        try
        {
            service.StartDownloadAsync(
                "job-unavailable-volume",
                "https://youtu.be/jNQXAC9IVRw",
                720,
                _ => Task.CompletedTask,
                CancellationToken.None).GetAwaiter().GetResult();
        }
        catch (MediaDownloadException exception)
        {
            Equal("STORAGE_UNAVAILABLE", exception.Code);
            Equal("STORAGE_UNAVAILABLE", service.GetJob()!.ErrorCode);
            Equal(1, runner.Calls.Count);
            True(probe.CallCount > 0, "The destination volume was not checked.");
            True(
                !exception.Message.Contains(paths.Home, StringComparison.OrdinalIgnoreCase),
                "The unavailable-volume error leaked the destination path.");
            return;
        }

        throw new InvalidOperationException("An unavailable destination volume was accepted.");
    }

    private static void YouTubeServiceReusesInstagramMetadataForDownload()
    {
        const string instagramUrl = "https://www.instagram.com/reel/C8x_example/";
        const string metadata = """
            {"id":"C8x_example","title":"Video by video.radar","extractor_key":"Instagram","formats":[
              {"format_id":"http-960","url":"https://cdn.test/reel.mp4","height":960,"vcodec":"avc1.64001f","acodec":"mp4a.40.2","ext":"mp4"}
            ]}
            """;
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var expectedPath = Path.Combine(paths.Home, "Video by video.radar [C8x_example].mp4");
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, metadata, string.Empty)),
            async call =>
            {
                var loadIndex = call.Arguments.ToList().IndexOf("--load-info-json");
                True(loadIndex >= 0, "Instagram download did not reuse its metadata.");
                var metadataPath = call.Arguments[loadIndex + 1];
                Equal(
                    Path.Combine(paths.TempRoot, "instagram-job", "media.info.json"),
                    Path.GetFullPath(metadataPath));
                Equal(metadata, File.ReadAllText(metadataPath));
                True(!call.Arguments.Contains(instagramUrl), "Instagram download queried the post a second time.");

                File.WriteAllText(expectedPath, "video");
                await call.OnOutput!($"VR_FILE:{JsonSerializer.Serialize(expectedPath)}");
                return new VideoRadar.NativeHost.Processes.ProcessResult(0, string.Empty, string.Empty);
            });
        var service = new YouTubeService("tools", runner, paths);

        var result = service.StartDownloadAsync(
            "instagram-job",
            instagramUrl,
            960,
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult();

        Equal(expectedPath, result.Path);
        Equal(2, runner.Calls.Count);
    }

    private static void YouTubeServiceRefreshesExpiredInstagramMetadataBeforeDownload()
    {
        const string instagramUrl = "https://www.instagram.com/reel/C8x_example/";
        const string staleMetadata = """
            {"id":"C8x_example","title":"Public Reel","extractor_key":"Instagram","formats":[
              {"format_id":"stale","url":"https://cdn.test/stale.mp4","height":720,"vcodec":"avc1","acodec":"mp4a","ext":"mp4"}
            ]}
            """;
        const string freshMetadata = """
            {"id":"C8x_example","title":"Public Reel","extractor_key":"Instagram","formats":[
              {"format_id":"fresh","url":"https://cdn.test/fresh.mp4","height":720,"vcodec":"avc1","acodec":"mp4a","ext":"mp4"}
            ]}
            """;
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var expectedPath = Path.Combine(paths.Home, "Public Reel [C8x_example].mp4");
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, staleMetadata, string.Empty)),
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, freshMetadata, string.Empty)),
            async call =>
            {
                var metadataPath = call.Arguments[call.Arguments.ToList().IndexOf("--load-info-json") + 1];
                Equal(freshMetadata, File.ReadAllText(metadataPath));
                File.WriteAllText(expectedPath, "video");
                await call.OnOutput!($"VR_FILE:{JsonSerializer.Serialize(expectedPath)}");
                return new VideoRadar.NativeHost.Processes.ProcessResult(0, string.Empty, string.Empty);
            });
        var time = new ManualTimeProvider(new DateTimeOffset(2026, 7, 29, 0, 0, 0, TimeSpan.Zero));
        var service = new YouTubeService(
            "tools",
            runner,
            new SinglePathsFactory(paths),
            time);

        service.ListFormatsAsync(instagramUrl, CancellationToken.None).GetAwaiter().GetResult();
        time.Advance(TimeSpan.FromMinutes(5));
        var result = service.StartDownloadAsync(
            "expired-instagram",
            instagramUrl,
            720,
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult();

        Equal(expectedPath, result.Path);
        Equal(3, runner.Calls.Count);
    }

    private static void YouTubeServiceRetriesInstagramAccessDeniedWithFreshMetadata()
    {
        const string instagramUrl = "https://www.instagram.com/reel/C8x_example/";
        const string staleMetadata = """
            {"id":"C8x_example","title":"Public Reel","extractor_key":"Instagram","formats":[
              {"format_id":"stale","url":"https://cdn.test/stale.mp4","height":720,"vcodec":"avc1","acodec":"mp4a","ext":"mp4"}
            ]}
            """;
        const string freshMetadata = """
            {"id":"C8x_example","title":"Public Reel","extractor_key":"Instagram","formats":[
              {"format_id":"fresh","url":"https://cdn.test/fresh.mp4","height":720,"vcodec":"avc1","acodec":"mp4a","ext":"mp4"}
            ]}
            """;
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var temp = Path.Combine(paths.TempRoot, "retry-instagram");
        var marker = Path.Combine(temp, "stale.part");
        var expectedPath = Path.Combine(paths.Home, "Public Reel [C8x_example].mp4");
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, staleMetadata, string.Empty)),
            call =>
            {
                var metadataPath = call.Arguments[call.Arguments.ToList().IndexOf("--load-info-json") + 1];
                Equal(staleMetadata, File.ReadAllText(metadataPath));
                File.WriteAllText(marker, "partial");
                return Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(
                    1,
                    string.Empty,
                    "ERROR: unable to download video data: HTTP Error 403: Forbidden"));
            },
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, freshMetadata, string.Empty)),
            async call =>
            {
                var metadataPath = call.Arguments[call.Arguments.ToList().IndexOf("--load-info-json") + 1];
                Equal(freshMetadata, File.ReadAllText(metadataPath));
                True(!File.Exists(marker), "Retry retained a partial file from the denied attempt.");
                File.WriteAllText(expectedPath, "video");
                await call.OnOutput!($"VR_FILE:{JsonSerializer.Serialize(expectedPath)}");
                return new VideoRadar.NativeHost.Processes.ProcessResult(0, string.Empty, string.Empty);
            });
        var service = new YouTubeService("tools", runner, paths);

        var result = service.StartDownloadAsync(
            "retry-instagram",
            instagramUrl,
            720,
            _ => Task.CompletedTask,
            CancellationToken.None).GetAwaiter().GetResult();

        Equal(expectedPath, result.Path);
        Equal(4, runner.Calls.Count);
        Equal("complete", service.GetJob()!.Stage);
        True(!Directory.Exists(temp), "Successful retry temp was not cleaned.");
    }

    private static void YouTubeServiceDoesNotRetryOtherInstagramFailures()
    {
        const string instagramUrl = "https://www.instagram.com/reel/C8x_example/";
        const string metadata = """
            {"id":"C8x_example","title":"Public Reel","extractor_key":"Instagram","formats":[
              {"height":720,"vcodec":"avc1","acodec":"mp4a","ext":"mp4"}
            ]}
            """;
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, metadata, string.Empty)),
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(
                1,
                string.Empty,
                "ERROR: Login required. Use --cookies-from-browser.")));
        var service = new YouTubeService("tools", runner, paths);

        try
        {
            service.StartDownloadAsync(
                "login-instagram",
                instagramUrl,
                720,
                _ => Task.CompletedTask,
                CancellationToken.None).GetAwaiter().GetResult();
        }
        catch (MediaDownloadException exception)
        {
            Equal("LOGIN_REQUIRED", exception.Code);
            Equal(2, runner.Calls.Count);
            return;
        }

        throw new InvalidOperationException("Instagram login failure should not be retried.");
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
            Equal("MEDIA_DOWNLOAD_FAILED", failureService.GetJob()!.ErrorCode);
            return;
        }

        throw new InvalidOperationException("Non-zero download exit should fail.");
    }

    private static void YouTubeServiceClassifiesDownloadFailuresSafely()
    {
        var cases = new[]
        {
            ("login", "ERROR: Login required. Use --cookies-from-browser.", "LOGIN_REQUIRED"),
            ("rate", "ERROR: HTTP Error 429: Too Many Requests", "RATE_LIMITED"),
            ("format", "ERROR: Requested format is not available", "FORMAT_UNAVAILABLE"),
            ("access", "ERROR: unable to download video data: HTTP Error 403: Forbidden", "MEDIA_ACCESS_DENIED"),
            ("no-video", "ERROR: There is no video in this post; only images are available", "NO_VIDEO"),
            ("unknown", "ERROR: private diagnostic secret https://sensitive.example/video", "MEDIA_DOWNLOAD_FAILED")
        };

        foreach (var (jobId, standardError, expectedCode) in cases)
        {
            using var scope = new DownloadTestScope();
            var paths = scope.CreatePaths();
            var runner = new ScriptedProcessRunner(
                _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, ReadFixture(), string.Empty)),
                _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(1, string.Empty, standardError)));
            var service = new YouTubeService("tools", runner, paths);

            try
            {
                service.StartDownloadAsync(
                    jobId,
                    "https://youtu.be/jNQXAC9IVRw",
                    1080,
                    _ => Task.CompletedTask,
                    CancellationToken.None).GetAwaiter().GetResult();
            }
            catch (MediaDownloadException exception)
            {
                Equal(expectedCode, exception.Code);
                Equal(expectedCode, service.GetJob()!.ErrorCode);
                True(!exception.Message.Contains("secret", StringComparison.OrdinalIgnoreCase), "Raw stderr leaked into the safe error.");
                True(!exception.Message.Contains("sensitive.example", StringComparison.OrdinalIgnoreCase), "A sensitive URL leaked into the safe error.");
                continue;
            }

            throw new InvalidOperationException($"Download failure '{jobId}' was not classified.");
        }
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

    private static void YouTubeServicePausePreservesAndDiscardRemovesPartials()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var downloadStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var partialPath = Path.Combine(paths.TempRoot, "paused-job", "media.part");
        var runner = new ScriptedProcessRunner(
            _ => Task.FromResult(new NativeProcessResult(0, ReadFixture(), string.Empty)),
            async call =>
            {
                File.WriteAllText(partialPath, "partial");
                downloadStarted.TrySetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, call.CancellationToken);
                throw new InvalidOperationException("Unreachable paused download continuation.");
            });
        var factory = new SinglePathsFactory(paths);
        var service = new YouTubeService("tools", runner, factory);

        var active = service.StartDownloadAsync(
            "paused-job",
            "https://youtu.be/jNQXAC9IVRw",
            DownloadSelection.Video(1080),
            null,
            new DownloadRunOptions(),
            _ => Task.CompletedTask,
            CancellationToken.None);
        True(downloadStarted.Task.Wait(TimeSpan.FromSeconds(5)), "Download did not reach its resumable partial.");

        service.PauseAsync("paused-job").GetAwaiter().GetResult();
        Throws<OperationCanceledException>(() => active.GetAwaiter().GetResult());
        True(File.Exists(partialPath), "Pause deleted the resumable partial.");

        service.DiscardPartialAsync("paused-job", null).GetAwaiter().GetResult();
        True(!Directory.Exists(Path.Combine(paths.TempRoot, "paused-job")), "Explicit discard left paused partials behind.");
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

    private static void ProcessRunnerHardTimeoutKillsTheChildTree()
    {
        if (!OperatingSystem.IsWindows()) return;

        const string script = "$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru; Write-Output $child.Id; Wait-Process -Id $child.Id";
        var childPid = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new VideoRadar.NativeHost.Processes.ProcessRunner(TimeSpan.FromSeconds(3));
        var run = runner.RunAsync(
            "powershell.exe",
            ["-NoProfile", "-Command", script],
            line =>
            {
                if (int.TryParse(line, out var pid)) childPid.TrySetResult(pid);
                return Task.CompletedTask;
            },
            CancellationToken.None);

        True(childPid.Task.Wait(TimeSpan.FromSeconds(10)), "Controlled child process did not start before the timeout.");
        var pid = childPid.Task.GetAwaiter().GetResult();
        Throws<TimeoutException>(() => run.GetAwaiter().GetResult());
        True(SpinWait.SpinUntil(() => !IsProcessRunning(pid), TimeSpan.FromSeconds(5)), "Hard timeout did not kill the child process tree.");
    }

    private static void ProcessRunnerBoundsCapturedOutputAndOversizedLines()
    {
        if (!OperatingSystem.IsWindows()) return;

        const string script = "[Console]::Out.WriteLine('ok'); [Console]::Out.WriteLine(('X' * 40)); [Console]::Out.Write('last'); [Console]::Error.Write(('B' * 80))";
        var lines = new List<string>();
        var runner = new VideoRadar.NativeHost.Processes.ProcessRunner(
            TimeSpan.FromSeconds(10),
            maximumStandardOutputChars: 32,
            maximumStandardErrorChars: 24,
            maximumOutputLineChars: 16);

        var result = runner.RunAsync(
            "powershell.exe",
            ["-NoProfile", "-Command", script],
            line =>
            {
                lines.Add(line);
                return Task.CompletedTask;
            },
            CancellationToken.None).GetAwaiter().GetResult();

        Equal(0, result.ExitCode);
        Equal(32, result.StandardOutput.Length);
        Equal(24, result.StandardError.Length);
        True(result.StandardOutputTruncated, "Oversized stdout was not marked as truncated.");
        True(result.StandardErrorTruncated, "Oversized stderr was not marked as truncated.");
        True(result.StandardError.All(character => character == 'B'), "Bounded stderr did not retain its diagnostic tail.");
        True(lines.SequenceEqual(["ok", "last"]), "An oversized output line reached the callback or valid lines were lost.");
    }

    private static void ProcessRunnerClosesChildStandardInput()
    {
        if (!OperatingSystem.IsWindows()) return;

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo(Environment.ProcessPath!)
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
        };
        process.StartInfo.ArgumentList.Add("--process-runner-stdin-probe");
        process.Start();

        var exited = process.WaitForExitAsync().Wait(TimeSpan.FromSeconds(3));
        if (!exited)
        {
            process.StandardInput.Close();
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
        }

        True(exited, "ProcessRunner leaked the Native Messaging input pipe to its child.");
        Equal(0, process.ExitCode);
        Equal("EOF", process.StandardOutput.ReadToEnd().Trim());
        Equal(string.Empty, process.StandardError.ReadToEnd());
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

    private sealed class SinglePathsFactory(IDownloadPaths paths) : IDownloadPathsFactory
    {
        public IDownloadPaths Create(string? destinationFolder)
        {
            True(destinationFolder is null, "The single-path test factory received an unexpected destination.");
            return paths;
        }
    }

    private sealed class RecordingMediaFileValidator : IMediaFileValidator
    {
        public int CallCount { get; private set; }
        public string? Path { get; private set; }
        public MediaValidationRequest? Request { get; private set; }
        public Exception? Failure { get; init; }

        public Task<MediaValidationResult> ValidateAsync(
            string path,
            MediaValidationRequest request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CallCount++;
            Path = path;
            Request = request;
            if (Failure is not null) throw Failure;
            return Task.FromResult(new MediaValidationResult("mov,mp4", 19, 19_000, 1, 1));
        }
    }

    private sealed class ScriptedMediaFileValidator(
        params Func<string, MediaValidationRequest, CancellationToken, Task<MediaValidationResult>>[] handlers)
        : IMediaFileValidator
    {
        private readonly Queue<Func<string, MediaValidationRequest, CancellationToken, Task<MediaValidationResult>>>
            handlers = new(handlers);

        public int CallCount { get; private set; }

        public Task<MediaValidationResult> ValidateAsync(
            string path,
            MediaValidationRequest request,
            CancellationToken cancellationToken)
        {
            CallCount++;
            if (handlers.Count == 0) throw new InvalidOperationException("Unexpected media validation.");
            return handlers.Dequeue()(path, request, cancellationToken);
        }
    }

    private sealed class RecordingFileTransfer(bool sameVolume) : IFileTransfer
    {
        public List<string> Operations { get; } = [];
        public HashSet<string> ReparsePaths { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Exception? CopyError { get; init; }
        public Exception? DeleteSourceError { get; init; }
        public Exception? PromoteErrorAfterMove { get; set; }
        public ManualResetEventSlim? CopyStartedSignal { get; init; }
        public ManualResetEventSlim? CopyReleaseSignal { get; init; }

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
            CopyStartedSignal?.Set();
            CopyReleaseSignal?.Wait();
            File.Copy(source, partial, overwrite: false);
            if (CopyError is not null) throw CopyError;
        }

        public void PromotePartial(string partial, string destination)
        {
            Operations.Add("promote");
            File.Move(partial, destination, overwrite: false);
            if (PromoteErrorAfterMove is not null) throw PromoteErrorAfterMove;
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

    private sealed class FixedVolumeSpaceProbe(VolumeSpaceStatus status) : IVolumeSpaceProbe
    {
        public int CallCount { get; private set; }

        public VolumeSpaceStatus Check(string volumeRoot, long requiredBytes)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(volumeRoot);
            True(requiredBytes > 0, "The volume probe received an invalid requirement.");
            CallCount++;
            return status;
        }
    }
}
