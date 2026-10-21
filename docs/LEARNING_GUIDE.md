# Guia de aprendizado — Distributed Wagering Processor

Este guia cresce a cada funcionalidade. O [README](../README.md) define o desafio;
[ARCHITECTURE](../ARCHITECTURE.md) registra decisões e limites; o
[plano](IMPLEMENTATION_PLAN.md) separa entregas presentes e futuras.

## 1. Base executável: problema e solução

Antes de debitar uma aposta, precisamos saber se o programa inicia, se o framework
registra a rota, se o runtime responde HTTP e se o compilador encontra inconsistências.
Sem essa base verificável, uma falha de inicialização pode se confundir com defeito
da regra financeira. Nesta etapa não há saldo nem apostas implementados.

Escolhemos um NestJS mínimo com Bun e teste HTTP real. A alternativa seria gerar
todo o template via CLI, incluindo arquivos que teríamos de adaptar para Bun.
A montagem manual mantém cada arquivo explicável. O custo é configurar explicitamente
compiler, scripts e testes. Isso atende a stack obrigatória (§4), mas não prova
correção financeira, concorrência ou recuperação distribuída (§§6–13).

### Conceitos usados nesta etapa

- **Runtime:** programa que executa nosso código; aqui, Bun. **Gerenciador de
  pacotes:** resolve e instala dependências. **Test runner:** descobre e executa
  testes. Bun cumpre os três papéis, como exige o desafio.
- **TypeScript estrito:** analisa tipos antes da execução. Por exemplo, o retorno
  de `live` aceita apenas a string literal `'ok'`; retornar `'ready'` é erro.
  Tipos desaparecem no JavaScript: um payload HTTP ainda precisará de validação
  em runtime. Não confundir tipagem com validação financeira.
- **Transpilação e checagem:** executar TS transforma sua sintaxe em JS, mas o
  projeto usa `tsc --noEmit` separadamente para verificar tipos. O build também
  verifica tipos e produz `dist/`, que não é versionado.
- **ESM:** sistema de módulos com `import`/`export`. Imports internos terminam em
  `.js` para funcionar após compilação; Bun resolve o correspondente `.ts` durante
  desenvolvimento. `import type` desaparece na saída e serve só ao compilador.
- **Decorators:** `@Controller`, `@Get` e `@Module` associam metadados às classes
  e métodos. O Nest lê esses metadados para montar módulos e rotas. Não são
  comentários: influenciam o comportamento da aplicação.
- **Reflection/metadata:** `reflect-metadata` disponibiliza suporte a metadados
  usados pelo Nest. `experimentalDecorators` e `emitDecoratorMetadata` configuram
  o formato esperado pelo framework.
- **Injeção de dependência:** o framework constrói classes e fornece as dependências
  registradas, em vez de cada consumidor criar tudo com `new`. Nesta base, o Nest
  instancia `HealthController`; não há ainda serviços financeiros para injetar.
  No futuro um caso de uso receberá uma porta de persistência, sem conhecer o ORM.
- **Promise e async/await:** uma `Promise<T>` representa conclusão futura com `T`
  ou erro. `await` aguarda a conclusão sem bloquear o event loop. Abrir/fechar
  servidor é assíncrono; retornar uma Promise permite ao chamador observar falhas.
- **Liveness:** o processo consegue responder. **Readiness:** suas dependências
  permitem aceitar trabalho. Uma carteira não deve receber apostas quando não
  consegue persistir, mesmo que o endpoint de liveness ainda responda.
- **Porta efêmera:** `listen(0)` pede uma porta livre ao sistema operacional.
  Testes não disputam uma porta fixa com o aplicativo do desenvolvedor.
- **Graceful shutdown:** encerrar recursos de forma coordenada ao receber sinal.
  Fechar HTTP já existe; terminar/devolver mensagens SQS ainda não existe.
- **Lockfile:** `bun.lock` registra o conjunto resolvido de versões e integridades.
  `bun install --frozen-lockfile` impede alterar essa resolução silenciosamente.

## 2. Arquivos de configuração

| Arquivo | Responsabilidade e decisões |
|---|---|
| [package.json](../package.json) | Dependências exatas, runtime esperado e comandos. `private` evita publicação acidental; `type: module` usa ESM |
| [bun.lock](../bun.lock) | Resolução das dependências transitivas; gerado pelo Bun, não editado manualmente |
| [.bun-version](../.bun-version) | Registra Bun 1.4.3 para humanos/ferramentas compatíveis; não instala nem troca versão sozinho |
| [tsconfig.json](../tsconfig.json) | Checa `src` e `test`; `strict`, acesso indexado possivelmente indefinido, propriedades opcionais exatas, código sem variáveis/parâmetros ociosos |
| [tsconfig.build.json](../tsconfig.build.json) | Herda a política de tipos e emite apenas `src` em `dist`; `noEmitOnError` evita produzir um novo build com erro de tipo |
| [.env.example](../.env.example) | Exemplos sem segredo para HOST/PORT; Bun pode ler `.env` local, que é ignorado |
| [.gitignore](../.gitignore) | Exclui dependências, builds, runtime local, logs, cobertura e arquivos de ambiente; preserva o exemplo |
| [AGENTS.md](../AGENTS.md) | Mantém as instruções de ensino, escopo, Git e garantias financeiras acessíveis no próprio projeto |

`skipLibCheck: true` reduz a checagem das declarações de bibliotecas; não desliga
`strict` para nosso código. `noUncheckedIndexedAccess` explica o acesso `env['PORT']`:
a chave pode não existir. `??` usa o padrão apenas para `null`/`undefined`; uma string
vazia não vira configuração padrão e será rejeitada.

Os scripts de compilação usam `bun x --bun --no-install tsc`: `--bun` força o
compilador a executar com Bun apesar do shebang Node do pacote; `--no-install`
exige a versão local já resolvida no lockfile, sem baixar um compilador durante o check.

**Uso de `number` nesta etapa:** a porta TCP é um inteiro entre 1 e 65535. Isso não
é dinheiro. A proibição financeira continua valendo integralmente para Money,
saldo, valores de transações e ledger.

## 3. Código explicado função por função

### `AppModule` — [src/app.module.ts](../src/app.module.ts)

- **Responsabilidade:** declarar a composição inicial da aplicação.
- **Parâmetros/retorno:** a classe não define construtor nem métodos; o decorator
  recebe `{ controllers: [HealthController] }`.
- **Fluxo:** a factory Nest encontra o módulo, lê a lista e cria/registra o controller.
- **Quem usa:** `createApplication`, através de `NestFactory.create`.
- **Dependências:** `Module` do Nest e nossa classe `HealthController`.
- **Erros:** falhas de montagem do grafo são rejeitadas pela factory; não são ocultadas.
- **Motivo:** um ponto de composição explícito; não se criou um service vazio.
- **Exemplo:** registrar o controller disponibiliza `GET /health/live` após `listen`.

### `createApplication(options)` — [src/create-application.ts](../src/create-application.ts)

- **Responsabilidade:** construir a aplicação Nest real, sem abrir porta de rede.
- **Entrada:** `options: NestApplicationOptions = {}`; nos testes, `{ logger: false }`.
- **Retorno:** `Promise<INestApplication>`; oferece `listen`, `close` e outras operações Nest.
- **Passos:** (1) importa o suporte a reflection; (2) cria um `ConsoleLogger` JSON;
  (3) aplica as opções recebidas com spread `...options`; (4) fixa `abortOnError: false`;
  (5) devolve a Promise de `NestFactory.create(AppModule, ...)`.
- **Chamadores:** `bootstrap` e o hook `beforeAll` do teste HTTP.
- **Dependências:** NestFactory, ConsoleLogger, reflect-metadata e AppModule.
- **Erros:** falhas de inicialização rejeitam a Promise. `abortOnError: false` evita
  que a factory aborte o processo por conta própria; o entrypoint trata a falha.
- **Motivo:** teste e execução normal compartilham a mesma composição. Opções
  permitem silenciar logs no teste sem substituir componentes por mocks.
- **Exemplo:** `const app = await createApplication({ logger: false })` cria a app;
  ela só escuta rede depois de `await app.listen(...)`.

