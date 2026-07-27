using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("VideoRadar.NativeHost.Tests")]

namespace VideoRadar.NativeHost.Files;

public sealed record FileMoveResult(long DownloadId, string FinalPath);

public interface IDownloadFileMover
{
    FileMoveResult Move(string sourcePath, string destinationFolder, long downloadId);
    void Reveal(string path);
}

internal interface IFileTransfer
{
    FileAttributes GetAttributes(string path);
    bool IsSameVolume(string source, string destination);
    void MoveSameVolume(string source, string destination);
    void CopyToPartial(string source, string partial);
    void PromotePartial(string partial, string destination);
    void DeleteSource(string source);
    void DeletePartial(string partial);
}
