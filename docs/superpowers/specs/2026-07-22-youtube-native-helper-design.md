# Vídeo Radar — suporte ao YouTube com auxiliar local

Data: 22 de julho de 2026

Status: design conversacional aprovado; documento aguardando revisão final do usuário

Esta especificação estende `2026-07-21-chrome-video-downloader-design.md`. A detecção e o download atuais de arquivos diretos e HLS continuam funcionando. O novo caminho é usado somente em páginas compatíveis do YouTube.

## 1. Objetivo

Adicionar ao Vídeo Radar o download sob demanda de vídeos públicos do YouTube, com escolha de qualidade, progresso persistente e processamento inteiramente local.

Para o usuário, o fluxo deve permanecer simples:

1. abrir o popup;
2. clicar em **Buscar vídeos**;
3. escolher a qualidade;
4. clicar em **Baixar**;
5. poder fechar e reabrir o popup sem perder o progresso;
6. encontrar o arquivo concluído em `Downloads\Video Radar`.

## 2. Decisão arquitetural

O suporte ao YouTube usará:

- a extensão Manifest V3 já existente;
- Native Messaging do Chrome;
- um host Windows local e autocontido;
- o executável oficial do `yt-dlp` para consultar formatos e baixar a mídia;
- FFmpeg para unir áudio e vídeo quando o YouTube os fornecer separadamente;
- Deno como runtime JavaScript usado pelos resolvedores atuais do `yt-dlp`.

Não haverá servidor HTTP local, porta aberta nem serviço externo de preparação de vídeos.

O host será um executável C#/.NET autocontido para Windows x64. O computador do usuário não precisará ter Python, Node ou .NET instalados.

## 3. Escopo e limites

### Incluído

- páginas `youtube.com/watch` e links `youtu.be` públicos;
- consulta das qualidades realmente disponíveis;
- download de uma qualidade escolhida;
- união de áudio e vídeo sem recodificação pesada;
- barra de progresso com etapas reconhecíveis;
- cancelamento;
- persistência ao fechar e reabrir o popup;
- notificação de conclusão;
- um download do YouTube ativo por vez, sem alterar a concorrência dos fluxos direto e HLS existentes.

### Fora de escopo

- DRM ou qualquer tentativa de contornar proteção;
- vídeos privados, pagos ou que exijam credenciais;
- leitura ou exportação de cookies do navegador;
- playlists e canais completos;
- transmissões ao vivo;
- extração somente de áudio;
- suporte inicial a Windows ARM64, macOS ou Linux;
- retomada automática depois de fechar completamente o Chrome ou reiniciar o Windows.

O produto deve lembrar que o usuário só deve baixar conteúdo próprio ou para o qual tenha autorização.

## 4. Instalação

O pacote de desenvolvimento terá um instalador de usuário único, sem elevação administrativa. Ele instalará os componentes em:

```text
%LOCALAPPDATA%\VideoRadar\
  host\video-radar-host.exe
  tools\yt-dlp.exe
  tools\ffmpeg.exe
  tools\ffprobe.exe
  tools\deno.exe
  native-host\com.videoradar.helper.json
  licenses\...
  state\...
  temp\...
```

O instalador:

1. copia componentes com versões fixadas e verifica seus SHA-256;
2. detecta Google Chrome, Microsoft Edge e Brave instalados e registra o manifesto Native Messaging nos respectivos locais de usuário em `HKCU`, sem administrador;
3. restringe `allowed_origins` ao ID estável do Vídeo Radar;
4. executa um `ping` local de diagnóstico;
5. informa sucesso ou uma falha acionável.

O `manifest.json` da extensão terá uma chave de desenvolvimento estável, para que o ID usado pelo Native Messaging não mude ao recarregar a extensão descompactada nesses navegadores. Outros navegadores Chromium ficam fora da matriz inicial até que seu local de registro seja documentado e testado.

O pacote descompactado usa uma origem fixa. Uma futura distribuição por lojas deverá gerar o manifesto do host com a lista explícita de IDs de cada canal publicado. Não serão usados curingas em `allowed_origins`.

