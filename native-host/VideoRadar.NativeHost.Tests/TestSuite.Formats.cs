using System.Text.Json;
using VideoRadar.NativeHost.Files;
using VideoRadar.NativeHost.Media;
using VideoRadar.NativeHost.Processes;
using VideoRadar.NativeHost.YouTube;
using NativeProcessResult = VideoRadar.NativeHost.Processes.ProcessResult;

namespace VideoRadar.NativeHost.Tests;

internal static partial class TestSuite
{
    private static void FormatCatalogTests()
    {
        FormatCatalogReducesFixtureToDistinctQualities();
        FormatCatalogExposesRichBoundedMetadata();
        FormatCatalogNormalizesPublicTextControls();
        FormatCatalogBoundsProtocolCollections();
        FormatCatalogRejectsUnavailableOrIncompleteMetadata();
        FormatCatalogRejectsMissingPositiveHeights();
        FormatCatalogRequiresAudioForSeparateYouTubeVideo();
        FormatCatalogAcceptsSeparateInstagramVideoWithM4aAudio();
        FormatCatalogAcceptsPublicSocialMetadataWithoutAvailability();
        FormatCatalogFiltersSocialQualitiesToCombinedFormats();
        FormatCatalogFiltersUnsupportedQualityContainers();
        FormatCatalogRejectsExplicitlyRestrictedSocialMetadata();
        MetadataArgumentsAreHardenedAndCanonical();
        DownloadArgumentsUsePlatformSpecificSelectors();
        DownloadArgumentsMergeSeparateInstagramVideoAndM4aAudio();
        DownloadArgumentsSupportAudioSubtitlesAndResumeSafely();
        FfprobeValidatorAcceptsExpectedBoundedMedia();
        FfprobeValidatorRejectsMalformedOrImplausibleMedia();
        YouTubeServiceCanonicalizesBeforeCallingRunner();
        YouTubeServiceAcceptsAllowlistedSocialPages();
        YouTubeServiceCachesSuccessfulCatalogsAndRetriesFailures();
        YouTubeServiceExpiresCatalogsByPlatform();
        YouTubeServiceBoundsCatalogCacheByCountAndBytes();
        YouTubeServiceCancellationDoesNotCancelSharedLookup();
        YouTubeServiceCancelsLookupAfterLastObserverLeaves();
        YouTubeServiceRejectsTruncatedMetadata();
        YouTubeServiceDoesNotRunForInvalidUrl();
        YouTubeServiceDoesNotLeakYtDlpStandardError();
    }

    private static void FormatCatalogReducesFixtureToDistinctQualities()
    {
        var catalog = FormatCatalog.Parse(ReadFixture());

        Equal("jNQXAC9IVRw", catalog.VideoId);
        Equal("Me at the zoo", catalog.Title);
        Equal(19d, catalog.DurationSeconds);
        Equal(3, catalog.Qualities.Count);
        Equal(1080, catalog.Qualities[0].Height);
        Equal(720, catalog.Qualities[1].Height);
        Equal(360, catalog.Qualities[2].Height);
        Equal("MP4", catalog.Qualities[0].Container);
        True(catalog.Qualities[2].Combined, "360p should be a combined stream.");
        Equal("1080p", catalog.Qualities[0].Label);
    }

    private static void FormatCatalogExposesRichBoundedMetadata()
    {
        var catalog = FormatCatalog.Parse(ReadFixture());
        var quality = catalog.Qualities[0];

        Equal(60d, quality.Fps);
        True(!quality.Hdr, "The MP4 selector inherited HDR metadata from an unselected WebM stream.");
        Equal<string?>(null, quality.DynamicRange);
        Equal("avc1.640028", quality.VideoCodec);
        Equal("mp4a.40.2", quality.AudioCodec);
        Equal(4800d, quality.BitrateKbps);
        Equal(4_608_000L, quality.EstimatedSizeBytes);
        True(quality.EstimatedSizeApproximate, "filesize_approx was reported as exact.");

        Equal(6, catalog.Formats.Count);
        var audio = catalog.Formats.Single(format => format.FormatId == "140");
        True(audio.AudioOnly, "The audio-only stream was not identified.");
        Equal("en", audio.Language);
        Equal(128d, audio.BitrateKbps);
        Equal(2, catalog.AudioLanguages.Count);
        True(catalog.AudioLanguages.SequenceEqual(["en", "pt-BR"]), "Audio languages were not normalized and sorted.");

        Equal(2, catalog.Subtitles.Count);
        var manual = catalog.Subtitles.Single(track => track.Language == "pt-BR");
        True(!manual.Automatic, "Manual subtitles were marked automatic.");
        Equal("Português (Brasil)", manual.Label);
        True(manual.Containers.SequenceEqual(["VTT"]), "Subtitle containers changed unexpectedly.");
        True(catalog.Subtitles.Single(track => track.Language == "en").Automatic, "Automatic captions were not exposed.");
    }

