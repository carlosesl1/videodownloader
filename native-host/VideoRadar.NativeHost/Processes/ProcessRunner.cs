using System.Diagnostics;
using System.Text;

namespace VideoRadar.NativeHost.Processes;

public sealed class ProcessRunner : IProcessRunner
{
    public async Task<ProcessResult> RunAsync(string executable, IReadOnlyList<string> arguments, Func<string, Task>? onOutput, CancellationToken cancellationToken)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo(executable)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            }
        };
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);

        process.Start();
        using var cancellationRegistration = cancellationToken.Register(() => KillIfRunning(process));

        var standardOutputTask = ReadStandardOutputAsync(process.StandardOutput, onOutput);
        var standardErrorTask = process.StandardError.ReadToEndAsync();
        var exitTask = process.WaitForExitAsync();
        await Task.WhenAll(standardOutputTask, standardErrorTask, exitTask);

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
