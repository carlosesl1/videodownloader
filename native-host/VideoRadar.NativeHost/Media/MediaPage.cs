using System.Text.RegularExpressions;

namespace VideoRadar.NativeHost.Media;

public sealed record MediaPage(string Platform, string CanonicalUrl, string MediaId)
{
    private static readonly Regex YouTubeId = new(
        "^[A-Za-z0-9_-]{11}$",
        RegexOptions.CultureInvariant);
    private static readonly Regex TikTokVideoPath = new(
        "^/@(?<user>[A-Za-z0-9._-]{1,64})/video/(?<id>[0-9]{10,30})/?$",
        RegexOptions.CultureInvariant);
    private static readonly Regex TikTokShortPath = new(
        "^/(?<id>[A-Za-z0-9_-]{5,32})/?$",
        RegexOptions.CultureInvariant);
    private static readonly Regex InstagramPath = new(
        "^/(?<kind>p|reel|reels|tv)/(?<id>[A-Za-z0-9_-]{5,64})/?$",
        RegexOptions.CultureInvariant);
    private static readonly Regex XStatusPath = new(
        "^/(?<user>[A-Za-z0-9_]{1,50})/status/(?<id>[0-9]{5,30})(?:/(?:video|photo)/[0-9]{1,3})?/?$",
        RegexOptions.CultureInvariant);

    public static bool TryCanonicalize(string? value, out MediaPage? page)
    {
        page = null;
        if (!HasSafeRawAuthorityAndPath(value)
            || !Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || !string.IsNullOrEmpty(uri.UserInfo)
            || !uri.IsDefaultPort)
        {
            return false;
        }

        page = TryYouTube(uri)
            ?? TryTikTok(uri)
            ?? TryInstagram(uri)
            ?? TryX(uri);
        return page is not null;
    }

    private static MediaPage? TryYouTube(Uri uri)
    {
        string? mediaId = null;
        if (IsHost(uri, "youtube.com", "www.youtube.com", "m.youtube.com")
            && string.Equals(uri.AbsolutePath, "/watch", StringComparison.Ordinal))
        {
            mediaId = GetSingleQueryValue(uri.Query, "v");
        }
        else if (IsHost(uri, "youtube.com", "www.youtube.com", "m.youtube.com")
            && uri.AbsolutePath.StartsWith("/shorts/", StringComparison.Ordinal)
            && uri.AbsolutePath.Length == "/shorts/".Length + 11)
        {
            mediaId = uri.AbsolutePath["/shorts/".Length..];
        }
        else if (IsHost(uri, "youtu.be")
            && uri.AbsolutePath.Length == 12
            && uri.AbsolutePath[0] == '/')
        {
            mediaId = uri.AbsolutePath[1..];
        }

        return mediaId is not null && YouTubeId.IsMatch(mediaId)
            ? new MediaPage("youtube", $"https://www.youtube.com/watch?v={mediaId}", mediaId)
            : null;
    }

    private static MediaPage? TryTikTok(Uri uri)
    {
        if (IsHost(uri, "vm.tiktok.com", "vt.tiktok.com"))
        {
            var shortMatch = TikTokShortPath.Match(uri.AbsolutePath);
            if (!shortMatch.Success) return null;
            var shortId = shortMatch.Groups["id"].Value;
            return new MediaPage("tiktok", $"https://{uri.Host.ToLowerInvariant()}/{shortId}/", $"short:{shortId}");
        }

        if (!IsHost(uri, "tiktok.com", "www.tiktok.com", "m.tiktok.com")) return null;
        var match = TikTokVideoPath.Match(uri.AbsolutePath);
        if (!match.Success) return null;
        var user = match.Groups["user"].Value;
        var mediaId = match.Groups["id"].Value;
        return new MediaPage("tiktok", $"https://www.tiktok.com/@{user}/video/{mediaId}", mediaId);
    }

    private static MediaPage? TryInstagram(Uri uri)
    {
        if (!IsHost(uri, "instagram.com", "www.instagram.com", "m.instagram.com")) return null;
        var match = InstagramPath.Match(uri.AbsolutePath);
        if (!match.Success) return null;
        var kind = match.Groups["kind"].Value is "reels" ? "reel" : match.Groups["kind"].Value;
        var mediaId = match.Groups["id"].Value;
        return new MediaPage("instagram", $"https://www.instagram.com/{kind}/{mediaId}/", mediaId);
    }

    private static MediaPage? TryX(Uri uri)
    {
        if (!IsHost(
            uri,
            "x.com",
            "www.x.com",
            "mobile.x.com",
            "twitter.com",
            "www.twitter.com",
            "mobile.twitter.com"))
        {
            return null;
        }

        var match = XStatusPath.Match(uri.AbsolutePath);
        if (!match.Success) return null;
        var user = match.Groups["user"].Value;
        var mediaId = match.Groups["id"].Value;
        return new MediaPage("x", $"https://x.com/{user}/status/{mediaId}", mediaId);
    }

    private static bool IsHost(Uri uri, params string[] allowed) =>
        allowed.Any(host => string.Equals(uri.Host, host, StringComparison.OrdinalIgnoreCase));

    private static bool HasSafeRawAuthorityAndPath(string? value)
    {
        if (string.IsNullOrEmpty(value)) return false;
        var schemeSeparator = value.IndexOf("://", StringComparison.Ordinal);
        if (schemeSeparator < 0) return false;

        var authorityStart = schemeSeparator + 3;
        var authorityEnd = FindDelimiter(value, authorityStart, includePathSeparators: true);
        if (value.AsSpan(authorityStart, authorityEnd - authorityStart).Contains('@')) return false;
        if (authorityEnd == value.Length || value[authorityEnd] is not ('/' or '\\')) return true;

        var pathEnd = FindDelimiter(value, authorityEnd, includePathSeparators: false);
        return !HasDotSegment(value.AsSpan(authorityEnd, pathEnd - authorityEnd));
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