    private static void FormatCatalogNormalizesPublicTextControls()
    {
        const string json = """
            {"id":"safe-id","title":"Linha 1\nLinha 2\tfinal","formats":[
              {"height":720,"vcodec":"avc1\nunsafe","acodec":"aac\tunsafe","ext":"mp4"}
            ]}
            """;

        var catalog = FormatCatalog.Parse(json);

        Equal("Linha 1 Linha 2 final", catalog.Title);
        True(!catalog.Title.Any(char.IsControl), "The public title retained control characters.");
        True(catalog.Formats.All(format =>
                format.VideoCodec is null || !format.VideoCodec.Any(char.IsControl)),
            "A public codec retained control characters.");
        True(catalog.Formats.All(format =>
                format.AudioCodec is null || !format.AudioCodec.Any(char.IsControl)),
            "A public audio codec retained control characters.");
    }

    private static void FormatCatalogBoundsProtocolCollections()
    {
        var formats = new List<Dictionary<string, object?>>();
        for (var index = 0; index < 100; index++)
        {
            formats.Add(new Dictionary<string, object?>
            {
                ["format_id"] = $"audio-{index}",
                ["ext"] = "m4a",
                ["vcodec"] = "none",
                ["acodec"] = "aac",
                ["language"] = $"l{index}"
            });
        }
        for (var index = 0; index < 300; index++)
        {
            formats.Add(new Dictionary<string, object?>
            {
                ["format_id"] = $"video-{index}",
                ["ext"] = "mp4",
                ["height"] = 144 + index,
                ["vcodec"] = "h264",
                ["acodec"] = "aac"
            });
        }
        var subtitles = Enumerable.Range(0, 140).ToDictionary(
            index => $"s{index}",
            _ => new[] { new { ext = "vtt", name = "Track" } });
        var json = JsonSerializer.Serialize(new
        {
            id = "bounded-id",
            title = "Bounded metadata",
            formats,
            subtitles
        });

        var catalog = FormatCatalog.Parse(json);

        Equal(32, catalog.Qualities.Count);
        Equal(256, catalog.Formats.Count);
        Equal(64, catalog.AudioLanguages.Count);
        Equal(128, catalog.Subtitles.Count);
    }

    private static void FormatCatalogRejectsUnavailableOrIncompleteMetadata()
    {
        foreach (var json in new[]
        {
            ReadFixture().Replace("\"is_live\": false", "\"is_live\": true", StringComparison.Ordinal),
            ReadFixture().Replace("\"availability\": \"public\"", "\"availability\": \"private\"", StringComparison.Ordinal),
            ReadFixture().Replace("\"id\": \"jNQXAC9IVRw\"", "\"id\": \"\"", StringComparison.Ordinal),
            ReadFixture().Replace("\"title\": \"Me at the zoo\"", "\"title\": \" \"", StringComparison.Ordinal),
            "{\"title\":\"A\",\"is_live\":false,\"availability\":\"public\",\"formats\":[]}",
            "{\"id\":\"jNQXAC9IVRw\",\"is_live\":false,\"availability\":\"public\",\"formats\":[]}",
            "{ not json"
        })
        {
            Throws<InvalidDataException>(() => FormatCatalog.Parse(json));
        }
    }

    private static void FormatCatalogRejectsMissingPositiveHeights()
    {
        const string json = """
            {"id":"jNQXAC9IVRw","title":"A","is_live":false,"availability":"public","formats":[{"height":0,"vcodec":"avc1","acodec":"none","ext":"mp4"}]}
            """;

        Throws<InvalidDataException>(() => FormatCatalog.Parse(json));
    }

    private static void FormatCatalogRequiresAudioForSeparateYouTubeVideo()
    {
        const string json = """
            {"id":"jNQXAC9IVRw","title":"A","is_live":false,"availability":"public","formats":[
              {"height":1080,"vcodec":"avc1","acodec":"none","ext":"mp4"},
              {"height":null,"vcodec":"none","acodec":"opus","ext":"webm"}
            ]}
            """;

        Throws<InvalidDataException>(() => FormatCatalog.Parse(json));
    }

