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
