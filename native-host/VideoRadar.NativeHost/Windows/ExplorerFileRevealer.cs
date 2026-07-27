using System.Runtime.InteropServices;
using System.Text;

namespace VideoRadar.NativeHost.Windows;

internal interface IExplorerShell
{
    void OpenFolderAndSelect(string path);
    IntPtr FindWindow(string folder);
}

internal sealed class ExplorerFileRevealer
{
    private static readonly TimeSpan WindowSearchDelay = TimeSpan.FromMilliseconds(50);
    private const int WindowSearchAttempts = 40;
    private readonly IExplorerShell shell;
    private readonly DialogOwnerWindow ownerWindow;
    private readonly Action<TimeSpan> delay;

    public ExplorerFileRevealer()
        : this(
            new WindowsExplorerShell(),
            new DialogOwnerWindow(new User32WindowApi()),
            Thread.Sleep)
    {
    }

    internal ExplorerFileRevealer(
        IExplorerShell shell,
        DialogOwnerWindow ownerWindow,
        Action<TimeSpan> delay)
    {
        this.shell = shell;
        this.ownerWindow = ownerWindow;
        this.delay = delay;
    }

    public void Reveal(string path)
    {
        var folder = Path.GetDirectoryName(path)
            ?? throw new ArgumentException("The downloaded file has no parent folder.", nameof(path));

        shell.OpenFolderAndSelect(path);
        for (var attempt = 0; attempt < WindowSearchAttempts; attempt++)
        {
            var window = shell.FindWindow(folder);
            if (window != IntPtr.Zero)
            {
                ownerWindow.Activate(window);
                return;
            }

            if (attempt + 1 < WindowSearchAttempts)
                delay(WindowSearchDelay);
        }
    }
}

internal sealed class WindowsExplorerShell : IExplorerShell
{
    private static readonly Guid ShellWindowsClsid =
        new("9BA05972-F6A8-11CF-A442-00A0C90A8F39");

    public void OpenFolderAndSelect(string path)
    {
        var result = SHParseDisplayName(path, IntPtr.Zero, out var item, 0, IntPtr.Zero);
        Marshal.ThrowExceptionForHR(result);
        try
        {
            result = SHOpenFolderAndSelectItems(item, 0, IntPtr.Zero, 0);
            Marshal.ThrowExceptionForHR(result);
        }
        finally
        {
            Marshal.FreeCoTaskMem(item);
        }
    }

    public IntPtr FindWindow(string folder)
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Windows Explorer is required.");

        object? windowsObject = null;
        try
        {
            var windowsType = Type.GetTypeFromCLSID(ShellWindowsClsid, throwOnError: true)
                ?? throw new InvalidOperationException("Windows Explorer is unavailable.");
            windowsObject = Activator.CreateInstance(windowsType)
                ?? throw new InvalidOperationException("Windows Explorer windows could not be enumerated.");
            dynamic windows = windowsObject;
            var count = Convert.ToInt32(windows.Count);

            for (var index = count - 1; index >= 0; index--)
            {
                object? windowObject = null;
                try
                {
                    windowObject = windows.Item(index);
                    if (windowObject is null) continue;
                    dynamic window = windowObject;
                    var location = Convert.ToString(window.LocationURL);
                    if (!WindowsFileUrl.TryConvert(location, out string windowFolder)
                        || !string.Equals(
                            NormalizeFolder(windowFolder),
                            NormalizeFolder(folder),
                            StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    return new IntPtr(Convert.ToInt64(window.HWND));
                }
                catch (COMException)
                {
                    // Explorer can replace a tab while its windows collection is being enumerated.
                }
                finally
                {
                    FinalRelease(windowObject);
                }
            }
        }
        catch (COMException)
        {
            // Explorer may still be creating the requested window; the caller retries briefly.
        }
        finally
        {
            FinalRelease(windowsObject);
        }

        return IntPtr.Zero;
    }

    private static string NormalizeFolder(string folder) =>
        Path.GetFullPath(folder).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar);

    private static void FinalRelease(object? value)
    {
        if (!OperatingSystem.IsWindows()) return;
        if (value is not null && Marshal.IsComObject(value))
            Marshal.FinalReleaseComObject(value);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHParseDisplayName(
        string name,
        IntPtr bindContext,
        out IntPtr item,
        uint attributesIn,
        IntPtr attributesOut);

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern int SHOpenFolderAndSelectItems(
        IntPtr folder,
        uint itemCount,
        IntPtr items,
        uint flags);
}

internal static class WindowsFileUrl
{
    private const int MaximumPathLength = 32768;

    public static bool TryConvert(string? location, out string path)
    {
        path = string.Empty;
        if (string.IsNullOrWhiteSpace(location)
            || !location.StartsWith("file:", StringComparison.OrdinalIgnoreCase)
            || !OperatingSystem.IsWindows())
        {
            return false;
        }

        var buffer = new StringBuilder(MaximumPathLength);
        var length = (uint)buffer.Capacity;
        var result = PathCreateFromUrl(location, buffer, ref length, 0);
        if (result < 0) return false;

        path = buffer.ToString();
        return Path.IsPathFullyQualified(path);
    }

    [DllImport("shlwapi.dll", EntryPoint = "PathCreateFromUrlW", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int PathCreateFromUrl(
        string url,
        StringBuilder path,
        ref uint pathLength,
        uint flags);
}
