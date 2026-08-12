using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace VideoRadar.NativeHost.Files;

public interface IDownloadPaths
{
    string Home { get; }
    string TempRoot { get; }
    string ReserveStem(string title, string videoId);
    string CreateJobTemp(string jobId);
    string? FindJobTemp(string jobId);
    bool ContainsFinalPath(string path);
    void ReleaseStem(string stem);
    void DeleteJobTemp(string jobId);
}

public sealed partial class DownloadPaths : IDownloadPaths
{
    private const int MaxStemLength = 180;
    private const int MaxBaseStemLength = 170;
    private const string InvalidPathCharacters = "<>:\"/\\|?*";
    private static readonly Guid DownloadsFolderId = new("374DE290-123F-4565-9164-39C4925E467B");
    private static readonly HashSet<string> ReservedNames = CreateReservedNames();
    private readonly object reservationLock = new();
    private readonly HashSet<string> reservations = new(StringComparer.OrdinalIgnoreCase);

    public DownloadPaths()
        : this(
            Path.Combine(GetDownloadsDirectory(), "Video Radar"),
            Path.Combine(GetLocalApplicationData(), "VideoRadar", "temp"))
    {
    }

    public DownloadPaths(string home, string tempRoot)
    {
        Home = NormalizeRoot(home, nameof(home));
        TempRoot = NormalizeRoot(tempRoot, nameof(tempRoot));
        Directory.CreateDirectory(Home);
        Directory.CreateDirectory(TempRoot);
        EnsureRegularDirectory(Home);
        EnsureRegularDirectory(TempRoot);
    }

    public string Home { get; }

    public string TempRoot { get; }