### `readHttpConfiguration(env)` — [http-configuration.ts](../src/infrastructure/config/http-configuration.ts)

- **Responsabilidade:** transformar configurações textuais de ambiente num objeto válido.
- **Entrada:** `Readonly<Record<string, string | undefined>>`: mapa de nomes para
  strings ou ausência; a função não pode atribuir novos valores a esse mapa.
- **Retorno:** `HttpConfiguration`, com `readonly host: string` e `readonly port: number`.
  `readonly` protege atribuição no TypeScript; não equivale a congelar um objeto em runtime.
- **Passos:** (1) lê PORT, padrão `'3000'`; (2) exige somente dígitos com regex ancorada
  `^[0-9]+$`; (3) converte para Number; (4) verifica inteiro e faixa de 1 a 65535;
  (5) lê HOST, padrão loopback `127.0.0.1`; (6) rejeita vazio e espaços nas extremidades;
  (7) retorna `{ host, port }`.
- **Chamadores:** `bootstrap` e testes unitários de configuração.
- **Dependências:** apenas recursos da linguagem; não lê `process.env` internamente.
- **Erros:** `Error` com mensagem de PORT/HOST; ocorre antes de abrir servidor.
  Resolução de hostname e disponibilidade da porta pertencem ao `listen`.
- **Motivo:** receber o mapa torna o teste determinístico, sem modificar o ambiente
  global. Validar a string inteira evita que `3000abc` seja parcialmente aceito.
- **Exemplos:** `{}` → `{host:'127.0.0.1',port:3000}`;
  `{HOST:'0.0.0.0',PORT:'8080'}` → binding configurável para containers;
  `{PORT:'1e3'}` → erro. Porta zero é proibida no entrypoint, mas usada diretamente no teste.

### `HealthController.live()` — [health.controller.ts](../src/infrastructure/http/health.controller.ts)

- **Responsabilidade:** responder à verificação de vida do processo.
- **Entrada:** nenhuma; não recebe corpo, headers nem identidade.
- **Retorno:** `{ status: 'ok' }`, cujo tipo permite somente esse literal.
- **Passos:** `@Controller('health')` define prefixo; `@Get('live')` define verbo/caminho;
  ao receber GET correspondente, Nest chama `live` e serializa o objeto como JSON.
- **Chamador:** roteador HTTP do Nest, acionado pelo cliente/probe/teste.
- **Dependências:** decorators do Nest; sem banco/fila/serviços externos.
- **Erros:** nenhuma falha de negócio é esperada; indisponibilidade do processo é
  observada por quem faz a requisição. Não captura indisponibilidade do banco.
- **Motivo:** liveness público e barato, sem confundir falha de dependência com processo morto.
- **Exemplo:** `GET /health/live` → HTTP 200, `{"status":"ok"}`.
  A classe não possui construtor explícito nem outros métodos.

### `bootstrap()` — [src/main.ts](../src/main.ts)

- **Responsabilidade:** iniciar o processo HTTP usando a configuração real.
- **Entrada:** nenhuma; lê `process.env` e o passa à função de configuração.
- **Retorno:** `Promise<void>`; resolução indica servidor iniciado, não fim do processo.
- **Passos:** (1) valida host/porta; (2) aguarda `createApplication()`; (3) registra hooks
  SIGINT/SIGTERM; (4) aguarda `listen(port, host)`; (5) se `listen` falhar, fecha os
  recursos com `app.close()` e relança o erro.
- **Chamador:** o próprio entrypoint, uma vez quando `main.ts`/`dist/main.js` é executado.
- **Dependências:** configuração, factory Nest e ambiente do processo.
- **Erros:** configuração inválida, montagem inválida e bind malsucedido rejeitam
  a Promise, tratada pelo callback abaixo. `unknown` exige verificar o tipo antes
  de acessar propriedades de um erro.
- **Motivo:** manter efeitos de processo fora da factory usada nos testes; shutdown
  explícito e propagação de falha, sem servidor silenciosamente quebrado.
- **Exemplo:** HOST=127.0.0.1 e PORT=3000 abrem o listener local; PORT=abc falha
  antes de abrir uma porta.

### Callback de `bootstrap().catch(...)` — [src/main.ts](../src/main.ts)

- **Responsabilidade:** registrar falha de inicialização e sinalizar erro ao sistema operacional.
- **Entrada:** `error: unknown`; **retorno:** `void`.
- **Passos:** cria logger JSON no contexto Bootstrap; se `error instanceof Error`,
  usa `error.message`; senão registra mensagem genérica; define `process.exitCode = 1`.
- **Chamador:** mecanismo de Promises, somente quando bootstrap rejeita.
- **Dependências:** ConsoleLogger e process. Não registra `process.env` nem payloads.
- **Erros:** não faz retry nem esconde a falha; o processo termina após recursos fechados.
- **Motivo:** sinalizar startup malsucedido sem `process.exit()` abrupto antes do cleanup.
  `void` expressa que não aguardamos no top-level; a rejeição tem handler explícito.
- **Exemplo:** porta ocupada → logs JSON de diagnóstico e código de saída 1.

## 4. Testes explicados

### Configuração — [http-configuration.test.ts](../test/http-configuration.test.ts)

`describe('HTTP configuration', callback)` recebe título e callback sem parâmetros,
com retorno `void`; executado pelo Bun para registrar os testes. Depende de `test`,
`expect` e `readHttpConfiguration`; falhas das expectativas são reportadas pelo runner.

| Callback | Entrada/retorno | Lógica, cenário e problema detectado |
|---|---|---|
| `uses local defaults...` | Sem argumentos → void | Chama com `{}` e compara host/porta; detecta default incorreto |
| `accepts an explicit container binding` | Sem argumentos → void | Passa HOST=0.0.0.0/PORT=8080 e compara objeto; detecta configuração ignorada |
| `rejects invalid PORT %j` | `port: string` → void, chamado por `test.each` | Uma execução por caso; callback interno `() => readHttpConfiguration(...)` adia a execução até `toThrow`; exige erro de PORT |
| `rejects invalid HOST %j` | `host: string` → void, chamado por `test.each` | Mesmo mecanismo; exige erro de HOST para vazio/branco/espaço inicial |

As closures passadas a `expect` não têm parâmetros; se a validação estiver quebrada,
retornam HttpConfiguration em vez de lançar, fazendo `toThrow` falhar. É necessário
adiar a execução para que o matcher observe a exceção. A bateria de PORT cobre
`''`, `abc`, `3000abc`, `1.5`, `1e3`, `-1`, `0`, `65536`, `Infinity` e `' 3000'`.
Isso testa caracteres, decimal, notação científica, faixa e espaços. HOST cobre
`''`, `' '` e `' 127.0.0.1'`. São **15 casos unitários**; não representam dinheiro.

### HTTP real — [health.http.test.ts](../test/health.http.test.ts)

O callback de `describe` não recebe argumentos e retorna `void`; registra hooks e
testes e mantém `app`/`baseUrl` no escopo compartilhado da suíte. `app` permite
`undefined` para cleanup seguro mesmo se a inicialização falhar.

| Callback | Entrada/retorno | Passos, dependências, falhas e justificativa |
|---|---|---|
| `beforeAll` | Nenhuma → Promise<void> | Chama createApplication com logger desligado, abre socket loopback na porta 0 e guarda URL real. Falha de montagem/bind falha a suíte; não injeta mocks |
| `afterAll` | Nenhuma → Promise<void> | Chama `app?.close()`; optional chaining evita acessar aplicação inexistente. Libera recursos mesmo após falha de asserção |
| `serves public liveness...` | Nenhuma → Promise<void> | fetch sem credenciais, verifica 200, Content-Type JSON e corpo exato. Detecta rota ausente, serialização errada ou exigência indevida de autenticação |
| `does not claim readiness...` | Nenhuma → Promise<void> | GET /health/ready exige 404 nesta etapa e consome o corpo; impede um sinal falso de prontidão. Será substituído por testes de readiness real quando houver dependências |

