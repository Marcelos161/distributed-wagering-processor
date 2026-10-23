# Executar a aplicação base e a infraestrutura local

Esta base disponibiliza somente `GET /health/live`. A aplicação conecta ao PostgreSQL
via MikroORM como usuário restrito; ainda não processa apostas nem consome SQS.

## Pré-requisito

Bun **1.4.3**, registrado em [.bun-version](../.bun-version).
Consulte a [instalação oficial](https://bun.sh/docs/installation).
Para infraestrutura: Docker Engine e plugin Docker Compose com suporte a `up --wait`.

Neste ambiente, Bun foi instalado **somente no projeto**, porque não existia no
PATH. Para usar o mesmo mecanismo, com npm disponível:

```bash
npm install --prefix .tools --no-audit --no-fund --package-lock=false bun@1.4.3
export PATH="$PWD/.tools/node_modules/.bin:$PATH"
bun --version
```

Execute na raiz do projeto. O PATH vale apenas para a sessão atual; repita o export
ao abrir outro terminal. npm é usado só para obter o executável Bun; as dependências
da aplicação, scripts e testes são gerenciados/executados por Bun.
`.tools/` é ignorado pelo Git. Quem já possui Bun 1.4.3 não precisa desse mecanismo.

## Instalar, verificar e iniciar

```bash
bun install --frozen-lockfile
export DATABASE_URL=postgresql://wager_app:local_app_only@127.0.0.1:55432/wagering
bun run infra:up
bun run check
bun run start
```

Em outro terminal:

```bash
curl --fail http://127.0.0.1:3000/health/live
```

Resposta: HTTP 200, `{"status":"ok"}`. A porta é local por padrão.
`GET /health/ready` retorna 404 nesta etapa: a aplicação ainda não tem probes de dependências.
Finalize com Ctrl+C. A aplicação registra encerramento para SIGINT/SIGTERM.

## Configuração

| Variável | Padrão | Regra |
|---|---|---|
| HOST | 127.0.0.1 | Não vazio, sem espaços nas extremidades; hostname inválido falha ao abrir listener |
| PORT | 3000 | Apenas dígitos; inteiro entre 1 e 65535 |

O arquivo [.env.example](../.env.example) contém somente exemplos. É possível usar
variáveis diretamente: `PORT=3100 bun run start`. `HOST=0.0.0.0` permite binding
para containers; não é necessário para a execução local atual.

## Comandos disponíveis

| Comando | Resultado |
|---|---|
| `bun run dev` | Reinicia ao alterar arquivos |
| `bun run start` | Executa o entrypoint TypeScript com Bun |
| `bun run typecheck` | Checa tipos de fontes e testes sem emitir JS |
| `bun run test` | Executa 395 casos: Money, WalletLedgerEntry, Wallet, WagerTransaction, configuração e HTTP real; exige DATABASE_URL + PostgreSQL |
| `bun test ./test/money.test.ts` | 73 testes unitários de Money; não exige Docker, Nest ou variáveis de banco |
| `bun test ./test/wallet-ledger-entry.test.ts` | 66 testes de lançamentos, reidratação, imutabilidade e dependências; sem serviços externos |
| `bun test ./test/wallet.test.ts` | 81 testes de abertura, movimentação, versão, datas e preservação de estado; sem serviços externos |
| `bun test ./test/wager-transaction.test.ts` | 151 testes de lifecycle, referências, failure codes e encapsulamento; sem serviços externos |
| `bun run build` | Compila fontes em dist com checagem de tipos |
| `bun run start:built` | Executa dist/main.js; exige build anterior |
| `bun run check` | Typecheck, testes e build, nessa ordem; interrompe na primeira falha |
| `bun run infra:up` | Inicia PostgreSQL/LocalStack e aguarda saúde, até 120s |
| `bun run infra:status` | Mostra estado e portas dos dois serviços |
| `bun run infra:down` | Remove containers/rede deste projeto, preservando volume PostgreSQL |
| `bun run test:infra:postgres` | 2 testes reais; inclui restart/recriação PostgreSQL |
| `bun run test:infra:sqs` | 4 testes reais; inclui drift, ACK, redrive e restart/recriação LocalStack |
| `bun run test:infra` | Executa os dois grupos de infraestrutura sequencialmente |
| `bun run test:orm` | Nest/SQL/permissões em banco descartável |
| `bun run test:migrations` | Criação/up/down/repetição/falha transacional em bancos descartáveis |

## Diagnóstico de startup

- `PORT=abc bun run start:built` deve terminar com código 1 e erro de PORT.
- Iniciar dois servidores no mesmo HOST/PORT deve fazer o segundo terminar com
  código 1 e diagnóstico de porta ocupada.
- SIGTERM fecha o listener. O encerramento pelo sinal 15 é esperado; não equivale
  a um crash por regra financeira. Ainda não há worker SQS para drenar.

Os resultados efetivamente observados estão no [guia de aprendizado](LEARNING_GUIDE.md).
Migrations já possuem testes isolados; schema financeiro e testes distribuídos
pertencem às próximas etapas. Money pode ser estudado/testado isoladamente pelo
comando acima; exemplos e cada método estão na seção 12 do guia.

## PostgreSQL local

```bash
bun run infra:up
bun run infra:status
bun run test:infra:postgres
```

`infra:up` aguarda healthchecks; `infra:down` para/remove containers e rede sem
apagar volumes. O teste PostgreSQL reinicia e recria seu container, verificando
que um registro persistido sobrevive; não execute durante outro trabalho no banco.

As credenciais em `.env.example` são apenas locais e já têm defaults no Compose.
Não é necessário criar `.env`; se precisar personalizar, copie o exemplo para
`.env` e mantenha as URLs coerentes com os valores escolhidos.

| Cliente | Endereço PostgreSQL |
|---|---|
| NestJS no host | `postgresql://wager_app:local_app_only@127.0.0.1:55432/wagering` |
| Futuro NestJS na rede Compose | `postgresql://wager_app:local_app_only@postgres:5432/wagering` |
| Migrations no host | `postgresql://wager_admin:local_admin_only@127.0.0.1:55432/wagering` |

`DATABASE_URL` é obrigatória no startup e no teste HTTP real. Pode ser exportada
ou definida em `.env` (Bun carrega esse arquivo). Não há fallback administrativo.
O usuário app não cria tabelas nem é administrador; permissões das
tabelas serão concedidas pelas migrations futuras. Senhas com caracteres especiais
precisam de percent-encoding nas URLs.

Para consultar sem instalar psql no host:

```bash
docker compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_APP_PASSWORD" psql -h 127.0.0.1 -U wager_app -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -c "SELECT current_user, current_database();"'
```

Volume: `dwp_postgres_data`. Mudar variáveis de inicialização em `.env` não modifica
usuário/senha/banco já persistidos. Não execute `down --volumes` para corrigir isso;
ajuste as credenciais SQL explicitamente. Alterações de porta/ambiente exigem
`docker compose up -d` para reconciliar configuração; `restart` não recria containers.

## LocalStack e SQS

Usamos Community 4.14.0, sem token, fixada por digest conforme aprovação. As versões
atuais exigem conta. Esta configuração é somente de desenvolvimento e não usa AWS real.
`infra:up` executa o hook que cria/reconcilia as duas filas e espera o healthcheck
validar seus atributos. Não é necessário instalar AWS CLI ou Python no host:
awslocal/Python/boto3 já fazem parte da imagem.

| Configuração futura | NestJS no host | NestJS na rede Compose |
|---|---|---|
| SQS_ENDPOINT | `http://127.0.0.1:4566` | `http://localstack:4566` |
| AWS_REGION | `us-east-1` | `us-east-1` |
| Credenciais AWS locais | `test` / `test` | `test` / `test` |
| SQS_QUEUE_NAME | `wager-transactions.fifo` | Mesmo nome |
| SQS_DLQ_NAME | `wager-transactions-dlq.fifo` | Mesmo nome |

O futuro cliente AWS SDK receberá `endpoint`, `region` e `credentials` explicitamente.
Chamará GetQueueUrl usando os nomes acima. Não copie uma URL interna de um container
para o host; a estratégia dynamic devolve a URL conforme o endereço de acesso.
Mudar `LOCALSTACK_PORT` exige ajustar `SQS_ENDPOINT` no cliente; os testes leem a
porta efetiva do Compose. Os nomes obrigatórios ficam em `infra/localstack/queues.json`.
Não altere apenas as variáveis de nomes esperando renomear filas automaticamente.

Comandos reais de inspeção:

```bash
docker compose exec -T localstack awslocal sqs list-queues
docker compose exec -T localstack python3 /opt/dwp-sqs/provision.py check
docker compose exec -T localstack python3 /opt/dwp-sqs/provision.py apply
```

`check` só lê; `apply` cria o que falta e reconcilia atributos mutáveis sem apagar
mensagens. Falha real de provisionamento torna o serviço unhealthy; veja
`docker compose logs --tail=80 localstack` e repare a causa antes de repetir apply.

Exemplo manual para filas vazias, sem consumidor concorrente, dentro do container:

```bash
docker compose exec localstack sh
queue_url=$(awslocal sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text)
probe_id=$(cat /proc/sys/kernel/random/uuid)
awslocal sqs send-message --queue-url "$queue_url" --message-body "InfrastructureProbe:$probe_id" --message-group-id infrastructure-demo --message-deduplication-id "$probe_id" --query MessageId --output text
receipt=$(awslocal sqs receive-message --queue-url "$queue_url" --wait-time-seconds 1 --max-number-of-messages 1 --query 'Messages[0].ReceiptHandle' --output text)
test "$receipt" != None && awslocal sqs delete-message --queue-url "$queue_url" --receipt-handle "$receipt"
awslocal sqs receive-message --queue-url "$queue_url" --wait-time-seconds 1 --query Messages --output text
exit
```

Send retorna um MessageId; DeleteMessage bem-sucedido não imprime corpo; a última
consulta retorna `None` se a fila continuar vazia. O receipt handle identifica
aquele recebimento e deve ser obtido novamente em caso de reentrega.

**Reinícios:** o PostgreSQL preserva seus dados; LocalStack usa PERSISTENCE=0 e
recria filas vazias/configuração a cada restart. Não reinicie o emulador com
mensagens importantes pendentes. Testes futuros de crash do worker devem manter
LocalStack rodando. Reiniciar os serviços após estarem ociosos:

```bash
docker compose restart
docker compose up -d --wait --wait-timeout 120
```

Os testes SQS exigem filas vazias, não executam purge e não devem competir com
produtores/consumidores. Se um teste falhar após enviar uma mensagem, inspecione
a fila antes de limpar apenas a mensagem de prova; nenhum cleanup global é executado.

## MikroORM no NestJS

`bun run test:orm` cria/remove bancos `dwp_test_<UUID>` no PostgreSQL local e valida
DI, SQL, HTTP e recusa do papel admin. Não reinicia containers nem altera wagering.
Os testes consultam credenciais locais no Compose; não exigem DATABASE_URL exportada.
`bun run check` inclui HTTP real e exige DATABASE_URL válida + PostgreSQL disponível.
Não executamos criação de schema nem migrations automaticamente no startup.

## Migrations oficiais

Instale dependências completas (`bun install --frozen-lockfile`), incluindo a CLI
e o migrador em devDependencies. O job usa Bun e fontes TS, separado de dist/main.js.
Defina MIGRATION_DATABASE_URL em `.env` ou no ambiente; a configuração não usa
DATABASE_URL como fallback. Use somente a conexão de migration no job administrativo.

```bash
export MIGRATION_DATABASE_URL=postgresql://wager_admin:local_admin_only@127.0.0.1:55432/wagering
bun run migration:create --name NomeDescritivo
bun run migration:pending
bun run migration:list
```

Create gera arquivo vazio em migrations: implemente/revise up/down e versione.
Pending lista pendentes; list lista aplicadas. Esses comandos oficiais podem
inicializar a tabela de histórico; não os trate como estritamente read-only.
Não há migration de produção nesta entrega, nem foi aplicado DDL em wagering.

Quando existir uma migration revisada para o alvo correto:

```bash
bun run migration:up
bun run migration:down
```

Up aplica pendências; repetição usa histórico e não duplica aplicação. Down reverte
a última migration e pode destruir dados: exercite no banco descartável antes de
considerar qualquer reversão em ambiente com dados. Não use fresh/schema:update.
Não execute dois jobs administrativos de migration simultaneamente; o job deve ser único.

Para demonstrar sem tocar no banco principal:

```bash
bun run test:orm
bun run test:migrations
```

Esses testes criam bancos dwp_test_<UUID> a partir de template0, usam credenciais
locais do Compose, geram migrations em .tools e limpam somente esses recursos.
A fixture recusa nomes de banco fora desse padrão. Não removem o volume principal.
Uma falha no teste é propagada; se cleanup for impedido por indisponibilidade do
banco, inspecione o banco de teste identificado antes de qualquer remoção manual.

O diretório migrations deve conter só uma versão (TS) de cada arquivo. O glob
Migration*.ts/js ignora README. Snapshots/diff automático estão desativados porque
ainda não existem entidades mapeadas; SQL é escrito e revisado explicitamente.

### Testes do schema financeiro

`bun run test:financial` aplica migrations reais em bancos descartáveis e valida
constraints/permissões por SQL direto. Não aplica nem reverte schema em wagering.
Migrations versionadas podem ser consultadas pela CLI existente; aplicar no banco
principal é uma ação separada. DOWN descarta dados das tabelas removidas.
