# Vídeo Radar — Especificação de Design

Data: 21 de julho de 2026

## 1. Objetivo

Criar uma extensão Manifest V3 para navegadores baseados em Chromium que, sob solicitação explícita do usuário, detecte vídeos na aba ativa e permita baixar:

- arquivos diretos `.mp4`, `.webm` e `.mov`;
- vídeos HLS sob demanda com segmentos MPEG-TS, salvos como `.ts`;
- a qualidade escolhida quando a origem expuser variantes reconhecíveis.

A extensão se chama **Vídeo Radar**. Ela funciona inteiramente no navegador, sem servidor externo, telemetria ou monitoramento contínuo da navegação.

## 2. Fora de escopo

A primeira versão não:

- contorna DRM ou mecanismos de acesso;
- baixa HLS criptografado;
- remuxa ou converte conteúdo para MP4;
- processa HLS baseado em segmentos fMP4/CMAF;
- processa playlists HLS ao vivo, playlists com byte ranges ou streams DASH;
- inventa qualidades que a página ou playlist não oferece;
- monitora tráfego de rede permanentemente.

Quando uma dessas condições for detectada, a interface deve explicar o limite e não produzir um arquivo incompleto como se fosse válido.

## 3. Experiência principal

1. O usuário abre o popup da extensão.
2. O popup exibe o estado inicial e o botão **Buscar vídeos nesta página**.
3. Ao clicar, a extensão usa o acesso temporário concedido à aba ativa e executa uma varredura híbrida.
4. O popup lista as mídias encontradas, sem duplicatas.
5. Quando houver variantes, a maior qualidade vem pré-selecionada e o usuário pode trocá-la.
6. O usuário clica em **Baixar**.
7. Arquivos diretos são entregues imediatamente ao gerenciador de downloads do Chrome.
8. Para HLS, o botão muda temporariamente para **Preparando…** e uma barra mostra o avanço por segmentos enquanto a extensão monta o arquivo `.ts`.
9. Quando o arquivo for entregue ao Chrome, o popup mostra uma confirmação curta: **Download enviado ao Chrome**.

A barra do popup cobre a etapa anterior ao download do Chrome, quando os segmentos HLS são baixados e unidos. Depois que o arquivo é entregue, o gerenciador de downloads do navegador assume o acompanhamento.

## 4. Detecção híbrida

A detecção acontece apenas após o clique do usuário e combina duas fontes na página ativa:

### 4.1 Elementos do DOM

O script injetado examina:

- `video.currentSrc`;
- `video.src`;
- elementos `<source>` dentro de `<video>`;
- o atributo `type` dos elementos quando presente;
- `video.videoWidth` e `video.videoHeight` quando já conhecidos.

### 4.2 Performance Resource Timing

O script também examina `performance.getEntriesByType("resource")` para localizar recursos cujo caminho ou tipo aparente corresponda a `.mp4`, `.webm`, `.mov` ou `.m3u8`.

### 4.3 Normalização

Cada candidato é convertido para URL absoluta. O fragmento `#...` é removido, mas a query string é preservada porque pode carregar assinatura ou autenticação. URLs iguais após essa normalização são deduplicadas.

URLs `blob:` e `data:` não entram como downloads diretos, pois não representam um recurso recuperável de forma confiável. Quando forem a única mídia observável, o estado vazio deve explicar que a página usa uma fonte interna ou protegida.

## 5. Qualidades e agrupamento

### 5.1 HLS

Uma playlist master com `#EXT-X-STREAM-INF` fornece as variantes. Cada opção deve mostrar, quando disponível:

- resolução, como `1920 × 1080`;
- rótulo simplificado, como `1080p`;
- bitrate estimado, como `5,2 Mbps`;
- codecs como informação secundária opcional.

As variantes são ordenadas por altura, depois por largura e bitrate. A de maior qualidade fica selecionada por padrão. Uma media playlist sem master é apresentada como **Qualidade única**.

### 5.2 Arquivos diretos

