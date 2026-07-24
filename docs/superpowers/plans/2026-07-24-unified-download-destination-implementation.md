# Unified Download Destination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unificar o destino de downloads diretos, HLS e YouTube com uma pasta padrão escolhida no Windows e a opção persistente “Perguntar onde salvar cada download”.

**Architecture:** A extensão mantém a preferência versionada em `chrome.storage.local` e usa o mesmo cliente Native Messaging já compartilhado pelo service worker. O auxiliar nativo escolhe pastas, entrega arquivos de preparação e recebe o destino por trabalho do YouTube; um coordenador de realocação persiste cada download direto/HLS por `downloadId` para sobreviver ao fechamento do popup e à suspensão do service worker.

**Tech Stack:** Chrome Extensions Manifest V3, JavaScript ES modules, `chrome.downloads`, `chrome.storage.local`, Native Messaging, Node.js `node:test`, C#/.NET 10, Windows `IFileOpenDialog`, PowerShell.

---

## Referências obrigatórias

- Especificação aprovada: `docs/superpowers/specs/2026-07-24-unified-download-destination-design.md`
- Protocolo YouTube existente: `src/youtube/protocol.js`
- Cliente nativo existente: `src/background/native-port.js`
- Host existente: `native-host/VideoRadar.NativeHost/Host/NativeHostServer.cs`
- Caminhos existentes: `native-host/VideoRadar.NativeHost/Files/DownloadPaths.cs`
- Testes completos: `npm run check:all`

## Mapa de arquivos

### Preferências

- Modify: `src/shared/download-preferences.js` — esquema v2, migração, validação e criação de alvo do navegador.
- Create: `test/download-preferences.test.js` — defaults, migração e alvos `saveAs`/staging.

### Contrato Native Messaging

- Modify: `src/youtube/protocol.js` — comandos e eventos para seletor e movimentação.
- Modify: `src/background/native-port.js` — correlação das novas respostas.
- Modify: `test/youtube-protocol.test.js`
- Modify: `test/native-port.test.js`
- Modify: `native-host/VideoRadar.NativeHost/Protocol/HostCommand.cs`
- Modify: `native-host/VideoRadar.NativeHost/Host/NativeHostServer.cs`
- Modify: `native-host/VideoRadar.NativeHost/HostInfo.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Protocol.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Server.cs`

### Seletor e arquivos no Windows

- Create: `native-host/VideoRadar.NativeHost/Windows/IFolderPicker.cs` — seam testável.
- Create: `native-host/VideoRadar.NativeHost/Windows/WindowsFolderPicker.cs` — `IFileOpenDialog` em thread STA.
- Create: `native-host/VideoRadar.NativeHost/Files/IDownloadFileMover.cs` — contrato de entrega.
- Create: `native-host/VideoRadar.NativeHost/Files/DownloadFileMover.cs` — validação, conflito e movimentação segura.
- Modify: `native-host/VideoRadar.NativeHost/Files/DownloadPaths.cs` — validação reutilizável da pasta final.
- Modify: `native-host/VideoRadar.NativeHost/Program.cs` — composição concreta.
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Download.cs`

### YouTube

- Create: `native-host/VideoRadar.NativeHost/Files/IDownloadPathsFactory.cs` — cria caminhos por trabalho.
- Create: `native-host/VideoRadar.NativeHost/Files/DownloadPathsFactory.cs`
- Modify: `native-host/VideoRadar.NativeHost/YouTube/IYouTubeService.cs`
- Modify: `native-host/VideoRadar.NativeHost/YouTube/YouTubeService.cs`
- Modify: `src/background/youtube-coordinator.js`
- Modify: `test/youtube-coordinator.test.js`

### Diretos e HLS

- Create: `src/background/download-relocation.js` — estado persistente e entrega pós-download.
- Create: `test/download-relocation.test.js`
- Modify: `src/background/handlers.js`
- Modify: `src/background/main.js`
- Modify: `test/background-handlers.test.js`

### Interface

- Modify: `options.html`
- Modify: `src/options/main.js`
- Modify: `styles/options.css`
- Create: `test/options.test.js`
- Modify: `src/popup/state.js`
- Modify: `src/popup/render.js`
- Modify: `src/popup/main.js`
- Modify: `test/popup-state.test.js`
- Modify: `test/popup-render.test.js`
- Modify: `test/popup-main.test.js`

### Documentação e pacote

- Modify: `README.md`
- Modify: `scripts/validate-extension.mjs`
- Modify: testes de manifesto/preflight somente se o contrato atual exigir uma nova asserção.

## Task 1: Versionar e migrar as preferências de download

**Files:**
- Modify: `src/shared/download-preferences.js`
- Create: `test/download-preferences.test.js`

- [ ] **Step 1: Escrever testes de defaults, migração e validação**

```js
// test/download-preferences.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_DOWNLOAD_PREFERENCES,
  normalizeDownloadPreferences,
  validateDownloadPreferences,
  browserDownloadTarget,
} from '../src/shared/download-preferences.js';

test('novas instalações perguntam onde salvar', () => {
  assert.deepEqual(normalizeDownloadPreferences(null), DEFAULT_DOWNLOAD_PREFERENCES);
  assert.deepEqual(DEFAULT_DOWNLOAD_PREFERENCES, {
    schemaVersion: 2,
    askEveryTime: true,
    defaultFolder: null,
  });
});

test('migra a preferência automática antiga sem converter subpasta relativa', () => {
  assert.deepEqual(normalizeDownloadPreferences({ subfolder: 'Cursos', automatic: true }), {
    schemaVersion: 2, askEveryTime: false, defaultFolder: null,
  });
  assert.deepEqual(normalizeDownloadPreferences({ subfolder: 'Cursos', automatic: false }), {
    schemaVersion: 2, askEveryTime: true, defaultFolder: null,
  });
});

test('aceita somente caminhos absolutos Windows escolhidos pelo host', () => {
  assert.deepEqual(validateDownloadPreferences({
    schemaVersion: 2,
    askEveryTime: false,
    defaultFolder: String.raw`D:\Vídeos`,
  }), {
    schemaVersion: 2,
    askEveryTime: false,
    defaultFolder: String.raw`D:\Vídeos`,
  });
  for (const path of ['', 'Vídeos', String.raw`C:\a\..\b`, 'C:/a/./b']) {
    assert.throws(() => validateDownloadPreferences({
      schemaVersion: 2, askEveryTime: false, defaultFolder: path,
    }), /pasta/i);
  }
});

test('cria alvo do navegador para perguntar ou preparar entrega automática', () => {
  assert.deepEqual(browserDownloadTarget('aula.ts', {
    schemaVersion: 2, askEveryTime: true, defaultFolder: null,
  }, 'op_123'), { filename: 'aula.ts', saveAs: true, staging: false });
  assert.deepEqual(browserDownloadTarget('aula.ts', {
    schemaVersion: 2, askEveryTime: false, defaultFolder: String.raw`D:\Vídeos`,
  }, 'op_123'), {
    filename: 'Video Radar/.staging/op_123/aula.ts',
    saveAs: false,
    staging: true,
  });
});
```

- [ ] **Step 2: Executar o teste e confirmar RED**

Run: `node --test test/download-preferences.test.js`

Expected: FAIL porque `browserDownloadTarget` e o esquema v2 ainda não existem.

- [ ] **Step 3: Implementar o esquema v2 e o alvo do navegador**

```js
// src/shared/download-preferences.js
export const DOWNLOAD_PREFERENCES_KEY = 'downloadPreferences';
export const DOWNLOAD_PREFERENCES_SCHEMA = 2;
export const DEFAULT_DOWNLOAD_PREFERENCES = Object.freeze({
  schemaVersion: DOWNLOAD_PREFERENCES_SCHEMA,
  askEveryTime: true,
  defaultFolder: null,
});

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/;
const OPAQUE_OPERATION = /^[A-Za-z0-9_-]{1,128}$/;

