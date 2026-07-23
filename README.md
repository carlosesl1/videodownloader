# Vídeo Radar

O Vídeo Radar tem duas partes: a extensão Manifest V3 nesta **pasta raiz** (onde está `manifest.json`) e o auxiliar nativo empacotado. O auxiliar usa Native Messaging por `stdio`: não inicia `localhost`, socket ou servidor. O armazenamento da extensão guarda apenas um snapshot local do estado do trabalho.

Use somente para um vídeo público que seja seu ou cujo download tenha sido autorizado.

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

1. Abra um vídeo público do YouTube que seja seu ou autorizado.
2. Abra o popup, clique em **Buscar vídeos**, escolha a qualidade e clique em **Baixar**.
3. O progresso permanece disponível ao fechar e reabrir o popup. Use **Cancelar** para interromper um trabalho em andamento.

Os arquivos são gravados em `%USERPROFILE%\Downloads\Video Radar`. Para mídias diretas, a extensão também reconhece `.mp4`, `.webm` e `.mov`. Para HLS compatível, ela apresenta variantes quando existirem e une os segmentos em `.ts`.

Se o popup informar que o auxiliar está ausente ou com erro, confirme a etapa 3 e recarregue a extensão. Não há monitoramento contínuo: a busca só ocorre depois de **Buscar vídeos**.

## Limites e uso responsável

- Não oferece suporte a DRM, conteúdo privado, ao vivo, com idade restrita ou que exija autenticação.
- Não usa cookies, credenciais, `netrc` nem perfil do navegador.
- Playlists, Shorts e formatos que o serviço não suporte não são tratados como download em lote.
- O acesso público é feito pelo `yt-dlp`; a política diária de atualização aplica-se somente ao `yt-dlp`.
- A disponibilidade de uma URL não concede direito de baixar ou redistribuir o conteúdo.

## Desenvolvimento

Os testes comuns não usam rede:

```powershell
npm run check
npm run check:all
```

`check:all` executa a validação estática/JS e a suíte do host nativo. Empacotar o auxiliar é um passo separado e pode buscar os artefatos fixados.

## Desinstalação

Feche Chrome, Edge, Brave e Vivaldi. Remova a extensão em cada página de extensões e, no PowerShell, remova somente os registros do usuário atual e a pasta `%LOCALAPPDATA%\VideoRadar`:

```powershell
Remove-Item -LiteralPath 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.videoradar.helper' -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.videoradar.helper' -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.videoradar.helper' -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'HKCU:\Software\Vivaldi\NativeMessagingHosts\com.videoradar.helper' -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$env:LOCALAPPDATA\VideoRadar" -Recurse -Force -ErrorAction SilentlyContinue
```

Não há chave HKLM nem necessidade de executar como administrador.