    public static string NormalizeDestination(string path, string parameterName = "path")
    {
        if (path is null
            || path.Length is 0 or > 1024
            || path.Contains('/')
            || path.StartsWith(@"\\?\", StringComparison.Ordinal)
            || path.StartsWith(@"\\.\", StringComparison.Ordinal)
            || path.StartsWith(@"\\??\", StringComparison.Ordinal))
        {
            throw new ArgumentException("Path must be absolute and canonical.", parameterName);
        }

        string[] segments;
        if (path.Length >= 3
            && char.IsAsciiLetter(path[0])
            && path[1] == ':'
            && path[2] == '\\')
        {
            segments = path.Length == 3 ? [] : path[3..].Split('\\', StringSplitOptions.None);
        }
        else if (path.StartsWith(@"\\", StringComparison.Ordinal))
        {
            segments = path[2..].Split('\\', StringSplitOptions.None);
            if (segments.Length < 2)
                throw new ArgumentException("Path must be absolute and canonical.", parameterName);
        }
        else
        {
            throw new ArgumentException("Path must be absolute and canonical.", parameterName);
        }

        if (segments.Any(IsInvalidPathSegment))
            throw new ArgumentException("Path must be absolute and canonical.", parameterName);

        string canonicalPath;
        try
        {
            canonicalPath = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw new ArgumentException("Path must be absolute and canonical.", parameterName, exception);
        }

        if (!string.Equals(path, canonicalPath, StringComparison.Ordinal))
            throw new ArgumentException("Path must be absolute and canonical.", parameterName);
        return canonicalPath;
    }

    public string ReserveStem(string title, string videoId)
    {
        var safeId = SanitizePart(videoId, 32, "video");
        var maxTitleLength = Math.Max(1, MaxBaseStemLength - safeId.Length - 3);
        var safeTitle = SanitizePart(title, maxTitleLength, "Video");
        var baseStem = EnsureSafeReservedName($"{safeTitle} [{safeId}]");
        if (baseStem.Length > MaxBaseStemLength) baseStem = baseStem[..MaxBaseStemLength].TrimEnd(' ', '.');

        lock (reservationLock)
        {
            for (var suffix = 1; ; suffix++)
            {
                var candidate = suffix == 1 ? baseStem : AppendSuffix(baseStem, $" ({suffix})");
                if (reservations.Contains(candidate) || HasExistingFile(candidate)) continue;
                reservations.Add(candidate);
                return candidate;
            }
        }
    }

    public string CreateJobTemp(string jobId)
    {
        ValidateJobId(jobId);
        var path = Path.GetFullPath(Path.Combine(TempRoot, jobId));
        if (!IsStrictChild(TempRoot, path)) throw new ArgumentException("Invalid job id.", nameof(jobId));
        Directory.CreateDirectory(path);
        EnsureRegularDirectory(TempRoot);
        EnsureRegularDirectory(path);
        return path;
    }

    public string? FindJobTemp(string jobId)
    {
        ValidateJobId(jobId);
        var path = Path.GetFullPath(Path.Combine(TempRoot, jobId));
        if (!IsStrictChild(TempRoot, path)) throw new ArgumentException("Invalid job id.", nameof(jobId));
        EnsureRegularDirectory(TempRoot);
        if (!Directory.Exists(path)) return null;
        EnsureRegularDirectory(path);
        return path;
    }

    public bool ContainsFinalPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)
            || !Path.IsPathFullyQualified(path)
            || HasTraversalSegment(path))
        {
            return false;
        }

        try
        {
            var candidate = Path.GetFullPath(path);
            if (!IsStrictChild(Home, candidate) || !File.Exists(candidate)) return false;
            var attributes = File.GetAttributes(candidate);
            return (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0;
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }
    }

    public void ReleaseStem(string stem)
    {
        if (!IsSafeStem(stem)) return;
        lock (reservationLock) reservations.Remove(stem);
    }

    public void DeleteJobTemp(string jobId)
    {
        ValidateJobId(jobId);
        var path = Path.GetFullPath(Path.Combine(TempRoot, jobId));
        if (!IsStrictChild(TempRoot, path)) throw new ArgumentException("Invalid job id.", nameof(jobId));
        EnsureRegularDirectory(TempRoot);
        if (Directory.Exists(path)) EnsureRegularDirectory(path);
        if (Directory.Exists(path)) DeleteDirectoryTree(path);
    }

    private bool HasExistingFile(string stem) =>
        File.Exists(Path.Combine(Home, stem))
        || Directory.EnumerateFiles(Home, $"{stem}.*", SearchOption.TopDirectoryOnly).Any();

    private static string AppendSuffix(string baseStem, string suffix)
    {
        var available = MaxStemLength - suffix.Length;
        var prefix = baseStem.Length <= available ? baseStem : baseStem[..available].TrimEnd(' ', '.');
        return $"{prefix}{suffix}";
    }

    private static string SanitizePart(string? value, int maxLength, string fallback)
    {
        var invalidCharacters = Path.GetInvalidFileNameChars();
        var builder = new StringBuilder();
        var previousWasWhitespace = false;
        foreach (var character in value ?? string.Empty)
        {
            var replacement = character is '/' or '\\' || invalidCharacters.Contains(character) || char.IsControl(character)
                ? ' '
                : character;
            if (char.IsWhiteSpace(replacement))
            {
                if (previousWasWhitespace) continue;
                previousWasWhitespace = true;
                builder.Append(' ');
            }
            else
            {
                previousWasWhitespace = false;
                builder.Append(replacement);
            }
        }

        var sanitized = builder.ToString().Replace("..", ".", StringComparison.Ordinal).Trim(' ', '.');
        while (sanitized.Contains("..", StringComparison.Ordinal))
            sanitized = sanitized.Replace("..", ".", StringComparison.Ordinal);
        if (sanitized.Length > maxLength) sanitized = sanitized[..maxLength].TrimEnd(' ', '.');
        if (string.IsNullOrWhiteSpace(sanitized)) sanitized = fallback;
        return EnsureSafeReservedName(sanitized);
    }

    private static string EnsureSafeReservedName(string value)
    {
        var deviceName = value.Split('.')[0].TrimEnd(' ', '.');
        return ReservedNames.Contains(deviceName) ? $"_{value}" : value;
    }

    internal static bool IsSafeOutputStem(string stem) => IsSafeStem(stem);

    private static bool IsSafeStem(string stem)
    {
        if (string.IsNullOrWhiteSpace(stem)
            || stem.Length > MaxStemLength
            || Path.IsPathFullyQualified(stem)
            || HasTraversalSegment(stem)
            || !string.Equals(stem, Path.GetFileName(stem), StringComparison.Ordinal)
            || stem.Any(character => Path.GetInvalidFileNameChars().Contains(character)))
        {
            return false;
        }

        return !ReservedNames.Contains(stem.Split('.')[0].TrimEnd(' ', '.'));
    }

    private static bool HasTraversalSegment(string path) =>
        path.Split(['/', '\\'], StringSplitOptions.None).Any(segment => segment is "." or "..");

    private static bool IsInvalidPathSegment(string segment)
    {
        if (segment.Length == 0
            || segment is "." or ".."
            || segment.EndsWith(' ')
            || segment.EndsWith('.')
            || segment.Any(character => char.IsControl(character) || InvalidPathCharacters.Contains(character)))
        {
            return true;
        }

        var extension = segment.IndexOf('.');
        var name = extension < 0 ? segment : segment[..extension];
        return ReservedNames.Contains(name);
    }

    private static bool IsStrictChild(string root, string candidate)
    {
        var prefix = Path.EndsInDirectorySeparator(root) ? root : root + Path.DirectorySeparatorChar;
        return candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    private static void EnsureRegularDirectory(string path)
    {
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Download directories cannot be reparse points.");
    }

    private static void DeleteDirectoryTree(string path)
    {
        foreach (var entry in Directory.EnumerateFileSystemEntries(path, "*", SearchOption.TopDirectoryOnly))
        {
            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.Directory) == 0)
            {
                File.Delete(entry);
                continue;
            }

            if ((attributes & FileAttributes.ReparsePoint) != 0)
                Directory.Delete(entry, recursive: false);
            else
                DeleteDirectoryTree(entry);
        }
        Directory.Delete(path, recursive: false);
    }

    private static string NormalizeRoot(string path, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
            throw new ArgumentException("Path must be absolute.", parameterName);
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
    }

    private static void ValidateJobId(string jobId)
    {
        if (string.IsNullOrEmpty(jobId) || !SafeJobId().IsMatch(jobId))
            throw new ArgumentException("Invalid job id.", nameof(jobId));
    }

    private static HashSet<string> CreateReservedNames()
    {
        var names = new HashSet<string>(["CON", "PRN", "AUX", "NUL"], StringComparer.OrdinalIgnoreCase);
        for (var index = 1; index <= 9; index++)
        {
            names.Add($"COM{index}");
            names.Add($"LPT{index}");
        }

        return names;
    }

    private static string GetLocalApplicationData()
    {
        var path = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(path)) throw new DirectoryNotFoundException("Local application data directory is unavailable.");
        return path;
    }

    private static string GetDownloadsDirectory()
    {
        if (!OperatingSystem.IsWindows())
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");

        var result = SHGetKnownFolderPath(in DownloadsFolderId, 0, 0, out var pointer);
        if (result != 0) throw new Win32Exception(result);
        try
        {
            return Marshal.PtrToStringUni(pointer)
                ?? throw new DirectoryNotFoundException("Downloads directory is unavailable.");
        }
        finally
        {
            Marshal.FreeCoTaskMem(pointer);
        }
    }

    [GeneratedRegex("^[A-Za-z0-9_-]{1,128}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeJobId();

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHGetKnownFolderPath(in Guid folderId, uint flags, nint token, out nint path);
}
