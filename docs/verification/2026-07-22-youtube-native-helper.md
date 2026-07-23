# Verificação proporcional — auxiliar nativo do YouTube

Data: 2026-07-22  
Branch: `codex/video-radar`  
Base: `70d2dc60bf870ca9a6d26cf4435a4e391ee5a8f9` (`build: package windows native helper`)  
Commits de implementação anteriores no branch: `fc5db84` a `70d2dc6`; o commit desta documentação é registrado ao final da tarefa.

## Escopo e limite da evidência

Esta verificação cobre o contrato estático da extensão, testes JS/nativos e evidências já obtidas de pacote e renderização. Ela **não é uma aprovação final E2E**. O instalador não foi executado: HKCU e `%LOCALAPPDATA%` não foram alterados. Nenhum vídeo real do YouTube foi baixado, pois não foi fornecida uma URL própria/autorizada.

| Evidência automatizada | Comando | Resultado |
| --- | --- | --- |
| Preflight da extensão | `node --test test/extension-preflight.test.js` | PASSOU — 6 testes; manifesta permissões/ID, imports locais, limites de host, lock, scripts e documentação. |
| Suite JS anterior (Task 10) | `npm run check` | PASSOU — 165/165 testes JS naquele momento. |
| Verificação integrada desta tarefa | `npm run check:all` | PASSOU — executado uma vez nesta tarefa; validação estática, testes JS e testes do host nativo. |
| Integridade de diff | `git diff --check` | PASSOU — sem whitespace error. |

Os testes nativos exercitam fixtures para HLS/direto, parsing de formatos, validações de URL/metadata, falhas sem vazar stderr, limpeza de temporários e cancelamento do processo. Não usam um vídeo real.

## Evidências de pacote já obtidas

O pacote real `dist/video-radar-helper` foi montado e permanece ignorado pelo Git. O `extension-id.txt` informou `cakpfifpfmbdcilimpedanglnopnmckg`; o `package-manifest.json` tinha 10 payloads com hashes e tamanhos, totalizando 479941291 bytes. O `host --ping` retornou exit code 0 e um único JSON com `ok: true` e as quatro ferramentas presentes.

| Ferramenta | Versão/asset | SHA-256 (prefixo/sufixo) |
| --- | --- | --- |
| yt-dlp | `2026.07.04`, asset `466665334` | `52fe…24b8` |
| Deno | `v2.9.3`, asset `478036058` | `6034…df3a` |
| FFmpeg | asset `486135048` | `947e…b7dfc` |

Havia quatro arquivos de licença no pacote. Esta documentação não repetiu o empacotamento nem realizou download.

## Renderização do popup já observada

O popup foi renderizado por controlador de navegador em 380×980. `innerWidth`, largura de scroll do body e client width eram 380; uma qualidade determinada foi mostrada como 62% com valor, a qualidade desconhecida não tinha valor; Cancelar estava habilitado; o caminho ficou contido; foco sólido tinha 3 px; com reduced motion, `animation` era `none` e `transition` era `0`. Isso é renderização real do popup, não E2E de extensão Chrome.

## Matriz manual pendente

| Cenário | Status | Razão / limite | Expected | Observed |
| --- | --- | --- | --- | --- |
| Auxiliar ausente real no popup | PENDENTE | Instalador/registry não executados. | Erro orienta instalar e recarregar. | |
| Listar formatos de URL autorizada real | PENDENTE | Nenhuma URL autorizada foi fornecida. | Qualidades públicas aparecem. | |
| Baixar qualidade selecionada real | PENDENTE | Nenhuma URL autorizada foi fornecida. | Arquivo chega a `%USERPROFILE%\Downloads\Video Radar`. | |
| Fechar/reabrir popup durante trabalho real | PENDENTE | Requer extensão instalada e download autorizado. | Snapshot mostra progresso após reabrir. | |
| Merge real de áudio/vídeo | PENDENTE | Requer URL autorizada e ferramentas instaladas. | Saída combinada reproduzível. | |
| Notificação final real | PENDENTE | Requer extensão instalada e download autorizado. | Notificação de conclusão/erro é apresentada. | |
| Cancelar | PASSOU (automatizado) | Testes do host cancelam árvore de subprocessos Windows e removem temporários em boundary fake; não é UI E2E. | Processo filho e temporários desaparecem. | Automatizado. |
| HLS e mídia direta | PASSOU (automatizado) | Fixtures/regressões JS cobrem descoberta e HLS. | Detecção/fluxos preservados. | Automatizado. |
| URL restrita/autenticação simulada | PASSOU (automatizado) | Testes de validação/erro do host usam fixtures/fakes; não é YouTube ao vivo. | Entrada insegura ou metadata privada é recusada sem vazar detalhe. | Automatizado. |

## Como completar a validação manual

1. Com uma URL pública própria/autorizada, gere ou obtenha o pacote e carregue a pasta da extensão no Chrome, Edge, Brave ou Vivaldi.
2. Execute `Instalar-Video-Radar.cmd` **de dentro de** `dist\video-radar-helper`; recarregue a extensão.
3. Primeiro abra o popup sem o auxiliar (ou antes de instalá-lo) e registre o texto do erro; então instale/recarregue e confirme recuperação.
4. Busque formatos, escolha uma qualidade, inicie o download, feche/reabra o popup, cancele uma segunda tentativa e confira o diretório de destino.
5. Para formatos separados, confirme merge e a notificação final. Preencha as colunas Expected/Observed da matriz, incluindo navegador, URL autorizada (ou identificador não sensível), horário e resultado.

Status da documentação: **DONE_WITH_CONCERNS** — as lacunas E2E acima dependem da execução voluntária do instalador e de uma URL autorizada do usuário; não bloqueiam o registro honesto desta verificação proporcional.
