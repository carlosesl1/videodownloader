namespace VideoRadar.NativeHost.Windows;

public interface IFolderPicker
{
    Task<string?> PickAsync(CancellationToken cancellationToken);
}
