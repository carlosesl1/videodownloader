using System.Diagnostics;
using System.Text;
using VideoRadar.NativeHost.Windows;

namespace VideoRadar.NativeHost.Processes;

public sealed class ProcessRunner : IProcessRunner
{
    private static readonly TimeSpan DefaultHardTimeout = TimeSpan.FromHours(12);
    private const int DefaultMaximumStandardOutputChars = 4 * 1024 * 1024;
    private const int DefaultMaximumStandardErrorChars = 256 * 1024;
    private const int DefaultMaximumOutputLineChars = 64 * 1024;
    private readonly TimeSpan hardTimeout;
    private readonly int maximumStandardOutputChars;
    private readonly int maximumStandardErrorChars;
    private readonly int maximumOutputLineChars;

    public ProcessRunner(
        TimeSpan? hardTimeout = null,
        int maximumStandardOutputChars = DefaultMaximumStandardOutputChars,
        int maximumStandardErrorChars = DefaultMaximumStandardErrorChars,
        int maximumOutputLineChars = DefaultMaximumOutputLineChars)
    {
        this.hardTimeout = hardTimeout ?? DefaultHardTimeout;
        if (this.hardTimeout <= TimeSpan.Zero || this.hardTimeout > TimeSpan.FromDays(7))
            throw new ArgumentOutOfRangeException(nameof(hardTimeout));
        if (maximumStandardOutputChars <= 0)
            throw new ArgumentOutOfRangeException(nameof(maximumStandardOutputChars));
        if (maximumStandardErrorChars <= 0)
            throw new ArgumentOutOfRangeException(nameof(maximumStandardErrorChars));
        if (maximumOutputLineChars <= 0)
            throw new ArgumentOutOfRangeException(nameof(maximumOutputLineChars));

        this.maximumStandardOutputChars = maximumStandardOutputChars;
        this.maximumStandardErrorChars = maximumStandardErrorChars;
        this.maximumOutputLineChars = maximumOutputLineChars;
    }

