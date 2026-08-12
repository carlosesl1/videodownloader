# Publicação do Video Radar

Este documento é para mantenedores. A versão 1.2.0 é distribuída como **Desktop
Edition** para Windows; não há uma listagem oficial em loja neste momento.

## Desktop Edition e Store Edition

| Edição | Estado | Distribuição | Escopo |
| --- | --- | --- | --- |
| Desktop Edition | Atual, versão 1.2.0 | GitHub Release + instaladores Windows x64/ARM64 | Extensão completa, auxiliar Native Messaging e downloads sociais públicos autorizados |
| Store Edition | Futura, não publicada | Chrome Web Store/Edge Add-ons após revisão | Pacote e ID separados; sem download do YouTube e somente recursos aceitos pela loja |

Não envie o pacote Desktop atual diretamente à Chrome Web Store. A política da
loja rejeita produtos que facilitem o download de vídeos do YouTube; uma Store
Edition precisa excluir esse fluxo, revisar permissões e passar pelas declarações
de privacidade e uso de dados. Consulte a
[orientação oficial da Chrome Web Store](https://developer.chrome.com/docs/webstore/troubleshooting)
e os [Termos do YouTube](https://www.youtube.com/static?gl=BR&hl=pt&template=terms).

O ID da loja será administrado pela própria loja. Se uma Store Edition vier a
usar Native Messaging, seu novo origin também precisará ser incluído no
manifesto do host e entregue por um instalador atualizado. Nada disso existe na
release 1.2.0.

## Pré-requisitos

- Windows 11 x64/ARM64 ou Windows 10 Enterprise/IoT LTSC x64 em uma versão ainda
  suportada pelo .NET 10;
- Node.js 22;
- acesso de rede aos releases oficiais fixados em `native-host/tool-lock.json`
  e `installer/inno-tool-lock.json`;
- o SDK .NET 10.0.400 é reutilizado da máquina quando coincidir exatamente com
  `global.json`; caso contrário, o wrapper baixa o ZIP oficial x64 ou ARM64
  correspondente à máquina, valida SHA-512 e instala uma cópia local em `.tools`.

O bootstrap do Inno Setup valida URL imutável, tamanho, SHA-256 e assinatura
Authenticode antes de criar uma instalação portátil em `.tools`. Essa assinatura
é do compilador Inno Setup, não do instalador Video Radar produzido por ele.
Mesmo quando um mantenedor fornece `-IsccPath` manualmente, o build exige a mesma
assinatura do publisher fixado e a versão exata antes de executar o compilador.
O FFmpeg está fixado em um autobuild mensal versionado — preservado pela política
de retenção do upstream — e nunca no alias descartável `latest`; atualizar esse
snapshot exige regenerar e revisar `native-host/tool-lock.json`.

## Verificação e build local

Na raiz do repositório:

```powershell
npm run check:all
npm run check:release
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-release.ps1
npm run verify:release
Get-Content dist\release\SHA256SUMS.txt
```

O diretório `dist\release` deve conter exatamente:

- `VideoRadar-Setup-1.2.0-Windows-x64.exe`;
- `VideoRadar-Setup-1.2.0-Windows-arm64.exe`;
- `VideoRadar-1.2.0-Developer-Windows-x64.zip`;
- `VideoRadar-1.2.0-Developer-Windows-arm64.zip`;
- `SBOM.spdx.json`;
- `SHA256SUMS.txt`.

`SHA256SUMS.txt` cobre os cinco payloads anteriores a ele. O verificador falha
com arquivo ausente, inesperado, vazio, hash divergente ou SBOM inconsistente.
O instalador é a entrega principal; o ZIP existe para auditoria e instalação
manual por desenvolvedores. O SBOM é um inventário SPDX de componentes de
primeira ordem, família do runtime .NET e inputs nativos imutáveis; ele não se
apresenta como inventário arquivo a arquivo do executável self-contained.

## Provenance e SBOM no GitHub

O workflow `Release` usa jobs com permissões separadas: build somente lê o
repositório, attestation recebe `id-token: write`, `attestations: write` e
`artifact-metadata: write`, e somente o job final de publicação recebe
`contents: write`. Todos os usos de actions estão fixados por SHA imutável e
monitorados pelo Dependabot.

O build principal reúne os dois RIDs em Windows x64. Como um executável ARM64
não pode ser iniciado nesse runner, a opção de build cruzado apenas adia o ping
do pacote ARM64. Depois do upload, dois jobs independentes em `windows-latest`
e `windows-11-arm` dependem do build e baixam o mesmo artifact pelo `artifact-id`
exato devolvido pelo upload; nenhum deles recompõe um segundo pacote. O script
parametrizado confere o contrato e os checksums, extrai os ZIPs x64 e ARM64 com
limites, executa com timeout `video-radar-host.exe --ping`, `deno --version`,
`ffmpeg -version`, `ffprobe -version` e `yt-dlp --version`, e instala cada Setup
exato silenciosamente em sua arquitetura nativa. Os gates comparam host e
ferramentas instalados com o ZIP correspondente, validam `build-info.json`,
manifesto e os quatro registros HKCU, repetem os comandos nativos e desinstalam
em `finally`.

Os downloads dos assets públicos e imutáveis de Deno, FFmpeg/ffprobe e yt-dlp
não recebem `GITHUB_TOKEN`; somente o passo que publica a Release recebe o token
do job. As releases fixadas oferecem binários ARM64 oficiais e o lock
proíbe fallback x64 silencioso.

O invólucro do instalador ARM64 é a exceção explícita: o Inno Setup 7 oferece
`SetupArchitecture` x86/x64, mas não um loader ARM64. Ele gera um Setup x64 que
o Windows 11 ARM executa por emulação e que é guardado por
`ArchitecturesAllowed=arm64`. O payload instalado permanece integralmente ARM64
nativo e é o que o job `windows-11-arm` executa.

### Upgrade transacional do instalador

Os Setups x64 e ARM64 usam o mesmo fluxo de upgrade. Um named mutex impede que
o Inno Setup e o instalador manual do ZIP troquem o runtime ao mesmo tempo. O
Restart Manager fecha processos que estejam usando os arquivos gerenciados e
eles não são reiniciados automaticamente durante a atualização.

Na etapa oficial `PrepareToInstall`, antes de qualquer mutação, o Setup extrai
do próprio instalador o host e as quatro ferramentas, exige que
`video-radar-host.exe --ping` termine com código zero e prepara o manifesto em
`{tmp}`. Ele também copia somente `Extension`, `host`, `licenses`, `legal`,
`onboarding`, `native-host` e `build-info.json` para o backup irmão
`{app}.runtime-backup`, no mesmo volume. Se a validação ou a cópia falhar,
`PrepareToInstall` devolve um erro e o Setup termina com código não zero sem
iniciar a instalação.

A raiz `{app}` nunca é copiada nem movida: `download-queue`, `temp`,
`start-journal`, `move-journal`, `diagnostics`, o desinstalador e qualquer mídia
externa permanecem no lugar. O manifesto temporário é instalado por uma entrada
`[Files]`, de modo que sua gravação no destino participa do rollback normal.
Se houver uma falha depois que o payload começar, o Inno desfaz as alterações e
`DeinitializeSetup` repõe a cópia exata dos componentes anteriores. O backup só
é apagado depois que a instalação termina; se a restauração não puder ser
concluída, ele é mantido para recuperação e uma nova execução falha sem
sobrescrevê-lo. Isso segue os contratos oficiais de
[PrepareToInstall](https://jrsoftware.org/ishelp/topic_scriptevents.htm) e da
[ordem de instalação do Inno Setup](https://jrsoftware.org/ishelp/topic_installorder.htm).

Fontes oficiais da matriz ARM64: [Deno v2.9.3](https://github.com/denoland/deno/releases/tag/v2.9.3),
[yt-dlp 2026.07.04](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.04),
[FFmpeg-Builds mensal](https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/autobuild-2026-07-31-16-16),
[runner Windows ARM64](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
e [SetupArchitecture/loader do Inno Setup](https://jrsoftware.org/ishelp/topic_setup_setuparchitecture.htm),
além dos [identificadores de arquitetura](https://jrsoftware.org/ishelp/topic_archidentifiers.htm).

Depois do download interno dos artefatos, o workflow executa novamente
`npm run verify:release`, cria attestation de provenance para os payloads e uma
attestation SPDX para os dois instaladores e os dois ZIPs. A publicação cria ou
reutiliza uma Release em draft, reenvia os seis assets com substituição idempotente e compara
nome, tamanho, estado e SHA-256 retornados pela API com os arquivos locais. Somente
o draft com o conjunto exato é promovido a Release pública. Os jobs seguintes
baixam pelo ID imutável retornado no upload, inclusive em reexecuções parciais do
workflow, sem depender de um nome calculado a partir da tentativa. Verificação externa:

```powershell
gh attestation verify `
  dist\release\VideoRadar-Setup-1.2.0-Windows-x64.exe `
  --repo carlosesl1/videodownloader

gh attestation verify `
  dist\release\VideoRadar-Setup-1.2.0-Windows-arm64.exe `
  --repo carlosesl1/videodownloader `
  --predicate-type https://spdx.dev/Document/v2.3
```

A attestation comprova origem e integridade do build do GitHub. Ela **não é**
uma assinatura Authenticode e não remove avisos do SmartScreen. Em planos Free,
Pro ou Team, artifact attestations exigem repositório público; repositório
privado exige GitHub Enterprise Cloud. O workflow não usa segredo personalizado
para attestations: a identidade é obtida por OIDC no próprio job.

## Smoke test antes da tag

1. Execute `npm run verify:release` e confira os hashes também com
   `Get-FileHash -Algorithm SHA256`.
2. Execute o instalador em uma conta comum e confirme que ele não pede elevação.
3. Confirme a entrada **Video Radar** em Aplicativos instalados.
4. Confira que a pasta `%LOCALAPPDATA%\VideoRadar\Extension` abre ao final.
5. Carregue essa pasta como extensão sem compactação e confirme o ID
   `cakpfifpfmbdcilimpedanglnopnmckg`.
6. Confirme que o navegador mostra a extensão como indisponível em janelas
   anônimas e que os ícones permanecem legíveis na barra e em `chrome://extensions`.
7. No Chrome, Edge, Brave ou Vivaldi, execute uma busca autorizada e confirme
   que o auxiliar responde.
8. Instale a mesma versão novamente e confirme o upgrade no mesmo caminho.
   Mantenha um download pausado com `.part` e confirme que fila, parcial e
   diagnóstico continuam presentes depois do upgrade.
9. Desinstale pelo Windows, confirme a remoção das quatro chaves
   `NativeMessagingHosts\com.videoradar.helper` e remova manualmente a extensão.
10. Confirme que vídeos concluídos fora da pasta do aplicativo foram preservados.

## Assinatura opcional do Windows

Os instaladores 1.2.0 produzidos pelo repositório **não estão assinados**. Por isso, o
Windows SmartScreen pode exibir um aviso de editor desconhecido. Isso é
diferente da assinatura válida do compilador Inno Setup usado durante o build.

Para assinar, o mantenedor precisa de um certificado Authenticode e de acesso a
uma chave privada, HSM ou serviço de assinatura. O projeto pode solicitar o
programa open source do **SignPath Foundation**, mas a aceitação depende dos
critérios e da análise do provedor; este repositório não presume aprovação.

Exemplo somente depois de configurar externamente a ferramenta e o timestamp:

```powershell
& $env:VIDEO_RADAR_SIGNTOOL sign `
  /fd SHA256 `
  /tr $env:VIDEO_RADAR_TIMESTAMP_URL `
  /td SHA256 `
  dist\release\VideoRadar-Setup-1.2.0-Windows-x64.exe

$signature = Get-AuthenticodeSignature `
  -LiteralPath dist\release\VideoRadar-Setup-1.2.0-Windows-x64.exe
if ($signature.Status -ne 'Valid') {
  throw "Assinatura inválida: $($signature.Status)"
}
```

Repita a assinatura e a verificação para o instalador `Windows-arm64` antes de
regenerar os checksums; a release não pode misturar um instalador assinado e outro não.

Como a assinatura altera o executável, regenere `SHA256SUMS.txt`:

```powershell
$releaseRoot = Resolve-Path dist\release
$payloads = @(
  'SBOM.spdx.json',
  'VideoRadar-1.2.0-Developer-Windows-x64.zip',
  'VideoRadar-1.2.0-Developer-Windows-arm64.zip',
  'VideoRadar-Setup-1.2.0-Windows-x64.exe',
  'VideoRadar-Setup-1.2.0-Windows-arm64.exe'
) | Sort-Object
$lines = foreach ($name in $payloads) {
  $path = Join-Path $releaseRoot $name
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $name"
}
[IO.File]::WriteAllLines(
  (Join-Path $releaseRoot 'SHA256SUMS.txt'),
  $lines,
  [Text.UTF8Encoding]::new($false)
)
npm run verify:release
```

Em CI, a assinatura deve ocorrer no job de build, antes da verificação, upload
e attestations. São externos ao repositório: certificado/conta do provedor,
credencial de assinatura e URL de timestamp. Nunca armazene certificado, token,
senha ou chave privada no repositório.

## Publicação por tag

1. Atualize `package.json`, `manifest.json`, `CHANGELOG.md` e a documentação com
   a mesma versão.
2. Execute a verificação, o build e o smoke test acima.
3. Crie e envie uma tag estável que corresponda exatamente à versão:

   ```powershell
   git tag -a v1.2.0 -m "Video Radar 1.2.0"
   git push origin v1.2.0
   ```

4. O workflow `Release` repete os testes, reconstrói as ferramentas fixadas,
   valida o conjunto exato de artefatos, gera as attestations e prepara um draft.
   Após conferir os digests remotos, ele publica o GitHub Release; uma reexecução
   reutiliza o draft ou aceita como concluída uma Release pública já idêntica.

Uma execução manual produz artefatos e attestations para inspeção, mas nunca
publica um release. Tags incompatíveis com `package.json` ou `manifest.json`
falham antes da compilação.
