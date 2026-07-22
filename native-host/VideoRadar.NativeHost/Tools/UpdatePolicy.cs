using System.Text.Json;
using VideoRadar.NativeHost.Processes;

namespace VideoRadar.NativeHost.Tools;

public interface IUpdatePolicy
{
    Task CheckAsync(CancellationToken cancellationToken);
}

public sealed class UpdatePolicy : IUpdatePolicy
{
    private static readonly TimeSpan CheckInterval = TimeSpan.FromHours(24);
    private readonly string toolsDirectory;
    private readonly string statePath;
    private readonly IProcessRunner processRunner;
    private readonly Func<DateTimeOffset> now;

    public UpdatePolicy(string toolsDirectory, IProcessRunner processRunner)
        : this(toolsDirectory, DefaultStatePath(), processRunner, () => DateTimeOffset.UtcNow)
    {
    }

    public UpdatePolicy(
        string toolsDirectory,
        string statePath,
        IProcessRunner processRunner,
        Func<DateTimeOffset> now)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(toolsDirectory);
        ArgumentException.ThrowIfNullOrWhiteSpace(statePath);
        ArgumentNullException.ThrowIfNull(processRunner);
        ArgumentNullException.ThrowIfNull(now);
        this.toolsDirectory = toolsDirectory;
        this.statePath = statePath;
        this.processRunner = processRunner;
        this.now = now;
    }

    public static bool ShouldCheck(DateTimeOffset? lastCheck, DateTimeOffset now)
    {
        if (lastCheck is null) return true;
        if (now < lastCheck.Value) return false;
        return now - lastCheck.Value >= CheckInterval;
    }

    public async Task CheckAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var checkTime = now().ToUniversalTime();
        var lastCheck = await ReadLastCheckAsync(cancellationToken);
        if (!ShouldCheck(lastCheck, checkTime)) return;

        // Persist before running the updater so non-zero exits and network failures are still attempts.
        await TryWriteLastCheckAsync(checkTime);
        try
        {
            await processRunner.RunAsync(
                Path.Combine(toolsDirectory, "yt-dlp.exe"),
                ["--ignore-config", "-U"],
                onOutput: null,
                cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            // Updating is best-effort and never prevents the requested YouTube operation.
        }
    }

    private async Task<DateTimeOffset?> ReadLastCheckAsync(CancellationToken cancellationToken)
    {
        try
        {
            if (!File.Exists(statePath)) return null;
            await using var stream = File.OpenRead(statePath);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("lastCheckUtc", out var value)
                || value.ValueKind != JsonValueKind.String
                || !value.TryGetDateTimeOffset(out var timestamp))
            {
                return null;
            }

            return timestamp.ToUniversalTime();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return null;
        }
    }

    private async Task TryWriteLastCheckAsync(DateTimeOffset timestamp)
    {
        string? temporaryPath = null;
        try
        {
            var directory = Path.GetDirectoryName(Path.GetFullPath(statePath))!;
            Directory.CreateDirectory(directory);
            temporaryPath = Path.Combine(directory, $".{Path.GetFileName(statePath)}.{Guid.NewGuid():N}.tmp");
            var json = JsonSerializer.Serialize(new { lastCheckUtc = timestamp });
            await File.WriteAllTextAsync(temporaryPath, json);
            File.Move(temporaryPath, statePath, overwrite: true);
            temporaryPath = null;
        }
        catch
        {
            // State persistence is best-effort and must not block the user's command.
        }
        finally
        {
            if (temporaryPath is not null)
            {
                try
                {
                    File.Delete(temporaryPath);
                }
                catch
                {
                    // Best-effort cleanup of an incomplete atomic write.
                }
            }
        }
    }

    private static string DefaultStatePath()
    {
        var localApplicationData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localApplicationData))
            throw new DirectoryNotFoundException("Local application data directory is unavailable.");
        return Path.Combine(localApplicationData, "VideoRadar", "state", "yt-dlp-update.json");
    }
}
