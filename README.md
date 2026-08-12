# Video Radar

[![CI](https://github.com/carlosesl1/videodownloader/actions/workflows/ci.yml/badge.svg)](https://github.com/carlosesl1/videodownloader/actions/workflows/ci.yml)
[![Versão](https://img.shields.io/github/v/release/carlosesl1/videodownloader?label=vers%C3%A3o)](https://github.com/carlosesl1/videodownloader/releases/latest)
[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-green.svg)](LICENSE)
[![Windows](https://img.shields.io/badge/Windows-11%20%7C%2010%20LTSC-0078D4.svg)](#compatibilidade)

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

## Edições e distribuição

O Video Radar 1.2.0 é a **Desktop Edition**: o pacote completo para Windows,
incluindo a extensão e o auxiliar nativo. Ele não está na Chrome Web Store e sua
instalação usa um instalador do Windows mais uma etapa manual no navegador.

Uma **Store Edition** é apenas um plano futuro e ainda não está publicada. Ela
terá pacote, ID e conjunto de recursos próprios e não poderá oferecer download
do YouTube, conforme a
[política da Chrome Web Store](https://developer.chrome.com/docs/webstore/troubleshooting).
Não considere uma listagem de terceiros como publicação oficial deste projeto.

## Instalação fácil no Windows

> [!NOTE]
> Baixe a Desktop Edition 1.2.0 somente quando o instalador correspondente ao
> seu Windows e `SHA256SUMS.txt` aparecerem em
> **Assets**. Até lá, use apenas a
> [instalação pelo código-fonte](#instalação-pelo-código-fonte) abaixo.

Quando os arquivos estiverem disponíveis:

1. Abra a [última versão do Video Radar](https://github.com/carlosesl1/videodownloader/releases/latest).
2. Em **Assets**, baixe `VideoRadar-Setup-1.2.0-Windows-x64.exe` para PCs Intel/AMD
   ou `VideoRadar-Setup-1.2.0-Windows-arm64.exe` para Windows 11 ARM64, além de
   `SHA256SUMS.txt`.
3. Confira o SHA-256 e execute o instalador. Ele instala apenas para o seu
   usuário e não pede permissão de administrador.
4. Ao final, o instalador abre a pasta da extensão e um guia local.
5. No Chrome, Edge, Brave ou Vivaldi, abra a página de extensões, ative o
   **Modo do desenvolvedor** e clique em **Carregar sem compactação**.
6. Selecione a pasta `%LOCALAPPDATA%\VideoRadar\Extension` que foi aberta pelo
   instalador e fixe o Video Radar na barra do navegador.

Como a Desktop Edition 1.2.0 ainda não possui assinatura Authenticode, o Windows SmartScreen pode
mostrar um aviso. Prossiga somente depois de confirmar que o arquivo veio desta
página e que seu SHA-256 corresponde ao publicado na mesma Release.

## Como usar

1. Abra uma página que contenha um vídeo público autorizado.
2. Abra o Video Radar e clique em **Buscar vídeos**.
3. Escolha vídeo ou **Somente áudio**. Quando a plataforma informar os dados,
   confira resolução, fps, HDR, codecs e tamanho, e selecione uma legenda
   manual ou automática antes de clicar em **Baixar**.
4. Em **Configurar downloads**, escolha uma pasta padrão ou ative
   **Perguntar onde salvar cada download**.
5. Nos downloads sociais, use **Pausar**, **Retomar** ou **Cancelar** na seção
   **Downloads**.

Arquivos diretos usam o gerenciador de downloads do navegador. HLS compatível
é reunido em um arquivo `.ts`. YouTube, TikTok, Instagram e X usam o auxiliar
nativo instalado no Windows. O andamento continua registrado mesmo se o popup
for fechado. Entregas automáticas de arquivos diretos e HLS usam temporariamente
`Downloads\Video Radar\.staging` antes de mover o vídeo para a pasta escolhida.

O auxiliar processa um download social por vez e mantém uma fila local durável:
até 32 trabalhos não finalizados e até 64 registros no total, incluindo os
concluídos, cancelados ou com falha mais recentes. Ao pausar, o arquivo `.part`
é preservado; **Retomar** recoloca o trabalho na fila e continua os dados já
recebidos quando o servidor permite. **Cancelar** descarta o parcial.

Depois de reiniciar o Windows, a recuperação acontece quando um navegador
compatível for aberto e a extensão voltar a conectar o auxiliar. O Video Radar
não instala serviço, tarefa agendada nem daemon em segundo plano: se o navegador
não for iniciado, a fila permanece salva, mas não é executada.
Se a interrupção ocorrer depois de o arquivo final ser movido, um manifesto por
trabalho conserva o nome reservado: o auxiliar revalida esse mesmo arquivo com
`ffprobe` e conclui sem baixar novamente quando ele estiver íntegro.

## O que ele oferece

- Busca sob demanda, iniciada somente por você.
- Detecção de `.mp4`, `.webm`, `.mov` e HLS (`.m3u8`) compatível.
- Seleção de qualidade quando a página oferece mais de uma opção.
- Suporte a vídeos e posts públicos individuais do YouTube, TikTok, Instagram e X.
- Fila nativa durável, com pausa, retomada e recuperação após reconexão.
- Opção de áudio M4A e legendas VTT quando anunciadas pela plataforma.
- Catálogo enriquecido com fps, HDR, codecs, bitrate e tamanho exato ou estimado
  quando essas informações estão disponíveis.
- Validação final de downloads sociais com `ffprobe` antes de marcar o arquivo
  como concluído.
- Diagnóstico local opcional, desativado por padrão, com exportação explícita de
  um pacote de suporte sem URLs, cookies, caminhos de mídia ou `stderr`.
- Escolha de uma pasta padrão ou do destino de cada download.
- Recuperação local de buscas e downloads após fechar o popup.
- Código aberto, sem conta, anúncios, analytics ou coleta de histórico.

## Compatibilidade

| Item | Suporte |
| --- | --- |
| Sistema | Windows 11 x64 ou ARM64; Windows 10 Enterprise/IoT LTSC x64 ainda suportado pelo .NET 10 |
| Navegadores | Chrome, Edge, Brave e Vivaldi baseados no Chromium 116+ |
| Vídeos diretos | MP4, WebM e MOV |
| Streaming | HLS MPEG-TS compatível, com limite seguro de 256 MiB |
| Plataformas públicas | YouTube, TikTok, Instagram e X |

Não há suporte para conteúdo privado, autenticado, protegido por DRM, com
restrição de idade ou transmissões ao vivo. O auxiliar e o processamento HLS
não leem nem enviam cookies, credenciais, `netrc` ou dados do perfil. Downloads
diretos usam a API de downloads do próprio Chromium e, portanto, seguem a
sessão de rede normal do navegador sem expor cookies à extensão. Veja todos os
[limites conhecidos](docs/README.pt-BR.md#limites-e-uso-responsável).

Há pacotes separados `win-x64` e `win-arm64`. O pacote ARM64 usa host, Deno,
FFmpeg/ffprobe e yt-dlp nativos, sem fallback x64 silencioso. O instalador recusa
a arquitetura errada. Edições comuns do Windows 10 encerradas pela Microsoft não
fazem parte da matriz suportada; a compatibilidade oficial do
runtime está na [documentação do .NET 10](https://learn.microsoft.com/dotnet/core/install/windows#supported-versions).

## Privacidade e segurança

O auxiliar nativo se comunica com a extensão pelo Native Messaging do Chromium
usando `stdio`. Ele não abre servidor local nem porta de rede. Os dados necessários
para o download permanecem no computador e são enviados somente aos servidores
da mídia solicitada.

Em **Configurar downloads**, o painel de diagnóstico mostra a arquitetura, o
espaço disponível e a integridade das ferramentas. O registro de eventos é
opt-in e limitado; somente nomes de eventos e códigos de erro permitidos são
gravados. A exportação para ZIP ocorre apenas quando você solicita e escolhe a
pasta. Consulte a política para conhecer conteúdo, retenção e exclusão.

Leia a [Política de Privacidade](PRIVACY.md) e a [Política de Segurança](SECURITY.md).

## Instalação pelo código-fonte

Esta opção é destinada a desenvolvedores. Ela requer Windows, PowerShell,
Node.js 22 e internet no primeiro empacotamento.

```powershell
git clone https://github.com/carlosesl1/videodownloader.git
cd videodownloader
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-native-helper.ps1 -RuntimeIdentifier win-x64
```

Depois:

1. Abra `chrome://extensions`, `edge://extensions`, `brave://extensions` ou
   `vivaldi://extensions`.
2. Ative o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e
   selecione a pasta raiz do repositório, onde está `manifest.json`. Não
   selecione `dist`.
3. Execute `dist\video-radar-helper-win-x64\Instalar-Video-Radar.cmd`. Em um PC
   ARM64, use `-RuntimeIdentifier win-arm64` e a pasta terminada em `win-arm64`.
4. Volte à página de extensões e clique em **Recarregar**.

O ID estável esperado é `cakpfifpfmbdcilimpedanglnopnmckg`. O launcher
`Instalar-Video-Radar.cmd` da raiz não substitui a cópia gerada dentro de
`dist\video-radar-helper-win-x64` ou `dist\video-radar-helper-win-arm64`.

## Desenvolvimento

```powershell
npm run check
npm run check:all
```

`check:all` valida a extensão, executa os testes JavaScript e a suíte do auxiliar
nativo. Se o SDK .NET 10.0.400 exato não estiver instalado, o wrapper baixa uma
cópia oficial fixada e validada por SHA-512 para `.tools`. O empacotamento da
Release é separado porque baixa ferramentas fixadas e verificadas por SHA-256.
Consulte [Como publicar uma versão](docs/RELEASING.md).

Contribuições são bem-vindas. Antes de abrir uma mudança, leia o
[guia de contribuição](CONTRIBUTING.md). Para relatar problemas, use as
[Issues](https://github.com/carlosesl1/videodownloader/issues).

A [auditoria técnica e o roadmap premium](docs/AUDITORIA-PREMIUM.md) registram
os riscos corrigidos, evidências de qualidade e gates das próximas versões.

## Desinstalação

Na instalação normal, remova **Video Radar** em **Aplicativos instalados** do
Windows e depois remova a extensão de cada navegador. Os vídeos concluídos não
são apagados. A [documentação completa](docs/README.pt-BR.md#desinstalação)
inclui a limpeza manual do pacote de desenvolvedor.

## Licença

Video Radar é distribuído sob a [licença MIT](LICENSE). Ferramentas de terceiros
mantêm suas próprias licenças, incluídas nos pacotes gerados.
