using System.Buffers.Binary;
using System.Text.Json;

namespace VideoRadar.NativeHost.Protocol;

public sealed class NativeMessageChannel(Stream input, Stream output)
{
    public const int MaxMessageBytes = 1_048_576;

    private readonly SemaphoreSlim writeLock = new(1, 1);

    public async Task<JsonDocument?> ReadAsync(CancellationToken cancellationToken)
    {
        var header = new byte[sizeof(uint)];
        var read = await input.ReadAtLeastAsync(header, header.Length, throwOnEndOfStream: false, cancellationToken);
        if (read == 0) return null;
        if (read != header.Length) throw new InvalidDataException("Cabeçalho Native Messaging incompleto.");

        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length is 0 or > MaxMessageBytes) throw new InvalidDataException("Mensagem Native Messaging inválida.");

        var body = new byte[(int)length];
        await input.ReadExactlyAsync(body, cancellationToken);
        return JsonDocument.Parse(body);
    }

    public async Task WriteAsync<T>(T value, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(value);
        if (body.Length is 0 or > MaxMessageBytes) throw new InvalidDataException("Mensagem Native Messaging inválida.");

        var header = new byte[sizeof(uint)];
        BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)body.Length);

        await writeLock.WaitAsync(cancellationToken);
        try
        {
            await output.WriteAsync(header, cancellationToken);
            await output.WriteAsync(body, cancellationToken);
            await output.FlushAsync(cancellationToken);
        }
        finally
        {
            writeLock.Release();
        }
    }
}
