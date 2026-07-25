using System.Diagnostics;
using System.Text;
using VideoRadar.NativeHost.Windows;

namespace VideoRadar.NativeHost.Processes;

public sealed class ProcessRunner : IProcessRunner
{
    public async Task<ProcessResult> RunAsync(string executable, IReadOnlyList<string> arguments, Func<string, Task>? onOutput, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(executable);
        ArgumentNullException.ThrowIfNull(arguments);
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
        process.StandardInput.Close();
        try
        {
            job.Assign(process);
        }
        catch
        {
            KillIfRunning(process);
            throw;
        }

        using var cancellationRegistration = cancellationToken.Register(static state => ((ChildProcessJob)state!).Dispose(), job);

        var standardOutputTask = ReadStandardOutputAsync(process.StandardOutput, onOutput);
        var standardErrorTask = process.StandardError.ReadToEndAsync();
        var exitTask = process.WaitForExitAsync();
        try
        {
            await Task.WhenAll(standardOutputTask, standardErrorTask, exitTask);
        }
        catch when (cancellationToken.IsCancellationRequested)
        {
            cancellationToken.ThrowIfCancellationRequested();
            throw;
        }

        cancellationToken.ThrowIfCancellationRequested();
        return new ProcessResult(process.ExitCode, await standardOutputTask, await standardErrorTask);
    }

    private static async Task<string> ReadStandardOutputAsync(StreamReader reader, Func<string, Task>? onOutput)
    {
        var output = new StringBuilder();
        string? line;
        while ((line = await reader.ReadLineAsync()) is not null)
        {
            output.AppendLine(line);
            if (onOutput is not null) await onOutput(line);
        }

        return output.ToString();
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
}