Na primeira versão, um lançador `Instalar-Video-Radar.cmd` poderá conduzir a instalação local. Uma distribuição pública assinada poderá substituir esse lançador por um instalador gráfico sem alterar o protocolo.

## 5. Componentes e responsabilidades

### 5.1 Popup

- inicia a busca somente por gesto explícito;
- mostra título, qualidades e formato previsto;
- inicia ou cancela o download;
- lê o estado persistido ao abrir;
- acompanha atualizações em tempo real enquanto estiver aberto;
- nunca mantém a operação viva por conta própria.

### 5.2 Service worker

- identifica URLs do YouTube e direciona essas operações ao host;
- abre uma conexão `connectNative` durável durante o trabalho;
- valida mensagens do popup e do host;
- persiste cada transição em `chrome.storage.local`;
- retransmite progresso para qualquer popup aberto;
- cria a notificação final;
- marca como interrompido um trabalho que ficou ativo sem host correspondente.

O manifesto acrescentará as permissões `nativeMessaging` e `notifications`. As permissões e o comportamento sob demanda já existentes para páginas comuns permanecem inalterados.

### 5.3 Host nativo

- recebe e envia mensagens JSON pelo framing de Native Messaging;
- valida comandos, URL, qualidade e identificadores;
- executa `yt-dlp` e FFmpeg sem usar shell para concatenar comandos;
- analisa a saída estruturada e publica progresso normalizado;
- limita o destino às pastas aprovadas;
- encerra o processo filho quando recebe cancelamento;
- coloca os processos filhos em um Windows Job Object configurado para encerrá-los se o host ou a conexão Native Messaging terminar;
- remove temporários após conclusão, cancelamento ou erro.

### 5.4 Ferramentas empacotadas

- `yt-dlp.exe`: consulta metadados, seleciona formatos e baixa fluxos;
- `ffmpeg.exe`/`ffprobe.exe`: união e inspeção local;
- `deno.exe`: execução restrita dos desafios JavaScript necessários ao suporte atual do YouTube.

O executável oficial empacotado do `yt-dlp` já inclui os scripts EJS correspondentes. Deno ficará na mesma pasta das ferramentas ou será passado por caminho absoluto.

## 6. Protocolo Native Messaging

Toda mensagem terá `type`, `requestId` e, quando aplicável, `jobId`.

### Comandos da extensão

- `ping`: verifica instalação e versões;
- `listFormats`: recebe uma URL e devolve metadados reduzidos;
- `startDownload`: inicia URL, qualidade e destino lógico;
- `cancelDownload`: cancela o trabalho ativo;
- `getJob`: reconcilia o último estado conhecido.

### Eventos do host

- `ready`;
- `formats`;
- `jobStarted`;
- `jobProgress`;
- `jobCompleted`;
- `jobCancelled`;
- `jobFailed`.

`jobProgress` usará este modelo lógico:

```json
{
  "type": "jobProgress",
  "jobId": "uuid",
  "stage": "video|audio|merge|finalize",
  "percent": 62,
  "downloadedBytes": 123,
  "totalBytes": 456,
  "speedBytesPerSecond": 789,
  "etaSeconds": 12
}
```

Campos desconhecidos serão ignorados e tipos inválidos serão recusados. Nenhuma mensagem individual poderá carregar arquivos ou grandes blocos binários.

## 7. Descoberta e escolha de qualidade

Em uma página do YouTube, **Buscar vídeos** enviará apenas a URL atual ao host. O host executará uma consulta sem download e reduzirá a resposta do `yt-dlp` para:

- título;
- identificador do vídeo;
- duração, se disponível;
- miniatura remota apenas como metadado opcional;
- alturas disponíveis;
- presença de formato combinado ou de fluxos separados;
- formato final provável.

As opções serão agrupadas por altura e ordenadas da maior para a menor, por exemplo: `2160p`, `1440p`, `1080p`, `720p`, `480p` e `360p`. Duplicatas de codec não aparecerão como opções separadas nesta versão.

Ao baixar uma altura:

