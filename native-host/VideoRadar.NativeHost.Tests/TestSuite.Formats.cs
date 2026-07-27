using VideoRadar.NativeHost.Processes;
using VideoRadar.NativeHost.YouTube;

namespace VideoRadar.NativeHost.Tests;

internal static partial class TestSuite
{
    private static void FormatCatalogTests()
    {
        FormatCatalogReducesFixtureToDistinctQualities();
        FormatCatalogRejectsUnavailableOrIncompleteMetadata();
        FormatCatalogRejectsMissingPositiveHeights();
        FormatCatalogFallsBackToWebmWithoutMp4AndM4a();
        MetadataArgumentsAreHardenedAndCanonical();
        YouTubeServiceCanonicalizesBeforeCallingRunner();
        YouTubeServiceCachesSuccessfulCatalogsAndRetriesFailures();
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

    private static void FormatCatalogFallsBackToWebmWithoutMp4AndM4a()
    {
        const string json = """
            {"id":"jNQXAC9IVRw","title":"A","is_live":false,"availability":"public","formats":[
              {"height":1080,"vcodec":"avc1","acodec":"none","ext":"mp4"},
              {"height":1080,"vcodec":"avc1","acodec":"none","ext":"mp4"},
              {"height":null,"vcodec":"none","acodec":"opus","ext":"webm"}
            ]}
            """;

        var catalog = FormatCatalog.Parse(json);

        Equal(1, catalog.Qualities.Count);
        Equal("WebM", catalog.Qualities[0].Container);
        True(!catalog.Qualities[0].Combined, "Separate streams should not be marked combined.");
    }

    private static void MetadataArgumentsAreHardenedAndCanonical()
    {
        var tools = @"C:\video-radar-tools";
        var canonical = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
        var arguments = YtDlpArguments.Metadata(tools, canonical);
        var expected = new[]
        {
            "--ignore-config", "--no-playlist", "--no-plugin-dirs", "--no-remote-components",
            "--js-runtimes", $"deno:{Path.Combine(tools, "deno.exe")}",
            "--ffmpeg-location", tools,
            "--dump-single-json", "--skip-download", "--no-warnings", canonical
        };

        Equal(expected.Length, arguments.Count);
        for (var index = 0; index < expected.Length; index++) Equal(expected[index], arguments[index]);
        True(!arguments.Any(argument => argument.Contains("cookie", StringComparison.OrdinalIgnoreCase)), "Metadata args should not use cookies.");
        True(!arguments.Any(argument => argument.Contains("config-location", StringComparison.OrdinalIgnoreCase)), "Metadata args should not use external config.");
        Equal(canonical, arguments[^1]);
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
