# YouTube Native Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar ao Vídeo Radar downloads públicos do YouTube com escolha de qualidade, união local de áudio/vídeo, cancelamento e progresso recuperável ao fechar e reabrir o popup.

**Architecture:** O fluxo direto/HLS existente permanece isolado. Um novo coordenador YouTube no service worker mantém uma porta Native Messaging com um host Windows x64 autocontido em .NET 10; o host executa `yt-dlp`, Deno e FFmpeg, enquanto `chrome.storage.local` guarda apenas o snapshot da interface. O popup consulta o host sob demanda e restaura o último job sem ser dono do processo.

**Tech Stack:** Chrome Extensions Manifest V3, JavaScript ES modules, `chrome.runtime.connectNative`, `chrome.storage.local`, `chrome.notifications`, Node.js `node:test`, C#/.NET 10 self-contained single-file, yt-dlp, Deno, FFmpeg, PowerShell.

---

## Referências obrigatórias

- Especificação: `docs/superpowers/specs/2026-07-22-youtube-native-helper-design.md`
- Native Messaging: <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- Ciclo de vida do service worker: <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- Registro no Edge: <https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/native-messaging>
- yt-dlp e templates de progresso: <https://github.com/yt-dlp/yt-dlp>
- EJS/Deno: <https://github.com/yt-dlp/yt-dlp/wiki/EJS>
- Publicação .NET single-file: <https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview>

## Mapa de arquivos

### Extensão existente a modificar

- `manifest.json` — chave estável e permissões `nativeMessaging`/`notifications`.
- `package.json` — comandos separados para testes da extensão, host e pacote completo.
- `src/background/main.js` — compõe coordenadores HLS e YouTube por um router.
- `src/popup/main.js` — detecta URL YouTube, consulta formatos e restaura jobs.
- `src/popup/state.js` — estados/erros/etapas YouTube.
- `src/popup/render.js` — qualidade, cancelar, barra determinada/indeterminada e caminho final.
- `styles/popup.css` — estados YouTube mantendo a largura atual.
- `scripts/validate-extension.mjs` — preflight das novas permissões e ausência de endpoints localhost.
- `README.md` — instalação do auxiliar, escopo e testes.

### Extensão nova

- `src/youtube/protocol.js` — ações e validação dos contratos extensão ↔ host.
- `src/youtube/job-view.js` — normalização do snapshot e texto de estágio.
- `src/youtube/page-url.js` — reconhecimento estrito de `watch`/`youtu.be`.
- `src/background/native-port.js` — uma porta, correlação por `requestId` e eventos.
- `src/background/youtube-coordinator.js` — storage local, concorrência, reconciliação e notificações.
- `src/background/router.js` — delegação sem misturar o coordenador HLS existente.
- `test/youtube-protocol.test.js`, `test/youtube-job-view.test.js`, `test/native-port.test.js`, `test/youtube-coordinator.test.js`, `test/background-router.test.js` — testes unitários do novo fluxo.

### Host nativo novo

- `native-host/VideoRadar.NativeHost/VideoRadar.NativeHost.csproj` — executável `net10.0`, single-file, win-x64.
- `native-host/VideoRadar.NativeHost/Program.cs` — composição e loop principal.
- `native-host/VideoRadar.NativeHost/Protocol/NativeMessageChannel.cs` — framing JSON de 32 bits.
- `native-host/VideoRadar.NativeHost/Protocol/HostCommand.cs` — parsing/validação de comandos.
- `native-host/VideoRadar.NativeHost/YouTube/YouTubeUrl.cs` — allowlist e canonicalização.
- `native-host/VideoRadar.NativeHost/YouTube/FormatCatalog.cs` — metadados reduzidos e alturas.
- `native-host/VideoRadar.NativeHost/YouTube/YtDlpArguments.cs` — argumentos herméticos, sem cookies/configuração externa.
- `native-host/VideoRadar.NativeHost/YouTube/ProgressParser.cs` — saída estruturada do yt-dlp.
- `native-host/VideoRadar.NativeHost/YouTube/IYouTubeService.cs` — seam para servidor e testes sem rede.
- `native-host/VideoRadar.NativeHost/Processes/ProcessRunner.cs` — processo redirecionado e cancelável.
- `native-host/VideoRadar.NativeHost/Windows/ChildProcessJob.cs` — Job Object kill-on-close.
- `native-host/VideoRadar.NativeHost/Files/DownloadPaths.cs` — destino fixo, temporários e sufixo numérico.
- `native-host/VideoRadar.NativeHost/YouTube/YouTubeService.cs` — consulta, download e eventos.
- `native-host/VideoRadar.NativeHost/Host/NativeHostServer.cs` — ping/list/start/cancel/getJob.
- `native-host/VideoRadar.NativeHost/YouTube/JobSnapshot.cs` — fonte tipada do estado ativo do host.
- `native-host/VideoRadar.NativeHost.Tests/` — runner de testes sem dependências NuGet adicionais.

### Empacotamento e instalação

- `native-host/tool-lock.json` — versões, URLs e SHA-256 fixados.
- `scripts/bootstrap-dotnet.ps1` — SDK .NET 10 local em `.tools/dotnet`.
- `scripts/dotnet.ps1` — resolução do SDK local/sistema.
- `scripts/lock-native-tools.ps1` — gera o lock a partir dos checksums oficiais.
- `scripts/fetch-native-tools.ps1` — baixa e valida o lock.
- `scripts/package-native-helper.ps1` — publica host e monta `dist/video-radar-helper`.
- `scripts/install-native-host.ps1` — instalação HKCU para Chrome/Edge/Brave.
- `Instalar-Video-Radar.cmd` — lançador de um clique.

## Task 1: Criar o scaffold .NET local e preservar o baseline

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Create: `scripts/bootstrap-dotnet.ps1`
- Create: `scripts/dotnet.ps1`
- Create: `native-host/VideoRadar.NativeHost/VideoRadar.NativeHost.csproj`
- Create: `native-host/VideoRadar.NativeHost/HostInfo.cs`
- Create: `native-host/VideoRadar.NativeHost/Program.cs`
- Create: `native-host/VideoRadar.NativeHost.Tests/VideoRadar.NativeHost.Tests.csproj`
- Create: `native-host/VideoRadar.NativeHost.Tests/Program.cs`
- Create: `native-host/VideoRadar.NativeHost.Tests/TestSuite.cs`

- [ ] **Step 1: Confirmar o baseline antes do host**

Run: `npm run check`

Expected: preflight aprovado, todos os testes JavaScript passam e o processo termina com código `0`.

- [ ] **Step 2: Escrever o runner nativo com um teste que falha**

```csharp
// native-host/VideoRadar.NativeHost.Tests/Program.cs
using VideoRadar.NativeHost.Tests;

try
{
    TestSuite.RunAll();
    Console.WriteLine("Native host tests passed");
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error);
    return 1;
}
```

