# Executar e avaliar

## Ambiente local

Pré-requisitos: Bun **1.4.3**, Docker Engine com Compose v2, portas locais 55432,
4566 e 3000 livres. Exemplos HTTP abaixo usam curl e jq. Não requer AWS paga nem token
LocalStack. Imagens e dependências estão fixadas; o primeiro download requer internet.

```bash
bun install --frozen-lockfile
cp -n .env.example .env
bun run demo:setup
```

O setup inicia os dois containers, reconcilia filas, cria **wagering_demo** se ausente
e aplica as dez migrations nesse banco. Reexecutar mantém os dados. Não aplica
migrations em `wagering` nem remove volumes. Se credenciais de um volume antigo
forem diferentes, ajuste seu `.env` local: variáveis de inicialização do PostgreSQL
não trocam senhas de um volume existente.

`.env.demo` contém somente conexão da aplicação e configuração local AWS;
`.env.demo-migrations` contém conexão administrativa separada. Ambos são ignorados
pelo Git e gravados com permissão 600. Migrações são um job administrativo; os quatro
processos abaixo usam `wager_app`, sem DDL nem privilégios de administrador.

Execute **um comando por terminal**, na raiz:

```bash
bun --env-file=.env.demo run start
WORKER_HEALTH_PORT=3101 bun --env-file=.env.demo run worker:consumer
WORKER_HEALTH_PORT=3102 bun --env-file=.env.demo run worker:publisher
WORKER_HEALTH_PORT=3103 bun --env-file=.env.demo run worker:references
```

Ctrl+C/SIGTERM para o processo: deixa de assumir trabalho e aguarda a operação atual.
A API atende em 127.0.0.1:3000; health dos workers nas portas acima. Sem configuração,
a porta de health do worker é dinâmica e aparece no JSON `started`.

```bash
curl -fsS localhost:3000/health/live
curl -fsS localhost:3000/health/ready
curl -fsS localhost:3000/metrics | jq
curl -fsS localhost:3101/health/ready
```

Readiness da API verifica SQL/SQS; consumer verifica SQL/fila de comandos; publisher,
SQL/fila de eventos; referências, SQL. Liveness não depende desses serviços.

## Migrations e build

```bash
bun --env-file=.env.demo-migrations run migration:pending
bun --env-file=.env.demo-migrations run migration:list
bun --env-file=.env.demo-migrations run migration:up
bun run migration:create -- --name NomeDaMudanca
bun run build
bun --env-file=.env.demo run start:built
```

`migration:create` também exige MIGRATION_DATABASE_URL se o CLI conectar: utilize o
mesmo `--env-file=.env.demo-migrations`. Para estudar down, use `test:delivery-migrations`,
que cria banco descartável. Não execute down indiscriminadamente no banco de demonstração:
migrations antigas removem tabelas; as novas protegem históricos incompatíveis.
Não há schema update automático ao iniciar a API.

## Demonstração HTTP

Cada execução do exemplo cria jogador diferente. IDs do servidor são opacos.

```bash
PLAYER="demo-$(date +%s)"
WALLET=$(curl -fsS localhost:3000/wallets -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" | jq -r .id)
BODY=$(jq -nc --arg p "$PLAYER" --arg w "$WALLET" --arg x "bet-$PLAYER" \
  '{providerId:"provider-a",externalTransactionId:$x,playerId:$p,walletId:$w,roundId:"round-1",gameId:"demo",kind:"BET",money:{amount:"25.00",currency:"BRL"}}')
curl -sS localhost:3000/wagering/transactions -H 'Content-Type: application/json' \
  -H "Idempotency-Key: provider-a:bet-$PLAYER" -d "$BODY" | jq
# Repita exatamente a chamada: saldo 75.00 original, idempotentReplay:true.
curl -fsS "localhost:3000/wallets/$WALLET" | jq
curl -fsS "localhost:3000/wallets/$WALLET/ledger?limit=1" | jq
curl -fsS -X POST "localhost:3000/wallets/$WALLET/reconciliation" | jq
curl -fsS "localhost:3000/providers/provider-a/wagering/transactions/bet-$PLAYER" | jq
```

Primeira BET retorna 200, status PROCESSED, balance.amount 75.00, idempotentReplay false
mais transactionId/version. Reconciliação retorna storedBalance 75.00,
calculatedBalance 75.00, difference 0.00, consistent true, checkedEntries 2 e issues[].
A página de ledger contém `items` e `nextCursor`; passe o cursor seguinte em `cursor`
para continuar. Limite 1..100, padrão 50, ordem por versão da carteira.

| Rota | Contrato |
|---|---|
| POST /wallets |201; abertura positiva inclui OPENING/CREDIT atomicamente |
| GET /wallets/:walletId |200 ou404 |
| GET /wallets/:walletId/ledger |200, cursor opaco vinculado à carteira |
| POST /wagering/transactions |200 processada/replay;202 pendente;422 rejeitada |
| GET /wagering/transactions/:transactionId |200 ou404 |
| GET /providers/:providerId/wagering/transactions/:externalTransactionId |200 ou404 |
| POST /wallets/:walletId/reconciliation |200 diagnóstico, nunca correção |
| GET /health/live, /health/ready |200; ready 503 se dependência indisponível |
| GET /metrics |200 JSON de contadores e gauges operacionais |

