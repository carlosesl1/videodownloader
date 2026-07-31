# Vídeo Radar — documentação em português

[Visão geral e instalação rápida](../README.md)

O Vídeo Radar tem duas partes: a extensão Manifest V3 nesta **pasta raiz** (onde está `manifest.json`) e o auxiliar nativo empacotado. O auxiliar usa Native Messaging por `stdio`: não inicia `localhost`, socket ou servidor. O armazenamento da extensão guarda apenas um snapshot local do estado do trabalho.

Use somente para um vídeo público que seja seu ou cujo download tenha sido autorizado.

## Instalação da V1

1. Abra a página
   [Releases](https://github.com/carlosesl1/videodownloader/releases) e baixe
   `VideoRadar-Setup-1.0.0-Windows-x64.exe`.
2. Execute o instalador. Ele instala somente para o seu usuário do Windows, não
   pede acesso de administrador e não exige PowerShell, .NET ou npm.
3. Siga o guia local aberto ao final. Na página de extensões, ative o **Modo do
   desenvolvedor**, clique em **Carregar sem compactação** e selecione a pasta
   `%LOCALAPPDATA%\VideoRadar\Extension`, que o instalador já abriu.
4. Confirme o ID `cakpfifpfmbdcilimpedanglnopnmckg`, fixe o Video Radar e use
   **Buscar vídeos**.

Essa etapa do navegador é manual porque o Video Radar não usa loja nem políticas
corporativas. A V1 sem assinatura pode exibir um aviso do Windows SmartScreen;
compare o SHA-256 do instalador com `SHA256SUMS.txt` da mesma release.

## Instalação a partir deste source

1. Na pasta raiz, execute:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-native-helper.ps1
   ```

   O pacote é criado em `dist\video-radar-helper`, ocupa cerca de 480 MB e, na primeira execução, requer rede para obter os artefatos fixados no lock.
2. Carregue **a pasta raiz, sem compactação**, no navegador: `chrome://extensions`, `edge://extensions`, `brave://extensions` ou `vivaldi://extensions`. Ative o modo de desenvolvedor e clique em **Carregar sem compactação**. Não selecione `dist`.
3. Dentro de `dist\video-radar-helper`, execute `Instalar-Video-Radar.cmd`. Não execute o launcher da raiz: ele não fica ao lado de um `package-manifest.json` válido.
4. Volte à página de extensões e clique em **Recarregar**. O ID esperado é `cakpfifpfmbdcilimpedanglnopnmckg`.

Se você recebeu o pacote distribuído já pronto, execute o launcher **dentro desse pacote** e carregue a extensão fornecida pela distribuição conforme as instruções dela.

## Uso

1. Abra um vídeo público autorizado do YouTube, TikTok, Instagram ou X.
2. Abra o popup, clique em **Buscar vídeos**, escolha a qualidade e clique em **Baixar**.
3. A busca em andamento, os vídeos encontrados, as qualidades inspecionadas e a
   qualidade escolhida permanecem disponíveis ao fechar e reabrir o popup.
4. **Vídeos encontrados** mostra somente o resultado da aba atual. Downloads em
   andamento, concluídos recentemente ou com falha recuperável aparecem em uma
   seção separada de **Downloads**. Use **Cancelar** para interromper um trabalho ativo.

### Destino dos downloads

Abra **Configurar downloads** no popup para escolher uma pasta padrão do Windows.
Com **Perguntar onde salvar cada download** ativado, o navegador pergunta o destino
para vídeos diretos/HLS e o Windows pergunta a pasta para vídeos sociais. Desativando a opção,
todos os formatos usam automaticamente a pasta padrão.

Diretos e HLS automáticos passam temporariamente por
`Downloads\Video Radar\.staging`. Se a movimentação falhar, o popup mostra o caminho
preservado para recuperação. O auxiliar nativo é necessário para escolher a pasta,
baixar vídeos sociais e entregar arquivos automáticos fora da pasta Downloads do navegador.

Para mídias diretas, a extensão reconhece `.mp4`, `.webm` e `.mov`. Para HLS compatível, ela apresenta variantes quando existirem e une os segmentos em `.ts`. Durante a montagem, o popup mostra os bytes já recebidos e uma estimativa do tamanho final marcada com `~`; o valor só é exato quando todos os segmentos terminam. Até oito segmentos são buscados simultaneamente quando o servidor permite. A montagem HLS tem limite seguro de 256 MiB; manifestos, linhas, catálogos de variantes, quantidade de segmentos ou duração excessivos são recusados antes de consumir recursos sem limite.

Os metadados públicos ficam em cache somente na memória do auxiliar por até 30 minutos no YouTube e 5 minutos no TikTok, Instagram e X. Se uma URL temporária do Instagram expirar, o auxiliar atualiza os metadados e tenta novamente uma única vez. Erros acionáveis da plataforma, como login exigido, limite de requisições, conteúdo privado ou alteração do extrator, são mostrados no popup em vez de serem ocultados por um resultado local vazio.

Se o popup informar que o auxiliar está ausente ou com erro, confirme a etapa 3 e recarregue a extensão. Não há monitoramento contínuo: a busca só ocorre depois de **Buscar vídeos**.

## Limites e uso responsável

- Não oferece suporte a DRM, conteúdo privado, ao vivo, com idade restrita ou que exija autenticação.
- Não usa cookies, credenciais, `netrc` nem perfil do navegador.
- Playlists não são tratadas como download em lote; Shorts individuais do YouTube e posts
  públicos individuais de TikTok, Instagram e X são aceitos.
- Carrosséis, slideshows, Stories, Spaces e posts com várias mídias ainda não são
  apresentados como download em lote.
- O acesso público é feito pelo `yt-dlp`; as ferramentas fixadas são atualizadas
  somente por uma nova versão do instalador do Video Radar.
- A disponibilidade de uma URL não concede direito de baixar ou redistribuir o conteúdo.

## Desenvolvimento

Os testes comuns não usam rede:

```powershell
npm run check
npm run check:all
```

`check:all` executa a validação estática/JS e a suíte do host nativo. Empacotar o auxiliar é um passo separado e pode buscar os artefatos fixados.

## Desinstalação

Na instalação normal, abra **Aplicativos instalados** do Windows, desinstale
**Video Radar** e depois remova a extensão na página de extensões de cada
navegador. O desinstalador remove o auxiliar, o guia local e as quatro chaves de
Native Messaging. Vídeos concluídos não são apagados.

Os comandos abaixo são apenas para quem usou o ZIP de desenvolvedor ou precisa
limpar manualmente uma instalação incompleta. Feche Chrome, Edge, Brave e
Vivaldi antes de executá-los:

```powershell
Remove-Item -LiteralPath 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.videoradar.helper' -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.videoradar.helper' -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.videoradar.helper' -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'HKCU:\Software\Vivaldi\NativeMessagingHosts\com.videoradar.helper' -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$env:LOCALAPPDATA\VideoRadar" -Recurse -Force -ErrorAction SilentlyContinue
```

Não há chave HKLM nem necessidade de executar como administrador.