    private static void FormatCatalogAcceptsSeparateInstagramVideoWithM4aAudio()
    {
        const string instagram = """
            {"id":"DbdpUhpg1bx","title":"Public Reel","extractor_key":"Instagram","formats":[
              {"height":null,"vcodec":"none","acodec":"mp4a.40.5","ext":"m4a"},
              {"height":1920,"vcodec":"vp09.00.40.08","acodec":"none","ext":"mp4"}
            ]}
            """;

        var catalog = FormatCatalog.Parse(instagram);

        Equal("instagram", catalog.Platform);
        Equal(1, catalog.Qualities.Count);
        Equal(1920, catalog.Qualities[0].Height);
        Equal("MP4", catalog.Qualities[0].Container);
        True(!catalog.Qualities[0].Combined, "Separate Instagram streams must remain marked for merging.");
    }

    private static void FormatCatalogAcceptsPublicSocialMetadataWithoutAvailability()
    {
        const string instagram = """
            {"id":"C8x_example","title":"Public Reel","extractor_key":"Instagram","is_live":false,"formats":[
              {"height":720,"vcodec":"avc1.64001f","acodec":"mp4a.40.2","ext":"mp4"}
            ]}
            """;

        var catalog = FormatCatalog.Parse(instagram);

        Equal("instagram", catalog.Platform);
        Equal("C8x_example", catalog.VideoId);
        Equal(1, catalog.Qualities.Count);
        Equal("MP4", catalog.Qualities[0].Container);
    }

    private static void FormatCatalogFiltersSocialQualitiesToCombinedFormats()
    {
        const string tiktok = """
            {"id":"social-id","title":"Public TikTok","extractor_key":"TikTok","formats":[
              {"height":1080,"vcodec":"h264","acodec":"none","ext":"mp4"},
              {"height":720,"vcodec":"h264","acodec":"aac","ext":"mp4","tbr":1200},
              {"height":720,"vcodec":"h265","acodec":"aac","ext":"mp4","tbr":2400},
              {"height":480,"vcodec":"vp9","acodec":"opus","ext":"webm"}
            ]}
            """;

        var catalog = FormatCatalog.Parse(tiktok);

        Equal(2, catalog.Qualities.Count);
        Equal(720, catalog.Qualities[0].Height);
        Equal("MP4", catalog.Qualities[0].Container);
        True(catalog.Qualities[0].Combined, "Social qualities must be combined streams.");
        Equal("h264", catalog.Qualities[0].VideoCodec);
        Equal(480, catalog.Qualities[1].Height);
        Equal("WebM", catalog.Qualities[1].Container);
    }

    private static void FormatCatalogFiltersUnsupportedQualityContainers()
    {
        const string json = """
            {"id":"container-id","title":"Container filter","extractor_key":"TikTok","formats":[
              {"height":1080,"vcodec":"h264","acodec":"aac","ext":"3gp"},
              {"height":720,"vcodec":"h264","acodec":"aac","ext":"mp4"},
              {"height":480,"vcodec":"vp9","acodec":"opus","ext":"webm"}
            ]}
            """;

        var catalog = FormatCatalog.Parse(json);

        Equal(2, catalog.Qualities.Count);
        True(catalog.Qualities.All(quality => quality.Container is "MP4" or "WEBM" or "WebM"),
            "A quality container outside the Native Messaging contract was exposed.");
    }

    private static void FormatCatalogRejectsExplicitlyRestrictedSocialMetadata()
    {
        foreach (var availability in new[] { "private", "subscriber_only", "premium_only", "needs_auth" })
        {
            var json = $$"""
                {"id":"social-id","title":"Restricted","extractor_key":"TikTok","availability":"{{availability}}","formats":[
                  {"height":720,"vcodec":"h264","acodec":"aac","ext":"mp4"}
                ]}
                """;
            Throws<InvalidDataException>(() => FormatCatalog.Parse(json));
        }
    }

