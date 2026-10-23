# Auditoria e plano incremental

## Auditoria inicial — 21/10/2026

- A pasta continha apenas `README.md` (27.497 bytes), lido integralmente.
- `git status` informou que não havia repositório; não existiam branch ou histórico.
- Não havia código, testes, migrations, Compose ou instruções AGENTS preexistentes
  na pasta e nos diretórios ancestrais consultados.
- O README oficial foi preservado; comandos da implementação foram acrescentados
  ao final. SHA-256 do enunciado original antes desse acréscimo:
  `47795fce2fc38cae5f1b91368ebaf80b7a2ed1fe147f36704b665faf0613812e`.
- Git foi inicializado em `main`. Nenhum remoto foi configurado e não houve push.
- Bun não estava disponível no PATH; instalado localmente em `.tools/` (ignorado).
  Docker Compose está disponível; nenhum container foi iniciado nesta etapa.

## Comparação com o README — atualização após REFUND

| Requisito/seção | Antes | Estado atual | Evidência futura necessária |
|---|---|---|---|
| Bun, TS strict, Nest (§4) | Ausente | Implementado | Manter check passando |
| PostgreSQL, SQS, Compose, ORM e migrations (§4) | Ausente | Containers, MikroORM/Nest, migrations e mappers/repositórios validados | Operação nos ambientes alvo; principal ainda sem migrations financeiras |
| Money, Wallet, WagerTransaction, ledger (§6) | Ausente | Domínio e persistência implementados; CreateWallet com OPENING/ledger/Outbox atômicos | Demais casos de uso financeiros |
| BET/WIN/LOSS/REFUND/ROLLBACK (§7) | Ausente | Domínio completo; BET/WIN/LOSS/REFUND com Outbox, rejeição, pendências e snapshots históricos | ROLLBACK, reprocessador e entrada Inbox |
| Concorrência por wallet (§8) | Ausente | BET 80+80/saldo 100, 50 BETs, 50 WINs e 50 REFUNDs em 3 processos reais, LOSS e operações mistas validadas | Outros kinds e janelas de falha distribuída |
| API e replay original (§9) | Ausente | Apenas liveness | Todos os contratos, status e paginação |
| Inbox/SQS/ACK/DLQ/shutdown (§10) | Ausente | Modelo/schema/repositório Inbox e SQS local testados; sem consumer | Consumer, crash após commit antes de ACK, shutdown |
| Outbox e eventos (§11) | Ausente | Eventos v1 e Outbox persistente; abertura grava dois eventos na mesma transação | Dois publishers, crash e redelivery |
| Observabilidade (§12) | Ausente | Logs de startup JSON e liveness | Contexto completo, métricas e readiness |
| Integração/distribuição (§13) | Ausente | PostgreSQL/SQS reais; BET/WIN/LOSS/REFUND com replay, rollback e 3 processos Bun | Fluxos HTTP/SQS, kill-process e publishers |
| Documentação (§14) | Enunciado | Plano, arquitetura e guia | Atualização a cada funcionalidade |
| Autenticação (§2) | Ausente | Decisão proposta, sem endpoints financeiros | Porta de identidade explícita e desenho OIDC |

## Etapas e commits planejados

Cada linha é uma unidade de trabalho com documentação e testes próprios. Uma etapa
que cresça deve ser dividida; a mensagem é proposta, não registro de commit realizado.

