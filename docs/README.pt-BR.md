# Vídeo Radar — documentação em português

[Visão geral e instalação rápida](../README.md)

O Vídeo Radar tem duas partes: a extensão Manifest V3 nesta **pasta raiz** (onde está `manifest.json`) e o auxiliar nativo empacotado. O auxiliar usa Native Messaging por `stdio`: não inicia `localhost`, socket ou servidor. A extensão guarda snapshots da interface no perfil do navegador; o auxiliar mantém a fila durável de downloads sociais no armazenamento local do usuário do Windows.

Use somente para um vídeo público que seja seu ou cujo download tenha sido autorizado.

Os pacotes 1.2.0 são `win-x64` e `win-arm64`. Há suporte oficial no Windows 11
x64/ARM64 e nas edições Windows 10 Enterprise/IoT LTSC x64 ainda aceitas pelo
.NET 10. Edições
comuns do Windows 10 que já encerraram o ciclo de suporte não fazem parte da
matriz validada.

## Instalação da Desktop Edition 1.2.0

1. Abra a página
   [Releases](https://github.com/carlosesl1/videodownloader/releases) e baixe
   `VideoRadar-Setup-1.2.0-Windows-x64.exe` em PCs Intel/AMD ou
   `VideoRadar-Setup-1.2.0-Windows-arm64.exe` em PCs Windows 11 ARM64.
2. Execute o instalador. Ele instala somente para o seu usuário do Windows, não
   pede acesso de administrador e não exige PowerShell, .NET ou npm.
3. Siga o guia local aberto ao final. Na página de extensões, ative o **Modo do
   desenvolvedor**, clique em **Carregar sem compactação** e selecione a pasta
   `%LOCALAPPDATA%\VideoRadar\Extension`, que o instalador já abriu.
4. Confirme o ID `cakpfifpfmbdcilimpedanglnopnmckg`, fixe o Video Radar e use
   **Buscar vídeos**.

Essa etapa do navegador é manual porque o Video Radar não usa loja nem políticas
corporativas. A Desktop Edition 1.2.0 sem assinatura Authenticode pode exibir um aviso do Windows SmartScreen;
compare o SHA-256 do instalador com `SHA256SUMS.txt` da mesma release.

A **Store Edition** é uma proposta futura, não uma listagem existente. Ela terá
um pacote e um ID separados, sem download do YouTube, e não substitui o auxiliar
da Desktop Edition até que uma distribuição de loja seja implementada e aprovada.

## Instalação a partir deste source

1. Na pasta raiz, execute:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-native-helper.ps1 -RuntimeIdentifier win-x64
   ```

   Em Windows ARM64, troque o RID por `win-arm64`. O pacote é criado em uma pasta
   com o RID no nome e, na primeira execução, requer rede para obter os artefatos
   fixados no lock.
2. Carregue **a pasta raiz, sem compactação**, no navegador: `chrome://extensions`, `edge://extensions`, `brave://extensions` ou `vivaldi://extensions`. Ative o modo de desenvolvedor e clique em **Carregar sem compactação**. Não selecione `dist`.
3. Dentro de `dist\video-radar-helper-win-x64` ou
   `dist\video-radar-helper-win-arm64`, execute `Instalar-Video-Radar.cmd`. Não
   execute o launcher da raiz: ele não fica ao lado de um `package-manifest.json` válido.
4. Volte à página de extensões e clique em **Recarregar**. O ID esperado é `cakpfifpfmbdcilimpedanglnopnmckg`.

Se você recebeu o pacote distribuído já pronto, execute o launcher **dentro desse pacote** e carregue a extensão fornecida pela distribuição conforme as instruções dela.

## Uso

1. Abra um vídeo público autorizado do YouTube, TikTok, Instagram ou X.
2. Abra o popup, clique em **Buscar vídeos** e escolha vídeo ou **Somente áudio**.
   Quando disponíveis, resolução, fps, HDR, codecs, bitrate e tamanho aparecem
   junto da opção. Você também pode selecionar uma legenda antes de clicar em
   **Baixar**.
3. A busca em andamento, os vídeos encontrados, as qualidades inspecionadas e a
   qualidade escolhida permanecem disponíveis ao fechar e reabrir o popup.
4. **Vídeos encontrados** mostra somente o resultado da aba atual. Downloads em
   andamento, concluídos recentemente ou com falha recuperável aparecem em uma
   seção separada de **Downloads**. Nos trabalhos do auxiliar, use **Pausar**,
   **Retomar** ou **Cancelar**.

### Fila, pausa e recuperação

Downloads sociais processados pelo auxiliar entram em uma fila FIFO durável. O
host executa um trabalho por vez, aceita no máximo 32 trabalhos não finalizados
(`queued`, `running` ou `paused`) e mantém no máximo 64 registros no total. Ao
atingir o limite total, os registros terminais mais antigos são removidos para
abrir espaço; trabalhos ainda pendentes não são descartados.

Ao pausar um download ativo, o auxiliar encerra a árvore do processo e preserva
o arquivo parcial do `yt-dlp`. **Retomar** devolve o trabalho à fila usando
`--continue` e `--part`, de modo que os bytes existentes possam ser reutilizados
quando o servidor aceitar continuação. Pausar um item que ainda espera na fila
apenas muda seu estado. **Cancelar** é definitivo e remove o parcial preservado.
Pausa e retomada não se aplicam aos fluxos direto/HLS gerenciados pelo Chromium.

A fila sobrevive ao fechamento do popup, ao reinício do navegador e ao reinício
do Windows. Porém, o auxiliar não é um serviço, tarefa agendada ou daemon: ele é
iniciado sob demanda pelo Native Messaging. Depois de um reboot, a recuperação
só começa quando um navegador compatível é aberto e a extensão volta a conectar
o host. Um trabalho que ficou como `running` volta para a fila com retomada do
parcial; um trabalho pausado continua pausado até a ação do usuário.
Cada trabalho também mantém um manifesto atômico e confinado com o nome final
reservado. Se o Windows reiniciar depois da movimentação, durante o `ffprobe` ou
antes do commit da fila, o host revalida o mesmo arquivo e o conclui sem repetir
o download quando ele estiver íntegro. Se estiver inválido, somente os nomes
exatos pertencentes àquele manifesto são removidos antes da retomada.

### Áudio, legendas e detalhes do formato

Quando a plataforma pública fornece os metadados, o catálogo mostra resolução,
fps, HDR/faixa dinâmica, codecs de vídeo e áudio, bitrate e tamanho. O prefixo
`~` indica uma estimativa; sem esse prefixo, o tamanho veio como valor declarado
pelo extrator. Campos ausentes são simplesmente omitidos, pois nem toda página
publica todos esses dados.

**Somente áudio** seleciona a melhor faixa de áudio anunciada e gera M4A. Para
vídeo, legendas manuais e automáticas disponíveis podem ser selecionadas e são
gravadas como arquivo VTT ao lado da mídia. O catálogo também conserva os idiomas
de áudio informados pela plataforma, mas a v1.2 não oferece escolha manual da
faixa por idioma.

### Validação final com ffprobe

Antes de considerar um download social concluído, o auxiliar executa o
`ffprobe` empacotado por no máximo 30 segundos. A verificação exige arquivo
regular, container coerente com a extensão, streams de vídeo/áudio esperados e
duração e tamanho plausíveis em relação aos metadados disponíveis. Saída
inválida, truncada ou inconsistente gera `MEDIA_VALIDATION_FAILED`, e os arquivos
de mídia produzidos para aquele trabalho são removidos em vez de apresentar um
sucesso falso. Esta etapa não altera a validação própria dos downloads
diretos/HLS do navegador.

### Diagnóstico local e exportação

Em **Configurar downloads**, o painel exibe versão e protocolo do host,
arquitetura, espaço disponível e disponibilidade das quatro ferramentas. Esse
resumo de saúde não ativa telemetria. O registro de eventos é **desativado por
padrão** e só começa depois que você habilita **Registrar diagnóstico local**.

Os registros estruturados contêm somente horário, nomes de eventos permitidos e
códigos de erro permitidos. URLs, cookies, caminhos da mídia, credenciais,
comandos completos e `stderr` de processos não entram no log. A rotação conserva
no máximo oito arquivos de 256 KiB cada. **Exportar pacote** pede uma pasta e
cria um ZIP com `health.json`, aviso de privacidade, hashes/versões das
ferramentas e os logs locais existentes. Nada é enviado automaticamente. Use
**Apagar registros** para excluir os logs; desabilitar o registro apenas impede
novos eventos. O ZIP exportado continua na pasta escolhida até você apagá-lo.

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

### Windows ARM64

A edição ARM64 não depende da emulação x64 para processar downloads. O host .NET
é publicado para `win-arm64` e o lock fixa os assets ARM64 oficiais do Deno,
FFmpeg/ffprobe e yt-dlp. O empacotamento lê o cabeçalho PE de todos os cinco
executáveis e falha se algum deles não for ARM64. O instalador também recusa um
pacote cuja arquitetura não corresponda ao Windows.

Não existe fallback automático para ferramentas x64: se um fornecedor deixar de
publicar um dos assets ARM64, a geração do lock ou do pacote falha. Uma eventual
emulação futura teria de ser uma decisão explícita, documentada e testada em uma
nova versão. A CI executa o pacote em um runner `windows-11-arm` nativo além do
build cruzado usado para reunir os artefatos da release.

A única camada emulada é o invólucro do instalador: o Inno Setup 7 atualmente
gera Setup em x86 ou x64, não em ARM64. O instalador `Windows-arm64` usa o loader
x64 oficialmente compatível com Windows 11 ARM e restringe a execução com
`ArchitecturesAllowed=arm64`. Depois da instalação, o host e todas as ferramentas
de mídia executam como ARM64 nativo. Essa exceção não permite instalar o payload
x64 no lugar do ARM64.

## Limites e uso responsável

- Não oferece suporte a DRM, conteúdo privado, ao vivo, com idade restrita ou que exija autenticação.
- O auxiliar e o processamento HLS não leem nem enviam cookies, credenciais,
  `netrc` ou dados do perfil. Downloads diretos seguem a sessão de rede normal
  da API de downloads do Chromium sem expor cookies à extensão.
- HLS com áudio em uma playlist separada é recusado para evitar gerar um arquivo
  mudo; fMP4, byte ranges e conteúdo criptografado também ainda não são suportados.
- Playlists não são tratadas como download em lote; Shorts individuais do YouTube e posts
  públicos individuais de TikTok, Instagram e X são aceitos.
- Carrosséis, slideshows, Stories, Spaces e posts com várias mídias ainda não são
  apresentados como download em lote.
- O acesso público é feito pelo `yt-dlp`; as ferramentas fixadas são atualizadas
  somente por uma nova versão do instalador do Video Radar.
- A disponibilidade de uma URL não concede direito de baixar ou redistribuir o conteúdo.

## Desenvolvimento

As suítes em si não consultam plataformas nem servidores externos. Na primeira
execução em uma máquina sem o SDK .NET 10.0.400 exato, o wrapper baixa o ZIP
oficial fixado e valida seu SHA-512 antes de instalá-lo em `.tools`; execuções
seguintes reutilizam o SDK verificado:

```powershell
npm run check
npm run check:all
```

`check:all` executa a validação estática/JS e a suíte do host nativo. Empacotar o auxiliar é um passo separado e pode buscar os artefatos fixados.

## Desinstalação

Na instalação normal, abra **Aplicativos instalados** do Windows, desinstale
**Video Radar** e depois remova a extensão na página de extensões de cada
navegador. O desinstalador remove o auxiliar, o guia local e as quatro chaves de
Native Messaging. Vídeos concluídos não são apagados. Como a fila e os
diagnósticos são dados criados depois da instalação, a pasta
`%LOCALAPPDATA%\VideoRadar` pode permanecer com esses registros; apague-a
manualmente, depois de conferir que não precisa de parciais ou relatórios, para
remover todo o estado local do auxiliar.

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
