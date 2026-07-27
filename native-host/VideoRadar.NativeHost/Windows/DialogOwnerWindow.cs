using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace VideoRadar.NativeHost.Windows;

internal interface IWindowApi
{
    bool IsWindow(IntPtr window);
    IntPtr GetForegroundWindow();
    IntPtr GetRootOwner(IntPtr window);
    void Restore(IntPtr window);
    void SetForeground(IntPtr window);
    void Raise(IntPtr window);
}

internal sealed class DialogOwnerWindow(IWindowApi api)
{
    public IntPtr Resolve(IntPtr suppliedParent)
    {
        if (api.IsWindow(suppliedParent))
            return Normalize(suppliedParent);

        var foreground = api.GetForegroundWindow();
        return api.IsWindow(foreground) ? Normalize(foreground) : IntPtr.Zero;
    }

    public void Activate(IntPtr owner)
    {
        if (!api.IsWindow(owner)) return;

        api.Restore(owner);
        api.Raise(owner);
        api.SetForeground(owner);
    }

    private IntPtr Normalize(IntPtr window)
    {
        var rootOwner = api.GetRootOwner(window);
        return api.IsWindow(rootOwner) ? rootOwner : window;
    }
}

[SupportedOSPlatform("windows")]
internal sealed class User32WindowApi : IWindowApi
{
    private const uint GaRootOwner = 3;
    private const int SwRestore = 9;

    public bool IsWindow(IntPtr window) =>
        window != IntPtr.Zero && NativeMethods.IsWindow(window);

    public IntPtr GetForegroundWindow() => NativeMethods.GetForegroundWindow();

    public IntPtr GetRootOwner(IntPtr window) =>
        NativeMethods.GetAncestor(window, GaRootOwner);

    public void Restore(IntPtr window)
    {
        if (NativeMethods.IsIconic(window))
            _ = NativeMethods.ShowWindowAsync(window, SwRestore);
    }

    public void SetForeground(IntPtr window) =>
        _ = NativeMethods.SetForegroundWindow(window);

    public void Raise(IntPtr window) =>
        _ = NativeMethods.BringWindowToTop(window);

    private static class NativeMethods
    {
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsWindow(IntPtr window);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        internal static extern IntPtr GetAncestor(IntPtr window, uint flags);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsIconic(IntPtr window);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ShowWindowAsync(IntPtr window, int command);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetForegroundWindow(IntPtr window);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool BringWindowToTop(IntPtr window);
    }
}