| Ordem | Commit proposto | Entrega e validação antes do commit |
|---|---|---|
| 1 | `chore: initialize NestJS project with Bun` | Concluída: base HTTP, configuração estrita, teste real, build e guias |
| 2 | `chore: configure PostgreSQL and LocalStack` | Concluída em dois commits: PostgreSQL persistente e SQS FIFO/DLQ, com testes reais de reinício/recriação |
| 3 | `chore: configure MikroORM and reversible migrations` | Concluída em commits de integração Nest e migrations; demonstrações apenas em bancos descartáveis |
| 4 | `feat: implement immutable Money value object` | Concluída: decimal.js, escala 2, BRL/USD/EUR, precisão por operação e 73 testes de Money |
| 5 | `feat: implement immutable wallet ledger entries` | Concluída: create/rehydrate/isBalanced, estado imutável incluindo Date; 66 testes específicos |
| 6 | `feat: implement Wallet aggregate with balance invariants` | Concluída: abertura com ledger, debit/credit, versão/datas e rejeições sem efeitos; 81 testes específicos |
| 7 | `feat: implement wager transaction lifecycle and domain rules` | Concluída: factories, estados terminais, referências, direções e códigos; 151 testes específicos |
| 8 | `feat: enforce financial database constraints` | Concluída em 3 commits: migrations Wallet/Transaction/Ledger, constraints, permissões e integridade diferível; 34 testes SQL. Mapeamento/repositórios financeiros ficam para próxima autorização |
| 9 | `feat: define versioned integration events` | Concluída: classe abstrata, subclasses e envelopes com MoneyProps; serialização estável |
| 10 | `feat: persist transactional outbox records` | Concluída: modelos/repositórios Inbox/Outbox na mesma transação; publicação pendente |
| 11 | `feat: open and query wallets atomically` | Abertura concluída: OPENING/ledger/Outbox positivos, versão1; consultas públicas, controller e porta de identidade pendentes |
| 12 | `feat: persist wager idempotency and original results` | Implementado para BET/WIN/LOSS/REFUND: unicidade por provedor, JSON canônico, snapshot imutável; replay após recriar ORM. Adaptador/replay HTTP pendente |
| 13 | `feat: process BET with wallet-level locking` | Implementado: débito + ledger + status + Outbox + resultado atômicos; validações concorrentes na seção29 do guia |
| 14 | `feat: process WIN and LOSS transactions` | Concluído: crédito WIN/registro LOSS, referências pendentes ou rejeitadas, eventos e versões corretos; 62 testes PostgreSQL novos |
| 15 | `feat: process full REFUND reversals` | Concluída: referência integral, unicidade por tipo, pendência/rejeição e snapshots; 57 testes PostgreSQL novos |
| 16 | `feat: process ROLLBACK reversals` | Após autorização e decisão sobre interação REFUND/ROLLBACK: inversão de BET/WIN/REFUND e código para reversão sem saldo |
| 17 | `feat: expose wagering HTTP contracts` | DTOs, OPENING bloqueado, header obrigatório, erros consistentes, consultas e cursor opaco |
| 18 | `feat: implement transactional SQS inbox consumer` | Mesmo use case do HTTP, inbox na transação, ACK pós-commit, retry/DLQ e shutdown |
| 19 | `feat: publish outbox events with concurrent workers` | Reivindicação recuperável, backoff, eventId estável, dois publishers e crash após envio |
| 20 | `feat: reprocess pending transaction references` | Worker agendado, tentativas/TTL persistidos, resolução ou rejeição com evento |
| 21 | `feat: reconcile wallet balances against ledger` | Leitura consistente, diferença assinada, alerta sem correção silenciosa |
| 22 | `feat: add financial observability and readiness` | Logs correlacionados, métricas exigidas e probes PostgreSQL/SQS |
| 23 | `test: verify distributed concurrency and crash recovery` | ≥3 processos, wallets distintas, kill pós-commit/pré-ACK, reinício e reconciliação final |
| 24 | `docs: document setup guarantees and delivery evidence` | Setup reproduzível, comandos, matriz final de requisitos e limitações reais |

Os testes financeiros/distribuídos começam nas etapas que criam os riscos; a etapa
23 consolida a demonstração completa, não adia todas as validações até o fim.
Modelos de eventos e persistência Outbox precedem mutações financeiras para não
introduzir um fluxo que precise publicar diretamente ou perder eventos.

## Riscos e critérios eliminatórios

Os oito eliminatórios expressos no README são: dinheiro em `number`; saldo negativo
por corrida; débito/crédito duplicado; idempotência somente em memória; correção
restrita a uma instância; evento publicado antes do commit; ausência de ledger
auditável; PostgreSQL/SQS completamente substituídos por mocks.