```csharp
// native-host/VideoRadar.NativeHost.Tests/TestSuite.cs
namespace VideoRadar.NativeHost.Tests;

internal static partial class TestSuite
{
    public static void RunAll() => HostInfoTest();

    private static void HostInfoTest()
    {
        Equal("com.videoradar.helper", global::VideoRadar.NativeHost.HostInfo.NativeName);
    }

    internal static void Equal<T>(T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new InvalidOperationException($"Expected {expected}, received {actual}");
    }

    internal static void True(bool value, string message)
    {
        if (!value) throw new InvalidOperationException(message);
    }
}
```

```xml
<!-- native-host/VideoRadar.NativeHost/VideoRadar.NativeHost.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <RuntimeIdentifier>win-x64</RuntimeIdentifier>
    <SelfContained>true</SelfContained>
    <PublishSingleFile>true</PublishSingleFile>
    <PublishTrimmed>false</PublishTrimmed>
    <AssemblyName>video-radar-host</AssemblyName>
    <RootNamespace>VideoRadar.NativeHost</RootNamespace>
  </PropertyGroup>
</Project>
```

```xml
<!-- native-host/VideoRadar.NativeHost.Tests/VideoRadar.NativeHost.Tests.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\VideoRadar.NativeHost\VideoRadar.NativeHost.csproj" />
  </ItemGroup>
</Project>
```

- [ ] **Step 3: Criar o bootstrap do SDK e verificar RED**

```powershell
# scripts/bootstrap-dotnet.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installDir = Join-Path $root '.tools\dotnet'
$installer = Join-Path ([System.IO.Path]::GetTempPath()) 'video-radar-dotnet-install.ps1'
Invoke-WebRequest 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installer
& powershell -NoProfile -ExecutionPolicy Bypass -File $installer -Channel '10.0' -InstallDir $installDir -NoPath
if ($LASTEXITCODE -ne 0) { throw "dotnet-install falhou: $LASTEXITCODE" }
& (Join-Path $installDir 'dotnet.exe') --version
```

```powershell
# scripts/dotnet.ps1
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$DotnetArgs)
$root = Split-Path -Parent $PSScriptRoot
$local = Join-Path $root '.tools\dotnet\dotnet.exe'
$dotnet = if (Test-Path $local) { $local } else { (Get-Command dotnet -ErrorAction Stop).Source }
& $dotnet @DotnetArgs
exit $LASTEXITCODE
```

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-dotnet.ps1`

Expected: imprime uma versão `10.0.x` e termina com código `0`.

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dotnet.ps1 run --project native-host/VideoRadar.NativeHost.Tests`

Expected: FAIL de compilação porque `HostInfo` ainda não existe.

- [ ] **Step 4: Adicionar a implementação mínima e comandos npm**

```csharp
// native-host/VideoRadar.NativeHost/HostInfo.cs
namespace VideoRadar.NativeHost;

public static class HostInfo
{
    public const string NativeName = "com.videoradar.helper";
    public const int ProtocolVersion = 1;
}
```

```csharp
// native-host/VideoRadar.NativeHost/Program.cs
namespace VideoRadar.NativeHost;

internal static class Program
{
    private static int Main()
    {
        Console.Error.WriteLine($"{HostInfo.NativeName} v{HostInfo.ProtocolVersion}");
        return 0;
    }
}
```

Add `.tools/`, `dist/`, `native-host/**/bin/` and `native-host/**/obj/` to `.gitignore` and use this package contract:

```json
{
  "name": "video-radar-extension",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/*.test.js",
    "check": "node scripts/validate-extension.mjs && node --test test/*.test.js",
    "test:native": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dotnet.ps1 run --project native-host/VideoRadar.NativeHost.Tests",
    "check:all": "npm run check && npm run test:native"
  }
}
```

- [ ] **Step 5: Verificar GREEN e commitar**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dotnet.ps1 run --project native-host/VideoRadar.NativeHost.Tests`

Expected: `Native host tests passed`.

Run: `npm run check`

Expected: todos os testes existentes continuam passando.

```powershell
git add .gitignore package.json scripts/bootstrap-dotnet.ps1 scripts/dotnet.ps1 native-host
git commit -m "chore: scaffold native youtube helper"
```

## Task 2: Implementar framing Native Messaging e validação de URL

**Files:**
- Create: `native-host/VideoRadar.NativeHost/Protocol/NativeMessageChannel.cs`
- Create: `native-host/VideoRadar.NativeHost/Protocol/HostCommand.cs`
- Create: `native-host/VideoRadar.NativeHost/YouTube/YouTubeUrl.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.cs`
- Create: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Protocol.cs`

- [ ] **Step 1: Escrever testes de framing e allowlist**

Add `ProtocolTests(); YouTubeUrlTests();` to `RunAll()` and create tests that:

```csharp
private static void ProtocolTests()
{
    using var stream = new MemoryStream();
    var channel = new NativeMessageChannel(stream, stream);
    channel.WriteAsync(new { type = "ready", requestId = "r1" }, CancellationToken.None).GetAwaiter().GetResult();
    stream.Position = 0;
    using var message = channel.ReadAsync(CancellationToken.None).GetAwaiter().GetResult();
    Equal("ready", message!.RootElement.GetProperty("type").GetString());
    Equal("r1", message.RootElement.GetProperty("requestId").GetString());
}

private static void YouTubeUrlTests()
{
    True(YouTubeUrl.TryCanonicalize("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=3", out var watch), "watch URL rejected");
    Equal("https://www.youtube.com/watch?v=jNQXAC9IVRw", watch);
    True(YouTubeUrl.TryCanonicalize("https://youtu.be/jNQXAC9IVRw", out var shortUrl), "short URL rejected");
    Equal(watch, shortUrl);
    True(!YouTubeUrl.TryCanonicalize("http://youtube.com/watch?v=jNQXAC9IVRw", out _), "HTTP accepted");
    True(!YouTubeUrl.TryCanonicalize("https://evil.test/watch?v=jNQXAC9IVRw", out _), "foreign host accepted");
    True(!YouTubeUrl.TryCanonicalize("https://youtube.com/playlist?list=x", out _), "playlist accepted");
}
```

- [ ] **Step 2: Rodar e verificar RED**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dotnet.ps1 run --project native-host/VideoRadar.NativeHost.Tests`

Expected: FAIL porque `NativeMessageChannel` e `YouTubeUrl` não existem.

- [ ] **Step 3: Implementar o framing e parser estrito**

`NativeMessageChannel` must read/write a four-byte little-endian unsigned length followed by UTF-8 JSON, reject zero-length and messages above `1_048_576` bytes, serialize writes through a `SemaphoreSlim`, and never write logs to stdout. `HostCommand.Parse(JsonElement)` must accept only `ping`, `listFormats`, `startDownload`, `cancelDownload`, `getJob`, require `requestId` matching `^[A-Za-z0-9._:-]{1,128}$`, and expose `Payload` without accepting arrays/null.

`YouTubeUrl.TryCanonicalize` must accept HTTPS only, no user info, default port only, an 11-character `[A-Za-z0-9_-]` video ID from `youtube.com/watch`, `www.youtube.com/watch`, `m.youtube.com/watch` or `youtu.be/<id>`, and return only `https://www.youtube.com/watch?v=<id>`.