Todos os callbacks são chamados pelo Bun test runner. `fetch` depende de um socket
HTTP real e pode rejeitar se o servidor não responder. Erros de rede ou expectativas
falham o teste; não há captura que converta falha em sucesso. Dois casos HTTP.

### Fluxo completo executado passo a passo

1. `bun run start` executa `src/main.ts` com Bun.
2. `bootstrap` transforma PORT textual em porta TCP validada.
3. `createApplication` entrega AppModule ao Nest; o framework encontra HealthController.
4. Decorators registram GET `/health/live`.
5. `listen` abre a porta. Um cliente envia GET sem autenticação.
6. O roteador chama `live()`, recebe o objeto e envia JSON com status 200.
7. SIGTERM aciona o ciclo de encerramento Nest e fecha o socket.

O teste HTTP exercita passos 3–6 com a mesma factory e encerra via `app.close`.
A sonda separada do programa compilado exercitou também entrypoint, bind e sinal.

## 5. Evidência observada na etapa 1

Ambiente: Linux x86_64; Bun **1.4.3**; NestJS **12.2.0**; TypeScript **5.9.3**.

| Comando/verificação executada | Resultado observado |
|---|---|
| `bun install` | Dependências instaladas e bun.lock gerado |
| `bun install --frozen-lockfile` | Passou; 101 instalações verificadas sem mudanças |
| `bun run typecheck` | Passou sem erros |
| `bun run test` | 17 passaram, 0 falharam; 19 expectativas, 2 arquivos |
| `bun run build` | Passou; JavaScript emitido em dist |
| `bun dist/main.js`, iniciado por sonda local Python, com GET real | HTTP 200 e JSON esperado |
| Segundo processo compilado na mesma porta | Exit code 1 e mensagem de porta em uso |
| SIGTERM no processo compilado | Terminou pelo sinal (Python reportou -15); socket fechado; logs de startup parseáveis como JSON |
| Processo compilado com PORT=3000abc | Exit code 1 e erro explícito de configuração |

As quatro últimas verificações foram uma sonda pontual com `subprocess`, socket e
HTTP, fora da suíte versionada. Não são contabilizadas como testes Bun nem como
evidência de shutdown de workers SQS. Os comandos de execução estão em [SETUP](SETUP.md).

### Problemas encontrados e soluções

- Bun não existia no PATH: instalado em `.tools/` sem mudar shell global.
- A primeira tentativa de `bun run check` pelo caminho absoluto do binário falhou:
  os subcomandos `bun` não estavam no PATH. Adicionar `.tools/node_modules/.bin`
  ao PATH da sessão resolveu; a checagem completa foi então executada e passou.
- A primeira sonda de porta ocupada procurava o texto literal `EADDRINUSE`.
  Bun registrou `Failed to start server. Is port ... in use?`, com exit code 1.
  A expectativa da sonda foi corrigida para o diagnóstico observado e ela passou.
  O código da aplicação não foi alterado para satisfazer uma mensagem específica.

**Limites:** nenhuma integração com PostgreSQL/SQS foi executada; nenhum teste de
concorrência financeira, precisão monetária ou recuperação de eventos existe ainda.

## 6. Vocabulário do plano (ainda sem implementação)

- **Domínio:** regras do problema; por exemplo, saldo não pode ficar negativo.
- **Caso de uso:** coordena uma ação, como processar BET, chamada tanto por HTTP como por SQS.
- **Porta/adaptador:** contrato necessário à aplicação e implementação concreta;
  por exemplo, contrato de persistência e sua implementação MikroORM.
- **Aggregate Root:** objeto que controla alterações de um conjunto consistente;
  Wallet deverá impedir mudanças de saldo sem uma movimentação correspondente.
- **Factory/reidratação:** métodos de construção; `create/open` aplicam regras de
  criação, enquanto `rehydrate` reconstrói estado persistido sem repetir uma aposta.
- **Ledger:** histórico imutável de movimentos; permite reconstruir o saldo.
- **Transação SQL/commit:** grupo de alterações confirmado junto ou desfeito. Gravar
  débito sem ledger seria inconsistente; ambos precisam da mesma confirmação.
- **Lock pessimista por wallet:** uma operação segura a linha da carteira até terminar;
  outra operação da mesma carteira aguarda. Carteiras diferentes continuam independentes.
- **Lock otimista:** a gravação exige a versão esperada; conflito exige nova leitura
  e possível retry. **Deadlock:** duas transações esperam recursos uma da outra;
  o banco cancela uma, exigindo tratamento transitório limitado.
- **Idempotência/replay:** repetir a mesma operação não repete o efeito; devolve-se
  seu resultado original, inclusive o saldo daquela execução.
- **At-least-once:** entrega pelo menos uma vez, com possíveis duplicatas.
  **ACK** confirma consumo; antes do commit poderia fazer uma aposta desaparecer.
- **SQS FIFO:** fila com recursos de ordem/deduplicação, insuficientes para substituir
  constraints e transações no banco. **DLQ:** fila de mensagens que esgotaram tratamento.
- **Inbox:** registro durável de mensagens recebidas/processadas, na transação financeira.
- **Outbox:** registro durável de eventos a enviar, também na transação; outro worker
  publica depois do commit. Duplicata ainda é possível se houver crash depois do envio.
- **Backoff exponencial:** ampliar espera a cada tentativa, até um teto; evita repetir
  rapidamente uma falha persistente. Tentativas e prazo precisam ser duráveis.
- **Unit of Work:** agrupa mudanças que o ORM pretende persistir. **Identity Map:**
  mantém uma representação de cada entidade em seu contexto. **EntityManager:**
  coordena consultas/persistência e transações; escopo precisa ser isolado por operação.
- **Evento de domínio/integração:** fato ocorrido, como saldo alterado. O envelope de
  integração será serializado e versionado para outros consumidores; não envia a
  instância Money nem autoriza publicação antes do commit.

Essas definições introduzem o plano. Cada módulo terá seu próprio exemplo executado,
contratos, erros e evidência quando efetivamente implementado.

## 7. Direção arquitetural aprovada — 21/10/2026

O usuário aprovou MikroORM, LocalStack e lock pessimista por carteira. A decisão
está na ADR-003 de [ARCHITECTURE](../ARCHITECTURE.md); não houve implementação
desses componentes nesta atualização documental.

Exemplo do comportamento a implementar: duas apostas de `80.00 BRL` disputam uma
wallet com `100.00 BRL`. A primeira transação obtém o lock da linha, verifica saldo,
debita e confirma saldo/ledger/eventos pendentes juntos. A segunda aguarda esse
commit; ao adquirir o lock, encontra `20.00 BRL` e rejeita a aposta sem novo débito.
Uma operação em outra wallet não depende desse mesmo lock. O teste real deverá
comprovar esse resultado com processos independentes; o exemplo não é evidência
de concorrência já validada.

## 8. Infraestrutura PostgreSQL: Compose, volume e usuário da aplicação

### Problema e decisão

Precisamos de um banco real, reproduzível, que preserve dados ao trocar o container.
Docker Compose lê [compose.yaml](../compose.yaml) e gerencia serviços, rede e volumes
como um projeto. O serviço `postgres` executa PostgreSQL 17.11; a imagem está fixada
pelo digest SHA-256, portanto a tag não muda silenciosamente os binários utilizados.
Escolhemos a linha 17 estável; não há requisito no enunciado que exija a linha 18.

Um **container** é a execução isolada da imagem. Sua camada gravável é descartável.
Um **volume nomeado** é armazenamento gerenciado pelo Docker fora dessa camada.
`dwp_postgres_data` é montado em `/var/lib/postgresql/data`, onde essa imagem grava
os arquivos do banco. Reiniciar ou recriar o container reutiliza esses arquivos.
`docker compose down` preserva o volume; acrescentar `--volumes` o apagaria.
Não há motivo para esse apagamento no fluxo normal de desenvolvimento.

### Propriedades do Compose

