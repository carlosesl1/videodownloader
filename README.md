# Video Radar

[![CI](https://github.com/carlosesl1/videodownloader/actions/workflows/ci.yml/badge.svg)](https://github.com/carlosesl1/videodownloader/actions/workflows/ci.yml)
[![Versão](https://img.shields.io/github/v/release/carlosesl1/videodownloader?label=vers%C3%A3o)](https://github.com/carlosesl1/videodownloader/releases/latest)
[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-green.svg)](LICENSE)
[![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4.svg)](#compatibilidade)

Extensão open source para encontrar e baixar vídeos públicos ou autorizados
diretamente do navegador. O Video Radar reconhece arquivos de vídeo, transmissões
HLS compatíveis e posts públicos do YouTube, TikTok, Instagram e X.

A busca acontece somente quando você abre a extensão e clica em **Buscar vídeos**.
Não há monitoramento contínuo, conta, anúncios, telemetria ou servidor do projeto.

> [!IMPORTANT]
> Use o Video Radar apenas para mídias que sejam suas, estejam em domínio público,
> tenham licença aberta ou cuja transferência tenha sido autorizada. O projeto não
> contorna DRM, login, conteúdo privado nem restrições de acesso.

![Video Radar exibindo vídeos encontrados](docs/verification/assets/popup-resultados-diretos.png)

## Instalação fácil no Windows

O Video Radar não está na Chrome Web Store. A instalação usa um pequeno instalador
do Windows e uma etapa manual no navegador.

> [!NOTE]
> A página da V1 já existe, mas o instalador ainda não está anexado aos arquivos da
> Release. Enquanto `VideoRadar-Setup-1.0.0-Windows-x64.exe` e
> `SHA256SUMS.txt` não aparecerem em **Assets**, use apenas a
> [instalação pelo código-fonte](#instalação-pelo-código-fonte) abaixo.

Quando os arquivos estiverem disponíveis:

1. Abra a [última versão do Video Radar](https://github.com/carlosesl1/videodownloader/releases/latest).
2. Em **Assets**, baixe `VideoRadar-Setup-1.0.0-Windows-x64.exe` e
   `SHA256SUMS.txt`.
3. Confira o SHA-256 e execute o instalador. Ele instala apenas para o seu
   usuário e não pede permissão de administrador.
4. Ao final, o instalador abre a pasta da extensão e um guia local.
5. No Chrome, Edge, Brave ou Vivaldi, abra a página de extensões, ative o
   **Modo do desenvolvedor** e clique em **Carregar sem compactação**.
6. Selecione a pasta `%LOCALAPPDATA%\VideoRadar\Extension` que foi aberta pelo
   instalador e fixe o Video Radar na barra do navegador.

Como a V1 ainda não possui assinatura de código, o Windows SmartScreen pode
mostrar um aviso. Prossiga somente depois de confirmar que o arquivo veio desta
página e que seu SHA-256 corresponde ao publicado na mesma Release.

## Como usar

1. Abra uma página que contenha um vídeo público autorizado.
2. Abra o Video Radar e clique em **Buscar vídeos**.
3. Escolha a qualidade disponível e clique em **Baixar**.
4. Em **Configurar downloads**, escolha uma pasta padrão ou ative
   **Perguntar onde salvar cada download**.
5. Use **Cancelar** para interromper um download social ainda em andamento.

Arquivos diretos usam o gerenciador de downloads do navegador. HLS compatível
é reunido em um arquivo `.ts`. YouTube, TikTok, Instagram e X usam o auxiliar
nativo instalado no Windows. O andamento continua registrado mesmo se o popup
for fechado. Entregas automáticas de arquivos diretos e HLS usam temporariamente
`Downloads\Video Radar\.staging` antes de mover o vídeo para a pasta escolhida.

## O que ele oferece

- Busca sob demanda, iniciada somente por você.
- Detecção de `.mp4`, `.webm`, `.mov` e HLS (`.m3u8`) compatível.
- Seleção de qualidade quando a página oferece mais de uma opção.
- Suporte a vídeos e posts públicos individuais do YouTube, TikTok, Instagram e X.
- Escolha de uma pasta padrão ou do destino de cada download.
- Recuperação local de buscas e downloads após fechar o popup.
- Código aberto, sem conta, anúncios, analytics ou coleta de histórico.

## Compatibilidade

| Item | Suporte |
| --- | --- |
| Sistema | Windows 10 ou 11, x64 |
| Navegadores | Chrome, Edge, Brave e Vivaldi baseados no Chromium 116+ |
| Vídeos diretos | MP4, WebM e MOV |
| Streaming | HLS MPEG-TS compatível, com limite seguro de 256 MiB |
| Plataformas públicas | YouTube, TikTok, Instagram e X |

Não há suporte para conteúdo privado, autenticado, protegido por DRM, com
restrição de idade ou transmissões ao vivo. O Video Radar não lê cookies,
credenciais, `netrc` nem o perfil do navegador. Veja todos os
[limites conhecidos](docs/README.pt-BR.md#limites-e-uso-responsável).

## Privacidade e segurança

O auxiliar nativo se comunica com a extensão pelo Native Messaging do Chromium
usando `stdio`. Ele não abre servidor local nem porta de rede. Os dados necessários
para o download permanecem no computador e são enviados somente aos servidores
da mídia solicitada.

Leia a [Política de Privacidade](PRIVACY.md) e a [Política de Segurança](SECURITY.md).

## Instalação pelo código-fonte

Esta opção é destinada a desenvolvedores. Ela requer Windows, PowerShell,
Node.js 22 e internet no primeiro empacotamento.

```powershell
git clone https://github.com/carlosesl1/videodownloader.git
cd videodownloader
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-native-helper.ps1
```

Depois:

1. Abra `chrome://extensions`, `edge://extensions`, `brave://extensions` ou
   `vivaldi://extensions`.
2. Ative o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e
   selecione a pasta raiz do repositório, onde está `manifest.json`. Não
   selecione `dist`.
3. Execute `dist\video-radar-helper\Instalar-Video-Radar.cmd`.
4. Volte à página de extensões e clique em **Recarregar**.

O ID estável esperado é `cakpfifpfmbdcilimpedanglnopnmckg`. O launcher
`Instalar-Video-Radar.cmd` da raiz não substitui a cópia gerada dentro de
`dist\video-radar-helper`.

## Desenvolvimento

```powershell
npm run check
npm run check:all
```

`check:all` valida a extensão, executa os testes JavaScript e a suíte do auxiliar
nativo. O empacotamento da Release é separado porque baixa ferramentas fixadas e
verificadas por SHA-256. Consulte [Como publicar uma versão](docs/RELEASING.md).

Contribuições são bem-vindas. Antes de abrir uma mudança, leia o
[guia de contribuição](CONTRIBUTING.md). Para relatar problemas, use as
[Issues](https://github.com/carlosesl1/videodownloader/issues).

## Desinstalação

Na instalação normal, remova **Video Radar** em **Aplicativos instalados** do
Windows e depois remova a extensão de cada navegador. Os vídeos concluídos não
são apagados. A [documentação completa](docs/README.pt-BR.md#desinstalação)
inclui a limpeza manual do pacote de desenvolvedor.

## Licença

Video Radar é distribuído sob a [licença MIT](LICENSE). Ferramentas de terceiros
mantêm suas próprias licenças, incluídas nos pacotes gerados.
