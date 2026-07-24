namespace VideoRadar.NativeHost.Files;

public interface IDownloadPathsFactory
{
    IDownloadPaths Create(string? destinationFolder);
}
