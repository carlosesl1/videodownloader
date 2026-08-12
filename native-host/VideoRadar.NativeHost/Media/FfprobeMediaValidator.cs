using System.Globalization;
using System.Text;
using System.Text.Json;
using VideoRadar.NativeHost.Processes;

namespace VideoRadar.NativeHost.Media;

public sealed record MediaValidationRequest(
    bool ExpectVideo,
    bool ExpectAudio,
    double? ExpectedDurationSeconds = null,
    long? EstimatedSizeBytes = null);

public sealed record MediaValidationResult(
    string Container,
    double DurationSeconds,
    long SizeBytes,
    int VideoStreamCount,
    int AudioStreamCount);

public interface IMediaFileValidator
{
    Task<MediaValidationResult> ValidateAsync(
        string path,
        MediaValidationRequest request,
        CancellationToken cancellationToken);
}

public sealed class MediaValidationException : Exception
{
    public MediaValidationException() : base("O arquivo baixado não passou pela validação final de mídia.")
    {
    }
}

public sealed class FfprobeMediaValidator : IMediaFileValidator
{
    private static readonly TimeSpan ValidationTimeout = TimeSpan.FromSeconds(30);
    private const int MaximumProbeOutputBytes = 256 * 1024;
    private const long MinimumPlausibleFileBytes = 1_024;
    private const double MaximumPlausibleDurationSeconds = 7 * 24 * 60 * 60;
    private readonly string executable;
    private readonly IProcessRunner processRunner;

    public FfprobeMediaValidator(string tools)
        : this(
            Path.Combine(ValidateToolsPath(tools), "ffprobe.exe"),
            new ProcessRunner(
                ValidationTimeout,
                maximumStandardOutputChars: MaximumProbeOutputBytes,
                maximumStandardErrorChars: 32 * 1024,
                maximumOutputLineChars: 64 * 1024))
    {
    }