    private static void MetadataArgumentsAreHardenedAndCanonical()
    {
        var tools = @"C:\video-radar-tools";
        var canonical = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
        var arguments = YtDlpArguments.Metadata(tools, canonical);
        var expected = new[]
        {
            "--ignore-config", "--no-config-locations", "--no-update", "--no-playlist",
            "--no-plugin-dirs", "--no-remote-components", "--no-js-runtimes",
            "--js-runtimes", $"deno:{Path.Combine(tools, "deno.exe")}",
            "--ffmpeg-location", tools,
            "--socket-timeout", "30", "--retries", "5", "--extractor-retries", "3",
            "--retry-sleep", "http:exp=1:10:2", "--retry-sleep", "extractor:exp=1:10:2",
            "--dump-single-json", "--skip-download", "--no-warnings", canonical
        };

        Equal(expected.Length, arguments.Count);
        for (var index = 0; index < expected.Length; index++) Equal(expected[index], arguments[index]);
        True(!arguments.Any(argument => argument.Contains("cookie", StringComparison.OrdinalIgnoreCase)), "Metadata args should not use cookies.");
        True(!arguments.Contains("--config-locations"), "Metadata args should not use external config.");
        Equal(canonical, arguments[^1]);
    }

    private static void DownloadArgumentsUsePlatformSpecificSelectors()
    {
        var tiktok = YtDlpArguments.Download(
            @"C:\video-radar-tools",
            @"C:\Users\Alice\Downloads\Video Radar",
            @"C:\Users\Alice\AppData\Local\VideoRadar\temp\job",
            "stem",
            "https://www.tiktok.com/@video.radar/video/7488298911734435077",
            720);
        var selector = tiktok[tiktok.ToList().IndexOf("--format") + 1];

        True(selector.Contains("vcodec!*=h265", StringComparison.Ordinal), "TikTok selector did not avoid H.265.");
        True(selector.Contains("ext=mp4", StringComparison.Ordinal), "TikTok selector did not prefer MP4.");
        True(!selector.Contains("height<=", StringComparison.Ordinal), "Social selector must not silently download a lower quality.");
        True(selector.Split('/').All(option => option.Contains("height=720", StringComparison.Ordinal)), "Every social fallback must preserve the selected height.");
    }

    private static void DownloadArgumentsMergeSeparateInstagramVideoAndM4aAudio()
    {
        var arguments = YtDlpArguments.Download(
            @"C:\video-radar-tools",
            @"C:\Users\Alice\Downloads\Video Radar",
            @"C:\Users\Alice\AppData\Local\VideoRadar\temp\job",
            "stem",
            "https://www.instagram.com/reel/DbdpUhpg1bx/",
            1920);

        var selector = arguments[arguments.ToList().IndexOf("--format") + 1];

        Equal(
            "b[height=1920][ext=mp4]/bv[height=1920][ext=mp4]+ba[ext=m4a]/b[height=1920]",
            selector);
    }

    private static void DownloadArgumentsSupportAudioSubtitlesAndResumeSafely()
    {
        var selection = DownloadSelection.Audio("pt-BR", includeAutomaticSubtitles: true);
        var arguments = YtDlpArguments.Download(
            @"C:\video-radar-tools",
            @"C:\Users\Alice\Downloads\Video Radar",
            @"C:\Users\Alice\AppData\Local\VideoRadar\temp\job",
            "stem",
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            selection,
            new DownloadRunOptions(ResumePartial: true, PreservePartialOnCancellation: true));

        var selectorIndex = arguments.ToList().IndexOf("--format");
        Equal("ba[ext=m4a]/ba", arguments[selectorIndex + 1]);
        foreach (var required in new[]
        {
            "--extract-audio", "--audio-format", "--write-auto-subs",
            "--sub-langs", "pt-BR", "--sub-format", "--convert-subs", "--continue", "--part"
        })
        {
            True(arguments.Contains(required), $"Missing safe audio/subtitle/resume argument: {required}");
        }
        True(!arguments.Contains("--write-subs"), "Automatic captions also requested the manual track.");
        True(!arguments.Contains("--merge-output-format"), "Audio-only download retained video merge settings.");
        True(!arguments.Any(argument => argument.Contains("cookie", StringComparison.OrdinalIgnoreCase)), "Rich download selection introduced cookies.");

        var manualSubtitleArguments = YtDlpArguments.Download(
            @"C:\video-radar-tools",
            @"C:\Users\Alice\Downloads\Video Radar",
            @"C:\Users\Alice\AppData\Local\VideoRadar\temp\job-manual",
            "stem-manual",
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            new DownloadSelection(720, SubtitleLanguage: "pt-BR"),
            new DownloadRunOptions());
        True(manualSubtitleArguments.Contains("--write-subs"), "Manual subtitles were not requested.");
        True(!manualSubtitleArguments.Contains("--write-auto-subs"), "Manual subtitles also requested automatic captions.");

        foreach (var unsafeLanguage in new[] { "all,-live_chat", "../pt", "pt,en", "pt BR", new string('a', 64) })
        {
            Throws<ArgumentException>(() => YtDlpArguments.Download(
                @"C:\video-radar-tools",
                @"C:\Users\Alice\Downloads\Video Radar",
                @"C:\Users\Alice\AppData\Local\VideoRadar\temp\job",
                "stem",
                "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                DownloadSelection.Audio(unsafeLanguage),
                new DownloadRunOptions()));
        }

        Throws<ArgumentException>(() => YtDlpArguments.Download(
            @"C:\video-radar-tools",
            @"C:\Users\Alice\Downloads\Video Radar",
            @"C:\Users\Alice\AppData\Local\VideoRadar\temp\job",
            "stem",
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            new DownloadSelection(720, AudioOnly: true),
            new DownloadRunOptions()));
    }

