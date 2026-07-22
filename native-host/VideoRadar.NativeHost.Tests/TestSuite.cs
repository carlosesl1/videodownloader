namespace VideoRadar.NativeHost.Tests;

internal static partial class TestSuite
{
    public static void RunAll() => HostInfoTest();

    private static void HostInfoTest()
    {
        Equal("com.videoradar.helper", global::VideoRadar.NativeHost.HostInfo.NativeName);
    }

    internal static void Equal<T>(T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new InvalidOperationException($"Expected {expected}, received {actual}");
    }

    internal static void True(bool value, string message)
    {
        if (!value) throw new InvalidOperationException(message);
    }
}
