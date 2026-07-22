namespace VideoRadar.NativeHost.Processes;

public sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError);

public interface IProcessRunner
{
    Task<ProcessResult> RunAsync(string executable, IReadOnlyList<string> arguments, Func<string, Task>? onOutput, CancellationToken cancellationToken);
}
