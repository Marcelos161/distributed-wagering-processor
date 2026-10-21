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
`GET /health/ready` retorna 404 nesta etapa: banco/fila ainda não foram configurados.
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
Banco, mensageria, migrations e testes distribuídos pertencem às próximas etapas;
nenhum comando para eles é anunciado como disponível.