| Risco | Como será enfrentado e comprovado |
|---|---|
| Read-calculate-update perde alteração concorrente | Lock por wallet no banco e teste real com apostas concorrentes |
| Replay consulta saldo atual em vez do original | Snapshot persistido do resultado e replay depois de outra movimentação |
| Dois identificadores externos ou keys contornam dedup | Unicidade separada e testes de colisão em entradas HTTP/SQS |
| Reversões cruzadas entre jogador/moeda/rodada | Validação completa da referência e integridade no schema |
| Deadlocks e hot wallets | Ordem estável de locks, transações curtas e retry limitado de falhas transitórias |
| Lock global esconde concorrência real | Testes de wallets distintas e ≥3 processos independentes |
| Falha depois de commit ou publicação | Outbox durável e consumidor idempotente; matar processo na janela crítica |
| FIFO esconde duplicata na demonstração | Variar dedup IDs e provocar redelivery, mantendo identidade de negócio |
| Mensagem venenosa bloqueia fila | Taxonomia de falhas, limite de retries e DLQ observável |
| Reconciliação vê dois instantes diferentes | Snapshot consistente ou mesmo lock; não comparar leituras incompatíveis |
| Constraints só existem na aplicação | Tentativas diretas de violação com papel SQL da aplicação |
| Metadata/decorators divergem entre TS e build | Exercitar aplicação real e saída compilada com Bun |

## Decisões aprovadas e pendências

Em 21/10/2026, o usuário aprovou **MikroORM + LocalStack + lock pessimista por
carteira no PostgreSQL**. Essas escolhas orientam as etapas 2, 3 e 13;
a infraestrutura das etapas 2 e 3 e os locks de repositório foram validados; aplicação aos casos de uso de apostas permanece pendente. A decisão e as alternativas
estão na ADR-003 de [ARCHITECTURE](../ARCHITECTURE.md).

Money exige exatamente duas casas e admite zero; entradas negativas são rejeitadas,
resultados matemáticos assinados são internos. Foram aprovadas precisão por operação
sem teto monetário nesta etapa e moedas BRL/USD/EUR (ADR-008). Antes dos contratos
financeiros/schema, decidir limites de payload/NUMERIC. Zero por operação e referências
opcionais foram definidos na etapa 7 (ADR-011). Concluir Money não autoriza implementar a etapa seguinte automaticamente.

Etapa 5 autorizada e concluída em 22/10/2026: WalletLedgerEntry reutiliza Money
sem alterações; ADR-009 documenta create vs rehydrate, cópias defensivas de Date e
constraints/índices futuros. Nenhuma migration financeira criada. Próxima etapa:
Wallet Aggregate Root, posteriormente autorizada na etapa 6 abaixo.

Etapa 6 autorizada e concluída em 22/10/2026: aprovação explícita de open retornar
Wallet + lançamento de abertura; versão 1 e null para abertura zero. ADR-010
registra confirmação local do estado, futuro OPENING atômico e limites de
concorrência. Money/WalletLedgerEntry não foram alterados. Próximo trabalho proposto:
WagerTransaction (kinds, transições, referências e failure codes); depois desenho
de persistência/mapeamento, constraints, transação/lock e testes SQL de violação.
Fechar ambiguidades de referências/zero e plano de escrita antes de migrations.
Nenhuma dessas etapas seguintes é iniciada automaticamente.

Também foi aprovado usar LocalStack Community anterior sem token, fixado por
versão/digest, após identificar a exigência de conta nas versões atuais. A ADR-005
documenta a imagem 4.14.0, o broker descartável e a perda de mensagens no restart
do emulador. Isso não é garantia de persistência do broker.


Etapa 7 autorizada e concluída em 22/10/2026: WagerTransaction mantém Money/Wallet/
WalletLedgerEntry intactos, implementa lifecycle e validação local de referências.
Aprovações: positivos exceto LOSS zero; WIN opcional ligado a BET processada;
markProcessed recebe entidade referenciada; transições sem retorno nem repetição
para PENDING_REFERENCE. ADR-011 explicita a ausência de garantia global de reversão
única e separa falhas persistidas de conflito de admissão. Sem controllers, banco
financeiro, consumers, Inbox/Outbox ou locks implementados.

Próxima etapa proposta: **desenho de persistência e constraints financeiras (8)**,
com decisão prévia sobre mapeamento, limites NUMERIC/payload, escopos de unicidade,
proteção de ledger/terminais e caminho de escrita atômico. Só implementar após nova
autorização. A política de retries/TTL e o snapshot de replay também permanecem
pendentes em suas etapas. Encerramos o desenvolvimento nesta funcionalidade.

