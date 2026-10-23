# Matriz final de requisitos e evidências

Auditoria local de 23/10/2026, base da missão `1d48b8b`. O README oficial foi preservado;
apenas a seção “Implementação do candidato” mudou. Estados usados:
**IMPLEMENTADO E TESTADO**, **IMPLEMENTADO, MAS SEM TESTE INTEGRADO**, **PENDENTE**.
A avaliação abaixo não atribui pontos à própria solução nem garante ausência de bugs.

| Requisito oficial | Implementação | Teste / evidência executada | Resultado |
|---|---|---|---|
| Bun 1.x, TypeScript strict, NestJS, MikroORM, Compose | package/tsconfig/AppModule/Compose | instalação limpa, lint, typecheck, build e API compilada real | IMPLEMENTADO E TESTADO |
| Money sem float, moedas e escala | Money decimal.js, transporte string, NUMERIC+CHECK | test/money.test.ts, financial-wallet/wager/ledger | IMPLEMENTADO E TESTADO |
| Wallet Aggregate Root, transições e ledger imutável | domínio encapsulado, rehydrate, factories, grants/triggers | unidade e financial/persistence | IMPLEMENTADO E TESTADO |
| OPENING positiva atômica; zero sem movimento | CreateWallet, OPENING/CREDIT/Outbox | wallet-creation25 | IMPLEMENTADO E TESTADO |
| BET/WIN/LOSS/REFUND/ROLLBACK | núcleo ProcessWagerTransaction comum | bet40, wager62, refund57, rollback14 | IMPLEMENTADO E TESTADO |
| Referências, integralidade, vínculos e compensação única | domínio + UNIQUEs + lock de carteira | rollback, refund, wager, distributed | IMPLEMENTADO E TESTADO |
| Concorrência sem lock global, saldo não negativo | advisory locks por identidade + FOR UPDATE Wallet | três APIs:50duplicatas;80+80;carteira independente;reversões concorrentes | IMPLEMENTADO E TESTADO |
| Idempotência persistente por provedor | duas UNIQUEs, SHA256 canônico, snapshots imutáveis | replay histórico/restart, payload conflitante, concorrência | IMPLEMENTADO E TESTADO |
| Wallet/Ledger/Transaction/Inbox/Outbox atômicos | EM transactional, triggers diferíveis | messaging14, testes rollback em BET/WIN/REFUND, consumer | IMPLEMENTADO E TESTADO |
| Todos endpoints §9 e status distintos | FinancialController, validation/filter, FinancialQueries | API5 via HTTP real, distributed via três servidores | IMPLEMENTADO E TESTADO |
| Ledger paginado com cursor estável | keyset por wallet_version, cursor vinculado à wallet | api.test.ts páginas, limites e cursor inválido | IMPLEMENTADO E TESTADO |
| SQS FIFO e DLQ obrigatórias | Compose/provision.py, redrive5 | infra6, consumer5, mensagens reais | IMPLEMENTADO E TESTADO |
| Consumer, Inbox, hash, ACK depois do commit | ConsumeWager + UOW + DeleteMessage | duplicatas, conflitos, falha pré-commit, SIGKILL pós-commit/pré-ACK, redelivery | IMPLEMENTADO E TESTADO |
| Publisher múltiplo e recuperação | OutboxDispatch lease/token, PublishOutbox, fila events | publisher3, dois processos em distributed, SIGKILL pós-envio/pré-marcação | IMPLEMENTADO E TESTADO |
| Publicação duplicada segura | eventId estável + Inbox persistente downstream | publisher: duplicata forçada, um efeito e saldo inalterado | IMPLEMENTADO E TESTADO |
| Referências fora de ordem e expiração | jobs duráveis, SKIP LOCKED, resolver compartilhado | references 9: WIN/REFUND/ROLLBACK, TTL, retry, crash/restart | IMPLEMENTADO E TESTADO |
| Reconciliação consistente e diagnóstico | lock Wallet, soma/chain/versões/vínculos, sem UPDATE | API: consistência e corrupção controlada só no descartável | IMPLEMENTADO E TESTADO |
| JSON logs, IDs, métricas, live/ready | observability, MetricsController, worker-runtime | HTTP/worker health real, counters/gauges, log/recovery tests | IMPLEMENTADO E TESTADO |
| Migrations e usuário restrito | dez migrations, admin separado, grants explícitos | delivery-migrations2, migrations2, orm2, schema/constraints | IMPLEMENTADO E TESTADO |
| Instalação limpa e execução local documentada | demo:setup + dois env separados + guia | cópia Git sem node_modules, frozen install, lint/check e quatro papéis reais | IMPLEMENTADO E TESTADO |
| Opção de omitir autenticação §2 | ProviderIdentityGuard no-op, desenho OIDC documentado | rotas locais, health sem auth; IdP não implementado intencionalmente | IMPLEMENTADO E TESTADO |
| Histórico Git e preparação do formulário | commits semânticos + SUBMISSION.md | status/remote/diff/arquivos revisados | IMPLEMENTADO E TESTADO |
| Publicação remota | repositório privado `Marcelos161/distributed-wagering-processor` | `origin/main`, HEAD local e API GitHub com o mesmo SHA | IMPLEMENTADO E TESTADO |
| Acesso de avaliadores e formulário externo | depende dos usuários GitHub e dados de candidatura | nenhum convite, formulário ou mensagem enviado | PENDENTE (administrativo) |

