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

## Comparação com o README — atualização após schema financeiro

| Requisito/seção | Antes | Estado atual | Evidência futura necessária |
|---|---|---|---|
| Bun, TS strict, Nest (§4) | Ausente | Implementado | Manter check passando |
| PostgreSQL, SQS, Compose, ORM e migrations (§4) | Ausente | Containers, MikroORM/Nest e migrations oficiais up/down validados | Mapeamento financeiro e casos de uso futuros |
| Money, Wallet, WagerTransaction, ledger (§6) | Ausente | Domínio implementado; schema financeiro versionado e testado em bancos descartáveis | Casos de uso, mapeamento e atomicidade com Inbox/Outbox |
| BET/WIN/LOSS/REFUND/ROLLBACK (§7) | Ausente | Kinds, lifecycle, referências e direções locais implementados | Casos de uso e processamento com Inbox/Outbox |
| Concorrência por wallet (§8) | Ausente | Pendente | Corridas em ≥3 processos |
| API e replay original (§9) | Ausente | Apenas liveness | Todos os contratos, status e paginação |
| Inbox/SQS/ACK/DLQ/shutdown (§10) | Ausente | Pendente | Crash após commit antes de ACK |
| Outbox e eventos (§11) | Ausente | Pendente | Dois publishers, crash e redelivery |
| Observabilidade (§12) | Ausente | Logs de startup JSON e liveness | Contexto completo, métricas e readiness |
| Integração/distribuição (§13) | Ausente | HTTP e infraestrutura reais; 2 testes PG e 4 SQS | Atomicidade financeira e ≥3 instâncias |
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
| 9 | `feat: define versioned integration events` | Classe abstrata, subclasses e envelopes com MoneyProps; serialização estável |
| 10 | `feat: persist transactional outbox records` | Modelo/repositório de Outbox e gravação dentro da mesma transação SQL; sem publicação ainda |
| 11 | `feat: open and query wallets atomically` | Abertura + OPENING/ledger para saldo positivo, version=1, consultas e porta de identidade |
| 12 | `feat: persist wager idempotency and original results` | Unicidade key e identidade externa, JSON canônico e snapshot; colisões e restart |
| 13 | `feat: process BET with wallet-level locking` | Débito + ledger + status + outbox atômicos; 50 replays e 2 apostas de 80 sobre saldo 100 |
| 14 | `feat: process WIN and LOSS transactions` | Crédito e resultado sem movimento; eventos e version corretos |
| 15 | `feat: process full REFUND reversals` | Mesma referência completa, uma vez por tipo, valores iguais e pendência persistida |
| 16 | `feat: process ROLLBACK reversals` | Inversão de BET/WIN/REFUND e código específico para reversão sem saldo |
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
a infraestrutura das etapas 2 e 3 foi validada; locks financeiros permanecem pendentes. A decisão e as alternativas
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
