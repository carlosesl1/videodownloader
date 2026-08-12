using VideoRadar.NativeHost.Media;

namespace VideoRadar.NativeHost.YouTube;

public static class YouTubeUrl
{
    public static bool TryCanonicalize(string url, out string canonical)
    {
        canonical = string.Empty;
        if (!MediaPage.TryCanonicalize(url, out var page) || page?.Platform != "youtube") return false;
        canonical = page.CanonicalUrl;
        return true;
    }
}