400 significa contrato inválido;409 conflito de unicidade/idempotência;503 falha
transitória reconhecida;500 falha interna sanitizada. Saldo insuficiente é resultado
REJECTED persistido com failureCode, não uma exceção sem histórico. O header
`X-Correlation-Id` pode ser enviado e é devolvido; inválido/ausente gera UUID.
OPENING é exclusivamente interna. LOSS exige 0.00; BET/WIN/REFUND/ROLLBACK são positivos.
REFUND exige BET integral; ROLLBACK exige BET, WIN ou REFUND integral. Use
`referenceExternalTransactionId` e a mesma rodada/provedor/jogador/carteira/moeda.
Referência ausente entra em 202 e o worker resolve quando chega ou expira a política.

## SQS, eventos e DLQ

```bash
docker compose exec -T localstack awslocal sqs list-queues
COMMAND_URL=$(docker compose exec -T localstack awslocal sqs get-queue-url \
  --queue-name wager-transactions.fifo --query QueueUrl --output text)
DLQ_URL=$(docker compose exec -T localstack awslocal sqs get-queue-url \
  --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
docker compose exec -T localstack awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" --attribute-names All
MESSAGE=$(jq -nc --argjson data "$BODY" --arg key "provider-a:bet-$PLAYER" \
  --arg id "msg-$PLAYER" --arg now "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  '{messageId:$id,type:"WagerTransactionRequested",occurredAt:$now,data:($data+{idempotencyKey:$key})}')
docker compose exec -T localstack awslocal sqs send-message --queue-url "$COMMAND_URL" \
  --message-body "$MESSAGE" --message-group-id "$WALLET" --message-deduplication-id "msg-$PLAYER"
```

Esse envio repete a BET HTTP, portanto o efeito financeiro continua único. Alterar
somente o dedupId do SQS para reenviar não contorna Inbox/messageId nem idempotência.
O consumer confirma negócio e Inbox na mesma UOW antes de DeleteMessage. Mensagens
inválidas/conflitantes continuam sem ACK e chegam à DLQ após 5 recebimentos; rejeição
financeira persistida recebe ACK. Inspeção de DLQ com receive-message muda visibilidade;
não apague/reenvie mensagens reais sem análise. Não existe redrive automático da DLQ.

Eventos vão a **wager-events.fifo**, separada dos comandos. Consultar atributos não
consome; receive-message oculta temporariamente a mensagem. Não há consumidor de
negócio externo nesta entrega; o teste do publisher demonstra Inbox downstream para
um mesmo eventId. Retenção: comandos 4 dias; DLQ/eventos 14 dias; visibilidade 30 s.

## Testes reproduzíveis

Pare todos os quatro processos antes da suíte completa e use filas padrão vazias.
Os testes financeiros criam/removem apenas bancos `dwp_test_*` e filas com nomes únicos.
`test:infra` reinicia/recria containers **ao final**, preserva volume PostgreSQL e
recusa filas padrão ocupadas. Se já fez a demonstração, eventos podem estar pendentes:
não purgue para forçar teste; execute a suíte antes da demonstração ou use ambiente
Docker de avaliação separado.

```bash
bun run test:all
# Seleção rápida, sem reiniciar a infraestrutura:
bun run lint
bun run check
bun run test:distributed
bun run test:consumer
bun run test:publisher
bun run test:references
bun run test:delivery-migrations
```

`test:all` cobre lint, strict, testes unitários, build e todas as suítes reais. Os testes
incluem processos Bun independentes, sockets HTTP, SIGKILL/SIGTERM, constraints SQL,
SQS e DLQ. Consulte [matriz e contagens](DELIVERY_CHECKLIST.md). Não são benchmarks de
capacidade:50 requisições concorrentes verificam integridade, não uma promessa de RPS.

## Limites conhecidos

- Autenticação omitida conforme permitido no enunciado. Guard ProviderIdentityGuard
  é ponto de extensão OIDC (Keycloak/Zitadel), com issuer/audience e vínculo do provedor.
  Sem autenticação/autorização, não exponha este perfil local na internet.
- Entrega de eventos é **at-least-once**. Banco não confirma atomicamente com SQS;
  consumidores deduplicam eventId persistente. FIFO não substitui PostgreSQL e não há
  garantia de ordem causal de eventos distintos publicados por vários publishers.
- LocalStack Community 4.14.0, fixado por digest, sem token, **PERSISTENCE=0**: restart
  do broker perde mensagens. Reiniciar workers preserva a recuperação provada; cair
  o broker não é o mesmo cenário. Outbox já marcada publicada não é republicada
  automaticamente após apagar o broker. Ambiente de emulação não equivale a produção.
- BRL/USD/EUR, duas casas; teto persistível 999999999999999999.99. Não há câmbio.
- Uma compensação bem-sucedida por referência, inclusive entre REFUND e ROLLBACK.
  Reverter um REFUND não reabre a BET para nova compensação. Política conservadora.
- Referências:300 verificações ou 24 h, backoff 1 s até 5 min. Falha técnica não consome
  tentativa de negócio; pode manter pendência além do TTL até o banco voltar.
- Outbox sem descarte por quantidade de falhas; requer monitoramento/intervenção.
  Backoff1s até 5 min, lease 60 s; expiração pode permitir publicação repetida.
- Reconciliação percorre o histórico e bloqueia a Wallet durante a leitura consistente.
  Contadores em memória reiniciam; backlog/gauges vêm de SQL/SQS. Sem dashboard/alertas
  externos, TLS, IdP, deploy em nuvem ou testes de carga de produção.