Etapa 8 autorizada em 23/10/2026, em andamento: usuário aprovou limite monetário
(20,2) com NUMERIC/CHECK sem arredondar, idempotência por provedor e integridade
por triggers diferíveis com versão no ledger. Primeiro incremento: Wallet/DOMAIN,
constraints e privilégios. WagerTransaction e ledger/integridade virão nos próximos
commits desta etapa; ainda não são garantias entregues neste incremento.

Segundo incremento da etapa 8: schema de transações, unicidade por provedor,
referências pendentes/processadas, índices parciais e imutabilidade de input/terminais.
Validações locais SQL e disputa concorrente do índice testadas; integração com saldo
materializado e ledger será adicionada no terceiro incremento.


Etapa 8 concluída em três incrementos: 34 testes reais do schema financeiro, incluindo
correspondência de saldo/ledger/resultado, rollback, reversões únicas e duas conexões
concorrentes. Migrations testadas apenas em bancos descartáveis; principal intocado.
Ajuste de escopo explícito: EntitySchemas/mappers/repositórios não foram antecipados;
o teste de driver confirma dinheiro string, e o desenho de mapeamento está na ADR-012.
Próxima etapa recomendada, após autorização: mapeamento/repositórios financeiros e
unidade transacional com lock por wallet. Eventos e Outbox continuam necessários
antes de expor processamento com publicação; não saltar suas dependências no plano.

Etapa complementar à 8 autorizada: mappers, repositórios e unidade transacional com
lock. Primeiro incremento: mappers explícitos e roundtrip com PostgreSQL descartável,
sem mudanças nas entidades ou migrations. Repositórios, atomicidade via MikroORM e
concorrência ainda serão validados nos incrementos seguintes. Não autoriza endpoints,
processadores, Inbox/Outbox operacionais ou publicação.

Segundo incremento complementar à etapa8: portas e adaptadores financeiros SQL
parametrizados via EntityManager, conforme aprovação. Gravação explícita por movimento,
lookup com escopo do provedor, ledger só INSERT/SELECT, sessão/ownership e leitura com
FOR NO KEY UPDATE. Testes dos adaptadores usam transactional oficial em bancos
isolados. Próximo incremento nesta autorização: unidade transacional injetável e
provas concorrentes de espera/liberação/saldo atualizado, sem casos de uso públicos.

Terceiro incremento complementar à etapa8: MikroFinancialUnitOfWork injetável, fork
por operação, READ COMMITTED, transactional oficial e recusa de fronteiras aninhadas.
Atomicidade de abertura, erro de callback/commit diferível, descarte de objetos e
permissões validados em bancos descartáveis. Testes concorrentes observam bloqueio
no PostgreSQL e confirmam atualização do saldo após commit/rollback, avanço de wallet
diferente e compatibilidade com KEY SHARE. Implementação desta etapa encerrada; nenhuma
migration financeira aplicada ao principal e nenhum endpoint/consumer financeiro.

Próxima etapa recomendada, mediante nova autorização: contratos/eventos e desenho
transacional de Inbox/Outbox e seus repositórios na mesma fronteira, antes de expor
casos de uso financeiros com publicação. Política de tentativas/TTL, relay, replay
HTTP e tratamento completo da idempotência continuam pendentes. Não iniciados aqui.

Evidência final desta etapa: 483 testes distintos aprovados (424 aplicação/unitários,
15 persistência,34 schema,6 infraestrutura,2 ORM,2 migrations), typecheck/build OK.
Trabalho dividido em mappers, repositórios+operação de lock e unidade transacional+
provas concorrentes. Commits locais; sem push. As etapas seguintes continuam pendentes.

Etapa eventos/Inbox/Outbox autorizada: primeiro incremento implementa quatro eventos
v1 e envelope abstrato imutável. OPENING/aggregateId aprovados; nenhum publisher ou
consumer iniciado. Próximos incrementos desta autorização: modelos, schema e integração
transacional das mensagens, com testes descartáveis.

Segundo incremento: InboxMessage/OutboxMessage encapsulados, envelope validado,
retry1s→5min sem descarte automático (aprovado), datas defensivas e transições testadas.
Persistência entre instâncias ainda depende das tabelas/repositórios seguintes.

