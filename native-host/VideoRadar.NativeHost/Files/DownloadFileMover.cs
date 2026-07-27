using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace VideoRadar.NativeHost.Files;

public sealed class DownloadFileMover : IDownloadFileMover
{
    private static readonly Regex SafeOperationId =
        new("^[A-Za-z0-9_-]{1,128}$", RegexOptions.CultureInvariant);
    private readonly IFileTransfer transfer;

    public DownloadFileMover()
        : this(new FileTransfer())
    {
    }

    internal DownloadFileMover(IFileTransfer transfer)
    {
        this.transfer = transfer ?? throw new ArgumentNullException(nameof(transfer));
    }

    public FileMoveResult Move(string sourcePath, string destinationFolder, long downloadId)
    {
        if (downloadId < 0)
            throw new ArgumentOutOfRangeException(nameof(downloadId));

        var source = DownloadPaths.NormalizeDestination(sourcePath, nameof(sourcePath));
        ValidateStagingSource(source);
        var destination = DownloadPaths.NormalizeDestination(destinationFolder, nameof(destinationFolder));

        Directory.CreateDirectory(destination);
        EnsureWritable(destination);
        var finalPath = ReserveFinalPath(destination, Path.GetFileName(source));

        if (transfer.IsSameVolume(source, finalPath))
        {
            transfer.MoveSameVolume(source, finalPath);
            return new FileMoveResult(downloadId, finalPath);
        }

        CopyAcrossVolumes(source, finalPath);
        return new FileMoveResult(downloadId, finalPath);
    }

    public void Reveal(string path)
    {
        var canonical = DownloadPaths.NormalizeDestination(path, nameof(path));
        if (!File.Exists(canonical))
            throw new FileNotFoundException("Downloaded file was not found.", canonical);
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Windows Explorer is required.");

        var result = SHParseDisplayName(canonical, IntPtr.Zero, out var item, 0, IntPtr.Zero);
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

    private void ValidateStagingSource(string source)
    {
        if (!File.Exists(source))
            throw new ArgumentException("Staging source must be an existing file.", nameof(source));

        var fileName = Path.GetFileName(source);
        var operationDirectory = Directory.GetParent(source);
        var stagingDirectory = operationDirectory?.Parent;
        var videoRadarDirectory = stagingDirectory?.Parent;
        var browserDownloadRoot = videoRadarDirectory?.Parent;

        if (string.IsNullOrEmpty(fileName)
            || operationDirectory is null
            || stagingDirectory is null
            || videoRadarDirectory is null
            || browserDownloadRoot is null
            || !SafeOperationId.IsMatch(operationDirectory.Name)
            || !string.Equals(stagingDirectory.Name, ".staging", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(videoRadarDirectory.Name, "Video Radar", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("Staging source has an invalid structure.", nameof(source));
        }

        for (var current = source; current is not null;)
        {
            var attributes = transfer.GetAttributes(current);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("Staging source cannot traverse reparse points.", nameof(source));
            if (string.Equals(current, source, StringComparison.OrdinalIgnoreCase)
                && (attributes & FileAttributes.Directory) != 0)
            {
                throw new ArgumentException("Staging source must be a regular file.", nameof(source));
            }

            current = Directory.GetParent(current)?.FullName;
        }
    }

    private static void EnsureWritable(string destination)
    {
        var probe = Path.Combine(destination, $".video-radar-{Guid.NewGuid():N}.probe");
        try
        {
            using var stream = new FileStream(
                probe,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 1,
                FileOptions.WriteThrough);
            stream.WriteByte(0);
            stream.Flush(flushToDisk: true);
        }
        finally
        {
            if (File.Exists(probe)) File.Delete(probe);
        }
    }

    private static string ReserveFinalPath(string destination, string fileName)
    {
        var extension = Path.GetExtension(fileName);
        var stem = Path.GetFileNameWithoutExtension(fileName);
        if (stem.Length == 0)
        {
            stem = fileName;
            extension = string.Empty;
        }

        for (var suffix = 0; ; suffix++)
        {
            var candidateName = suffix == 0
                ? fileName
                : $"{stem} ({suffix}){extension}";
            var candidate = Path.Combine(destination, candidateName);
            if (!File.Exists(candidate) && !Directory.Exists(candidate))
                return candidate;
        }
    }

    private void CopyAcrossVolumes(string source, string finalPath)
    {
        var destination = Path.GetDirectoryName(finalPath)
            ?? throw new IOException("Destination directory is unavailable.");
        var partial = Path.Combine(destination, $".video-radar-{Guid.NewGuid():N}.partial");

        try
        {
            transfer.CopyToPartial(source, partial);
            transfer.PromotePartial(partial, finalPath);
        }
        catch
        {
            try
            {
                transfer.DeletePartial(partial);
            }
            catch
            {
                // The staging source remains the recovery copy even if partial cleanup fails.
            }
            throw;
        }

        try
        {
            transfer.DeleteSource(source);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Delivery is already complete. Keeping staging is safer than making a retry duplicate it.
        }
    }

    private sealed class FileTransfer : IFileTransfer
    {
        public FileAttributes GetAttributes(string path) => File.GetAttributes(path);

        public bool IsSameVolume(string source, string destination)
        {
            var sourceRoot = Path.GetPathRoot(source);
            var destinationRoot = Path.GetPathRoot(destination);
            return !string.IsNullOrEmpty(sourceRoot)
                && !string.IsNullOrEmpty(destinationRoot)
                && string.Equals(sourceRoot, destinationRoot, StringComparison.OrdinalIgnoreCase);
        }

        public void MoveSameVolume(string source, string destination) =>
            File.Move(source, destination, overwrite: false);

        public void CopyToPartial(string source, string partial)
        {
            using var sourceStream = new FileStream(
                source,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 1024 * 1024,
                FileOptions.SequentialScan);
            using var partialStream = new FileStream(
                partial,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 1024 * 1024,
                FileOptions.SequentialScan);
            sourceStream.CopyTo(partialStream);
            partialStream.Flush(flushToDisk: true);
        }

        public void PromotePartial(string partial, string destination) =>
            File.Move(partial, destination, overwrite: false);

        public void DeleteSource(string source) => File.Delete(source);

        public void DeletePartial(string partial)
        {
            if (File.Exists(partial)) File.Delete(partial);
        }
    }
}
