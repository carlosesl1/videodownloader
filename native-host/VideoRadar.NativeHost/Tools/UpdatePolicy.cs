using VideoRadar.NativeHost.Processes;

namespace VideoRadar.NativeHost.Tools;

public interface IUpdatePolicy
{
    Task CheckAsync(CancellationToken cancellationToken);
}

public sealed class UpdatePolicy : IUpdatePolicy
{
    public UpdatePolicy(string toolsDirectory, IProcessRunner processRunner)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(toolsDirectory);
        ArgumentNullException.ThrowIfNull(processRunner);
    }

    public Task CheckAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.CompletedTask;
    }
}