Terceiro incremento: migration00004 Inbox/Outbox, unicidade, validação JSONB, índice de
pendentes, lifecycle e permissões. Up/down/reaplicação testados em banco descartável;
principal preservado. Repositórios/unidade compartilhada serão validados a seguir.

Quarto incremento: Inbox/Outbox adicionadas às portas e à mesma FinancialSession.
Receive com UNIQUE/lock compara hash, distingue new/pending/processed; Outbox tem INSERT,
consulta pendente limitada/ordenada e update de lifecycle sob lock. Atomicidade das
cinco tabelas, replay após recriar ORM e disputas concorrentes testadas em PostgreSQL.
Nenhum publisher/consumer foi iniciado; listDue não é claim nem publicação.

Etapa eventos/Inbox/Outbox concluída:510 testes distintos aprovados, typecheck/build
OK, banco principal sem migrations e bancos descartáveis removidos. Próxima etapa
recomendada: caso de uso transacional de abertura de carteira (incluindo OPENING,
ledger e dois eventos Outbox), após autorização; depois admissão/processamento e
idempotência compartilhados por HTTP/SQS. Publishers/consumers operacionais exigem
suas próprias etapas e decisões, e não foram iniciados automaticamente.

Etapa CreateWallet autorizada: tratamento específico de conflito de unicidade
concluído em c73ff56. Caso de uso coordena Wallet.open/createOpening, ledger e dois
eventos na mesma UOW, com DTO entregue após commit; saldo zero não movimenta ledger.
Metadados internos de OPENING aprovados (ADR-020). Sem controller, Inbox, publicação,
processamento de apostas ou mudanças no schema. Testes reais isolados cobrem abertura,
limites, falhas e concorrência; fechamento da evidência consta na seção25 do guia.

Próxima etapa recomendada, somente após nova autorização: adaptador HTTP de criação
de carteira, tratamento dos erros/contrato e autenticação exigida pelo README. Decidir
previamente como atender a autenticação na exposição do endpoint e como preparar o
banco alvo, sem aplicar migrations ao principal automaticamente. Processamento de
apostas, publisher/consumer, replay HTTP e referências permanecem em etapas próprias.

Etapa CreateWallet concluída: **535 testes distintos aprovados**, typecheck/build OK.
Banco principal sem tabelas financeiras e nenhum banco dwp_test_* remanescente.
Nenhum push. As etapas seguintes continuam dependendo de nova autorização.

Etapa BET autorizada após CreateWallet: começa pela canonicalização de admissão
(seção26 do guia/ADR-021). Usuário aprovou snapshot imutável separado e versionado,
locks PostgreSQL por duas identidades antes da Wallet, erros de admissão para vínculos
inválidos e até 3 tentativas para40P01/40001. Persistência/replay, processamento, provas
concorrentes e rollback ainda serão implementados nos incrementos seguintes. Sem HTTP,
consumer/publisher, outros kinds ou alterações no banco principal.

Segundo incremento BET: migration00005 resultados imutáveis, mapper/repositório,
locks por identidade e portas na UOW. Up/down e regras SQL validados em descartáveis;
não há backfill fictício nem alteração de entidades. Processamento/replay serão
integrados no incremento seguinte; este suporte sozinho não executa apostas.

Terceiro incremento: ProcessWagerTransaction BET, replay persistente, rejeição por
saldo insuficiente, erros de admissão, retry limitado de 40P01/40001 e composição Nest.
Testes reais de sucesso/rejeição, histórico/restart, rollback e fronteira externa.
Ainda sem outros kinds, HTTP, consumer/publisher ou migrations no principal.

Etapa BET concluída: **601 testes distintos aprovados**, typecheck/build OK. Inclui
50 chamadas em três processos Bun reais, replay histórico e disputa de saldo 80+80
contra 100. Banco principal sem tabelas financeiras; bancos descartáveis removidos.
Nenhum push. Próxima etapa recomendada: WIN/LOSS pelo mesmo fluxo, após autorização.
HTTP, consumer/publisher e demais operações continuam fora da entrega atual.

Etapa WIN/LOSS autorizada: primeiro incremento compartilha canonicalização sem mudar
hashes BET. Aprovados comprovante separado de pendência, rejeição auditável de referência
inválida e rejeição de overflow do saldo. Persistência, processamento, testes reais e
concorrência serão concluídos nesta etapa; worker de referências permanece fora dela.