1. o host prefere um arquivo que já contenha áudio e vídeo naquela qualidade;
2. se não existir, seleciona o melhor vídeo até a altura escolhida e o melhor áudio compatível;
3. usa FFmpeg para unir os fluxos;
4. prefere MP4/H.264/AAC quando disponíveis sem recodificação;
5. usa WebM quando for o contêiner compatível mais seguro e produzir MP4 exigiria conversão pesada.

A interface deve informar o formato final previsto, sem prometer MP4 quando os codecs disponíveis não forem compatíveis.

## 8. Progresso persistente

O popup não é dono do download. Fechá-lo não fecha a conexão entre o service worker e o host.

Enquanto a porta Native Messaging estiver conectada, o host é a fonte de verdade do trabalho ativo e `getJob` consulta esse mesmo processo. O snapshot em `chrome.storage.local` existe para reconstruir a interface, não para reanexar a um processo perdido.

Se a porta cair, o Job Object encerra `yt-dlp` e FFmpeg. O service worker marca o snapshot ativo como **interrompido**. Ao iniciar novamente, qualquer snapshot ainda marcado como ativo é reconciliado com um novo `ping`; como um novo host não possui o `jobId` anterior, o estado passa deterministicamente para **interrompido** e oferece **Tentar novamente**. Não há promessa de retomada após queda do service worker, fechamento do navegador ou reinício do Windows.

O service worker salvará em `chrome.storage.local`:

- `jobId`;
- URL canônica mínima ou identificador do vídeo;
- título sanitizado;
- qualidade;
- estágio;
- percentual;
- bytes conhecidos;
- horário da última atualização;
- status final;
- caminho do arquivo concluído ou erro público.

Ao reabrir, o popup:

1. renderiza imediatamente o último estado salvo;
2. pede reconciliação ao service worker;
3. atualiza o cartão quando o host responder;
4. continua acompanhando novos eventos.

Etapas apresentadas ao usuário:

- **Preparando…**;
- **Baixando vídeo…**;
- **Baixando áudio…**;
- **Combinando…**;
- **Finalizando…**;
- **Concluído**.

Quando o total não for conhecido, a barra será indeterminada e mostrará a etapa, sem inventar percentual. O percentual nunca deve regredir dentro da mesma etapa.

## 9. Arquivos e limpeza

Destino final:

```text
%USERPROFILE%\Downloads\Video Radar\
```

Temporários:

```text
%LOCALAPPDATA%\VideoRadar\temp\<jobId>\
```

O host deve:

- criar nomes a partir do título e do ID do vídeo;
- remover caracteres inválidos e nomes reservados do Windows;
- evitar sobrescrever arquivos, adicionando sufixo numérico;
- mover o resultado para o destino somente depois da conclusão;
- limpar intermediários em sucesso, cancelamento e falha controlada;
- limpar diretórios órfãos antigos na inicialização, sem tocar arquivos finais.

## 10. Atualizações

O instalador distribui versões conhecidas e verificadas de todas as ferramentas.

O host poderá verificar a atualização oficial do `yt-dlp` no máximo uma vez a cada 24 horas. Falha de atualização não bloqueia a versão instalada. FFmpeg, Deno e o próprio host serão atualizados por uma nova versão do instalador.

Não haverá verificação de atualização a cada clique nem download de binários de fontes não oficiais. Avisos e licenças de terceiros acompanharão o pacote.

## 11. Privacidade e segurança

- nenhuma URL de vídeo será enviada a um serviço de processamento controlado pelo Vídeo Radar;
- não haverá telemetria;
- o host aceitará somente a origem da extensão registrada;
- o host aceitará apenas URLs `https` pertencentes às rotas públicas suportadas do YouTube;
- não haverá leitura de cookies, credenciais ou perfil do Chrome;
- argumentos de processos serão construídos como lista, sem interpolação de shell;
- caminhos recebidos da extensão não serão aceitos como destinos arbitrários;
- logs locais não registrarão URLs assinadas completas nem dados sensíveis;
- DRM e pedidos de autenticação serão recusados com mensagem clara.

