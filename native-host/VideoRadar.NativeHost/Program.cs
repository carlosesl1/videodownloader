namespace VideoRadar.NativeHost;

internal static class Program
{
    private static int Main()
    {
        Console.Error.WriteLine($"{HostInfo.NativeName} v{HostInfo.ProtocolVersion}");
        return 0;
    }
}