Segundo incremento WIN/LOSS: migration00006 e repositório de comprovantes, ampliação
de snapshots terminais, permissões/imutabilidade e downgrade protegido. Testes reais
em descartáveis cobrem up/down/reaplicação, consistência e rollback no commit.
Processamento de WIN/LOSS ainda será integrado; nenhuma migration aplicada ao principal.

Terceiro incremento WIN/LOSS: ProcessWagerTransaction compartilhado, crédito/registro
sem movimento, referências opcionais/pendência/rejeição, snapshots/replay histórico e
atomicidade. 29 testes funcionais e 15 rollback novos executados em PostgreSQL. Worker
não implementado; teste simula apenas a transição futura por entidades/repositórios.
Próximo incremento desta autorização: concorrência real e fechamento de regressões.

Etapa WIN/LOSS concluída: **678 testes distintos aprovados**, typecheck/build OK,
62 testes PostgreSQL novos e 77 novos no total. WIN duplicada 50 vezes em 3 processos
Bun → 1 crédito/49 replays; LOSS/pendência duplicadas 20 vezes → 1 registro/evento cada.
Rejeições, replay histórico, referências fora de ordem, rollback e reconciliação
validados. Principal permanece sem tabelas financeiras; nenhum dwp_test_* remanescente.
Commits locais, sem push. Próxima etapa recomendada: REFUND e ROLLBACK, após autorização.
Worker de referências, HTTP, consumers, publishers e políticas operacionais não foram
iniciados. O desenvolvimento desta etapa foi encerrado.

Etapa REFUND autorizada: primeiro incremento estende entrada canônica e decisão
local de duplicidade por evidência persistida. Sem alterar hashes anteriores ou
ativar ROLLBACK. Repositório, snapshots e processamento transacional virão a seguir.
Interação futura REFUND/ROLLBACK exige decisão antes da etapa16, preservando índice
por referência/tipo e evitando supor proteção cruzada que ele não oferece.

Segundo incremento REFUND: migration00007 compatível, lookup do reembolso processado
e mapper de DUPLICATE_REVERSAL. Quatro testes PostgreSQL reais de preservação/up/down,
respostas obrigatórias, lookup e proteção definitiva por UNIQUE. Integração no caso de
uso e provas de concorrência ainda serão concluídas nesta autorização.

Terceiro incremento REFUND: integrado no ProcessWagerTransaction compartilhado,
com crédito integral, rejeição de duplicidade/overflow, referência pendente ou inválida,
replay e snapshots. Os 29 testes funcionais e 15 de rollback usam PostgreSQL real.
Nenhum worker iniciado; um teste compõe manualmente a conclusão futura para provar
que receipt e resultado terminal coexistem. Fechamento de concorrência e regressões
permanece no último incremento desta autorização.

Etapa REFUND concluída: **751 testes distintos aprovados**, typecheck/build OK.
São 73 testes novos: 16 unitários e 57 PostgreSQL. Dois reembolsos diferentes da mesma
BET serializam: um sucesso e uma rejeição, ou um sucesso se o primeiro abortar. Um
writer SQL direto foi barrado pelo UNIQUE após esperar o commit. Cinquenta chamadas
em três processos Bun geraram um crédito e 49 replays. Carteiras independentes,
referência concorrente, falhas e histórico foram reconciliados com ledger.

PostgreSQL/LocalStack saudáveis após testes reais de restart/recriação; principal com
zero tabelas públicas e nenhum banco descartável remanescente. Enunciado preservado;
nenhum push. Próxima etapa sugerida: ROLLBACK, só após autorização e definição das
sequências permitidas com REFUND; a unicidade por tipo não oferece exclusão cruzada.
HTTP, consumer, publisher, worker de referências e autenticação continuam pendentes.


Missão final autorizada em 23/10/2026: avançar por todas as fases restantes, com
commits e validações por fase. A auditoria operacional está em DELIVERY_CHECKLIST.md.
Fase1 integra ROLLBACK e proteção cruzada persistente; não requer novo prompt para
prosseguir ao worker, API, consumer/publisher e validação final. Esta autorização
substitui as pausas históricas descritas acima, sem autorizar destruição do principal.
