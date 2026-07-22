using System.Text.RegularExpressions;

namespace VideoRadar.NativeHost.YouTube;

public static class YouTubeUrl
{
    private static readonly Regex VideoId = new("^[A-Za-z0-9_-]{11}$", RegexOptions.CultureInvariant);

    public static bool TryCanonicalize(string url, out string canonical)
    {
        canonical = string.Empty;
        if (!HasSafeRawAuthorityAndPath(url)
            || !Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || !string.IsNullOrEmpty(uri.UserInfo)
            || !uri.IsDefaultPort)
        {
            return false;
        }

        string? videoId = null;
        if (IsWatchHost(uri.Host) && string.Equals(uri.AbsolutePath, "/watch", StringComparison.Ordinal))
        {
            videoId = GetSingleQueryValue(uri.Query, "v");
        }
        else if (string.Equals(uri.Host, "youtu.be", StringComparison.OrdinalIgnoreCase))
        {
            var path = uri.AbsolutePath;
            if (path.Length == 12 && path[0] == '/') videoId = path[1..];
        }

        if (videoId is null || !VideoId.IsMatch(videoId)) return false;

        canonical = $"https://www.youtube.com/watch?v={videoId}";
        return true;
    }

    private static bool HasSafeRawAuthorityAndPath(string url)
    {
        if (string.IsNullOrEmpty(url)) return false;

        var schemeSeparator = url.IndexOf("://", StringComparison.Ordinal);
        if (schemeSeparator < 0) return false;

        var authorityStart = schemeSeparator + 3;
        var authorityEnd = FindDelimiter(url, authorityStart, includePathSeparators: true);
        if (url.AsSpan(authorityStart, authorityEnd - authorityStart).Contains('@')) return false;
        if (authorityEnd == url.Length || url[authorityEnd] is not ('/' or '\\')) return true;

        var pathEnd = FindDelimiter(url, authorityEnd, includePathSeparators: false);
        return !HasDotSegment(url.AsSpan(authorityEnd, pathEnd - authorityEnd));
    }

    private static int FindDelimiter(string value, int start, bool includePathSeparators)
    {
        for (var index = start; index < value.Length; index++)
        {
            if (value[index] is '?' or '#'
                || (includePathSeparators && value[index] is '/' or '\\'))
            {
                return index;
            }
        }

        return value.Length;
    }

    private static bool HasDotSegment(ReadOnlySpan<char> path)
    {
        var segmentStart = 0;
        for (var index = 0; index <= path.Length; index++)
        {
            if (index != path.Length && path[index] is not ('/' or '\\')) continue;

            var segment = path[segmentStart..index];
            if (segment.SequenceEqual(".".AsSpan())
                || segment.SequenceEqual("..".AsSpan())
                || Uri.UnescapeDataString(segment.ToString()) is "." or "..")
            {
                return true;
            }

            segmentStart = index + 1;
        }

        return false;
    }

    private static bool IsWatchHost(string host) =>
        string.Equals(host, "youtube.com", StringComparison.OrdinalIgnoreCase)
        || string.Equals(host, "www.youtube.com", StringComparison.OrdinalIgnoreCase)
        || string.Equals(host, "m.youtube.com", StringComparison.OrdinalIgnoreCase);

    private static string? GetSingleQueryValue(string query, string name)
    {
        string? result = null;
        foreach (var pair in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = pair.IndexOf('=');
            var key = separator < 0 ? pair : pair[..separator];
            if (!string.Equals(key, name, StringComparison.Ordinal)) continue;
            if (result is not null) return null;

            result = separator < 0 ? string.Empty : Uri.UnescapeDataString(pair[(separator + 1)..]);
        }

        return result;
    }
}
