namespace VideoRadar.NativeHost.YouTube;

public sealed class MediaDownloadException : InvalidOperationException
{
    public MediaDownloadException(string code, string message)
        : base(message)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(code);
        Code = code;
    }

    public string Code { get; }
}
