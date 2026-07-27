using System.Text.Json;
using System.Text.RegularExpressions;

namespace VideoRadar.NativeHost.Protocol;

public sealed record HostCommand(string Type, string RequestId, JsonElement Payload)
{
    private static readonly HashSet<string> Types =
        ["ping", "listFormats", "startDownload", "cancelDownload", "getJob", "chooseDownloadFolder", "moveDownloadedFile", "revealDownloadedFile"];
    private static readonly Regex SafeId = new("^[A-Za-z0-9._:-]{1,128}$", RegexOptions.CultureInvariant);

    public static HostCommand Parse(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Comando inválido.");
        if (!root.TryGetProperty("type", out var typeElement) || typeElement.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("Comando inválido.");
        if (!root.TryGetProperty("requestId", out var requestIdElement) || requestIdElement.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("Comando inválido.");
        if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Comando inválido.");

        var type = typeElement.GetString();
        var requestId = requestIdElement.GetString();
        if (type is null || requestId is null || !Types.Contains(type) || !SafeId.IsMatch(requestId))
            throw new InvalidDataException("Comando inválido.");

        return new HostCommand(type, requestId, payload.Clone());
    }
}