export function normalizeWindowsFolder(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 1024 || !WINDOWS_ABSOLUTE.test(value)) {
    throw new Error('Escolha uma pasta absoluta válida.');
  }
  const segments = value.replace(/^\\\\[^\\]+\\[^\\]+\\?/, '').split(/[\\/]/);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Escolha uma pasta absoluta válida.');
  }
  if (/^[A-Za-z]:\\$/.test(value)) return value;
  return value.replace(/[\\/]+$/, '');
}

export function normalizeDownloadPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_DOWNLOAD_PREFERENCES };
  }
  if (value.schemaVersion !== DOWNLOAD_PREFERENCES_SCHEMA) {
    return {
      schemaVersion: DOWNLOAD_PREFERENCES_SCHEMA,
      askEveryTime: value.automatic !== true,
      defaultFolder: null,
    };
  }
  try {
    return {
      schemaVersion: DOWNLOAD_PREFERENCES_SCHEMA,
      askEveryTime: value.askEveryTime !== false,
      defaultFolder: normalizeWindowsFolder(value.defaultFolder),
    };
  } catch {
    return { ...DEFAULT_DOWNLOAD_PREFERENCES };
  }
}

export function validateDownloadPreferences(value) {
  return {
    schemaVersion: DOWNLOAD_PREFERENCES_SCHEMA,
    askEveryTime: value?.askEveryTime === true,
    defaultFolder: normalizeWindowsFolder(value?.defaultFolder),
  };
}

export async function readDownloadPreferences(storageLocal) {
  try {
    const stored = await storageLocal.get(DOWNLOAD_PREFERENCES_KEY);
    return normalizeDownloadPreferences(stored?.[DOWNLOAD_PREFERENCES_KEY]);
  } catch {
    return { ...DEFAULT_DOWNLOAD_PREFERENCES };
  }
}

export function browserDownloadTarget(filename, preferences, operationId) {
  const normalized = normalizeDownloadPreferences(preferences);
  if (normalized.askEveryTime) return { filename, saveAs: true, staging: false };
  if (!OPAQUE_OPERATION.test(operationId)) throw new Error('Operação de download inválida.');
  return {
    filename: `Video Radar/.staging/${operationId}/${filename}`,
    saveAs: false,
    staging: true,
  };
}
```

- [ ] **Step 4: Executar os testes focados**

Run: `node --test test/download-preferences.test.js`

Expected: quatro testes PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/shared/download-preferences.js test/download-preferences.test.js
git commit -m "feat: version download destination preferences"
```

## Task 2: Ampliar o protocolo JavaScript do auxiliar nativo

**Files:**
- Modify: `src/youtube/protocol.js`
- Modify: `src/background/native-port.js`
- Modify: `test/youtube-protocol.test.js`
- Modify: `test/native-port.test.js`

- [ ] **Step 1: Adicionar testes dos novos comandos e eventos**

```js
// acrescentar em test/youtube-protocol.test.js
test('valida respostas do seletor e da movimentação', () => {
  assert.deepEqual(assertHostEvent({
    type: 'folderSelected', requestId: 'r1', path: String.raw`D:\Vídeos`,
  }), {
    type: 'folderSelected', requestId: 'r1', path: String.raw`D:\Vídeos`,
  });
  assert.deepEqual(assertHostEvent({
    type: 'folderSelectionCancelled', requestId: 'r2',
  }), {
    type: 'folderSelectionCancelled', requestId: 'r2',
  });
  assert.deepEqual(assertHostEvent({
    type: 'fileMoved', requestId: 'r3', downloadId: 42,
    finalPath: String.raw`D:\Vídeos\aula.ts`,
  }), {
    type: 'fileMoved', requestId: 'r3', downloadId: 42,
    finalPath: String.raw`D:\Vídeos\aula.ts`,
  });
  assert.throws(() => assertHostEvent({
    type: 'folderSelected', requestId: 'r4', path: 'relative',
  }), /Mensagem inválida/);
});
```

```js
// acrescentar em test/native-port.test.js
test('correlaciona seletor de pasta e movimentação', async () => {
  const port = fakePort();
  const client = createNativePortClient({ connectNative: () => port, onEvent() {} });
  const choose = client.request(HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER);
  port.emit({
    type: 'folderSelected',
    requestId: port.messages[0].requestId,
    path: String.raw`D:\Vídeos`,
  });
  assert.equal((await choose).path, String.raw`D:\Vídeos`);

  const move = client.request(HOST_COMMANDS.MOVE_DOWNLOADED_FILE, {
    downloadId: 42,
    sourcePath: String.raw`C:\Downloads\Video Radar\.staging\op_1\aula.ts`,
    destinationFolder: String.raw`D:\Vídeos`,
  });
  port.emit({
    type: 'fileMoved',
    requestId: port.messages[1].requestId,
    downloadId: 42,
    finalPath: String.raw`D:\Vídeos\aula.ts`,
  });
  assert.equal((await move).finalPath, String.raw`D:\Vídeos\aula.ts`);
});
```

- [ ] **Step 2: Executar os testes e confirmar RED**

Run: `node --test test/youtube-protocol.test.js test/native-port.test.js`

Expected: FAIL porque as constantes e os eventos não existem.

- [ ] **Step 3: Implementar constantes, validação e correlação**

```js
// acrescentar ao objeto HOST_COMMANDS em src/youtube/protocol.js
CHOOSE_DOWNLOAD_FOLDER: 'chooseDownloadFolder',
MOVE_DOWNLOADED_FILE: 'moveDownloadedFile',
```

```js
// acrescentar ao objeto HOST_EVENTS em src/youtube/protocol.js
FOLDER_SELECTED: 'folderSelected',
FOLDER_SELECTION_CANCELLED: 'folderSelectionCancelled',
FILE_MOVED: 'fileMoved',
```

```js
// acrescentar aos branches de assertHostEvent
if (event.type === HOST_EVENTS.FOLDER_SELECTION_CANCELLED) {
  return exactEvent(event, ['type', 'requestId']);
}
if (event.type === HOST_EVENTS.FOLDER_SELECTED) {
  assertWindowsAbsolutePath(event.path);
  return exactEvent(event, ['type', 'requestId', 'path']);
}
if (event.type === HOST_EVENTS.FILE_MOVED) {
  if (!Number.isInteger(event.downloadId) || event.downloadId < 0) invalidMessage();
  assertWindowsAbsolutePath(event.finalPath);
  return exactEvent(event, ['type', 'requestId', 'downloadId', 'finalPath']);
}
```

```js
// substituir RESPONSE_TYPES em src/background/native-port.js
[HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER]: new Set([
  HOST_EVENTS.FOLDER_SELECTED,
  HOST_EVENTS.FOLDER_SELECTION_CANCELLED,
]),
[HOST_COMMANDS.MOVE_DOWNLOADED_FILE]: new Set([HOST_EVENTS.FILE_MOVED]),
```

O objeto inteiro passa a armazenar `Set` para todos os comandos:

```js
const RESPONSE_TYPES = Object.freeze({
  [HOST_COMMANDS.PING]: new Set([HOST_EVENTS.READY]),
  [HOST_COMMANDS.LIST_FORMATS]: new Set([HOST_EVENTS.FORMATS]),
  [HOST_COMMANDS.START_DOWNLOAD]: new Set([HOST_EVENTS.JOB_STARTED]),
  [HOST_COMMANDS.GET_JOB]: new Set([HOST_EVENTS.READY]),
  [HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER]: new Set([
    HOST_EVENTS.FOLDER_SELECTED,
    HOST_EVENTS.FOLDER_SELECTION_CANCELLED,
  ]),
  [HOST_COMMANDS.MOVE_DOWNLOADED_FILE]: new Set([HOST_EVENTS.FILE_MOVED]),
});
```

