namespace VideoRadar.NativeHost.Files;

public sealed class DownloadPathsFactory(string fallbackHome, string tempRoot)
    : IDownloadPathsFactory
{
    private readonly string fallbackHome =
        DownloadPaths.NormalizeDestination(fallbackHome, nameof(fallbackHome));
    private readonly string tempRoot =
        DownloadPaths.NormalizeDestination(tempRoot, nameof(tempRoot));

    public IDownloadPaths Create(string? destinationFolder) =>
        new DownloadPaths(
            destinationFolder is null
                ? fallbackHome
                : DownloadPaths.NormalizeDestination(destinationFolder, nameof(destinationFolder)),
            tempRoot);
}