| Propriedade | Significado nesta configuração |
|---|---|
| `name: dwp` | Prefixa recursos do projeto; evita depender do nome da pasta com espaços |
| `services.postgres` | Define o serviço e seu nome DNS dentro da rede Compose |
| `image` | Imagem oficial e conteúdo fixado por digest; sem build próprio |
| `environment` | Variáveis recebidas pelo processo do container; `${VAR:-padrão}` usa valor local ou padrão de desenvolvimento |
| `ports` | `127.0.0.1:55432:5432`: porta do host → porta do container, acessível apenas por loopback |
| `volumes: postgres_data:...` | Monta dados persistentes; declaração final `volumes` cria o volume nomeado |
| `volumes: ./infra/...:...:ro` | Monta script do repositório somente para leitura, no diretório de inicialização da imagem |
| `healthcheck.test` | Executa SELECT 1 via TCP e senha; exige banco, usuário e autenticação funcionando |
| `CMD-SHELL` e `$$` | Executa shell no container; `$$` adia expansão da variável até esse shell, em vez de o Compose expandi-la no host |
| `interval: 5s` / `timeout: 3s` | Frequência da sonda e duração máxima de cada tentativa |
| `retries: 12` / `start_period: 15s` | Tolerância a falhas consecutivas e período inicial de aquecimento |
| `stop_grace_period: 30s` | Tempo para o banco encerrar antes de Docker forçar término |

O Compose cria a rede `dwp_default` automaticamente. Não usamos `container_name`
nem rede externa compartilhada. Não há dependência entre PostgreSQL e LocalStack:
eles podem iniciar independentemente. Sem política de restart automático nesta
etapa, os serviços iniciam sob comando explícito do desenvolvedor.

### Script de inicialização do PostgreSQL

[10-create-app-role.sh](../infra/postgres/10-create-app-role.sh) é um script linear,
sem funções próprias. A imagem oficial o chama **somente quando o volume está vazio**.

- **Entradas:** POSTGRES_USER, POSTGRES_DB e POSTGRES_APP_PASSWORD (strings do ambiente).
- **Retorno:** exit status 0 quando os comandos SQL concluem; diferente de zero se falhar.
- **Passos:** `set -eu` interrompe erro/variável ausente; chama psql com
  `ON_ERROR_STOP=1`; cria `wager_app` com login sem privilégios administrativos;
  concede conexão ao banco e uso do schema public.
- **Segurança de SQL:** `:'app_password'` faz quoting de literal e `:"db_name"`
  faz quoting de identificador via psql. O heredoc delimitado por `'SQL'` não
  expande variáveis no shell; a substituição é feita pelo psql.
- **Dependências:** shell/psql da imagem e servidor de inicialização PostgreSQL.
- **Erros:** não ignora falhas nem recria usuário por conta própria em banco existente.
  A ausência de repetição no restart é garantida pelo entrypoint oficial e pelo volume.
- **Motivo:** a aplicação não deve ser superusuária, pois poderia contornar proteções
  do ledger. Migrations usarão conexão administrativa separada e concederão permissões
  específicas sobre as futuras tabelas; elas ainda não existem.
- **Exemplo:** primeiro boot cria `wager_app`; restart preserva o mesmo usuário/dados.

Alterar senhas em `.env` depois do primeiro boot **não altera a senha persistida**.
Será necessário executar ALTER ROLE explicitamente e ajustar a conexão, preservando
dados. Não recomendamos apagar o volume para resolver divergência de credenciais.

### Testes reais e helpers

[compose.ts](../infra/test/compose.ts) contém dois helpers de teste, sem papel na aplicação:

| Função | Contrato e fluxo |
|---|---|
| `compose(...args)` | Recebe strings de argumentos CLI, retorna Promise<string> com stdout. Usa Bun.spawn sem shell, cwd da raiz via fileURLToPath, coleta stdout/stderr/exit em paralelo; exit não zero lança Error. Chamado pelos testes e pelo helper postgres; depende do CLI Docker/daemon. Não interpola comandos nem imprime a configuração com senhas |
| `postgres(role)` | Recebe `'admin'` ou `'app'`, retorna Promise<SQL>. Lê `docker compose config --format json`, extrai porta publicada/banco/senha do serviço e cria cliente PostgreSQL nativo Bun, loopback, pool máximo 1 e timeout de conexão 5s. Chamado pelos testes; não é ORM de produção e não substitui MikroORM |

Os callbacks de `Promise.all` são as Promises de leitura e saída do processo,
não há funções auxiliares ocultas. `fileURLToPath` é necessário porque o caminho
do projeto contém espaços: `.pathname` produziria `%20`, um diretório inexistente.
A primeira tentativa dos testes detectou esse erro de cwd; foi corrigido antes do commit.

[postgres.test.ts](../infra/test/postgres.test.ts) tem dois callbacks `async`, sem
argumentos, retorno Promise<void>, chamados pelo Bun test runner:

1. **SQL autenticado e permissões:** conecta como app, consulta `pg_roles` e exige
   `wager_app` sem superuser/createdb/createrole. Fecha conexão em finally. Detecta
   senha/porta/banco incorretos e privilégios excessivos. Falhas SQL/asserções falham o teste.
2. **Persistência:** cria tabela de prova com nome aleatório e um marcador UUID,
   insere com parâmetro `$1`, fecha conexão, reinicia o serviço e verifica o marcador
   com nova conexão. Recria o container com `--force-recreate` e repete a consulta.
   Em finally remove somente sua tabela e fecha as conexões. O identificador passado
   a `unsafe` é prefixo constante + UUID sem hífens gerado pelo próprio teste, não
   entrada do usuário. Não há truncamento de dados do projeto nem remoção de volume.

O segundo teste tem timeout de 120s e reinicia apenas o serviço deste projeto.
Use-o quando nenhum outro trabalho estiver usando esse banco. Os testes normais
continuam em `bun run test`; infraestrutura é explícita em `bun run test:infra:postgres`.

### Evidência PostgreSQL desta etapa

- `docker compose config --quiet`: configuração válida.
- `docker compose up -d --wait --wait-timeout 120 postgres`: serviço healthy.
- `PGPASSWORD=local_app_only psql -h 127.0.0.1 -p 55432 -U wager_app -d wagering`:
  conexão real retornou banco `wagering`, usuário `wager_app` e PostgreSQL **17.11**.
- Consulta de privilégios: `rolsuper=f`, `rolcreatedb=f`, `rolcreaterole=f`.
- `bun run test:infra:postgres`: **2 passaram, 0 falharam**, incluindo preservação
  do marcador após restart e após recriação do container (aproximadamente 11,5s).

