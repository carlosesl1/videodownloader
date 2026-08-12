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
        if (read != header.Length)
            throw new NativeMessageFramingException("Cabeçalho Native Messaging incompleto.");

        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length is 0 or > MaxMessageBytes)
            throw new NativeMessageFramingException("Mensagem Native Messaging inválida.");

        var body = new byte[(int)length];
        try
        {
            await input.ReadExactlyAsync(body, cancellationToken);
        }
        catch (EndOfStreamException exception)
        {
            throw new NativeMessageFramingException(
                "Corpo Native Messaging incompleto.",
                exception);
        }
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
            // Once a header is visible, cancellation cannot safely interrupt its body:
            // a partial frame would desynchronize every later message on stdout.
            await output.WriteAsync(header, CancellationToken.None);
            await output.WriteAsync(body, CancellationToken.None);
            await output.FlushAsync(CancellationToken.None);
        }
        finally
        {
            writeLock.Release();
        }
    }
}

public sealed class NativeMessageFramingException : IOException
{
    public NativeMessageFramingException(string message)
        : base(message)
    {
    }

    public NativeMessageFramingException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