As únicas conexões esperadas são as realizadas pelo `yt-dlp` aos endpoints necessários do YouTube e, na verificação diária opcional, à fonte oficial de atualização do próprio `yt-dlp`.

## 12. Erros e recuperação

Mensagens principais:

- **Auxiliar não instalado** — oferece instrução para executar o instalador;
- **Não foi possível conectar ao auxiliar** — permite testar novamente;
- **Vídeo indisponível ou restrito** — não sugere contorno de acesso;
- **Nenhuma qualidade compatível encontrada**;
- **Conexão interrompida** — permite repetir;
- **Espaço insuficiente**;
- **Download cancelado**;
- **Componente desatualizado** — oferece atualização do auxiliar;
- **Download interrompido porque o Chrome foi fechado**.

Um erro do caminho YouTube não deve quebrar a detecção direta ou HLS existente.

## 13. Interface

O popup manterá a largura natural já adotada pelo Vídeo Radar. Em páginas do YouTube haverá um único cartão principal com:

- título truncado de forma acessível;
- seletor de qualidade;
- formato previsto;
- botão **Baixar**;
- botão **Cancelar** durante a operação;
- barra de progresso;
- etapa e detalhes curtos;
- caminho final depois da conclusão.

O estado deve continuar legível com zoom e navegação por teclado. A barra terá texto equivalente para leitores de tela e respeitará `prefers-reduced-motion`.

## 14. Verificação proporcional

Sem verificações excessivas, a implementação terá:

- testes unitários do protocolo, validação de mensagens, agrupamento de qualidades, sanitização de nomes e parser de progresso;
- teste de integração do host com um processo falso, sem baixar vídeos reais repetidamente;
- testes negativos que rejeitam URL não HTTPS, domínio não permitido e destino arbitrário;
- teste do construtor de argumentos garantindo ausência de `--cookies`, `--cookies-from-browser` e opções de perfil do navegador;
- testes de instalação que exigem `allowed_origins` explícito e os registros de usuário dos navegadores suportados;
- teste de desconexão que encerra o processo filho e converte um snapshot ativo em **interrompido**;
- preflight que confirma não haver listener HTTP/TCP no host nem dependência de `localhost` no caminho YouTube;
- preflight existente da extensão;
- uma verificação manual com vídeo público autorizado, incluindo escolha de qualidade, progresso, fechamento/reabertura do popup, conclusão e cancelamento;
- `git diff --check` e a suíte atual antes da entrega.

Não serão adicionados testes de rede instáveis que dependam continuamente do comportamento do YouTube.

## 15. Critérios de aceitação

O suporte está pronto quando:

1. o instalador registra o host sem administrador em Windows 10/11 x64 para Chrome, Edge e Brave detectados;
2. o popup distingue claramente auxiliar ausente de mídia ausente;
3. **Buscar vídeos** mostra as alturas disponíveis em um vídeo público compatível;
4. a qualidade selecionada é respeitada;
5. áudio e vídeo separados são unidos localmente;
6. o resultado é salvo em `Downloads\Video Radar`;
7. fechar e reabrir o popup não interrompe nem perde o progresso;
8. cancelamento encerra o processo e remove temporários;
9. conclusão e falha permanecem visíveis ao reabrir o popup;
10. nenhum servidor local, cookie ou serviço externo de processamento do Vídeo Radar é usado;
11. os downloads diretos e HLS existentes continuam passando em seus testes;
12. os limites de vídeos públicos, sem DRM e sem credenciais são respeitados.

## 16. Referências técnicas

- [Native Messaging — Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Ciclo de vida do service worker — Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Native Messaging no Microsoft Edge — Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/native-messaging)
- [yt-dlp — repositório e seleção de formatos](https://github.com/yt-dlp/yt-dlp)
- [EJS — runtime JavaScript necessário ao suporte atual do YouTube](https://github.com/yt-dlp/yt-dlp/wiki/EJS)
- [Video DownloadHelper CoApp — precedente de auxiliar nativo](https://github.com/aclap-dev/vdhcoapp)
