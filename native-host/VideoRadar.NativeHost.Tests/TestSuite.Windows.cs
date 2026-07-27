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
    }

    private sealed class FakeWindowApi : IWindowApi
    {
        public HashSet<IntPtr> ValidWindows { get; } = [];
        public Dictionary<IntPtr, IntPtr> RootOwners { get; } = [];
        public IntPtr ForegroundWindow { get; init; }
        public IntPtr LastRestoredWindow { get; private set; }
        public IntPtr LastForegroundWindow { get; private set; }
        public IntPtr LastRaisedWindow { get; private set; }

        public bool IsWindow(IntPtr window) => ValidWindows.Contains(window);

        public IntPtr GetForegroundWindow() => ForegroundWindow;

        public IntPtr GetRootOwner(IntPtr window) =>
            RootOwners.TryGetValue(window, out var root) ? root : IntPtr.Zero;

        public void Restore(IntPtr window) => LastRestoredWindow = window;

        public void SetForeground(IntPtr window) => LastForegroundWindow = window;

        public void Raise(IntPtr window) => LastRaisedWindow = window;
    }
}
