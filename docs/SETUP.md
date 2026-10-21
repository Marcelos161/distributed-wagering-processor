# Executar a etapa 1

Esta base disponibiliza somente `GET /health/live`. Ainda não processa apostas.

## Pré-requisito

Bun **1.4.3**, registrado em [.bun-version](../.bun-version).
Consulte a [instalação oficial](https://bun.sh/docs/installation).

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
| `bun run test` | Executa 15 casos de configuração + 2 casos HTTP reais |
| `bun run build` | Compila fontes em dist com checagem de tipos |
| `bun run start:built` | Executa dist/main.js; exige build anterior |
| `bun run check` | Typecheck, testes e build, nessa ordem; interrompe na primeira falha |

## Diagnóstico de startup

- `PORT=abc bun run start:built` deve terminar com código 1 e erro de PORT.
- Iniciar dois servidores no mesmo HOST/PORT deve fazer o segundo terminar com
  código 1 e diagnóstico de porta ocupada.
- SIGTERM fecha o listener. O encerramento pelo sinal 15 é esperado; não equivale
  a um crash por regra financeira. Ainda não há worker SQS para drenar.

Os resultados efetivamente observados estão no [guia de aprendizado](LEARNING_GUIDE.md).
Migrations e testes financeiros distribuídos pertencem às próximas etapas.

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

`DATABASE_URL` e `MIGRATION_DATABASE_URL` estão preparadas, mas a aplicação ainda
não as consome. O usuário app não cria tabelas nem é administrador; permissões das
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