Use these public contracts exactly:

```csharp
using System.Buffers.Binary;
using System.Text.Json;

namespace VideoRadar.NativeHost.Protocol;

public sealed class NativeMessageChannel(Stream input, Stream output)
{
    public const int MaxMessageBytes = 1_048_576;
    private readonly SemaphoreSlim writeLock = new(1, 1);

    public async Task<JsonDocument?> ReadAsync(CancellationToken cancellationToken)
    {
        var header = new byte[4];
        var read = await input.ReadAtLeastAsync(header, 4, throwOnEndOfStream: false, cancellationToken);
        if (read == 0) return null;
        if (read != 4) throw new InvalidDataException("Cabeçalho Native Messaging incompleto.");
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length is 0 or > MaxMessageBytes) throw new InvalidDataException("Mensagem Native Messaging inválida.");
        var body = new byte[length];
        await input.ReadExactlyAsync(body, cancellationToken);
        return JsonDocument.Parse(body);
    }

    public async Task WriteAsync<T>(T value, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(value);
        if (body.Length is 0 or > MaxMessageBytes) throw new InvalidDataException("Mensagem Native Messaging inválida.");
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)body.Length);
        await writeLock.WaitAsync(cancellationToken);
        try
        {
            await output.WriteAsync(header, cancellationToken);
            await output.WriteAsync(body, cancellationToken);
            await output.FlushAsync(cancellationToken);
        }
        finally { writeLock.Release(); }
    }
}
```

```csharp
using System.Text.Json;
using System.Text.RegularExpressions;

namespace VideoRadar.NativeHost.Protocol;

public sealed record HostCommand(string Type, string RequestId, JsonElement Payload)
{
    private static readonly HashSet<string> Types = ["ping", "listFormats", "startDownload", "cancelDownload", "getJob"];
    private static readonly Regex SafeId = new("^[A-Za-z0-9._:-]{1,128}$", RegexOptions.CultureInvariant);

    public static HostCommand Parse(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Comando inválido.");
        var type = root.GetProperty("type").GetString();
        var requestId = root.GetProperty("requestId").GetString();
        var payload = root.GetProperty("payload");
        if (type is null || !Types.Contains(type) || requestId is null || !SafeId.IsMatch(requestId) || payload.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Comando inválido.");
        return new(type, requestId, payload.Clone());
    }
}
```

- [ ] **Step 4: Rodar GREEN e commitar**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dotnet.ps1 run --project native-host/VideoRadar.NativeHost.Tests`

Expected: `Native host tests passed`.

```powershell
git add native-host
git commit -m "feat: add native messaging protocol"
```

## Task 3: Consultar metadados e reduzir qualidades

**Files:**
- Create: `native-host/VideoRadar.NativeHost/YouTube/FormatCatalog.cs`
- Create: `native-host/VideoRadar.NativeHost/YouTube/YtDlpArguments.cs`
- Create: `native-host/VideoRadar.NativeHost/Processes/IProcessRunner.cs`
- Create: `native-host/VideoRadar.NativeHost/Processes/ProcessRunner.cs`
- Create: `native-host/VideoRadar.NativeHost/YouTube/IYouTubeService.cs`
- Create: `native-host/VideoRadar.NativeHost/YouTube/YouTubeService.cs`
- Create: `native-host/VideoRadar.NativeHost.Tests/Fixtures/youtube-info.json`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.cs`
- Create: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Formats.cs`

- [ ] **Step 1: Criar fixture e teste de catálogo**

Create the fixture as a small, deterministic yt-dlp response. It represents a public non-live video with combined MP4 360p, video-only MP4 720p/1080p, video-only WebM 1080p and audio-only M4A/WebM:

```json
{
  "id": "jNQXAC9IVRw",
  "title": "Me at the zoo",
  "duration": 19,
  "is_live": false,
  "availability": "public",
  "formats": [
    { "format_id": "18", "ext": "mp4", "height": 360, "vcodec": "avc1.42001E", "acodec": "mp4a.40.2", "filesize": 1024000 },
    { "format_id": "136", "ext": "mp4", "height": 720, "vcodec": "avc1.4d401f", "acodec": "none", "filesize": 2048000 },
    { "format_id": "137", "ext": "mp4", "height": 1080, "vcodec": "avc1.640028", "acodec": "none", "filesize": 4096000 },
    { "format_id": "248", "ext": "webm", "height": 1080, "vcodec": "vp9", "acodec": "none", "filesize": 3584000 },
    { "format_id": "140", "ext": "m4a", "height": null, "vcodec": "none", "acodec": "mp4a.40.2", "filesize": 512000 },
    { "format_id": "251", "ext": "webm", "height": null, "vcodec": "none", "acodec": "opus", "filesize": 480000 }
  ]
}
```

Add `FormatCatalogTests()` to `RunAll()` and assert:

```csharp
private static void FormatCatalogTests()
{
    var json = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "youtube-info.json"));
    var catalog = FormatCatalog.Parse(json);
    Equal("jNQXAC9IVRw", catalog.VideoId);
    Equal("Me at the zoo", catalog.Title);
    Equal(3, catalog.Qualities.Count);
    Equal(1080, catalog.Qualities[0].Height);
    Equal("mp4", catalog.Qualities[0].Container);
    Equal(360, catalog.Qualities[2].Height);
    True(catalog.Qualities[2].Combined, "360p should be combined");

    var args = YtDlpArguments.Metadata(@"C:\Tools", "https://www.youtube.com/watch?v=jNQXAC9IVRw");
    True(args.Contains("--ignore-config"), "config was not disabled");
    True(args.Contains("--no-playlist"), "playlist was not disabled");
    True(args.Contains("--no-plugin-dirs"), "plugins were not disabled");
    True(args.All(value => !value.Contains("cookie", StringComparison.OrdinalIgnoreCase)), "cookie argument present");
}
```

Ensure the fixture is copied to the test output via the test `.csproj`.

- [ ] **Step 2: Verificar RED**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dotnet.ps1 run --project native-host/VideoRadar.NativeHost.Tests`

Expected: FAIL porque `FormatCatalog` e `YtDlpArguments` não existem.

- [ ] **Step 3: Implementar catálogo e processo de consulta**

`FormatCatalog.Parse` must reject `is_live=true`, any `availability` other than `public`, missing ID/title, or no video heights. It groups distinct positive heights where `vcodec != "none"`, sorts descending, marks `Combined` when the same height has both codecs, and predicts MP4 when an MP4 video plus M4A audio (or combined MP4) exists; otherwise WebM.

