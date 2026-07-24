# Destino unificado de downloads

Data: 2026-07-24  
Status: aprovado

## Objetivo

Oferecer uma única configuração de destino para vídeos diretos, HLS e YouTube:

- uma pasta padrão absoluta, escolhida pelo seletor nativo do Windows;
- uma opção **Perguntar onde salvar cada download**;
- comportamento automático e consistente quando a pergunta estiver desativada;
- preservação segura do arquivo quando a entrega à pasta final falhar.

## Experiência de configuração

A página **Destino dos downloads** terá dois controles:

1. **Pasta padrão**
   - mostra o caminho absoluto atual;
   - oferece o botão **Alterar pasta padrão…**;
   - o botão solicita ao auxiliar nativo que abra o seletor de pastas do Windows;
   - cancelar o seletor mantém a configuração anterior;
   - sem uma escolha explícita, o fallback é `%USERPROFILE%\Downloads\Video Radar`.
2. **Perguntar onde salvar cada download**
   - fica ativada por padrão em novas instalações;
   - quando ativada, a pasta padrão permanece salva, mas é ignorada naquele download;
   - quando desativada, todos os tipos de vídeo usam automaticamente a pasta padrão.

As preferências ficam em `chrome.storage.local`. O esquema novo terá versão explícita e os campos:

```text
schemaVersion: 2
askEveryTime: boolean
defaultFolder: string | null
```

Preferências antigas serão migradas sem perder o modo anterior: `automatic: true` vira
`askEveryTime: false`; `automatic: false` vira `askEveryTime: true`. A antiga subpasta
relativa não será convertida em caminho absoluto; o fallback seguro será usado até o
usuário escolher outra pasta.

## Fluxos de download

### Modo perguntar

- **Diretos e HLS:** usam `chrome.downloads.download` com `saveAs: true`; o navegador
  mostra seu diálogo **Salvar como**.
- **YouTube:** antes de iniciar, a extensão solicita ao auxiliar o seletor de pastas do
  Windows. O caminho escolhido vale somente para esse download. Cancelar não inicia o
  trabalho.

### Modo automático

- **YouTube:** o caminho padrão é enviado ao auxiliar e o `yt-dlp` grava diretamente
  nessa pasta.
- **Diretos e HLS:** o navegador baixa primeiro para uma área de preparação relativa à
  pasta Downloads, em `Video Radar/.staging/<operação>/`. Ao concluir, o auxiliar move
  o arquivo para a pasta padrão.

Antes de iniciar um download direto/HLS automático, a extensão confirma que o auxiliar
está disponível. Se não estiver, não inicia um trabalho que não possa ser entregue e
orienta o usuário a reinstalar o auxiliar ou ativar **Perguntar onde salvar**.

O acompanhamento da movimentação será persistido em `chrome.storage.local`, associado
ao `downloadId`, para sobreviver ao fechamento do popup, suspensão do service worker e
reinício do navegador. A conclusão remove apenas o registro correspondente.

## Contrato com o auxiliar nativo

O protocolo ganhará operações pequenas, sem transportar os bytes do vídeo:

- `chooseDownloadFolder`: abre o seletor do Windows e retorna `selected` com caminho
  absoluto ou `cancelled`;
- `moveDownloadedFile`: recebe o caminho absoluto do arquivo de preparação e a pasta
  final;
- `startDownload`: passa a aceitar a pasta final do trabalho do YouTube;
- `ping`: continua sendo usado para verificar disponibilidade e compatibilidade.

O auxiliar nunca recebe blobs HLS nem o conteúdo completo por Native Messaging. O
navegador mantém o transporte de diretos/HLS e o auxiliar cuida somente da entrega
final.

## Regras de segurança para arquivos

- A pasta final deve ser absoluta, normalizada e não pode conter segmentos `.` ou `..`.
- O auxiliar cria a pasta quando possível e confirma acesso de escrita antes do
  download.
- Um arquivo recebido por `moveDownloadedFile` deve ter a estrutura canônica
  `<Downloads do navegador>\Video Radar\.staging\<operação>\<arquivo>`. O auxiliar
  valida os segmentos fixos, o identificador opaco da operação e o nome final; ele não
  presume que a pasta Downloads configurada no navegador seja a pasta conhecida do
  Windows.
- A origem deve existir, ser um arquivo comum e não pode atravessar links ou pontos de
  nova análise.
- Conflitos de nome são resolvidos com sufixos (`arquivo (1).ts`) sem sobrescrever.
- No mesmo volume, a entrega usa movimentação atômica. Entre volumes, usa cópia para
  arquivo temporário na pasta final, renomeação e só então remove a origem.
- Uma falha nunca apaga o arquivo de preparação.

## Estados e mensagens

- Cancelar qualquer seletor retorna ao estado pronto, com **Download cancelado**.
- Pasta padrão ausente, removida ou sem permissão bloqueia o início e oferece
  **Alterar pasta padrão…**.
- Falha ao mover mantém o arquivo na preparação e mostra seu caminho recuperável.
- Após uma movimentação concluída, o popup mostra o caminho final.
- O histórico do navegador pode continuar apontando para o caminho temporário; a
  extensão exibirá o caminho final como fonte de verdade.

## Interface

A página de opções preserva o sistema visual navy/azul/verde existente. A primeira
seção mostra a pasta padrão e o botão do seletor; a segunda contém a única opção de
comportamento. Não haverá campos manuais de caminho nem configurações separadas por
tipo de vídeo.

O popup mantém o link **Configurar downloads**. Erros de destino usam as mensagens e
estados existentes, com uma ação direta para abrir a configuração quando necessário.

## Verificação

- testes JavaScript da migração e validação das preferências;
- testes do roteamento `saveAs` versus preparação automática;
- testes de persistência e retomada da movimentação por `downloadId`;
- testes do protocolo e coordenador YouTube com destino por trabalho;
- testes .NET do seletor abstraído, validação da raiz, conflitos, movimentação no mesmo
  volume, cópia entre volumes e preservação em falhas;
- preflight da extensão e pacote do auxiliar;
- teste visual da página de opções em largura desktop e estreita;
- cenários manuais: direto, HLS e YouTube nos modos perguntar e automático.

## Fora de escopo

- alterar a pasta Downloads global do Chrome, Edge, Brave ou Vivaldi;
- transportar arquivos grandes pelo canal Native Messaging;
- DRM, conteúdo privado ou qualquer ampliação de acesso a cookies e credenciais;
- sincronizar a preferência entre diferentes computadores.