Dentro de `pending.expected`, trocar a comparação por:

```js
if (!RESPONSE_TYPES[type]?.has(event.type)) return false;
```

Substituir o `Set` público atual por constantes nomeadas e um `Set` interno:

```js
export const MIN_NATIVE_PROTOCOL_VERSION = 2;
export const HOST_EVENTS = Object.freeze({
  READY: 'ready',
  FORMATS: 'formats',
  JOB_STARTED: 'jobStarted',
  JOB_PROGRESS: 'jobProgress',
  JOB_COMPLETED: 'jobCompleted',
  JOB_CANCELLED: 'jobCancelled',
  JOB_FAILED: 'jobFailed',
  FOLDER_SELECTED: 'folderSelected',
  FOLDER_SELECTION_CANCELLED: 'folderSelectionCancelled',
  FILE_MOVED: 'fileMoved',
});
const ALLOWED_HOST_EVENTS = new Set(Object.values(HOST_EVENTS));
```

Adicionar estes helpers completos:

```js
function assertWindowsAbsolutePath(value) {
  if (!text(value, 1024) || !/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(value)) invalid();
  if (value.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')) invalid();
  return value;
}

function exactEvent(event, keys) {
  if (Object.keys(event).length !== keys.length
      || keys.some((key) => !Object.hasOwn(event, key))) invalid();
  return Object.fromEntries(keys.map((key) => [key, event[key]]));
}
```

O branch `ready` do ping passa a exigir versão numérica e a pasta padrão efetiva:

```js
if (event.type === HOST_EVENTS.READY) {
  if (Object.hasOwn(event, 'job')) {
    return { type: event.type, requestId: event.requestId,
      job: event.job === null ? null : assertJobSnapshot(event.job) };
  }
  if (!finiteInteger(event.protocolVersion, MIN_NATIVE_PROTOCOL_VERSION, 999)
      || !text(event.nativeName, 128)) invalid();
  return {
    type: event.type,
    requestId: event.requestId,
    protocolVersion: event.protocolVersion,
    nativeName: event.nativeName,
    defaultFolder: assertWindowsAbsolutePath(event.defaultFolder),
  };
}
```

Atualizar o teste de `ready` para usar `protocolVersion: 2` e
`defaultFolder: String.raw\`C:\Users\Carlos\Downloads\Video Radar\``.

- [ ] **Step 4: Executar os testes focados**

Run: `node --test test/youtube-protocol.test.js test/native-port.test.js`

Expected: todos os testes PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/youtube/protocol.js src/background/native-port.js test/youtube-protocol.test.js test/native-port.test.js
git commit -m "feat: extend native destination protocol"
```

## Task 3: Implementar o seletor de pasta do Windows

**Files:**
- Create: `native-host/VideoRadar.NativeHost/Windows/IFolderPicker.cs`
- Create: `native-host/VideoRadar.NativeHost/Windows/WindowsFolderPicker.cs`
- Modify: `native-host/VideoRadar.NativeHost/Protocol/HostCommand.cs`
- Modify: `native-host/VideoRadar.NativeHost/Host/NativeHostServer.cs`
- Modify: `native-host/VideoRadar.NativeHost/Program.cs`
- Modify: `native-host/VideoRadar.NativeHost/HostInfo.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Protocol.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Server.cs`

- [ ] **Step 1: Escrever o teste do comando selecionado e cancelado**

```csharp
// acrescentar ao conjunto ServerTests em TestSuite.Server.cs
NativeHostServerChoosesOrCancelsFolder().GetAwaiter().GetResult();
```

```csharp
private static async Task NativeHostServerChoosesOrCancelsFolder()
{
    using var input = new ControlledInputStream(FrameCommands(
        Command("chooseDownloadFolder", "r-selected", "{}"),
        Command("chooseDownloadFolder", "r-cancelled", "{}")));
    using var output = new SignallingOutputStream();
    var picker = new FakeFolderPicker(
        @"D:\Vídeos",
        null);
    var server = CreateServer(input, output, folderPicker: picker);
    input.Complete();
    await server.RunAsync(CancellationToken.None);

    var messages = ReadFrames(output);
    Equal(@"D:\Vídeos", Message(messages, "folderSelected", "r-selected")
        .GetProperty("path").GetString());
    Message(messages, "folderSelectionCancelled", "r-cancelled");
    Equal(2, picker.CallCount);
}
```

```csharp
private sealed class FakeFolderPicker(params string?[] results) : IFolderPicker
{
    private readonly Queue<string?> results = new(results);
    public int CallCount { get; private set; }
    public Task<string?> PickAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        CallCount++;
        return Task.FromResult(results.Dequeue());
    }
}
```

- [ ] **Step 2: Executar os testes nativos e confirmar RED**

Run: `npm run test:native`

Expected: FAIL de compilação porque `IFolderPicker` e o comando ainda não existem.

- [ ] **Step 3: Criar a abstração e o seletor STA**

```csharp
// native-host/VideoRadar.NativeHost/Windows/IFolderPicker.cs
namespace VideoRadar.NativeHost.Windows;

public interface IFolderPicker
{
    Task<string?> PickAsync(CancellationToken cancellationToken);
}
```

```csharp
// estrutura pública de WindowsFolderPicker.cs
namespace VideoRadar.NativeHost.Windows;

public sealed class WindowsFolderPicker : IFolderPicker
{
    public Task<string?> PickAsync(CancellationToken cancellationToken)
    {
        var completion = new TaskCompletionSource<string?>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try { completion.TrySetResult(ShowDialog()); }
            catch (Exception error) { completion.TrySetException(error); }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        cancellationToken.Register(() => completion.TrySetCanceled(cancellationToken));
        return completion.Task;
    }