`ProcessRunner` uses `ProcessStartInfo.ArgumentList`, `UseShellExecute=false`, redirected UTF-8 stdout/stderr, and accepts a cancellation token. `YouTubeService.ListFormatsAsync` canonicalizes first, runs `Path.Combine(tools, "yt-dlp.exe")`, rejects nonzero exit with a safe error code, and returns only the reduced catalog.

`IYouTubeService` exposes `ListFormatsAsync`, `StartDownloadAsync`, `CancelAsync` and `GetJob`; `NativeHostServer` depends only on this interface so its tests never invoke the network or real tools.

Use these types/signatures throughout later tasks:

```csharp
namespace VideoRadar.NativeHost.YouTube;

public sealed record QualityOption(int Height, string Label, string Container, bool Combined);
public sealed record FormatCatalog(string VideoId, string Title, double? DurationSeconds, IReadOnlyList<QualityOption> Qualities);
public sealed record JobProgress(string Stage, int? Percent, long? DownloadedBytes, long? TotalBytes, long? SpeedBytesPerSecond, int? EtaSeconds, string? Path = null);
public sealed record JobResult(string JobId, string Path);
public sealed record JobSnapshot(string JobId, string VideoId, string Title, int Height, string Stage, int? Percent, string? Path, string? ErrorCode);

public interface IYouTubeService
{
    Task<FormatCatalog> ListFormatsAsync(string url, CancellationToken cancellationToken);
    Task<JobResult> StartDownloadAsync(string jobId, string url, int height, Func<JobProgress, Task> onProgress, CancellationToken cancellationToken);
    Task CancelAsync(string jobId);
    JobSnapshot? GetJob();
}
```

```csharp
namespace VideoRadar.NativeHost.Processes;

public sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError);
public interface IProcessRunner
{
    Task<ProcessResult> RunAsync(string executable, IReadOnlyList<string> arguments, Func<string, Task>? onOutput, CancellationToken cancellationToken);
}
```

```csharp
namespace VideoRadar.NativeHost.YouTube;

public static class YtDlpArguments
{
    public static IReadOnlyList<string> Metadata(string tools, string canonicalUrl) =>
    [
        "--ignore-config", "--no-playlist", "--no-plugin-dirs", "--no-remote-components",
        "--js-runtimes", $"deno:{Path.Combine(tools, "deno.exe")}",
        "--ffmpeg-location", tools,
        "--dump-single-json", "--skip-download", "--no-warnings", canonicalUrl,
    ];
}
```

- [ ] **Step 4: Verificar GREEN e commitar**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dotnet.ps1 run --project native-host/VideoRadar.NativeHost.Tests`

Expected: `Native host tests passed`.

```powershell
git add native-host
git commit -m "feat: list youtube video qualities"
```

## Task 4: Baixar, acompanhar progresso e cancelar com Job Object

**Files:**
- Create: `native-host/VideoRadar.NativeHost/YouTube/ProgressParser.cs`
- Create: `native-host/VideoRadar.NativeHost/Windows/ChildProcessJob.cs`
- Create: `native-host/VideoRadar.NativeHost/Files/DownloadPaths.cs`
- Modify: `native-host/VideoRadar.NativeHost/Processes/ProcessRunner.cs`
- Modify: `native-host/VideoRadar.NativeHost/YouTube/YtDlpArguments.cs`
- Modify: `native-host/VideoRadar.NativeHost/YouTube/YouTubeService.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.cs`
- Create: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Download.cs`

- [ ] **Step 1: Escrever testes de argumentos, progresso e cancelamento**

Add `DownloadTests()` to `RunAll()` and test that `YtDlpArguments.Download` contains `--windows-filenames`, `--trim-filenames 180`, `--no-overwrites`, home/temp paths, a pre-reserved literal file stem, `--progress-template`, `--print after_move:VR_FILE:%(filepath)j`, an upper-bound selector for the selected height, and no `--cookies`, `--cookies-from-browser`, `--username`, `--password`, `--netrc` or browser profile arguments. Test `DownloadPaths.ReserveStem("Me at the zoo", "jNQXAC9IVRw")` returns `Me at the zoo [jNQXAC9IVRw]`, then `(2)` and `(3)` when matching files/reservations already exist.

```csharp
private static void DownloadTests()
{
    var line = "VR_PROGRESS:{\"progress\":{\"status\":\"downloading\",\"downloaded_bytes\":50,\"total_bytes\":100,\"speed\":25,\"eta\":2},\"vcodec\":\"avc1\",\"acodec\":\"none\"}";
    True(ProgressParser.TryParse(line, out var progress), "progress not parsed");
    Equal("video", progress!.Stage);
    Equal(50, progress.Percent);
    True(ProgressParser.TryParse("VR_POSTPROCESS:{\"status\":\"started\"}", out var merge), "postprocess not parsed");
    Equal("merge", merge!.Stage);
    True(ProgressParser.TryParse("VR_FILE:\"C:\\\\Downloads\\\\Video Radar\\\\file.mp4\"", out var file), "file not parsed");
    Equal("finalize", file!.Stage);
}
```

- [ ] **Step 2: Verificar RED**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dotnet.ps1 run --project native-host/VideoRadar.NativeHost.Tests`

Expected: FAIL porque parser e argumentos de download ainda não existem.

- [ ] **Step 3: Implementar download hermético**

Use this selector for chosen height `H`:

```text
b[height=H][ext=mp4]/bv*[height<=H][ext=mp4]+ba[ext=m4a]/b[height<=H]/bv*[height<=H]+ba
```

`ProgressParser` emits bounded integer percentages, keeps unknown totals as `null`, classifies video/audio from codecs, classifies postprocess as merge, and accepts the final path only when it remains under `Downloads\Video Radar`.

`DownloadPaths` sanitizes the catalog title plus video ID, reserves the first available stem in memory and on disk, and appends ` (2)`, ` (3)` and so on. Only that host-generated relative stem may reach `--output`; no path from the extension is accepted.

`ChildProcessJob` uses `CreateJobObject`, `SetInformationJobObject` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `AssignProcessToJobObject`, and closes its handle on disposal. `ProcessRunner` assigns every yt-dlp process before reading output and kills the process tree on cancellation.

`YouTubeService.StartDownloadAsync` permits one active job, streams normalized progress, returns the final path, deletes the job temp directory in `finally`, and maps cancellation to `jobCancelled` rather than `jobFailed`.

Implement the builder as a pure function so the security test inspects the final list:

```csharp
public static IReadOnlyList<string> Download(
    string tools, string home, string temp, string reservedStem, string canonicalUrl, int height)
{
    if (height is < 144 or > 4320) throw new ArgumentOutOfRangeException(nameof(height));
    var selector = $"b[height={height}][ext=mp4]/bv*[height<={height}][ext=mp4]+ba[ext=m4a]/b[height<={height}]/bv*[height<={height}]+ba";
    return
    [
        "--ignore-config", "--no-playlist", "--no-plugin-dirs", "--no-remote-components",
        "--js-runtimes", $"deno:{Path.Combine(tools, "deno.exe")}",
        "--ffmpeg-location", tools,
        "--windows-filenames", "--trim-filenames", "180", "--no-overwrites",
        "--paths", home, "--paths", $"temp:{temp}",
        "--output", $"{reservedStem}.%(ext)s",
        "--format", selector, "--merge-output-format", "mp4/webm",
        "--newline", "--progress", "--progress-delta", "0.5",
        "--progress-template", "download:VR_PROGRESS:{\"progress\":%(progress)j,\"vcodec\":%(info.vcodec)j,\"acodec\":%(info.acodec)j}",
        "--progress-template", "postprocess:VR_POSTPROCESS:%(progress)j",
        "--print", "after_move:VR_FILE:%(filepath)j",
        canonicalUrl,
    ];
}
```

`DownloadPaths` must implement this complete boundary:

```csharp
public interface IDownloadPaths
{
    string Home { get; }
    string TempRoot { get; }
    string ReserveStem(string title, string videoId);
    string CreateJobTemp(string jobId);
    bool ContainsFinalPath(string path);
    void ReleaseStem(string stem);
    void DeleteJobTemp(string jobId);
}
```

- [ ] **Step 4: Verificar GREEN e commitar**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dotnet.ps1 run --project native-host/VideoRadar.NativeHost.Tests`