Nenhum requisito técnico obrigatório ficou no estado “IMPLEMENTADO, MAS SEM TESTE
INTEGRADO”. IdP, OpenTelemetry, dashboard e benchmark de carga são opcionais e não
foram implementados; testes concorrentes não são apresentados como benchmark.

## Execuções finais

Comandos sequenciais executados em PostgreSQL 17 e LocalStack 4.14 reais, imagens por
digest, Bun 1.4.3. Todos retornaram exit0. Banco principal não recebeu migrations.

| Comando | Testes aprovados |
|---|---:|
| bun run check (inclui typecheck, unitários e build) |494|
| bun run test:financial |34|
| bun run test:persistence |15|
| bun run test:messaging |14|
| bun run test:wallet-creation |25|
| bun run test:bet |40|
| bun run test:wager |62|
| bun run test:refund |57|
| bun run test:rollback |14|
| bun run test:references |9|
| bun run test:api |5|
| bun run test:consumer |5|
| bun run test:publisher |3|
| bun run test:distributed |3|
| bun run test:delivery-migrations |2|
| bun run test:orm |2|
| bun run test:migrations |2|
| bun run test:infra |6|
| **Total distinto** |**792**|

Lint passou separadamente. Instalação limpa repetiu os494 unitários, lint, typecheck e
build; são reexecuções, não adicionados ao total. Setup rodou duas vezes sem reaplicar
migrations. Smoke da cópia limpa iniciou `dist/main.js` + consumer + publisher +
reference-worker em quatro PIDs distintos, readiness/live/metrics200; criou wallet
zero201 e reconciliou200/consistent true/zeroentries. SIGTERM encerrou os quatro.

## Provas de crash e processos independentes

- Três APIs:50 requisições simultâneas iguais → um efeito/49replays. Reiniciar API
  mantém snapshot original75.00 mesmo após movimentos posteriores.
- BET 80+80 contra100 →200+422, saldo 20.00, apenas um débito 80.00. Carteira diferente
  avança enquanto a primeira está bloqueada no PostgreSQL.
- REFUND versus ROLLBACK da mesma BET → uma compensação e uma rejeição, sem crédito
  duplo. Os testes de domínio/SQL cobrem também reversão de WIN/REFUND sem fundos.
- Três consumers efetivamente esperando lock em pg_stat_activity recebem SIGKILL:
  zero commits parciais/Inbox, saldo original 100. Reinício processa uma BET, rejeita
  outra e registra LOSS; saldo 20, um débito, Inbox 3. Dois publishers drenam Outbox.
- Consumer morto após commit, antes do DeleteMessage: redelivery consulta Inbox e
  resultado persistentes, ACK posterior, sem novo movimento.
- Publisher morto depois de SendMessage, antes de publishedAt: lease expira e outra
  instância envia novamente. Mesma identidade de evento, Inbox downstream única,
  nenhuma alteração monetária. Entrega é at-least-once.
- Resolver morto sob claim: PostgreSQL desfaz transação/lock, novo worker assume job.
  Falha técnica não apaga pendência nem consome sua tentativa de negócio.
- Docker restart/recreate preservou PostgreSQL e recriou a topologia SQS. Broker
  descartável não preserva mensagens; esse limite não foi confundido com worker crash.

## Eliminatórios revisados

| Eliminação | Proteção e evidência |
|---|---|
| Dinheiro em number | Money/decimal.js, mapper textual, CHECK escala/faixa; Number somente para versões/portas/contagens |
| Race produz saldo negativo | Wallet lock + CHECK,80+80 entre PIDs |
| Débito/crédito duplicado | identidades UNIQUE, snapshots, Inbox, proteção cruzada de reversão |
| Idempotência em memória | banco e replay após reinício |
| Correção só em uma instância | três APIs/três consumers/dois publishers reais |
| Evento antes do commit | Outbox na UOW, publisher lê somente confirmado |
| Movimento sem ledger | constraint triggers diferíveis, atomicidade e reconciliação |
| Banco/broker totalmente mockados | SQL e SQS em containers, HTTP real, processos reais e SIGKILL |

## Limites da evidência

Testes controlam interleavings e pontos de falha, mas não demonstram todos os schedules
possíveis. Uso externo/produção precisa de autenticação/autorização, TLS, monitoramento,
backups, sizing e operação da DLQ. As políticas de compensação, broker descartável,
limite monetário, lease e retenção estão explicitadas em EVALUATOR_GUIDE.md.
