using System.Buffers.Binary;
using System.Text.Json;
using VideoRadar.NativeHost.Media;
using VideoRadar.NativeHost.Protocol;
using VideoRadar.NativeHost.YouTube;

namespace VideoRadar.NativeHost.Tests;

internal static partial class TestSuite
{
    private static void ProtocolTests()
    {
        NativeMessageChannelRoundTripsJson();
        NativeMessageChannelReturnsNullForCleanEof();
        NativeMessageChannelRejectsIncompleteHeader();
        NativeMessageChannelRejectsInvalidMessageLengths();
        NativeMessageChannelRequiresCompleteBody();
        HostCommandAcceptsAllowedTypesAndClonesPayload();
        HostCommandRejectsMalformedCommands();
    }

    private static void NativeMessageChannelRoundTripsJson()
    {
        using var stream = new MemoryStream();
        var channel = new NativeMessageChannel(stream, stream);
        channel.WriteAsync(new { type = "ready", requestId = "r1" }, CancellationToken.None).GetAwaiter().GetResult();
        stream.Position = 0;
        using var message = channel.ReadAsync(CancellationToken.None).GetAwaiter().GetResult();
        Equal("ready", message!.RootElement.GetProperty("type").GetString());
        Equal("r1", message.RootElement.GetProperty("requestId").GetString());
    }

    private static void NativeMessageChannelReturnsNullForCleanEof()
    {
        using var input = new MemoryStream();
        using var output = new MemoryStream();
        var channel = new NativeMessageChannel(input, output);

        var message = channel.ReadAsync(CancellationToken.None).GetAwaiter().GetResult();

        True(message is null, "Clean EOF did not return null.");
    }

    private static void NativeMessageChannelRejectsIncompleteHeader()
    {
        using var input = new MemoryStream([1, 2, 3]);
        using var output = new MemoryStream();
        var channel = new NativeMessageChannel(input, output);

        Throws<InvalidDataException>(() => channel.ReadAsync(CancellationToken.None).GetAwaiter().GetResult());
    }

    private static void NativeMessageChannelRejectsInvalidMessageLengths()
    {
        var zeroLength = new byte[4];
        var oversized = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(oversized, NativeMessageChannel.MaxMessageBytes + 1U);

        using (var input = new MemoryStream(zeroLength))
        using (var output = new MemoryStream())
        {
            var channel = new NativeMessageChannel(input, output);
            Throws<InvalidDataException>(() => channel.ReadAsync(CancellationToken.None).GetAwaiter().GetResult());
        }

        using (var input = new MemoryStream(oversized))
        using (var output = new MemoryStream())
        {
            var channel = new NativeMessageChannel(input, output);
            Throws<InvalidDataException>(() => channel.ReadAsync(CancellationToken.None).GetAwaiter().GetResult());
        }
    }

    private static void NativeMessageChannelRequiresCompleteBody()
    {
        var inputBytes = new byte[6];
        BinaryPrimitives.WriteUInt32LittleEndian(inputBytes, 3);
        inputBytes[4] = (byte)'{';
        inputBytes[5] = (byte)'}';
        using var input = new MemoryStream(inputBytes);
        using var output = new MemoryStream();
        var channel = new NativeMessageChannel(input, output);

        Throws<EndOfStreamException>(() => channel.ReadAsync(CancellationToken.None).GetAwaiter().GetResult());
    }