Expected: `Native host tests passed`.

```powershell
git add native-host
git commit -m "feat: download and merge youtube streams"
```

## Task 5: Implementar servidor nativo, snapshots e atualização diária

**Files:**
- Create: `native-host/VideoRadar.NativeHost/Host/NativeHostServer.cs`
- Create: `native-host/VideoRadar.NativeHost/YouTube/JobSnapshot.cs`
- Create: `native-host/VideoRadar.NativeHost/Tools/UpdatePolicy.cs`
- Modify: `native-host/VideoRadar.NativeHost/Program.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.cs`
- Create: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Server.cs`

- [ ] **Step 1: Escrever testes do ciclo do host**

Add `ServerTests()` to `RunAll()`. With a fake `YouTubeService`, feed framed commands `ping`, `listFormats`, `startDownload`, `getJob`, `cancelDownload` and assert responses carry the original `requestId`, one stable `jobId`, ordered progress, and terminal cancellation. Feed two starts and assert the second returns `YOUTUBE_BUSY`. Close input while a job is active and assert its cancellation token is cancelled.

Test `UpdatePolicy.ShouldCheck(lastCheck, now)` is true at 24 hours and false at 23:59, and that update failure does not block a metadata request.

- [ ] **Step 2: Verificar RED**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dotnet.ps1 run --project native-host/VideoRadar.NativeHost.Tests`

Expected: FAIL porque `NativeHostServer` não existe.

- [ ] **Step 3: Implementar dispatch e snapshot**

`NativeHostServer.RunAsync` continuously reads commands until EOF. It validates every payload: `listFormats` accepts only `{url}`, `startDownload` only `{url,height}` with positive integer height, `cancelDownload` only the current `{jobId}`, and `getJob` an empty object. `startDownload` creates a UUID job, writes `jobStarted` immediately, and launches the job without blocking the read loop. All writes pass through `NativeMessageChannel`. `getJob` returns the in-memory snapshot only; a new host returns `job=null`. EOF cancels the active job and disposes the Job Object.

Use public event shapes exactly matching the spec: `ready`, `formats`, `jobStarted`, `jobProgress`, `jobCompleted`, `jobCancelled`, `jobFailed`. Safe failures expose only uppercase code, Portuguese message and a small details object.

Before the first YouTube command in a host process, `UpdatePolicy` reads `%LOCALAPPDATA%\VideoRadar\state\yt-dlp-update.json`; when at least 24 hours old it runs `yt-dlp.exe --ignore-config -U`, records the check time even on network failure, and continues with the installed version. No other tool auto-updates.

`Program.Main` composes paths from the executable directory, creates the channel from `Console.OpenStandardInput/Output`, creates the process runner/service/server, logs only to stderr, and returns nonzero only for a fatal protocol/host error. When the first argument is exactly `--ping`, it verifies the four tool executables, prints one plain JSON diagnostic to stdout and exits without entering Native Messaging; ordinary browser launches always use framed stdout.

Keep the server state serializable with this record and API:

```csharp
namespace VideoRadar.NativeHost.Host;

public interface INativeHostServer
{
    Task RunAsync(CancellationToken cancellationToken);
}
```

`NativeHostServer` implements `INativeHostServer`. Implement `RunAsync` with a `switch (command.Type)` over all five allowed commands; every response is an anonymous object containing `type`, `requestId` and the command-specific data. The background task for `startDownload` catches `OperationCanceledException` into `jobCancelled` and all other known service failures into `jobFailed`.

- [ ] **Step 4: Verificar GREEN, publish e commitar**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dotnet.ps1 run --project native-host/VideoRadar.NativeHost.Tests`

Expected: `Native host tests passed`.

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dotnet.ps1 publish native-host/VideoRadar.NativeHost -c Release -r win-x64 --self-contained true`

Expected: `video-radar-host.exe` single-file exists under `bin/Release/net10.0/win-x64/publish`.

```powershell
git add native-host
git commit -m "feat: add youtube native host server"
```

## Task 6: Definir contratos JavaScript e cliente da porta nativa

**Files:**
- Create: `src/youtube/protocol.js`
- Create: `src/youtube/page-url.js`
- Create: `src/youtube/job-view.js`
- Create: `src/background/native-port.js`
- Create: `test/youtube-protocol.test.js`
- Create: `test/youtube-job-view.test.js`
- Create: `test/native-port.test.js`

- [ ] **Step 1: Escrever testes JavaScript RED**

```js
// core assertions for test/youtube-protocol.test.js
assert.equal(canonicalYouTubePageUrl('https://youtu.be/jNQXAC9IVRw?t=3'), 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
assert.equal(canonicalYouTubePageUrl('https://evil.test/watch?v=jNQXAC9IVRw'), null);
const progressEvent = {
  type: 'jobProgress', requestId: 'r1', jobId: 'j1', stage: 'video', percent: 50,
  downloadedBytes: 50, totalBytes: 100, speedBytesPerSecond: 25, etaSeconds: 2,
};
assert.deepEqual(assertHostEvent(progressEvent), progressEvent);
assert.throws(() => assertHostEvent({ type: 'jobProgress', requestId: 'r1', jobId: 'j1', stage: 'video', percent: 101 }), /Mensagem inválida/);
```

`native-port.test.js` uses a fake port with `onMessage`/`onDisconnect`, asserts unique request IDs, response correlation, event forwarding, timeout rejection, and rejection of all pending calls on disconnect.

- [ ] **Step 2: Rodar RED**

Run: `node --test test/youtube-protocol.test.js test/youtube-job-view.test.js test/native-port.test.js`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implementar contratos puros e porta injetável**