    internal FfprobeMediaValidator(string executable, IProcessRunner processRunner)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(executable);
        ArgumentNullException.ThrowIfNull(processRunner);
        this.executable = executable;
        this.processRunner = processRunner;
    }

    public async Task<MediaValidationResult> ValidateAsync(
        string path,
        MediaValidationRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        var actualSize = ValidateFile(path);
        if (!request.ExpectVideo && !request.ExpectAudio)
            throw new ArgumentException("At least one expected stream is required.", nameof(request));

        ProcessResult probe;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(ValidationTimeout);
        try
        {
            probe = await processRunner.RunAsync(
                executable,
                Arguments(path),
                onOutput: null,
                timeout.Token).WaitAsync(ValidationTimeout, cancellationToken);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new MediaValidationException();
        }
        catch (TimeoutException)
        {
            timeout.Cancel();
            throw new MediaValidationException();
        }
        catch (Exception exception) when (
            exception is InvalidOperationException
            or IOException
            or UnauthorizedAccessException
            or System.ComponentModel.Win32Exception)
        {
            throw new MediaValidationException();
        }

        if (probe.ExitCode != 0
            || probe.StandardOutputTruncated
            || probe.StandardErrorTruncated
            || !string.IsNullOrWhiteSpace(probe.StandardError)
            || Encoding.UTF8.GetByteCount(probe.StandardOutput) > MaximumProbeOutputBytes)
        {
            throw new MediaValidationException();
        }

        return ParseAndValidate(probe.StandardOutput, path, actualSize, request);
    }

    internal static IReadOnlyList<string> Arguments(string path) =>
    [
        "-v", "error",
        "-hide_banner",
        "-show_entries", "format=format_name,duration,size:stream=codec_type,codec_name,duration,width,height",
        "-of", "json=c=1",
        path
    ];

    internal static MediaValidationResult ParseAndValidate(
        string json,
        string path,
        long actualSize,
        MediaValidationRequest request)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("format", out var format)
                || format.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("streams", out var streams)
                || streams.ValueKind != JsonValueKind.Array
                || streams.GetArrayLength() > 1_024)
            {
                throw new MediaValidationException();
            }

            var container = RequiredBoundedString(format, "format_name", 128);
            ValidateContainer(path, container);
            var duration = ParsePositiveDouble(format, "duration");
            if (!double.IsFinite(duration) || duration > MaximumPlausibleDurationSeconds)
                throw new MediaValidationException();

            var reportedSize = ParsePositiveInt64(format, "size");
            if (actualSize < MinimumPlausibleFileBytes
                || (reportedSize.HasValue && Math.Abs(reportedSize.Value - actualSize) > 4_096))
            {
                throw new MediaValidationException();
            }

            var videoStreams = 0;
            var audioStreams = 0;
            foreach (var stream in streams.EnumerateArray())
            {
                if (stream.ValueKind != JsonValueKind.Object) continue;
                var codecType = OptionalBoundedString(stream, "codec_type", 32);
                var codecName = OptionalBoundedString(stream, "codec_name", 128);
                if (string.IsNullOrWhiteSpace(codecName) || string.Equals(codecName, "unknown", StringComparison.OrdinalIgnoreCase))
                    continue;
                if (string.Equals(codecType, "video", StringComparison.OrdinalIgnoreCase)) videoStreams++;
                if (string.Equals(codecType, "audio", StringComparison.OrdinalIgnoreCase)) audioStreams++;
            }

            if ((request.ExpectVideo && videoStreams == 0)
                || (request.ExpectAudio && audioStreams == 0))
            {
                throw new MediaValidationException();
            }

            ValidatePlausibility(actualSize, duration, request);
            return new MediaValidationResult(container, duration, actualSize, videoStreams, audioStreams);
        }
        catch (JsonException)
        {
            throw new MediaValidationException();
        }
        catch (FormatException)
        {
            throw new MediaValidationException();
        }
        catch (OverflowException)
        {
            throw new MediaValidationException();
        }
    }

    private static long ValidateFile(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
            throw new MediaValidationException();
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists
                || (info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            {
                throw new MediaValidationException();
            }
            return info.Length;
        }
        catch (Exception exception) when (
            exception is ArgumentException
            or IOException
            or UnauthorizedAccessException
            or NotSupportedException)
        {
            throw new MediaValidationException();
        }
    }

    private static void ValidateContainer(string path, string formatNames)
    {
        var names = formatNames
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(name => name.ToLowerInvariant())
            .ToHashSet(StringComparer.Ordinal);
        var extension = Path.GetExtension(path).ToLowerInvariant();
        var accepted = extension switch
        {
            ".mp4" or ".m4a" => names.Any(name => name is "mov" or "mp4" or "m4a" or "3gp" or "3g2" or "mj2"),
            ".webm" => names.Any(name => name is "matroska" or "webm"),
            ".mkv" => names.Any(name => name is "matroska" or "webm"),
            _ => false
        };
        if (!accepted) throw new MediaValidationException();
    }

    private static void ValidatePlausibility(long actualSize, double duration, MediaValidationRequest request)
    {
        var bytesPerSecond = actualSize / duration;
        if (bytesPerSecond is < 100 or > 2_000_000_000)
            throw new MediaValidationException();

        if (request.ExpectedDurationSeconds is double expectedDuration && expectedDuration > 0)
        {
            var allowedDifference = Math.Max(10, expectedDuration * 0.1);
            if (Math.Abs(duration - expectedDuration) > allowedDifference)
                throw new MediaValidationException();
        }

        if (request.EstimatedSizeBytes is long estimatedSize && estimatedSize > 1_048_576)
        {
            var lowerBound = Math.Max(MinimumPlausibleFileBytes, estimatedSize / 100);
            var upperBound = estimatedSize > long.MaxValue / 100 ? long.MaxValue : estimatedSize * 100;
            if (actualSize < lowerBound || actualSize > upperBound)
                throw new MediaValidationException();
        }
    }

    private static double ParsePositiveDouble(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var property)) throw new MediaValidationException();
        double value;
        if (property.ValueKind == JsonValueKind.Number && property.TryGetDouble(out value)) { }
        else if (property.ValueKind == JsonValueKind.String
            && double.TryParse(property.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out value)) { }
        else throw new MediaValidationException();
        if (!double.IsFinite(value) || value <= 0) throw new MediaValidationException();
        return value;
    }

    private static long? ParsePositiveInt64(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var property)) return null;
        long value;
        if (property.ValueKind == JsonValueKind.Number && property.TryGetInt64(out value)) { }
        else if (property.ValueKind == JsonValueKind.String
            && long.TryParse(property.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out value)) { }
        else return null;
        return value > 0 ? value : null;
    }

    private static string RequiredBoundedString(JsonElement element, string propertyName, int maximumLength) =>
        OptionalBoundedString(element, propertyName, maximumLength) ?? throw new MediaValidationException();

    private static string? OptionalBoundedString(JsonElement element, string propertyName, int maximumLength) =>
        element.TryGetProperty(propertyName, out var property)
        && property.ValueKind == JsonValueKind.String
        && property.GetString() is { Length: > 0 } value
        && value.Length <= maximumLength
            ? value
            : null;

    private static string ValidateToolsPath(string tools)
    {
        if (string.IsNullOrWhiteSpace(tools) || !Path.IsPathFullyQualified(tools))
            throw new ArgumentException("The tools directory must be absolute.", nameof(tools));
        return Path.GetFullPath(tools);
    }
}
