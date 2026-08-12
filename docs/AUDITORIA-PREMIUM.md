# Auditoria técnica e roadmap premium

Data da revisão: 12 de agosto de 2026
Versão preparada: 1.2.0

## Resumo executivo

O Video Radar 1.2.0 foi endurecido como um produto local, sob demanda e voltado
a mídia pública ou autorizada. A revisão cobriu a extensão Manifest V3, o
processamento HLS, o host Native Messaging em .NET, a entrega de arquivos, o
instalador e a cadeia de release.

Os riscos de maior prioridade encontrados foram corrigidos: processos nativos
órfãos, operações sem idempotência, perda de estado entre service workers,
permissões temporárias sem dono, arquivos presos em staging, HLS com áudio
separado silenciosamente descartado, consultas HLS distintas colapsadas, scans
sem limites e artefatos de release não reprodutíveis.

O resultado é uma base adequada para validar a Desktop Edition 1.2.0 em Windows.
Assinatura Authenticode, testes do instalador em uma máquina Windows limpa e uma
eventual Store Edition são gates externos, não características já publicadas.
A fila durável, pausa/retomada, reconciliação após reinício, validação com
`ffprobe`, diagnóstico local, catálogo rico e payload ARM64 já fazem parte do
código da v1.2; isso não significa que um instalador assinado já foi publicado.

## Escopo suportado

- Arquivos diretos MP4, WebM e MOV encontrados na aba ativa.
- HLS finito MPEG-TS, sem criptografia, byte ranges ou faixa de áudio externa,
  com limite de montagem de 256 MiB.
- Páginas públicas individuais do YouTube, TikTok, Instagram e X processadas
  pelo host local, sem cookies, perfil do navegador, `netrc` ou login.
- Windows 11 x64/ARM64 e Windows 10 Enterprise/IoT LTSC x64 ainda suportado pelo
  .NET 10; Chromium 116 ou superior.

Ficam explicitamente fora do escopo: DRM, conteúdo privado ou autenticado,
restrição de idade, transmissões ao vivo e qualquer uso sem autorização do
titular.

## Melhorias implementadas

| Área | Problema encontrado | Implementação 1.2.0 |
| --- | --- | --- |
| Estado Manifest V3 | Jobs e handoffs podiam ficar órfãos após reinício ou falha de persistência | Intenções duráveis, reconciliação ao acordar, keepalive somente durante trabalho real e eventos terminais preservados |
| Fila nativa | Um único snapshot não representava vários pedidos nem sobrevivia com segurança à troca do host | Fila FIFO por usuário, um worker ativo, limite de 32 trabalhos não terminais e 64 entradas totais, com substituição atômica por trabalho e leases de mutação/execução |
| Pausa e reinício | Cancelar o processo descartava o progresso e um reboot deixava estado `running` abandonado | Pausa preserva `.part`; retomada usa `--continue --part`; na próxima conexão do navegador, runner abandonado volta à fila e item pausado permanece pausado. Um manifesto atômico conserva o stem final e permite revalidar/concluir o mesmo arquivo após queda durante a movimentação ou o `ffprobe`, sem daemon e sem apagar nomes fora do trabalho |
| Integridade da mídia | Exit code zero do extrator podia aceitar arquivo vazio, container incoerente ou streams ausentes | Gate final de até 30 s com `ffprobe`, limites de output e validação de arquivo, container, streams, duração e tamanho plausíveis; saída rejeitada é removida com `MEDIA_VALIDATION_FAILED` |
| Catálogo e seleção | A escolha mostrava basicamente altura/container e não expunha áudio ou legenda | Catálogo limitado com áudio M4A, legendas manuais/automáticas VTT e metadados opcionais de fps, HDR/faixa dinâmica, codecs, bitrate, idioma de áudio e tamanho exato/estimado |
| Suporte | Diagnosticar instalação exigia troca manual de dados potencialmente sensíveis | Painel de saúde e logging opt-in; eventos/códigos estritamente estruturados, oito logs de 256 KiB, exclusão local e ZIP explícito sem URL, cookie, caminho de mídia ou `stderr` |
| Windows ARM64 | O pacote existia somente para PCs Intel/AMD | RIDs, lock, ferramentas, ZIP e instalador separados para x64/ARM64, checagem PE fail-closed e smoke dos artifacts exatos em `windows-latest` e `windows-11-arm`: ZIP, host, quatro ferramentas, instalação silenciosa, registro e desinstalação; apenas o loader Inno do Setup ARM64 é x64 emulado |
| Entrega de arquivos | Perda de ACK podia duplicar arquivo ou transformar sucesso em falha | `operationId`, journal durável, commit idempotente, SHA-256 na recuperação e pareamento download/intenção 1:1 |
| Permissões HLS | Grant podia sobreviver sem ledger ou ser removido de outro fluxo | Claim antes do prompt, heartbeat, confirmação pós-grant, leases duráveis e remoção verificada por `contains()` |
| HLS | Qualidades com query eram colapsadas; resolução era exigida; áudio externo podia gerar vídeo mudo | Query preservada, `RESOLUTION` opcional, detecção de `EXT-X-MEDIA` e rejeição segura de mídia ainda não suportada |
| Desempenho HLS | Manifestos, segmentos e montagem podiam crescer sem orçamento | Limites de bytes, linhas, variantes, segmentos, duração e 256 MiB; timeout com aborto real e concorrência limitada |
| Descoberta | DOM, performance entries e snapshots podiam crescer sem limite | Caps por tipo, priorização, payload limitado e LRU global medido em bytes UTF-8 |
| Host nativo | Timeout abandonava a espera mas mantinha `yt-dlp` ativo | Cancelamento compartilhado por observadores, hard timeout e encerramento da árvore pelo Windows Job Object |
| Rede/processos | Output ilimitado, retries vagos e progresso excessivo | Buffers bounded, linhas limitadas, socket timeout, retries/backoff finitos e coalescing de progresso |
| Espaço em disco | Download podia iniciar em volume indisponível ou sem margem | Preflight de volume/espaço e erros seguros `STORAGE_UNAVAILABLE` e `DISK_SPACE_LOW` |
| Protocolo nativo | Framing inválido podia desalinhar a conexão e upgrades eram frágeis | Framing fatal, escritas atômicas, protocolo v5, capabilities, validação estrita dos envelopes e troca transacional do runtime com rollback sem mover fila, parciais ou diagnósticos |
| Release | Assets rolling expiravam; ações e bootstrap não eram integralmente fixados | Snapshot mensal do FFmpeg, SDK .NET exato com SHA-512, ferramentas por asset ID/tamanho/SHA-256 e actions por commit |
| Integridade | Release podia ficar pública parcialmente e checksum vinha no mesmo canal | Draft idempotente, verificação exata dos assets, SBOM SPDX 2.3, provenance/SBOM attestations e CodeQL |
| Privacidade | Incógnito poderia compartilhar estado e o contrato não era explícito | Incógnito desabilitado, CSP explícita e documentação do uso local, retenção e sem telemetria |