    private static void FfprobeValidatorAcceptsExpectedBoundedMedia()
    {
        using var scope = new DownloadTestScope();
        var path = Path.Combine(scope.Root, "validated.mp4");
        File.WriteAllBytes(path, new byte[19_000]);
        const string output = """
            {"streams":[
              {"codec_type":"video","codec_name":"h264","width":1920,"height":1080},
              {"codec_type":"audio","codec_name":"aac"}
            ],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"19.000000","size":"19000"}}
            """;
        var runner = new FakeProcessRunner(new NativeProcessResult(0, output, string.Empty));
        var validator = new FfprobeMediaValidator("ffprobe.exe", runner);

        var result = validator.ValidateAsync(
            path,
            new MediaValidationRequest(true, true, 19, 20_000),
            CancellationToken.None).GetAwaiter().GetResult();

        Equal(19d, result.DurationSeconds);
        Equal(19_000L, result.SizeBytes);
        Equal(1, result.VideoStreamCount);
        Equal(1, result.AudioStreamCount);
        Equal("ffprobe.exe", runner.Executable);
        True(runner.Arguments.SequenceEqual(FfprobeMediaValidator.Arguments(path)), "ffprobe received unexpected arguments.");
        True(!runner.Arguments.Any(argument => argument.Contains("http", StringComparison.OrdinalIgnoreCase)), "ffprobe was given a remote source.");
    }

    private static void FfprobeValidatorRejectsMalformedOrImplausibleMedia()
    {
        using var scope = new DownloadTestScope();
        var path = Path.Combine(scope.Root, "invalid.mp4");
        File.WriteAllBytes(path, new byte[19_000]);
        var invalidOutputs = new[]
        {
            "{not-json",
            "{\"streams\":[],\"format\":{\"format_name\":\"mov,mp4\",\"duration\":\"19\",\"size\":\"19000\"}}",
            "{\"streams\":[{\"codec_type\":\"audio\",\"codec_name\":\"aac\"}],\"format\":{\"format_name\":\"matroska,webm\",\"duration\":\"19\",\"size\":\"19000\"}}",
            "{\"streams\":[{\"codec_type\":\"video\",\"codec_name\":\"h264\"},{\"codec_type\":\"audio\",\"codec_name\":\"aac\"}],\"format\":{\"format_name\":\"mov,mp4\",\"duration\":\"999\",\"size\":\"19000\"}}"
        };

        foreach (var output in invalidOutputs)
        {
            var validator = new FfprobeMediaValidator(
                "ffprobe.exe",
                new FakeProcessRunner(new NativeProcessResult(0, output, string.Empty)));
            Throws<MediaValidationException>(() => validator.ValidateAsync(
                path,
                new MediaValidationRequest(true, true, 19),
                CancellationToken.None).GetAwaiter().GetResult());
        }

        var truncated = new FfprobeMediaValidator(
            "ffprobe.exe",
            new FakeProcessRunner(new NativeProcessResult(0, "{}", string.Empty, StandardOutputTruncated: true)));
        Throws<MediaValidationException>(() => truncated.ValidateAsync(
            path,
            new MediaValidationRequest(true, true),
            CancellationToken.None).GetAwaiter().GetResult());
    }

    private static void YouTubeServiceCanonicalizesBeforeCallingRunner()
    {
        var runner = new FakeProcessRunner(new VideoRadar.NativeHost.Processes.ProcessResult(0, ReadFixture(), string.Empty));
        var tools = @"C:\video-radar-tools";
        var service = new YouTubeService(tools, runner);

        var catalog = service.ListFormatsAsync("https://youtu.be/jNQXAC9IVRw", CancellationToken.None).GetAwaiter().GetResult();

        Equal("jNQXAC9IVRw", catalog.VideoId);
        Equal(Path.Combine(tools, "yt-dlp.exe"), runner.Executable);
        Equal("https://www.youtube.com/watch?v=jNQXAC9IVRw", runner.Arguments[^1]);
    }

