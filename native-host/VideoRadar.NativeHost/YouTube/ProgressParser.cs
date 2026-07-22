using System.Text.Json;

namespace VideoRadar.NativeHost.YouTube;

public static class ProgressParser
{
    private const string ProgressPrefix = "VR_PROGRESS:";
    private const string PostprocessPrefix = "VR_POSTPROCESS:";
    private const string FilePrefix = "VR_FILE:";

    public static bool TryParse(string line, out JobProgress? progress)
    {
        progress = null;
        if (string.IsNullOrEmpty(line)) return false;

        try
        {
            if (line.StartsWith(ProgressPrefix, StringComparison.Ordinal))
                return TryParseDownload(line[ProgressPrefix.Length..], out progress);
            if (line.StartsWith(PostprocessPrefix, StringComparison.Ordinal))
                return TryParsePostprocess(line[PostprocessPrefix.Length..], out progress);
            if (line.StartsWith(FilePrefix, StringComparison.Ordinal))
                return TryParseFile(line[FilePrefix.Length..], out progress);
            return false;
        }
        catch (JsonException)
        {
            progress = null;
            return false;
        }
    }

    private static bool TryParseDownload(string json, out JobProgress? result)
    {
        result = null;
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("progress", out var details)
            || details.ValueKind != JsonValueKind.Object
            || !TryReadNonNegativeLong(details, "downloaded_bytes", allowZeroAsNull: false, out var downloaded)
            || !TryReadNonNegativeLong(details, "total_bytes", allowZeroAsNull: true, out var total)
            || !TryReadNonNegativeRate(details, "speed", out var speed)
            || !TryReadNonNegativeInt(details, "eta", out var eta)
            || !TryReadString(root, "vcodec", out var videoCodec)
            || !TryReadString(root, "acodec", out var audioCodec))
        {
            return false;
        }

        var stage = HasCodec(videoCodec) && IsNone(audioCodec)
            ? "video"
            : IsNone(videoCodec) && HasCodec(audioCodec)
                ? "audio"
                : "download";
        int? percent = downloaded.HasValue && total is > 0
            ? (int)Math.Clamp((decimal)downloaded.Value * 100m / total.Value, 0m, 100m)
            : null;
        result = new JobProgress(stage, percent, downloaded, total, speed, eta);
        return true;
    }

    private static bool TryParsePostprocess(string json, out JobProgress? result)
    {
        result = null;
        using var document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind != JsonValueKind.Object) return false;
        result = new JobProgress("merge", null, null, null, null, null);
        return true;
    }

    private static bool TryParseFile(string json, out JobProgress? result)
    {
        result = null;
        using var document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind != JsonValueKind.String) return false;
        var path = document.RootElement.GetString();
        if (string.IsNullOrWhiteSpace(path)) return false;
        result = new JobProgress("finalize", null, null, null, null, null, path);
        return true;
    }

    private static bool TryReadNonNegativeLong(JsonElement element, string name, bool allowZeroAsNull, out long? result)
    {
        result = null;
        if (!element.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null) return true;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var number) || number < 0) return false;
        if (number != 0 || !allowZeroAsNull) result = number;
        return true;
    }

    private static bool TryReadNonNegativeInt(JsonElement element, string name, out int? result)
    {
        result = null;
        if (!element.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null) return true;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var number) || number < 0) return false;
        result = number;
        return true;
    }

    private static bool TryReadNonNegativeRate(JsonElement element, string name, out long? result)
    {
        result = null;
        if (!element.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null) return true;
        if (value.ValueKind != JsonValueKind.Number
            || !value.TryGetDecimal(out var number)
            || number < 0
            || number > long.MaxValue)
        {
            return false;
        }

        result = (long)decimal.Truncate(number);
        return true;
    }

    private static bool TryReadString(JsonElement element, string name, out string? result)
    {
        result = null;
        if (!element.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null) return true;
        if (value.ValueKind != JsonValueKind.String) return false;
        result = value.GetString();
        return true;
    }

    private static bool IsNone(string? codec) => string.Equals(codec, "none", StringComparison.OrdinalIgnoreCase);

    private static bool HasCodec(string? codec) => !string.IsNullOrWhiteSpace(codec) && !IsNone(codec);
}