`protocol.js` exports frozen `YOUTUBE_ACTIONS` (`LIST_FORMATS`, `START_DOWNLOAD`, `CANCEL_DOWNLOAD`, `GET_JOB`), host command builders, `assertHostEvent`, `assertFormatsResult`, and size/type bounds. `job-view.js` accepts only states `preparing`, `video`, `audio`, `merge`, `finalize`, `complete`, `cancelled`, `failed`, `interrupted`, clamps percentages without inventing unknown totals, and maps them to Portuguese labels.

`createNativePortClient({ connectNative, setTimeoutFn, clearTimeoutFn, onEvent })` connects only to `com.videoradar.helper`, uses 15 seconds for ping/list and no request timeout after a start acknowledgement, never auto-retries a command with side effects, and exposes `request(type,payload)`, `disconnect()` and `connected`.

Start `protocol.js` with this exact public surface:

```js
export const NATIVE_HOST = 'com.videoradar.helper';
export const YOUTUBE_ACTIONS = Object.freeze({
  LIST_FORMATS: 'YOUTUBE_LIST_FORMATS',
  START_DOWNLOAD: 'YOUTUBE_START_DOWNLOAD',
  CANCEL_DOWNLOAD: 'YOUTUBE_CANCEL_DOWNLOAD',
  GET_JOB: 'YOUTUBE_GET_JOB',
});
export const HOST_COMMANDS = Object.freeze({
  PING: 'ping',
  LIST_FORMATS: 'listFormats',
  START_DOWNLOAD: 'startDownload',
  CANCEL_DOWNLOAD: 'cancelDownload',
  GET_JOB: 'getJob',
});
export const HOST_EVENTS = new Set([
  'ready', 'formats', 'jobStarted', 'jobProgress', 'jobCompleted', 'jobCancelled', 'jobFailed',
]);

export function hostCommand(type, requestId, payload = {}) {
  if (!Object.values(HOST_COMMANDS).includes(type) || !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
    throw new Error('Mensagem inválida');
  }
  return { type, requestId, payload };
}
```

`createNativePortClient` returns exactly:

```js
return Object.freeze({
  request,
  disconnect: () => port?.disconnect(),
  get connected() { return Boolean(port); },
});
```

- [ ] **Step 4: Rodar GREEN e commitar**

Run: `node --test test/youtube-protocol.test.js test/youtube-job-view.test.js test/native-port.test.js`

Expected: todos passam.

```powershell
git add src/youtube src/background/native-port.js test/youtube-protocol.test.js test/youtube-job-view.test.js test/native-port.test.js
git commit -m "feat: add youtube native client contracts"
```

## Task 7: Coordenar jobs no background sem tocar no HLS

**Files:**
- Create: `src/background/youtube-coordinator.js`
- Create: `src/background/router.js`
- Modify: `src/background/main.js`
- Modify: `manifest.json`
- Create: `scripts/generate-extension-key.mjs`
- Create: `scripts/generate-extension-icon.ps1`
- Create: `assets/icon-128.png`
- Modify: `test/manifest.test.js`
- Create: `test/youtube-coordinator.test.js`
- Create: `test/background-router.test.js`

- [ ] **Step 1: Escrever testes de storage, desconexão e router**

Use fakes for `storage.local`, native client and notifications. Assert:

- `LIST_FORMATS` never writes a job;
- `START_DOWNLOAD` persists `youtubeJob` before acknowledging;
- progress is monotonic inside one stage and can move to the next stage;
- completion persists `path` and creates one notification;
- cancel maps to `cancelled`;
- disconnect maps an active snapshot to `interrupted`;
- a new coordinator marks a stale active snapshot interrupted when `getJob` returns null;
- the router sends only `YOUTUBE_ACTIONS` to YouTube and preserves every HLS/direct action in the existing handler.

- [ ] **Step 2: Rodar RED**

Run: `node --test test/youtube-coordinator.test.js test/background-router.test.js test/manifest.test.js`

Expected: FAIL for missing coordinator/router and missing permissions.

- [ ] **Step 3: Implementar coordinator, router e manifesto**

`createYouTubeCoordinator` receives `{ nativeClient, storageLocal, notifications, now }`, owns only key `youtubeJob`, and exposes `ready`, `handle(message)` and `handleHostEvent(event)`. It never reads/writes `chrome.storage.session` and never examines HLS keys.

`createBackgroundRouter({ hls, youtube })` delegates by the `YOUTUBE_ACTIONS` set; unknown actions continue through the strict existing validators and fail safely. `src/background/main.js` composes the existing HLS handler unchanged, the native client and YouTube coordinator, then passes the router to `createBackgroundMessageListener`.

```js
// src/background/router.js
import { YOUTUBE_ACTIONS } from '../youtube/protocol.js';

const YOUTUBE_ACTION_SET = new Set(Object.values(YOUTUBE_ACTIONS));

export function createBackgroundRouter({ hls, youtube }) {
  if (!hls?.handle || !youtube?.handle) throw new TypeError('Coordenador inválido');
  return Object.freeze({
    ready: Promise.all([hls.ready, youtube.ready]),
    handle(message) {
      return YOUTUBE_ACTION_SET.has(message?.action) ? youtube.handle(message) : hls.handle(message);
    },
  });
}
```

The coordinator's persisted shape is fixed and validated before every write:

```js
{
  jobId: 'uuid', videoId: 'jNQXAC9IVRw', title: 'Me at the zoo',
  url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', height: 1080,
  format: 'mp4', stage: 'video', percent: 62, downloadedBytes: 123,
  totalBytes: 456, speedBytesPerSecond: 789, etaSeconds: 12,
  path: null, error: null, updatedAt: 1784678400000
}
```

Add `nativeMessaging` and `notifications` to permissions. Generate a stable development key once with Node `crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })`, commit only the DER SPKI public key in `manifest.key`, and save no private key in Git. Generate `assets/icon-128.png` with a deterministic PowerShell/System.Drawing script (navy 128×128 square, green radar rings), declare it in `manifest.icons`, and pass `chrome.runtime.getURL('assets/icon-128.png')` to completion notifications. Update `test/manifest.test.js` to require the two permissions, the icon, and a nonempty base64 key while preserving empty mandatory host permissions.

```js
// scripts/generate-extension-key.mjs — run once; private material is never written
import { generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const manifestUrl = new URL('../manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
manifest.key = key;
await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log('Stable development key written to manifest.json');
```

Run: `node scripts/generate-extension-key.mjs`

Expected: `manifest.json` contains one base64 public key and subsequent extension reloads keep the same ID.

- [ ] **Step 4: Rodar GREEN e regressão HLS**

Run: `node --test test/youtube-coordinator.test.js test/background-router.test.js test/manifest.test.js test/background-handlers.test.js`

Expected: todos passam; testes HLS não mudam.