    private static void YouTubeServiceAcceptsAllowlistedSocialPages()
    {
        const string instagram = """
            {"id":"C8x_example","title":"Public Reel","extractor_key":"Instagram","formats":[
              {"height":720,"vcodec":"avc1.64001f","acodec":"mp4a.40.2","ext":"mp4"}
            ]}
            """;
        var runner = new FakeProcessRunner(new VideoRadar.NativeHost.Processes.ProcessResult(0, instagram, string.Empty));
        var service = new YouTubeService("tools", runner);

        var catalog = service.ListFormatsAsync(
            "https://instagram.com/reels/C8x_example/?igsh=abc",
            CancellationToken.None).GetAwaiter().GetResult();

        Equal("instagram", catalog.Platform);
        Equal("https://www.instagram.com/reel/C8x_example/", runner.Arguments[^1]);
        Throws<InvalidDataException>(() => service.ListFormatsAsync(
            "https://www.instagram.com/video.radar/",
            CancellationToken.None).GetAwaiter().GetResult());
        Equal(1, runner.CallCount);
    }

    private static void YouTubeServiceDoesNotRunForInvalidUrl()
    {
        var runner = new FakeProcessRunner(new VideoRadar.NativeHost.Processes.ProcessResult(0, ReadFixture(), string.Empty));
        var service = new YouTubeService("tools", runner);

        Throws<InvalidDataException>(() => service.ListFormatsAsync("https://evil.test/watch?v=jNQXAC9IVRw", CancellationToken.None).GetAwaiter().GetResult());
        Equal(0, runner.CallCount);
    }

    private static void YouTubeServiceCachesSuccessfulCatalogsAndRetriesFailures()
    {
        var successfulRunner = new FakeProcessRunner(
            new VideoRadar.NativeHost.Processes.ProcessResult(0, ReadFixture(), string.Empty));
        var service = new YouTubeService("tools", successfulRunner);

        var first = service.ListFormatsAsync(
            "https://www.youtube.com/shorts/jNQXAC9IVRw",
            CancellationToken.None).GetAwaiter().GetResult();
        var second = service.ListFormatsAsync(
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            CancellationToken.None).GetAwaiter().GetResult();

        Equal(1, successfulRunner.CallCount);
        Equal(first, second);

        var retryRunner = new FakeProcessRunner(call => call == 1
            ? new VideoRadar.NativeHost.Processes.ProcessResult(1, string.Empty, "offline")
            : new VideoRadar.NativeHost.Processes.ProcessResult(0, ReadFixture(), string.Empty));
        var retryService = new YouTubeService("tools", retryRunner);
        Throws<InvalidOperationException>(() => retryService.ListFormatsAsync(
            "https://youtu.be/jNQXAC9IVRw",
            CancellationToken.None).GetAwaiter().GetResult());

        var recovered = retryService.ListFormatsAsync(
            "https://youtu.be/jNQXAC9IVRw",
            CancellationToken.None).GetAwaiter().GetResult();
        Equal("jNQXAC9IVRw", recovered.VideoId);
        Equal(2, retryRunner.CallCount);
    }

    private static void YouTubeServiceExpiresCatalogsByPlatform()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var time = new ManualTimeProvider(new DateTimeOffset(2026, 7, 29, 0, 0, 0, TimeSpan.Zero));
        var youtubeRunner = new FakeProcessRunner(
            new VideoRadar.NativeHost.Processes.ProcessResult(0, ReadFixture(), string.Empty));
        var youtube = new YouTubeService(
            "tools",
            youtubeRunner,
            new DownloadPathsFactory(paths.Home, paths.TempRoot),
            time);

        youtube.ListFormatsAsync("https://youtu.be/jNQXAC9IVRw", CancellationToken.None).GetAwaiter().GetResult();
        time.Advance(TimeSpan.FromMinutes(29));
        youtube.ListFormatsAsync("https://youtu.be/jNQXAC9IVRw", CancellationToken.None).GetAwaiter().GetResult();
        Equal(1, youtubeRunner.CallCount);
        time.Advance(TimeSpan.FromMinutes(1));
        youtube.ListFormatsAsync("https://youtu.be/jNQXAC9IVRw", CancellationToken.None).GetAwaiter().GetResult();
        Equal(2, youtubeRunner.CallCount);