Referências: [Compose](https://docs.docker.com/reference/compose-file/services/),
[volumes](https://docs.docker.com/reference/compose-file/volumes/),
[imagem PostgreSQL](https://hub.docker.com/_/postgres),
[cliente SQL Bun usado somente nos testes](https://bun.sh/docs/runtime/sql).

## 9. Infraestrutura SQS: FIFO, DLQ, provisionamento e recuperação de configuração

### Problema e decisão aprovada

Precisamos exercitar uma API de fila de verdade, com mensagens, reentregas e ACK,
sem usar conta ou credenciais AWS reais. **LocalStack** é um emulador que atende
requisições compatíveis com APIs AWS dentro de um container. O SDK/CLI envia HTTP
para ele, em vez de enviá-lo à AWS. Emulação não equivale a demonstrar comportamento
em produção AWS; divergências devem ser tratadas quando aparecerem.

As versões atuais do LocalStack exigem token. O usuário aprovou Community **4.14.0**,
fixada por digest, sem token. Alternativas apresentadas: versão atual com conta ou
reavaliar MiniStack. A escolha antiga evita credenciais externas, mas não recebe
atualizações automaticamente. A ADR-005 registra essa decisão e seus limites.

Nesta configuração, **somente PostgreSQL tem persistência de dados**. LocalStack
está com PERSISTENCE=0: no restart, o hook recria as filas e os atributos, mas
mensagens pendentes desaparecem. Reexecutar o provisionador com o container vivo
preserva mensagens; reiniciar o emulador não. Essa diferença foi documentada
explicitamente para não confundir configuração reproduzível com broker durável.

### Fila normal, FIFO e DLQ

| Tipo | Comportamento e aplicação |
|---|---|
| Standard (normal) | Entrega pelo menos uma vez, duplicatas possíveis e ordem por melhor esforço |
| FIFO | Ordena dentro de cada MessageGroupId e oferece deduplicação por janela limitada; grupos diferentes podem avançar independentemente |
| DLQ | Papel de uma fila que recebe mensagens que excederam o limite de entregas sem remoção; neste projeto também é FIFO |

Para apostas futuras, MessageGroupId será walletId. Usar um grupo global limitaria
o paralelismo de todas as carteiras. MessageDeduplicationId identifica o envio para
deduplicação do broker; `messageId` do envelope e a idempotency key de negócio têm
papéis diferentes. FIFO não substitui os registros persistentes de Inbox/transação.

### Como uma mensagem percorre a infraestrutura

1. O produtor chama **SendMessage**, informando QueueUrl, corpo, grupo e dedup ID.
2. **ReceiveMessage** entrega corpo e **ReceiptHandle**. A mensagem ainda está na fila.
3. Durante o **visibility timeout**, a mensagem fica temporariamente invisível.
   Se o processo morrer antes de confirmar, ela pode ser recebida novamente.
4. Após concluir o processamento, o consumidor chama **DeleteMessage** com o handle
   daquele recebimento. Isso é nosso ACK no SQS. No worker financeiro futuro, ocorrerá
   somente depois do commit SQL; nenhum processamento financeiro existe nesta etapa.
5. Sem DeleteMessage, a mensagem volta após a visibilidade expirar. Isso permite
   **retry**: nova tentativa. **Backoff** é a política de espaçar essas tentativas;
   o backoff exponencial definitivo pertence ao futuro worker, não a este script.
6. A **redrive policy** da origem aponta o ARN da DLQ e maxReceiveCount=5. Depois
   de cinco recebimentos sem remoção, a mensagem é redirecionada à DLQ ao tentar
   nova entrega. Ela fica disponível para diagnóstico; não é sucesso de negócio.

Não há garantia absoluta de ausência de duplicatas pelo visibility timeout. Uma
operação demorada poderá exigir renovação de visibilidade e continuará necessitando
de idempotência. Remover uma mensagem para DLQ também pode interromper a sequência
original do grupo; o domínio deverá tratar dependências fora de ordem.

### Atributos escolhidos

| Atributo | Valor | Justificativa |
|---|---|---|
| FifoQueue | true em ambas | Exigência do desafio; atributo imutável após criação |
| ContentBasedDeduplication | false | Exige dedup ID explícito; evita esconder duplicatas pelo corpo automaticamente |
| VisibilityTimeout | 30 segundos | Ponto inicial para operações curtas; ajustar/renovar quando houver worker e medidas reais |
| ReceiveMessageWaitTimeSeconds | 20 segundos | Long polling: servidor aguarda mensagem antes de responder vazio; reduz consultas ociosas |
| MessageRetentionPeriod origem | 345600 segundos (4 dias) | Prazo inicial de processamento local |
| MessageRetentionPeriod DLQ | 1209600 segundos (14 dias) | Mais tempo para inspecionar falhas; expiração em dias não foi validada por espera real |
| RedrivePolicy | ARN da DLQ + maxReceiveCount=5 | Tentativas limitadas, sem redirecionar por uma única falha transitória |
| RedriveAllowPolicy | byQueue + ARN da origem | Somente a fila obrigatória pode usar essa DLQ |

ARN é o identificador do recurso (`arn:aws:sqs:região:conta:nome`); QueueUrl é o
endereço HTTP utilizado nas operações. Conta local fictícia: `000000000000`.

### Propriedades adicionadas ao Compose

`localstack.image` fixa Community 4.14.0 por digest. `SERVICES=sqs` limita o emulador
ao serviço necessário. `AWS_DEFAULT_REGION` organiza os recursos; credenciais
`test/test` são fictícias e explícitas. Não são carregados perfis AWS do host.

`SQS_ENDPOINT_STRATEGY=dynamic` usa o endereço pedido pelo cliente na QueueUrl:
`127.0.0.1:4566` funciona no host; `localstack:4566` funciona na rede Compose.
`LOCALSTACK_HOST=localstack:4566` configura o hostname interno anunciado pelo emulador.
`SQS_ENABLE_MESSAGE_RETENTION_PERIOD=1` ativa retenção; PERSISTENCE=0 explicita o
ciclo descartável. A porta publicada é loopback; somente 4566 é publicada no host,
mesmo que `docker compose ps` mostre outras portas internas declaradas pela imagem.

Um bind mount somente leitura disponibiliza scripts/JSON em `/opt/dwp-sqs`.
Outro coloca o hook em `/etc/localstack/init/ready.d`, executado quando o serviço
AWS estiver pronto. Healthcheck executa Python em modo `check`, a cada 5s, timeout
10s, até 18 falhas consecutivas e aquecimento de 20s. Ele verifica configuração,
não apenas porta aberta. `up --wait` usa essa saúde para concluir ou falhar.
Não há volume de dados para LocalStack nem montagem do Docker socket.

### Scripts e funções de provisionamento

[queues.json](../infra/localstack/queues.json) é o estado desejado versionado, sem
funções. Contém nomes, atributos e limite de recebimentos. Políticas dependentes
de ARN são construídas depois de descobrir as filas.

[10-init-sqs.sh](../infra/localstack/10-init-sqs.sh) não recebe argumentos; usa
`set -eu` e `exec python3 ... apply`. Retorna o exit status do Python. `exec`
substitui o processo shell, propagando falha. É chamado pelo LocalStack no estágio
ready; depende apenas dos recursos já presentes na imagem. Não instala pacotes.

[provision.py](../infra/localstack/provision.py) usa Python/boto3 incluídos no
emulador; essa escolha evita outro container ou instalação em startup. Bun continua
sendo o runtime, gerenciador e test runner da aplicação TypeScript.

| Função | Parâmetros/retorno | Lógica, chamadores, dependências e falhas |
|---|---|---|
| `ensure_queue` | cliente boto3 + `spec: dict` → URL string | Chamada por main em apply; consulta URL; cria somente se o código AWS indicar fila inexistente; lê FifoQueue e rejeita incompatibilidade. Outros ClientErrors propagam. Nunca apaga fila para corrigir erro |
| `expected_attributes` | spec dict + source_arn/dlq_arn strings → dict | Chamada por main; copia atributos sem modificar spec, acrescenta RedrivePolicy na origem e RedriveAllowPolicy na DLQ usando json.dumps. Depende de JSON; chaves ausentes falham explicitamente |
| `normalized` | key/value strings → string ou objeto JSON | Chamada nas comparações; atributos simples continuam strings; políticas são parseadas e maxReceiveCount vira inteiro. Isso evita considerar ordem das chaves ou representação `5`/`"5"` como drift. JSON inválido falha |
| `main` | mode string → None | Valida apply/check, lê spec relativo ao arquivo, cria cliente no loopback do container com test/test e timeouts. Resolve DLQ e origem, consulta ARNs, monta atributos. Em apply atualiza atributos mutáveis; em ambos compara atributos atuais com esperados e imprime JSON de sucesso. Divergência, rede, JSON ou modo inválido propagam exceção e exit não zero |

O bloco `if __name__ == '__main__'` chama main com argv[1], ou apply por padrão.
No healthcheck o argumento é explicitamente check. Esse modo não cria filas nem
altera atributos. Falha do hook não é ocultada: sem topologia correta, healthcheck
também falha. `connect_timeout=2`, `read_timeout=2` e retry limitado evitam espera
indefinida por tentativa. O loop é DLQ → origem para resolver o destino antes da origem.

Exemplo: aplicar com VisibilityTimeout alterado para 7 restaura 30. Chamar check
antes de restaurar lança `unexpected attribute VisibilityTimeout`. Se a fila já
contiver uma mensagem, apply não remove essa mensagem.

### Funções e testes TypeScript do SQS

[sqs.test.ts](../infra/test/sqs.test.ts) utiliza o SDK AWS real, instalado como
devDependency. Todas as funções abaixo retornam Promises; erros de transporte e
expectativas são propagados ao Bun runner, sem conversão para sucesso.

| Função | Entrada → retorno | Passos, dependências e chamadores |
|---|---|---|
| `sqs` | Nenhuma → SQSClient | Lê config Compose pelo helper da seção 8; monta endpoint loopback/porta publicada, região e test/test; limita retries SDK a 2. Chamado por cada teste; não consulta credenciais reais |
| `queues` | SQSClient → objeto source/dlq de URLs | Duas GetQueueUrl pelos nomes obrigatórios; URL ausente lança Error. Chamado por validação, precondição e testes |
| `attributes` | cliente, URL string → mapa de strings | GetQueueAttributes All; ausência de Attributes lança Error. Usado por verifyTopology/requireEmpty |
| `verifyTopology` | cliente → void | Resolve URLs, consulta ambas, exige FIFO, dedup explícita, timeout/polling/retenção e políticas com ARNs corretos. Valores esperados independentes do provisionador detectam config errada. Usado antes/depois de reaplicação e reinícios |
| `requireEmpty` | cliente → void | Verifica contagens visível/em processamento/atrasada em ambas. Qualquer valor diferente de zero lança Error. Não purga mensagens. Precondição dos testes; ambiente deve estar ocioso porque contadores são aproximados |
| `sendProbe` | cliente, URL → corpo string | Gera UUID, cria JSON InfrastructureProbe e envia com grupo/dedup únicos. Retorna corpo para comparação. Chamado pelos testes; não cria uma aposta |
| `receive` | cliente, URL, wait number=1 → Message ou undefined | ReceiveMessage com máximo 1, long polling configurável e contador de recebimentos. Vazio retorna undefined. Chamado pelos testes; mantém visibility timeout padrão da fila |
| `acknowledge` | cliente, URL, Message ou undefined, corpo esperado → void | Confere corpo antes de remover; exige ReceiptHandle e chama DeleteMessage. Não confirma mensagem diferente da prova. Chamado após recebimento e na DLQ |

Cada callback de `test` abaixo não recebe parâmetros, retorna Promise<void>, cria
cliente por sqs e chama `client.destroy()` em finally. O SDK destroy fecha recursos
HTTP locais; não remove filas nem mensagens. Dependem de Docker e LocalStack reais.

1. **Provisionamento:** exige filas vazias, valida atributos, envia prova, altera
   visibility para 7; espera check falhar e em finally reaplica configuração. Aplica
   novamente, verifica as mesmas URLs/atributos e recebe/remove a prova. Detecta
   healthcheck superficial, drift não corrigido e bootstrap destrutivo. Timeout 30s.
2. **Recebimento/ACK:** envia, recebe com contador 1, confirma invisibilidade numa
   segunda consulta, muda visibilidade dessa mensagem para zero, recebe contador 2,
   remove com novo handle e verifica vazio. Detecta remoção prematura ou falta de
   reentrega; não espera 30s porque usa a API de mudança de visibilidade. Timeout 15s.
3. **Redrive:** envia, recebe cinco vezes, verifica corpo/contador e devolve
   visibilidade a zero a cada vez. A próxima consulta da origem não entrega; consulta
   DLQ, verifica corpo e remove com handle da DLQ. Detecta policy que só parece
   correta no JSON, mas não encaminha mensagens. Timeout 20s.
4. **Reinício/recriação:** exige filas vazias, salva URLs, reinicia LocalStack,
   aguarda healthy, verifica topologia e troca uma nova mensagem. Recria container
   e repete. Detecta hook ausente/URLs inconsistentes após restart. Não testa
   preservação de mensagens no broker, que é descartável. Timeout 120s.

`test:infra` encadeia PostgreSQL e SQS sequencialmente. Testes não rodam ao importar
a aplicação nem fazem parte do comando normal `test`. Eles reiniciam serviços:
execute-os sem outros produtores/consumidores usando este ambiente. Nenhum worker
de apostas, Inbox ou Outbox foi implementado.

### Resultados efetivamente observados

| Comando/cenário | Resultado |
|---|---|
| `docker compose up -d --wait --wait-timeout 120` | PostgreSQL e LocalStack healthy |
| `bun run test:infra:sqs` | 4 passaram, 0 falharam, 79 expectativas; aproximadamente 17,9s |
| `docker compose exec -T localstack awslocal sqs list-queues` | As duas filas obrigatórias presentes |
| `python3 /opt/dwp-sqs/provision.py check`, dentro do container | JSON com sqs=configured e as duas URLs |
| GetQueueAttributes origem | FIFO=true; VisibilityTimeout=30; polling=20; retention=345600; redrive ARN da DLQ e maxReceiveCount=5 |
| GetQueueAttributes DLQ | FIFO=true; retention=1209600; byQueue com ARN da origem |
| CLI SendMessage manual | MessageId `55d0ffef-9824-4b20-8316-0b0dc21e2064` |
| CLI ReceiveMessage + DeleteMessage manual | Handle obtido, remoção sem erro; nova consulta Messages retornou `None` |

Na primeira consulta manual pós-ACK, uma expressão JMESPath com crases foi
interpretada pelo shell e falhou. Substituímos por `--query Messages`; a confirmação
retornou `None`. Foi erro da sonda CLI, não de envio/remoção; os quatro testes SDK
já haviam passado. Os exemplos em [SETUP](SETUP.md) usam a forma corrigida.

Os resultados não demonstram processamento financeiro, transação SQL integrada à
mensagem, persistência do broker nem compatibilidade completa com AWS real. O
próximo módulo será MikroORM e migrations reversíveis, antes de regras financeiras.

## 10. MikroORM no NestJS, sem entidades financeiras

### Problema e decisões

A aplicação precisa consultar PostgreSQL sem usar a credencial administrativa.
Adotamos MikroORM 7.2.5, driver PostgreSQL da mesma versão e integração oficial
NestJS 7.1.0 (compatível com Nest 12). A configuração ESM/NodeNext existente serve
ao ORM; Bun 1.4.3 executa fontes, build e testes. Não há criação automática de banco,
índices ou tabelas no startup. Não há entidade fictícia no registro de produção.

Alternativa seria escrever providers e middleware próprios; o módulo oficial já
gerencia pool, injeção, contexto HTTP e shutdown. Usamos `forRootAsync` para ler
ambiente ao montar a aplicação, não ao importar arquivos. Variáveis são obrigatórias:
sem DATABASE_URL não se tenta adivinhar conexão nem reutilizar credencial de migration.

### Conceitos: ORM, Entity, Repository, EntityManager, Unit of Work, Identity Map

**ORM** relaciona objetos do programa com registros do banco. O MikroORM permite
persistir mudanças e coordenar consultas/transações sem espalhar SQL por controllers.
Ele não substitui regras de domínio nem constraints PostgreSQL.

**Entity** é um tipo mapeado: seus campos correspondem a colunas, e a chave primária
identifica um registro. Futuras entidades de persistência ficarão na infraestrutura.
Isso não exige adicionar decorators ORM às classes financeiras: mapeadores poderão
transformar estado persistido em domínio por `rehydrate` e extrair estado para gravação.
Nenhuma dessas entidades ou mapeadores é antecipada nesta etapa.

**Repository** concentra consultas de uma entidade. O EntityRepository do ORM opera
com seu EntityManager; um futuro adaptador de repositório implementará o contrato
exigido pelo caso de uso. Não criamos um GenericRepository vazio só para ter uma camada.

**EntityManager (EM)** coordena consultas, objetos carregados e gravações. `em.fork()`
cria um contexto de trabalho independente, compartilhando o pool/driver. Nos testes
usamos `execute` para SQL real sem precisar criar uma Entity de demonstração.

**Identity Map** associa tipo + chave primária ao mesmo objeto dentro de um contexto.
Carregar o mesmo registro duas vezes pode devolver a mesma instância; isso evita
duas cópias divergentes na mesma operação. Não é cache global nem garantia de
idempotência. Requisições diferentes precisam de contextos independentes.

**Unit of Work** acompanha entidades gerenciadas e suas mudanças. `flush()` calcula
as escritas necessárias. No contexto de uma transação explícita, elas participam
dessa transação; fazer uma alteração num objeto não equivale a confirmar no banco.
SQL manual via `execute` não sincroniza automaticamente objetos já carregados.

**`EntityManager.transactional(callback)`** abre um contexto transacional, passa
o EM desse contexto ao callback, realiza flush/commit se concluir, ou rollback se
lançar erro. O callback deve usar esse EM para todas as consultas/escritas relacionadas.
Uma operação em outro pool/conexão não entra magicamente na mesma transação. Locks
pessimistas futuros serão adquiridos dentro desse limite e liberados no commit/rollback.
Não foi implementado lock financeiro nesta etapa.

### Caminho completo: inicialização até SQL

1. `bootstrap` chama `createApplication`, que entrega AppModule ao Nest.
2. AppModule importa PersistenceModule; `forRootAsync.useFactory` lê DATABASE_URL.
3. `createOrmOptions` configura driver, pool e descoberta vazia; MikroORM.init
   estabelece a infraestrutura de conexão. Não executa migrations.
4. O módulo oficial registra MikroORM e EntityManager como providers; `@Inject`
   informa qual token o construtor de ApplicationDatabaseCheck precisa receber.
5. Durante `app.init()`/`listen()`, Nest chama `onModuleInit`. A classe cria um fork,
   executa SELECT em pg_roles através do driver/pool PostgreSQL e verifica privilégios.
6. O driver envia SQL, PostgreSQL autentica/executa e devolve linhas. O método
   aguarda essa Promise; erro de conexão/consulta ou papel administrativo aborta startup.
7. Nas requisições HTTP, middleware oficial cria RequestContext próprio. No shutdown,
   o módulo oficial fecha o pool. Workers futuros precisarão de fork/contexto explícito.

### Arquivos e funções

| Arquivo/função | Contrato, fluxo, chamadores, erros e motivos |
|---|---|
| [database-url.ts](../src/infrastructure/persistence/database-url.ts), `readDatabaseUrl(env,purpose)` | Mapa readonly e purpose `'application'/'migrations'` → string. Seleciona uma única variável, exige valor, parseia URL, verifica protocolo PostgreSQL/host/usuário/banco. Ausência ou formato inválido lança erro que não inclui a URL/senha. Usada pelo módulo Nest e pela configuração futura da CLI; nunca faz fallback entre credenciais |
| [orm-options.ts](../src/infrastructure/persistence/orm-options.ts), `createOrmOptions(clientUrl)` | String → opções tipadas por defineConfig. Entidades vazias, warnWhenNoEntities=false, ensureDatabase/ensureIndexes=false, allowGlobalContext=false, pool 0–5, debug=false. Não abre conexão; inicializador ORM interpreta as opções. Desabilitar aviso de lista vazia é temporário, até existir primeira entidade |
| Callback `logger(message)` | String → void; encaminha mensagem ao ConsoleLogger JSON com contexto MikroORM. Chamado pelo ORM; debug SQL desligado |
| [persistence.module.ts](../src/infrastructure/persistence/persistence.module.ts), `PersistenceModule` | Classe sem métodos/construtor próprio. Registra módulo oficial e ApplicationDatabaseCheck; `useFactory()` sem parâmetros retorna createOrmOptions(readDatabaseUrl(process.env,'application')). PostgreSqlDriver explícito permite ao Nest registrar tokens específicos do driver. Falhas são propagadas |
| [application-database-check.ts](../src/infrastructure/persistence/application-database-check.ts), construtor | MikroORM injetado → instância; guarda referência privada readonly; @Inject torna o token explícito, evitando depender só da inferência de metadata |
| `ApplicationDatabaseCheck.onModuleInit()` | Sem argumentos → Promise<void>. Fork, SELECT de privilégios do usuário atual, exige linha e rejeita superuser/createdb/createrole/bypassrls. Chamado pelo lifecycle Nest; teste também o chama diretamente. Não concede/revoga privilégios; SQL real continua responsável por autorização |
| [app.module.ts](../src/app.module.ts), AppModule | Passou a importar PersistenceModule; mantém controller de health. Nenhum método novo |

A checagem do papel não é uma auditoria completa de grants ou memberships; migrations
futuras ainda devem conceder permissões mínimas e testes SQL devem verificar cada
constraint. Liveness continua público e não consulta banco a cada request; startup
agora exige banco disponível. Readiness PostgreSQL+SQS continua pendente.

### Testes e isolamento

[database-configuration.test.ts](../test/database-configuration.test.ts): callbacks
sem retorno útil chamados pelo Bun; verificam seleção exclusiva das duas URLs,
ausência de fallback, rejeição de cinco formatos inválidos sem revelar o texto
sensível e opções que impedem criação automática/global context. As closures de
expect adiam execução para toThrow; erros não esperados falham o teste. São 7 casos.

[disposable-database.ts](../infra/test/disposable-database.ts): `withDisposableDatabase(run)`
recebe callback assíncrono com URLs application/migrations e retorna Promise<void>.
Lê configuração Compose, gera nome `dwp_test_` + UUID, conecta ao banco de controle
`postgres`, cria banco com template0 e chama run. Em finally remove **somente** o
banco que acabou de criar, com FORCE, e fecha conexão. Nenhum nome externo é aceito;
identificador SQL vem só do UUID interno. O flag created impede apagar algo que
não foi criado pela função. Se erro de cleanup ocorrer, ele é propagado. A tabela
de produção, o banco wagering e seu volume não são alvos desse helper.

[orm.test.ts](../infra/test/orm.test.ts): dois callbacks test (sem parâmetros,
Promise<void>) usam o helper. O callback run recebe URLs e executa:

1. Inicialização real do Nest com DATABASE_URL de app do banco descartável; resolve
   MikroORM via `app.get`, faz SELECT de usuário/banco, confirma lista de tabelas
   vazia, consulta liveness por socket real e exige CREATE TABLE negado. Em finally
   fecha app e restaura variável de ambiente. Detecta credencial errada, schema
   automático, falha de DI/HTTP e grants excessivos.
2. Inicializa MikroORM com credencial admin somente no banco descartável; chama
   o guard de startup e exige rejeição. Fecha ORM em finally. Demonstra a recusa
   explícita antes de usar essa credencial como aplicação.

Resultados: `bun run test:orm` **2 passaram, 0 falharam, 7 expectativas**;
`DATABASE_URL=... bun run check` **24 testes passaram**, typecheck/build passaram.
O teste HTTP existente agora também inicializa ORM real e exige DATABASE_URL.

Referências: [integração Nest](https://mikro-orm.io/docs/usage-with-nestjs),
[transações](https://mikro-orm.io/docs/transactions),
[compatibilidade v7](https://mikro-orm.io/docs/upgrading-v6-to-v7).

## 11. Migrations oficiais: criação, histórico, aplicação e reversão

### Migration não é transação SQL

Uma **migration** é uma mudança versionada da estrutura ou dos dados: arquivo com
nome único e métodos `up` e `down`. Ela responde: qual mudança este ambiente recebeu?
Uma **transação SQL** é o limite de atomicidade: BEGIN, operações, COMMIT ou ROLLBACK.
Ela responde: estas operações foram confirmadas juntas? Uma migration pode executar
numa transação. Uma aposta futura também usará transação, mas não será uma migration.

O migrador compara arquivos com a tabela `mikro_orm_migrations`. `up` executa
pendências em ordem e registra sucesso; reaplicar pula nomes já registrados.
`down` reverte a última migration por padrão e remove seu registro. O controle é
por nome, não uma prova criptográfica do conteúdo: não edite migrations aplicadas;
versione no Git e acrescente correções novas.

`transactional=true` protege cada migration; `allOrNothing=true` mantém o lote numa
transação mestre. Se uma instrução falha, desfaz o lote sem registrar sucesso parcial.
`disableForeignKeys=false` mantém constraints ativas. CREATE INDEX CONCURRENTLY,
por exemplo, exigiria decisão separada porque não cabe nesse modelo transacional.

**Down não é backup:** remover uma tabela remove seus dados. O teste compara o
schema antes/depois, não restaura dados apagados. A tabela administrativa do migrador
permanece vazia depois de down; a linha de base é capturada após inicializar esse controle.

### Escolhas e estrutura

Usamos `@mikro-orm/migrations` e `@mikro-orm/cli` oficiais 7.2.5 em devDependencies.
O job de migration instala essas dependências e executa TypeScript com Bun. O
servidor compilado não importa nem executa o migrador. A pasta
[migrations](../migrations/README.md) está preparada, sem tabelas fictícias.

`migration:create` gera arquivo **vazio** para SQL explícito e revisado. A alternativa
é diff automático de entidades; com registro de entidades vazio, esse diff poderia
propor remoções indevidas. Não o usamos nesta etapa; snapshots também estão desativados.
Quando houver entidades reais, geração por diff poderá ser avaliada, mantendo revisão
de up/down e testes de constraints. Não usamos schema:update/fresh.

### Configuração e funções

| Arquivo/função | Contrato, fluxo, chamadores e erros |
|---|---|
| [mikro-orm.config.ts](../mikro-orm.config.ts) | Sem função própria; exporta createMigrationOptions(readDatabaseUrl(process.env,'migrations')). Importada pela CLI. Exige MIGRATION_DATABASE_URL; não consulta DATABASE_URL. Importar configuração não aplica migrations |
| [migration-options.ts](../scripts/migration-options.ts), `createMigrationOptions(clientUrl,path)` | URL string e caminho opcional → opções PostgreSQL. Reutiliza createOrmOptions, registra Migrator, configura path/pathTs, glob Migration*.ts/js, tabela histórica e políticas transacionais. Caminho padrão absoluto via fileURLToPath; testes passam pasta temporária. Não abre conexão; erros de conexão/discovery surgem ao inicializar ORM |
| [fixture migration-config.ts](../infra/test/fixtures/migration-config.ts) | Sem função própria; lê URL, exige nome `/dwp_test_` + 32 caracteres hexadecimais e DWP_TEST_MIGRATIONS_PATH. Exporta opções de migration; recusa explicitamente wagering/outros bancos. Usada só por subprocessos de teste |
| [migrations.test.ts](../infra/test/migrations.test.ts), `migrationCli(url,path,command,...args)` | Strings → Promise<string> stdout. Bun.spawn usa process.execPath (Bun), CLI oficial e fixture; recebe URL/path no ambiente do subprocesso. Lê stdout/stderr/exit em paralelo. Exit não zero lança Error para o teste. Não modifica process.env global nem interpola shell |

path e pathTs apontam ao mesmo diretório porque o job usa TS diretamente; o build
do servidor compila apenas src. Não misture JS e TS da mesma migration na pasta.
Testes escrevem em `.tools/`, ignorado no Git, para resolver pacotes do projeto.
Finally remove somente o diretório temporário que cada cenário acabou de criar.

### Cada método das migrations de demonstração

O teste chama a CLI oficial `migration:create --blank --name InfrastructureProbe`,
encontra arquivo/classe gerados e preenche a classe temporária:

```ts
override async up(): Promise<void> {
  this.addSql('CREATE TABLE infrastructure_probe (id text PRIMARY KEY)');
  this.addSql('GRANT SELECT, INSERT ON infrastructure_probe TO wager_app');
}
override async down(): Promise<void> {
  this.addSql('DROP TABLE infrastructure_probe');
}
```

Os métodos não recebem argumentos, retornam Promise<void> e são chamados pelo
migrador. `addSql` enfileira instruções no runner, não confirma separadamente.
Up cria tabela e grants mínimos; down remove tabela/grants. Erros SQL provocam
rollback. A classe herda Migration sem construtor próprio. `override` verifica
que o método existe na classe base. Nada disso vai à pasta de produção.

O cenário de falha gera outras duas classes temporárias:

- `Migration20990101000001.up`: CREATE TABLE batch_probe; `down`: DROP dessa tabela.
- `Migration20990101000002.up`: CREATE TABLE failure_probe e depois SELECT 1/0;
  `down`: DROP dessa tabela.

Todos esses métodos são async/Promise<void>, sem parâmetros, executados pelo runner
no banco isolado. A divisão por zero acontece depois do DDL, demonstrando rollback
de mudança já executada. Números dos nomes servem para ordem determinística do teste.

### Testes passo a passo

Callbacks de `test`: sem parâmetros → Promise<void>, chamados pelo Bun. Callbacks
`run` do helper recebem `{application,migrations}` → Promise<void>. Falhas propagam
e os blocos finally fecham conexões/removem apenas recursos descartáveis.

**1. Criação, aplicação, repetição, permissões e reversão (timeout 60s):**

1. Cria pasta e banco UUID; abre conexão SQL administrativa independente do ORM.
2. CLI create gera arquivo. Callback `find(name)` retorna boolean para localizar TS;
   regex extrai classe. Falta de arquivo/classe lança erro explícito.
3. Preenche up/down; CLI list inicializa histórico; SELECT pg_tables captura baseline.
4. Pending deve listar classe; up deve criar tabela e uma linha de histórico,
   confirmadas por SQL direto. List deve mostrar a migration aplicada.
5. Novo up mantém uma linha, sem duplicar CREATE TABLE.
6. Conecta MikroORM como app. Callback `transactional(transaction)` insere
   `committed` usando o EM transacional; retorno normal confirma a operação.
7. Segundo callback transacional insere `rolled-back` e lança erro; SQL direto
   encontra só `committed`. As callbacks recebem EntityManager e retornam Promise<void>.
8. App tenta DROP, CREATE e SELECT do histórico: todos devem falhar por permissões.
   Isso complementa o INSERT permitido; a credencial admin não é necessária à app.
9. Fecha ORM, executa down, compara pg_tables à baseline e exige histórico vazio.
10. Fecha SQL, remove banco descartável e pasta temporária em finally.

**2. Falha dentro do lote (timeout 30s):**

1. Cria pasta, duas classes de falha e novo banco isolado.
2. CLI up deve falhar com division by zero na segunda migration.
3. SQL direto exige ausência de batch_probe e failure_probe e zero linhas históricas.
4. Pending ainda lista a primeira. Isso prova rollback inclusive da migration
   anterior que havia executado sem erro. Finally fecha SQL e remove os recursos.

### Atualizações dos testes anteriores

[postgres.test.ts](../infra/test/postgres.test.ts) agora usa withDisposableDatabase:
o callback run cria infrastructure_probe, grava UUID parametrizado e verifica
persistência após restart/recriação com novas conexões ao banco descartável.
Finally fecha SQL; o helper remove o banco. Nenhuma tabela é criada/apagada em
wagering. Restart do serviço interrompe clientes: execute em ambiente ocioso.

[orm.test.ts](../infra/test/orm.test.ts) moveu createApplication para dentro de try;
restaura DATABASE_URL num finally aninhado, mesmo se criação/fechamento falhar.

### Evidência observada

| Verificação | Resultado |
|---|---|
| `bun run test:orm` | 2 passaram, 0 falharam, 7 expectativas |
| `bun run test:migrations` | 2 passaram, 0 falharam, 17 expectativas, cerca de 2s |
| `bun run test:infra` | 2 PostgreSQL e 4 SQS passaram, inclusive restart/recriação |
| `DATABASE_URL=... bun run check` | 24 testes passaram; typecheck e build passaram |
| Scripts raiz list/pending/up/down com banco descartável | Todos exit 0, pasta de migrations de produção vazia |
| `bun dist/main.js`, sonda HTTP real | 200 e encerramento por SIGTERM |
| Startup compilado com URL administrativa/ausente | Ambas recusadas com exit 1 e erro específico |
| Schema principal antes/depois (`pg_dump --schema-only`) | Igual, desconsiderando somente os delimitadores aleatórios restrict/unrestrict do dump |
| Consulta final de bancos `dwp_test_%` | Nenhum banco de teste restante |

O smoke compilado e os scripts raiz foram sondas adicionais fora da contagem Bun.
Nenhuma migration foi aplicada em wagering. A tabela de controle histórico permanece
após down; os dados da tabela removida não são recuperáveis por esse mecanismo.
Referência: [migrations MikroORM](https://mikro-orm.io/docs/migrations).
