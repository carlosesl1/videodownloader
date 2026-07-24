using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace VideoRadar.NativeHost.Windows;

[SupportedOSPlatform("windows")]
public sealed class WindowsFolderPicker : IFolderPicker
{
    private static readonly Guid FileOpenDialogClsid = new("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7");
    private const uint FosPickFolders = 0x00000020;
    private const uint FosForceFileSystem = 0x00000040;
    private const uint FosPathMustExist = 0x00000800;
    private const uint FosDontAddToRecent = 0x02000000;
    private const uint SigdnFileSystemPath = 0x80058000;
    private const int ErrorCancelled = unchecked((int)0x800704C7);

    public Task<string?> PickAsync(CancellationToken cancellationToken)
    {
        var completion = new TaskCompletionSource<string?>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        if (cancellationToken.IsCancellationRequested)
        {
            completion.TrySetCanceled(cancellationToken);
            return completion.Task;
        }

        var thread = new Thread(() =>
        {
            try
            {
                completion.TrySetResult(ShowDialog());
            }
            catch (Exception exception)
            {
                completion.TrySetException(exception);
            }
        })
        {
            IsBackground = true,
            Name = "Video Radar folder picker"
        };

        try
        {
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
        }
        catch (Exception exception)
        {
            completion.TrySetException(exception);
        }

        return completion.Task;
    }

    private static string? ShowDialog()
    {
        object? dialogObject = null;
        IShellItem? shellItem = null;
        var pathPointer = IntPtr.Zero;
        try
        {
            var dialogType = Type.GetTypeFromCLSID(FileOpenDialogClsid, throwOnError: true)
                ?? throw new InvalidOperationException("FileOpenDialog is unavailable.");
            dialogObject = Activator.CreateInstance(dialogType)
                ?? throw new InvalidOperationException("FileOpenDialog could not be created.");
            var dialog = (IFileOpenDialog)dialogObject;

            Marshal.ThrowExceptionForHR(dialog.SetOptions(
                FosPickFolders
                | FosForceFileSystem
                | FosPathMustExist
                | FosDontAddToRecent));
            Marshal.ThrowExceptionForHR(dialog.SetTitle("Escolha a pasta dos downloads"));

            var showResult = dialog.Show(IntPtr.Zero);
            if (showResult == ErrorCancelled) return null;
            Marshal.ThrowExceptionForHR(showResult);

            Marshal.ThrowExceptionForHR(dialog.GetResult(out var result));
            shellItem = result;
            Marshal.ThrowExceptionForHR(shellItem.GetDisplayName(SigdnFileSystemPath, out pathPointer));
            return Marshal.PtrToStringUni(pathPointer)
                ?? throw new InvalidDataException("The selected folder has no filesystem path.");
        }
        finally
        {
            if (pathPointer != IntPtr.Zero) Marshal.FreeCoTaskMem(pathPointer);
            FinalRelease(shellItem);
            FinalRelease(dialogObject);
        }
    }

    private static void FinalRelease(object? value)
    {
        if (value is not null && Marshal.IsComObject(value))
            Marshal.FinalReleaseComObject(value);
    }

    [ComImport]
    [Guid("D57C7288-D4AD-4768-BE02-9D969532D960")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        // IModalWindow
        [PreserveSig]
        int Show(IntPtr parent);

        // IFileDialog
        [PreserveSig]
        int SetFileTypes(uint fileTypeCount, IntPtr filterSpecs);

        [PreserveSig]
        int SetFileTypeIndex(uint fileTypeIndex);

        [PreserveSig]
        int GetFileTypeIndex(out uint fileTypeIndex);

        [PreserveSig]
        int Advise(IntPtr events, out uint cookie);

        [PreserveSig]
        int Unadvise(uint cookie);

        [PreserveSig]
        int SetOptions(uint options);

        [PreserveSig]
        int GetOptions(out uint options);

        [PreserveSig]
        int SetDefaultFolder([MarshalAs(UnmanagedType.Interface)] IShellItem shellItem);

        [PreserveSig]
        int SetFolder([MarshalAs(UnmanagedType.Interface)] IShellItem shellItem);

        [PreserveSig]
        int GetFolder([MarshalAs(UnmanagedType.Interface)] out IShellItem shellItem);

        [PreserveSig]
        int GetCurrentSelection([MarshalAs(UnmanagedType.Interface)] out IShellItem shellItem);

        [PreserveSig]
        int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string fileName);

        [PreserveSig]
        int GetFileName(out IntPtr fileName);

        [PreserveSig]
        int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);

        [PreserveSig]
        int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);

        [PreserveSig]
        int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);

        [PreserveSig]
        int GetResult([MarshalAs(UnmanagedType.Interface)] out IShellItem shellItem);

        [PreserveSig]
        int AddPlace([MarshalAs(UnmanagedType.Interface)] IShellItem shellItem, uint alignment);

        [PreserveSig]
        int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string defaultExtension);

        [PreserveSig]
        int Close(int result);

        [PreserveSig]
        int SetClientGuid(ref Guid clientGuid);

        [PreserveSig]
        int ClearClientData();

        [PreserveSig]
        int SetFilter(IntPtr filter);

        // IFileOpenDialog
        [PreserveSig]
        int GetResults(out IntPtr shellItems);

        [PreserveSig]
        int GetSelectedItems(out IntPtr shellItems);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        [PreserveSig]
        int BindToHandler(IntPtr bindContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr value);

        [PreserveSig]
        int GetParent([MarshalAs(UnmanagedType.Interface)] out IShellItem shellItem);

        [PreserveSig]
        int GetDisplayName(uint displayNameType, out IntPtr displayName);

        [PreserveSig]
        int GetAttributes(uint mask, out uint attributes);

        [PreserveSig]
        int Compare([MarshalAs(UnmanagedType.Interface)] IShellItem shellItem, uint hint, out int order);
    }
}