    private static void HostCommandAcceptsAllowedTypesAndClonesPayload()
    {
        foreach (var type in new[]
        {
            "ping",
            "listFormats",
            "startDownload",
            "cancelDownload",
            "getJob",
            "chooseDownloadFolder",
            "moveDownloadedFile",
            "revealDownloadedFile"
        })
        {
            using var document = JsonDocument.Parse($"{{\"type\":\"{type}\",\"requestId\":\"request-1\",\"payload\":{{\"value\":1}}}}");
            var command = HostCommand.Parse(document.RootElement);

            Equal(type, command.Type);
            Equal("request-1", command.RequestId);
            Equal(1, command.Payload.GetProperty("value").GetInt32());
        }

        HostCommand cloned;
        using (var document = JsonDocument.Parse("{\"type\":\"ping\",\"requestId\":\"r1\",\"payload\":{\"survives\":true}}"))
        {
            cloned = HostCommand.Parse(document.RootElement);
        }

        True(cloned.Payload.GetProperty("survives").GetBoolean(), "Payload was not cloned.");
    }

    private static void HostCommandRejectsMalformedCommands()
    {
        foreach (var json in new[]
        {
            "[]",
            "{\"requestId\":\"r1\",\"payload\":{}}",
            "{\"type\":\"ping\",\"payload\":{}}",
            "{\"type\":\"ping\",\"requestId\":\"r1\"}",
            "{\"type\":\"unknown\",\"requestId\":\"r1\",\"payload\":{}}",
            "{\"type\":1,\"requestId\":\"r1\",\"payload\":{}}",
            "{\"type\":\"ping\",\"requestId\":1,\"payload\":{}}",
            "{\"type\":\"ping\",\"requestId\":\"\",\"payload\":{}}",
            "{\"type\":\"ping\",\"requestId\":\"contains space\",\"payload\":{}}",
            $"{{\"type\":\"ping\",\"requestId\":\"{new string('a', 129)}\",\"payload\":{{}}}}",
            "{\"type\":\"ping\",\"requestId\":\"r1\",\"payload\":null}",
            "{\"type\":\"ping\",\"requestId\":\"r1\",\"payload\":[]}",
            "{\"type\":\"ping\",\"requestId\":\"r1\",\"payload\":\"text\"}"
        })
        {
            using var document = JsonDocument.Parse(json);
            Throws<InvalidDataException>(() => HostCommand.Parse(document.RootElement));
        }
    }

    private static void YouTubeUrlTests()
    {
        True(YouTubeUrl.TryCanonicalize("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=3", out var watch), "watch URL rejected");
        Equal("https://www.youtube.com/watch?v=jNQXAC9IVRw", watch);
        True(YouTubeUrl.TryCanonicalize("https://youtu.be/jNQXAC9IVRw", out var shortUrl), "short URL rejected");
        Equal(watch, shortUrl);
        True(YouTubeUrl.TryCanonicalize("https://m.youtube.com/watch?v=jNQXAC9IVRw", out var mobile), "mobile URL rejected");
        Equal(watch, mobile);
        True(YouTubeUrl.TryCanonicalize("https://www.youtube.com/shorts/jNQXAC9IVRw?feature=share", out var shorts), "Shorts URL rejected");
        Equal(watch, shorts);
        True(!YouTubeUrl.TryCanonicalize("http://youtube.com/watch?v=jNQXAC9IVRw", out _), "HTTP accepted");
        True(!YouTubeUrl.TryCanonicalize("https://evil.test/watch?v=jNQXAC9IVRw", out _), "foreign host accepted");
        True(!YouTubeUrl.TryCanonicalize("https://youtube.com/playlist?list=x", out _), "playlist accepted");
        YouTubeUrlRejectsUnsafeOrInvalidUrls();
    }

