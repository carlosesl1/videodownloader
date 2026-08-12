# Publicação do Video Radar

Este documento é para mantenedores. A instalação normal de amigos e familiares
usa apenas o arquivo `VideoRadar-Setup-<versão>-Windows-x64.exe` publicado em
GitHub Releases.

## Pré-requisitos

- Windows 10/11 x64;
- Node.js 22;
- acesso de rede aos releases oficiais fixados em `native-host/tool-lock.json`
  e `installer/inno-tool-lock.json`;
- .NET é obtido pelo wrapper local do projeto quando não estiver disponível.

O bootstrap do Inno Setup valida URL imutável, tamanho, SHA-256 e assinatura
Authenticode antes de criar uma instalação portátil em `.tools`. Ele não chama
`winget`, Chocolatey nem instala o compilador globalmente.

## Verificação e build local

Na raiz do repositório:

```powershell
npm run check:all
npm run check:release
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-v1-release.ps1
Get-Content dist\release\SHA256SUMS.txt
```

O diretório `dist\release` deve conter exatamente:

- `VideoRadar-Setup-1.0.0-Windows-x64.exe`;
- `VideoRadar-1.0.0-Developer.zip`;
- `SHA256SUMS.txt`.

O instalador é a entrega principal. O ZIP existe para auditoria e instalação
manual por desenvolvedores.

## Smoke test antes da tag

1. Confira os dois hashes de `SHA256SUMS.txt` com `Get-FileHash -Algorithm SHA256`.
2. Execute o instalador em uma conta comum e confirme que ele não pede elevação.
3. Confirme a entrada **Video Radar** em Aplicativos instalados.
4. Confira que a pasta `%LOCALAPPDATA%\VideoRadar\Extension` abre ao final.
5. Carregue essa pasta como extensão sem compactação e confirme o ID
   `cakpfifpfmbdcilimpedanglnopnmckg`.
6. No Chrome, Edge, Brave ou Vivaldi, execute uma busca autorizada e confirme
   que o auxiliar responde.
7. Instale a mesma versão novamente e confirme o upgrade no mesmo caminho.
8. Desinstale pelo Windows, confirme a remoção das quatro chaves
   `NativeMessagingHosts\com.videoradar.helper` e remova manualmente a extensão
   do navegador.
9. Confirme que vídeos concluídos fora da pasta do aplicativo foram preservados.

## Assinatura opcional

O artefato local da V1 **não está assinado**. Por isso, o Windows SmartScreen
pode exibir um aviso de editor desconhecido. Isso é diferente da assinatura
válida do compilador Inno Setup usado durante o build.

O projeto pode solicitar assinatura gratuita para open source no
**SignPath Foundation**. A aceitação depende dos critérios e da análise do
SignPath; este repositório não presume aprovação.

Depois de receber a integração, assine somente o instalador final. Exemplo com
uma ferramenta Authenticode já configurada pelo provedor:

```powershell
& $env:VIDEO_RADAR_SIGNTOOL sign `
  /fd SHA256 `
  /tr $env:VIDEO_RADAR_TIMESTAMP_URL `
  /td SHA256 `
  dist\release\VideoRadar-Setup-1.0.0-Windows-x64.exe

$signature = Get-AuthenticodeSignature `
  -LiteralPath dist\release\VideoRadar-Setup-1.0.0-Windows-x64.exe
if ($signature.Status -ne 'Valid') {
  throw "Assinatura inválida: $($signature.Status)"
}
```

Como a assinatura altera o executável, regenere os hashes depois dela:

```powershell
$releaseRoot = Resolve-Path dist\release
$artifacts = @(
  Get-Item -LiteralPath `
    (Join-Path $releaseRoot 'VideoRadar-Setup-1.0.0-Windows-x64.exe'),
    (Join-Path $releaseRoot 'VideoRadar-1.0.0-Developer.zip') |
    Sort-Object Name
)
$lines = foreach ($artifact in $artifacts) {
  $hash = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $($artifact.Name)"
}
[IO.File]::WriteAllLines(
  (Join-Path $releaseRoot 'SHA256SUMS.txt'),
  $lines,
  [Text.UTF8Encoding]::new($false)
)
```

Nunca armazene certificado, token, senha ou chave privada no repositório.

## Publicação por tag

1. Atualize `package.json`, `manifest.json` e `CHANGELOG.md` com a mesma versão.
2. Execute a verificação, o build e o smoke test acima.
3. Crie e envie uma tag estável que corresponda exatamente à versão:

   ```powershell
   git tag -a v1.0.0 -m "Video Radar 1.0.0"
   git push origin v1.0.0
   ```

4. O workflow `Release` repete todos os testes, reconstrói as ferramentas
   fixadas, envia os artefatos da execução e cria o GitHub Release.

Uma execução manual do workflow produz artefatos para inspeção, mas nunca
publica um release. Tags incompatíveis com `package.json` ou `manifest.json`
falham antes da compilação.
