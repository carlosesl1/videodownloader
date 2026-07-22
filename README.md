# Vídeo Radar

Extensão Manifest V3 para navegadores baseados em Chromium que identifica vídeos somente quando você abre o popup e clica em **Buscar vídeos**.

Ela encontra arquivos diretos (`.mp4`, `.webm` e `.mov`) e playlists HLS (`.m3u8`). Quando uma playlist oferece variantes, você pode escolher a qualidade. Downloads HLS compatíveis são reunidos e salvos como `.ts`.

## Requisitos

- Google Chrome, Microsoft Edge ou outro navegador Chromium compatível com Chrome 116 ou superior.
- Conteúdo que você tenha autorização para baixar.

## Instalação

1. Baixe ou copie esta pasta para um local definitivo no computador.
2. Abra `chrome://extensions` no Chrome ou `edge://extensions` no Edge.
3. Ative o **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação**.
5. Selecione a pasta que contém o arquivo `manifest.json`.

Enquanto a extensão estiver instalada sem compactação, mantenha essa pasta no mesmo local.

## Como usar

1. Abra a página que contém o vídeo.
2. Clique no ícone do **Vídeo Radar**.
3. Clique em **Buscar vídeos**.
4. Escolha a qualidade, quando houver mais de uma opção.
5. Clique em **Baixar** para um arquivo direto ou em **Ver qualidades** para inspecionar um HLS.
6. Se o HLS usar outro servidor, autorize esse servidor quando o navegador solicitar.

Arquivos diretos são enviados ao gerenciador de downloads do navegador. Em HLS compatível, os segmentos são reunidos e o resultado é salvo como `.ts`, formato que pode ser reproduzido ou convertido depois.

## Privacidade e permissões

- Não existe monitoramento contínuo: a varredura só acontece após o clique em **Buscar vídeos**.
- A extensão combina elementos `<video>`/`<source>` da página com URLs já registradas pelo navegador na página atual.
- O acesso ao site atual é temporário, pelo `activeTab`, após sua interação.
- Acesso adicional a um servidor de mídia é opcional e solicitado apenas quando necessário para um HLS.
- O manifesto não concede acesso global permanente aos sites.

## Limitações

Esta versão não baixa:

- vídeos protegidos por DRM;
- HLS criptografado ou ao vivo;
- HLS baseado em fMP4/CMAF;
- playlists ou segmentos que dependem de byte ranges;
- streams DASH (`.mpd`).

Sites também podem impedir o download por autenticação, cookies, expiração de URL, política de origem ou outras restrições do servidor.

## Uso responsável

Use a extensão apenas para conteúdo próprio, de domínio público ou que você tenha permissão legal para baixar. A disponibilidade técnica de uma URL não concede direitos sobre o conteúdo.