```powershell
git add manifest.json assets/icon-128.png scripts/generate-extension-key.mjs scripts/generate-extension-icon.ps1 src/background src/youtube test
git commit -m "feat: coordinate persistent youtube jobs"
```

## Task 8: Integrar busca YouTube e restauração no popup

**Files:**
- Modify: `src/popup/main.js`
- Modify: `src/popup/state.js`
- Modify: `test/popup-main-helpers.test.js`
- Modify: `test/popup-state.test.js`

- [ ] **Step 1: Escrever testes de busca e restauração**

Add reducer cases for `YOUTUBE_FORMATS_LOADED`, `YOUTUBE_JOB_RESTORED`, `YOUTUBE_JOB_UPDATED`. Test one item with `kind: 'youtube'`, title, qualities descending, selected height, predicted format and job state. Test that an active restored job renders before a new scan and that a terminal snapshot remains visible.

In popup helper tests, use a fake active YouTube tab and assert `bootPopup` sends `LIST_FORMATS` instead of `chrome.scripting.executeScript`. On a normal site, assert the existing hybrid scan remains unchanged. Assert boot sends `GET_JOB` once and subscribes to `storage.local` key `youtubeJob` while still listening to HLS in `storage.session`.

- [ ] **Step 2: Rodar RED**

Run: `node --test test/popup-main-helpers.test.js test/popup-state.test.js`

Expected: FAIL because the popup has no YouTube branch.

- [ ] **Step 3: Implementar branch sob demanda**

At popup boot, render idle, request `GET_JOB`, and dispatch a restore only when a safe snapshot exists. In `scan()`, canonicalize `tab.url`; if YouTube, send `LIST_FORMATS` and build one item from the reduced response. Otherwise run the existing page injection exactly as today.

For YouTube download, send `{ url, height }` through `START_DOWNLOAD`; for cancel send `{ jobId }` through `CANCEL_DOWNLOAD`. Do not request optional host permissions for YouTube. Route `chrome.storage.onChanged` by area: session/HLS keeps current code; local/`youtubeJob` dispatches the YouTube update.

Use this branch at the start of the existing `scan()` after obtaining the active tab:

```js
const youtubeUrl = canonicalYouTubePageUrl(tab.url);
if (youtubeUrl) {
  const response = await chromeApi.runtime.sendMessage({
    target: 'background',
    action: YOUTUBE_ACTIONS.LIST_FORMATS,
    payload: { url: youtubeUrl },
  });
  const formats = unwrapYouTubeFormats(response);
  dispatch({ type: 'YOUTUBE_FORMATS_LOADED', item: youtubeItem(formats, youtubeUrl), target: 'youtube.com' });
  return;
}
```

Add these exact command envelopes to the click handlers:

```js
await chromeApi.runtime.sendMessage({
  target: 'background', action: YOUTUBE_ACTIONS.START_DOWNLOAD,
  payload: { url: item.url, height: item.variants[selectedIndex].height },
});

await chromeApi.runtime.sendMessage({
  target: 'background', action: YOUTUBE_ACTIONS.CANCEL_DOWNLOAD,
  payload: { jobId: item.jobId },
});
```

On boot, send `YOUTUBE_GET_JOB` with `{}` and dispatch `YOUTUBE_JOB_RESTORED` only after `assertJobSnapshot` succeeds.

- [ ] **Step 4: Rodar GREEN e commitar**

Run: `node --test test/popup-main-helpers.test.js test/popup-state.test.js test/media-candidates.test.js`

Expected: todos passam.

```powershell
git add src/popup test/popup-main-helpers.test.js test/popup-state.test.js
git commit -m "feat: add youtube search and popup recovery"
```

## Task 9: Renderizar qualidade, cancelamento e progresso acessível

**Files:**
- Modify: `src/popup/render.js`
- Modify: `styles/popup.css`
- Modify: `test/popup-layout.test.js`
- Create: `test/popup-youtube-render.test.js`

- [ ] **Step 1: Escrever testes DOM/markup RED**

Render a YouTube item in ready, downloading with known percentage, downloading with unknown percentage, complete and failed states. Assert:

- metadata says `YOUTUBE / SAÍDA .MP4` or `.WEBM`;
- quality select contains each height once;
- active item has enabled `data-cancel` and no enabled `data-download`;
- known progress sets `value` and `aria-valuetext`;
- unknown progress omits `value` and announces the stage;
- complete item shows the final path;
- popup width remains exactly 380px and no content forces horizontal overflow.

- [ ] **Step 2: Rodar RED**

Run: `node --test test/popup-youtube-render.test.js test/popup-layout.test.js`

Expected: FAIL because render has no YouTube/cancel branch.

- [ ] **Step 3: Implementar UI mantendo o design atual**

Extend `appendMediaItem` by kind instead of duplicating the card. Use the existing `<progress>` element; set `.value` only for finite percentages. During active YouTube stages render a secondary danger/quiet button **Cancelar** with `data-cancel`. Preserve `prefers-reduced-motion`, keyboard focus and existing HLS progress.

Add only these new visual roles: `.button--cancel`, `.media-row__path`, `.media-row__stage`, and an indeterminate progress style. Do not change `html, body` width/min-width.

The active branch must use native progress semantics instead of reusing HLS segment labels:

```js
if (item.kind === 'youtube' && item.active) {
  const cancel = button('Cancelar', 'button button--cancel', 'cancel', item.jobId);
  row.append(cancel);
  const progress = node('progress', 'media-row__progress');
  progress.max = 100;
  if (Number.isFinite(item.progress)) progress.value = item.progress;
  progress.setAttribute('aria-label', `Progresso de ${item.filename}`);
  progress.setAttribute('aria-valuetext', item.statusLabel);
  row.append(progress, node('p', 'media-row__stage', item.statusLabel));
}
if (item.kind === 'youtube' && item.path) {
  const path = node('p', 'media-row__path', item.path);
  path.title = item.path;
  row.append(path);
}
```

Guard the existing generic status paragraph with `!(item.kind === 'youtube' && item.active)` so the active stage is announced once, not duplicated.

- [ ] **Step 4: Rodar GREEN e commitar**

Run: `node --test test/popup-youtube-render.test.js test/popup-layout.test.js test/popup-state.test.js`

Expected: todos passam.

```powershell
git add src/popup/render.js styles/popup.css test/popup-youtube-render.test.js test/popup-layout.test.js
git commit -m "feat: show persistent youtube progress"
```

## Task 10: Fixar ferramentas, empacotar e instalar sem administrador

**Files:**
- Create: `native-host/tool-lock.json`
- Create: `scripts/lock-native-tools.ps1`
- Create: `scripts/fetch-native-tools.ps1`
- Create: `scripts/package-native-helper.ps1`
- Create: `scripts/install-native-host.ps1`
- Create: `Instalar-Video-Radar.cmd`
- Create: `test/native-installer.test.js`

- [ ] **Step 1: Escrever teste estático do instalador RED**

The Node test reads all PowerShell/cmd files and asserts:

- installation root is `%LOCALAPPDATA%\VideoRadar`;
- native manifest uses `type: stdio` and exactly one explicit origin matching `^chrome-extension://[a-p]{32}/$`;
- registry targets include Google Chrome, Microsoft Edge and Brave HKCU paths;
- no HKLM write, elevation request, wildcard origin, HTTP listener, TCP listener or localhost URL appears;
- every tool lock entry has HTTPS URL and 64 lowercase SHA-256 characters;
- installer checks hashes before copying/extracting.

- [ ] **Step 2: Rodar RED**

Run: `node --test test/native-installer.test.js`

Expected: FAIL because scripts/lock do not exist.

- [ ] **Step 3: Implementar lock e fetch verificável**

`lock-native-tools.ps1` queries only official GitHub releases for `yt-dlp/yt-dlp`, `denoland/deno`, and `yt-dlp/FFmpeg-Builds`; it selects `yt-dlp.exe`, `deno-x86_64-pc-windows-msvc.zip`, and `ffmpeg-master-latest-win64-gpl.zip`, requires the release API's `digest` to be `sha256:<64 hex>` (and cross-checks a published checksum artifact when supplied), then writes version/tag, immutable release-asset API URL by numeric asset ID, SHA-256 and archive layout to `native-host/tool-lock.json`.

`fetch-native-tools.ps1` reads the lock, downloads into `.tools/native-cache`, verifies `Get-FileHash -Algorithm SHA256` before extraction, and places only `yt-dlp.exe`, `deno.exe`, `ffmpeg.exe`, `ffprobe.exe` plus upstream license files in `.tools/native-ready`.

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lock-native-tools.ps1`

Expected: lock contains three sources and no moving `latest/download` URL.

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-native-tools.ps1`

Expected: four executables and license material exist in `.tools/native-ready`; any hash mismatch aborts before extraction.

- [ ] **Step 4: Implementar pacote e registro HKCU**

`package-native-helper.ps1` publishes the host single-file, computes the extension ID from `manifest.key` (SHA-256 first 16 bytes mapped nibbles to `a`–`p`), copies tools/licenses, writes `extension-id.txt`, and produces `dist/video-radar-helper`.

`install-native-host.ps1` copies that directory atomically to `%LOCALAPPDATA%\VideoRadar`, writes an absolute-path `com.videoradar.helper.json`, and sets the default value of these user keys to the JSON path:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.videoradar.helper
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.videoradar.helper
HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.videoradar.helper
```

It invokes the host diagnostic mode `--ping`, reports success/failure in Portuguese and never requests elevation. `Instalar-Video-Radar.cmd` calls this PowerShell script relative to its own directory and pauses only on error.

The manifest/registry core is exactly:

```powershell
$hostManifest = [ordered]@{
  name = 'com.videoradar.helper'
  description = 'Auxiliar local do Vídeo Radar'
  path = (Join-Path $installRoot 'host\video-radar-host.exe')
  type = 'stdio'
  allowed_origins = @("chrome-extension://$extensionId/")
}
$manifestPath = Join-Path $installRoot 'native-host\com.videoradar.helper.json'
$manifestJson = $hostManifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))

$registryKeys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.videoradar.helper',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.videoradar.helper',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.videoradar.helper'
)
foreach ($key in $registryKeys) {
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifestPath
}
```

Parse the exact installed file with `ConvertFrom-Json` before setting registry keys.

- [ ] **Step 5: Rodar GREEN, pacote e commitar**

Run: `node --test test/native-installer.test.js`

Expected: PASS.

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-native-helper.ps1`

Expected: complete `dist/video-radar-helper` with no SDK requirement.

```powershell
git add native-host/tool-lock.json scripts/lock-native-tools.ps1 scripts/fetch-native-tools.ps1 scripts/package-native-helper.ps1 scripts/install-native-host.ps1 Instalar-Video-Radar.cmd test/native-installer.test.js
git commit -m "build: package windows native helper"
```

## Task 11: Preflight, documentação e verificação real proporcional

**Files:**
- Modify: `scripts/validate-extension.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Create: `docs/verification/2026-07-22-youtube-native-helper.md`
- Modify: `test/extension-preflight.test.js`

- [ ] **Step 1: Escrever preflight final RED**

Extend the preflight test to require:

- stable manifest key and exact new permissions;
- every new local JS import;
- no `http://localhost`, `https://localhost`, `HttpListener`, `TcpListener`, `--cookies`, `--cookies-from-browser` or browser profile flags in production host/extension sources;
- `tool-lock.json` valid;
- installer and host project present;
- `npm run check:all` includes JavaScript and native tests.

- [ ] **Step 2: Rodar RED**

Run: `node --test test/extension-preflight.test.js`

Expected: FAIL until validation/package commands are updated.

- [ ] **Step 3: Finalizar validação e documentação**

Update `README.md` with:

1. load the unpacked extension;
2. run `Instalar-Video-Radar.cmd` once;
3. reload the extension;
4. open an authorized public YouTube video, click **Buscar vídeos**, choose quality and download;
5. explain `Downloads\Video Radar`, progress recovery, cancellation and limits (no DRM/private/live/cookies);
6. explain how to uninstall the three HKCU registrations and `%LOCALAPPDATA%\VideoRadar`.

Set `check:all` to run extension preflight/tests and the native test runner. Do not make ordinary `npm test` download tools or access YouTube.

- [ ] **Step 4: Executar verificação automatizada fresca**

Run: `npm run check:all`

Expected: extension preflight passes, all Node tests pass, `Native host tests passed`, exit `0`.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 5: Verificar manualmente um vídeo autorizado**

Use one public video the tester owns or is authorized to save. Record in `docs/verification/2026-07-22-youtube-native-helper.md`:

| Scenario | Expected |
|---|---|
| Helper absent | Explicit install message, never endless Preparing |
| List formats | Available heights appear once, descending |
| Selected quality | Output height is at or below the chosen height |
| Popup close/reopen | Same job, stage and latest percentage reappear |
| Merge | Final file has audio and video |
| Cancel | Child exits and temp folder is removed |
| Complete | Notification appears and the final path exists under `Downloads\Video Radar` |
| Restricted/fake auth error | Clear refusal; no cookie/profile request |
| Regression | Direct MP4/WEBM/MOV and fixture HLS still work |

Do not test DRM circumvention, private videos or user cookies.

- [ ] **Step 6: Commit final handoff**

```powershell
git add README.md package.json scripts/validate-extension.mjs test/extension-preflight.test.js docs/verification/2026-07-22-youtube-native-helper.md
git commit -m "docs: verify youtube native helper"
```

## Final completion gate

Run these commands fresh and read the complete output:

```powershell
npm run check:all
git diff --check
git status --short
git log --oneline -15
```

Completion requires zero test failures, no unintended working-tree changes, a packaged self-contained host, an installer diagnostic pass, and concrete manual evidence for quality selection plus popup close/reopen persistence.