        const string instagramMetadata = """
            {"id":"C8x_example","title":"Public Reel","extractor_key":"Instagram","formats":[
              {"height":720,"vcodec":"avc1.64001f","acodec":"mp4a.40.2","ext":"mp4"}
            ]}
            """;
        var instagramRunner = new FakeProcessRunner(
            new VideoRadar.NativeHost.Processes.ProcessResult(0, instagramMetadata, string.Empty));
        var instagram = new YouTubeService(
            "tools",
            instagramRunner,
            new DownloadPathsFactory(paths.Home, paths.TempRoot),
            time);

        instagram.ListFormatsAsync("https://www.instagram.com/reel/C8x_example/", CancellationToken.None).GetAwaiter().GetResult();
        time.Advance(TimeSpan.FromMinutes(4));
        instagram.ListFormatsAsync("https://www.instagram.com/reel/C8x_example/", CancellationToken.None).GetAwaiter().GetResult();
        Equal(1, instagramRunner.CallCount);
        time.Advance(TimeSpan.FromMinutes(1));
        instagram.ListFormatsAsync("https://www.instagram.com/reel/C8x_example/", CancellationToken.None).GetAwaiter().GetResult();
        Equal(2, instagramRunner.CallCount);
    }

    private static void YouTubeServiceBoundsCatalogCacheByCountAndBytes()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var factory = new DownloadPathsFactory(paths.Home, paths.TempRoot);
        var countRunner = new FakeProcessRunner(
            new VideoRadar.NativeHost.Processes.ProcessResult(0, ReadFixture(), string.Empty));
        var countService = new YouTubeService("tools", countRunner, factory);
        var urls = Enumerable.Range(0, 17)
            .Select(index => $"https://youtu.be/id{index:D9}")
            .ToArray();

        foreach (var url in urls)
            countService.ListFormatsAsync(url, CancellationToken.None).GetAwaiter().GetResult();
        countService.ListFormatsAsync(urls[0], CancellationToken.None).GetAwaiter().GetResult();
        Equal(18, countRunner.CallCount);

        var largeTitle = new string('x', 1_100_000);
        var largeMetadata = $$"""
            {"id":"large-video","title":"{{largeTitle}}","formats":[
              {"height":720,"vcodec":"avc1","acodec":"mp4a","ext":"mp4"}
            ]}
            """;
        var byteRunner = new FakeProcessRunner(
            new VideoRadar.NativeHost.Processes.ProcessResult(0, largeMetadata, string.Empty));
        var byteService = new YouTubeService("tools", byteRunner, factory);
        var byteUrls = Enumerable.Range(0, 4)
            .Select(index => $"https://youtu.be/byte{index:D7}")
            .ToArray();

        foreach (var url in byteUrls)
            byteService.ListFormatsAsync(url, CancellationToken.None).GetAwaiter().GetResult();
        byteService.ListFormatsAsync(byteUrls[0], CancellationToken.None).GetAwaiter().GetResult();
        Equal(5, byteRunner.CallCount);
    }

    private static void YouTubeServiceCancellationDoesNotCancelSharedLookup()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completed = new TaskCompletionSource<VideoRadar.NativeHost.Processes.ProcessResult>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new ScriptedProcessRunner(call =>
        {
            True(call.CancellationToken.CanBeCanceled, "Shared metadata lookup is not cancellable.");
            started.TrySetResult();
            return completed.Task;
        });
        var service = new YouTubeService(
            "tools",
            runner,
            new DownloadPathsFactory(paths.Home, paths.TempRoot),
            TimeProvider.System);
        using var cancellation = new CancellationTokenSource();

        var cancelledObserver = service.ListFormatsAsync(
            "https://youtu.be/jNQXAC9IVRw",
            cancellation.Token);
        True(started.Task.Wait(TimeSpan.FromSeconds(5)), "Metadata lookup did not start.");
        var survivingObserver = service.ListFormatsAsync(
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            CancellationToken.None);
        cancellation.Cancel();

        Throws<OperationCanceledException>(() => cancelledObserver.GetAwaiter().GetResult());
        True(!runner.Calls[0].CancellationToken.IsCancellationRequested,
            "Cancelling one observer cancelled a lookup that still had an observer.");
        True(!survivingObserver.IsCompleted, "Cancelling one observer completed the shared lookup.");
        completed.SetResult(new VideoRadar.NativeHost.Processes.ProcessResult(0, ReadFixture(), string.Empty));
        Equal("jNQXAC9IVRw", survivingObserver.GetAwaiter().GetResult().VideoId);
        Equal(1, runner.Calls.Count);
    }

    private static void YouTubeServiceCancelsLookupAfterLastObserverLeaves()
    {
        using var scope = new DownloadTestScope();
        var paths = scope.CreatePaths();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancellationObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new ScriptedProcessRunner(
            async call =>
            {
                True(call.CancellationToken.CanBeCanceled, "Metadata runner did not receive a cancellable lookup token.");
                started.TrySetResult();
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, call.CancellationToken);
                }
                catch (OperationCanceledException) when (call.CancellationToken.IsCancellationRequested)
                {
                    cancellationObserved.TrySetResult();
                    throw;
                }

                throw new InvalidOperationException("Unreachable metadata continuation.");
            },
            _ => Task.FromResult(new VideoRadar.NativeHost.Processes.ProcessResult(
                0,
                ReadFixture(),
                string.Empty)));
        var service = new YouTubeService(
            "tools",
            runner,
            new DownloadPathsFactory(paths.Home, paths.TempRoot),
            TimeProvider.System);
        using var cancellation = new CancellationTokenSource();

        var abandoned = service.ListFormatsAsync(
            "https://youtu.be/jNQXAC9IVRw",
            cancellation.Token);
        True(started.Task.Wait(TimeSpan.FromSeconds(5)), "Metadata lookup did not start.");
        cancellation.Cancel();

        Throws<OperationCanceledException>(() => abandoned.GetAwaiter().GetResult());
        True(cancellationObserved.Task.Wait(TimeSpan.FromSeconds(5)),
            "The metadata subprocess token was not cancelled after its final observer left.");
        var recovered = service.ListFormatsAsync(
            "https://youtu.be/jNQXAC9IVRw",
            CancellationToken.None).GetAwaiter().GetResult();
        Equal("jNQXAC9IVRw", recovered.VideoId);
        Equal(2, runner.Calls.Count);
    }

    private static void YouTubeServiceRejectsTruncatedMetadata()
    {
        var runner = new FakeProcessRunner(new VideoRadar.NativeHost.Processes.ProcessResult(
            0,
            ReadFixture(),
            string.Empty,
            StandardOutputTruncated: true));
        var service = new YouTubeService("tools", runner);

        Throws<InvalidOperationException>(() => service.ListFormatsAsync(
            "https://youtu.be/jNQXAC9IVRw",
            CancellationToken.None).GetAwaiter().GetResult());
        Equal(1, runner.CallCount);
    }

    private static void YouTubeServiceDoesNotLeakYtDlpStandardError()
    {
        var runner = new FakeProcessRunner(new VideoRadar.NativeHost.Processes.ProcessResult(1, string.Empty, "secret cookie and raw diagnostics"));
        var service = new YouTubeService("tools", runner);

        try
        {
            service.ListFormatsAsync("https://youtu.be/jNQXAC9IVRw", CancellationToken.None).GetAwaiter().GetResult();
        }
        catch (InvalidOperationException exception)
        {
            True(!exception.Message.Contains("secret cookie", StringComparison.Ordinal), "Raw stderr leaked into the error.");
            return;
        }

        throw new InvalidOperationException("Non-zero yt-dlp exit should fail.");
    }

    private static string ReadFixture() => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "youtube-info.json"));

    private sealed class ManualTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => utcNow;

        public void Advance(TimeSpan elapsed) => utcNow += elapsed;
    }

    private sealed class FakeProcessRunner : IProcessRunner
    {
        private readonly Func<int, VideoRadar.NativeHost.Processes.ProcessResult> result;

        public FakeProcessRunner(VideoRadar.NativeHost.Processes.ProcessResult result)
            : this(_ => result)
        {
        }

        public FakeProcessRunner(Func<int, VideoRadar.NativeHost.Processes.ProcessResult> result)
        {
            this.result = result;
        }

        public int CallCount { get; private set; }
        public string Executable { get; private set; } = string.Empty;
        public IReadOnlyList<string> Arguments { get; private set; } = [];

        public Task<VideoRadar.NativeHost.Processes.ProcessResult> RunAsync(string executable, IReadOnlyList<string> arguments, Func<string, Task>? onOutput, CancellationToken cancellationToken)
        {
            CallCount++;
            Executable = executable;
            Arguments = arguments;
            return Task.FromResult(result(CallCount));
        }
    }
}