    private static void MediaPageTests()
    {
        (string Input, string Platform, string Canonical, string MediaId)[] accepted =
        [
            (
                "https://m.youtube.com/shorts/jNQXAC9IVRw?feature=share",
                "youtube",
                "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                "jNQXAC9IVRw"),
            (
                "https://www.tiktok.com/@video.radar/video/7488298911734435077?is_from_webapp=1",
                "tiktok",
                "https://www.tiktok.com/@video.radar/video/7488298911734435077",
                "7488298911734435077"),
            (
                "https://vm.tiktok.com/ZM123abcD/",
                "tiktok",
                "https://vm.tiktok.com/ZM123abcD/",
                "short:ZM123abcD"),
            (
                "https://www.instagram.com/reels/C8x_example/?igsh=abc",
                "instagram",
                "https://www.instagram.com/reel/C8x_example/",
                "C8x_example"),
            (
                "https://twitter.com/VideoRadar/status/1907123456789012345/video/1",
                "x",
                "https://x.com/VideoRadar/status/1907123456789012345",
                "1907123456789012345")
        ];

        foreach (var sample in accepted)
        {
            True(MediaPage.TryCanonicalize(sample.Input, out var page), $"Valid media URL rejected: {sample.Input}");
            Equal(sample.Platform, page!.Platform);
            Equal(sample.Canonical, page.CanonicalUrl);
            Equal(sample.MediaId, page.MediaId);
        }

        foreach (var rejected in new[]
        {
            "http://x.com/user/status/1907123456789012345",
            "https://user@x.com/user/status/1907123456789012345",
            "https://x.com:444/user/status/1907123456789012345",
            "https://x.com.evil.test/user/status/1907123456789012345",
            "https://tiktok.com/extra/../@user/video/7488298911734435077",
            "https://instagram.com/%2e/reel/C8x_example/",
            "https://www.tiktok.com/@video.radar",
            "https://www.instagram.com/stories/video.radar/123/",
            "https://x.com/i/spaces/abc",
            "https://example.com/video/123"
        })
        {
            True(!MediaPage.TryCanonicalize(rejected, out var page), $"Invalid media URL accepted: {rejected}");
            True(page is null, "Rejected URL returned a media page.");
        }
    }

    private static void YouTubeUrlRejectsUnsafeOrInvalidUrls()
    {
        foreach (var url in new[]
        {
            "https://user@youtube.com/watch?v=jNQXAC9IVRw",
            "https://@youtube.com/watch?v=jNQXAC9IVRw",
            "https://youtube.com:444/watch?v=jNQXAC9IVRw",
            "https://youtube.com.evil.test/watch?v=jNQXAC9IVRw",
            "https://notyoutube.com/watch?v=jNQXAC9IVRw",
            "https://youtube.com/extra/../watch?v=jNQXAC9IVRw",
            "https://youtube.com/./watch?v=jNQXAC9IVRw",
            "https://youtube.com/%2e/watch?v=jNQXAC9IVRw",
            "https://youtu.be/jNQXAC9IVRw/extra",
            "https://youtu.be/extra/../jNQXAC9IVRw",
            "https://youtu.be/./jNQXAC9IVRw",
            "https://youtu.be/%2e/jNQXAC9IVRw",
            "https://youtu.be/jNQXAC9IVR",
            "https://youtu.be/jNQXAC9IVR!",
            "https://www.youtube.com/watch?v=jNQXAC9IVR",
            "https://www.youtube.com/watch?v=jNQXAC9IVR!",
            "https://www.youtube.com/shorts/jNQXAC9IVRw/extra",
            "https://www.youtube.com/shorts/jNQXAC9IVR",
            "https://www.youtube.com/embed/jNQXAC9IVRw",
            "https://www.youtube.com/watch?video=jNQXAC9IVRw"
        })
        {
            True(!YouTubeUrl.TryCanonicalize(url, out var canonical), $"Invalid URL accepted: {url}");
            Equal(string.Empty, canonical);
        }

        True(!YouTubeUrl.TryCanonicalize(null!, out var nullCanonical), "Null URL accepted.");
        Equal(string.Empty, nullCanonical);
    }

    private static void Throws<TException>(Action action) where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException)
        {
            return;
        }
        catch (Exception exception)
        {
            throw new InvalidOperationException($"Expected {typeof(TException).Name}, received {exception.GetType().Name}.", exception);
        }

        throw new InvalidOperationException($"Expected {typeof(TException).Name}, but no exception was thrown.");
    }
}
