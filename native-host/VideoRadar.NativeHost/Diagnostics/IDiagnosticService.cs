namespace VideoRadar.NativeHost.Diagnostics;

public interface IDiagnosticService
{
    bool Enabled { get; }

    DiagnosticSummary GetSummary(string downloadFolder);

    void SetEnabled(bool enabled);

    void Record(string eventName, string? code = null);

    string Export(string destinationFolder, string downloadFolder);

    void Clear();
}

public sealed class NullDiagnosticService : IDiagnosticService
{
    public static NullDiagnosticService Instance { get; } = new();

    private NullDiagnosticService() { }

    public bool Enabled => false;
    public DiagnosticSummary GetSummary(string downloadFolder) =>
        throw new NotSupportedException("Diagnostics are unavailable.");
    public void SetEnabled(bool enabled) =>
        throw new NotSupportedException("Diagnostics are unavailable.");
    public void Record(string eventName, string? code = null) { }
    public string Export(string destinationFolder, string downloadFolder) =>
        throw new NotSupportedException("Diagnostics are unavailable.");
    public void Clear() =>
        throw new NotSupportedException("Diagnostics are unavailable.");
}

public sealed record DiagnosticSummary(
    DateTimeOffset GeneratedAt,
    string HostVersion,
    int ProtocolVersion,
    string Architecture,
    string OperatingSystem,
    long? AvailableBytes,
    bool LoggingEnabled,
    int LogFileCount,
    IReadOnlyList<DiagnosticTool> Tools);

public sealed record DiagnosticTool(
    string Name,
    bool Available,
    string? Version,
    long? SizeBytes,
    string? Sha256);