## Evidência de qualidade

- Preflight estático e suíte JavaScript cobrem protocolo v5, catálogo rico,
  reconciliação da fila, popup e diagnóstico; os totais são emitidos pelo
  `npm run check` da revisão para não manter uma contagem manual desatualizada.
- Contrato de release 1.2.0 aprovado e diff sem erros de whitespace.
- Host e testes compilados para `win-x64` e `win-arm64` com .NET SDK 10.0.400:
  zero erros e zero avisos.
- Publish self-contained/single-file do host concluído para os dois RIDs.
- IDs, tamanhos e digests dos seis assets nativos conferidos com as releases
  oficiais fixadas.

A suíte funcional completa do host, o instalador Inno e os browsers reais ainda
devem rodar no workflow Windows antes da publicação. A compilação Linux
cross-target não substitui APIs de Shell, registro, Authenticode e Job Objects do
Windows.

## Gates para uma entrega comercial confiável

1. Executar CI e smoke E2E em Windows limpo: instalar, conferir registro e
   manifesto, carregar a extensão, testar fixture local, fila cheia,
   pausa/retomada, reboot e reconexão, rejeição do `ffprobe`, exportação de
   diagnóstico, cancelamento, upgrade e desinstalação em x64 e ARM64.
2. Assinar host, setup e desinstalador com Authenticode e timestamp; regenerar
   hashes e attestations depois da assinatura.
3. Fazer revisão das obrigações de redistribuição das ferramentas de terceiros,
   especialmente o build GPL do FFmpeg, antes de monetizar.
4. Manter a Desktop Edition fora da Chrome Web Store enquanto facilitar
   downloads do YouTube. Uma Store Edition precisa de pacote, ID, listing e
   conjunto de recursos separados, sem esse fluxo.

## Depois da 1.2

As próximas decisões devem ser guiadas por testes em hardware Windows real. A
v1.2 executa deliberadamente apenas um trabalho nativo por vez; aumentar a
concorrência exigiria orçamento de CPU, disco, banda e isolamento por volume.
Escolha explícita de idioma da faixa de áudio, legendas incorporadas ao container
e testes de fault injection do rollback em hardware x64/ARM64 também permanecem
candidatos futuros. A
eventual edição Edge Add-ons/Chrome Web Store continua condicionada às políticas
de cada loja e deve ter pacote, ID e recursos separados.

Esses candidatos não são promessas da versão 1.2.0. O escopo implementado
continua limitado a mídia pública ou autorizada, sem DRM, login, cookies ou
credenciais do perfil do navegador.

## Referências primárias

- [Políticas da Chrome Web Store](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Motivos comuns de rejeição da Chrome Web Store](https://developer.chrome.com/docs/webstore/troubleshooting)
- [Distribuição de extensões Chrome](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)
- [Lifecycle de service workers de extensões](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [RFC 8216 — HTTP Live Streaming](https://datatracker.ietf.org/doc/html/rfc8216)
- [Documentação do yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [Segurança no GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use)
- [Artifact attestations](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)
- [Assinatura Authenticode e timestamp](https://learn.microsoft.com/windows/win32/seccrypto/time-stamping-authenticode-signatures)
- [Termos de Serviço do YouTube no Brasil](https://www.youtube.com/static?gl=BR&hl=pt&template=terms)