    private static string? ShowDialog()
    {
        var dialog = (IFileOpenDialog)new FileOpenDialog();
        dialog.SetOptions(FOS.FOS_PICKFOLDERS | FOS.FOS_FORCEFILESYSTEM
            | FOS.FOS_PATHMUSTEXIST | FOS.FOS_DONTADDTORECENT);
        var result = dialog.Show(IntPtr.Zero);
        if (result == unchecked((int)0x800704C7)) return null;
        Marshal.ThrowExceptionForHR(result);
        dialog.GetResult(out var item);
        item.GetDisplayName(SIGDN.SIGDN_FILESYSPATH, out var pointer);
        try { return Marshal.PtrToStringUni(pointer); }
        finally { Marshal.FreeCoTaskMem(pointer); }
    }
}
```

No mesmo arquivo, usar estas declarações COM, preservando a ordem da vtable:

```csharp
[ComImport]
[Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
private sealed class FileOpenDialog { }

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("D57C7288-D4AD-4768-BE02-9D969532D960")]
private interface IFileOpenDialog
{
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(FOS options);
    void GetOptions(out FOS options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, int alignment);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
    void GetResults(out IntPtr items);
    void GetSelectedItems(out IntPtr items);
}

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
private interface IShellItem
{
    void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid interfaceId,
        out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(SIGDN displayName, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
}

[Flags]
private enum FOS : uint
{
    FOS_PICKFOLDERS = 0x00000020,
    FOS_FORCEFILESYSTEM = 0x00000040,
    FOS_PATHMUSTEXIST = 0x00000800,
    FOS_DONTADDTORECENT = 0x02000000,
}

private enum SIGDN : uint
{
    SIGDN_FILESYSPATH = 0x80058000,
}
```

Adicionar `using System.Runtime.InteropServices;`. A assinatura `[PreserveSig]` permite
distinguir cancelamento (`0x800704C7`) de falha.

- [ ] **Step 4: Ligar o comando ao servidor**

```csharp
// HostCommand.cs
private static readonly HashSet<string> AllowedTypes =
[
    "ping", "listFormats", "startDownload", "cancelDownload", "getJob",
    "chooseDownloadFolder", "moveDownloadedFile"
];
```

```csharp
// NativeHostServer.cs: novo campo/construtor e branch do switch
private readonly IFolderPicker folderPicker;

case "chooseDownloadFolder":
    command.RequireExactPayload();
    var selected = await folderPicker.PickAsync(cancellationToken);
    await channel.WriteAsync(selected is null
        ? new { type = "folderSelectionCancelled", command.RequestId }
        : new { type = "folderSelected", command.RequestId, path = selected },
        cancellationToken);
    break;
```

```csharp
// Program.cs: composição
var folderPicker = new WindowsFolderPicker();
var server = new NativeHostServer(
    channel, youtubeService, updatePolicy, folderPicker, downloadPaths.Home);
```

Atualizar `HostInfo.ProtocolVersion` para `2`, a allowlist de eventos dos testes e o helper
`CreateServer(...)` para injetar `FakeFolderPicker`. A resposta `ready` do `ping` deve
incluir `defaultFolder = fallbackDownloadFolder`; o construtor do servidor valida e
normaliza esse caminho uma vez.

- [ ] **Step 5: Executar testes nativos**

Run: `npm run test:native`

Expected: `Native host tests passed`.

- [ ] **Step 6: Commit**

```powershell
git add native-host/VideoRadar.NativeHost native-host/VideoRadar.NativeHost.Tests
git commit -m "feat: choose download folder with windows dialog"
```

## Task 4: Entregar arquivos preparados com segurança

**Files:**
- Create: `native-host/VideoRadar.NativeHost/Files/IDownloadFileMover.cs`
- Create: `native-host/VideoRadar.NativeHost/Files/DownloadFileMover.cs`
- Modify: `native-host/VideoRadar.NativeHost/Files/DownloadPaths.cs`
- Modify: `native-host/VideoRadar.NativeHost/Host/NativeHostServer.cs`
- Modify: `native-host/VideoRadar.NativeHost/Program.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Download.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Server.cs`

- [ ] **Step 1: Escrever testes da validação, conflito e preservação**

```csharp
// acrescentar a DownloadTests em TestSuite.Download.cs
DownloadFileMoverMovesWithoutOverwrite();
DownloadFileMoverRejectsUnsafeStagingPaths();
DownloadFileMoverCopiesAcrossVolumesBeforeDeletingSource();
DownloadFileMoverPreservesSourceWhenCopyFails();
```

```csharp
private static void DownloadFileMoverMovesWithoutOverwrite()
{
    using var scope = new DownloadTestScope();
    var staging = scope.CreateStagingFile("op_1", "aula.ts", "new");
    var target = Directory.CreateDirectory(Path.Combine(scope.Root, "target")).FullName;
    File.WriteAllText(Path.Combine(target, "aula.ts"), "old");
    var mover = new DownloadFileMover();

    var result = mover.Move(staging, target, 42);

    Equal(Path.Combine(target, "aula (1).ts"), result.FinalPath);
    Equal("new", File.ReadAllText(result.FinalPath));
    True(!File.Exists(staging), "Successful move left the staging file.");
}

private static void DownloadFileMoverRejectsUnsafeStagingPaths()
{
    using var scope = new DownloadTestScope();
    var outside = Path.Combine(scope.Root, "outside.ts");
    File.WriteAllText(outside, "keep");
    var mover = new DownloadFileMover();
    Throws<ArgumentException>(() => mover.Move(outside,
        Path.Combine(scope.Root, "target"), 1));
    True(File.Exists(outside), "Rejected source was removed.");
}
```

O helper `CreateStagingFile` deve criar exatamente
`<root>/Downloads/Video Radar/.staging/<operation>/<filename>`. O teste de falha deve
injetar um `IFileTransfer` fake que lança durante a cópia e então confirmar
`File.Exists(source)`.

```csharp
private static void DownloadFileMoverCopiesAcrossVolumesBeforeDeletingSource()
{
    using var scope = new DownloadTestScope();
    var source = scope.CreateStagingFile("op_2", "aula.ts", "bytes");
    var destination = Directory.CreateDirectory(
        Path.Combine(scope.Root, "other-volume")).FullName;
    var transfer = new RecordingFileTransfer(sameVolume: false);
    var mover = new DownloadFileMover(transfer);

    var result = mover.Move(source, destination, 7);

    True(transfer.Operations.SequenceEqual(
        new[] { "copy", "promote", "delete-source" }),
        "Cross-volume delivery used an unsafe order.");
    Equal("bytes", File.ReadAllText(result.FinalPath));
    True(!File.Exists(source), "Source was not removed after promotion.");
}
```

- [ ] **Step 2: Executar os testes e confirmar RED**

Run: `npm run test:native`

Expected: FAIL porque `DownloadFileMover` ainda não existe.

- [ ] **Step 3: Criar contratos e resultado**

```csharp
// IDownloadFileMover.cs
namespace VideoRadar.NativeHost.Files;

public sealed record FileMoveResult(long DownloadId, string FinalPath);

public interface IDownloadFileMover
{
    FileMoveResult Move(string sourcePath, string destinationFolder, long downloadId);
}

internal interface IFileTransfer
{
    bool IsSameVolume(string source, string destination);
    void MoveSameVolume(string source, string destination);
    void CopyToPartial(string source, string partial);
    void PromotePartial(string partial, string destination);
    void DeleteSource(string source);
    void DeletePartial(string partial);
}
```

- [ ] **Step 4: Implementar validação e movimentação**

```csharp
// núcleo de DownloadFileMover.cs
public FileMoveResult Move(string sourcePath, string destinationFolder, long downloadId)
{
    var source = Path.GetFullPath(sourcePath);
    var destination = DownloadPaths.NormalizeDestination(destinationFolder);
    ValidateStagingSource(source);
    Directory.CreateDirectory(destination);
    EnsureWritable(destination);
    var finalPath = ReserveFinalPath(destination, Path.GetFileName(source));

    try
    {
        if (transfer.IsSameVolume(source, finalPath))
            transfer.MoveSameVolume(source, finalPath);
        else
            CopyAcrossVolumes(source, finalPath);
        return new FileMoveResult(downloadId, finalPath);
    }
    catch
    {
        if (File.Exists(source)) throw;
        throw new IOException("A entrega falhou depois da origem deixar de existir.");
    }
}
```

`ValidateStagingSource` deve:

- exigir caminho absoluto existente e `FileAttributes` sem `ReparsePoint`;
- exigir os segmentos finais `Video Radar`, `.staging`, operação e arquivo;
- validar operação com `^[A-Za-z0-9_-]{1,128}$`;
- exigir que `Path.GetFileName(source) == sourceSegment`;
- caminhar da origem até a raiz e rejeitar qualquer diretório com `ReparsePoint`.

`ReserveFinalPath` deve tentar `arquivo.ext`, `arquivo (1).ext`, `arquivo (2).ext` sem
sobrescrever. `CopyAcrossVolumes` deve copiar para
`.video-radar-<guid>.partial` na pasta final, fechar o stream, renomear o parcial para
o caminho reservado e somente então apagar a origem; no `catch`, deve apagar apenas o
parcial. A implementação concreta de `IFileTransfer.IsSameVolume` compara
`Path.GetPathRoot` com `StringComparison.OrdinalIgnoreCase`; os demais métodos chamam
`File.Move`, `File.Copy` e `File.Delete` com overwrite desativado.

- [ ] **Step 5: Implementar o comando do host**

```csharp
case "moveDownloadedFile":
    var move = command.ReadExactPayload<MoveDownloadedFilePayload>(
        "downloadId", "sourcePath", "destinationFolder");
    var delivered = fileMover.Move(
        move.SourcePath, move.DestinationFolder, move.DownloadId);
    await channel.WriteAsync(new
    {
        type = "fileMoved",
        command.RequestId,
        downloadId = delivered.DownloadId,
        finalPath = delivered.FinalPath
    }, cancellationToken);
    break;
```

```csharp
private sealed record MoveDownloadedFilePayload(
    long DownloadId,
    string SourcePath,
    string DestinationFolder);
```

Adicionar teste de servidor que envia um payload válido e confirma `fileMoved`.
Payload relativo, propriedade extra, `downloadId` negativo e pasta vazia devem produzir
`jobFailed` com código seguro `DESTINATION_INVALID`, sem encerrar o loop.

Nesta task, adicionar `IDownloadFileMover fileMover` ao construtor do servidor e ligar
`new DownloadFileMover()` em `Program.cs`.

- [ ] **Step 6: Executar testes nativos**

Run: `npm run test:native`

Expected: `Native host tests passed`.

- [ ] **Step 7: Commit**

```powershell
git add native-host/VideoRadar.NativeHost native-host/VideoRadar.NativeHost.Tests
git commit -m "feat: safely deliver staged downloads"
```

## Task 5: Permitir destino por trabalho do YouTube

**Files:**
- Create: `native-host/VideoRadar.NativeHost/Files/IDownloadPathsFactory.cs`
- Create: `native-host/VideoRadar.NativeHost/Files/DownloadPathsFactory.cs`
- Modify: `native-host/VideoRadar.NativeHost/YouTube/IYouTubeService.cs`
- Modify: `native-host/VideoRadar.NativeHost/YouTube/YouTubeService.cs`
- Modify: `native-host/VideoRadar.NativeHost/Host/NativeHostServer.cs`
- Modify: `native-host/VideoRadar.NativeHost/Program.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Download.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Server.cs`

- [ ] **Step 1: Escrever teste de destino por trabalho**

```csharp
private static void YouTubeServiceUsesPerJobDestination()
{
    using var scope = new DownloadTestScope();
    var destination = Path.Combine(scope.Root, "chosen");
    var factory = new FakeDownloadPathsFactory(scope.TempRoot);
    var runner = CreateSuccessfulYouTubeRunner(factory, destination);
    var service = new YouTubeService("tools", runner, factory);

    var result = service.StartDownloadAsync(
        "job-1",
        "https://youtu.be/jNQXAC9IVRw",
        720,
        destination,
        _ => Task.CompletedTask,
        CancellationToken.None).GetAwaiter().GetResult();

    Equal(Path.GetFullPath(destination), factory.LastDestination);
    True(result.Path.StartsWith(Path.GetFullPath(destination),
        StringComparison.OrdinalIgnoreCase), "YouTube ignored the selected destination.");
}
```

- [ ] **Step 2: Executar os testes e confirmar RED**

Run: `npm run test:native`

Expected: FAIL de compilação pela nova assinatura.

- [ ] **Step 3: Criar a fábrica e mudar a assinatura**

```csharp
// IDownloadPathsFactory.cs
namespace VideoRadar.NativeHost.Files;

public interface IDownloadPathsFactory
{
    IDownloadPaths Create(string? destinationFolder);
}
```

```csharp
// DownloadPathsFactory.cs
namespace VideoRadar.NativeHost.Files;

public sealed class DownloadPathsFactory(string fallbackHome, string tempRoot)
    : IDownloadPathsFactory
{
    public IDownloadPaths Create(string? destinationFolder)
        => new DownloadPaths(
            destinationFolder is null
                ? fallbackHome
                : DownloadPaths.NormalizeDestination(destinationFolder),
            tempRoot);
}
```

```csharp
// IYouTubeService.cs
Task<JobResult> StartDownloadAsync(
    string jobId,
    string url,
    int height,
    string? destinationFolder,
    Func<JobProgress, Task> onProgress,
    CancellationToken cancellationToken);
```

Em `YouTubeService`, substituir o `IDownloadPaths` compartilhado por
`IDownloadPathsFactory` e criar `var paths = pathsFactory.Create(destinationFolder);`
dentro de `StartDownloadAsync`, antes de reservar o nome.

- [ ] **Step 4: Ampliar o payload startDownload**

```csharp
private sealed record StartDownloadPayload(
    string Url,
    int Height,
    string? DestinationFolder);
```

O servidor deve aceitar exatamente `url`, `height`, `destinationFolder`; o último pode
ser `null` ou caminho absoluto validado por `DownloadPaths.NormalizeDestination`.
Passar o valor ao serviço. Atualizar todos os fakes para registrar o destino recebido.

- [ ] **Step 5: Executar testes nativos**

Run: `npm run test:native`

Expected: `Native host tests passed`, incluindo destino selecionado, fallback nulo e
rejeição de caminho relativo.

- [ ] **Step 6: Commit**

```powershell
git add native-host/VideoRadar.NativeHost native-host/VideoRadar.NativeHost.Tests
git commit -m "feat: use per-job youtube destinations"
```

## Task 6: Aplicar a preferência ao YouTube na extensão

**Files:**
- Modify: `src/background/youtube-coordinator.js`
- Modify: `test/youtube-coordinator.test.js`

- [ ] **Step 1: Escrever testes dos dois modos e cancelamento**

```js
test('youtube pergunta a pasta antes de iniciar', async () => {
  const native = fakeNativeClient([
    { type: 'folderSelected', path: String.raw`D:\Aulas` },
    { type: 'jobStarted', jobId: 'j1', job: snapshot },
  ]);
  const coordinator = createYouTubeCoordinator({
    nativeClient: native,
    storageLocal: storageWithPreferences({ askEveryTime: true, defaultFolder: null }),
  });

  await coordinator.handleStart(youtubeUrl, 720);

  assert.deepEqual(native.requests.map(({ type, payload }) => ({ type, payload })), [
    { type: HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER, payload: {} },
    {
      type: HOST_COMMANDS.START_DOWNLOAD,
      payload: { url: youtubeUrl, height: 720, destinationFolder: String.raw`D:\Aulas` },
    },
  ]);
});

test('youtube automático usa a pasta padrão', async () => {
  const native = fakeNativeClient([{ type: 'jobStarted', jobId: 'j1', job: snapshot }]);
  const coordinator = createYouTubeCoordinator({
    nativeClient: native,
    storageLocal: storageWithPreferences({
      askEveryTime: false, defaultFolder: String.raw`E:\Vídeos`,
    }),
  });
  await coordinator.handleStart(youtubeUrl, 720);
  assert.equal(native.requests[0].payload.destinationFolder, String.raw`E:\Vídeos`);
});

test('cancelar seletor não inicia youtube', async () => {
  const native = fakeNativeClient([{ type: 'folderSelectionCancelled' }]);
  const coordinator = createYouTubeCoordinator({
    nativeClient: native,
    storageLocal: storageWithPreferences({ askEveryTime: true, defaultFolder: null }),
  });
  assert.deepEqual(await coordinator.handleStart(youtubeUrl, 720), {
    cancelled: true, code: 'DOWNLOAD_CANCELLED',
  });
  assert.equal(native.requests.length, 1);
});
```

- [ ] **Step 2: Executar o teste e confirmar RED**

Run: `node --test test/youtube-coordinator.test.js`

Expected: FAIL porque `handleStart` ainda envia somente URL e altura.

- [ ] **Step 3: Implementar a resolução do destino**

```js
async function resolveYouTubeDestination(nativeClient, storageLocal) {
  const preferences = await readDownloadPreferences(storageLocal);
  if (!preferences.askEveryTime) return {
    cancelled: false,
    destinationFolder: preferences.defaultFolder,
  };
  const result = await nativeClient.request(HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER, {});
  if (result.type === HOST_EVENTS.FOLDER_SELECTION_CANCELLED) {
    return { cancelled: true, destinationFolder: null };
  }
  return { cancelled: false, destinationFolder: result.path };
}
```

`handleStart` deve chamar esse helper antes de criar estado “preparando”. Se cancelado,
retornar `{ cancelled: true, code: 'DOWNLOAD_CANCELLED' }`. Caso contrário:

```js
return nativeClient.request(HOST_COMMANDS.START_DOWNLOAD, {
  url,
  height,
  destinationFolder,
});
```

- [ ] **Step 4: Executar o teste focado**

Run: `node --test test/youtube-coordinator.test.js`

Expected: todos os testes PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/background/youtube-coordinator.js test/youtube-coordinator.test.js
git commit -m "feat: apply destination preference to youtube"
```

## Task 7: Persistir e retomar a entrega de diretos e HLS

**Files:**
- Create: `src/background/download-relocation.js`
- Create: `test/download-relocation.test.js`
- Modify: `src/background/handlers.js`
- Modify: `src/background/main.js`
- Modify: `test/background-handlers.test.js`

- [ ] **Step 1: Escrever testes do coordenador de realocação**

```js
// test/download-relocation.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDownloadRelocationCoordinator } from
  '../src/background/download-relocation.js';

test('persiste por downloadId, move ao concluir e guarda caminho final', async () => {
  const storage = fakeStorageLocal();
  const downloads = fakeDownloads([{
    id: 42,
    state: 'complete',
    filename: String.raw`C:\Downloads\Video Radar\.staging\op_1\aula.ts`,
  }]);
  const native = fakeNativeClient([{
    type: 'fileMoved', downloadId: 42, finalPath: String.raw`D:\Vídeos\aula.ts`,
  }]);
  const coordinator = createDownloadRelocationCoordinator({
    storageLocal: storage, downloads, nativeClient: native,
  });

  await coordinator.track({
    downloadId: 42, operationId: 'op_1',
    destinationFolder: String.raw`D:\Vídeos`, mediaKind: 'hls',
  });
  await coordinator.handleChanged({ id: 42, state: { current: 'complete' } });

  assert.equal((await coordinator.get(42)).status, 'complete');
  assert.equal((await coordinator.get(42)).finalPath, String.raw`D:\Vídeos\aula.ts`);
});

test('retoma download completo após reinício do service worker', async () => {
  const storage = fakeStorageLocalWithRelocation({
    downloadId: 42, operationId: 'op_1', destinationFolder: String.raw`D:\Vídeos`,
    status: 'downloading', mediaKind: 'direct',
  });
  const coordinator = createDownloadRelocationCoordinator({
    storageLocal: storage,
    downloads: fakeDownloads([{ id: 42, state: 'complete',
      filename: String.raw`C:\Downloads\Video Radar\.staging\op_1\aula.mp4` }]),
    nativeClient: fakeNativeClient([{
      type: 'fileMoved', downloadId: 42, finalPath: String.raw`D:\Vídeos\aula.mp4`,
    }]),
  });
  await coordinator.reconcile();
  assert.equal((await coordinator.get(42)).status, 'complete');
});

test('falha mantém caminho recuperável e permite nova tentativa', async () => {
  const coordinator = createFailingRelocationCoordinator();
  await coordinator.handleChanged({ id: 42, state: { current: 'complete' } });
  const record = await coordinator.get(42);
  assert.equal(record.status, 'moveFailed');
  assert.match(record.stagingPath, /Video Radar.+\.staging.+aula\.ts/);
  assert.equal(record.errorCode, 'DESTINATION_MOVE_FAILED');
});
```

- [ ] **Step 2: Executar o teste e confirmar RED**

Run: `node --test test/download-relocation.test.js`

Expected: FAIL porque o módulo não existe.

- [ ] **Step 3: Criar o coordenador persistente**

```js
// src/background/download-relocation.js
export const RELOCATION_PREFIX = 'downloadRelocation:';
export const DELIVERY_RESULT_PREFIX = 'downloadDeliveryResult:';

export function createDownloadRelocationCoordinator({
  storageLocal, downloads, nativeClient, now = Date.now,
}) {
  const inFlight = new Map();
  const key = (id) => `${RELOCATION_PREFIX}${id}`;
  const resultKey = (id) => `${DELIVERY_RESULT_PREFIX}${id}`;

  async function get(downloadId) {
    const result = await storageLocal.get(key(downloadId));
    if (result[key(downloadId)]) return result[key(downloadId)];
    const completed = await storageLocal.get(resultKey(downloadId));
    return completed[resultKey(downloadId)] ?? null;
  }

  async function put(record) {
    await storageLocal.set({ [key(record.downloadId)]: record });
    return record;
  }

  async function track(record) {
    return put({
      ...record, status: 'downloading', stagingPath: null,
      finalPath: null, errorCode: null, updatedAt: now(),
    });
  }

  async function deliverOnce(downloadId) {
    const record = await get(downloadId);
    if (!record || record.status === 'complete' || record.status === 'moving') return;
    const [item] = await downloads.search({ id: downloadId });
    if (!item || item.state !== 'complete' || !item.filename) return;
    await put({ ...record, status: 'moving', stagingPath: item.filename, updatedAt: now() });
    try {
      const moved = await nativeClient.request(HOST_COMMANDS.MOVE_DOWNLOADED_FILE, {
        downloadId,
        sourcePath: item.filename,
        destinationFolder: record.destinationFolder,
      });
      await storageLocal.set({
        [resultKey(downloadId)]: {
          ...record, status: 'complete', stagingPath: item.filename,
          finalPath: moved.finalPath, errorCode: null, updatedAt: now(),
        },
      });
      await storageLocal.remove(key(downloadId));
      await pruneResults();
    } catch {
      await put({
        ...record, status: 'moveFailed', stagingPath: item.filename,
        finalPath: null, errorCode: 'DESTINATION_MOVE_FAILED', updatedAt: now(),
      });
    }
  }

  function deliver(downloadId) {
    if (inFlight.has(downloadId)) return inFlight.get(downloadId);
    const work = deliverOnce(downloadId).finally(() => {
      if (inFlight.get(downloadId) === work) inFlight.delete(downloadId);
    });
    inFlight.set(downloadId, work);
    return work;
  }

  async function pruneResults() {
    const all = await storageLocal.get(null);
    const results = Object.entries(all)
      .filter(([name]) => name.startsWith(DELIVERY_RESULT_PREFIX))
      .sort(([, left], [, right]) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    const expired = results.slice(50).map(([name]) => name);
    if (expired.length > 0) await storageLocal.remove(expired);
  }

  async function handleChanged(delta) {
    if (delta?.state?.current === 'complete') await deliver(delta.id);
  }

  async function reconcile() {
    const all = await storageLocal.get(null);
    for (const [name, record] of Object.entries(all)) {
      if (name.startsWith(RELOCATION_PREFIX)
          && ['downloading', 'moving', 'moveFailed'].includes(record.status)) {
        await deliver(record.downloadId);
      }
    }
  }

  return { get, track, deliver, handleChanged, reconcile };
}
```

Serializar `deliver` por `downloadId` com uma `Map` de promises para impedir duas
movimentações quando `onChanged` e `reconcile()` observarem a mesma conclusão.
O registro ativo `downloadRelocation:<id>` é removido somente depois de gravar
`downloadDeliveryResult:<id>`. O resultado final é o histórico usado pelo popup e deve
conter também `operationId`, `mediaKind`, `mediaUrl` e `displayName`; ao criar um
resultado novo, `pruneResults()` conserva no máximo os 50 mais recentes.

- [ ] **Step 4: Integrar aos handlers**

No download direto e no handoff HLS:

```js
const operationId = crypto.randomUUID().replaceAll('-', '');
const preferences = await readDownloadPreferences(storageLocal);
const target = browserDownloadTarget(filename, preferences, operationId);
if (target.staging) {
  const ready = await nativeClient.request(HOST_COMMANDS.PING, {});
  if (!ready.defaultFolder && !preferences.defaultFolder) {
    const error = new Error('Escolha uma pasta padrão para continuar.');
    error.code = 'DESTINATION_NOT_CONFIGURED';
    throw error;
  }
  destinationFolder = preferences.defaultFolder ?? ready.defaultFolder;
}
const downloadId = await downloads.download({
  url: objectUrlOrDirectUrl,
  filename: target.filename,
  saveAs: target.saveAs,
});
if (target.staging) {
  await relocation.track({
    downloadId,
    operationId,
    destinationFolder,
    mediaKind,
    mediaUrl: directUrlOrPlaylistUrl,
    displayName: filename,
  });
  await relocation.deliver(downloadId);
}
```

`relocation.deliver(downloadId)` logo após `track` fecha a corrida em que o navegador
termina antes de registrar `downloads.onChanged`. Em modo perguntar, não criar registro
de realocação.

- [ ] **Step 5: Compartilhar cliente e eventos no service worker**

```js
// src/background/main.js
const relocation = createDownloadRelocationCoordinator({
  storageLocal: chrome.storage.local,
  downloads: chrome.downloads,
  nativeClient,
});

chrome.downloads.onChanged.addListener((delta) => {
  void handlers.handleDownloadChanged(delta);
  void relocation.handleChanged(delta);
});

void relocation.reconcile();
```

Passar `nativeClient` e `relocation` para `createBackgroundHandlers`. Não criar segunda
porta nativa.

- [ ] **Step 6: Executar testes de background**

Run: `node --test test/download-relocation.test.js test/background-handlers.test.js`

Expected: todos os testes PASS, inclusive pergunta com `saveAs: true`, automático com
staging, ping antes do download e ausência de duplicação visual.

- [ ] **Step 7: Commit**

```powershell
git add src/background/download-relocation.js src/background/handlers.js src/background/main.js test/download-relocation.test.js test/background-handlers.test.js
git commit -m "feat: persist direct and hls delivery"
```

## Task 8: Substituir a configuração antiga pela experiência unificada

**Files:**
- Modify: `options.html`
- Modify: `src/options/main.js`
- Modify: `styles/options.css`
- Create: `test/options.test.js`

- [ ] **Step 1: Escrever testes da página de opções**

```js
// test/options.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOptionsController } from '../src/options/main.js';

test('mostra pasta atual e persiste o checkbox', async () => {
  const view = fakeOptionsView();
  const storage = fakeStorageWithPreferences({
    schemaVersion: 2, askEveryTime: true, defaultFolder: String.raw`D:\Vídeos`,
  });
  const controller = createOptionsController({
    view, storageLocal: storage, nativeClient: fakeNativeClient([{
      type: 'ready', protocolVersion: 2, nativeName: 'com.videoradar.helper',
      defaultFolder: String.raw`C:\Users\Carlos\Downloads\Video Radar`,
    }]),
  });
  await controller.load();
  assert.equal(view.folderText, String.raw`D:\Vídeos`);
  assert.equal(view.askEveryTime, true);
  await controller.setAskEveryTime(false);
  assert.equal(storage.preferences.askEveryTime, false);
});

test('altera pasta somente quando o seletor confirma', async () => {
  const view = fakeOptionsView();
  const storage = fakeStorageWithPreferences({
    schemaVersion: 2, askEveryTime: false, defaultFolder: null,
  });
  const controller = createOptionsController({
    view, storageLocal: storage,
    nativeClient: fakeNativeClient([
      { type: 'folderSelectionCancelled' },
      { type: 'folderSelected', path: String.raw`E:\Cursos` },
    ]),
  });
  await controller.chooseFolder();
  assert.equal(storage.preferences.defaultFolder, null);
  await controller.chooseFolder();
  assert.equal(storage.preferences.defaultFolder, String.raw`E:\Cursos`);
});
```

- [ ] **Step 2: Executar o teste e confirmar RED**

Run: `node --test test/options.test.js`

Expected: FAIL porque o controller unificado não existe.

- [ ] **Step 3: Atualizar o HTML**

```html
<main class="options-shell">
  <section class="settings-card" aria-labelledby="destination-title">
    <p class="eyebrow">DESTINO DOS DOWNLOADS</p>
    <h1 id="destination-title">Onde salvar os vídeos</h1>
    <div class="folder-row">
      <div>
        <span class="field-label">Pasta padrão</span>
        <output id="default-folder">Downloads\Video Radar</output>
      </div>
      <button id="choose-folder" type="button">Alterar pasta padrão…</button>
    </div>
    <label class="switch-row">
      <input id="ask-every-time" type="checkbox">
      <span>
        <strong>Perguntar onde salvar cada download</strong>
        <small>O navegador ou o Windows solicitará o destino antes de começar.</small>
      </span>
    </label>
    <p id="save-status" role="status" aria-live="polite"></p>
  </section>
</main>
```

- [ ] **Step 4: Implementar o controller injetável**

```js
export function createOptionsController({ view, storageLocal, nativeClient }) {
  let fallbackFolder = null;
  async function load() {
    const preferences = await readDownloadPreferences(storageLocal);
    const ready = await nativeClient.request(HOST_COMMANDS.PING, {});
    fallbackFolder = ready.defaultFolder;
    view.render({
      ...preferences,
      effectiveFolder: preferences.defaultFolder ?? fallbackFolder,
    });
  }
  async function persist(patch) {
    const current = await readDownloadPreferences(storageLocal);
    const next = validateDownloadPreferences({ ...current, ...patch });
    await storageLocal.set({ [DOWNLOAD_PREFERENCES_KEY]: next });
    view.render({
      ...next,
      effectiveFolder: next.defaultFolder ?? fallbackFolder,
    });
    view.status('Configuração salva.');
  }
  async function setAskEveryTime(value) {
    await persist({ askEveryTime: value });
  }
  async function chooseFolder() {
    const result = await nativeClient.request(
      HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER, {});
    if (result.type === HOST_EVENTS.FOLDER_SELECTION_CANCELLED) {
      view.status('Seleção cancelada.');
      return;
    }
    await persist({ defaultFolder: result.path });
  }
  return { load, setAskEveryTime, chooseFolder };
}
```

No `bootOptions`, criar um `createNativePortClient({ connectNative:
chrome.runtime.connectNative, onEvent() {} })`, ligar os dois controles e renderizar o
caminho absoluto `effectiveFolder` informado pelo ping quando `defaultFolder` for
`null`. Não aceitar texto manual de caminho. Se o ping falhar, renderizar
“Auxiliar indisponível” e manter habilitado o checkbox; o botão de alteração mostra o
erro seguro de reinstalação já usado no popup.

- [ ] **Step 5: Ajustar CSS responsivo**

```css
.settings-card { width: min(720px, calc(100vw - 32px)); }
.folder-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 20px; }
#default-folder { display: block; overflow-wrap: anywhere; }
.switch-row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; }
@media (max-width: 560px) {
  .folder-row { grid-template-columns: 1fr; }
  #choose-folder { width: 100%; }
}
```

Preservar cores, tipografia, raios e foco visível já definidos em `styles/options.css`.

- [ ] **Step 6: Executar testes de opções**

Run: `node --test test/options.test.js`

Expected: todos os testes PASS.

- [ ] **Step 7: Commit**

```powershell
git add options.html src/options/main.js styles/options.css test/options.test.js
git commit -m "feat: add unified download destination settings"
```

## Task 9: Restaurar o estado final e recuperável no popup

**Files:**
- Modify: `src/popup/state.js`
- Modify: `src/popup/render.js`
- Modify: `src/popup/main.js`
- Modify: `test/popup-state.test.js`
- Modify: `test/popup-render.test.js`
- Modify: `test/popup-main.test.js`

- [ ] **Step 1: Escrever testes de apresentação**

```js
test('mostra o caminho final da realocação sem duplicar o vídeo', () => {
  const state = reducePopupState(initialState(), {
    type: 'DOWNLOAD_RELOCATION_UPDATED',
    record: {
      downloadId: 42, operationId: 'op_1', status: 'complete',
      finalPath: String.raw`D:\Vídeos\aula.ts`, mediaKind: 'hls',
    },
  });
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].finalPath, String.raw`D:\Vídeos\aula.ts`);
  assert.equal(state.items[0].statusText, 'Salvo em D:\\Vídeos\\aula.ts');
});

test('mostra o caminho de preparação quando a entrega falha', () => {
  const state = reducePopupState(initialState(), {
    type: 'DOWNLOAD_RELOCATION_UPDATED',
    record: {
      downloadId: 42, operationId: 'op_1', status: 'moveFailed',
      stagingPath: String.raw`C:\Downloads\Video Radar\.staging\op_1\aula.ts`,
      errorCode: 'DESTINATION_MOVE_FAILED', mediaKind: 'hls',
    },
  });
  assert.match(state.items[0].statusText, /arquivo preservado/i);
  assert.equal(state.items[0].action, 'open-download-settings');
});

test('cancelar seletor do youtube volta ao estado pronto', () => {
  const state = reducePopupState(preparingYouTubeState(), {
    type: 'YOUTUBE_START_CANCELLED',
  });
  assert.equal(state.busy, false);
  assert.equal(state.notice, 'Download cancelado.');
});
```

- [ ] **Step 2: Executar os testes e confirmar RED**

Run: `node --test test/popup-state.test.js test/popup-render.test.js test/popup-main.test.js`

Expected: FAIL porque os eventos novos não são tratados.

- [ ] **Step 3: Restaurar e observar realocações**

No boot do popup, consultar `chrome.storage.local.get(null)`, selecionar chaves com
prefixo `downloadRelocation:` ou `downloadDeliveryResult:` e despachar uma atualização
por registro. Registrar:

```js
chrome.storage.local.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, change] of Object.entries(changes)) {
    if ((key.startsWith(RELOCATION_PREFIX)
        || key.startsWith(DELIVERY_RESULT_PREFIX)) && change.newValue) {
      dispatch({
        type: 'DOWNLOAD_RELOCATION_UPDATED',
        record: change.newValue,
      });
    }
  }
});
```

O reducer deve reconciliar por `downloadId` e, quando disponível, por `operationId`.
Nunca anexar um segundo card para o mesmo identificador.

- [ ] **Step 4: Renderizar estados e ações**

```js
const RELOCATION_TEXT = {
  downloading: 'Baixando…',
  moving: 'Movendo para a pasta escolhida…',
  complete: (record) => `Salvo em ${record.finalPath}`,
  moveFailed: (record) =>
    `Não foi possível mover. Arquivo preservado em ${record.stagingPath}`,
};
```

Erros `DESTINATION_INVALID`, `DESTINATION_NOT_CONFIGURED`,
`DESTINATION_MOVE_FAILED` e auxiliar indisponível devem oferecer o botão
“Configurar downloads”, que chama `chrome.runtime.openOptionsPage()`. O retorno
`{ cancelled: true }` do início YouTube deve despachar `YOUTUBE_START_CANCELLED`, sem
banner de erro.

- [ ] **Step 5: Executar testes do popup**

Run: `node --test test/popup-state.test.js test/popup-render.test.js test/popup-main.test.js`

Expected: todos os testes PASS e nenhum card duplicado.

- [ ] **Step 6: Commit**

```powershell
git add src/popup test/popup-state.test.js test/popup-render.test.js test/popup-main.test.js
git commit -m "feat: show durable download delivery status"
```

## Task 10: Atualizar documentação, validar pacote e fazer QA enxuto

**Files:**
- Modify: `README.md`
- Modify: `scripts/validate-extension.mjs`
- Modify: testes de preflight apenas se uma asserção nova for necessária.

- [ ] **Step 1: Atualizar a documentação do comportamento**

Adicionar ao `README.md`:

```markdown
### Destino dos downloads

Abra **Configurar downloads** no popup para escolher uma pasta padrão do Windows.
Com **Perguntar onde salvar cada download** ativado, o navegador pergunta o destino
para vídeos diretos/HLS e o Windows pergunta a pasta para YouTube. Desativando a opção,
todos os formatos usam automaticamente a pasta padrão.

Diretos e HLS automáticos passam temporariamente por
`Downloads\Video Radar\.staging`. Se a movimentação falhar, o popup mostra o caminho
preservado para recuperação. O auxiliar nativo é necessário para escolher a pasta,
baixar YouTube e entregar arquivos automáticos fora da pasta Downloads do navegador.
```

- [ ] **Step 2: Atualizar o preflight**

O preflight deve confirmar:

```js
assert.equal(manifest.permissions.includes('nativeMessaging'), true);
assert.equal(manifest.permissions.includes('downloads'), true);
assert.equal(manifest.options_ui?.page, 'options.html');
assert.equal(MIN_NATIVE_PROTOCOL_VERSION, 2);
```

Importar `MIN_NATIVE_PROTOCOL_VERSION` de `src/youtube/protocol.js`. Não analisar C#
como texto para descobrir a versão.

- [ ] **Step 3: Executar toda a suíte**

Run: `npm run check:all`

Expected: preflight aprovado, todos os testes JavaScript PASS, mensagem
`Native host tests passed` e código `0`.

- [ ] **Step 4: Gerar o pacote atualizado do auxiliar**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-native-helper.ps1`

Expected: pacote criado em `dist/video-radar-helper`, contendo host, ferramentas,
manifestos de Chrome, Edge, Brave e Vivaldi, instalador PowerShell e
`Instalar-Video-Radar.cmd`.

- [ ] **Step 5: Fazer verificação visual curta**

Carregar a extensão descompactada no navegador e verificar `options.html` em:

- desktop com viewport de aproximadamente `1024 × 768`;
- largura estreita de aproximadamente `390 × 844`.

Expected: caminho quebra linha sem estourar o card, botão ocupa largura total no modo
estreito, checkbox e foco de teclado permanecem visíveis.

- [ ] **Step 6: Executar os seis cenários manuais**

1. Direto + perguntar: navegador abre Salvar como e baixa uma vez.
2. HLS + perguntar: navegador abre Salvar como após montar o `.ts`.
3. YouTube + perguntar: Windows abre seletor; cancelar não inicia.
4. Direto + automático: staging é movido e popup mostra caminho final.
5. HLS + automático: progresso sobrevive ao fechamento; entrega não duplica o card.
6. YouTube + automático: arquivo nasce diretamente na pasta padrão.

Expected: um único download por clique, estado recuperado ao reabrir o popup e nenhuma
remoção do staging quando a entrega falha.

- [ ] **Step 7: Commit**

```powershell
git add README.md scripts/validate-extension.mjs
git commit -m "docs: explain unified download destinations"
```

## Critérios finais de aceite

- Novas instalações começam com “Perguntar onde salvar cada download” ativado.
- A antiga preferência `automatic` é migrada sem tentar transformar subpasta em caminho absoluto.
- O seletor do Windows é a única forma de definir a pasta padrão.
- Direto/HLS usam `saveAs` no modo perguntar e staging + entrega no modo automático.
- YouTube escolhe a pasta por trabalho no modo perguntar e usa o padrão no automático.
- Fechar popup, suspender service worker ou reiniciar navegador não perde a entrega por `downloadId`.
- Conflitos nunca sobrescrevem arquivos.
- Falhas preservam o arquivo preparado e exibem seu caminho.
- O popup não duplica visualmente um único download.
- Chrome, Edge, Brave e Vivaldi permanecem cobertos pelo pacote do auxiliar.
