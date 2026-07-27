using VideoRadar.NativeHost.Windows;

namespace VideoRadar.NativeHost.Tests;

internal static partial class TestSuite
{
    private static void DialogOwnerWindowTests()
    {
        var suppliedParent = new IntPtr(101);
        var suppliedRoot = new IntPtr(102);
        var foreground = new IntPtr(201);
        var foregroundRoot = new IntPtr(202);
        var api = new FakeWindowApi
        {
            ForegroundWindow = foreground
        };
        api.ValidWindows.UnionWith([suppliedParent, suppliedRoot, foreground, foregroundRoot]);
        api.RootOwners[suppliedParent] = suppliedRoot;
        api.RootOwners[foreground] = foregroundRoot;

        var owner = new DialogOwnerWindow(api);

        Equal(suppliedRoot, owner.Resolve(suppliedParent));
        Equal(foregroundRoot, owner.Resolve(IntPtr.Zero));

        api.ValidWindows.Remove(suppliedParent);
        Equal(foregroundRoot, owner.Resolve(suppliedParent));

        owner.Activate(foregroundRoot);
        Equal(foregroundRoot, api.LastRestoredWindow);
        Equal(foregroundRoot, api.LastForegroundWindow);
        Equal(foregroundRoot, api.LastRaisedWindow);

        var browserWindow = new IntPtr(401);
        var explorerWindow = new IntPtr(402);
        var blockedApi = new FakeWindowApi
        {
            ForegroundWindow = browserWindow,
            DirectActivationSucceeds = false
        };
        blockedApi.ValidWindows.UnionWith([browserWindow, explorerWindow]);

        new DialogOwnerWindow(blockedApi).Activate(explorerWindow);

        Equal(1, blockedApi.AttachedActivationCount);
        Equal(explorerWindow, blockedApi.ForegroundWindow);
    }

    private static void ExplorerFileRevealerTests()
    {
        True(
            WindowsFileUrl.TryConvert(
                "file:///C:/Users/Carlos/Documents/Extens%E3o%20Chrome/Video%20Radar",
                out var decodedFolder),
            "Windows Shell file URL was not converted.");
        Equal(@"C:\Users\Carlos\Documents\Extensão Chrome\Video Radar", decodedFolder);

        var explorerWindow = new IntPtr(301);
        var windowApi = new FakeWindowApi();
        windowApi.ValidWindows.Add(explorerWindow);
        var shell = new FakeExplorerShell();
        shell.Windows.Enqueue(IntPtr.Zero);
        shell.Windows.Enqueue(explorerWindow);
        var delayCount = 0;
        var revealer = new ExplorerFileRevealer(
            shell,
            new DialogOwnerWindow(windowApi),
            _ => delayCount++);
        const string path = @"C:\Users\Carlos\Downloads\Video Radar\video.mp4";

        revealer.Reveal(path);

        Equal(path, shell.OpenedPath);
        Equal(@"C:\Users\Carlos\Downloads\Video Radar", shell.SearchedFolders[0]);
        Equal(@"C:\Users\Carlos\Downloads\Video Radar", shell.SearchedFolders[1]);
        Equal(1, delayCount);
        Equal(explorerWindow, windowApi.LastRestoredWindow);
        Equal(explorerWindow, windowApi.LastForegroundWindow);
        Equal(explorerWindow, windowApi.LastRaisedWindow);
    }

    private sealed class FakeWindowApi : IWindowApi
    {
        public HashSet<IntPtr> ValidWindows { get; } = [];
        public Dictionary<IntPtr, IntPtr> RootOwners { get; } = [];
        public IntPtr ForegroundWindow { get; set; }
        public bool DirectActivationSucceeds { get; init; } = true;
        public int AttachedActivationCount { get; private set; }
        public IntPtr LastRestoredWindow { get; private set; }
        public IntPtr LastForegroundWindow { get; private set; }
        public IntPtr LastRaisedWindow { get; private set; }

        public bool IsWindow(IntPtr window) => ValidWindows.Contains(window);

        public IntPtr GetForegroundWindow() => ForegroundWindow;

        public IntPtr GetRootOwner(IntPtr window) =>
            RootOwners.TryGetValue(window, out var root) ? root : IntPtr.Zero;

        public void Restore(IntPtr window) => LastRestoredWindow = window;

        public void SetForeground(IntPtr window)
        {
            LastForegroundWindow = window;
            if (DirectActivationSucceeds) ForegroundWindow = window;
        }

        public void Raise(IntPtr window) => LastRaisedWindow = window;

        public void AttachToForegroundAndActivate(IntPtr window)
        {
            AttachedActivationCount++;
            ForegroundWindow = window;
        }
    }

    private sealed class FakeExplorerShell : IExplorerShell
    {
        public Queue<IntPtr> Windows { get; } = [];
        public List<string> SearchedFolders { get; } = [];
        public string? OpenedPath { get; private set; }

        public void OpenFolderAndSelect(string path) => OpenedPath = path;

        public IntPtr FindWindow(string folder)
        {
            SearchedFolders.Add(folder);
            return Windows.Dequeue();
        }
    }
}
