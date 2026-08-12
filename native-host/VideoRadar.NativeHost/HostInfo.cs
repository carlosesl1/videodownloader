namespace VideoRadar.NativeHost;

public static class HostInfo
{
    public const string NativeName = "com.videoradar.helper";
    public const string AllowedOrigin = "chrome-extension://cakpfifpfmbdcilimpedanglnopnmckg/";
    public const string Version = "1.2.0";
    public const int ProtocolVersion = 5;
    public static IReadOnlyList<string> Capabilities { get; } = Array.AsReadOnly(
        new[]
        {
            "idempotentStart",
            "idempotentFileMove",
            "jobReconciliation",
            "boundedProcessOutput",
            "durableQueue",
            "pauseResume",
            "restartRecovery",
            "richMediaCatalog",
            "ffprobeValidation",
            "diagnosticsExport",
            "arm64"
        });
}