Arquivos diretos só são agrupados como variantes quando a relação for confiável, por exemplo, múltiplos `<source>` do mesmo `<video>` com dimensões ou rótulos identificáveis. Candidatos ambíguos permanecem separados para evitar associar vídeos diferentes.

Quando apenas uma URL for conhecida, o seletor é substituído por **Qualidade única**, acompanhado da resolução apenas se ela tiver sido observada.

## 6. Permissões e privacidade

O manifesto usa permissões funcionais mínimas:

- `activeTab` e `scripting` para executar a detecção somente após interação do usuário;
- `downloads` para entregar arquivos ao Chrome;
- `offscreen` para preparar HLS sem depender de o popup permanecer aberto.

Origens `http` e `https` ficam em `optional_host_permissions`, não em permissões obrigatórias globais.

O clique de busca usa o acesso temporário da aba ativa. Se uma mídia estiver em outra origem, o clique de download inicia uma solicitação limitada àquela origem. Se uma playlist revelar segmentos em outra origem, a extensão informa o motivo e oferece um novo botão explícito para autorizar o servidor de mídia. Permissões opcionais concedidas para a preparação HLS devem ser removidas após conclusão ou falha, desde que não sejam necessárias por outra operação ativa.

Nenhuma URL, título de página, mídia ou métrica é enviada para serviços externos.

## 7. Arquitetura

### 7.1 Popup

Responsável por:

- estados e interações da interface;
- disparar a detecção na aba ativa;
- apresentar mídias, variantes e mensagens;
- solicitar permissões opcionais mediante gesto explícito;
- enviar comandos de download ao service worker.

### 7.2 Detector injetado

Uma função autocontida executada por `chrome.scripting.executeScript` lê DOM e Performance API e devolve dados serializáveis. Ela não instala listeners persistentes nem modifica a página.

### 7.3 Service worker

Responsável por:

- validar mensagens recebidas;
- iniciar downloads diretos;
- coordenar o documento offscreen;
- criar e encerrar operações HLS;
- remover permissões transitórias ao final;
- impedir operações duplicadas para a mesma mídia.

### 7.4 Documento offscreen

Responsável pelo trabalho de longa duração do HLS:

- buscar e analisar playlists;
- resolver a variante escolhida;
- validar o perfil suportado;
- baixar segmentos MPEG-TS;
- preservar a ordem dos segmentos;
- montar um `Blob` `video/mp2t`;
- devolver ao worker a URL do blob e os metadados do arquivo.

O documento offscreen mantém no máximo quatro downloads de segmentos em paralelo. Os bytes são montados em ordem, independentemente da ordem de término das requisições.

## 8. Regras HLS

O parser deve reconhecer:

- cabeçalho `#EXTM3U`;
- variantes `#EXT-X-STREAM-INF`;
- duração e lista de segmentos `#EXTINF`;
- encerramento VOD `#EXT-X-ENDLIST`;
- URLs relativas resolvidas contra a URL da playlist.

A operação deve ser recusada com mensagem específica quando houver:

- `#EXT-X-KEY` com método diferente de `NONE`;
- `#EXT-X-MAP`, indicando segmentos fMP4;
- `#EXT-X-BYTERANGE`;
- playlist sem `#EXT-X-ENDLIST`;
- resposta que não seja uma playlist HLS válida;
- segmentos de origem não autorizada;
- falha HTTP, timeout ou cancelamento;
- mais de 1 GiB de segmentos acumulados.

O limite de 1 GiB vale somente para a montagem HLS em memória. Downloads diretos são transmitidos pelo próprio Chrome e não usam esse limite.

## 9. Nome dos arquivos

A ordem de preferência é:

1. nome presente no caminho da URL;
2. título ou rótulo associado ao elemento de vídeo;
3. título da página;
4. `video-AAAA-MM-DD-HHMMSS`.

Caracteres inválidos para Windows, nomes reservados, controles e espaços excedentes são removidos. Arquivos diretos preservam `.mp4`, `.webm` ou `.mov`. HLS sempre termina em `.ts`.

## 10. Estados da interface