    public async Task<ProcessResult> RunAsync(
        string executable,
        IReadOnlyList<string> arguments,
        Func<string, Task>? onOutput,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(executable);
        ArgumentNullException.ThrowIfNull(arguments);
        if (arguments.Any(argument => argument is null))
            throw new ArgumentException("Process arguments cannot contain null values.", nameof(arguments));
        cancellationToken.ThrowIfCancellationRequested();

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo(executable)
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            }
        };
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);

        using var job = new ChildProcessJob();
        if (!process.Start()) throw new InvalidOperationException("Unable to start child process.");
        try
        {
            job.Assign(process);
            process.StandardInput.Close();
        }
        catch
        {
            try { process.StandardInput.Close(); } catch (InvalidOperationException) { }
            KillIfRunning(process);
            throw;
        }

        using var timeoutCancellation = new CancellationTokenSource(hardTimeout);
        using var runCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            timeoutCancellation.Token);
        using var cancellationRegistration = runCancellation.Token.Register(
            static state => ((ChildProcessJob)state!).Dispose(),
            job);

        var standardOutputTask = ReadStandardOutputAsync(
            process.StandardOutput,
            onOutput,
            maximumStandardOutputChars,
            maximumOutputLineChars,
            runCancellation.Token);
        var standardErrorTask = ReadBoundedTailAsync(
            process.StandardError,
            maximumStandardErrorChars);
        var exitTask = process.WaitForExitAsync();
        DisposeJobOnFault(standardOutputTask, job);
        DisposeJobOnFault(standardErrorTask, job);

        try
        {
            await Task.WhenAll(standardOutputTask, standardErrorTask, exitTask);
            timeoutCancellation.CancelAfter(Timeout.InfiniteTimeSpan);
        }
        catch (Exception exception)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            if (timeoutCancellation.IsCancellationRequested)
            {
                throw new TimeoutException(
                    $"Child process exceeded its {hardTimeout} execution limit.",
                    exception);
            }
            throw;
        }

        cancellationToken.ThrowIfCancellationRequested();
        if (timeoutCancellation.IsCancellationRequested)
            throw new TimeoutException($"Child process exceeded its {hardTimeout} execution limit.");

        var standardOutput = await standardOutputTask;
        var standardError = await standardErrorTask;
        return new ProcessResult(
            process.ExitCode,
            standardOutput.Text,
            standardError.Text,
            standardOutput.Truncated,
            standardError.Truncated);
    }

    private static async Task<CapturedOutput> ReadStandardOutputAsync(
        StreamReader reader,
        Func<string, Task>? onOutput,
        int maximumCaptureChars,
        int maximumLineChars,
        CancellationToken cancellationToken)
    {
        var output = new StringBuilder(Math.Min(maximumCaptureChars, 4096));
        var line = onOutput is null ? null : new StringBuilder(Math.Min(maximumLineChars, 1024));
        var truncated = false;
        var lineOverflowed = false;
        var buffer = new char[8192];

        while (true)
        {
            var read = await reader.ReadAsync(buffer.AsMemory());
            if (read == 0) break;

            var available = maximumCaptureChars - output.Length;
            if (available > 0) output.Append(buffer, 0, Math.Min(available, read));
            if (read > available) truncated = true;

            if (onOutput is null) continue;
            for (var index = 0; index < read; index++)
            {
                var character = buffer[index];
                if (character == '\n')
                {
                    if (!lineOverflowed)
                    {
                        if (line!.Length > 0 && line[line.Length - 1] == '\r') line.Length--;
                        await onOutput(line.ToString()).WaitAsync(cancellationToken);
                    }

                    line!.Clear();
                    lineOverflowed = false;
                    continue;
                }

                if (lineOverflowed) continue;
                if (line!.Length < maximumLineChars)
                {
                    line.Append(character);
                }
                else
                {
                    line.Clear();
                    lineOverflowed = true;
                }
            }
        }

        if (onOutput is not null && !lineOverflowed && line!.Length > 0)
        {
            if (line[line.Length - 1] == '\r') line.Length--;
            await onOutput(line.ToString()).WaitAsync(cancellationToken);
        }

        return new CapturedOutput(output.ToString(), truncated);
    }

    private static async Task<CapturedOutput> ReadBoundedTailAsync(
        StreamReader reader,
        int maximumCaptureChars)
    {
        var output = new BoundedTailBuffer(maximumCaptureChars);
        var buffer = new char[8192];
        while (true)
        {
            var read = await reader.ReadAsync(buffer.AsMemory());
            if (read == 0) break;
            output.Append(buffer.AsSpan(0, read));
        }

        return new CapturedOutput(output.ToString(), output.Truncated);
    }

    private static void DisposeJobOnFault(Task task, ChildProcessJob job)
    {
        _ = task.ContinueWith(
            static (completed, state) =>
            {
                if (!completed.IsCompletedSuccessfully) ((ChildProcessJob)state!).Dispose();
            },
            job,
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    private static void KillIfRunning(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // The process completed between HasExited and Kill.
        }
    }

    private sealed record CapturedOutput(string Text, bool Truncated);

    private sealed class BoundedTailBuffer(int capacity)
    {
        private readonly char[] buffer = new char[capacity];
        private int count;
        private int start;

        public bool Truncated { get; private set; }

        public void Append(ReadOnlySpan<char> value)
        {
            if (value.Length >= buffer.Length)
            {
                Truncated |= count > 0 || value.Length > buffer.Length;
                value[^buffer.Length..].CopyTo(buffer);
                start = 0;
                count = buffer.Length;
                return;
            }

            var overflow = Math.Max(0, count + value.Length - buffer.Length);
            if (overflow > 0)
            {
                start = (start + overflow) % buffer.Length;
                count -= overflow;
                Truncated = true;
            }

            var appendAt = (start + count) % buffer.Length;
            var firstLength = Math.Min(value.Length, buffer.Length - appendAt);
            value[..firstLength].CopyTo(buffer.AsSpan(appendAt));
            value[firstLength..].CopyTo(buffer);
            count += value.Length;
        }

        public override string ToString()
        {
            if (count == 0) return string.Empty;
            if (start + count <= buffer.Length) return new string(buffer, start, count);
            var firstLength = buffer.Length - start;
            return string.Concat(
                new string(buffer, start, firstLength),
                new string(buffer, 0, count - firstLength));
        }
    }
}
