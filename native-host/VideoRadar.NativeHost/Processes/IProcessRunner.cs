namespace VideoRadar.NativeHost.Processes;

public sealed record ProcessResult(
    int ExitCode,
    string StandardOutput,
    string StandardError,
    bool StandardOutputTruncated = false,
    bool StandardErrorTruncated = false);

public interface IProcessRunner
{
    Task<ProcessResult> RunAsync(string executable, IReadOnlyList<string> arguments, Func<string, Task>? onOutput, CancellationToken cancellationToken);
}