O popup terá largura aproximada de 380 px e estes estados:

- inicial;
- solicitando acesso;
- analisando página;
- resultados;
- nenhum resultado;
- preparando HLS;
- enviado ao Chrome;
- permissão negada;
- mídia não suportada;
- erro de rede.

O CTA inicial é único. Após a busca, cada mídia tem sua própria ação de download. A ação **Buscar novamente** repete a varredura sob demanda.

Durante HLS, o item ativo mostra percentual, contagem de segmentos e uma barra de progresso. Uma segunda montagem HLS aguarda a primeira terminar. Mensagens de erro devem dizer o que ocorreu e qual ação o usuário pode tentar, sem códigos internos como texto principal.

## 11. Direção visual

O popup se apresenta como ferramenta de inspeção, não como um downloader chamativo.

- azul profundo `#101D30`: cabeçalho e contexto técnico;
- azul elétrico `#2F67E8`: ações primárias e foco;
- verde `#6FE2AE`: mídia detectada e confirmação;
- superfície `#F7F9FC`: plano principal;
- texto `#17253A`: conteúdo;
- borda `#DDE4ED`: separação.

A assinatura visual é um indicador circular de radar que passa de vazio para a contagem de mídias. A interface usa tipografia do sistema para reduzir peso e evitar carregamentos externos. Movimento fica restrito a transições rápidas de estado e respeita `prefers-reduced-motion`.

## 12. Acessibilidade

- contraste mínimo WCAG AA para texto e controles;
- foco de teclado claramente visível;
- alvos interativos de pelo menos 40 × 40 px;
- botões com nomes completos acessíveis;
- estados não dependem apenas de cor;
- status assíncronos usam uma região `aria-live` discreta;
- seletores de qualidade são operáveis por teclado;
- nenhuma animação é necessária para compreender ou usar o popup.

## 13. Testes e verificação

### 13.1 Testes automatizados

- detecção e classificação por extensão e MIME;
- normalização e deduplicação sem remover query strings;
- agrupamento conservador de variantes diretas;
- parser de master playlists e ordenação de qualidades;
- resolução de URLs relativas;
- rejeição de DRM/criptografia, fMP4, byte ranges e live HLS;
- montagem ordenada de segmentos baixados fora de ordem;
- limite de 1 GiB;
- sanitização de nomes;
- validação de mensagens entre popup, worker e offscreen;
- estados do popup, incluindo vazio, permissão negada e erro.

### 13.2 Fixtures locais

O projeto incluirá páginas e playlists pequenas para exercitar:

- MP4 direto;
- WEBM direto;
- MOV direto;
- múltiplos `<source>`;
- HLS master com 1080p, 720p e 480p;
- HLS de qualidade única;
- HLS não suportado para cada motivo explícito.

### 13.3 Verificação manual

- carregar a extensão descompactada em um navegador Chromium;
- confirmar que nenhuma permissão ampla é pedida na instalação;
- testar busca, estado vazio e busca repetida;
- baixar cada formato direto;
- escolher qualidades HLS diferentes e conferir o arquivo `.ts`;
- fechar o popup durante a preparação HLS e confirmar que a operação continua;
- negar permissões e validar a recuperação;
- navegar por todos os controles somente com teclado;
- inspecionar o popup em escala padrão e ampliada sem corte de texto.

## 14. Critérios de aceitação

A primeira versão está pronta quando:

1. pode ser carregada descompactada sem erros de manifesto;
2. não solicita acesso global a sites na instalação;
3. só pesquisa após o clique **Buscar vídeos nesta página**;
4. detecta e deduplica os formatos diretos definidos;
5. detecta HLS VOD MPEG-TS e oferece variantes disponíveis;
6. salva arquivos diretos com a extensão original e HLS como `.ts`;
7. continua preparando HLS após o popup ser fechado;
8. remove permissões opcionais transitórias após a operação;
9. mostra progresso por segmentos durante a montagem HLS;
10. mostra falhas suportadas com mensagens acionáveis;
11. passa nos testes automatizados e na verificação manual definida acima.
