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

## 12. Money: um Value Object financeiro

### Valor, identidade e imutabilidade

Um **Value Object** é definido pelo conteúdo. Dois Money de 25.00 BRL são iguais
mesmo quando são objetos diferentes na memória. Não existe um id de Money a
preservar. Uma **Entity**, como a futura Wallet, tem identidade: a mesma carteira
continua sendo a mesma entidade depois que seu saldo muda.

Imutabilidade significa que a instância não muda depois de criada. Se `saldo`
representa 100.00 BRL, `saldo.subtract(aposta)` produz outro Money: quem ainda
referencia saldo continua vendo 100.00 BRL. Isso evita alterações indiretas por
compartilhamento de objetos e simplifica testar as operações.

O construtor privado impede criação direta pelo código TypeScript consumidor.
As factories são os pontos nomeados de criação: `from` valida o contrato externo,
enquanto `zero` expressa a intenção de obter o elemento neutro da soma. O domínio
não recebe instâncias de Decimal de seus consumidores nem as devolve.

### Por que string e decimal

O `number` de JavaScript usa representação binária de ponto flutuante. Frações
decimais comuns não têm representação binária finita: 0.1 + 0.2 pode produzir
0.30000000000000004. Converter esse resultado para string ou Decimal depois da
conta não desfaz a perda ocorrida antes.

Money recebe strings: `"0.10"` e `"0.20"`. decimal.js representa sinal, expoente e
dígitos decimais, sem converter a quantia inteira para um number binário. A
biblioteca usa números pequenos internamente para armazenar blocos de dígitos;
isso não equivale a representar a quantia monetária como number. Nossa API não
aceita números e não chama parseFloat, Number ou toNumber para dinheiro.

Escala e precisão são diferentes: **escala 2** é a quantidade de casas depois do
ponto; **precisão** é a quantidade de dígitos significativos da operação. Mesmo
uma biblioteca decimal pode arredondar se a precisão escolhida for insuficiente.
O limite futuro de uma coluna PostgreSQL NUMERIC(p,2) será uma decisão de
persistência; não foi criado schema financeiro nesta etapa.

### Entrada externa e resultados assinados

`Money.from` recebe somente strings não negativas com exatamente duas casas.
`"25"`, `"25.0"`, `"25.001"`, `"-25.00"`, `"-0.00"`, `"1e2"`, NaN, Infinity,
espaços, vírgulas e strings vazias são recusados; não há arredondamento para
aceitá-los. Zero é válido em Money: regras específicas sobre apostas zero
pertencerão aos respectivos contratos e regras de negócio.

Resultados internos podem ser negativos: 5.00 menos 8.00 resulta em -3.00.
`negate` também precisa representar o inverso aditivo. Isso não autoriza receber
uma aposta negativa. Serializar um resultado negativo não o transforma em uma
entrada válida: tentar reconstruí-lo com `from` é rejeitado. Não existe factory
pública `fromSigned` nem opção para desabilitar essa validação.

Money verifica aritmética e moeda. A futura Wallet deverá verificar se um débito
deixaria o saldo negativo e rejeitá-lo, além de coordenar saldo e ledger. Money,
sozinho, não garante saldo não negativo, concorrência, idempotência ou atomicidade.

### Independência do domínio

O domínio importa apenas a biblioteca de cálculo e seu erro de domínio. Não
importa NestJS, MikroORM, SQL, controller ou decorator. Uma regra como somar duas
quantias pode ser testada sem iniciar servidor, banco ou fila. Futuramente, a
infraestrutura converterá as colunas exatas de valor/moeda para Money, preservando
essa direção de dependências. O mapeamento ORM não faz parte desta entrega.

### Decisões aprovadas e garantia de precisão

O usuário aprovou precisão ajustada aos operandos e a lista inicial **BRL, USD,
EUR**, todas com duas casas. Uma lista explícita aceita somente moedas suportadas;
uma regex de três letras aceitaria códigos inexistentes. Não implementamos um
catálogo ISO completo, moedas de outras escalas ou câmbio. `currency` continua
string na assinatura de referência; a factory valida seu conteúdo em runtime.

Usamos decimal.js **10.6.0**, versão fixa em package.json e bun.lock. A proposta
antiga de bigint em centavos foi substituída pela preferência do pedido por uma
biblioteca decimal encapsulada. Bigint seria adequado para soma/subtração, mas não
é a representação de Money nesta entrega.

Em [money.ts](../src/domain/money/money.ts), `MoneyDecimal` é um construtor Decimal
clonado e não exportado. Ele fixa precision=20, ROUND_HALF_EVEN e a faixa de
expoentes da biblioteca. **A precisão 20 não é usada como teto de soma/subtração**:
construir Decimal de string não arredonda; cada operação cria outro clone com
precisão suficiente. Nenhum Decimal.set global é usado por Money.

Para calcular, formatamos os dois operandos em escala 2 e escolhemos:

```ts
const precision = Math.max(left.length, right.length) + 1;
```

Se o maior operando tem I dígitos inteiros, o resultado de soma/subtração precisa,
no máximo, de I+1 dígitos inteiros e dois fracionários: I+3 dígitos no total. O
comprimento da string já inclui I+2 dígitos e um ponto; somamos mais um para o
transporte (por exemplo 999.99 + 0.01). Um sinal negativo só aumenta essa folga.
Por isso a precisão escolhida é suficiente também para subtração de negativos,
cancelamento de valores grandes e diferenças de um centavo. Não há divisão ou
multiplicação pública para invalidar essa demonstração.

Math.max, comprimentos, escala e precisão são números de **metadados**, não
quantias monetárias. Todas as quantias continuam strings/Decimal. toFixed(2) só
formata: a entrada validada e as operações disponíveis nunca produzem frações
menores que um centavo. Não usamos arredondamento para admitir entrada inválida.
ROUND_HALF_EVEN é explícito, mas não deve descartar dígitos nessas operações.

Não estabelecemos teto monetário de negócio. Isso não significa recursos infinitos:
memória, tamanho máximo de strings e limites da biblioteca continuam existindo.
Um limite para payloads e para NUMERIC(p,2) deverá ser definido antes de expor e
persistir valores. Criar um clone por operação prioriza clareza/isolar configuração;
nenhum benchmark de desempenho financeiro foi realizado.

### Contratos, estado privado e erros

`MoneyProps` é apenas o DTO `{ amount: string; currency: string }`. Não tem métodos.
from recebe esse formato e toJSON produz um objeto novo no mesmo formato. O tipo
string não expressa sozinho a restrição de sinal: essa regra é executada por from.
Zeros redundantes à esquerda, como `00025.10`, são aceitos e serializados como
`25.10`; escala, valor e moeda não mudam. Não há trim nem uppercase para corrigir
entradas. A comparação com trim serve somente para rejeitar whitespace, inclusive
a quebra de linha final que o `$` de uma regex JavaScript poderia admitir.

`#value` é um campo privado ECMAScript, inacessível ao consumidor em runtime;
`readonly` impede reatribuição no TypeScript. Não há getter que exponha Decimal.
`currency` é pública e readonly, e Object.freeze bloqueia alteração da instância
em JavaScript. O Decimal interno não é exposto nem alterado pelas operações.

O construtor privado TypeScript desaparece como restrição no JavaScript emitido.
Por isso acrescentamos um terceiro argumento interno, `constructionToken`, um
Symbol não exportado. Só factories e operações da classe conhecem esse token.
Construção direta por Reflect.construct é recusada; criar outro Symbol com o
mesmo texto não gera a mesma identidade. Essa pequena adaptação preserva as
assinaturas públicas do README e não oferece factory pública de valores assinados.

Em [money-error.ts](../src/domain/money/money-error.ts), `MoneyErrorCode` é a união
de literais INVALID_AMOUNT, UNSUPPORTED_CURRENCY e CURRENCY_MISMATCH. O construtor
`MoneyError(code: MoneyErrorCode, message: string)` chama super(message), atribui
code e name='MoneyError' e produz um Error de domínio. Não valida regras nem chama
infraestrutura: é usado por from/assertSameCurrency e pode ser identificado por
instanceof e code. Exemplo: `Money.zero('XYZ')` lança UNSUPPORTED_CURRENCY. Os
consumidores futuros decidirão o status HTTP/resultado de negócio; isso não está
embutido na classe. Nenhum payload financeiro é incluído nas mensagens.

### Cada método de Money

As implementações abaixo ficam em [money.ts](../src/domain/money/money.ts).
Chamadores atuais são os testes; futuros chamadores serão regras de domínio.
Os métodos são síncronos. Métodos que recebem `other` exigem uma instância Money
válida; não são decodificadores de objetos JSON. Um consumidor JavaScript que
desrespeite esse contrato pode receber TypeError. Falhas de recursos/biblioteca
propagam, sem conversão para zero ou resultado aproximado.

#### `private constructor(value, currency, token)`

- Parâmetros: Decimal interno, moeda string já validada e Symbol interno.
- Resultado: uma instância Money; construtores não declaram retorno próprio.
- Fluxo: confere token; transforma qualquer zero em Decimal('0') para eliminar
  zero negativo; armazena o campo privado e a moeda; congela a instância.
- Validação/erro: token diferente lança TypeError. Valor/moeda vêm somente dos
  caminhos internos validados; não há revalidação externa que impediria negativos.
- Chamado por from, negate e #calculate. Exemplo interno: criar o resultado de
  5.00 - 8.00. Centraliza normalização de zero e imutabilidade em todos os caminhos.

#### `static from(props: MoneyProps): Money`

- Objetivo: única entrada pública para uma quantia externa.
- Fluxo: exige objeto não nulo/não array; amount deve ser string sem whitespace,
  somente dígitos, ponto e exatamente duas casas; valida a lista de moedas;
  constrói Decimal da string e Money com token interno.
- Erros: INVALID_AMOUNT para contrato/quantia inválida; UNSUPPORTED_CURRENCY
  para moeda ausente, não string ou não suportada. A validação precede Decimal.
- Exemplo: `Money.from({ amount: '25.00', currency: 'BRL' })`.
- Chamadores: consumidores e zero. Validação de runtime continua necessária
  porque TypeScript não valida JSON ou chamadas JavaScript.

#### `static zero(currency: string): Money`

- Objetivo: criar o elemento neutro com moeda explícita.
- Fluxo: delega a from com amount='0.00'; retorna nova instância a cada chamada.
- Validação/erro: reutiliza a lista e UNSUPPORTED_CURRENCY de from.
- Exemplo: `Money.zero('BRL')`. Não há singleton mutável nem moeda padrão implícita.

#### `add(other: Money): Money`

- Objetivo: somar quantias; retorna nova instância, sem alterar os operandos.
- Fluxo: delega a #calculate(other,'add'), que valida moeda e precisão antes de plus.
- Erro de domínio: CURRENCY_MISMATCH. Resultados assinados são permitidos.
- Exemplo: 0.10 BRL + 0.20 BRL → 0.30 BRL. Delegação evita duplicar a política de precisão.

#### `subtract(other: Money): Money`

- Objetivo: calcular this - other; retorna novo Money.
- Fluxo: delega a #calculate(other,'subtract'), que valida moeda e executa minus.
- Erro de domínio: CURRENCY_MISMATCH. Não lança por resultado negativo: impedir
  saldo negativo será responsabilidade da Wallet, não da subtração matemática.
- Exemplo: 5.00 BRL - 8.25 BRL → -3.25 BRL. Usa a mesma proteção de precisão de add.

#### `negate(): Money`

- Sem parâmetros; retorna nova instância com o inverso aditivo.
- Fluxo: Decimal.negated inverte somente o sinal, preservando os dígitos; constrói
  Money com a mesma moeda. O construtor normaliza zero novamente.
- Não há nova validação nem erro de domínio para estado válido.
- Exemplo: 12.34 → -12.34 → 12.34. Não precisa passar por from nem aceitar input negativo.

#### `isZero(): boolean`

- Sem parâmetros; delega a Decimal.isZero, sem alterar estado ou validar de novo.
- Exemplo: `Money.zero('BRL').isZero()` → true. Não lança erro de domínio em estado válido.
- Permite decisões de domínio sem expor Decimal nem converter valores para number.

#### `isPositive(): boolean`

- Sem parâmetros; compara Decimal com a string '0' usando greaterThan.
- Retorna true somente para quantias estritamente maiores que zero. Zero retorna false.
- Exemplo: 0.01 → true. Sem nova validação/erro de domínio.
- Preferimos comparação estrita porque o teste de sinal do Decimal também considera +0.

#### `isNegative(): boolean`

- Sem parâmetros; compara com '0' usando lessThan. Retorna true somente abaixo de zero.
- Exemplo: 0.00 - 0.01 → true; zero negado → false.
- Sem nova validação/erro de domínio. Define sinal matemático, sem expor o detalhe de -0.

#### `isLessThan(other: Money): boolean`

- Fluxo: assertSameCurrency, depois comparação Decimal.lessThan; não cria Money.
- CURRENCY_MISMATCH em moedas distintas. Mesmo valor retorna false.
- Exemplo: -3.00 BRL < 0.00 BRL → true. Não compara strings lexicograficamente.

#### `equals(other: Money): boolean`

- Fluxo: assertSameCurrency, depois Decimal.equals; retorna igualdade de valor.
- CURRENCY_MISMATCH em moedas distintas, inclusive para zeros; não retorna false
  silenciosamente, seguindo a regra de operações entre moedas do README.
- Exemplo: duas instâncias distintas de 25.00 BRL → true. Evita igualdade por referência.

#### `toJSON(): MoneyProps`

- Sem parâmetros; retorna objeto novo com amount=Decimal.toFixed(2) e currency.
- Não expõe Decimal nem uma referência guardada. Sem nova validação/erro de domínio.
- Exemplo: JSON.stringify(Money.zero('BRL')) → `{"amount":"0.00","currency":"BRL"}`.
- Chamado explicitamente ou por JSON.stringify. Mantém duas casas e evita notação científica.
  Um resultado negativo mantém seu sinal; isso não o torna válido para from.

#### `toString(): string`

- Sem parâmetros; formata amount com toFixed(2), espaço e moeda.
- Exemplo: `25.00 BRL`. Sem nova validação/erro de domínio.
- Usado para apresentação/diagnóstico; o contrato de transporte continua sendo toJSON.
  Não é parser nem formato locale que troque ponto por vírgula.

#### `private assertSameCurrency(other: Money): void`

- Compara currency das duas instâncias; retorna undefined quando iguais.
- Lança CURRENCY_MISMATCH se diferentes. Chamado por #calculate, equals e isLessThan.
- Exemplo: 25.00 BRL e 25.00 USD são recusados. Centraliza a regra sem implementar câmbio.

#### `#calculate(other: Money, operation: 'add' | 'subtract'): Money`

- Helper privado em runtime, chamado somente por add/subtract.
- Fluxo: valida moeda; formata os dois valores; calcula a precisão pelo comprimento;
  clona MoneyDecimal; cria Decimal do operando esquerdo; executa plus ou minus
  com o direito; encapsula resultado em novo Money com a moeda original.
- CURRENCY_MISMATCH antes da conta; falhas técnicas de recursos/configuração
  propagam. Não captura falha para arredondar ou devolver um valor parcial.
- Exemplo: 999.99 + 0.01 → 1000.00. O clone local evita alterar configuração global
  ou de instâncias anteriores e dá espaço para o dígito adicional do resultado.

### Exemplo completo: quantia inicial, aposta e prêmio

Este exemplo exercita somente aritmética; não processa uma aposta nem cria Wallet:

```ts
const initial = Money.from({ amount: '100.00', currency: 'BRL' });
const stake = Money.from({ amount: '25.00', currency: 'BRL' });
const prize = Money.from({ amount: '40.50', currency: 'BRL' });
const afterStake = initial.subtract(stake);
const afterPrize = afterStake.add(prize);
// initial.toString()    → '100.00 BRL'
// afterStake.toString() → '75.00 BRL'
// afterPrize.toJSON()   → { amount: '115.50', currency: 'BRL' }
```

Uma futura Wallet validará moeda, valor permitido da operação e saldo suficiente,
e só então adotará um novo saldo junto ao ledger. Este exemplo não afirma que
essa coordenação ou persistência exista.

### O que cada teste comprova

[money.test.ts](../test/money.test.ts) usa Bun e a classe real, sem mocks.
Callbacks de test são síncronas, sem argumentos e retorno void. Em test.each,
recebem o caso descrito abaixo e retornam void; falhas de expect propagam ao runner.
As funções passadas a toThrow executam a operação para que o runner capture seu
erro. Casts de unknown existem somente nos testes para simular JSON/runtime inválido.

| Teste/grupo | Parâmetro e prova |
|---|---|
| creates a value object | Sem parâmetro; moeda, DTO e apresentação de 25.00 BRL |
| adds decimal fractions | Sem parâmetro; 0.10 + 0.20 = 0.30 e subtração inversa |
| subtracts exactly | Sem parâmetro; diferença positiva/negativa e recomposição do valor |
| negation reverses sign | Sem parâmetro; sinal invertido, dupla negação e soma com inverso igual a zero |
| compares signed amounts | Sem parâmetro; instâncias distintas iguais, desigualdade, ordenação estrita e negativos |
| classifies positive, negative and zero | Sem parâmetro; três predicados em cada classe de sinal e normalização de zero |
| rejects invalid external decimal syntax (26 casos) | amount string; vazio/whitespace, NaN/Infinity, expoentes, escala, sinais, separadores e outros formatos recusados |
| rejects non-string runtime amounts (7 casos) | Objeto com amount desconhecido; números, null, undefined, objeto e array não sofrem coerção |
| rejects malformed runtime contracts (5 casos) | Objeto com input desconhecido; contrato nulo, ausente, incompleto, array ou string é recusado |
| does not admit a signed internal result | Sem parâmetro; serializar negativo não permite reenviá-lo à factory externa |
| all arithmetic returns new instances | Sem parâmetro; add/subtract/negate criam referências novas e preservam ambos os operandos, inclusive operações com zero |
| freezes public state | Sem parâmetro; alteração do input/DTO não altera Money e Reflect.set não modifica a instância |
| JSON serialization | Sem parâmetro; JSON estável para positivo, negativo interno e zero, sempre duas casas |
| example: initial amount | Sem parâmetro; 100.00 - 25.00 + 40.50 = 115.50, preservando estados anteriores |
| supports currency (3 casos) | currency string; BRL/USD/EUR funcionam e zero tem mesma moeda/escala |
| rejects unsupported currencies (10 casos) | currency desconhecida; formato inválido e códigos não suportados falham em from e zero |
| different currencies (4 casos) | Nome do método add/subtract/isLessThan/equals; BRL/USD são recusados nas duas ordens |
| domain failures have stable codes | Sem parâmetro; três callbacks run criam erros diferentes, capturados com classe/name/code esperados; expect.assertions(9) impede sucesso se não houver throw |
| canonicalizes leading zeros | Sem parâmetro; 00025.10 vira 25.10 sem alterar valor/escala |
| private construction at runtime | Sem parâmetro; Reflect.construct sem token ou com Symbol diferente não contorna a factory |
| preserves cents with large values (3 casos) | Quantidade de dígitos 25/100/1000; strings de noves, transporte, empréstimo, cancelamento, negativos e centavo exato |
| external Decimal configuration | Sem parâmetro; reduz precisão/faixa global do Decimal, demonstra que Money permanece exato e restaura configuração em finally |

O loop do teste de imutabilidade só compara referências dos resultados. O loop
de erros executa os três callbacks run e verifica o código de cada falha. No teste
grande, String.repeat recebe uma contagem, nunca uma quantia monetária; resultados
esperados são strings construídas independentemente da aritmética decimal.

Durante a implementação, test.each interpretou arrays como listas de argumentos
(inclusive um array vazio como callback com done). Corrigimos os casos envolvendo
arrays usando objetos `{ amount }`/`{ input }`, garantindo que o valor inválido
chegue intacto à factory. O import default funcionava no runtime Bun, mas não no
typecheck NodeNext; usamos o export nomeado `{ Decimal }`, sem relaxar o strict.

Referências: [API decimal.js](https://mikemcl.github.io/decimal.js/),
[implementação/documentação oficial](https://github.com/MikeMcl/decimal.js).

### Comandos e resultados observados nesta etapa

Com Bun 1.4.3 no PATH e infraestrutura local disponível para as regressões:

```bash
bun install --frozen-lockfile
bun test ./test/money.test.ts
DATABASE_URL=postgresql://wager_app:local_app_only@127.0.0.1:55432/wagering bun run check
bun run test:infra
bun run test:orm
bun run test:migrations
```

| Verificação | Resultado real |
|---|---|
| Instalação frozen | 168 instalações/169 pacotes verificados; sem alterações |
| Money isolado | 73 passaram, 0 falharam; 167 expectativas |
| check | Typecheck passou; 97 testes passaram, 0 falharam; build passou |
| PostgreSQL | 2 passaram; inclui persistência após restart/recriação em banco descartável |
| SQS | 4 passaram; inclui recebimento, ACK, redrive e restart/recriação |
| ORM | 2 passaram; integração Nest/SQL e credencial restrita |
| Migrations | 2 passaram; CLI, up/down/repetição e rollback do lote |

Total de casos distintos na rodada completa: **107**, dos quais **73 são novos de
Money**. A execução isolada de Money repete esses mesmos casos, não acrescenta 73
à contagem. Money não usa banco ou mocks; as regressões de persistência/SQS usam
os serviços reais em Docker. Não foi criada migration de domínio nesta etapa.

Também executamos o exemplo com `bun --eval`, importando a classe compilada de
`./dist/domain/money/money.js`. Resultados:

```text
100.00 BRL
75.00 BRL
{"amount":"115.50","currency":"BRL"}
0.30 BRL
```

Isso verifica o mesmo exemplo na saída ESM do build, não apenas no TypeScript do
test runner. Encerramos esta etapa em Money; o próximo item do plano é o modelo
imutável de lançamento de ledger, antes da Wallet, sujeito a nova autorização.

## 13. WalletLedgerEntry: histórico financeiro imutável

### Auditoria inicial e escopo

Partimos da branch main limpa, no commit `85a0ba8` de Money. README oficial e
interfaces reais foram conferidos. Money já oferece soma, subtração, comparação,
predicados de sinal e imutabilidade; seus fontes e testes não foram alterados.
Não criamos Wallet, transação de aposta, repositório, endpoint, worker ou migration.

O README §6.4 pede um registro com identidade, moeda/quantias encapsuladas em
Money e duas factories. Seguimos as assinaturas; createdAt passou de campo Date
para getter Date, preservando o acesso `entry.createdAt` e protegendo o estado.
O enum usa os nomes do esqueleto `LedgerDirection.Debit`/`Credit`, cujos valores
são `DEBIT`/`CREDIT`. Não é um enum de operações BET/WIN/LOSS.

### Ledger, saldo e Wallet

**Ledger** é o histórico de movimentos efetivos. Cada entrada responde: qual
carteira, qual transação, qual direção, quanto, qual saldo antes/depois e quando?
O **saldo atual** é um valor materializado para consulta e tomada de decisão.
O histórico permite reconstruí-lo e investigar como ele foi alcançado.

Exemplo: abertura CREDIT 100.00 (0.00 → 100.00), aposta DEBIT 25.00
(100.00 → 75.00), prêmio CREDIT 40.50 (75.00 → 115.50). O saldo atual é 115.50;
o ledger contém os três fatos que explicam esse saldo. Esses movimentos são
exemplos; não há processamento de apostas nesta classe.

**Wallet** será o agregado responsável por autorizar mudanças de saldo e produzir
o lançamento correspondente. **WalletLedgerEntry** é um registro desse efeito,
com identidade e sem transições. É diferente de Money, um Value Object definido
por valor/moeda. Não implementamos partidas dobradas, opcionais no README.

Registros imutáveis mantêm a trilha histórica: uma correção deve ser uma operação
compensatória explícita, não uma alteração silenciosa do fato anterior. Auditoria
financeira envolve rastrear transações, conferir equações, procurar duplicatas,
reconstruir saldos e comparar com o saldo materializado. Esta classe possibilita
conferir uma linha; não implementa reconciliação de toda a carteira.

Uma operação rejeitada não mudou o saldo, portanto não deve gerar uma entrada de
movimentação. Seu motivo continuará auditável na futura WagerTransaction. LOSS
também não move dinheiro. Esta classe não recebe status/kind e não consegue
verificar essas regras sozinha: o futuro caso de uso e o banco precisarão garanti-las.

### create e rehydrate têm responsabilidades diferentes

**create** valida estrutura e a equação da movimentação. Para débito, before -
money deve ser exatamente after; para crédito, before + money deve ser after.
Não arredonda nem corrige um saldo incorreto. Movimento é estritamente positivo;
ambos os saldos são não negativos e as três quantias têm a mesma moeda.

**rehydrate** reconstrói dados persistidos, sem executar novamente essa equação,
autorizar aposta, verificar saldo atual ou produzir efeitos. Não chama create.
Mantém verificações estruturais permanentes: campos/tipos válidos, identificadores,
direção, data válida, instâncias Money, moeda única, movimento positivo e saldos
não negativos. Nesta implementação, sinais e moeda definem um estado admissível
de registro; a equação representa a transição que create valida.

Um estado positivo e da mesma moeda com 100.00 - 25.00 = 74.99 pode ser reidratado:
`isBalanced()` retorna false e os valores originais permanecem disponíveis para
diagnóstico. create recusa esse mesmo estado. Isso é deliberado e testado.
Rehydrate é uma fronteira de persistência confiável, não um caminho de aceitação
de comandos externos; o futuro repositório não deverá inserir objetos arbitrários
reidratados para contornar create. A constraint SQL também rejeitará essa equação.

Alternativa de rehydrate delegar a create repetiria a validação da transição,
contrariando a separação do README. Alternativa de aceitar qualquer objeto sem
checagem permitiria estado inutilizável. As validações estruturais escolhidas não
comprovam procedência do dado nem substituem a integridade do banco.

### Campos, data e identidade

Em [wallet-ledger-entry.ts](../src/domain/wallet/wallet-ledger-entry.ts),
`LedgerEntryState` é interface readonly com os oito campos exigidos.
`CreateLedgerEntryProps` é alias desse formato: criação e reconstrução têm os
mesmos dados, mas semânticas diferentes; não duplicamos interfaces idênticas.

IDs são strings opacas, não vazias, sem whitespace ou controles ASCII. Não
normalizamos com trim nem geramos IDs na factory. O README usa string e não exige
UUID; impor uma versão de UUID agora acoplaria uma decisão futura de geração e
persistência. `entry-1` e UUIDs válidos podem ser usados. Existência, unicidade e
pertencimento das referências não podem ser comprovados por esta classe isolada.

O chamador fornece createdAt: não usamos relógio global, garantindo testes
determinísticos e preservação do instante na reidratação. Aceitamos Date finita;
não rejeitamos uma data por ser futura/passada, pois isso seria outra regra.
Internamente guardamos `#createdAtMilliseconds`, um número de tempo, **não dinheiro**.
Cada acesso a createdAt devolve novo Date. Congelar um Date sozinho não impede
setTime/setUTCFullYear de alterar seu instante, daí a cópia defensiva.

Os sete outros campos são readonly; Object.freeze impede reatribuição, remoção
e redefinição na instância em runtime. Money já é imutável, então pode ser
compartilhado sem clonagem ou acesso a Decimal. Alterar DTO de Money não o altera.
O construtor privado também recebe Symbol interno, como Money, para impedir
construção direta via JavaScript/Reflect. Não há setters ou métodos de transição.
Classes/protótipos não são uma sandbox contra código arbitrário malicioso no processo.

### Cada função, método e factory

Todos os métodos abaixo são síncronos. Chamadores atuais são os testes; os
chamadores de aplicação/persistência descritos são futuros. Falhas técnicas de
Money/recursos propagam; não são convertidas em saldo zero ou lançamentos válidos.

#### LedgerEntryError.constructor(code, message)

Arquivo: [ledger-entry-error.ts](../src/domain/wallet/ledger-entry-error.ts).
Recebe `LedgerEntryErrorCode` e mensagem string; produz Error de domínio. Chama
super(message), guarda code readonly e define name='LedgerEntryError'. Não faz
validação financeira nem importa framework. Usado pelo validador e por create.

Códigos: INVALID_STATE, INVALID_IDENTIFIER, INVALID_DIRECTION, INVALID_MONEY,
INVALID_CREATED_AT, NON_POSITIVE_MOVEMENT, NEGATIVE_BALANCE, CURRENCY_MISMATCH,
UNBALANCED_ENTRY. Permitem ao consumidor distinguir causas sem interpretar texto.
Exemplo: movimento zero lança NON_POSITIVE_MOVEMENT. Não há taxonomia de falhas
de apostas nem mapeamento HTTP nesta etapa; mensagens não incluem payload financeiro.

#### WalletLedgerEntry.constructor(state, token)

Arquivo: [wallet-ledger-entry.ts](../src/domain/wallet/wallet-ledger-entry.ts).
Privado; recebe LedgerEntryState e o Symbol interno. Construtor produz a instância,
sem anotação explícita de retorno. Primeiro recusa token diferente com TypeError;
depois chama #assertState, copia os sete campos, extrai getTime e congela this.
Chamado exclusivamente pelas factories. Erros estruturais propagam como
LedgerEntryError. Não retém o objeto state nem o Date recebidos. Exemplo: a factory
constrói o lançamento entry-1 sem manter uma referência mutável ao DTO de entrada.

#### static create(props: CreateLedgerEntryProps): WalletLedgerEntry

Cria novo fato válido. Instancia pelo construtor, executa isBalanced e retorna o
registro somente quando true. False lança UNBALANCED_ENTRY; os erros estruturais
do construtor continuam possíveis. A instância temporária inválida não é entregue.
Será usada pela Wallet para produzir entradas. Exemplo: DEBIT 25.00 sobre 100.00,
com after 75.00, é aceito; after 74.99 é recusado. Não escolhe IDs/data, não altera
saldo da Wallet, não grava banco nem verifica unicidade entre objetos.

#### static rehydrate(state: LedgerEntryState): WalletLedgerEntry

Recebe estado previamente persistido e devolve nova instância com mesmos dados.
Chama apenas o construtor; não chama create/isBalanced. Pode lançar os erros
estruturais, mas não UNBALANCED_ENTRY. Será usada pelo mapeador do repositório,
que converterá colunas exatas em Money. Exemplo: conserva id/data e saldo 74.99
de um registro divergente para inspeção; isBalanced revela false. Não conserta
nem reaplica a operação histórica.

#### get createdAt(): Date

Sem parâmetros; retorna `new Date(this.#createdAtMilliseconds)`. Sem novas
validações ou erros de domínio, pois o instante já foi validado. Usado por
consumidores/mapeadores. Exemplo: `entry.createdAt.setTime(0)` modifica apenas
a cópia, e uma leitura seguinte continua devolvendo o instante original.
A assinatura de leitura do README permanece Date; não criamos um Value Object de tempo.

#### isBalanced(): boolean

Sem parâmetros. Escolhe subtract para Debit ou add para Credit, sempre com Money,
e compara o resultado com balanceAfter por equals. Retorna true/false sem mutar
estado. Chamado por create, testes e futura auditoria. Não reexecuta #assertState:
direção/tipos/moedas já foram validados pelo construtor. A comparação exata não
usa tolerância nem conversão para number. Exemplo: 0.10 + 0.20 = 0.30 é true.
Este método verifica a equação local, não a continuidade do ledger inteiro.

#### static #assertState(state: LedgerEntryState): void

Helper privado em runtime, chamado pelo construtor nas duas factories. Retorna
undefined se válido. Ordem: exige objeto não nulo/não array; percorre os três
IDs e valida strings; confere direction; valida Date/getTime finito; percorre
money/balanceBefore/balanceAfter exigindo instanceof Money; compara moedas;
exige money.isPositive; rejeita saldos com isNegative. Cada falha lança o código
correspondente descrito acima; a primeira falha interrompe o fluxo.
Não usa duck typing de DTO monetário nem recria Money de uma quantia negativa.
Exemplo: `{ money: { amount: '25.00', currency: 'BRL' } }` é recusado; o chamador
deve fornecer Money real. Não consulta serviços nem valida transições passadas.

### Exemplo executável de aposta e prêmio

```ts
const at = new Date('2026-10-22T12:00:00.000Z');
const debit = WalletLedgerEntry.create({
  id: 'entry-bet', walletId: 'wallet-1', transactionId: 'tx-bet',
  direction: LedgerDirection.Debit,
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
  balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
  balanceAfter: Money.from({ amount: '75.00', currency: 'BRL' }),
  createdAt: at,
});
const credit = WalletLedgerEntry.create({
  id: 'entry-win', walletId: debit.walletId, transactionId: 'tx-win',
  direction: LedgerDirection.Credit,
  money: Money.from({ amount: '40.50', currency: 'BRL' }),
  balanceBefore: debit.balanceAfter,
  balanceAfter: Money.from({ amount: '115.50', currency: 'BRL' }),
  createdAt: at,
});
// debit.isBalanced() → true; credit.isBalanced() → true
// credit.balanceAfter.toString() → '115.50 BRL'
```

A mesma data é permitida: timestamps não são identificadores únicos nem garantem
ordem de commit. O exemplo compõe registros; não executa BET/WIN de verdade.

### Testes e helpers

Arquivo: [wallet-ledger-entry.test.ts](../test/wallet-ledger-entry.test.ts).
`amount(value: string, currency='BRL'): Money` chama Money.from; usado para montar
fixtures legíveis e propaga MoneyError. `state(overrides: Partial<LedgerEntryState>
= {}): LedgerEntryState` cria uma fixture nova (DEBIT 25, 100 → 75, IDs e data fixos)
e sobrepõe campos; cada chamada cria Date/Money independentes. Não valida overrides:
isso permite exercitar entradas inválidas. `expectCode(run: () => unknown, code):
void` executa callback, captura erro e exige classe/name/code. Se não houver erro,
o próprio expect falha; não há falso sucesso por ausência de throw.

Callbacks test comuns não recebem argumentos e retornam void. Os test.each recebem
direction, currency, field ou objeto de caso conforme a tabela. Casts nos casos
inválidos simulam runtime/JSON, não enfraquecem os tipos de produção. Falhas de
assertion propagam ao Bun; não há mocks de Money, Nest ou PostgreSQL.

| Teste/grupo | O que comprova |
|---|---|
| Débito válido | Todos os campos, identidade/data e equação 100 - 25 = 75 |
| Crédito de prêmio | 75 + 40.50 = 115.50, preservando saldo anterior |
| Abertura e débito até zero | Crédito desde zero permitido; débito que zera saldo permitido |
| Equação incorreta (2 direções) | create rejeita; rehydrate preserva e isBalanced retorna false |
| 19 casos inválidos × 2 factories | Direção inválida, zero/negativo de negate/subtract, saldos negativos, moeda divergente em cada posição, data inválida e tipo Money incorreto |
| 4 estados malformados × 2 factories | Null, undefined, array e string rejeitados |
| 3 campos de ID × 2 factories | Para cada campo: vazio, espaços, controles, null, undefined e number recusados sem normalização |
| Imutabilidade × 2 factories | Reflect.set em todos os campos, remoção/redefinição, mutação do input, Date original/retornado e DTO monetário não alteram o registro |
| Reidratação válida | Nova referência, mesmos IDs, direção, Money e instante, equação true |
| Decimais × BRL/USD/EUR | 0.10 + 0.20 = 0.30 e débito inverso sem erro binário |
| Valor grande | Soma de um centavo com transporte além de 30 dígitos preservada |
| Construção direta | Reflect.construct sem token ou com outro Symbol lança TypeError |
| Grafo de dependências | Percorre imports reais do modelo e dependências de domínio; único pacote externo permitido é decimal.js |

No teste de dependências, callback async retorna Promise<void>. Lê fontes com
readFile; ts.preProcessFile extrai imports; uma pilha pending e Set visited evitam
repetição; resolve imports relativos .js para fontes .ts e exige caminho dentro
de src/domain. Imports de pacote devem ser decimal.js. Falhas de leitura/import
ou assertions fazem o teste falhar. TypeScript/fs/path são dependências do teste,
não do domínio. Esse teste cobre o grafo estático de imports, não constitui sandbox
de execução de código arbitrário. O suite isolado executa sem iniciar Nest/ORM.

### Integração e garantias futuras do PostgreSQL

Uma transação SQL agrupará aquisição do lock por wallet, leitura/validação,
atualização do saldo e inserção do lançamento, além de transação/inbox/outbox
quando aplicáveis. Se o INSERT falhar, deve haver rollback também do saldo.
Se tudo passar, commit torna o conjunto persistido. Nenhum evento será publicado
antes disso. Atomicidade precisa de uma transação compartilhada; chamadas SQL
independentes não garantem o conjunto. O lock já aprovado protege a disputa entre
processos, algo que esta classe imutável em memória não resolve.

O schema futuro precisará de PK do id; NOT NULL; UNIQUE(transaction_id,wallet_id);
FKs sem exclusão em cascata do histórico; valores exatos e finitos, movimento > 0,
saldos >= 0, direction válida e CHECK da equação. Uma moeda por linha pode
representar as três quantias; deve também corresponder à wallet/transação.
CHECK local não prova correspondência entre tabelas, ausência de ledger para
LOSS/rejeitadas nem existência de ledger para toda alteração de saldo. Esses
requisitos exigirão desenho de escrita controlada/constraints apropriadas e
testes SQL diretos. Não basta afirmar que a aplicação sempre chama create.

Planejar índice (wallet_id, created_at, id) para extrato com desempate estável;
isso não prova ordem causal. A sequência de movimentos/versão da Wallet será
definida junto ao schema. UNIQUE já fornece índice próprio, sem duplicação inútil.
Imutabilidade persistente precisará bloquear UPDATE/DELETE/TRUNCATE, inclusive
caminhos indiretos; privilégios e proteção SQL serão testados com o papel da app.
O papel de execução não será dono/superusuário. Nenhuma dessas constraints,
índices ou políticas financeiras foi criada ou validada nesta etapa.

Referências: [transações PostgreSQL 17](https://www.postgresql.org/docs/17/tutorial-transactions.html),
[constraints PostgreSQL 17](https://www.postgresql.org/docs/17/ddl-constraints.html).

### Validação observada — 22/10/2026

Primeira rodada: os testes de domínio passaram, mas o setup HTTP falhou com
`ECONNREFUSED 127.0.0.1:55432`. `docker compose ps` mostrou os serviços parados.
Executamos `docker compose up -d --wait --wait-timeout 120`, preservando o volume;
PostgreSQL e LocalStack ficaram healthy. Nenhum código foi alterado para esconder
a falha. Depois repetimos a rodada completa:

```bash
export PATH="$PWD/.tools/node_modules/.bin:$PATH"
bun test ./test/wallet-ledger-entry.test.ts
DATABASE_URL=postgresql://wager_app:local_app_only@127.0.0.1:55432/wagering bun run check
bun run test:infra
bun run test:orm
bun run test:migrations
```

| Comando/verificação | Resultado real |
|---|---|
| Suite isolado WalletLedgerEntry | 66 passaram, 0 falharam, 422 expectativas; sem conexão a serviços |
| check | Typecheck aprovado; 163 testes passaram, 0 falharam, 626 expectativas; build aprovado |
| test:infra | 2 PostgreSQL + 4 SQS passaram, incluindo restart/recriação |
| test:orm | 2 passaram, integração real Nest/SQL e restrição de credencial |
| test:migrations | 2 passaram, migrations/rollback reais em bancos descartáveis |
| Exemplo compilado | Débito/crédito equilibrados, data preservada e divergência reidratada detectada |

Total final: **173 casos distintos**, incluindo os **66 novos** e todos os **73 de
Money**. A execução isolada repete casos e não é somada novamente. Testes existentes
não foram modificados; Money e dependências/lockfile permaneceram iguais.

O exemplo foi executado com `bun --eval` importando Money e WalletLedgerEntry de
dist/domain. A saída observada foi:

```text
DEBIT 100.00 BRL 75.00 BRL true
CREDIT 75.00 BRL 115.50 BRL true
2026-10-22T12:00:00.000Z
rehydrated mismatch: false
```

A data foi impressa depois de `debit.createdAt.setTime(0)`, mostrando que só a
cópia foi alterada. A última linha consulta isBalanced no estado reidratado com
after 74.99. Nenhuma dessas sondas grava lançamento financeiro no PostgreSQL.
Diff revisado, links locais conferidos e hash do README oficial original preservado.
Próxima etapa: Wallet Aggregate Root, somente após autorização; não implementada.

## 14. Wallet Aggregate Root: saldo e lançamento por uma única operação de domínio

### Auditoria e decisão de abertura

Partimos de main limpa no commit `89bd638`. Conferimos o README e os fontes de
Money/WalletLedgerEntry. Ambos foram reutilizados **sem modificações**. Não há
nova dependência, migration, controller, worker, WagerTransaction ou caso de uso
BET/WIN/LOSS nesta etapa. Os nomes de aposta/prêmio nos exemplos dão contexto à
aritmética; não representam processamento persistente implementado.

Foi apresentada a alternativa de open retornar apenas Wallet e delegar todo o
lançamento ao caso de uso. O usuário aprovou o contrato **{ wallet, openingEntry }**:
saldo positivo exige IDs de transação/lançamento e retorna CREDIT em memória;
saldo zero retorna null, sem movimento. Assim o domínio não entrega uma abertura
positiva pelo caminho open sem produzir o lançamento correspondente. Nenhuma
transação OPENING é simulada ou marcada como persistida.

### Aggregate Root, Entity e Value Object

Um agregado reúne estado e regras que precisam permanecer consistentes. Sua
**Aggregate Root** é a porta pública para as mudanças: o chamador solicita debit
ou credit, em vez de alterar balance e tentar lembrar de todas as verificações.
Wallet é essa raiz. Ela coordena Money, saldo/version/data e a criação do registro
financeiro correspondente; não carrega uma lista ilimitada de lançamentos antigos.

Wallet é uma **Entity** porque tem identidade: wallet-1 continua sendo wallet-1
depois de gastar 25.00. Money é um **Value Object**: 100.00 BRL e 75.00 BRL são
valores diferentes; a subtração produz outro objeto. WalletLedgerEntry é um
registro com identidade e sem transições. A Wallet muda por métodos; o registro
retornado de uma mudança anterior continua intacto.

Um setter balance permitiria criar dinheiro, pular validação de moeda, deixar
saldo negativo, esquecer ledger ou version. Por isso o saldo é um getter de Money
imutável. debit/credit pertencem ao domínio porque expressam essas regras, que
devem ser as mesmas independentemente de entrada HTTP, fila ou outro caso de uso.
O domínio não abre conexão, não publica evento e não depende de NestJS/MikroORM.

### Contratos e adaptação das assinaturas

Em [wallet.ts](../src/domain/wallet/wallet.ts), os contratos são interfaces readonly:

| Tipo | Campos e finalidade |
|---|---|
| WalletState | id, playerId, currency, balance: Money, version: number, createdAt/updatedAt: Date; entrada da reidratação |
| OpenWalletProps | id, playerId, initialBalance: Money, at: Date, opening?: {ledgerEntryId,transactionId}; entrada de abertura |
| WalletOpeningResult | wallet: Wallet e openingEntry: WalletLedgerEntry ou null; resultado da abertura |
| WalletMovementProps | ledgerEntryId, transactionId, money: Money, at: Date; dados para débito/crédito |
| WalletMovementResult | entry: WalletLedgerEntry e walletVersion: number; resultado imutável de uma movimentação aceita |
| MutableState (interno) | balance, version, updatedAtMilliseconds; snapshot readonly substituído por inteiro a cada sucesso |

open difere do esqueleto ao retornar o par aprovado e receber at/IDs de abertura.
debit/credit recebem identidades e instante porque ledger exige esses campos.
Retornam lançamento e versão daquele movimento: ler wallet.version muito depois
poderia observar outra operação. Saldo anterior/posterior, moeda, data e identidade
da wallet já estão no lançamento, sem duplicação no resultado.

Objetos resultado são Object.freeze. O par de abertura contém uma referência à
Wallet **mutável por métodos**, não um snapshot permanente do saldo; openingEntry
é o registro imutável da abertura. Não há lista de eventos ou Unit of Work de domínio.

### Ordem de execução e ausência de estado parcial

O helper #applyMovement é síncrono e segue esta sequência:

1. Valida objeto de entrada, Money, moeda e movimento estritamente positivo.
2. Valida Date e disponibilidade de próxima versão representável exatamente.
3. Em débito, verifica saldo suficiente antes da subtração.
4. Calcula novo Money por subtract/add, mantendo a referência do saldo antigo.
5. Chama **WalletLedgerEntry.create real**, que valida IDs, sinais e equação.
6. Prepara/congela o próximo snapshot e o resultado {entry,walletVersion}.
7. Faz uma única atribuição `this.#state = nextState` e retorna o resultado pronto.

Toda validação, cálculo e alocação está antes do passo 7. Se a criação do ledger
falhar, ainda não houve atribuição ao estado. Não precisamos desfazer três campos
mutados sequencialmente nem capturar erro para corrigir saldo. Após a substituição
não há callback, await, I/O, validação ou nova alocação no fluxo do método.

Os testes passam ID inválido à factory **real** do ledger: ela lança depois do
cálculo e a Wallet conserva saldo, versão e datas. Isso demonstra a ordem por seu
efeito observável; não usamos mock de sucesso/falha para substituir Money ou ledger.
Falhas de validação anteriores também são comparadas com snapshot completo.

Essa garantia vale para a conclusão/falha de uma chamada no objeto em memória.
Não fornece durabilidade, transação entre processos nem recuperação de crash.
Se o processo morrer após alterar memória, não há commit SQL implícito.

### Versão, datas e proteção do estado

Version começa em **1**, inclusive em abertura financiada. open constrói o CREDIT
diretamente; não chama credit, o que incrementaria indevidamente a versão inicial.
Cada movimento aceito é positivo e muda o saldo exatamente, portanto incrementa
uma vez. Zero/negativo são rejeitados; rejeições não mudam version nem updatedAt.

Version é inteiro positivo seguro de JavaScript; isso é metadado, não dinheiro.
Rehydrate rejeita valores fracionários, não finitos e acima de MAX_SAFE_INTEGER.
Uma wallet já no máximo rejeita movimento com VERSION_EXHAUSTED antes de mudar
estado. Esse limite técnico evita perder incrementos; não define o tipo SQL futuro.

IDs/currency são readonly e a superfície da Wallet é congelada. Os campos privados
ECMAScript continuam acessíveis aos métodos da classe mesmo com Object.freeze:
congelar a superfície não torna o agregado inteiro imutável. #state só é trocado
pelo helper; seus próprios campos são congelados. Token Symbol não exportado
protege também o construtor em JavaScript. Não é sandbox contra código malicioso
com controle arbitrário do processo ou protótipos.

createdAt/updatedAt guardam instantes numéricos privados e getters retornam Date
novos. Alterar a entrada ou a cópia devolvida não altera a Wallet. createdAt nunca
muda; updatedAt recebe o instante fornecido em cada sucesso. Não usamos Date.now.
Seguindo o contrato temporal do ledger, aceitamos Date válido, sem pressupor
monotonicidade de relógio: instantes podem ser iguais ou recuar. Isso não transforma
timestamp em ordem de commit. Version acompanha as mudanças locais; a futura
aplicação deverá escolher o relógio de processamento e o schema definirá sequência.

### Cada função, factory, getter e helper

As funções de produção abaixo ficam em [wallet.ts](../src/domain/wallet/wallet.ts),
exceto WalletError. Seus chamadores atuais são testes; Wallet será chamada por
casos de uso, e rehydrate por um mapeador de persistência, ambos ainda futuros.
Não se aceita DTO monetário no lugar de Money. Inputs tipados ainda recebem
validação runtime para chamadas JavaScript/dados indevidos.

#### WalletError.constructor(code, message)

Arquivo: [wallet-error.ts](../src/domain/wallet/wallet-error.ts). Recebe
WalletErrorCode e string, chama super(message), guarda code readonly e define
name='WalletError'. Produz Error de domínio, sem validação de negócio própria.
Usado pelas factories/helpers; consumidores podem decidir por code, sem analisar
mensagens nem depender de HTTP. Exemplo: INSUFFICIENT_FUNDS para débito excessivo.

Códigos: INVALID_STATE, INVALID_IDENTIFIER, INVALID_MONEY, NEGATIVE_BALANCE,
CURRENCY_MISMATCH, INVALID_DATE, INVALID_VERSION, VERSION_EXHAUSTED,
NON_POSITIVE_MOVEMENT, INSUFFICIENT_FUNDS e INVALID_OPENING_CONTEXT. Erros do
WalletLedgerEntry, como INVALID_IDENTIFIER, propagam como LedgerEntryError:
não escondemos sua origem nem inventamos um resultado de sucesso. Falhas técnicas
de recursos/decimal também propagam, antes da troca de estado.

#### private constructor(state: WalletState, token)

Recebe estado e Symbol interno; retorna a instância por construção, sem tipo de
retorno explícito. Valida token, objeto, IDs, Money não negativo, igualdade da
moeda com balance, versão segura positiva e datas. Copia IDs/moeda/createdAt,
monta #state congelado e congela this. Não retém o objeto de entrada nem os Dates.
Chamado por open/rehydrate. Token incorreto lança TypeError; campos inválidos
lançam os códigos correspondentes de WalletError. Exemplo: versão 7 pode ser
restaurada, sem se tornar 1 ou produzir sete lançamentos.

#### static open(props: OpenWalletProps): WalletOpeningResult

Valida objeto/saldo inicial, deriva moeda do Money e constrói Wallet com versão 1
e as duas datas iguais a at. Se saldo positivo, exige opening como objeto e cria
um CREDIT de zero até o saldo inicial com IDs fornecidos. Se zero, opening deve
estar ausente e o lançamento é null. Congela e retorna o par somente quando tudo
passa. Exemplo: 100.00 BRL produz CREDIT 100.00 e wallet.version=1.

Erros: objeto/saldo/identidade/data inválidos; saldo negativo; contexto de abertura
ausente/malformado em abertura positiva ou presente em abertura zero; IDs de
lançamento inválidos rejeitados pelo ledger. Uma instância local construída antes
de falhar o ledger não é exposta ao chamador. Não chama rehydrate/credit, gera
transação ou toca no banco. Será usada pelo caso de uso de abertura atômica.

#### static rehydrate(state: WalletState): Wallet

Delega ao construtor e retorna uma nova instância com saldo, versão e instantes
preservados. Só valida estado estrutural: não chama open, não exige IDs OPENING,
não recria ledger nem reaplica regras de débito passadas. Exemplo: saldo 100.00,
version 7 continua assim até uma próxima operação. Erros estruturais são os do
construtor. O futuro mapeador só deve usar este caminho para dados persistidos
confiáveis; não é alternativa para financiar carteiras sem histórico.

#### get balance(): Money

Sem parâmetros, devolve #state.balance, já imutável. Não precisa copiar Money;
não há nova validação/erro de domínio. Usado por consumidores e #applyMovement.
Exemplo: `wallet.balance.add(valor)` cria outro Money, não credita a Wallet.
Isso permite leitura sem oferecer um setter de saldo.

#### get version(): number

Sem parâmetros, retorna #state.version; não incrementa nem consulta banco.
Usado por aplicação e testes. Exemplo: retorna 2 após primeiro movimento aceito.
Sem validação nova ou erro de domínio; o valor foi validado na criação/transição.

#### get createdAt(): Date / get updatedAt(): Date

Sem parâmetros; cada um retorna new Date do seu instante privado. Não validam
de novo nem lançam erro de domínio em estado válido. Usados por consumidores e
futuro mapeador. Exemplo: `wallet.updatedAt.setTime(0)` modifica somente a cópia.
createdAt é fixo; updatedAt reflete o último movimento aceito pelo objeto.

#### debit(props: WalletMovementProps): WalletMovementResult

Delega a #applyMovement com LedgerDirection.Debit. O helper valida moeda/valor,
saldo suficiente e ledger, depois confirma estado. Exemplo: saldo 100.00,
movimento 25.00 → saldo 75.00 e entrada DEBIT; excesso → INSUFFICIENT_FUNDS.
Retorna entrada e versão do sucesso. Qualquer erro do helper/ledger propaga sem
efeito parcial. Será usado pelo caso de uso após resolver transação e concorrência.

#### credit(props: WalletMovementProps): WalletMovementResult

Delega a #applyMovement com Credit; exige valor positivo/mesma moeda, sem teste
de insuficiência. Exemplo: 75.00 + 40.50 → 115.50 e CREDIT. Retorno e erros seguem
o helper. Não classifica a operação como WIN/REFUND/OPENING nem publica eventos.
Essa classificação pertence à futura transação e camada de aplicação.

#### private assertSameCurrency(money: Money): void

Compara money.currency com this.currency; retorna undefined se iguais ou lança
CURRENCY_MISMATCH. Chamado por #applyMovement depois de validar instanceof Money.
Exemplo: débito USD numa Wallet BRL é recusado, sem conversão cambial.

#### #applyMovement(props, direction): WalletMovementResult

Helper privado em runtime, usado por debit/credit com direção já determinada.
Recebe WalletMovementProps e LedgerDirection. Executa os sete passos da seção de
atomicidade acima, devolvendo resultado congelado. Valida objeto, Money, moeda,
positividade, data, capacidade da versão e saldo em débito. IDs de transação e
lançamento são validados pela factory real do ledger, antes de qualquer mutação.
Erros possíveis incluem WalletError e LedgerEntryError. Exemplo: ID de ledger
vazio falha após cálculo, deixando o saldo original e a versão intactos.

O resultado é preparado antes da troca de #state. Não há lista interna de
lançamentos: o futuro caso de uso deve persistir o resultado junto da Wallet.
Chamadas duplicadas não são deduplicadas em memória; idempotência persistente e
UNIQUE(transaction_id,wallet_id) ainda precisarão existir no banco.

#### static #assertObject(value: unknown): void

Exige objeto não nulo/não array. Usado por construtor, open e #applyMovement.
Retorna undefined ou INVALID_STATE. Exemplo: null é recusado antes de acessar
balance. Não valida todos os campos; cada etapa valida os que utiliza.

#### static #assertIdentifier(value: string, field: string): void

Exige string não vazia sem whitespace/controles ASCII, sem trim ou geração de ID.
Chamado pelo construtor para id/playerId. Retorna undefined ou INVALID_IDENTIFIER,
com nome do campo, sem incluir conteúdo do payload. Exemplo: 'player-1' aceito,
' player-1' rejeitado. Mantém política de IDs opacos já usada no ledger.

#### static #assertBalance(value: Money): void

Exige instanceof Money e !isNegative. Chamado por open e construtor; retorna
undefined ou INVALID_MONEY/NEGATIVE_BALANCE. Zero é permitido. Exemplo: Money
negativo produzido por negate não pode entrar como saldo inicial/persistido.

#### static #timestamp(value: Date): number

Exige Date e getTime finito; retorna os milissegundos ou lança INVALID_DATE.
Chamado pelo construtor e #applyMovement. Exemplo: Date inválido rejeitado antes
de alterar estado. Não representa dinheiro nem consulta relógio atual.

### Exemplo completo: abertura, aposta, prêmio e rejeição

```ts
const { wallet, openingEntry } = Wallet.open({
  id: 'wallet-1', playerId: 'player-1',
  initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  at: new Date('2026-10-22T12:00:00Z'),
  opening: { ledgerEntryId: 'entry-opening', transactionId: 'tx-opening' },
});
const debit = wallet.debit({
  ledgerEntryId: 'entry-bet', transactionId: 'tx-bet',
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
  at: new Date('2026-10-22T12:01:00Z'),
});
const credit = wallet.credit({
  ledgerEntryId: 'entry-win', transactionId: 'tx-win',
  money: Money.from({ amount: '40.50', currency: 'BRL' }),
  at: new Date('2026-10-22T12:02:00Z'),
});
// openingEntry: CREDIT 0.00 → 100.00; versão inicial 1
// debit.entry: DEBIT 100.00 → 75.00; debit.walletVersion=2
// credit.entry: CREDIT 75.00 → 115.50; credit.walletVersion=3
// wallet.balance = 115.50 BRL; wallet.version = 3
```

Uma tentativa seguinte de debitar 200.00 lança INSUFFICIENT_FUNDS: saldo continua
115.50, versão continua 3 e updatedAt continua 12:02. O lançamento anterior não
muda. O exemplo não cria WagerTransaction nem comprova que os IDs existam no banco.

### Persistência futura: não deixar saldo financiado sem histórico

O resultado de open obriga o caminho de domínio a produzir o CREDIT, mas um objeto
em memória não consegue impedir que um programador descarte openingEntry ou use
rehydrate indevidamente. A garantia persistente precisará do seguinte protocolo:

1. Caso de uso inicia a transação SQL e reserva identidades internas.
2. Chama open; se houver openingEntry, cria a WagerTransaction OPENING com o mesmo
   transactionId, valor, carteira e moeda.
3. Insere Wallet, OPENING e ledger na **mesma transação**; abertura zero insere
   Wallet sem OPENING/ledger. Inclui Outbox quando essa parte existir.
4. Faz commit somente se todo o conjunto passar. Erro provoca rollback do conjunto.

Banco exigirá UNIQUE(player_id,currency), não negatividade, chaves estrangeiras,
unicidade do lançamento por transação/carteira e proteção do ledger, além do
desenho entre tabelas que impeça saldo sem lançamento. FK sozinha não obriga uma
wallet a ter ledger; a correspondência exigirá constraint diferida/caminho SQL de
escrita controlado, a decidir no schema e provar por tentativas SQL diretas.

Se uma transação SQL falhar **depois** que Wallet.debit/credit retornou, PostgreSQL
não reverte automaticamente o objeto JavaScript. O caso de uso deverá descartar
essa instância/transação de trabalho e recarregar estado antes de retry. Não
reutilizar uma Wallet já alterada após rollback. Não introduzimos compensação em
memória, repositório ou Unit of Work próprio para antecipar essa camada.

### Concorrência: o que esta etapa não garante

No mesmo objeto, cada chamada síncrona observa seu estado atual. Duas cópias
carregadas com 100.00/version 7 podem ambas debitar 80.00 e chegar localmente a
20.00/version 8. Um teste explícito demonstra isso; não é um teste de concorrência
distribuída nem uma solução de race condition.

O lock pessimista por carteira já aprovado será adquirido na linha PostgreSQL
dentro da transação, antes de ler/decidir o saldo. Outra transação da mesma wallet
aguardará e avaliará o estado confirmado; wallets diferentes poderão avançar.
Version é metadado útil, mas incrementar um contador local não adquire lock nem
faz comparação condicional no banco. Não implementamos nenhum lock nesta etapa.

Transação SQL protege o conjunto persistido; lock protege a disputa concorrente;
constraints protegem as invariantes contra caminhos de escrita indevidos. Nenhum
desses papéis é substituído por Object.freeze, FIFO, getters ou um contador local.

### Testes: helpers, callbacks e evidências por cenário

Arquivo: [wallet.test.ts](../test/wallet.test.ts). Nenhum mock de Money, ledger ou
banco; testes de domínio não acessam infraestrutura. `money(amount,currency='BRL')`
retorna Money.from e propaga MoneyError. `opening(overrides={})` retorna
OpenWalletProps novos para saldo 100.00 com IDs/data fixos; `persisted(overrides={})`
retorna WalletState novo com saldo 100.00/version 7 e datas fixas;
`movement(overrides={})` retorna WalletMovementProps de 25.00 com IDs/data fixos.
Os três recebem Partial do contrato, retornam objetos sem validar overrides e
são usados para criar casos válidos/ inválidos, sem compartilhamento mutável de Date.

`snapshot(wallet)` retorna DTO com IDs, moeda, saldo serializado, versão e datas
ISO. É usado para comparar todo o estado observável antes/depois de erros.
`expectCode(run: () => unknown, code: WalletErrorCode): void` executa callback,
captura erro e exige instanceof/name/code; ausência de throw faz expect falhar.
Os helpers são síncronos; erros de setup/assertions propagam ao Bun.

Callbacks test retornam void, sem argumentos. test.each recebe o campo/valor/caso
da tabela. Loops de métodos ('debit','credit') e factories ('open','rehydrate')
registram os mesmos contratos relevantes para ambos. Casts existem nos testes
para simular input runtime inválido; não são usados para contornar produção.

| Grupo | Prova |
|---|---|
| Abertura zero e positiva | Version 1, identidades/datas, moeda derivada, null ou CREDIT equilibrado de zero ao saldo |
| Contexto de abertura | Positiva sem objeto válido é rejeitada; zero com IDs de movimento é rejeitada; IDs inválidos falham no ledger |
| Inicial negativo | Money negativo interno não é admitido como saldo |
| Três moedas/decimais | 0.10 + 0.20 = 0.30 e débito inverso em BRL/USD/EUR |
| Débito e crédito encadeados | Saldo, direção, IDs, instante e versão correspondem ao lançamento; resultados anteriores não mudam |
| Débito exato/insuficiente | Zerar saldo é válido; excesso é INSUFFICIENT_FUNDS sem mudanças, inclusive após sucesso anterior |
| Oito inputs inválidos × dois métodos | Zero, negativo, moeda, DTO/money ausente e datas inválidas deixam todo estado intacto |
| Erro real de ledger × dois IDs × dois métodos | Factory falha depois do cálculo; saldo/versão/data preservados; operação seguinte válida funciona |
| Versão máxima e último incremento | Não há arredondamento/overflow do contador nem mutação após esgotá-lo |
| Inputs malformados | Null, undefined, array e string rejeitados em operações/factories |
| Reidratação | Preserva identidade/saldo/version/datas sem replay de abertura; primeira operação usa versão restaurada |
| Versão/estado inválidos | Rejeita versão não segura/positiva, saldo negativo, moeda divergente/ausente, DTO de saldo |
| IDs | Cada ID é validado sem geração, trim ou normalização |
| Imutabilidade externa | Não é possível atribuir saldo/versão/IDs/datas; mutações das entradas, Dates devolvidos e DTO monetário não alteram estado |
| Datas em sucessos | updatedAt acompanha o instante fornecido e createdAt permanece; timestamp não é relógio monotônico |
| Valores grandes | 100 dígitos inteiros e centavo com transporte/subtração exatos |
| Duas cópias | Demonstra que versão sozinha não resolve conflito entre instâncias |
| Token | Reflect.construct sem token correto não cria Wallet |
| Dependências | Grafo estático de imports permanece em domain e decimal.js; sem Nest/MikroORM |

No último teste, callback async retorna Promise<void>: readFile lê cada fonte;
ts.preProcessFile extrai imports; pending/visited percorrem sem repetir; resolve
converte imports .js relativos para fontes .ts e exige caminho dentro de domain.
Pacote externo só pode ser decimal.js. Erros de leitura/assertions propagam.
TypeScript, fs/path/url são utilizados apenas pelo teste, não pela Wallet.

Referências para a camada futura:
[transações PostgreSQL](https://www.postgresql.org/docs/17/tutorial-transactions.html),
[locks por linha](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS).

### Validação observada da Wallet — 22/10/2026

```bash
export PATH="$PWD/.tools/node_modules/.bin:$PATH"
bun test ./test/wallet.test.ts
DATABASE_URL=postgresql://wager_app:local_app_only@127.0.0.1:55432/wagering bun run check
bun run test:infra
bun run test:orm
bun run test:migrations
```

| Verificação | Resultado real |
|---|---|
| Wallet isolada | 81 passaram, 0 falharam; 490 expectativas |
| check | Typecheck aprovado; 244 testes passaram, 0 falharam; 1116 expectativas; build aprovado |
| PostgreSQL/SQS | 2 + 4 passaram; serviços reais, inclusive reinícios/recriação |
| ORM | 2 passaram |
| Migrations | 2 passaram, somente bancos descartáveis |

Total da rodada: **254 casos distintos**, incluindo **81 novos**. O comando isolado
repete esses casos e não entra duas vezes no total. Money e WalletLedgerEntry,
incluindo seus testes, não foram modificados. Nenhuma regressão ou falha foi
observada nesta rodada; os serviços já estavam healthy na auditoria inicial.

Também executamos com `bun --eval` o exemplo importando Wallet e Money compilados
de dist/domain. Saída real:

```text
OPEN 100.00 BRL 1 CREDIT true
DEBIT 75.00 BRL 2 true
CREDIT 115.50 BRL 3 true
INSUFFICIENT_FUNDS 115.50 BRL 3 2026-10-22T12:02:00.000Z
```

True verifica isBalanced no lançamento; a última linha comprova preservação de
saldo/version/updatedAt após débito rejeitado de 200.00. Essa sonda usa classes
reais compiladas; não grava Wallet, OPENING ou ledger no banco. A etapa termina
aqui: próxima proposta é WagerTransaction, seguida do desenho de persistência e
constraints, ambos sujeitos a autorização antes de desenvolvimento.

## 15. WagerTransaction — identidade, referências e ciclo de vida

### Escopo, auditoria e decisões aprovadas

Partimos da branch main limpa no commit bdd274a (Wallet). Lemos as seções 6.3 e 7
no contexto do README completo e inspecionamos as interfaces reais de Money,
WalletLedgerEntry e Wallet. Money é imutável, compara valores exatamente e pode
produzir negativos internamente; a transação deve validar seu sinal. Nenhum desses
três modelos nem seus testes precisou ser modificado. Esta etapa implementa apenas
a entidade em memória, sem processamento, persistência financeira ou endpoints.

O usuário aprovou três decisões que o esqueleto não fechava:

1. OPENING/BET/WIN/REFUND/ROLLBACK exigem Money positivo; LOSS exige zero. Uma Wallet
   pode abrir com zero, mas nesse caso não existe transação OPENING.
2. WIN admite referência opcional a BET processada; o valor do prêmio pode diferir.
   BET/LOSS/OPENING não recebem referência. markProcessed recebe a entidade da
   referência, permitindo inspecionar os vínculos em vez de confiar num ID opaco.
3. PENDING pode aguardar referência uma vez; ambos os estados pendentes podem terminar.
   Não há retorno para PENDING nem repetição de markPendingReference.

As alternativas e os limites estão na ADR-011. A adaptação adicional de
ledgerDirectionFor para retornar null representa naturalmente a ausência de ledger.
createOpening é uma factory interna explícita; não introduz autenticação nem escolhe
metadados fictícios. O futuro caso de uso fornecerá providerId/roundId/gameId internos
segundo o contrato a definir. Os adaptadores externos não poderão usar essa factory.

### Kind não é status: máquina de estados

Kind descreve **qual operação** foi pedida: apostar, premiar, registrar perda ou
reverter. Status descreve **onde ela está** no processamento. Uma BET continua BET
quando é rejeitada. Uma máquina de estados restringe quais mudanças são possíveis;
não permite atribuir qualquer string a status.

```mermaid
stateDiagram-v2
    [*] --> PENDING: create ou createOpening
    PENDING --> PENDING_REFERENCE: referência externa preenchida
    PENDING --> PROCESSED: markProcessed
    PENDING_REFERENCE --> PROCESSED: markProcessed
    PENDING --> REJECTED: reject
    PENDING_REFERENCE --> REJECTED: reject
    PENDING --> FAILED: fail
    PENDING_REFERENCE --> FAILED: fail
```

PROCESSED, REJECTED e FAILED são terminais. Todos os seus métodos de transição
lançam InvalidTransactionStateError, inclusive tentar marcar PROCESSED novamente.
Isso preserva o resultado auditável e evita que um retry altere uma decisão anterior.
O futuro replay deve carregar e devolver o resultado original, inclusive o saldo
daquela operação, sem aplicar outra movimentação.

| Kind | Valor | Referência | Efeito quando processada |
|---|---|---|---|
| OPENING | positivo | proibida; criação interna | crédito de abertura |
| BET | positivo | proibida | débito |
| WIN | positivo | opcional; BET processada | crédito do prêmio |
| LOSS | zero | proibida | registra resultado, sem ledger |
| REFUND | positivo | BET processada, valor integral | crédito de devolução |
| ROLLBACK | positivo | BET/WIN/REFUND processada, valor integral | inverso da referência |

Exemplo: Wallet com 100.00 BRL, BET de 25.00 deixa 75.00; WIN de 40.50 deixa
115.50. LOSS não debita novamente: a aposta já produziu o débito. REFUND da BET
credita os mesmos 25.00. ROLLBACK da BET também credita 25.00; ROLLBACK de WIN
40.50 debita 40.50; ROLLBACK de REFUND 25.00 debita 25.00. Esses cálculos explicam
a regra; WagerTransaction não possui saldo nem aplica essas movimentações.

### Referências, ordem de chegada e limites locais

O ID externo identifica a operação no provedor. O ID interno identifica nossa linha.
Não são intercambiáveis: a futura consulta será por `(providerId, externalId)`;
após validação, markProcessed registra `reference.id` no referenceTransactionId.
Provider, jogador, wallet, moeda e rodada devem coincidir. Isso impede, por exemplo,
devolver a aposta de outro jogador ou associar um prêmio de outra rodada. O gameId
é preservado, mas não acrescentamos igualdade dele à regra oficial de referência.

REFUND/ROLLBACK só aceitam o valor integral exato; Money.equals só é chamado depois
de conferir a moeda. WIN pode premiar 99.99 sobre uma BET de 25.00. O fato de sua
referência ser opcional não permite ignorá-la quando veio preenchida.

Um REFUND que chega primeiro nasce PENDING. Sem referência resolvida, processá-lo
lança REFERENCE_REQUIRED; uma referência existente ainda pendente gera
REFERENCE_NOT_PROCESSED. O futuro caso de uso chama markPendingReference, persiste
e agenda nova tentativa. Quando a BET estiver PROCESSED, poderá concluir o REFUND.
Se a referência estiver REJECTED/FAILED, é inválida, não uma aposta aplicada.
A entidade lança INVALID_REFERENCE; a aplicação escolhe registrar a rejeição.
Nenhum erro de validação muda status automaticamente.

Contagem de tentativas, TTL, backoff e agendamento ainda não existem. Ao esgotar a
política futura, o caso de uso poderá usar reject(ReferenceNotFound). A entidade
conhece o código e exige uma referência externa, mas não pode provar que as
consultas/tentativas ocorreram. Da mesma forma, DuplicateReversal não implica
consulta: a unicidade global dependerá do banco e do caminho transacional.

### Falhas, identidade e idempotência

REJECTED significa decisão de negócio: a operação não pode ser aplicada. FAILED
significa falha permanente de infraestrutura, auditável. Não se deve marcar FAILED
por qualquer timeout transitório; após resultado de commit desconhecido, consultar
o resultado antes de decidir. Rejeições/falhas não geram ledger.

| FailureCode | Onde pode ser registrado | Exemplo / responsabilidade futura |
|---|---|---|
| INSUFFICIENT_FUNDS | reject em BET | apostar 80.00 com saldo 20.00 |
| REVERSAL_INSUFFICIENT_FUNDS | reject em ROLLBACK | desfazer prêmio de 50.00 com saldo 10.00; REFUND só credita |
| REFERENCE_NOT_FOUND | reject quando existe referência externa solicitada | esgotamento de tentativas/TTL verificado pelo caso de uso |
| INVALID_REFERENCE | reject quando existe referência externa solicitada | jogador/rodada diferente ou referência terminal sem sucesso |
| DUPLICATE_REVERSAL | reject em REFUND/ROLLBACK | banco identifica outra reversão bem-sucedida do mesmo tipo |
| DOMAIN_RULE_VIOLATION | reject em qualquer kind | regra de domínio sem código específico; preferir específico quando existir |
| PERMANENT_INFRASTRUCTURE_FAILURE | fail exclusivamente | erro permanente comprovado; não simples falha transitória |
| IDEMPOTENCY_CONFLICT | admissão/API futura, nunca reject/fail da transação original | mesma chave, conteúdo diferente |

Esses códigos são strings estáveis para máquina, sem números HTTP. Erros de uso da
classe são WagerTransactionError/InvalidTransactionStateError: não equivalem a um
resultado persistido automaticamente. INVALID_REFERENCE existe como erro local e
como FailureCode; o primeiro informa validação, o segundo registra decisão explícita.

idempotencyKey identifica a submissão; payloadHash representa seu conteúdo canônico
futuro. matchesPayload apenas compara strings exatas. Não normaliza JSON nem calcula
hash. Mesma key e mesmo hash poderão ser replay; mesma key com hash diferente é
conflito, preservando o resultado original. A entidade sozinha não procura outra
transação pela key e não impede duplicata em outro processo. Identidade externa e
key precisarão de constraints distintas conforme o README.

### Contratos e métodos de produção, um a um

Todos os métodos abaixo pertencem a `src/domain/wagering/wager-transaction.ts`,
exceto os erros e enum indicados. Tipos monetários são Money; nenhum number guarda
dinheiro. number nos snapshots representa apenas milissegundos de Date.

**Tipos e configuração:** WagerTransactionKind e WagerTransactionStatus são enums
com os valores oficiais. CreateWagerTransactionProps contém IDs/hash (string), kind,
money (Money), referência externa opcional (string), createdAt (Date).
CreateOpeningTransactionProps omite kind e referência externa. WagerTransactionState
adiciona status, referenceTransactionId/failureCode/processedAt opcionais. Campos
opcionais de lifecycle aceitam explicitamente undefined para reinicialização na
factory sob exactOptionalPropertyTypes. Lifecycle é o snapshot privado readonly:
status e valores internos opcionais, com tempo em epoch. O Symbol constructionToken
fica só no módulo e impede new via JavaScript sem a factory; TypeScript private
sozinho desaparece na compilação. Não é sandbox contra alteração do próprio código.

**constructor(state: WagerTransactionState, token: symbol) → WagerTransaction.**
Chamado somente pelas factories. Primeiro compara o token, depois valida estrutura;
copia identidade e Money imutável; converte datas; congela o snapshot; valida a
coerência do lifecycle e congela o objeto público. Token incorreto dá TypeError;
dados incorretos dão WagerTransactionError. Não chama Wallet, banco ou transições.
Object.freeze protege propriedades públicas, enquanto o campo #lifecycle continua
substituível exclusivamente pelos métodos da classe.

**create(props: CreateWagerTransactionProps) → WagerTransaction.** Futura admissão
HTTP/SQS e testes chamam esta factory. Confere objeto; recusa kind OPENING com
INTERNAL_ONLY_KIND; copia os dados e força PENDING, sem referência interna, failureCode
ou processedAt. Campos de lifecycle injetados por JS não tornam a operação processada.
O construtor valida os demais dados. Não gera IDs/hash/datas. Exemplo: BET com Money
25.00 BRL nasce PENDING, ainda sem qualquer débito real.

**createOpening(props: CreateOpeningTransactionProps) → WagerTransaction.** Futuro
caso de uso de abertura chama esta factory com metadados internos e Money positivo.
Confere objeto, recusa kind diferente de OPENING ou referência externa inesperada
(INTERNAL_ONLY_KIND), força OPENING/PENDING e apaga campos de resultado injetados.
Reutiliza o construtor; zero dá INVALID_AMOUNT. Abertura zero de Wallet não chama
esta factory. A escolha torna a origem interna explícita sem criar uma camada de
autenticação nesta etapa.

**rehydrate(state: WagerTransactionState) → WagerTransaction.** Futuros mapeadores
carregam snapshots persistidos. Chama o construtor com token; admite todos os estados
coerentes, incluindo OPENING e PROCESSED com uma referência que não está carregada.
Não chama create, markProcessed, Wallet ou resolução de referências. IDs, enums,
Money/sinal, datas e coerência dos campos são verificações estruturais; não refaz
transições, saldo, igualdade com outra transação ou busca de duplicidade. Corrupção
estrutural lança erros em vez de silenciosamente reconstruir um objeto impossível.

**get status() → WagerTransactionStatus; get referenceTransactionId() → string | undefined;
get failureCode() → FailureCode | undefined.** Consultas de casos de uso, mapeadores
e testes; não recebem parâmetros. Leem valores primitivos do snapshot privado, sem
setters, mudanças ou exceções normais. Referência interna só aparece em PROCESSED;
falha só em REJECTED/FAILED.

**get createdAt() → Date; get processedAt() → Date | undefined.** Sem parâmetros;
retornam novas instâncias a partir do epoch. processedAt preserva undefined e aceita
epoch zero. Caso de uso/mapeador/testes consultam. Alterar o Date retornado não altera
a entidade; o mesmo vale para o Date recebido na criação/processamento. Não há relógio
oculto nem validação de ordem temporal entre máquinas.

**markProcessed(reference: WagerTransaction | undefined, at: Date) → void.** Futura
orquestração chama depois de validar condições do processamento, dentro da unidade
transacional a projetar. Primeiro bloqueia terminal, valida at, valida referência;
só então troca #lifecycle por PROCESSED com reference.id, sem failureCode e com epoch
de at. Sem referência externa exige undefined. Erros INVALID_DATE, REFERENCE_REQUIRED,
REFERENCE_NOT_PROCESSED ou INVALID_REFERENCE preservam TODO o estado anterior.
Terminais sempre dão InvalidTransactionStateError antes de validar parâmetros.
Não aplica saldo nem cria ledger: a conclusão durável dependerá do commit SQL.

**markPendingReference() → void.** Sem parâmetros; caso de uso chama quando precisa
aguardar a referência. Bloqueia terminal, exige PENDING e referência externa preenchida;
troca apenas o status. Qualquer outra origem dá InvalidTransactionStateError, incluindo
repetir a espera. Consultar status em retries evita transições repetidas. Exemplo:
REFUND de uma BET que ainda não chegou.

**reject(code: FailureCode) → void.** Caso de uso registra decisão de negócio. Bloqueia
terminal, valida código adequado ao kind/contexto e substitui status/failureCode.
Não exige relógio nem introduz rejectedAt fora do modelo. INVALID_FAILURE_CODE não
muda nada. Exemplo: BET sem saldo → INSUFFICIENT_FUNDS. Verifica a compatibilidade
do código, mas não calcula saldo, duplicidade ou TTL.

**fail(code: FailureCode) → void.** Caso de uso registra falha permanente, depois
de resolver a situação da tentativa anterior. Bloqueia terminal, aceita somente
PERMANENT_INFRASTRUCTURE_FAILURE e troca status/failureCode. Outro código dá
INVALID_FAILURE_CODE sem mutação. Não publica evento nem tenta recuperação automática.

**isTerminal() → boolean.** Sem parâmetros; consulta os três estados terminais.
Usado por #assertMutable, validação da referência, casos de uso e testes. Nenhum I/O
ou erro normal. Exemplo: PENDING_REFERENCE retorna false, REJECTED retorna true.

**affectsBalance() → boolean.** Sem parâmetros; false em LOSS/REJECTED/FAILED, true
nos outros kinds enquanto pendentes ou processados. Chamado por ledgerDirectionFor
e futuros casos de uso. É descrição de efeito potencial ou já ocorrido, não licença
para processar novamente nem prova de referência disponível. Não lança normalmente.

**requiresReference() → boolean.** Sem parâmetros; true só em REFUND/ROLLBACK, usado
na validação de valor integral/código de falha e pelos chamadores externos. WIN continua
false mesmo se uma referência opcional foi preenchida; nesse caso #assertReference
ainda exige sua resolução. Não lança normalmente.

**matchesPayload(payloadHash: string) → boolean.** Futura admissão compara o hash
recebido com o armazenado usando igualdade estrita. Não muta, não lança em divergência,
não calcula hash nem decide status. Exemplo: `opaque-hash` igual → true; maiúsculas,
espaço ou outro conteúdo → false. Parâmetro é string já produzido/validado pela borda.

**ledgerDirectionFor(reference?: WagerTransaction) → LedgerDirection | null.** Futura
orquestração consulta qual método de Wallet chamar. Retorna null imediatamente para
operações sem efeito. Para demais, valida referência, retorna DEBIT em BET, inverso
do kind alvo em ROLLBACK, CREDIT nos demais. Não navega recursivamente a referência
de um REFUND: sabe que REFUND processado creditou. Pode lançar os erros de referência;
não altera estado, não verifica saldo e não retorna lançamento. Exemplo: ROLLBACK de
WIN processada → DEBIT; saldo insuficiente dessa reversão será verificado depois.

**#assertMutable() → void.** Helper privado sem parâmetros; chamado primeiro por todas
as transições. Usa isTerminal e lança InvalidTransactionStateError se true. Não muda
estado. Justificativa: o resultado terminal não pode depender do conteúdo de um retry.

**#assertReference(reference: WagerTransaction | undefined) → void.** Chamado por
markProcessed e ledgerDirectionFor. Sem external ID, recusa alvo inesperado. Com ID,
exige entidade, confere identidade externa, impede autoreferência interna, preserva
ID interno já registrado, compara os quatro IDs de escopo e a moeda, valida kind,
valor integral se reversão e status PROCESSED. Falta de entidade → REFERENCE_REQUIRED;
alvo pendente válido → REFERENCE_NOT_PROCESSED; demais incompatibilidades →
INVALID_REFERENCE. Não busca banco nem escreve. A ordem evita comparar Money de
moedas diferentes e reporta vínculo inválido antes de sugerir espera por ele.

**#assertRejectionCode(code: FailureCode) → void.** Chamado por reject e validação de
snapshots REJECTED. Confere a matriz de códigos acima usando kind e presença de
referência externa. Incompatibilidade/undefined/valor desconhecido →
INVALID_FAILURE_CODE. Não verifica a evidência externa da rejeição; isso pertence ao
caso de uso. Evita persistir IDEMPOTENCY_CONFLICT na operação original.

**#assertLifecycle() → void.** Chamado somente no construtor. Verifica enum status;
processedAt existe se e somente se PROCESSED; referenceTransactionId só existe em
PROCESSED e corresponde à presença da referência externa; PENDING_REFERENCE exige
referência externa; código deve corresponder a REJECTED/FAILED e estar ausente nos
demais. Lança INVALID_STATE ou INVALID_FAILURE_CODE. Não executa transições, não
consulta alvo e não exige que o histórico esteja disponível para reidratar.

**static #assertStructure(state: WagerTransactionState) → void.** Construtor chama:
confere objeto, nove strings obrigatórias, kind conhecido, instância Money, sinal
conforme kind, datas válidas, formato das referências e proibição de self reference.
Exige referência externa para reversões e a proíbe em BET/LOSS/OPENING. Não normaliza
identificadores nem impõe UUID. Erros: INVALID_STATE/IDENTIFIER/KIND/MONEY/AMOUNT/DATE/
REFERENCE e REFERENCE_REQUIRED. São limites de representação, sem refazer efeito
financeiro. Delega aos três helpers simples abaixo.

**static #assertObject(value: unknown) → void.** Factories de criação e validação
estrutural usam para recusar null/undefined/primitivos/arrays com INVALID_STATE.
Não verifica todos os campos; só permite continuar a inspeção segura do objeto.

**static #assertIdentifier(value: unknown) → void.** Validação estrutural usa para
IDs, key e hash opacos. Exige string não vazia sem whitespace/controles ASCII;
INVALID_IDENTIFIER em falha. Não trim, não gera UUID, não infere algoritmo de hash.
Exemplo: `provider-a:ext-1` preservado; ` ext-1` recusado. Limites máximos de tamanho
serão definidos com contratos/persistência.

**static #assertDate(value: unknown) → void.** Estrutura e markProcessed usam para
exigir Date com getTime finito; string ou Invalid Date dá INVALID_DATE. Não altera
o Date, não compara com o relógio atual. Retorno void; epoch zero é válido.

**WagerTransactionError.constructor(code: WagerTransactionErrorCode, message: string).**
Arquivo `src/domain/wagering/wager-transaction-error.ts`. Chama Error, guarda code
readonly, define name. Helpers/factories o lançam; testes e futuros casos de uso
inspecionam code, não a frase. Não traduz para HTTP nem altera a entidade.

**InvalidTransactionStateError.constructor(message: string).** Mesmo arquivo;
subclasse que fixa INVALID_TRANSACTION_STATE e name específico. Usada por transições
ilegais; permite instanceof conforme o esqueleto oficial. Erro de programação em
replay terminal não deve se transformar em segunda decisão de negócio.

**FailureCode**, em `src/domain/wagering/failure-code.ts`, é enum sem funções ou I/O.
Distingue resultados persistidos de conflito de admissão, conforme a tabela. Nenhum
código representa status HTTP. WagerTransactionErrorCode é união de strings para
violações locais; não precisa de uma hierarquia adicional por cada campo inválido.

### Como a aplicação futura coordenará os modelos

Um futuro caso de uso abrirá uma transação PostgreSQL, identificará a operação e
seu resultado anterior, obterá o lock da wallet, carregará referências e validará
unicidade/escopo. Para uma operação nova apta a processar, consultará a direção e
chamará debit ou credit em Wallet, recebendo o ledger correspondente. LOSS pula a
movimentação. A conclusão de WagerTransaction e a gravação de Wallet, ledger,
resultado original, Inbox quando aplicável e Outbox ocorrerão no mesmo commit.

Se qualquer etapa falhar, o rollback SQL impede persistência parcial. Objetos
mutados em memória não são automaticamente desfeitos pelo PostgreSQL: o caso de uso
deverá descartá-los/recarregá-los em retry. Nenhum evento será publicado antes do
commit. Não conectamos esses passos nesta etapa nem alegamos atomicidade financeira.

Futuramente o banco deverá proteger unicidade de key e identidade externa, ledger
por transação/wallet, sucesso único por referência/tipo, não-negatividade e
imutabilidade de ledger/terminais. Uma rejeição não deve consumir a possibilidade
de uma reversão válida posterior. Sem schema, dois objetos independentes podem
validar a mesma reversão; há um teste explícito desse limite, não um cache simulando
proteção global. Locks serão por wallet, nunca globais.

### Guia dos helpers e de cada teste

Arquivo único: `test/wager-transaction.test.ts`. Os testes importam as classes reais
com Bun, sem mocks de Money/Wallet/Ledger nem simulação de PostgreSQL. Cada callback
de teste retorna void (ou Promise<void> no teste de dependências), é chamado pelo
runner, e falha se uma expectativa divergir. `test.each` expande parâmetros de
matriz em casos independentes; os nomes abaixo identificam essas famílias. Cada
linha descreve entrada, fluxo, erro/retorno esperado e por que a proteção existe.

| Helper | Parâmetros / retorno | Fluxo, dependências, erros e chamadores |
|---|---|---|
| money | amount: string = 25.00, currency: string = BRL → Money | chama Money.from; fixtures usam valores exatos; propaga MoneyError se fixture inválida |
| props | patch: Partial<CreateWagerTransactionProps> = {} → props completos | fornece IDs, hash opaco, Money e Date determinísticos e aplica patch; testes variam só a condição relevante; depende de money |
| state | patch: Partial<WagerTransactionState> = {} → snapshot | props + PENDING + patch; usado em rehidratação/fixtures; não valida, pois alguns testes precisam de corrupção deliberada |
| target | kind: Kind = BET, patch: Partial<State> = {} → entidade | constrói snapshot PROCESSED com outra identidade; LOSS zero e reversões com vínculo persistido; rehydrate real pode lançar se a fixture for inválida; usado em matrizes de referência |
| dependent | kind: Kind = REFUND, patch: Partial<Props> = {} → entidade | cria operação com reference-ext; create real valida; testes de dependência usam/reforçam erros reais |
| snapshot | tx: WagerTransaction → objeto com campos/JSON/datas/status | captura dados públicos e getters sem expor estado privado; testes comparam antes/depois para provar ausência de mutação; não altera a entidade |
| expectCode | run: () => unknown, code: ErrorCode → void | executa e captura erro, exige WagerTransactionError + code; para estado inválido exige a subclasse; falha na asserção se não houve erro; usado em testes negativos |

Fixtures são exemplos de snapshots locais, não evidência de linhas no PostgreSQL.
`target` reidrata uma REFUND processada sem carregar sua própria BET: esse cenário
exercita justamente a separação entre reidratar e reexecutar transições.

| Teste / família (nome no código) | Parâmetros, passos e resultado validado |
|---|---|
| creates ${kind} as PENDING with preserved identity, Money and no outcome | todos os 6 kinds; monta entrada, escolhe factory, compara todos os IDs/Money e campos de lifecycle; comprova origem PENDING e consultas requiresReference/affectsBalance |
| ${kind} enforces the approved amount policy including internal negative Money | 6 kinds × valores zero/0.01/negativo interno; aceita exatamente a política aprovada, demais INVALID_AMOUNT; impede negativos vindos de subtract/negate |
| external creation refuses OPENING while the explicit internal factory works | cria OPENING pela borda e recebe INTERNAL_ONLY_KIND; cria internamente, consulta CREDIT e processa; rejeita kind/referência injetados |
| create strips untrusted lifecycle fields and never admits a terminal snapshot | passa snapshot FAILED com campos de resultado à create; verifica PENDING e todos os resultados apagados; protege admissão contra dados JS extras |
| ${initial} transitions to ${outcome} with the correct outcome fields | 2 origens × 3 destinos; chama a transição real e confere status, terminal, ref, data e código; não usa atribuição direta |
| waiting for a reference is explicit, requires a reference and cannot repeat | BET não pode aguardar; WIN com referência pode; segunda espera dá INVALID_TRANSACTION_STATE sem alteração |
| ${terminal} refuses every transition including reprocessing, preserving the entire snapshot | 3 terminais × todos os métodos/alguns parâmetros inválidos; exige subclasse e estado idêntico; REJECTED/FAILED retornam null/false financeiro |
| %s requires an external reference at creation | REFUND/ROLLBACK sem ID → REFERENCE_REQUIRED antes de admitir a operação |
| %s refuses an unrelated external reference | BET/LOSS com referência → INVALID_REFERENCE; LOSS usa zero válido para isolar a regra |
| %s rejects self references by external ID | WIN/REFUND/ROLLBACK apontando a si → INVALID_REFERENCE |
| ${kind} cannot process or calculate direction without its supplied external reference resolved | WIN/REFUND/ROLLBACK com ID mas sem alvo → REFERENCE_REQUIRED em ambas as chamadas, snapshot intacto |
| ${kind} rejects a reference with different %s without mutation | 3 kinds × provider/player/wallet/round/external ID; alvo processado incompatível dá INVALID_REFERENCE em processo e direção |
| ${kind} rejects currency mismatch, own internal ID and a DTO masquerading as reference | 3 kinds com moeda/ID incompatível, DTO ou null; INVALID_REFERENCE e continua PENDING |
| reference in %s cannot be consumed and does not automatically reject the dependent operation | alvo PENDING/PENDING_REFERENCE → REFERENCE_NOT_PROCESSED; REJECTED/FAILED → INVALID_REFERENCE; dependente continua PENDING sem código |
| ${kind} validates target kind %s | 3 dependentes × 6 kinds de alvo; só matriz oficial é aceita; sucesso registra reference.id, erro não processa |
| %s accepts only the full amount, including exact cents and large amounts | 2 reversões; 24.99/25.01 contra 25.00 falham; 0.01 e valor de 100 dígitos iguais processam preservando centavos |
| WIN may have no reference or a processed BET with a different prize; gameId is not a reference scope | WIN livre e WIN99.99 contra BET25 processam; diferença de gameId aceita conforme escopo oficial |
| %s without an external ID refuses an unexpected reference during processing | BET/WIN/LOSS recebem alvo que não pediram; INVALID_REFERENCE sem mutação |
| LOSS records PROCESSED without financial effect or ledger direction | zero, null antes/depois, PROCESSED sem ref; não confunde perda com segundo débito |
| $kind with reference $reference has direction $direction before and after processing | BET, WIN, REFUND e 3 variantes ROLLBACK; verifica direção pendente/processada; troca de ID interno após processamento recusada |
| $kind persists the stable rejection $code and has no ledger effect | 7 pares kind/código válidos; reject guarda código e status, sem efeito/direção; diferencia saldo/reversão/referência |
| fail accepts only infrastructure code, not %s business outcomes | todos os 8 códigos; só permanente vira FAILED, demais INVALID_FAILURE_CODE mantendo PENDING |
| reject rejects inappropriate kinds, API conflicts, infra codes and unknown codes without mutation | códigos incompatíveis com BET/REFUND, código de admissão/infra/desconhecido; snapshot preservado e INVALID_FAILURE_CODE |
| hash comparison is exact and never mutates the original transaction on conflict | hash igual true; caixa/espaço/vazio/diferente false; snapshot intacto e string estável IDEMPOTENCY_CONFLICT |
| rehydrate restores ${status} without replaying reference resolution or transitions | todos os 5 estados; referência não carregada não impede restauração; pendentes depois podem processar com alvo real |
| rehydrate rejects incoherent lifecycle snapshot %# | 13 snapshots com status/data/ref/código contraditório; erro esperado em tabela; não aceita corrupção como resultado válido |
| ${factory} refuses malformed identifier/hash %s without normalization | create/rehydrate × 10 campos; vazio/espaço/controle/tipo errado/null, e undefined nos obrigatórios; INVALID_IDENTIFIER; opcional ausente permanece permitido |
| ${factory} validates object, kind, Money and timestamps at runtime | 2 factories; arrays/primitivos/null, kind desconhecido, DTO monetário, datas inválidas → erros estáveis; TS não substitui runtime |
| processing and rehydration reject invalid processed dates without partial changes | Date inválido/string/null/undefined; processar preserva snapshot; rehydrate recusa datas explicitamente inválidas |
| all fields and dates resist assignment, input mutation and getter mutation | Reflect.set/defineProperty, Date de entrada/getter/rehydrate e DTO Money; nenhuma alteração pública, processedAt conserva instante original |
| two independent reversals remain locally valid: persistent uniqueness is a future database responsibility | dois REFUND com identidade distinta contra mesma BET são aceitos em memória; evidencia limite e necessidade SQL |
| direct construction cannot bypass factories even from JavaScript | Reflect.construct sem token/com Symbol novo → TypeError, mesmo descrição textual do Symbol |
| wager dependency graph uses only domain files and decimal.js, without NestJS or MikroORM | callback async lê imports com parser TS, percorre DFS com Set visitado; cada caminho deve ficar no domínio, único pacote externo decimal.js; dependência indevida/falha de leitura falha teste |
| a refund arriving before its BET waits and can complete once the same reference is processed | BET real inicialmente PENDING; REFUND falha, aguarda; processa BET e então REFUND; termina CREDIT ligado à mesma identidade |
| the internal opening factory validates input and initializes its own lifecycle | entradas não objeto dão INVALID_STATE; snapshot terminal injetado resulta OPENING PENDING sem resíduos de resultado |

Não há um teste que afirme unicidade persistente ou atomicidade financeira entregue.
As regressões de infraestrutura abaixo exercitam a base já existente e não usam as
novas entidades como tabelas: schema financeiro continua vazio.

### Validação observada — 22/10/2026

Comandos executados na raiz, usando apenas credencial local de desenvolvimento:

```bash
export PATH="$PWD/.tools/node_modules/.bin:$PATH"
bun test ./test/wager-transaction.test.ts
DATABASE_URL=postgresql://wager_app:local_app_only@127.0.0.1:55432/wagering bun run check
bun run test:infra
bun run test:orm
bun run test:migrations
git diff --check
```

| Verificação | Resultado observado |
|---|---|
| WagerTransaction isolada | 151 passaram, 0 falharam; 1154 expectativas |
| check | typecheck e build aprovados; 395 testes passaram, 0 falharam; 2270 expectativas |
| PostgreSQL real | 2 passaram, incluindo SQL autenticado e dados preservados após restart/recriação |
| SQS em LocalStack real | 4 passaram, incluindo reconciliação, entrega/reentrega/ACK, DLQ e reinício/recriação |
| MikroORM/Nest real | 2 passaram; usuário restrito aceito e administrativo recusado |
| Migrations oficiais | 2 passaram; geração/aplicação única/reversão e rollback de lote com falha em banco descartável |

São **405 casos distintos**, 151 novos. A execução isolada repete casos da suíte
principal e não é contada novamente. Não houve falha de teste em runtime nem
regressão observada. Durante a implementação, typecheck identificou campos opcionais
explicitamente undefined sob exactOptionalPropertyTypes; o contrato de snapshot foi
ajustado para representar isso. Também corrigimos duas tipagens de testes: comparação
de enum com string literal e conversão intencional de DTO inválido por unknown.
Não afrouxamos o tsconfig nem as garantias de Money para eliminar os erros.

Executamos ainda `bun --eval` com imports reais do build:

```ts
import { Money } from './dist/domain/money/money.js';
import {
  WagerTransaction as Tx,
  WagerTransactionKind as Kind,
} from './dist/domain/wagering/wager-transaction.js';

const common = {
  providerId: 'provider-a', playerId: 'player-1', walletId: 'wallet-1',
  roundId: 'round-1', gameId: 'game-1',
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
  createdAt: new Date('2026-10-22T12:00:00Z'),
};
const bet = Tx.create({ ...common, id: 'bet-1', externalTransactionId: 'bet-ext',
  idempotencyKey: 'bet-key', payloadHash: 'bet-hash', kind: Kind.Bet });
const refund = Tx.create({ ...common, id: 'refund-1', externalTransactionId: 'refund-ext',
  idempotencyKey: 'refund-key', payloadHash: 'refund-hash', kind: Kind.Refund,
  referenceExternalTransactionId: 'bet-ext' });
// markProcessed(bet, new Date(0)) agora lança REFERENCE_NOT_PROCESSED.
refund.markPendingReference();
bet.markProcessed(undefined, new Date(0));
refund.markProcessed(bet, new Date(1));
// Outra tentativa de markProcessed lança INVALID_TRANSACTION_STATE.
```

A sonda capturou os erros esperados e imprimiu esta saída real:

```text
REFERENCE_NOT_PROCESSED PENDING
WAIT PENDING_REFERENCE
BET PROCESSED DEBIT 25.00 BRL
REFUND PROCESSED CREDIT bet-1
INVALID_TRANSACTION_STATE PROCESSED
HASH true false
```

Isso comprova execução da entidade compilada, sem movimentar dinheiro nem gravar
ledger. Hash true/false corresponde a comparar refund-hash e changed.
O SHA-256 dos 27.497 bytes do enunciado original permaneceu
47795fce2fc38cae5f1b91368ebaf80b7a2ed1fe147f36704b665faf0613812e;
o README mudou somente na seção adicional de implementação.

Próxima proposta: desenhar persistência e constraints financeiras, fechar limites
de armazenamento e plano de escrita atômico antes das migrations. Não iniciamos
essa etapa, endpoints ou processamento. O desenvolvimento para aqui.

## 16. Schema financeiro PostgreSQL — primeira parte: Wallet

Em 23/10/2026 partimos de main limpa em 97c3fad. README, modelos e configuração real
foram inspecionados; não havia tabelas públicas no banco wagering. O usuário aprovou
NUMERIC com CHECKs, limite equivalente a (20,2), key única por provedor e triggers
diferíveis com wallet_version no ledger. As duas últimas escolhas serão implementadas
nas próximas partes desta mesma etapa autorizada.

### Precisão exata e limites de armazenamento

Em NUMERIC(p,2), p conta todos os dígitos e 2 é a escala fracionária; p=20 permite
18 dígitos inteiros. O maior valor não negativo é 999999999999999999.99. Esse teto
é muito superior aos exemplos do desafio, mas finito e explícito. Money pode calcular
valores maiores; persistir algo fora do limite deve falhar, nunca truncar.

A consulta real `SELECT '1.005'::numeric(20,2), '1.005'::numeric` retornou 1.01 e
1.005. Uma coluna com typmod (20,2) já teria arredondado antes de executar um CHECK
sobre seu valor. Por isso financial_amount é um **DOMAIN SQL sobre numeric sem
typmod**, com range 0..999999999999999999.99 e scale <= 2. Não é um domínio DDD nem
tabela extra: é o mesmo tipo numérico com validação reutilizada. NaN e infinidades
falham no limite superior/inferior. NULL é tratado pelo NOT NULL de cada coluna.
Escala 0/1 é exata e aceita no banco; o futuro mapper formatará em duas casas antes
de Money.from. Escala 3, inclusive 1.000, é recusada. Se o próprio cliente executar
um cast que já arredondou, o banco não pode reconstruir o valor original perdido.

PostgreSQL armazena NUMERIC em representação decimal de precisão variável, sem
usar ponto flutuante para os centavos. A documentação oficial descreve arredondamento
e armazenamento: https://www.postgresql.org/docs/17/datatype-numeric.html.
Inspecionamos DecimalType instalado no MikroORM 7: modo number converte com `+value`,
modo string preserva texto. Consulta real via EntityManager retornou o máximo como
string, sob wager_app. Não configuramos conversão para number. Futuras entidades de
persistência serão separadas das classes de domínio; migrations SQL não exigem
antecipar repositórios/EntitySchemas sem caso de uso.

### Chaves, checks e permissões

PRIMARY KEY identifica uma linha, proíbe nulo/duplicata e cria índice único.
UNIQUE(player_id,currency) impede duas wallets do mesmo jogador na mesma moeda;
BRL e USD do mesmo jogador são carteiras diferentes. A UNIQUE composta adicional
(id,player_id,currency) servirá à FOREIGN KEY das transações, protegendo o vínculo
com o jogador/moeda corretos. FOREIGN KEY assegura que a chave referenciada exista;
não significa copiar todos os dados nem executar regras de processamento.

CHECK valida uma expressão da linha; não deve consultar outras tabelas. NOT NULL
é separado porque um CHECK que resulta NULL não rejeita a linha. Um índice acelera
buscas e custa espaço/manutenção na escrita. Os índices de PK/UNIQUE já atendem essas
consultas; não criamos cópias redundantes. Checks não criam índices automaticamente.

Exemplos executados no teste, após criar os campos obrigatórios da wallet:

```sql
UPDATE wallets SET balance = '-0.01'; -- 23514: faixa
UPDATE wallets SET balance = '1.005'; -- 23514: escala, não vira 1.01
UPDATE wallets SET version = 0;      -- 23514: versão positiva
DELETE FROM wallets;                -- 42501 para wager_app
```

Schema e dados têm permissões distintas. wager_app recebe SELECT, INSERT e UPDATE
apenas nas três colunas mutáveis. Não pode mudar dono/moeda/ID, apagar wallet,
TRUNCATE ou alterar tabelas/triggers. O proprietário de migrations continua capaz de
administrar o schema. Não prometemos resistência contra um administrador que
explicitamente remove as proteções.

### Cada função/migration/helper e seus chamadores

| Nome e arquivo | Parâmetros e retorno | Fluxo, validações, erros, dependências e razão |
|---|---|---|
| Migration20261023000001.up — migrations/Migration20261023000001.ts | nenhum → Promise<void> | Migrator oficial chama; addSql agenda criação do DOMAIN, wallets, PK/UNIQUE/CHECKs e grants; falha DDL aborta migration transacional; não modifica tabelas preexistentes |
| Migration20261023000001.down — mesmo arquivo | nenhum → Promise<void> | Migrator chama em reversão; remove wallets antes do DOMAIN, respeitando dependência; perde dados e falha se dependências futuras não tiverem sido revertidas; sem CASCADE |
| withFinancialDatabase — infra/test/financial-schema-support.ts | to: string, run: (FinancialDatabase) => Promise<void> → Promise<void> | usa withDisposableDatabase; inicia MikroORM de migrations, clientes SQL app/owner, aplica até a migration solicitada e chama callback; finally fecha conexões, helper externo apaga só banco dwp_test; erros propagam; evita tocar wagering |
| expectSqlState — mesmo arquivo | run: () => Promise<unknown>, sqlstate: string → Promise<void> | executa SQL, captura erro e exige Error + errno exato; asserção falha se SQL foi aceito ou erro errado; usado nos cenários negativos, não simula PostgreSQL |
| insertWallet — mesmo arquivo | sql: SQL, id: string=wallet-1, balance: string=0.00 → Promise<void> | INSERT parametrizado com player derivado, BRL, version1 e timestamps fixos; propaga erro PostgreSQL; fixture usada pelos testes; depois da integridade completa, saldo positivo exige abertura/ledger no mesmo commit |

FinancialDatabase é o contexto de teste (app, owner, orm e applicationUrl); não é
abstração de domínio/repositório. `orm.migrator` é a API real instalada no MikroORM 7;
getMigrator de exemplos de versões anteriores não existe nesta versão. O typecheck
identificou a diferença e usamos a API atual sem flexibilizar TypeScript strict.

Todos os testes seguintes estão em infra/test/financial-wallet.test.ts. Callbacks
assíncronos recebem contexto por withFinancialDatabase, retornam Promise<void> ao
Bun e falham por asserção/erro SQL inesperado. Aplicam somente a primeira migration,
para testar precisamente sua responsabilidade; a suíte de ledger testará o conjunto.

| Teste | Entrada, lógica e resultado |
|---|---|
| wallet schema enforces primary key, player/currency uniqueness and required fields | insere wallet, tenta PK e par duplicados (23505); outra moeda funciona; campos omitidos dão 23502 |
| wallet rejects negative, overflow, excess scale and nonfinite money through direct SQL | sete valores inválidos parametrizados dão 23514 e não deixam linhas; maior valor válido retorna exatamente igual |
| wallet validates currency, identifiers, version bounds and finite timestamps | versões zero/negativa/acima MAX_SAFE, moedas e IDs inválidos, infinity e NULL; erros 23514/23502; último inteiro seguro aceito |
| wallet grants permit only application data operations and prevent DDL, identity updates and deletion | app insere/atualiza campos mutáveis; seis tentativas proibidas dão 42501; protege fronteira de privilégios, não só domínio |
| MikroORM and PostgreSQL return exact financial decimals as strings compatible with Money | grava Money máximo como string, consulta com ORM/app real, verifica typeof e roundtrip Money.equals; fecha ORM no finally |
| wallet migration applies once, reverses in a disposable database and reapplies cleanly | confere tabela, segundo up vazio, down até 0 remove tabela/tipo, novo up registra uma migration; somente banco descartável |

A primeira migration ainda permite alteração direta de saldo sem ledger: a terceira
parte fechará essa lacuna com as três tabelas presentes. Uma migration cria estrutura;
uma transação financeira futura grava dados relacionados numa unidade BEGIN/COMMIT.
O fato de a migration ser transacional não torna os futuros casos de uso atômicos
por si só.

Evidência do primeiro incremento: `bun test ./infra/test/financial-wallet.test.ts`
passou 6 testes/64 expectativas; `DATABASE_URL=... bun run check` passou os 395
casos existentes, typecheck e build. O valor máximo foi devolvido como string por
MikroORM real. Não alteramos Money nem aplicamos a migration no banco principal.

### Segunda parte: WagerTransaction persistida

Migration20261023000002 cria wager_transactions com os campos da entidade em snake_case.
Money é amount + currency; datas são timestamptz(3); referências/falhas opcionais são
NULL. Uma FK composta para wallets(id,player_id,currency) impede que a mesma wallet
seja associada a jogador/moeda incompatíveis. O campo reference_external_transaction_id
é texto sem FK: o provedor pode nomear uma transação que ainda não chegou.
reference_transaction_id é FK nullable para a transação local e só aparece quando a
dependente fica PROCESSED; os CHECKs reproduzem a forma de lifecycle do domínio.

PRIMARY KEY, UNIQUE(provider_id,external_transaction_id) e
UNIQUE(provider_id,idempotency_key) têm funções distintas. A key recebida não é
regenerada a partir do externalId. Outro provedor pode usar as mesmas strings.
payload_hash é persistido, mas não calculamos hash/canonicalização nesta etapa.
A unicidade impede duas linhas com a chave; comparar payload e devolver o resultado
original continua responsabilidade do futuro caso de uso.

Um **índice parcial** indexa somente linhas que atendem seu WHERE. A UNIQUE
(reference_transaction_id,kind) aplica-se somente a PROCESSED REFUND/ROLLBACK.
Assim rejeições não consomem a reversão; duas tentativas concorrentes bem-sucedidas
do mesmo tipo não podem confirmar. Tipos diferentes continuam permitidos, conforme
§7.4. Há índice parcial de OPENING processada por wallet para impedir duas aberturas
positivas. Índices de pendentes (created_at,id), histórico por wallet e referência
interna servem às futuras consultas; índices únicos já cobrem provedor/externalId/key.
Não há worker nem política de tentativas/TTL implementados.

Uma **trigger** executa uma função em eventos da tabela. guard_wager_transaction é
BEFORE INSERT/UPDATE/DELETE por linha. Ela não movimenta dinheiro: impede alteração
de identidade/input, exclusão, transição inválida e mutação terminal; para conclusão
com referência, valida que alvo existe, está PROCESSED, tem escopo/kind corretos e
valor integral quando reversão. WIN pode ter prêmio diferente; gameId não é comparado.
O alvo deve estar processado antes da conclusão da dependente, inclusive na mesma
transação SQL. Reidratação posterior não executa UPDATE nem dispara transição.

Transações podem ser inseridas já com um snapshot terminal coerente (por exemplo,
caso de uso aplica o domínio e persiste seu estado final uma vez). Isso não autoriza
modificar uma linha terminal existente. Constraints são defesa dos dados, não prova
de que determinado endpoint autenticou o provedor. OPENING continua reservado ao
fluxo interno nos futuros adaptadores; um papel SQL autorizado a INSERT não distingue
HTTP de código interno.

Exemplos com uma wallet e uma BET processada existentes:

```sql
UPDATE wager_transactions SET status='PENDING' WHERE status='PROCESSED';
-- 23514: terminal imutável
UPDATE wager_transactions SET payload_hash='different';
-- 42501 sob wager_app; coluna não autorizada
-- Segundo INSERT PROCESSED REFUND da mesma referência: 23505, índice parcial.
-- REFUND sem referência externa: 23514, wager_reference_shape.
```

| Função e arquivo | Parâmetros/retorno, fluxo, erros e justificativa |
|---|---|
| Migration20261023000002.up — migrations/Migration20261023000002.ts | sem args → Promise<void>; Migrator chama, agenda tabela/FKs/checks/índices/função/trigger/grants; DDL inválido reverte lote; depende de wallets/financial_amount |
| Migration20261023000002.down — mesmo arquivo | sem args → Promise<void>; remove tabela (e seus índices/trigger), depois função; não remove wallets; perde transações e exige reverter primeiro dependências futuras |
| guard_wager_transaction — SQL na mesma migration | sem args SQL → trigger; lê TG_OP, OLD/NEW; DELETE dá 23514; UPDATE confere terminal, igualdade do input com to_jsonb excluindo quatro campos de lifecycle, e máquina de estados; PROCESSED resolve referência por PK e valida escopo/kind/valor/status; ausente dá 23503, incompatível 23514; retorna NEW; usa search_path fixo, security invoker, sem UPDATE oculto |
| insertTransaction — infra/test/financial-schema-support.ts | sql: SQL, patch: Partial<TransactionFixture>={} → Promise<void>; monta fixture determinística PENDING, ou data processada se solicitado, aplica patch e INSERT parametrizado; erros SQL propagam; somente testes chamam, não é caso de uso |

TransactionFixture tipa IDs/hash/kind/status/valores string e nullable referências/
falha/data. O helper permite strings inválidas deliberadamente para provar rejeição
no banco. Os valores de teste não passam por Number nem por JSON de domínio alterado.

Testes em infra/test/financial-wager.test.ts, executados por Bun com callback async
Promise<void>, todos usando withFinancialDatabase até a segunda migration:

| Nome | Entradas, execução e resultado |
|---|---|
| wager identities and idempotency are independently unique within each provider | PK/external/key repetidos → 23505; mesmo external/key em outro provider aceito |
| wager wallet FK binds wallet, player and currency and prevents missing or mismatched owners | wallet ausente, player diferente, moeda USD/JPY contra BRL → 23503 |
| wager permits unresolved external references while enforcing lifecycle and failure code shape | REFUND pendente sem alvo existe; 15 formas inválidas de kind/status/valor/ref/data/código dão 23514; rejeição final mantém ref interna NULL |
| wager validates processed references and full reversal amounts through direct SQL | alvo BET25; testa 24.99, provider/rodada/external/status errados (23514), ID interno ausente (23503); REFUND integral e WIN99.99 aceitos; REFUND de WIN recusado |
| successful reversal uniqueness permits rejected attempts and different reversal kinds | rejeição não bloqueia REFUND válido; segundo sucesso igual dá 23505; ROLLBACK separado funciona |
| unique reversal index arbitrates genuinely concurrent PostgreSQL insertions | Promise.allSettled envia dois INSERTs reais concorrentes pelo pool; um confirma e outro recebe 23505; consulta confirma um REFUND; não prova cenário distribuído completo |
| wager transition guard protects identities and terminal rows even with owner SQL privileges | owner não pode alterar input/apagar/atualizar terminal com trigger habilitada; app não pode voltar a PENDING/repetir espera nem alterar hash/TRUNCATE |
| wager indexes exist and migration down preserves wallet before clean reapplication | consulta pg_indexes, up repetido vazio, down remove só transações, novo up registra duas migrations |

Map callbacks nos testes de concorrência e índices apenas transformam IDs em Promises
ou linhas em nomes; filter/find selecionam resultados de Promise.allSettled para
asserções. Nenhum callback substitui a execução PostgreSQL por mock.
A correspondência transação/ledger e mudança de saldo será fechada na terceira parte.

Evidência do segundo incremento: `bun run test:financial` passou 14 testes (6 Wallet
+ 8 WagerTransaction), 149 expectativas. `DATABASE_URL=... bun run check` passou os
395 casos existentes, typecheck e build. A disputa real pelo índice retornou um
sucesso e um SQLSTATE 23505. As tabelas de wagering continuam intocadas.

### Terceira parte: ledger imutável e integridade entre tabelas

Migration20261023000003 cria wallet_ledger_entries. Cada linha contém ID, wallet_id,
transaction_id, wallet_version, direction, amount/currency, balance_before,
balance_after e created_at. WalletLedgerEntry continua sem dependências ORM: o campo
wallet_version é metadado de persistência, obtido do WalletMovementResult existente
(ou 1 na abertura). Não alteramos a classe para carregar uma preocupação SQL.

A FK simples aponta à wallet; a FK composta (transaction_id,wallet_id,currency)
aponta a wager_transactions. UNIQUE(transaction_id,wallet_id) impede dois lançamentos
da mesma operação. UNIQUE(wallet_id,wallet_version) ordena e identifica cada movimento
da carteira, também servindo a busca do predecessor/paginação futura. A versão 1 é
reservada ao OPENING positivo; em abertura zero, o primeiro movimento é versão 2.
Não usamos created_at para definir a sequência: relógios podem empatar ou divergir.

O CHECK do ledger valida uma linha: DEBIT exige before - amount = after; CREDIT
exige before + amount = after. Amount deve ser positivo; os três valores usam o
tipo exato com limite/escala. Somente isso não garante que before seja o saldo real,
que after corresponda à Wallet ou que a transação tenha sido processada. Essas
relações precisam de FKs e verificações entre tabelas.

**Constraint triggers diferíveis** executam a validação ao fim da transação por
padrão. Elas deixam inserir as partes de uma escrita financeira em comandos SQL
separados, mas recusam COMMIT se a estrutura final estiver incompleta. Podem ser
antecipadas com SET CONSTRAINTS ALL IMMEDIATE. Não são tarefas assíncronas, não
executam depois do commit e não corrigem dados silenciosamente.

Três verificações se complementam:

1. Cada INSERT de Wallet positiva ou UPDATE de saldo exige o lançamento da versão
   correspondente, com before igual ao OLD.balance (zero na abertura) e after igual
   ao NEW.balance. São examinados os eventos de cada UPDATE, não só o saldo final;
   isso impede esconder movimentos intermediários. Abrir com zero exige ausência
   de lançamento na versão 1.
2. Cada INSERT no ledger exige transação PROCESSED com mesmo valor/moeda/wallet e
   direção de acordo com kind/referência. Seu predecessor por versão precisa terminar
   no seu before. Só versão 2 pode não ter predecessor, representando abertura zero.
   A versão do lançamento não pode ultrapassar a Wallet; se for a última, after deve
   ser o saldo atual. Versão 1 só aceita OPENING e before zero.
3. Cada transação, em seu estado final no commit, deve ter exatamente um lançamento
   se PROCESSED e financeira, e nenhum se LOSS/PENDING/PENDING_REFERENCE/REJECTED/FAILED.
   A UNIQUE limita a um; a trigger exige existência. Lemos o estado final porque um
   INSERT PENDING pode ter sido seguido por UPDATE PROCESSED na mesma transação SQL.

A cadeia parte de zero ou do crédito OPENING, cada evento tem equação exata e um único
número de versão, e a última entrada termina no saldo atual. Isso sustenta a igualdade
entre saldo e ledger sem recalcular todo o histórico a cada escrita: as consultas
normais usam chaves/índices para a linha correspondente e o predecessor. Os testes
consultam a soma do ledger para verificar o resultado. Não criamos reconciliação API.

A trigger BEFORE INSERT do ledger toma FOR NO KEY UPDATE na **wallet específica**.
Esse lock SQL mantém escritas dessa carteira serializadas até o fim da transação,
sem lock global. É defesa do schema; ainda não implementa o lock antecipado do futuro
caso de uso, antes de decidir saldo. No teste, duas conexões leem 100.00 e tentam a
mesma versão seguinte: só uma confirma, a outra falha no índice único. Isso não é
uma implementação do cenário distribuído completo de apostas ou de retry automático.

Encontramos um problema real ao testar: a primeira versão usava FOR UPDATE e o
cenário concorrente recebeu **40P01 (deadlock)**, pois ambas as inserções de transação
já mantinham locks de FK FOR KEY SHARE na wallet. A mudança para FOR NO KEY UPDATE
mantém exclusão entre escritores de saldo, mas é compatível com KEY SHARE. Não mudamos
o teste para aceitar deadlock: ele continua exigindo um sucesso e 23505. Futuramente,
ordem de locks e tratamento de falhas transitórias continuarão necessários para
operações envolvendo múltiplas linhas/carteiras.

Referências oficiais: [constraints](https://www.postgresql.org/docs/17/ddl-constraints.html),
[constraint triggers](https://www.postgresql.org/docs/17/sql-createtrigger.html),
[locks por linha e conflitos](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS).

### Funções SQL e triggers da terceira migration, uma a uma

Todas ficam em `migrations/Migration20261023000003.ts`. Funções de trigger não
recebem parâmetros SQL: PostgreSQL fornece OLD/NEW, TG_OP e TG_TABLE_NAME conforme
o evento. Retorno trigger é NEW nas BEFORE que permitem a linha, NULL nas AFTER
(o retorno é ignorado) ou exceção. Todas usam search_path fixo pg_catalog,public,
security invoker, referências qualificadas e EXECUTE revogado de PUBLIC; não elevam
privilégios. O engine chama a trigger vinculada, não um método da aplicação.

| Função | Fluxo, resultado/erros, chamadores e justificativa |
|---|---|
| Migration20261023000003.up() → Promise<void> | Migrator agenda guarda dos dados anteriores, tabela/constraints, funções/triggers e grants; depende das migrations 1/2; erro reverte lote; não corrige/apaga saldo anterior |
| bloco DO $guard$ | sem parâmetros/retorno de dados; antes do DDL verifica wallets fora de saldo0/version1 ou transações financeiras PROCESSED sem histórico (a tabela ledger ainda não existe); 23514 exige migration de histórico explícita; impede legitimar saldo anterior sem lastro |
| reject_financial_mutation() | sempre lança 23514 com operação/tabela; BEFORE UPDATE/DELETE no ledger, DELETE em wallets, TRUNCATE nas três tabelas; protege até SQL normal do owner com triggers habilitadas; não protege contra owner/superuser que altera o schema |
| guard_wallet_state() | BEFORE INSERT/UPDATE: INSERT exige version1; UPDATE preserva id/player/currency/created_at e exige incremento exatamente1 se saldo muda; saldo igual exige version/updated_at iguais; 23514 em desvio; retorna NEW |
| lock_ledger_wallet() | BEFORE INSERT do ledger: SELECT da wallet FOR NO KEY UPDATE; ausente dá 23503; retorna NEW e mantém lock da linha até fim da transação; depende de privilégio de UPDATE já dado em colunas mutáveis |
| check_wallet_movement() | AFTER INSERT/UPDATE, diferível: determina before de OLD ou zero; abertura zero verifica ausência de ledger1; UPDATE sem movimento retorna; demais buscam ledger por wallet/version e comparam before/after; 23514 se falta ou diverge, NULL em sucesso |
| check_ledger_entry() | AFTER INSERT, diferível: carrega wallet/transação; confere status/kind/amount/wallet/currency, calcula direção (ROLLBACK consulta kind da referência), compara versão/saldo final e predecessor; 23514 em qualquer incompatibilidade; NULL em sucesso; FKs já asseguram existência |
| check_transaction_ledger() | AFTER INSERT/UPDATE, diferível: relê transação pelo ID, testa EXISTS ledger e compara com PROCESSED não LOSS; 23514 quando efeito e ledger divergem; NULL em sucesso; UNIQUE/FK impedem multiplicidade ou vínculo a outra wallet |
| Migration20261023000003.down() → Promise<void> | remove primeiro triggers instaladas em wallets/transações, depois ledger e suas triggers, por fim funções; sem CASCADE; destrói histórico e retira garantias, por isso demonstração exclusivamente descartável |

| Trigger | Evento/timing | Função |
|---|---|---|
| ledger_immutable | BEFORE UPDATE/DELETE, linha | reject_financial_mutation |
| ledger_no_truncate, wallets_no_truncate, wagers_no_truncate | BEFORE TRUNCATE, comando inteiro | reject_financial_mutation |
| wallets_no_delete | BEFORE DELETE, linha | reject_financial_mutation |
| guard_wallet_state | BEFORE INSERT/UPDATE, linha | guard_wallet_state |
| lock_ledger_wallet | BEFORE INSERT, linha | lock_ledger_wallet |
| wallet_movement_consistency | AFTER INSERT/UPDATE, linha, DEFERRABLE INITIALLY DEFERRED | check_wallet_movement |
| ledger_entry_consistency | AFTER INSERT, linha, DEFERRABLE INITIALLY DEFERRED | check_ledger_entry |
| transaction_ledger_consistency | AFTER INSERT/UPDATE, linha, DEFERRABLE INITIALLY DEFERRED | check_transaction_ledger |

wager_app só recebe SELECT/INSERT no ledger. UPDATE/DELETE/TRUNCATE já falham por
permissão (42501); triggers dão segunda proteção se alguém conceder DML indevidamente.
TRUNCATE precisa de trigger própria, pois não dispara DELETE por linha. App também
não pode desabilitar triggers nem usar session_replication_role=replica. Migrations
rodam com papel administrativo separado, nunca com credencial da aplicação.

### Helpers e testes da integração completa

| Helper / arquivo | Parâmetros, retorno, fluxo e erros |
|---|---|
| insertLedger — infra/test/financial-schema-support.ts | sql:SQL, patch:Partial<LedgerFixture>={} → Promise<void>; preenche fixture de crédito25/version2/100→125, aplica patch e INSERT parametrizado; só testes chamam; PostgreSQL valida e erros propagam |
| openFundedWallet — mesmo arquivo | sql:SQL → Promise<void>; abre sql.begin, insere wallet100, OPENING100 PROCESSED e ledger1 0→100; commit executa verificações; erro faz rollback; fixture de teste, não caso de uso implementado |
| walletState — infra/test/financial-ledger.test.ts | sql:SQL → Promise de linhas balance/version text; SELECT ordenado por id, usado nas asserções antes/depois; consulta real, erro propaga |
| credit — mesmo arquivo | sql:SQL, id='win-1', before='100.00', after='125.00':strings, version=2:number → Promise<void>; insere WIN25 processada, ledger e UPDATE wallet; exige conexão transacional fornecida pelo teste, não calcula saldo; erro propaga e sql.begin externo reverte |

LedgerFixture é DTO de teste: strings para IDs/direção/moeda/dinheiro; number só para
versão. Nenhum helper de teste fica no domínio ou é exportado como serviço da aplicação.
Callbacks de sql.begin recebem conexão transacional, retornam Promise<void> e confirmam
somente após as constraints; em erro, Bun faz rollback. Callbacks de matrizes repetem
SQL real e asserções, não substituem funções de banco.

Os testes em infra/test/financial-ledger.test.ts aplicam **as três migrations**:

| Teste (nome inicial no arquivo) | Entradas, lógica e comprovação |
|---|---|
| full schema accepts zero opening... | wallet zero sem ledger e positiva com trio coerente; saldo/version e soma conferidos |
| positive opening without ledger fails... | INSERT wallet100 isolado falha 23514 no commit, consulta não encontra linha |
| wallet cannot change balance alone... | saldo/version/data alterados sem correspondência e identidade alterada pelo owner → 23514; saldo100/version1 preservados |
| processed financial transaction without ledger fails... | BET processada isolada falha; LOSS zero, rejeição e pendência são aceitas sem ledger |
| deferred checks allow ledger before status... | tentativa sem UPDATE wallet aborta; depois ledger inserido enquanto WIN está PENDING, seguido de Wallet e PROCESSED, confirma125/version2; prova estado final diferível |
| ledger enforces arithmetic... | 12 patches inválidos: equação, negativos, zero, escala, teto, NaN, direção, versão, moeda, tx/wallet ausentes; 23514 ou23503 exatos |
| ledger is immutable for app and owner... | app recebe42501 e owner23514 em UPDATE/DELETE/TRUNCATE; TRUNCATE CASCADE nas origens e DELETEwallet bloqueados; app não desabilita trigger/replicação |
| ledger uniqueness prevents a transaction... | segundo lançamento por transação/wallet ou por versão recebe23505 |
| ledger rejects pending, rejected, failed and LOSS... | entradas com equação válida ligadas a resultados sem efeito falham23514, mesmo com UPDATEsaldo correspondente |
| ledger rejects mismatched transaction amount... | WIN25 contra ledger20 ou direçãoDEBIT falha23514; não basta equação correta |
| wallet event checks prevent fabricating... | before90 contra wallet100 e salto versão1→3 rejeitados; estado anterior preservado |
| multiple movements in one SQL transaction... | dois créditos25 com UPDATEs separados formam versões2/3, saldo150, soma150 |
| first movement on a zero wallet... | OPENING na versão2 falha; WIN normal versão2 0→25 confirma |
| BET, REFUND and ROLLBACK... | cadeia de BET, REFUND, ROLLBACKrefund, ROLLBACKbet, WIN, ROLLBACKwin confirma direções/referências e retorna saldo100/version7 |
| forced SQL failure rolls back... | trio válido seguido de divisão por zero22012; consultas comprovam que saldo, status e ledger novos não foram persistidos |
| SET CONSTRAINTS IMMEDIATE exposes... | força validação de alteração incompleta antes de COMMIT; recebe23514 e preserva saldo |
| all financial migrations reverse and reapply... | up repetido vazio; down0 deixa apenas histórico de migrations e nenhuma função pública; up reconstrói3 migrations e aceita abertura válida |
| ledger migration refuses preexisting... | aplica só1/2, grava saldo anterior sem lastro, tenta3 e recebe erro; saldo anterior continua100, ledger não criado, histórico permanece2 |
| concurrent stale writers use distinct sessions... | duas sql.begin consultam saldo100 e PIDs distintos; barreira Promise libera ambas somente após leitura; um crédito confirma, outro23505; saldo125/version2 e apenas abertura+um movimento persistidos |
| SQL preserves exact cents... | WIN0.10 seguida de WIN0.20 em walletzero produz0.30/version3, sem number monetário |

No teste concorrente, callback do construtor Promise armazena release, callbacks map
abrem as duas conexões e contam chegadas, filter/find inspecionam resultados; Set de
PIDs comprova sessões distintas. A barreira não serializa escritas nem simula o banco.
Timeout15s impede teste sem limite caso uma regressão impeça completar as duas leituras.

### Responsabilidades restantes e limites operacionais

Classes de domínio continuam validando entradas e transições em memória, com erros
expressivos. Banco garante estrutura, unicidade, equações, imutabilidade e correspondência
financeira nos commits testados. O futuro mapper transformará snake_case/null em
props/undefined, strings numéricas em Money (escala2) e chamará rehydrate; version de
bigint será convertida só após verificar o limite seguro. Ainda não há entidades ORM
financeiras registradas, mappers de produção nem repositórios: a integração usa SQL
real via MikroORM/Bun e migrations oficiais. Não usamos auto-sync com entities vazio.

O futuro caso de uso fará admissão idempotente, leitura da wallet com lock antes do
cálculo, domínio, persistência de cada movimento, resultado original e Inbox/Outbox na
mesma unidade SQL. Se aplicar várias transições da mesma Wallet num lote, precisará
persistir cada UPDATE/version e ledger, não condensar vários movimentos num único
UPDATE final via Unit of Work. Alternativamente, uma operação por wallet/transação SQL.
As triggers não tomam essa decisão de orquestração nem criam lançamentos automaticamente.

Inbox/Outbox não foram criadas. Sua futura inserção deve usar a mesma conexão/transação
financeira; ainda não há garantia de evento durável ou ACK pós-commit. Replay ainda
precisa guardar também resultado de LOSS/rejeições, que não têm ledger. Retries/TTL,
≥3 instâncias, recuperação de crash e locks nos casos de uso permanecem futuros.
A trigger evita que uma escrita inconsistente confirme, mas não implementa resposta
adequada ao provedor, retry, métricas ou coordenação de workers.

Migrations foram aplicadas/revertidas somente em bancos dwp_test descartáveis. A guarda
da terceira migration recusa dados anteriores sem histórico em vez de apagá-los ou
inventar lançamentos. DOWN de ledger retira suas garantias e perde histórico; reexecutar
UP sobre efeitos remanescentes falhará, exigindo plano explícito de migração de dados.
A demonstração down0/up ocorre em banco descartável, nunca como recuperação de produção.

### Visão das tabelas e evidências finais da etapa

```mermaid
erDiagram
    wallets ||--o{ wager_transactions : "wallet e jogador/moeda"
    wallets ||--o{ wallet_ledger_entries : "histórico por versão"
    wager_transactions ||--o| wallet_ledger_entries : "um efeito financeiro"
    wager_transactions o|--o{ wager_transactions : "referência interna resolvida"
    wallets {
        text id PK
        text player_id
        text currency
        numeric balance
        bigint version
    }
    wager_transactions {
        text id PK
        text wallet_id FK
        text provider_id
        text external_transaction_id
        text idempotency_key
        text payload_hash
        text kind
        text status
        numeric amount
        text reference_transaction_id FK
    }
    wallet_ledger_entries {
        text id PK
        text wallet_id FK
        text transaction_id FK
        bigint wallet_version
        text direction
        numeric amount
        numeric balance_before
        numeric balance_after
    }
```

O diagrama omite datas/códigos/alguns campos para destacar relações; as migrations
são a definição completa. A referência interna é opcional e não é o ID externo do
provedor. Para transação PROCESSED financeira a cardinalidade efetiva de ledger é
exatamente1; nos demais resultados ela é0, verificada pela trigger.

Comandos executados, apenas credenciais locais:

```bash
export PATH="$PWD/.tools/node_modules/.bin:$PATH"
bun run test:financial
DATABASE_URL=postgresql://wager_app:local_app_only@127.0.0.1:55432/wagering bun run check
bun run test:infra
bun run test:orm
bun run test:migrations
git diff --check
docker compose exec -T postgres psql -U wager_app -d wagering \
  -c "SELECT tablename FROM pg_tables WHERE schemaname='public';"
```

| Verificação final | Resultado real |
|---|---|
| test:financial | 34 passaram, 0 falharam, 272 expectativas; 6 Wallet +8 Wager +20 Ledger |
| check | 395 passaram, 0 falharam, 2270 expectativas; typecheck/build aprovados |
| PostgreSQL/SQS | 2 +4 passaram, incluindo persistência/reinícios/recriação e DLQ |
| ORM/Nest | 2 passaram |
| Migrations de infraestrutura | 2 passaram, incluindo falha de lote e reversão |
| Banco principal wagering | SELECT catálogo retornou 0 tabelas públicas; migrations financeiras não aplicadas |

Total **439 casos distintos**, sendo34 novos. Execuções parciais/repetidas não foram
somadas outra vez. A falha intermediária40P01 do teste concorrente foi reproduzida,
corrigida e substituída pelo resultado esperado23505 na execução final. As mensagens
23514 (CHECK/trigger),23503 (FK),23505 (UNIQUE),23502 (NOT NULL),42501 (permissão) e22012
(falha forçada) foram verificadas por SQLSTATE, não apenas por texto genérico de erro.

O README oficial permaneceu preservado; o domínio e seus testes não foram alterados.
Há três migrations e três suítes financeiras, suporte de testes, comando dedicado e
documentação. A etapa termina aqui: próximo trabalho sugerido é mapeamento/repositórios
e unidade transacional com lock antecipado, após autorização; eventos e Outbox devem
preceder disponibilização do processamento completo conforme suas dependências.

## 17. Mappers financeiros: domínio ↔ registros SQL

Um **mapper** traduz representações, sem executar uma operação financeira. Um registro
SQL usa `player_id`, `NULL`, texto decimal e datas; o domínio usa `playerId`, `undefined`,
Money e construtores encapsulados. Reidratar R$100 já persistidos não credita R$100
novamente. Não criamos IDs/datas e não chamamos `credit`, `debit` ou `markProcessed`.
As três migrations continuam sendo a autoridade das invariantes persistidas.

Todos os métodos abaixo são síncronos. Os mappers não têm construtor próprio nem
estado; futuramente serão chamados pelos adaptadores de repositório. Dependem só
do domínio e de outros mappers, sem decorators/EntitySchemas na entidade financeira.
Os tipos `*Record` descrevem uma linha SQL; são contratos TypeScript, não validadores
universais de entrada HTTP. As factories de domínio continuam validando estrutura.

| Arquivo / operação | Parâmetros → retorno | Fluxo, erros, motivo e exemplo |
|---|---|---|
| `src/infrastructure/persistence/financial/money-mapper.ts` — `MoneyMapper.toDomain` | `amount: string, currency: string → Money` | Verifica decimal não negativo com até 2 casas; separa texto; remove zeros iniciais; limita parte inteira a 18 dígitos; completa casas; chama Money.from. TypeError para representação inválida, RangeError para teto, MoneyError para moeda. `0.1/BRL → Money(0.10/BRL)`. Não arredonda `1.005` nem aceita `1.000`, conforme CHECK scale. |
| mesmo — `MoneyMapper.toRecord` | `money: Money → string` | Lê toJSON e passa pela mesma fronteira para validar teto/sinal; retorna duas casas. Negativo obtido por negate é legítimo no cálculo de Money, mas proibido nas três tabelas: recusado, nunca convertido em positivo. Money continua podendo calcular acima do teto; armazenamento não. |
| mesmo — `readVersion` | `value: string → number` | Exige inteiro textual positivo e compara BigInt ao MAX_SAFE_INTEGER antes de Number. RangeError em falha. **Somente contador** usa number; dinheiro nunca. Usado por Wallet/LedgerMapper. |
| mesmo — `writeVersion` | `value: number → string` | Exige inteiro seguro ≥1, retorna String; RangeError se inválido. Ex.: 2 → `"2"`. |
| `wallet-mapper.ts` — `WalletMapper.toDomain` | `row: WalletRecord → Wallet` | Converte balance/versão e nomes; chama Wallet.rehydrate com IDs, moeda e ambas as datas existentes. Erros dos helpers/factory propagados. Não abre carteira nem cria ledger. |
| mesmo — `WalletMapper.toRecord` | `wallet: Wallet → WalletRecord` | Lê getters, valida dinheiro/versão, retorna campos SQL. Getters de Date devolvem cópias; alterar a linha não altera a Wallet. |
| `wager-transaction-mapper.ts` — `WagerTransactionMapper.toDomain` | `row: WagerTransactionRecord → WagerTransaction` | Converte Money, null→undefined, nomes e lifecycle inteiro; rehydrate valida enum/estrutura. Cast de enum não substitui essa validação. Referência persistida é preservada sem buscar/processar sua BET novamente. |
| mesmo — `WagerTransactionMapper.toRecord` | `transaction: WagerTransaction → WagerTransactionRecord` | Extrai identidade, payloadHash, dinheiro, estado, referências, failureCode e timestamps; undefined→null. Erros de MoneyMapper propagam. Não recalcula hash nem estado. |
| `ledger-entry-mapper.ts` — `LedgerEntryMapper.toDomain` | `row: LedgerEntryRecord → VersionedLedgerEntry` | Converte três valores Money, reidrata entry e lê wallet_version; devolve envelope congelado `{entry,walletVersion}`. Versão é metadado de persistência, não campo novo no domínio. Rehydrate não reexecuta a equação, já protegida no SQL. |
| mesmo — `LedgerEntryMapper.toRecord` | `entry: WalletLedgerEntry, walletVersion: number → LedgerEntryRecord` | Extrai entry imutável e versão explícita da movimentação. Valida dinheiro/contador; mantém data. Ex.: crédito R$0,10, antes R$0,20, depois R$0,30, versão2. |

A normalização é exata por operações de texto. Não utilizamos parseFloat, números
binários ou arredondamento. `999999999999999999.99` permanece igual. Versões são
selecionadas como `::text` para não depender da política do driver para bigint.

**Testes deste incremento.** Em `test/financial-mappers.test.ts`, callbacks de
`test.each` recebem o amount/version ou status/failure da tabela e retornam void:
normalização (5 casos), representação recusada (9), versões recusadas (4), lifecycle
(4). Os demais callbacks sem argumentos conferem input number/negativo/teto,
limite de contador, Wallet e datas defensivas, referência processada sem replay,
null/enum inválido e ledger com versão separada. Um snapshot propositalmente
desequilibrado demonstra que rehydrate não chama create; esse snapshot **não é
persistido** e o CHECK SQL continuaria recusando-o.

`infra/test/persistence-mappers.test.ts` tem um callback async (`Promise<void>`):
withFinancialDatabase cria banco descartável e aplica três migrations; fixture grava
abertura máxima e WIN aguardando referência em uma transação com usuário app;
MikroORM com applicationUrl lê as três tabelas; mappers fazem roundtrip de todos os
campos; contagem confirma que ler não criou novo ledger. `finally` fecha o ORM e o
helper remove só o banco descartável. Falhas SQL/assertions falham o teste. Nenhum
mock substitui o PostgreSQL e nenhuma migration é aplicada ao banco principal.

O primeiro roundtrip real revelou que `em.execute` devolve timestamptz como **string**
(não Date). Foi corrigido na fronteira: `timestamp-mapper.ts/readTimestamp(value:
Date|string): Date` valida formato com fuso explícito e no máximo milissegundos,
constrói uma cópia Date, recusa valor não finito com TypeError. Os três toDomain
utilizam esse helper; toRecord devolve cópias Date, aceitas pelo driver na escrita.
Ex.: `2026-10-23 09:34:56.789-03` → `2026-10-23T12:34:56.789Z`. Não inventa fuso para
texto ambíguo. O teste `timestamp mapping requires timezone and retains milliseconds`
recebe nenhum parâmetro, importa o helper, valida conversão/fuso/invalidade e retorna
Promise<void>. O teste SQL compara datas com instantes conhecidos, não exige que a
representação textual do driver seja idêntica à representação Date de saída.

O segundo teste SQL, `processed reference and terminal failures survive PostgreSQL
rehydration`, é callback sem argumentos → Promise<void>. Em banco isolado, cria uma
wallet zero, WIN de R$1, BET de R$0,30 e prêmio de R$0,10 ligado à BET, além de
REJECTED/FAILED sem ledger. Cada mudança usa um UPDATE e um lançamento próprios,
na mesma transação. O mapper recupera referência interna/externa, status, falhas e
datas; a consulta final exige saldo `0.80`/versão4. Erro SQL ou divergência falha o
teste; finally fecha conexão. A fixture prova conversão/constraints, não é caso de
uso público nem implementação de Inbox/Outbox/idempotência distribuída.

Validação do incremento de mappers: `bun run check` com DATABASE_URL local passou
(typecheck, 424 testes da aplicação e build); `bun test
./infra/test/persistence-mappers.test.ts`: 2/2; `bun run test:financial`: 34/34.
A primeira tentativa do check sem DATABASE_URL falhou na inicialização HTTP;
a execução correta usou a configuração local documentada, sem modificar o teste.

## 18. Portas, repositórios e sessão financeira

Uma **porta** declara o que a aplicação precisa; um **adaptador** implementa isso
com tecnologia concreta. `src/application/ports/financial-persistence.ts` declara
WalletRepository, WagerTransactionRepository, LedgerEntryRepository e o callback de
FinancialUnitOfWork. O domínio não os importa. `FINANCIAL_UNIT_OF_WORK` é símbolo de
DI, sem dependência de Nest. `PersistedLedgerEntry` é entry + versão de armazenamento.
Não criamos repositório genérico: cada operação nomeia uma intenção permitida.

Um **Repository** recupera/agrega objetos persistidos. Aqui ele chama mapper e SQL
parametrizado no EntityManager. O banco recebe parâmetros separados do texto SQL;
por exemplo, um ID contendo aspas não vira uma condição SQL. Os métodos async
retornam Promise; erros dos mappers, domínio, sessão e PostgreSQL propagam. Quem
utiliza agora são fixtures de integração; futuramente, casos de uso dentro da unidade
transacional. Os construtores dos três adaptadores recebem `session: FinancialSession`,
guardam a referência e retornam a instância; não abrem conexão/transação.

### Catálogo dos adaptadores (pasta src/infrastructure/persistence/financial)

| Arquivo / método | Parâmetros → resultado resolvido | SQL, fluxo e motivo |
|---|---|---|
| `wallet-repository.ts` / `findById` | `id:string → Wallet|null` | SELECT pela PK; usa read sem lock. Snapshot de consulta, não base autorizada para save. |
| mesmo / `findByPlayerAndCurrency` | `playerId,currency:string → Wallet|null` | SELECT pela chave UNIQUE; read sem lock. Ex.: carteira BRL do jogador. |
| mesmo / `findByIdForUpdate` | `id:string → Wallet|null` | beforeLock verifica ordem; SELECT explícito FOR NO KEY UPDATE; read reidrata **novo objeto** depois da aquisição. Não serve objeto antigo do Identity Map. Ausência retorna null e não bloqueia uma futura criação inexistente; UNIQUE protege essa criação. |
| mesmo / `read` privado | `sql:string, parameters:string[], locked:boolean → Wallet|null` | Executa, retorna null sem linha ou mapeia e associa objeto à sessão; não gera identidade. Compartilhado pelas três buscas. |
| mesmo / `insert` | `wallet:Wallet → void` | Associa ownership, mapeia e INSERT dos sete campos. Wallet positiva só poderá confirmar com OPENING/ledger. PK/UNIQUE/CHECK/FK/trigger podem rejeitar. |
| mesmo / `save` | `wallet:Wallet → void` | Obtém versão previamente lida sob lock, exige um avanço, mapeia; UPDATE balance/version/updated_at WHERE id/version RETURNING id; zero linhas gera erro; sucesso atualiza versão rastreada. Um crédito R$0,10 em 100.00/v1 escreve 100.10/v2. Não atualiza identidade. |
| `wager-transaction-repository.ts` / `findById` | `id:string → WagerTransaction|null` | SELECT PK por read. |
| mesmo / `findByExternalId` | `providerId,externalId:string → WagerTransaction|null` | SELECT com os dois campos da chave UNIQUE; provedor distinto não recupera transação alheia. |
| mesmo / `findByIdempotencyKey` | `providerId,key:string → WagerTransaction|null` | SELECT pelo espaço de chaves do provedor. É lookup, não idempotência/replay completos. |
| mesmo / `read` privado | `sql:string, parameters:string[] → WagerTransaction|null` | Executa, mapeia se existir e associa objeto à sessão. |
| mesmo / `insert` | `transaction:WagerTransaction → void` | Associa objeto; mapper fornece os 18 campos do INSERT. Aceita snapshot coerente permitido no schema; PROCESSED financeiro exige ledger antes do commit. |
| mesmo / `updateLifecycle` | `transaction:WagerTransaction → void` | Exige objeto carregado/inserido nesta sessão; UPDATE somente status, reference_transaction_id, failure_code, processed_at; exige RETURNING. Trigger recusa terminal/no-op/transição proibida; input original não é reescrito. |
| `ledger-entry-repository.ts` / `insert` | `entry:WalletLedgerEntry, walletVersion:number → void` | Mapper e INSERT de dez campos; banco garante equação, unicidade e relação com wallet/transação. Não existe save/delete. |
| mesmo / `listByWalletId` | `walletId:string → readonly PersistedLedgerEntry[]` | SELECT filtrado, ORDER BY wallet_version ASC,id ASC; mapeia cada linha e congela array. Vazio é []; IDs lexicais não substituem ordem financeira. Ainda sem paginação; não expor lista ilimitada em endpoint. |
| `create-repositories.ts` / `createRepositories` | `session:FinancialSession → FinancialRepositories` | Constrói os três adaptadores com a **mesma** sessão e congela envelope. Chamado pelo executor transacional; não abre transações individuais. |

### Catálogo de FinancialSession

Arquivo `financial-session.ts`; depende do EntityManager PostgreSQL e tipos do domínio.
É mecanismo interno do adaptador, não porta para SQL livre na aplicação.

| Método | Parâmetros / retorno | Passos e erros |
|---|---|---|
| constructor | `em:EntityManager → instância` | Armazena EM e chama assertActive; rejeita manager fora de transação. |
| assertActive | `() → void` | Exige flag ativa e em.isInTransaction; erro se expirou ou não há SQL transaction. Chamado por operações da sessão. |
| close | `() → void` | Marca encerrada; chamador usa finally ao terminar callback. Repositório escapado deixa de funcionar. |
| execute | `<T extends object[]>(sql:string, parameters:readonly unknown[]=[]) → Promise<T>` | Verifica escopo, copia parâmetros e chama em.execute. O MikroORM usa getTransactionContext para encaminhar à conexão transacional. Não usa connection.execute sem contexto. |
| beforeLock | `id:string → void` | Verifica atividade e ordem crescente vs último ID; registra ID; erro se ordem inversa. Mesmo ID pode ser consultado novamente, produzindo snapshot novo. |
| attachWallet | `wallet:Wallet,locked:boolean → void` | WeakMap global só identifica a sessão dona do objeto; recusa dono anterior; mapa local registra lock e versão. Leituras/insert/save usam esse método. Não impede consulta por outro processo: isso é trabalho do banco. |
| versionBeforeSave | `wallet:Wallet → number` | Exige objeto local com lock e exatamente versão anterior+1. Erra se não carregado, lido sem lock ou dois movimentos acumulados. Não modifica o objeto. |
| saved | `wallet:Wallet → void` | Após UPDATE bem-sucedido, reassocia com versão atual e lock mantido. |
| attachTransaction | `transaction:WagerTransaction → void` | Registra ownership; recusa instância de sessão anterior. Chamado por leitura/insert. |
| assertTransaction | `transaction:WagerTransaction → void` | Confirma ownership/atividade antes de atualizar lifecycle; não permite objeto avulso substituir estado existente. |

O Unit of Work **interno do ORM** calcula diferenças entre entidades gerenciadas e
emite SQL no flush. Nosso domínio usa campos privados/factories e os adaptadores
escrevem SQL imediatamente; essas entidades **não estão registradas nesse Unit of
Work nem no Identity Map**. Assim, `flush()` não salva uma Wallet só porque ela foi
mutada: chamar `save` é obrigatório. Não confundir essa estratégia aprovada com o
mapeamento automático de uma EntitySchema. O commit continua sendo do MikroORM/SQL.

### Fixtures e testes de repositórios

`infra/test/persistence-support.ts` não é importado por src. Todas as funções async
retornam Promise e propagam erros; nenhum fixture publica evento:

- `withPersistenceDatabase(run:(FinancialDatabase & {appOrm:MikroORM})=>Promise<void>)`:
  chama helper descartável existente, aplica três migrations como owner, inicializa
  **outro ORM com applicationUrl**, chama run e fecha appOrm em finally. Retorna void.
- `inRepositoryTransaction<T>(orm,work:(FinancialRepositories)=>Promise<T>):Promise<T>`:
  fork novo/limpo, transactional oficial, sessão e três repos; retorna callback;
  fecha sessão em finally. Testa adaptadores antes da unidade transacional pública.
- `persistOpening(repos,id='wallet-1',amount='100.00'):Promise<Wallet>`: Money, factory
  OPENING, Wallet.open com IDs de fixture, markProcessed; grava wallet → tx → ledger;
  devolve wallet. Assume amount positivo; abertura zero não é finalidade do helper.
- `persistCredit(repos,wallet,id,amount='0.10'):Promise<void>`: cria WIN PENDING,
  insere, wallet.credit, save, markProcessed/updateLifecycle, insere ledger/versão.
  Cada chamada gera um UPDATE; datas fixas incluem `.123` para testar precisão.

`infra/test/persistence-repositories.test.ts` contém callbacks sem argumentos →
Promise<void>, sempre em banco descartável:

1. `repositories share SQL transaction and preserve exact opening and ordered movements`:
   abertura+dois créditos; exige 100.30/v3, milissegundos, buscas em todas as chaves,
   ausência/null, ID com aspas parametrizado e histórico [v1,v2,v3] mesmo com IDs fora
   da ordem lexical. Confirma usuário app via SQL. Não prova replay.
2. `wallet saves require fresh ownership, lock and exactly one movement`: recusa Wallet
   anterior e snapshot sem lock, obtém objeto novo/saldo persistido, recusa dois créditos
   acumulados antes de save. Mutações recusadas ficam apenas na memória.
3. `repository scope expires and rejects nontransactional managers and reversed lock order`:
   recusa sessão sem transação, ordem z→a e acesso a repos depois do callback.

Os testes falham em qualquer erro/assertion inesperado. Não relaxam constraints nem
migrations. Testes de espera concorrente observável e rollback da unidade completa
serão executados no próximo incremento; um SELECT FOR NO KEY UPDATE isolado não é
prova suficiente da coordenação de duas operações.

4. `ledger order uses numeric version rather than textual 1,10,11,2 order`: callback
async sem parâmetros; cria abertura e 11 créditos, confirma versões 1..12 em sequência.
O primeiro teste encontrou ORDER BY ambíguo ao selecionar `*` e versão convertida com
mesmo nome. Corrigimos projeção explícita e ordenamos pela coluna **numérica qualificada**
`wallet_ledger_entries.wallet_version`, não pelo alias texto. Nenhuma migration mudou.

Validação dos repositórios: typecheck/build e 424 testes existentes+unitários passaram;
`bun run test:persistence` passou 6 testes (2 mappers + 4 repositórios), em PostgreSQL
real descartável. A abstração de unidade transacional da aplicação ainda não estava
implementada neste commit; os testes usam diretamente EntityManager.transactional.

## 19. Unidade transacional, commit, rollback e concorrência observável

**Caminho completo:** Nest cria o ORM com DATABASE_URL de wager_app e valida o papel;
a factory de DI fornece a unidade; um futuro caso de uso chama run; a unidade abre
transação em um fork; os três repositórios compartilham essa sessão; a leitura com
lock espera sua vez e retorna linha atual; mapper.rehydrate cria objetos; métodos de
domínio produzem estado/ledger; mappers geram strings/datas; em.execute envia SQL na
conexão transacional; callback termina; ORM executa flush; PostgreSQL avalia constraints
diferíveis e confirma; só então a Promise de run resolve. Em falha, rejeita e desfaz
as escritas. Hoje apenas fixtures de teste percorrem esse caminho financeiro.

**Exemplo de aposta, apenas explicativo:** saldo R$100, aposta R$10. O futuro caso de
uso deve adquirir lock antes de decidir, chamar wallet.debit, salvar100→90/v2 e
persistir BET PROCESSED + DEBIT10/antes100/depois90 na mesma transação. Se qualquer
parte faltar, o commit falha. Uma BET recusada permanece sem ledger. Depois desse
commit, a Outbox permitirá publicação confiável por outro processo; publicar SQS
agora criaria risco de evento que descreve dinheiro ainda não confirmado.

### O que significa cada garantia

- **Unit of Work do ORM:** rastreia alterações de entidades gerenciadas e prepara SQL
  no flush. **Nossa unidade transacional:** delimita uma operação atômica e fornece
  os adaptadores. São conceitos relacionados, não o mesmo objeto. Nosso SQL explícito
  é executado antes do flush; flush não confirma a transação nem garante sozinho que
  as constraints diferíveis passaram.
- **Identity Map:** cache de instâncias gerenciadas por identidade dentro de um EM.
  Não utilizamos esse cache para Wallet; cada SELECT/mapper devolve instância nova.
  Assim, uma leitura antiga não substitui a linha retornada pela consulta com lock.
- **Commit:** torna o conjunto visível a outras sessões e conclui as verificações
  diferidas. Um callback que retornou normalmente pode ter seu commit recusado.
- **Rollback:** desfaz alterações SQL e libera locks. Não volta no tempo no heap JS:
  uma Wallet creditada110 pode continuar110 em memória, enquanto o banco permanece100.
  Descartar/recarregar é obrigatório; ownership da sessão impede salvar o objeto antigo.
- **Isolamento READ COMMITTED:** cada comando lê dados confirmados apropriados ao
  momento da consulta. O lock pessimista serializa decisões da mesma wallet. Não
  basta SELECT antigo seguido de UPDATE: a decisão deve usar a leitura com lock.
- **Imutabilidade/encapsulamento:** o ORM não precisa abrir campos privados nem colocar
  setters no ledger; getters exportam snapshot, mapper converte e INSERT persiste.
  Reidratação usa factories existentes. Atualizar Wallet grava só seu estado mutável.

### Locks de linha

| Modo | Uso relevante | Compatibilidade relevante |
|---|---|---|
| FOR UPDATE | Protege inclusive contra alteração/remoção da chave | Conflita com KEY SHARE; pode formar o ciclo já encontrado com FKs concorrentes. |
| FOR NO KEY UPDATE | Protege alteração de saldo/versão sem trocar PK | Conflita com outro NO KEY UPDATE/UPDATE, mas permite KEY SHARE. Escolhido para Wallet. |
| FOR KEY SHARE | Protege chave referenciada, comum em validações de FK | Impede remoção/mudança de chave, permite a atualização não-chave do saldo. |

O lock existe no PostgreSQL, vale para qualquer processo/conexão e dura até commit ou
rollback. Não é um mutex JavaScript nem se limita à ordem FIFO do broker. Adquirir IDs
em ordem lexical crescente reduz ciclos; referências/identidades imutáveis e ordem
wallet → transação → ledger preservam as FKs. Não há garantia de ausência universal de
deadlocks: timeouts/retries futuros precisam considerar outros recursos e recomeçar
com nova unidade. Nenhum retry automático é feito aqui.

### Código da fronteira e DI

`src/infrastructure/persistence/financial/financial-unit-of-work.ts`:

- `MikroFinancialUnitOfWork.constructor(orm:MikroORM)`: guarda o ORM de aplicação;
  retorna instância, não abre transação. Chamado pela factory Nest e testes. A conexão
  restrita vem do módulo existente; testes usam ORM app separado do ORM de migrations.
- `run<T>(work:(FinancialRepositories)=>Promise<T>):Promise<T>`: primeiro verifica
  AsyncLocalStorage; se já há unidade financeira nesse fluxo, rejeita. Abre contexto
  assíncrono, cria fork limpo sem reutilizar contexto global, chama transactional com
  READ_COMMITTED/clear:true, cria FinancialSession e repos, aguarda work, fecha sessão
  em finally. O retorno só atravessa transactional depois do commit. Erros originais
  propagam (ex.: SQLSTATE23514,23505,42501); não são convertidos em sucesso/replay.
  Chamadores futuros recebem só portas, não EM/SQL livre. Exemplo de fixture:
  `await unit.run(repos => persistOpening(repos))`.
- Callbacks internos de `activeBoundary.run` e `fork.transactional` retornam a Promise
  da execução; o segundo recebe EM transacional. O callback `work` é fornecido pelo
  chamador. Não existem begin/commit manuais duplicados nem savepoints financeiros
  aninhados. Todas as Promises de repositório devem ser aguardadas; proibido deixar
  trabalho solto ou publicação externa dentro de work.

`persistence.module.ts` já tinha factory de opções do ORM. A nova `useFactory(orm:
MikroORM):MikroFinancialUnitOfWork` apenas constrói o adaptador, injetado pelo ORM oficial,
registra e exporta FINANCIAL_UNIT_OF_WORK. Não adiciona controllers nem inicializa
migrations. `infra/test/orm.test.ts`, no teste Nest existente, agora resolve a porta
por DI e executa callback que devolve texto; confirma provider e transação reais sem
precisar de schema financeiro nesse banco. Isso não substitui os testes financeiros.

### Testes transacionais e permissões

`infra/test/persistence-unit-of-work.test.ts`: todos os callbacks recebem nenhum
argumento, retornam Promise<void>, usam withPersistenceDatabase e falham em assertion/
erro inesperado. Não são funções de produção:

| Nome do teste | Fluxo / evidência esperada |
|---|---|
| financial boundary confirms opening together and returns only after commit | run grava abertura; consulta por outra conexão após retorno vê uma wallet, uma tx e um ledger. |
| explicit callback error rolls back all opening records | Grava os três, lança erro antes de retornar; três contagens ficam zero. |
| deferred commit failure rejects a completed callback and rolls back every write | Grava abertura correta e outra wallet positiva sem ledger; callback marca flag e retorna; commit23514 rejeita; todas as tabelas ficam vazias, inclusive abertura correta. |
| rollback leaves JavaScript mutated but forbids reuse and reloads persisted wallet | Wallet100 é creditada110 e SQL gravado, depois erro; objeto antigo continua110, repo escapado e reuse falham; nova leitura lockada retorna100/v1, sem tx/ledger abortados; novo crédito0.10 confirma. |
| nested financial boundaries fail and leave the outer scope usable | Tentativa de run interno é rejeitada sem abrir savepoint; callback externo trata esse erro local e confirma abertura. Outra run externa funciona. |
| application adapter role cannot run DDL or mutate ledger and constraints stay enabled | ORM app confirma current_user; CREATE TABLE, UPDATE/DELETE ledger, desabilitar triggers e replication_role falham42501; catálogo confirma três constraint triggers habilitadas/diferíveis/inicialmente diferidas. |
| zero opening needs neither financial transaction nor ledger | Wallet.open zero retorna entry null; INSERT confirma0.00/v1 sem tx/ledger. Não força OPENING de valor zero. |

### Testes concorrentes sem presumir locks por tempo

Arquivo `infra/test/persistence-locking.test.ts`:

- `gate():{ready:Promise<void>,open:()=>void}`: cria barreira explícita; executor recebe
  resolve e open o libera, de forma idempotente. Controla quando A permite commit.
  Não tem timer nem simula lock. Chamado pelos dois cenários.
- `within<T>(operation:Promise<T>,description:string):Promise<T>`: corre operação contra
  watchdog de5s; retorna resultado ou rejeita com contexto, limpa timer em finally.
  Watchdog limita teste travado, não prova sucesso. O watchdog não cancela consulta;
  finally dos cenários libera a barreira e aguarda sessões antes de apagar o banco.
- `observeBlockedWallet(sql:SQL):Promise<{pid:number,blockers:number[]}>`: consulta
  pg_stat_activity do banco atual, filtra espera Lock no SELECT FOR NO KEY UPDATE e
  exige pg_blocking_pids não vazio. Repete com cadência10ms até limite4s; erro se nunca
  observar. **Resultado do servidor**, não tempo decorrido, confirma bloqueio.
- Callback de cada `independent sessions serialize wallet decisions and release locks
  after commit/rollback`: seed wallets A/B; primeira unidade locka A, credita10 e abre
  held; segunda lê100, insere PENDING com FK KEY SHARE, tenta lock; observador confirma
  PID distinto bloqueado; terceira unidade locka B, credita30 e confirma enquanto A
  ainda segura o lock. Release libera primeira, por commit ou erro intencional. Segunda
  recebe objeto novo110 ou100 e credita20. SQL final exige130/v3 ou120/v2; primeira tx
  só existe no commit. Falha/deadlock é erro, nunca resultado aceito.
- Callbacks `then` capturam sucesso como null e erro como unknown para evitar rejeição
  não tratada enquanto outra sessão é observada. `finally` libera gate e aguarda
  Promise.allSettled das sessões antes de cleanup; asserts exigem sucesso onde cabível.

Esses cenários também confirmam KEY SHARE concorrente com NO KEY UPDATE: o INSERT da
FK na segunda sessão termina antes de ela ser observada esperando no lock explícito.
Uma carteira diferente avançar durante essa espera exclui um lock global na unidade
para esse cenário. Não afirmamos benchmark, tolerância a queda de processo ou ausência
universal de deadlock. As futuras Inbox e Outbox devem usar esta mesma fronteira; só
um relay após commit poderá publicar em SQS com segurança transacional.

Fontes primárias: [transações MikroORM](https://mikro-orm.io/docs/transactions),
[Unit of Work MikroORM](https://mikro-orm.io/docs/unit-of-work) e
[locks PostgreSQL17](https://www.postgresql.org/docs/17/explicit-locking.html).

### Resultado executado da etapa de persistência

Com PostgreSQL e LocalStack reais saudáveis, em23/10/2026:

| Comando | Resultado |
|---|---|
| `bun run check` (DATABASE_URL local configurada) | typecheck OK; 424 testes aprovados; build OK |
| `bun run test:persistence` | 15 aprovados: 2 mappers SQL, 4 repositórios, 7 unidade/permissões, 2 concorrência |
| `bun run test:financial` | 34 aprovados, constraints existentes preservadas |
| `bun run test:orm` | 2 aprovados, incluindo DI da nova unidade |
| `bun run test:migrations` | 2 aprovados, rollback real de DDL |
| `bun run test:infra` | 2 PostgreSQL + 4 SQS aprovados, incluindo restart/recriação |

Total: **483 testes distintos**, 44 novos sobre439. A contagem não soma novamente
execuções repetidas da mesma suite. Os testes financeiros usam bancos descartáveis;
consulta final de catálogo confirmou nenhum `dwp_test_*` restante. Consulta de
pg_tables no database principal wagering/public retornou zero linhas; nenhuma
migration financeira foi aplicada nele. Não houve alteração das classes de domínio
ou das migrations existentes, nem push.

Correções encontradas no caminho: timestamptz bruto em string exigiu conversão
explícita; ORDER BY com projeção duplicada exigiu colunas explícitas e ordenação pela
versão bigint; check inicial sem DATABASE_URL precisou da configuração local existente.
Não mascaramos essas falhas e não alteramos proteções SQL para resolvê-las.

```mermaid
sequenceDiagram
  participant C as Futuro caso de uso
  participant U as FinancialUnitOfWork
  participant R as Repositórios e mappers
  participant P as PostgreSQL
  C->>U: run(callback)
  U->>P: BEGIN READ COMMITTED
  U->>R: mesma sessão transacional
  R->>P: SELECT ... FOR NO KEY UPDATE
  P-->>R: linha atual após obter lock
  R-->>C: Wallet.rehydrate
  C->>R: save / insert por movimento
  R->>P: UPDATE Wallet + INSERT/UPDATE tx + INSERT ledger
  C-->>U: callback concluído
  Note over U: ORM chama flush (sem entidades financeiras gerenciadas)
  U->>P: COMMIT e constraints diferíveis
  alt todas as invariantes satisfeitas
    P-->>U: confirmado; locks liberados
    U-->>C: resultado
  else erro
    P-->>U: rollback; locks liberados
    U-->>C: rejeição; descartar objetos mutados
  end
```

Próxima funcionalidade recomendada: contratos de eventos e persistência transacional
Inbox/Outbox, com nova autorização. Ainda faltam relay, consumers, replay HTTP,
retry/TTL e casos de uso públicos. A integração desta etapa não prova essas partes.

## 20. Integration Events v1

Arquitetura orientada a eventos comunica fatos que já ocorreram. Domain Event descreve
um fato interno do modelo; Integration Event é contrato serializável entre sistemas,
com versão estável. Criar objeto ainda não publica nada: só a futura Outbox confirmada
poderá ser publicada. Uma BET rejeitada gera Rejected, nunca BalanceChanged. LOSS
processada gera Processed sem ledger/mudança de saldo. OPENING positiva gera Processed
+ BalanceChanged; abertura zero não gera esses eventos (decisão aprovada).

Identidade: eventId identifica **uma ocorrência** e será reutilizado na redelivery;
aggregateId identifica transação nos três eventos de transação e wallet em BalanceChanged;
correlationId acompanha o fluxo inteiro; causationId opcional identifica sua causa
(mensagem/comando/evento anterior); version=1 identifica formato, não a versão do saldo.
IDs e occurredAt são fornecidos pelo chamador; não há relógio/UUID escondido. Todos os
payloads incluem walletId. Hash de entrada/idempotencyKey não são expostos no evento.

Catálogo (arquivos em `src/domain/messaging`; erros propagam ao chamador):

| Função / classe | Parâmetros → retorno; fluxo, uso e erros |
|---|---|
| message-values.ts/assertIdentifier | string→void; rejeita vazio/espaços/controles com TypeError. Usado nas identidades de mensagens/contexto. |
| timestamp | Date→number de milissegundos; exige Date finita; usado no armazenamento privado de datas. Número aqui é tempo, nunca dinheiro. |
| immutableJson<T> | T, ancestors:Set<object> interno→T; copia arrays/objetos simples recursivamente, congela todos os níveis; recusa ciclos, Date, Money, bigint, undefined e números não finitos. Protege payloads sem conversões JSON silenciosas. Callbacks map percorrem filhos, propagando TypeError. |
| integration-event.ts/IntegrationEvent<T>.constructor protected | IntegrationEventProps<T>→instância; valida IDs, copia timestamp e congela cópia de data. Base abstrata, chamada pelas quatro subclasses. |
| occurredAt getter | ()→Date nova, preservando instante interno. Mutar a cópia não altera evento. |
| toJSON | ()→IntegrationEventJSON<T>; envelope completo, ISO UTC, causationId ausente se não fornecido; cópia profundamente congelada. Chamado por JSON.stringify e Outbox. |
| financial-events.ts/transactionData | tx:WagerTransaction,status esperado→TransactionEventData; exige instância/status, copia identidades, referências e money.toJSON. Erro se evento não corresponde ao estado. Helper das três factories. |
| WagerTransactionProcessed.from | tx,ctx:EventContext→evento v1; exige PROCESSED, inclui LOSS/OPENING; aggregateId=tx.id. |
| WagerTransactionRejected.from | tx,ctx→evento v1; exige REJECTED, inclui failureCode estável. FAILED não é rejeição de negócio. |
| WagerTransactionPendingReference.from | tx,ctx→evento v1; exige PENDING_REFERENCE e preserva referência externa. |
| WalletBalanceChanged.from | wallet:Wallet,entry:WalletLedgerEntry,ctx→evento v1; exige wallet/ledger compatíveis, saldo final igual e lançamento equilibrado; captura MoneyProps e walletVersion. Chamador deve passar o lançamento da movimentação corrente. |
| construtores privados das quatro subclasses | props tipadas→instância; super valida/copia, campos fixam eventType/version, Object.freeze sela a superfície pública. Sem transições ou setters. |

`test/integration-events.test.ts`: helper transaction(kind=BET,reference=false) cria
entidades de teste, inclusive OPENING interna/LOSS zero. Callbacks test.each verificam
Processed para BET/WIN/LOSS/OPENING; os demais verificam Rejected/Pending e transições
recusadas, BalanceChanged/imutabilidade/datas, contexto/causationId e cópia JSON
sem perda. Todos retornam void e lançam assertion em divergência. Nenhuma dependência
Nest/ORM é importada pelo domínio. Exemplo: crédito10.00 BRL gera payload com
`money:{amount:"10.00",currency:"BRL"}`, nunca uma instância Money ou valor binário.

## 21. Modelos de Inbox e Outbox

Inbox é recibo persistente de uma mensagem para um consumidor; Outbox é a intenção
persistente de publicar um evento. As duas participam da mesma transação dos efeitos.
At-least-once significa entrega uma ou mais vezes: ack pode falhar depois do commit,
ou o publisher pode morrer depois de enviar e antes de marcar published. eventId deve
permanecer estável; não alegamos publication exactly-once. DLQ é fila para mensagens
que exigem investigação após falhas; não é a tabela Outbox nem descarta sua pendência.

Arquivos em `src/domain/messaging`, sem Nest/ORM. Métodos são síncronos; os modelos
são chamados pelos futuros casos de uso e pelos mappers/testes nesta etapa:

| Método | Contrato e passos / erros |
|---|---|
| event-envelope.ts/validateEnvelope | IntegrationEventJSON<unknown>→void; exige JSON puro, IDs, versão1, timestamp UTC canônico, tipo conhecido, dados/money e aggregateId compatíveis; verifica estado/rejeição/referência e equação de saldo. TypeError/MoneyError/RangeError em dados inválidos. Não publica nem consulta entidades. |
| InboxMessage.constructor privado | InboxMessageState, token→instância; valida IDs/hash/datas e processedAt≥receivedAt, guarda epoch, congela superfície. Token impede bypass runtime da factory. |
| InboxMessage.receive | ReceiveInboxProps→InboxMessage; nasce não processada, ignora processedAt extra; não consulta banco. |
| InboxMessage.rehydrate | InboxMessageState→InboxMessage; preserva snapshot e processedAt sem repetir markProcessed. |
| receivedAt/processedAt getters | ()→Date/Date\|undefined; cópias defensivas do epoch. |
| InboxMessage.isProcessed | ()→boolean; verifica presença do instante final. |
| InboxMessage.markProcessed | at:Date→void; valida instante, recusa repetição e tempo anterior ao recebimento, altera só campo privado. |
| InboxConflictError.constructor | ()→erro com code INBOX_PAYLOAD_CONFLICT; identifica conflito de conteúdo, não replay. Futuro repositório o utiliza. |
| OutboxMessage.constructor privado | OutboxMessageState,token→instância; valida envelope/espelho id,agregado,tipo,data, attempts inteiro0..2147483647 e shape do agendamento/publicação; copia/congela payload. Não recalcula backoff reidratado. |
| OutboxMessage.enqueue | IntegrationEvent<unknown>→OutboxMessage; id=eventId, payload=toJSON, attempts0 e sem agendamento/publicação. Não gera nova identidade. |
| OutboxMessage.rehydrate | OutboxMessageState→OutboxMessage; reconstrói inclusive retry/publicado, sem executar transição. |
| occurredAt/nextAttemptAt/publishedAt getters | ()→Date ou undefined defensivas; attempts getter retorna contador de falhas, nunca valor monetário. |
| OutboxMessage.isPending | ()→boolean; publishedAt ausente. |
| OutboxMessage.isDue | now:Date→boolean; pendente e now≥nextAttemptAt ou occurredAt. Relógio explícito permite testes determinísticos. |
| OutboxMessage.markPublished | at:Date→void; exige devido/pendente, preenche publishedAt e limpa próximo retry; erro se terminal/cedo. Chamado somente após futura confirmação do broker. |
| OutboxMessage.scheduleRetry | now:Date→void; exige devido e contador disponível, calcula min(1000×2^attempts,300000)ms, valida Date futura antes de mutar; incrementa contador e agenda. Limita expoente para impedir overflow. Não descarta nem publica. |

Exemplo: falhas às12:00:00,12:00:01,12:00:03 agendam12:00:01,12:00:03,12:00:07.
Após muitas falhas, intervalo fica5min. Um evento publicado não volta a pendente.
Falha de negócio: futura transação rejeitada + evento + ack após commit. Indisponibilidade
transitória: rollback/retry. Payload inválido permanente: política futura de DLQ. Nenhum
desses workers está implementado; não confundir transições de objeto com automação.

`test/message-models.test.ts`: helper event() cria LOSS PROCESSED v1; quatro callbacks
void testam Inbox receber/processar/rehidratar/datas/erros; Outbox identidade/publicação/
imutabilidade; 15 falhas com intervalos exatos e teto; reidratação sem incremento e
rejeição de envelope/lifecycle divergente. Exceptions/assertions falham testes, sem mocks.

## 22. Schema persistente de mensagens

`migrations/Migration20261023000004.ts`: `up():Promise<void>` agenda SQL via addSql,
criando funções, tabelas, índice, triggers e grants; `down():Promise<void>` remove só
as duas tabelas/funções novas. Chamados pelo Migrator oficial; falhas causam rollback
de DDL. Down apaga mensagens, portanto testes apenas em banco descartável. Nenhuma
migration financeira anterior foi alterada.

| Operação SQL criada | Parâmetros/retorno, fluxo, motivo e erros |
|---|---|
| message_json_id | jsonb→boolean; string não vazia/sem espaços/controle; COALESCE false evita NULL passar como CHECK válido. Usada no envelope. |
| message_json_money | jsonb→boolean; objeto com amount string/regex2casas/moeda suportada; cast financial_amount confere teto/escala; exceção de conversão/constraint vira false. Não arredonda. |
| valid_integration_payload | jsonb→boolean; valida objeto/envelope v1/UTC/IDs/data; valida Money, tipo/estado; BalanceChanged confere moeda/equação/versão segura; demais eventos conferem kind/zeroLOSS/failure/referência necessária. Chamado pelo CHECK. Não tenta reaplicar domínio nem buscar transação financeira. |
| inbox_messages | PK composta; hash obrigatório; datas finitas e processed≥received; INSERT duplicado gera23505, não compara hash automaticamente. Comparação semântica ocorrerá no repositório. |
| outbox_messages | PK id, JSONB CHECK, espelho de id/agregado/tipo/data, attempts int32≥0, agendamento coerente, published sem next. Identidade única do evento, sem confundir tentativas com novos eventos. |
| outbox_due_idx | índice parcial dos pendentes, chave de vencimento/occurred/id; suporta busca ordenada e futura disputa SKIP LOCKED. Não é mutex global. |
| guard_message_state | trigger→NEW; UPDATE Inbox só null→processed e identidade intacta; Outbox só retry(attempts+1/next avança) ou publicação(attempts igual/next null), terminal imutável. DELETE/TRUNCATE recusados23514. App sem essas permissões falha42501 antes. |
| grants/revokes | app SELECT/INSERT e UPDATE somente processed_at ou attempts/next/published; executa helpers usados nos CHECKs, não recebe DDL. Funções sem SECURITY DEFINER; search_path fixo. |

Persistir evento JSON não garante que alguém o publicou. Não existe FK polimórfica
nem trigger que obrigue Outbox para todo SQL financeiro: futuros casos de uso precisam
chamar os cinco repositórios dentro de run. Atomicidade impedirá que falha nessa unidade
confirme apenas parte do conjunto. Administrador com poder de DDL não é adversário
contido pelos grants do usuário app.

`infra/test/messaging-schema.test.ts`: três callbacks async sem parâmetros→Promise<void>.
Primeiro aplica/up sem pendências/down até00003/reaplica, preservando tabela wallets.
Segundo prova PK por consumidor, colisão/hash imutável/transição terminal e permissões.
Terceiro usa helper local insert(value:unknown,id='event')→Promise de INSERT; testa
JSON faltante/versão inválida/amount number/escala inválida/espelho divergente/duplicação,
retry/publicação e proibição de alterar payload ou truncar. Passa o objeto diretamente como parâmetro no cliente Bun: JSON.stringify seguido
de inferência JSONB duplicava a codificação. A tentativa intermediária app.json não
existe nessa versão e foi recusada pelo typecheck; a fixture foi corrigida para o
parâmetro objeto nativo. O CHECK não foi relaxado. Todos usam PG real.

Validação SQL da migration00004 após corrigir a fixture: 3 testes reais aprovados,
35 assertions, incluindo down/up. Typecheck aprovado. A correção da fixture foi
registrada separadamente; o commit inicial do schema precedeu essa correção.

## 23. Mappers e repositórios de mensagens na mesma transação

Um exemplo completo agora testado: recebemos message-wallet; Inbox registra hash;
Wallet abre100.00; OPENING/ledger são inseridos; dois eventos v1 são enfileirados na
Outbox; Inbox é marcada processada. O commit confirma tudo junto. Um erro no último
CHECK financeiro desfaz **inclusive os eventos e processedAt**, mesmo que o callback
já tenha terminado. Depois de rollback, não se dá ack e não se reutilizam objetos
mutados. Na próxima tentativa, nova sessão consulta novamente o banco.

MessageId identifica mensagem lógica do envelope consumido. Não é idempotencyKey da
operação e não deve ser substituído automaticamente pelo ReceiptHandle do SQS, que
muda em redelivery. A identidade/receipts de transporte serão tratados no consumidor.
Uma operação financeira reenviada em **outro messageId** ainda requer a idempotência
por provedor já desenhada para WagerTransaction; Inbox não substitui isso. payloadHash
é fornecido pelo futuro adaptador confiável que calculará JSON canônico, não prova de
integridade se aceito cegamente do remetente. Hash diferente na mesma chave é conflito.

### Contratos e chamadas

`src/application/ports/message-persistence.ts` define InboxRepository e OutboxRepository
somente com tipos do domínio. FinancialRepositories ganhou essas duas propriedades;
run(callback) mantém a mesma assinatura e semântica. As tabelas só são acessadas quando
a operação usa os novos repositórios, portanto iniciar Nest não executa migrations.

Arquivos abaixo em `src/infrastructure/persistence/financial`; métodos async retornam
Promise e propagam erros de domínio, TypeError/RangeError, sessão expirada e SQLSTATE.
SQL usa placeholders e parâmetros separados; não concatena valores de mensagens.

| Método/função | Parâmetros → retorno resolvido; fluxo, chamadores e erros |
|---|---|
| message-mappers.ts/InboxMapper.toDomain | InboxRecord→InboxMessage; snake_case→camelCase, readTimestamp, null→undefined; rehydrate valida estrutura sem processar de novo. Usado por receive. |
| InboxMapper.toRecord | InboxMessage→InboxRecord; extrai identidade/hash/cópias Date, undefined→null. Usado por receive e testes; nunca gera IDs. |
| OutboxMapper.toDomain | OutboxRecord→OutboxMessage; mantém JSONB, id/tipo/agregado/attempts; converte datas; rehydrate não calcula retry nem publica. Validação de envelope recusa inconsistências de representação. |
| OutboxMapper.toRecord | OutboxMessage→OutboxRecord; getters e payload imutável, null nas datas ausentes. Usado por insert/save. Contador é number int32, dinheiro permanece string dentro de JSONB. |
| inbox-repository.ts/MikroInboxRepository.constructor | session:FinancialSession→instância; armazena sessão já transacional, não abre conexão. |
| receive | ReceiveInboxProps→{message:InboxMessage,disposition:'new'\|'pending'\|'processed'}; valida via receive de domínio, INSERT com PK e DO NOTHING; se colidiu, SELECT FOR UPDATE em novo comando; exige linha, compara hash e lança InboxConflictError se divergir; mapeia/associa ownership e informa estado. Chamador deve sair sem efeitos em processed. |
| save da Inbox | message:InboxMessage→void; exige objeto desta sessão e processedAt definido; UPDATE só processed_at WHERE chave/processed_at NULL RETURNING; zero linhas significa já processada. Chamado após efeitos e Outbox. |
| outbox-repository.ts/MikroOutboxRepository.constructor | session:FinancialSession→instância; compartilha EM, sem transação independente. |
| insert da Outbox | message:OutboxMessage→void; verifica ownership, mapeia e INSERT dos oito campos; JSON.stringify é passado ao driver MikroORM com cast jsonb explícito. Colisão eventId23505 propaga; não sobrescreve evento divergente. |
| findByIdForUpdate | id:string→OutboxMessage\|null; SELECT FOR UPDATE na PK; reidrata e associa ownership, null se ausente. Permite atualizar lifecycle com lock até fim SQL. |
| listDue | now:Date,limit:number→readonly OutboxMessage[]; exige data finita e limite inteiro1..1000; SELECT pendentes vencidos, ORDER BY vencimento/occurredAt/id, LIMIT; mapeia/congela array. Snapshots não recebem ownership para save. Consulta não reivindica publicação. |
| save da Outbox | message:OutboxMessage→void; exige ownership; UPDATE attempts/next/published WHERE id e ainda pendente; exige RETURNING. Trigger protege sequência/estado terminal. Não envia SQS. |
| createRepositories modificado | session→FinancialRepositories; constrói cinco adaptadores com a mesma sessão e congela envelope. Chamado pelo callback transactional existente. |
| FinancialSession.attachMessage | InboxMessage\|OutboxMessage→void; assertActive, verifica token dono, recusa outra sessão, registra token. Usado em inserção/recebimento/leitura lockada. |
| FinancialSession.assertMessage | InboxMessage\|OutboxMessage→void; exige sessão ativa e token igual; recusa snapshot sem lock, objeto escapado ou mutado em rollback. Usado em saves. |

O INSERT da Inbox pode aguardar outra sessão por causa da PK. Se ela confirmar,
DO NOTHING retorna sem linha; o **SELECT seguinte** vê o resultado confirmado. Usar
CTE com um SELECT no mesmo snapshot pode não ver a linha que causou conflito. Se a
primeira sessão fizer rollback, o INSERT concorrente poderá criar a linha e executar
a operação. Esse protocolo usa estado do PostgreSQL, não cache/mutex em memória.

A ordem comum dos locks deve ser Inbox (se houver), depois wallets em ordem crescente.
Um futuro handler HTTP não toma lock de Inbox. O publisher deve tratar Outbox em fluxo
separado e nunca adquirir wallet depois de segurar eventos para publicar. O índice
parcial prepara seleção SKIP LOCKED; não implementamos o worker, seu lease nem envio.

### O que acontece depois de um crash

Se o processo morre **antes do commit**, PostgreSQL reverte a operação. Se morre após
commit mas antes de publicar, a Outbox permanece pendente; outro publisher poderá
selecioná-la depois. Se o envio foi aceito pelo SQS mas publishedAt não foi confirmado,
a publicação poderá repetir com o **mesmo eventId**. At-least-once exige consumidor
idempotente. Nenhuma transação SQL pode desfazer uma mensagem já enviada ao broker;
por isso não fazemos publicação dentro do callback financeiro ou antes do commit.

Após uma falha transitória do broker, o futuro publisher chamará scheduleRetry e
persistirá a agenda em uma transação apropriada. Após erro permanente, precisará
registrar/alertar a condição segundo política ainda não implementada. A mensagem não
é descartada automaticamente pelo contador. Falha de negócio em aposta é outro caso:
REJECTED + evento são confirmados e a entrada poderá receber ack. Pendência de referência
não autoriza duplicar ledger: registra-se PENDING_REFERENCE e evento, para worker futuro.

### Fixtures e testes: catálogo completo

`infra/test/messaging-support.ts`:

- `messageAt`: instante fixo com milissegundos; permite comparar identidade temporal.
- `withMessagingDatabase(run:(FinancialDatabase & {appOrm,unit})=>Promise<void>):Promise<void>`:
  cria banco descartável, aplica00004 e antecessoras como migrations, cria ORM **app**
  separado e unidade, aguarda callback, fecha ORM em finally; helper externo apaga
  só o banco de teste. Falhas de migração/SQL/assertions propagam.
- `openingWithMessages(repos,id='wallet',hash='hash',withInbox=true):Promise<'applied'|'replay'>`:
  recebe Inbox opcional, sai em processed; chama fixture persistOpening, recupera tx e
  ledger; cria Processed/BalanceChanged com eventIds fixos por fixture; insere Outbox;
  marca/salva Inbox. Não é caso de uso público e não é importado por src. HTTP simulado
  usa withInbox=false; valores default só existem nos testes.

`infra/test/messaging-transactions.test.ts`: callbacks async→Promise<void>; usam
fixture/mappers/repositórios reais e falham em assertions/erros inesperados:

| Nome | Passos/evidência |
|---|---|
| atomic opening persists outbox with broker inbox=true/false | run completo, consulta separada exige1wallet/1tx/1ledger/2eventos e1ou0Inbox; lista ordenada conserva amount100.00 e timestamp. |
| failure at callback/commit rolls back financial rows inbox and outbox | lança erro após fixture ou insere wallet inválida sem ledger; verifica callback terminado no caso diferível; todas as cinco tabelas ficam vazias; nova tentativa é aplicada. |
| persistent replay has no second financial effect and divergent hash conflicts | confirma fixture, fecha ORM, inicializa novo ORM app/unidade; mesma mensagem retorna replay, hash divergente retorna código específico; ledger1 e eventos2. Finalmente fecha ORM novo. |
| pending inbox resumes and message objects cannot cross rollback boundary | confirma Inbox pendente, retoma sob lock, marca processada e força rollback; objeto JS continua processado, save em nova unidade é recusado, leitura persistida permite nova execução. |
| outbox rehydrates retry and publication and rejects stale read-only snapshots | agenda retry sob lock e salva; nova unidade conserva attempts/next, listDue exclui futuro; recusa objeto anterior e snapshot de lista; publica em instante devido e confirma leitura de publishedAt. Limite inválido e ID ausente também testados. |
| all four event types survive JSONB mapping with stable type and version | cria abertura, LOSS processada, BET rejeitada, REFUND pendente com suas tx/eventos; lê JSONB e exige quatro tipos, v1/IDs/datas/amount string; somente abertura tem ledger. |

`infra/test/messaging-concurrency.test.ts`:

- `gate():{ready:Promise<void>,open:()=>void}` cria barreira explícita; o executor
  Promise captura resolve como open. Segura commit da sessão A, não simula lock SQL.
- `bounded<T>(operation:Promise<T>):Promise<T>` corre contra watchdog5s, retorna
  resultado ou erro de timeout e limpa timer em finally; não é evidência de lock.
- `observeWait(sql:SQL,table:string):Promise<void>` consulta pg_stat_activity filtrando
  banco/espera Lock/tabela e pg_blocking_pids não vazio; confere PID distinto; polling10ms
  até4s. A espera é comprovada pelo servidor, não inferida por atraso.
- Dois casos `concurrent Inbox waits then checks payload hash/different`: A persiste
  fixture e segura commit; B tenta mesma chave; observador confirma espera; outra
  mensagem/wallet confirma durante bloqueio; A libera; B retorna replay ou conflito,
  com apenas1ledger/2eventos para wallet original.
- `concurrent Outbox inserts wait and reject duplicate event identity`: A grava evento
  e segura commit; B reidrata cópia independente e tenta mesmo eventId; observa espera;
  libera A; B falha23505; uma linha permanece. Não é teste de publisher concorrente.
- Callbacks then capturam erros como resultados para evitar rejeições não tratadas;
  finally libera barreiras e aguarda allSettled antes de remover banco. Resultado
  errado/deadlock/timeout faz o teste falhar; não aceitamos erro como prova de sucesso.

Cobertura complementar em `test/message-models.test.ts`: teste `invalid lifecycle times
and attempt overflow leave snapshots unchanged` verifica data prematura/inválida,
limite int32 e Inbox com processed anterior; estado não se altera quando a transição
falha. Callback void, helper event já documentado na seção21.

Regressão ajustada em `infra/test/financial-ledger.test.ts`: o teste de down/up das
**três migrations financeiras** agora passa `{to:migration}` ao Migrator, preservando
a mesma exigência de3 registros e limpeza total. Antes `up()` passou a aplicar também
a quarta migration e invalidou a premissa do teste. A nova migration tem teste próprio
de up/down/reaplicação; não removemos assertions nem alteramos constraints antigas.

### Evidência final desta etapa — 23/10/2026

| Comando executado | Resultado real |
|---|---|
| `bun run check` com DATABASE_URL local | typecheck OK;437 testes aprovados;build OK |
| `bun run test:messaging` | 14 aprovados:3schema,8atomicidade/mapeamento/lifecycle,3concorrência |
| `bun run test:persistence` | 15 aprovados |
| `bun run test:financial` | 34 aprovados |
| `bun run test:orm` | 2 aprovados |
| `bun run test:migrations` | 2 aprovados |
| `bun run test:infra` | 2PostgreSQL+4SQS aprovados |

Total510 testes distintos (27 novos sobre483); não somamos repetição de suites. As
consultas finais de pg_tables em wagering/public e pg_database para dwp_test_* retornaram
zero linhas. Nenhuma migration foi aplicada ao principal. Os testes SQS são regressões
da infraestrutura anterior, não validação de um publisher/consumer novo.

Problemas encontrados: fixture Bun precisava de JSON nativo; teste antigo de migrations
precisou explicitar até00003; tentativa de usar disconnect no ORM foi recusada pelo
typecheck e o teste foi implementado fechando/recriando a instância oficial. Cada falha
foi corrigida e o cenário correspondente executado com sucesso. Não houve relaxamento
de constraints para resolver falhas.

Garantias demonstradas: eventos tipados/imutáveis; mensagens persistidas com unicidade
por consumidor/evento; hash conflitante explícito; rollback integral das cinco tabelas;
replay persistente na fixture; ausência de bloqueio global nos cenários observados.
Continuam pendentes: cálculo canônico de hash na admissão, casos de uso públicos,
replay HTTP, publishers/consumers, lease/claim concorrente de publicação, ack e DLQ
operacionais, kill-process e reprocessamento de referências. Não afirmamos que chamar
save de Wallet sozinho passa a produzir eventos automaticamente.

## 24. Conflito explícito na criação de carteira

Primeiro incremento de CreateWallet: converter apenas a unicidade esperada, sem
ocultar outros defeitos de persistência. Não fazemos SELECT antes do INSERT: duas
sessões poderiam observar ausência simultaneamente. O índice UNIQUE é a autoridade.

- `WalletAlreadyExistsError.constructor(options?: ErrorOptions)`, em
  `src/application/errors/wallet-already-exists-error.ts`: cria Error com nome próprio,
  código `WALLET_ALREADY_EXISTS` e causa opcional. Não contém HTTP nem ORM; o futuro
  controller poderá traduzir esse conflito em409. Retorna a instância construída;
  não consulta banco e não implica replay. Exemplo: segunda abertura BRL para player1.
- `MikroWalletRepository.insert(wallet: Wallet): Promise<void>`, em
  `src/infrastructure/persistence/financial/wallet-repository.ts`: mantém ownership,
  mapper e INSERT parametrizado. Agora captura erro somente se SQLSTATE23505,
  schema public, tabela wallets e constraint wallets_player_currency_unique
  coincidirem; lança o erro de aplicação preservando cause. Todos os demais erros
  são relançados intactos. A UOW recebe a rejeição e faz rollback; não tentamos usar
  a transação SQL já abortada. Chamado por casos de uso e testes de repositório.
- Teste `only the player and currency constraint becomes a wallet creation conflict`,
  em `infra/test/wallet-creation-conflict.test.ts`: callback async sem parâmetros,
  retorna Promise<void>. withMessagingDatabase aplica migrations em banco descartável;
  helper local `make(id: string, playerId: string): Wallet` usa Wallet.open real,
  Money.zero(BRL) e data atual. Insere uma carteira, repete jogador/moeda e verifica
  classe/código/cause; repete ID com outro jogador e exige wallets_pkey original.
  Consulta final exige apenas uma linha. Qualquer erro inesperado/assertion/timeout
  falha o teste, cujo finally de suporte fecha conexões e remove só esse banco.

Evidência executada: typecheck aprovado; esse teste real aprovado (5 assertions).
O caso de uso completo ainda será implementado no próximo incremento desta etapa.

## 25. CreateWallet: da intenção de abertura ao commit

### Problema e papéis das camadas

Um **caso de uso** representa uma intenção completa do usuário: aqui, abrir uma
carteira. Ele precisa coordenar operações que isoladamente não bastam: criar Wallet,
registrar a origem do saldo, guardar o lançamento e preparar eventos. Pertence à
camada de aplicação porque determina quando esses objetos colaboram e qual é a
fronteira atômica. As regras de dinheiro, crédito e estados continuam no domínio.

Controller recebe HTTP, autentica/adapta a entrada e traduz resultado/erros para HTTP.
CreateWallet coordena a operação independente de transporte. Repository converte
objetos em registros e executa persistência. A UOW fornece repositórios da mesma
transação. Nesta etapa o controller não existe: teste/composição Nest chamam execute
diretamente. Não adicionamos uma segunda implementação de aritmética ou de ledger.

Exemplo: Ana abre uma carteira com 100.00 BRL antes de apostar 25.00. A abertura deve
explicar de onde vieram os 100.00. OPENING é uma transação interna, sem jogo externo;
o ledger CREDIT registra 0.00 → 100.00. Saldo atual é o estado materializado consultado
rapidamente; ledger é histórico imutável que permite conferir sua evolução. A futura
BET de 25.00 precisará de outro lançamento 100.00 → 75.00, mas não foi implementada aqui.
Começar em 0.00 não altera dinheiro e não produz OPENING/ledger/eventos financeiros.

### Contrato e fluxo completo

`src/application/wallet/create-wallet.ts` exporta os tipos readonly CreateWalletInput
(`playerId: string`, `initialBalance: Readonly<MoneyProps>`) e CreatedWallet (`id`,
`playerId`, `balance: Readonly<MoneyProps>`, `version: number`). Version é contador;
amount permanece string. O DTO é congelado também em balance; não expõe métodos ou
estado mutável de entidades. Money.from valida o contrato externo de duas casas.

```mermaid
sequenceDiagram
  participant Caller as Chamador futuro API
  participant UC as CreateWallet
  participant UOW as FinancialUnitOfWork
  participant PG as PostgreSQL
  Caller->>UC: execute(playerId, initialBalance)
  UC->>UC: Validar entrada e Money; ler relógio
  UC->>UOW: run(callback)
  UOW->>PG: BEGIN READ COMMITTED
  UOW->>UC: Repositórios com o mesmo EntityManager
  UC->>UC: Wallet.open + ledger em memória
  UC->>PG: INSERT Wallet
  opt Saldo positivo
    UC->>UC: createOpening + markProcessed
    UC->>PG: INSERT OPENING
    UC->>PG: INSERT ledger CREDIT versão 1
    UC->>PG: INSERT WagerTransactionProcessed
    UC->>PG: INSERT WalletBalanceChanged
  end
  UC-->>UOW: Snapshot da resposta
  UOW->>PG: COMMIT e constraints diferíveis
  PG-->>UOW: Confirmação ou erro
  UOW-->>Caller: DTO somente após commit; rejeição se falhar
```

Os cinco INSERTs da abertura positiva compartilham uma transação: o teste consulta
xmin das quatro tabelas e encontra um único identificador de transação PostgreSQL.
As FKs exigem Wallet antes de OPENING e OPENING antes de ledger. A factory Wallet.open
cria o lançamento em memória antes das escritas; sua persistência ocorre depois da
transação financeira. Não chamamos credit novamente: isso criaria outro movimento.

Evento criado em memória não foi publicado. Outbox armazena a intenção de publicação
antes do commit, sem torná-la visível a outras sessões antes de confirmar. Publicar
SQS dentro do callback permitiria enviar um fato que depois seria desfeito no banco.
Um publisher futuro lerá registros confirmados; suas falhas/reentregas ainda precisam
de tratamento próprio. Não há Inbox: não recebemos mensagem de broker nesta operação.

### Catálogo do código de produção

**CreateWallet.constructor(unit, ids, clock)**, em `src/application/wallet/create-wallet.ts`.
Parâmetros: FinancialUnitOfWork, IdGenerator e Clock. Retorna nova instância; armazena
somente serviços, sem I/O, entidades ou cache por jogador. Chamadores: useFactory de
WalletApplicationModule e helper creator dos testes. Dependências são portas; não
depende de Nest/MikroORM. Não valida serviços fornecidos por código confiável; erros
desses serviços serão propagados durante execute. Exemplo: real UOW + UUID + SystemClock.

**CreateWallet.execute(input: CreateWalletInput): Promise<CreatedWallet>** no mesmo arquivo.
Usado pelo futuro adaptador HTTP e diretamente nos testes. Fluxo passo a passo:

1. Recusa entrada não objeto/array e playerId vazio, não string, com espaços/controles.
   Copia playerId e cria Money imutável, evitando conservar o objeto de entrada.
2. Compara Money com 999999999999999999.99 na mesma moeda. Esse é limite de admissão
   para o schema atual, não mudança no Money; o banco ainda verifica sua própria faixa.
3. Consulta Clock.now uma vez. Entra em unit.run, que inicia transação real.
4. Gera walletId. Se positivo, gera transactionId e ledgerEntryId. Wallet.open real
   valida IDs/data e devolve Wallet versão 1 e lançamento; zero devolve lançamento null.
5. Persiste Wallet. Para saldo positivo, calcula hash e chama createOpening real;
   marca PROCESSED com a data defensiva de Wallet. Persiste OPENING e ledger versão 1.
6. Gera um eventId por evento. Factories reais capturam snapshots coerentes.
   OutboxMessage.enqueue inicia attempts=0, sem nextAttemptAt/publishedAt; dois INSERTs.
7. Retorna DTO congelado ao callback. run só resolve após commit; execute adota essa
   Promise, portanto um erro no commit rejeita também o resultado público.

Erros: TypeError para entrada/playerId; MoneyError INVALID_AMOUNT/UNSUPPORTED_CURRENCY;
RangeError para teto; erros de Wallet/Wager/Event para dependências inválidas;
WalletAlreadyExistsError para duplicação esperada; demais erros SQL/infra preservados.
Nenhum catch transforma falha em sucesso; não há retry interno. Nova chamada constrói
novos objetos/IDs. Exemplo real de teste: execute({playerId:'player',initialBalance:
{amount:'000100.00',currency:'BRL'}}) devolveu case-1/player/100.00 BRL/version 1.

**Callback de unit.run(repos: FinancialRepositories): Promise<CreatedWallet>** dentro
de execute: dono temporário das entidades; utiliza exclusivamente os cinco adaptadores
fornecidos (Inbox não é chamada). Todos os awaits de persistência são sequenciais.
Retorna snapshot ou rejeita; fechamento/rollback/commit pertencem à UOW existente.
Não escapa repositório nem entidade para armazenamento fora do callback.

**openingPayloadHash(wallet: Wallet, transactionId: string, ledgerEntryId: string): string**
no mesmo arquivo, helper privado usado só por execute. Constrói objeto com ordem fixa:
version, kind, providerId, transactionId, externalTransactionId, idempotencyKey,
walletId, playerId, ledgerEntryId, roundId, gameId, money, createdAt. Serializa JSON
UTF-8 sem espaços; Money.toJSON normaliza quantia, Date.toISOString normaliza UTC.
createHash('sha256').update(...).digest('hex') retorna 64 caracteres. Dependência
node:crypto testada sob Bun; erros de serialização/crypto propagam e abortam UOW.
Não é canonicalizador genérico nem autenticação; hash não substitui chave UNIQUE.
No fixture case-1/case-2/case-3, player, 100.00 BRL, 15:00:00.123Z de 23/10/2026, o hash
é `f6deebec8b4668f02abeaca73d6b65dac83b9508d286246231aea484c583b298`.
Foi conferido independentemente com hashlib/json Python e fixado no teste.

**IdGenerator.next(): string e Clock.now(): Date**, em `src/application/ports/runtime.ts`:
contratos sem implementação, parâmetros ou I/O próprio. CreateWallet é o consumidor;
testes e runtime fornecem implementações. Injetar serviços em vez de chamar APIs
globais dentro de entidades permite IDs/datas previsíveis sem alterar o domínio.

**UuidGenerator.next(): string**, em `src/infrastructure/application/runtime.ts`:
delegação a node:crypto.randomUUID, sem parâmetros; devolve UUID v4. Construtor implícito
sem parâmetros/estado; criado pela composição Nest. Falhas de crypto propagam; colisão,
embora improvável, é rejeitada por PK, não tratada como conflito de jogador. UUID não
é uma sequência ordenada. Exemplo de formato: 8-4-4-4-12 dígitos hexadecimais.

**SystemClock.now(): Date**, no mesmo arquivo: retorna new Date a cada chamada; sem
parâmetros/estado e com construtor implícito vazio. Chamado por execute via Clock;
representa instante da operação, não comprova sincronização entre máquinas. A factory
de Wallet valida a data e armazena timestamp defensivo. Teste Nest verifica que a data
gravada está entre instantes imediatamente anterior/posterior à chamada.

**WalletApplicationModule e useFactory(unit: FinancialUnitOfWork): CreateWallet**, em
`src/infrastructure/application/wallet-application.module.ts`: metadados Nest importam
PersistenceModule, injetam FINANCIAL_UNIT_OF_WORK, constroem adapters UUID/clock e
exportam o provider CreateWallet. Módulo usa construtor implícito sem lógica. Factory
retorna instância sem abrir conexão adicional, executar caso de uso ou aplicar migration.
Nest chama a factory; configuração/startup do PersistenceModule pode falhar como antes.
Alternativa seria decorar CreateWallet com @Injectable/@Inject; composição externa
mantém o caso de uso utilizável sem framework. AppModule em `src/app.module.ts` passa
a importar esse módulo; mantém somente o HealthController. Nenhum novo endpoint.

### Metadados, conflitos e rollback

Foi aprovada a reutilização de WagerTransaction para OPENING com namespace interno,
em vez de tabela nova. providerId=internal:wallet-opening, roundId/gameId=wallet-opening,
externalTransactionId=idempotencyKey=OPENING.id. Futura admissão de provedores deve
reservar esse namespace. correlationId=Wallet.id agrupa os dois eventos;
causationId=OPENING.id identifica a causa. Todos usam o mesmo instante. Snapshot de
WagerTransactionProcessed tem aggregateId da transação; WalletBalanceChanged, da Wallet.

Duplicação de playerId/moeda é conflito de negócio, não replay. SELECT antes de INSERT
não resolveria a corrida: duas sessões poderiam consultar ausência. UNIQUE permite
que a segunda inserção espere o resultado da primeira. Se esta confirma, a segunda
falha; se desfaz, a segunda pode inserir. Verificação e espera fazem parte do mecanismo
do índice do PostgreSQL, conforme [documentação oficial](https://www.postgresql.org/docs/17/index-unique-checks.html).
Carteiras de jogadores/moedas diferentes não disputam essa chave.

Constraints diferíveis são verificadas no commit, depois de o callback ter terminado.
Qualquer inconsistência faz a confirmação falhar; não é suficiente retornar do callback.
Esse comportamento está descrito em [SET CONSTRAINTS](https://www.postgresql.org/docs/17/sql-set-constraints.html).
O rollback do SQL não volta os campos privados de objetos JavaScript. A sessão existente
recusa salvar objetos pertencentes à transação anterior; execute nunca os guarda.
O teste conserva deliberadamente um objeto alterado para provar essa proteção.

### Catálogo dos testes e helpers

Todos os testes abaixo retornam Promise<void> via callback async do Bun, recebem
apenas parâmetros indicados por test.each, e falham por assertion/erro/timeout. Usam
withMessagingDatabase: cria banco dwp_test_*, aplica quatro migrations, usa papel
wager_app para negócio, fecha conexões e remove esse banco no finally. Nenhuma tabela
financeira é criada no banco principal. Testes de sucesso usam domínio/repos reais.

Em `infra/test/wallet-creation-support.ts`:

| Helper | Parâmetros/retorno, fluxo, dependências, chamadores e erros |
|---|---|
| sequenceIds | prefix:string='case' → IdGenerator. Closure next():string incrementa contador e retorna prefix-N; sem I/O. creator e testes usam IDs previsíveis; não é gerador de produção. |
| creator | unit:FinancialUnitOfWork, prefix:string='case' → CreateWallet. Usa sequenceIds e Clock.now():Date que retorna nova Date(openingTime). Chamado pelas três suites novas; delega erros ao caso de uso. |
| expectCounts | sql:SQL, wallets/transactions/ledger/outbox:string → Promise<void>. SELECT de cinco subconsultas count, compara exatamente com esperado e Inbox=0. Usado após commit/rollback; assertion ou erro SQL falha. Não converte dinheiro/contagem para float. |

Constantes fundedInput e openingTime são fixtures compartilhadas somente para leitura:
player/100.00 BRL e 2026-10-23T15:00:00.123Z. O helper não substitui operações de negócio.

Em `infra/test/wallet-creation-functional.test.ts`:

| Teste (nome iniciado por CreateWallet, salvo Nest) | Passos, resultado e motivo |
|---|---|
| zero persists only the wallet and returns an immutable plain response | execute0.00; DTO plain/frozen nas duas camadas, versão1; SQL confirma1Wallet e0em todas as demais tabelas. |
| positive commits linked OPENING CREDIT and two pending events with exact values | execute000100.00; consulta as quatro tabelas, IDs, moeda, quantias, datas, hash fixo, status/refs e versão; xmin único prova mesma transação; eventos pendentes corretos. Callbacks map sobre eventos extraem IDs; for percorre ambos sem mutação. |
| preserves supported amount %s (2 casos) | Parâmetro amount:string em999999999999999999.99 e0.01; confere resposta, saldo e ledger textuais exatos, e contagem1/1/1/2. |
| rejects %s without partial records (10 casos) | invalidCases é tabela label:string,input:unknown,errorCode:string. Casos1.005, number100, JPY,-1.00, acima do teto, player vazio/espaço/controle/número e inputnull. Cast representa transporte não tipado; exige classe/código esperado e cinco tabelas vazias. |
| separates currencies and rejects a duplicate without changing the first opening | Uma instância abre BRL e USD para mesmo player; terceira chamada BRL conflita; saldo original e contagens2/2/2/4 preservados. |
| Nest composes CreateWallet with restricted PostgreSQL UUIDs and system clock without exposing an endpoint | Substitui temporariamente DATABASE_URL pelo descartável; inicia Nest, resolve provider e executa abertura. Confere UUIDv4, data real, contagens e404em POST /wallets. Finally fecha Nest/restaura env mesmo em erro. |

Em `infra/test/wallet-creation-rollback.test.ts`:

| Teste | Injeção de falha, resultado e callbacks |
|---|---|
| CreateWallet rolls back a real wallet INSERT when the OPENING factory throws | Wrapper run(work) delega à UOW real; wrapper wallets.insert(wallet):Promise<void> grava de verdade e marca inserted; os demais métodos delegam intactos. spyOn/createOpening lança uma exceção apenas nesta tentativa, restaurada no finally. A exceção é artificial; INSERT/rollback/SQL são reais. Exige inserted=true e banco vazio; nova chamada com factory real confirma. |
| CreateWallet rolls back a PostgreSQL write failure in %s (3 casos) | table:literal wager_transactions/wallet_ledger_entries/outbox_messages. Owner instala fail_creation_write():trigger temporária que lança P0001; na Outbox dispara apenas no segundo evento case-5. Execute rejeita e tudo volta a0; remove função/trigger e repete com novos IDs, obtendo1/1/1/2. SQL unsafe usa só identificadores literais do teste, nunca entrada externa. |
| CreateWallet propagates Outbox identity collisions rather than wallet conflicts | Gerador next():string retira IDs fixos de array, repetindo os dois eventIds. PK real da Outbox rejeita segundo INSERT; exige nome original da constraint e rollback integral. Clock.now retorna data fixa. |
| CreateWallet rejects a deferred commit failure and discards mutated objects before retry | Wrapper run executa callback real até o DTO; carrega Wallet sob lock, usa credit1.00 e save reais, omitindo propositalmente o ledger desse movimento extra. Callback termina; constraint financeira existente falha23514no COMMIT. Callback then de sucesso não executa, banco vazio. Objeto retido continua101.00 mas nova UOW recusa reutilizá-lo. Desliga injeção; mesma instância CreateWallet retorna nova Wallet100.00/version1/IDcase-6. |

fail_creation_write é PL/pgSQL apenas do teste, sem parâmetros explícitos, contexto
NEW/TG_TABLE_NAME implícito de trigger e retorno declarado trigger; sempre lança, não
retorna linha. Chamador é BEFORE INSERT PostgreSQL; não é migration de produção.
No cenário de commit não criamos trigger nova: testamos as constraints já existentes.

Em `infra/test/wallet-creation-concurrency.test.ts`:

- `gate(): {ready:Promise<void>,open:()=>void}` cria barreira. Executor da Promise guarda
  resolve; open libera a espera. Dois gates separam fim das escritas e autorização de
  commit. Não possui timer nem consulta; usado pelo teste parametrizado.
- `bounded<T>(operation:Promise<T>):Promise<T>` disputa operação com watchdog5s; rejeita
  em timeout, limpa timer no finally. Callbacks do timer só rejeitam; não contam como
  evidência de lock. Usado para evitar que regressão fique aguardando indefinidamente.
- `observeWalletWait(sql:SQL):Promise<void>` consulta pg_stat_activity e pg_blocking_pids,
  filtrando banco atual/INSERTwallets/Lock e bloqueador distinto do PID aguardando.
  Amostra a cada10ms por até4s, lança se não observar. O sleep limita polling; o
  resultado do servidor comprova sessões independentes, não uma suposição por tempo.
- `concurrent CreateWallet waits for %s while another wallet advances` (2 casos,
  ending:'commit'|'rollback'): cria segundo ORM/pool e segunda UOW; wrapper paused.run
  mantém A após escritas e antes do commit; observer vê0linhas e retorno não entregue.
  B tenta mesma chave e é observada esperando. C abre other-player enquanto A/B
  disputam. Libera A: no commit B conflita; no rollback B confirma. Final tem2Wallets,
  2OPENINGs,2ledgers,4eventos (incluindo C) e só uma Wallet para player/BRL. Callbacks
  then capturam sucesso/erro como resultado para evitar rejeição não tratada; finally
  libera barreira, aguarda allSettled e fecha ORM. Não há lock global ou retry invisível.

O teste de conflito específico e seu helper make estão catalogados na seção24.
Não criamos testes espelhando cada linha: assertions verificam contratos observáveis,
estado SQL, momento de commit e erros reais nas fronteiras relevantes.

### Evidência executada e limites — 23/10/2026

Ambiente: Bun 1.4.3, PostgreSQL 17 em container local; credenciais de aplicação
wager_app para operações financeiras. Os comandos foram executados na raiz; Bun
local foi disponibilizado com `export PATH="$PWD/.tools/node_modules/.bin:$PATH"`.
Para check, DATABASE_URL apontou para a conexão local documentada em .env.example.

| Comando | Resultado observado |
|---|---|
| `bun run check` | Typecheck OK; 437 testes aprovados; build TypeScript OK |
| `bun run test:wallet-creation` | 25 testes aprovados, 0 falhas, 116 assertions |
| `bun run test:financial` | 34 aprovados |
| `bun run test:persistence` | 15 aprovados |
| `bun run test:messaging` | 14 aprovados |
| `bun run test:orm` | 2 aprovados |
| `bun run test:migrations` | 2 aprovados |
| `bun run test:infra` | 2 PostgreSQL + 4 SQS aprovados, incluindo reinício/recriação |

Total: **535 testes distintos**, 25 novos sobre os 510 anteriores. Não somamos
reexecuções da mesma suíte. Testes de infraestrutura foram executados depois dos
financeiros para não interromper suas conexões durante restart dos containers.

Consultas finais executadas:

```bash
docker compose exec -T postgres psql -U wager_admin -d wagering \
  -c "SELECT tablename FROM pg_tables WHERE schemaname='public';" \
  -c "SELECT datname FROM pg_database WHERE datname LIKE 'dwp_test_%';"
```

Ambas retornaram `(0 rows)`: principal sem tabelas/migrations financeiras e nenhum
banco descartável remanescente. `docker compose ps` mostrou PostgreSQL e LocalStack
healthy. Uma primeira consulta manual usou o nome incorreto wager_owner e falhou por
papel inexistente; corrigida para wager_admin conforme compose.yaml, sem alterar roles.
Nenhum teste automatizado falhou nesta implementação.

Evidência financeira real: abertura de 100.00 resultou em uma Wallet versão 1, uma
OPENING PROCESSED, um CREDIT 0.00 → 100.00 e dois eventos pendentes. Cada cenário de falha
deixou as cinco tabelas vazias; depois de retirar a falha, nova tentativa confirmou
com objetos novos. Abertura concorrente teve um vencedor e um conflito após commit;
após rollback da primeira, a segunda confirmou. Outro jogador concluiu antes de
liberar a disputa. A restrição de concorrência não depende de FIFO nem memória local.

O enunciado oficial, domínio e migrations permaneceram intactos; README foi atualizado
somente na seção da implementação. Não há controller, consumidor, publisher, apostas,
replay HTTP, autenticação ou migrations no principal. SQS foi testado como regressão
da infraestrutura existente, não como publicação de eventos desta nova funcionalidade.
O namespace interno ainda precisa ser protegido na futura admissão de provedores.
Falha de conexão após o servidor confirmar um commit pode deixar resultado incerto
para o cliente; não prometemos replay HTTP ou recuperação dessa janela nesta etapa.

Próxima etapa recomendada: adaptador HTTP de criação de carteira com contrato/erros
e autenticação do README, mediante autorização específica. Desenvolvimento encerrado
no caso de uso de aplicação e seus testes.

## 26. Admissão e JSON canônico de BET

Primeiro incremento da etapa ProcessWagerTransaction: preparar uma entrada independente
de HTTP/SQS. Ainda não executa débito nem oferece replay. O header Idempotency-Key será
extraído pelo futuro adaptador HTTP e entregue como idempotencyKey; messageId identifica
uma entrega do broker e não substitui essa chave financeira.

JSON canônico significa que a mesma informação produz a mesma sequência de bytes.
Neste contrato fechado v1, construímos uma lista explícita de campos em ordem
lexicográfica, incluindo as chaves internas de money. Não usamos a ordem do objeto
recebido, nem um serializador genérico que possa incluir headers por acidente.
Entram: externalTransactionId, gameId, kind, money(amount,currency), playerId,
providerId, roundId e walletId. Cada campo altera a identidade ou o significado da
aposta. Ficam fora idempotencyKey, messageId, datas de transporte, correlationId e
campos extras de transporte. Chave identifica a tentativa lógica; hash compara seu
conteúdo. Identidade externa identifica a operação no provedor, mesmo com outra chave.

Money.from exige duas casas e mantém precisão; toJSON normaliza zeros à esquerda.
Assim,25.00 e00025.00 têm o mesmo hash. SHA-256 fornece digest determinístico de 256 bits
em64 caracteres hexadecimais; não autentica o provedor nem cifra seu payload. Os bytes
são JSON UTF-8. Não normalizamos IDs com trim ou conversão de caixa: token inválido
é erro e identificadores distintos permanecem distintos.

### Funções e contratos

Em `src/application/wagering/prepare-bet.ts`:

- `BetInput`: DTO readonly com sete identificadores string, kind literal BET e
  money:Readonly<MoneyProps>. Não contém headers/envelope nem tipos de ORM.
- `PreparedBet`: input normalizado readonly, Money imutável, canonicalPayload:string
  e payloadHash:string. O caso de uso consumirá essa preparação por execução.
- `InvalidWagerInputError.constructor(message:string)`: retorna Error com name próprio
  e code INVALID_WAGER_INPUT; usado pelos dois helpers, sem I/O. O futuro transporte
  traduzirá essa admissão inválida, que não é REJECTED financeira persistida.
- `assertToken(value:unknown,field:string):asserts value is string`: helper privado;
  exige string não vazia sem espaços/controles. Lança InvalidWagerInputError indicando
  campo. Chamado pelo loop de prepareBet, sem normalizar o identificador.
- `prepareBet(input:BetInput):PreparedBet`: valida objeto; percorre sete IDs (incluindo
  chave obrigatória); bloqueia o provider internal:wallet-opening reservado; exige BET
  e ausência de referência externa; chama Money.from e exige positivo/até o teto do
  schema; constrói business ordenado; JSON.stringify; createHash('sha256') UTF-8;
  retorna cópias congeladas, incluindo money no DTO. Não conserva objetos mutáveis
  da entrada. MoneyError é propagado para formato/moeda; erros de crypto propagam.
  Não há banco/Nest/ORM; dependências são Money e node:crypto. Exemplo: provider-a,
  bet-1, player, wallet, round, game,25.00 BRL gera
  `3453cc106ee4d196dbb10fd6695becbdd4ef529164a71d899a4b72358b93cba7`.

### Testes do contrato

`test/bet-payload.test.ts`, describe canonical BET payload: callbacks síncronos void,
sem infraestrutura; assertions lançam em divergência. input é fixture readonly.

| Teste | Parâmetros, fluxo e garantia |
|---|---|
| sorts known keys... | Compara JSON exato e hash calculado independentemente com Python json(sort_keys=True)/hashlib; valida algoritmo e escala textual. |
| ignores original key ordering... | Reordena chaves externas/internas, muda chave, acrescenta metadata, usa00025.00; exige hash igual. |
| changing %s changes... (6) | field: providerId/externalTransactionId/playerId/walletId/roundId/gameId; altera um por vez e exige hash diferente. |
| changing money %j... (2) | money:MoneyProps; muda quantia ou moeda e exige hash diferente. |
| captures immutable normalized input... | Prepara cópia de entrada, altera origem depois; Money/input conservam valores e três níveis relevantes estão congelados. |
| rejects missing or malformed %s (7) | field:string; testa vazio/espaço/controle/undefined/number para cada ID; todos devem lançar. |
| rejects invalid or inadmissible amount %s (6) | amount:string em zero,negativo,escala3,exponencial,NaN,acima do teto; nenhum é admitido. |
| rejects unsupported currency... | Testa moeda desconhecida, dinheiro number, WIN/OPENING, referência, provider interno e inputnull/array/undefined. |

Evidência deste incremento: typecheck OK;25 testes aprovados,66 assertions. Nenhuma
mudança em entidades ou schema. Decisões de snapshot/locks/retry aprovadas para os
próximos incrementos, ainda não provadas por este teste puro.

## 27. Resultado histórico e admissão persistente de BET

Decisões aprovadas: tabela separada de snapshots imutáveis; locks transacionais por
duas identidades, antes da Wallet. Um replay não pode ler o saldo atual: se a primeira
BET levou100.00→75.00 e outra levou75.00→65.00, a resposta da primeira continua75.00.
Rejeições não têm ledger para reconstruir esse resultado, justificando persistir o
snapshot mesmo que status/moeda também existam na transação. wallet_version é metadado
para conferir o instante capturado; não altera a resposta do README.

### Migration20261023000005 (migrations/Migration20261023000005.ts)

`up():Promise<void>` registra SQL via addSql no Migrator oficial, sem argumentos.
Cria wager_transaction_results com PK/FK transaction_id, schema_version=1,
wallet_version positivo seguro e response JSONB. A versão permite evolução explícita
sem interpretar um contrato antigo como atual. response guarda transactionId,status,
balance e failureCode quando terminal negativo; idempotentReplay descreve a entrega,
portanto é calculado ao responder. Nenhum header/envelope é guardado nessa tabela.

`down():Promise<void>` remove trigger na transação, tabela e três funções novas, nessa
ordem de dependências. É destrutivo para os snapshots, como qualquer down que remove
tabela, e só foi executado em banco descartável. Não altera migrations anteriores.
Up não reescreve registros antigos nem inventa resultado de rejeição legada. A exigência
vale para INSERT/UPDATE posterior da BET; replay legado sem snapshot deverá falhar
explicitamente. Aplicação no principal não foi autorizada nem realizada.

Funções SQL, chamadas por checks/triggers, com search_path fixo:

| Função | Parâmetros/retorno e fluxo |
|---|---|
| valid_wager_result(p jsonb):boolean | Valida objeto v1 de chaves exatas, ID, Money string normalizada/limite via message_json_money, status terminal e presença/ausência de failureCode. COALESCE impede NULL passar como válido. Não consulta tabelas. |
| check_wager_result():trigger | BEFORE INSERT, recebe NEW implicitamente; recusa JSON inválido, busca WagerTransaction, exige BET terminal/status/failure/moeda iguais; bloqueia Wallet NO KEY UPDATE e compara saldo/versão; PROCESSED também precisa de ledger com mesmo saldo/versão. Retorna NEW ou lança 23514/23503. PK/FK/checks continuam ativos. |
| require_bet_result():trigger | Constraint trigger diferível AFTER INSERT/UPDATE da transação; lê seu estado final e exige snapshot se BET terminal. Retorna NULL ou lança 23514 no commit. Isso impede confirmar efeito/rejeição novos sem resultado. |

Triggers wager_results_immutable/no_truncate reutilizam reject_financial_mutation,
recusando UPDATE/DELETE/TRUNCATE inclusive pelo owner. Papel app recebe só SELECT e
INSERT; execute apenas no validador usado no CHECK. Não há permissões de DDL concedidas.
Resultado é validado no instante da captura sob lock e não revalidado contra saldo
futuro ao ler. PK oferece lookup por transactionId; não é necessário índice duplicado.

### Portas, mapper e adaptadores

`src/application/wagering/wager-result.ts`: interfaces readonly WagerResultSnapshot
(transactionId:string,status terminal,balance:Readonly<MoneyProps>,failureCode opcional)
e WagerResult (adiciona idempotentReplay:boolean). São DTOs, sem comportamento financeiro.
`src/application/ports/wager-persistence.ts`: WagerAdmissionRepository.lock recebe
três strings e retorna Promise<void>; WagerResultRepository.findByTransactionId(string)
retorna snapshot|null; insert(snapshot,version:number) retorna Promise<void>.

Em `src/infrastructure/persistence/financial/wager-result-mapper.ts`:

- `WagerResultMapper.toSnapshot(row:WagerResultRecord):WagerResultSnapshot` exige versão 1,
  identidade igual à coluna, estrutura e chaves exatas, Money normalizado, faixa
  persistível, status/failure de BET coerentes e wallet_version string segura. Retorna
  cópia congelada também em balance; TypeError/RangeError/MoneyError propagam. Usa
  MoneyMapper para o teto; não reconstrói saldo lendo Wallet. Chamado pelo repositório.
- `toRecord(result:WagerResultSnapshot,walletVersion:number):WagerResultRecord` valida
  contador seguro, converte versão para string, chama toSnapshot para validar/capturar
  cópia e devolve colunas. Não passa dinheiro por number. Chamado por insert.

Em `wager-result-repository.ts`, mesmo diretório: construtor recebe FinancialSession
e a armazena, sem I/O. `findByTransactionId(id:string)` usa SELECT parametrizado e
wallet_version::text; retorna mapper ou null. `insert(result,version)` usa mapper,
JSON.stringify + castjsonb no INSERT parametrizado; nunca UPDATE/upsert. Erros de
sessão/mapper/SQL propagam. O caso de uso usará ambos na UOW atual; banco valida vínculos.

Em `wager-admission-repository.ts`:

- `lockAddress(scope:string,provider:string,identity:string):bigint`: helper privado,
  SHA-256 de tupla JSON ['dwp:wager:v1',scope,provider,identity], primeiros64 bits assinados.
  Tupla evita colisões por concatenação ambígua. Hash aqui endereça lock; hash do payload
  usa todos256 bits e tem função diferente. Colisão de 64 bits só serializa operações
  adicionais, não mistura identidades, que são conferidas por valores exatos/UNIQUE.
- `MikroWagerAdmissionRepository.constructor(session)` armazena sessão; `lock(providerId,
  idempotencyKey,externalTransactionId):Promise<void>` chama guarda de ordem, calcula
  dois endereços, elimina colisão idêntica, ordena numericamente (comparador bigint)
  e chama pg_advisory_xact_lock(?::bigint) sequencialmente. Strings só em parâmetros.
  PostgreSQL libera no commit/rollback; não é lock de sessão/pool nem lock global.
  SQL/guarda falham explicitamente. IDs devem vir da admissão validada.

`FinancialSession.beforeWagerAdmission():void` em financial-session.ts exige sessão
ativa, uma admissão por UOW e nenhuma aquisição prévia de lock/escrita de Wallet.
beforeLock e attachWallet(locked=true) passam a registrar esse estágio; não mudam
ownership nem ordem lexical anterior entre wallets. Ler uma Wallet sem lock não
marca escrita. Repositórios são internos: o fluxo deve também admitir antes de inserir
WagerTransaction; os locks advisory são um protocolo cooperativo, UNIQUE é a garantia
mesmo para escritor que não participe dele.

`createRepositories(session):FinancialRepositories` e a interface correspondente
agora incluem wagerAdmission/wagerResults na mesma sessão/EntityManager dos demais.
Construir adaptadores não consulta tabela nova, preservando suites das migrations1–4.

### Testes e suporte

`infra/test/bet-support.ts`: `withBetDatabase(run:(BetDatabase)=>Promise<void>)` aplica
até 00005 em banco descartável, cria ORM com papel app/UOW, executa callback e fecha
ORM no finally. Erros não são suprimidos. `assertReconciled(sql:SQL):Promise<void>`
compara todas Wallets com SUM(CREDITamount-DEBITamount), incluindo saldo zero sem
ledger; exige nenhuma diferença via SQL numeric. `gate()` retorna ready/open; executor
da Promise captura resolve. `bounded<T>(promise):Promise<T>` watchdog 8s e limpeza de
timer. `observeWait(sql,query:string):Promise<void>` consulta pg_stat_activity e
pg_blocking_pids no banco atual até 6s, polling 10ms; servidor deve mostrar bloqueador
de outro PID, caso contrário lança. Timer não é evidência de concorrência.

`infra/test/bet-persistence.test.ts`: callbacks async Promise<void> com banco real,
assertions/erro/timeout falham; helper `rejected(id,walletId):WagerTransaction` usa
factory real+reject(INSUFFICIENT_FUNDS) para fixture com saldozero, sem simular SQL.

| Teste | Fluxo e garantia |
|---|---|
| result migration up down reapply... | Cria rejeição legada na00004, aplica00005duas vezes, verifica snapshot vazio/registro preservado; down mantém Wallet, up recria tabela vazia; reconcilia. |
| result repository persists immutable rejected snapshot... | Persiste rejeição+snapshot real, roundtrip congelado, inexistente=null, duplicado23505; app/owner recusam alterações; saldo/moeda/status/failure/versão divergentes falham; reconcilia. |
| terminal BET without result fails... | Callback conclui sem resultado mas commit23514; nenhum registro parcial; SQL com JSON ausente/dinheiro numérico/escala3recusado; reconcilia. |
| admission lock serializes %s... (key/external) | A segura identidades; B mesma chave ou identidade externa espera observada no servidor; outro provedor prossegue; rollbackA liberaB; finally libera barreiras e aguarda sessões. |
| admission guard rejects repeat late or expired... | Guarda recusa repositório escapado, segunda admissão e admissão depois de lock Wallet; reconcilia banco vazio. |

`test/wager-result-mapper.test.ts`: teste síncrono `wager result mapper refuses...`
compara snapshot válido e recusa versão futura, contador inseguro, identidade diferente,
null, PENDING, dinheiro number/não normalizado e REJECTED sem código. Casts só simulam
dados não confiáveis do driver; não são usados para burlar validação de produção.

Teste de migration em `infra/test/messaging-schema.test.ts` agora passa explicitamente
`to:Migration20261023000004` nos dois up: testa a etapa de mensagens, sem aplicar00005
acidentalmente. Cobertura da nova migration fica na suite nova.

Problemas corrigidos: TypeScript exigiu anotar o snapshot de fixture para preservar
o tipo terminal; SQL exigiu parênteses em `(p->'balance') - ARRAY[...]` para desambiguar
operadores JSONB. Depois da correção:6 testes reais/51 assertions aprovados. Canonicalização
e snapshot são infraestrutura para replay; o caso de uso será integrado a seguir.

Na revisão ampliada, o teste do mapper comparava um valor tipado com response:unknown;
o typecheck recusou essa assertion. Foi corrigida para comparar com o DTO esperado
explicitamente, sem cast que esconda o problema. O commit de persistência foi criado
antes dessa correção por falha na sequência de verificação; a correção tem commit
próprio e a evidência final só considera a suíte após sua execução bem-sucedida.
Verificação após a correção: typecheck aprovado;10 testes (mapper, persistência BET
e schema de mensagens),95 assertions, todos aprovados.

## 28. Processamento transacional de BET

O caso de uso é a coordenação de uma intenção financeira inteira. Ele não é controller
(não interpreta HTTP) nem repository (não monta SQL). Sua função é selecionar o fluxo,
usar entidades reais e concluir a transação com todos os registros necessários.
Wallet continua sendo dona da regra de débito e WagerTransaction da máquina de estados.
Não houve alteração nessas entidades ou nas constraints financeiras aprovadas.

### Caminho de uma aposta

Entrada: providerId, externalTransactionId, idempotencyKey, playerId, walletId, roundId,
gameId, kind BET e money string. prepareBet valida/copia antes de I/O, como na seção 26.
Saldo de exemplo100.00 BRL e BET25.00:

```mermaid
sequenceDiagram
  participant Caller as Futuro HTTP ou fronteira SQS
  participant UC as ProcessWagerTransaction
  participant UOW as FinancialUnitOfWork
  participant PG as PostgreSQL
  Caller->>UC: execute(BetInput)
  UC->>UC: prepareBet e hash canônico
  UC->>UOW: run(callback)
  UOW->>PG: BEGIN
  UC->>PG: Advisory locks ordenados por key e externalId
  UC->>PG: Procurar key e identidade externa
  alt Replay
    PG-->>UC: Snapshot original
  else Nova operação
    UC->>PG: Wallet FOR NO KEY UPDATE
    UC->>UC: Validar jogador e moeda
    UC->>PG: INSERT WagerTransaction PENDING
    UC->>UC: Wallet.debit e transição de WagerTransaction
    UC->>PG: Wallet e ledger se processada; estado terminal
    UC->>PG: Outbox e snapshot do resultado
  end
  UOW->>PG: COMMIT, incluindo constraints diferíveis
  UOW-->>Caller: DTO confirmado ou rejeição da Promise
```

Sucesso: Wallet75.00/version2; BET PROCESSED; ledger DEBIT100.00→75.00; dois eventos;
snapshot PROCESSED/balance75.00. Rejeição por saldo insuficiente: Wallet mantém saldo,
versão e updatedAt; BET REJECTED/INSUFFICIENT_FUNDS; nenhum ledger; um evento Rejected;
snapshot do saldo observado. Rejeição é resultado financeiro terminal, não exceção
transitória que deva tentar debitar novamente. Repeti-la retorna a mesma rejeição.

Os eventos são WagerTransactionProcessed + WalletBalanceChanged no sucesso, ou só
WagerTransactionRejected na rejeição. As factories conferem os estados. Outbox é
inserida antes do commit, na mesma sessão, mas não é publicada. Eventos não confirmados
não aparecem na leitura de outra sessão. Só o publisher futuro enviará dados ao SQS.
Fazer isso dentro da transação permitiria divulgar um débito depois revertido.

### Idempotência e prioridade dos conflitos

Idempotency-Key obrigatório vem do futuro header HTTP; no SQS, virá do campo do payload.
messageId distingue entrega e será usado pela Inbox. `(provider,key)` identifica a
operação lógica e `(provider,externalId)` impede a mesma operação do provedor com outra
chave. As duas unicidades são persistentes e não dependem de processo/cache/FIFO.

Após adquirir locks, primeiro procuramos key. Hash diferente é IDEMPOTENCY_CONFLICT,
mesmo que o payload novo aponte para outra carteira inexistente. Hash igual exige
snapshot terminal compatível; devolve cópia com idempotentReplay=true. Não gera IDs,
não lê Wallet e não cria ledger/evento. Se não há key mas externalId já existe,
EXTERNAL_TRANSACTION_CONFLICT. Só uma identidade nova segue para lock da Wallet.
Consulta anterior sem lock seria vulnerável à corrida; a espera protege a decisão.
UNIQUE permanece a proteção final para escritores que não usem os advisory locks.

Exemplo de replay: primeira BET25.00 responde75.00; segunda BET10.00 responde65.00;
replay da primeira responde75.00, não65.00. Resultado de rejeição também é histórico:
BET101.00 rejeitada com saldo 100.00 continua respondendo100.00 após outra BET reduzir
saldo para 75.00. Não reconstruímos rejeições pelo ledger porque não existe lançamento.

### Métodos, erros e composição

Em `src/application/wagering/process-wager-transaction.ts`:

- `ProcessWagerTransaction.constructor(unit:FinancialUnitOfWork,ids:IdGenerator,
  clock:Clock)` armazena serviços, sem I/O ou estado financeiro. Chamadores são a
  factory Nest e processor dos testes. IDs/datas continuam fora do domínio.
- `execute(input:BetInput):Promise<WagerResult>` chama prepareBet uma vez para capturar
  entrada imutável; tenta unit.run callback process. Retorna somente após commit.
  Catch aceita exclusivamente RetryableFinancialTransactionError e no máximo3 tentativas;
  espera10ms depois da primeira e20ms depois da segunda, fora da transação. Callback
  do setTimeout resolve Promise<void>, sem I/O financeiro. Terceira falha ou outro
  erro é propagado. Repetir a transação inteira garante novas entidades, EM e leituras.
- `processInTransaction(input:BetInput,repositories:FinancialRepositories):Promise<WagerResult>`
  prepara entrada e chama o mesmo núcleo process, sem abrir UOW/retry. É ponto interno
  de composição para futura Inbox; o resultado é provisório. Dono da UOW precisa
  confirmar tudo e repetir a fronteira inteira (incluindo Inbox) se houver falha.
  Nunca enviar resposta/ACK com base apenas nessa Promise. Teste externo força rollback
  após o retorno para provar que nada escapou. Não há Inbox/consumer implementado aqui.
- `process(prepared:PreparedBet,repos:FinancialRepositories):Promise<WagerResult>`,
  privado: adquire identidades; verifica replay/conflitos; bloqueia Wallet e verifica
  existência/jogador/moeda; lê clock; cria WagerTransaction PENDING com novo ID;
  INSERT para satisfazer FK futura do ledger; chama Wallet.debit com novo ledger ID.
  Se houve movimento, marcaProcessed, salva Wallet, atualiza lifecycle e insere ledger.
  Se WalletError/INSUFFICIENT_FUNDS, chama reject específico e só atualiza lifecycle.
  Cria evento(s), grava Outbox, cria snapshot congelado e o insere com wallet.version;
  devolve DTO congelado com replayfalse. Não contém SQL nem reimplementa subtração.
  Todos os awaits de escrita são sequenciais; transação financeira e resultado usam
  os mesmos repositórios/sessão. Nenhuma entidade é guardada na classe após a chamada.

Erros de Money/validação/infra propagam. Apenas o erro de saldo insuficiente lançado
pela Wallet vira rejeição persistida. Não tratamos qualquer Error ou23505como rejeição.
Wallet não encontrada/jogador incompatível/moeda divergente são erros de admissão:
não faz sentido violar a FK para gravar transação ligada a carteira inválida.

`WagerProcessingError.constructor(code:WagerProcessingErrorCode,message:string)`, em
`src/application/wagering/wager-processing-error.ts`, retorna Error de aplicação com
código estável. Usado por process, sem I/O ou acoplamento HTTP:

| Código | Significado |
|---|---|
| IDEMPOTENCY_CONFLICT | A key já representa outro conteúdo. |
| EXTERNAL_TRANSACTION_CONFLICT | Identidade externa já registrada com outra key. |
| WALLET_NOT_FOUND | Carteira ausente. |
| WALLET_PLAYER_MISMATCH | Jogador incompatível. |
| WALLET_CURRENCY_MISMATCH | Moeda incompatível. |
| ORIGINAL_RESULT_UNAVAILABLE | Registro existente sem snapshot terminal compatível; não reprocessar nem inventar saldo. |

`RetryableFinancialTransactionError.constructor(sqlState:'40001'|'40P01',options:ErrorOptions)`,
em `src/application/errors/retryable-financial-transaction-error.ts`, preserva causa
SQL e sinaliza tentativa revertida. Usado pela UOW; execute o interpreta. Não é
FailureCode financeiro e não fica persistido como FAILED.

`MikroFinancialUnitOfWork.run<T>(work):Promise<T>`, em financial-unit-of-work.ts, agora
aguarda a transactional oficial dentro de try/catch. Após ela rejeitar/efetuar rollback,
traduz só code40001/40P01 para a exceção acima. Mantém fork, READ COMMITTED, recusa de
UOW aninhada e fechamento de sessão existentes. Outros erros permanecem intactos.
Inclui falhas do commit; não repete internamente um callback com objetos anteriores.
Essa ordem segue a recomendação de [reexecutar toda a transação](https://www.postgresql.org/docs/17/mvcc-serialization-failure-handling.html).

`WagerApplicationModule` em `src/infrastructure/application/wager-application.module.ts`
tem construtor implícito sem lógica. Importa PersistenceModule; factory
`useFactory(unit:FinancialUnitOfWork):ProcessWagerTransaction` instancia UUID/clock
existentes e retorna o provider exportado. AppModule importa esse módulo junto ao de
Wallet; nenhum controller novo. Nest resolve dependências; erros de configuração
continuam sendo os de startup. Criar provider não executa apostas nem migrations.

### Falhas, objetos revertidos e limites do retry

Rollback apaga todas as escritas daquela tentativa, incluindo resultado e Outbox,
mas não desfaz memória JavaScript. Uma Wallet que chegou a74.99numa tentativa abortada
continua assim naquele objeto; ownership existente recusa reutilizá-la em outra UOW.
Cada retry constrói tudo novamente, lê o saldo confirmado e reaplica o domínio uma vez.
IDs consumidos por tentativas revertidas não voltam, o que é normal para UUIDs.

Só erros40001(serialização)/40P01(deadlock) são candidatos a retry aprovado. Não há
retry automático para perda de conexão/resultado de commit incerto, corrupção de
snapshot,23505 ou erro de domínio. Três falhas seguidas são reportadas ao chamador;
nenhum FAILED é gravado por uma tentativa que foi revertida. Tratamento operacional
em transporte, métricas, TTL e DLQ ficam para suas etapas.

### Testes funcionais e de falha

`infra/test/bet-processing-support.ts`: `processor(unit,prefix='bet')` retorna caso de
uso com sequenceIds e clock que copia betTime (16:00:00.123Z); não simula SQL.
`betInput(walletId:string,patch:Partial<BetInput>={})` retorna fixture válida mesclada
com mudanças do cenário. `databaseState(sql:SQL):Promise<unknown>` retorna SELECT com
JSONB agregados em ordem estável das Wallets/transações/ledger/Outbox/resultados e
contagem Inbox. As propriedades monetárias são substituídas por amount/balance::text
antes de sair do PostgreSQL: também nesse helper de teste dinheiro chega como string.
O snapshot serve para exigir igualdade integral antes/depois de uma falha.

Em `infra/test/bet-functional.test.ts`, callbacks async Promise<void> usando
withBetDatabase, erro/assertion/timeout faz falhar; todos reconciliam Wallet/ledger:

| Teste | Entradas, passos e resultado esperado |
|---|---|
| BET %s processes or rejects... (25.00/100.00/100.01) | Abre100.00, processa valor, consulta estado/versão/ledger/eventos/snapshot e xmin; resultados75.00/0.00/REJECTED100.00. Snapshot exclui replay; response congelada. |
| BET admission rejects %s... (7) | zero,USD divergente,Wallet ausente,player diferente,escala3,acima do teto,key ausente; compara código e banco integralmente igual. |
| replay retains the original successful balance... | Executa25.00, replay imediato sem efeito, depois 10.00; fecha ORM original, cria outro e responde75.00 com banco atual65.00 sem alteração. Finally fecha ORM novo. |
| rejected replay preserves rejection balance... | Rejeita101.00; outra BET reduz saldo; replay mantém REJECTED100.00 sem evento novo. |
| BET %s conflict... (payload/external) | Nova Wallet inexistente na mesma key gera conflito de payload antes da consulta de Wallet; outra key com mesmoexternalId gera conflito externo; estado anterior preservado. |
| same keys in distinct providers... | Mesmo par textual em dois provedores produz duas operações válidas, saldo 50.00. |
| Nest injects the BET use case... | DATABASE_URL temporária descartável, resolve provider real, processa25.00 e exige 404 na rota ainda inexistente; finally fecha Nest/restauraenv. |
| legacy %s without original result... (PENDING/REJECTED) | Cria fixture na migration00004 com hash real, aplica00005 e tenta mesmo payload; ORIGINAL_RESULT_UNAVAILABLE sem efeitos. Nenhum backfill/retomada implícita. |

Em `infra/test/bet-rollback.test.ts`, também Promise<void> e banco real:

| Teste | Falha e evidência |
|---|---|
| BET rolls back...writing %s (5) | owner cria fail_bet_write():trigger que lançaP0001antes de INSERT em transação/ledger/Outbox/resultado ou UPDATEWallet. Na Outbox falha só no BalanceChanged (segundo evento). Wrapper run conta1tentativa; banco idêntico/reconciliado. Remove trigger/função e mesma instância confirma nova tentativa75.00. |
| BET cannot return success before commit... | Wrapper run executa callback real, carrega Wallet, debita0.01extra e salva sem ledger, pausa em barreira. Observador vê só estado anterior e successfalse. Ao liberar, constraint antiga falha23514; memória74.99não pode ser reinserida em nova UOW; objetos novos produzem75.00. Finally libera barreira. |
| BET retries complete fresh transactions... (40001/40P01) | retry_bet_write():trigger consulta nextval de sequência descartável (não revertido pelo rollback), lança código nas 2primeiras inserções de ledger e retorna NEW na terceira. Depois das tentativas: um débito, um resultado, dois eventos e75.00. É injeção SQL real da categoria, não detector real de deadlock. |
| BET stops after three retryable failures... | retry_forever():trigger lança 40001sempre; wrapper run conta3 chamadas, nenhuma linha parcial/FAILED. |
| unrelated unique violation... | ID generator repeteeventId do segundo evento; PK verdadeira gera23505, só1tentativa, rollback integral. Não é rejeição financeira. |
| transaction composition shares the caller boundary... | UOW externa chama processInTransaction, observa DTO provisório e lança; rollback inclui débito/resultado/eventos. Não há transação aninhada. |

As funções PL/pgSQL de falha são só fixtures, sem parâmetros explícitos, contexto NEW
implícito e retorno trigger; não entram em migrations. SQL unsafe nelas usa apenas
tabela/código de listas constantes do teste. Counters são de tentativas, nunca dinheiro.
Callbacks then capturam resultado/erro para evitar rejeições não tratadas durante
barreiras. Cada finally libera/fecha recursos; assertReconciled usa numeric SQL.

Evidência após implementação:18 testes funcionais,11 de rollback/retry/composição
aprovados. Nenhum evento foi enviado a SQS. Resultados finais de regressão/concorrência
estão na seção 29, com distinção entre sessões e processos reais.

## 29. Concorrência de BET, evidência final e limites

### Duas apostas disputando o saldo

Com100.00 BRL, A e B apostam80.00 cada, com identidades distintas:

1. A adquire seus locks de identidade, depois o lock da Wallet e observa100.00.
2. B adquire suas próprias identidades, mas aguarda o lock da mesma Wallet. Não lê
   um saldo antigo para decidir um débito em paralelo.
3. A usa Wallet.debit, que produz20.00/versão 2/ledger DEBIT; persiste estado, eventos
   e snapshot. Somente o commit torna esse conjunto visível e libera os locks.
4. B obtém o lock e lê20.00. Wallet.debit lança INSUFFICIENT_FUNDS sem alterar estado.
   B persiste REJECTED, snapshot20.00 e um evento, sem ledger/save de Wallet.
5. Resultado: saldo 20.00, um débito, uma processada, uma rejeitada. Replay de A retorna
   seu20.00 original; replay de B mantém a rejeição. Uma Wallet distinta concluiu
   durante a espera, mostrando ausência de lock global nesse cenário.

### Testes concorrentes

`infra/test/bet-concurrency.test.ts` usa os helpers gate/bounded/observeWait da seção 27.
Callbacks async Promise<void>; assertions/erros/watchdog falham o teste. Não provamos
espera por atraso arbitrário: exigimos wait_event_type=Lock e pg_blocking_pids no servidor.

- `two BETs of 80 against 100 serialize by wallet while an independent wallet progresses`:
  cria duas Wallets; segundo ORM independente; wrapper paused.run executa o callback
  real de A e segura seu commit. B usa outra key/ID e espera em NO KEY UPDATE observado
  no servidor. C aposta na outra Wallet e conclui antes de liberar A. Depois confere
  A PROCESSED20.00, B REJECTED/INSUFFICIENT_FUNDS20.00, versão 2, um DEBIT e5 eventos na
  Wallet original (2 da abertura+2processada+1rejeitada). Reconcilia todas. Finally
  libera barreira, aguarda ambas e fecha ORM; callbacks then capturam falhas sem unhandled.
- `concurrent same identity produces %s after waiting for commit`: cenário:string
  replay/payload-conflict/external-conflict. A segura a transação após processar; B usa
  payload igual, valor26.00 na mesma key, ou outra key no mesmoexternalId. Observador
  exige espera advisory. Após commit, B retorna respectivamente replay original ou
  erro explícito; uma BET e4 eventos totais (incluindo abertura), reconciliação válida.
  Duas instâncias ORM aqui significam sessões independentes no mesmo processo.
- `50 parallel copies across three real Bun processes produce one debit and 49 historical replays`:
  parent abre Wallet100.00 e segura lock antes de iniciar filhos. Bun.spawn lança três
  processos do mesmo executável, com 17/17/16 chamadas concorrentes. URL de cada pool
  recebe application_name distinta. Antes de liberar barreira, observer exige três
  nomes distintos em espera no PostgreSQL. Lê stdout/stderr e exitCode dos filhos,
  exige 3 PIDs de SO distintos,50 respostas,1 com replayfalse,49true,mesma transação/saldo 75.00.
  SQL exige uma BET, um DEBIT, um snapshot,4 eventos incluindo abertura e reconciliação.
  Finally libera lock e encerra apenas filhos ainda ativos, aguardando sua saída.

Callbacks map geram configurações dos3 filhos e depois coletam seus resultados;
flatMap concatena as 50 respostas, filter separa replay e Set confere identidades/PIDs.
Só contagens usam number. Promise.all inicia concorrência, não executa chamadas
sequenciais disfarçadas. Pools dos filhos têm max5cada; as 50 operações são submetidas
simultaneamente e aguardam conexões/locks conforme disponibilidade, como na aplicação.

`infra/test/bet-worker.ts` é script de teste com top-level await, não componente de
produção. Parâmetros via env: DWP_BET_DB URL local, DWP_BET_COUNT inteiro1..50,
DWP_BET_INPUT JSON BetInput. Recusa host diferente de 127.0.0.1 ou banco que não corresponda
a `/dwp_test_[a-f0-9]+`. Cria ORM/app-role, UOW, UUID/clock reais e ProcessWagerTransaction.
Callback Array.from chama execute count vezes; Promise.all espera todas. Saída única
JSON com pid e resultados; finally fecha ORM. Erro de validação/SQL/Promise deixa
exitCode nãozero e stderr, fazendo parent falhar. Não usa mocks/cache de deduplicação.
driverOptions.application_name marca todas as conexões para observação, sem alterar
SQL financeiro ou lógica de produção. A configuração veio da API do driver instalada.

### Resultados reais desta etapa

Ambiente: Bun 1.4.3, PostgreSQL 17 e LocalStack Community4.14.0 nos containers do projeto;
papel wager_app para processamento. Principal não recebeu migrations. Commands na raiz
com PATH do Bun local e DATABASE_URL de desenvolvimento, como descrito no setup.

| Comando executado | Resultado |
|---|---|
| `bun run check` | Typecheck OK;463 testes unitários/aplicação;build OK |
| `bun run test:bet` | 40 aprovados:6 persistência,18 funcionais,11 rollback/retry/composição,5 concorrência |
| `bun run test:financial` | 34 aprovados |
| `bun run test:persistence` | 15 aprovados |
| `bun run test:wallet-creation` | 25 aprovados |
| `bun run test:messaging` | 14 aprovados |
| `bun run test:orm` | 2 aprovados |
| `bun run test:migrations` | 2 aprovados |
| `bun run test:infra` | 2 PostgreSQL+4 SQS aprovados |

Total **601 testes distintos**,66 novos sobre 535:25 canonicalização,1 mapper,40 integraçãoBET.
Não somamos reexecuções. Infra foi executada depois das outras suites, pois reinicia
containers. SQS segue sendo regressão de infraestrutura, não teste de consumer/publisher
novo. Typecheck/build utilizam os comandos reais do package.json; nenhuma simulação.

Após o ajuste de transporte textual no helper, os 29 testes funcionais/rollback
afetados foram reexecutados: 29 aprovados/155 assertions, typecheck OK. Consultas finais
via psql no banco wagering retornaram 0 tabelas em public e 0 bancos dwp_test_* restantes.
Nenhuma migration foi aplicada ao principal e nenhum volume foi apagado.

Problemas encontrados e soluções: precedência JSONB corrigida na migration; tipos de
assertions passaram a usar DTO/enum explícitos; commit de persistência precisou de
correção posterior do teste de mapper. No cenário multiprocesso, application_name na
querystring da URL não era repassado pelo parser instalado do MikroORM: observação
encontrou 0 nomes e o teste falhou. O script de teste passou a fornecer driverOptions
ao pool e o cenário completo passou com 3 PIDs e49 replays. A revisão também explicitou
::text nos valores monetários do snapshot SQL de comparação dos testes.

Garantias demonstradas: saldo/ledger reconciliados em cada cenário; efeito único em
50 chamadas/3 processos; rejeição persistente sem movimento; resposta original imutável;
espera por identidade/Wallet, outra Wallet avançando; rollback integral e ausência de
sucesso antes do commit; retry limitado sem eventos/efeitos duplicados.

Limites: nenhum WIN/LOSS/REFUND/ROLLBACK como caso de uso, HTTP, autenticação, consumer,
publisher ou reprocessamento de referências. O teste de 3 processos não é teste de carga
nem prova de kill após commit/pré-ACK. Snapshot legado ausente exige intervenção
explícita; não foi reconstruído. Falha de conexão após commit pode ter resultado
incerto: não fazemos retry automático desse erro, embora posterior chamada idêntica
possa recuperar resultado já persistido. Métricas/alertas e protocolo de retenção são
pendências operacionais, não garantias desta entrega.

Próxima etapa recomendada, mediante autorização: ampliar o mesmo fluxo para WIN/LOSS
com snapshots/eventos correspondentes e validação das referências aprovada. Não iniciar
outros kinds ou transportes automaticamente. Desenvolvimento desta etapa termina em BET.

## 30. Admissão compartilhada para BET, WIN e LOSS

Aposta BET retira o valor apostado. WIN credita o prêmio, que pode ser diferente
 desse valor. LOSS registra que a rodada foi perdida: debitar novamente cobraria
 duas vezes a mesma aposta. Por isso LOSS exige `0.00` e não movimenta saldo.

### Funções e contratos desta mudança

- `WagerInput`/`PreparedWager` (`src/application/wagering/prepare-wager.ts`): DTO
  readonly com kind BET/WIN/LOSS, IDs string, MoneyProps e referência externa
  opcional. A saída acrescenta Money, JSON canônico e hash. Não são entidades ORM.
- `prepareWager(input: WagerInput): PreparedWager`, no mesmo arquivo: usado pelo
  processador e pelos testes. Confere objeto/IDs/namespace/kind; valida referência
  somente em WIN, diferente do próprio externalId; constrói Money; exige positivo
  para BET/WIN e zero para LOSS; verifica o teto persistível; monta campos de negócio
  em ordem lexicográfica; serializa JSON UTF-8 e calcula SHA-256; congela cópias.
  Dependências: Money e crypto, sem I/O. Erros: InvalidWagerInputError para contrato,
  MoneyError para dinheiro inválido. Referência ausente não entra no JSON; referência
  presente entra entre providerId e roundId. Exemplo: WIN 40.50 com referência bet-1
  tem hash diferente da mesma WIN sem referência. idempotencyKey continua excluída.
- `assertToken(value: unknown, field: string): asserts value is string`, privado no
  mesmo arquivo: usado por prepareWager; rejeita vazio, tipo incorreto, espaços e
  controles, sem normalizar IDs. Não retorna valor; lança InvalidWagerInputError.
- `InvalidWagerInputError(message: string)`: construtor agora nesse arquivo,
  preserva name/code e Error.message; os chamadores distinguem admissão inválida.
- `prepareBet(input: BetInput): PreparedBet` (`prepare-bet.ts`): fachada compatível;
  verifica BET antes de delegar à função comum e restringe o tipo de saída.
  Continua recusando WIN e referências. O cast de saída só estreita o kind já
  verificado. Preserva imports antigos e, principalmente, os bytes/hashes existentes.
  Alternativa de renomear/remover a API quebraria consumidores sem benefício.

### Testes de contrato

`test/wager-payload.test.ts` tem fixtures sem infraestrutura. Cada callback retorna
void; depende de expect/prepareWager e falha se a garantia nomeada não for cumprida.
`generic canonicalizer preserves BET bytes and hash` compara a saída com prepareBet;
`WIN reference is canonical...` verifica inclusão/ordem, hash, cópia e ausência;
`invalid WIN reference %j` parametriza vazio/espaço/self/null/número;
`WIN rejects amount %s` cobre zero/negativo/escala/teto;
`LOSS requires exactly zero...` cobre zero, positivos/negativos, referência e kind
fora do escopo; `kind participates...` prova que trocar BET por WIN muda o hash.
Os 25 testes anteriores de BET continuam ativos, inclusive o hash independente
`3453cc...cba7`. Execução: typecheck OK; 38 testes de payload, 88 assertions, zero falhas.
Este incremento só prepara entrada; ainda não credita prêmios nem grava LOSS.

## 31. Resultados terminais e comprovantes de pendência

Resultado histórico é o saldo observado na execução, não o saldo consultado hoje.
LOSS precisa guardar versão e saldo sob o mesmo lock usado por movimentos: entre
uma leitura e a gravação poderia haver uma BET concorrente. O preço é serializar
brevemente LOSS com movimentos da mesma carteira. Wallets diferentes não se bloqueiam.

A migration `Migration20261023000006.ts` mantém a tabela terminal v1 e acrescenta
`wager_pending_receipts`. Uma WIN aguardando BET guarda um comprovante imutável, que
não é uma promessa de crédito. Quando o futuro worker concluir, acrescentará um
resultado terminal na outra tabela. Nada precisa sobrescrever o histórico inicial.
Não criamos backfill com saldos atuais para transações antigas sem resultado.

### Migration e SQL, função por função

- `up(): Promise<void>`: chamado pelo migrator; enfileira DDL transacional com addSql.
  Cria comprovantes, PK/FK para transação, schema_version=1, wallet_version positiva
  e segura, JSON de status PENDING_REFERENCE sem failureCode. Reusa valid_wager_result
  substituindo o status somente na expressão de validação, nunca no dado armazenado.
  Cria triggers de consistência/imutabilidade/no-truncate e permissões SELECT/INSERT
  para app; troca duas funções existentes com CREATE OR REPLACE. Não altera hashes,
  saldos, ledger, privilégios financeiros nem linhas anteriores.
- `check_wager_pending_receipt(): trigger`: BEFORE INSERT; NEW é a entrada e NEW o
  retorno. Busca transação (23503 se inexistente), exige WIN/PENDING_REFERENCE/moeda
  igual (23514), trava wallet NO KEY UPDATE e compara saldo/versão (23514). CHECKs
  completam forma JSON e identidade; PK recusa duplicata (23505). Cast inválido pode
  produzir erro SQL de conversão; toda a transação é revertida. Não chama rede.
- `check_wager_result(): trigger`: agora aceita BET/WIN/LOSS terminal; compara status,
  failureCode/moeda com transação, saldo/versão com wallet travada. PROCESSED de BET
  ou WIN exige ledger correspondente. LOSS não exige ledger, pois a integridade
  financeira anterior já proíbe lançamento para LOSS. Continua recusando snapshots
  inventados e mantém as regras de BET. Retorna NEW ou levanta 23514/23503.
- `require_bet_result(): trigger`: nome legado preservado para o trigger existente;
  consulta o estado final da operação no COMMIT e exige resultado para os três kinds
  terminais ou comprovante para WIN pendente. Retorna NULL (AFTER), falha 23514.
  Diferível permite inserir transação, ledger e resposta na mesma unidade SQL.
- `down(): Promise<void>`: restaura exatamente as duas funções da versão anterior,
  remove tabela de comprovantes e sua função. Guarda SQL DO recusa downgrade com
  comprovantes ou resultados WIN/LOSS (55000), evitando apagar evidências. Testamos
  ida/volta/reaplicação em banco descartável e a recusa com dados. Remover uma feature
  com dados financeiros exigirá plano explícito de preservação, fora desta entrega.
  Sem dados novos, down é reversível; as tabelas financeiras anteriores permanecem.

### Tipos, mapper e repositório

`PendingWagerReceipt` em `wager-result.ts`: transactionId/status fixo/balance readonly,
failureCode nunca; WagerResult passa a ser união terminal|pendente acrescida de flag
replay. O DTO BET não ganha campos novos. wallet_version fica no registro persistido.
`WagerResultRepository` acrescenta findPendingReceipt e insertPendingReceipt; mesma
sessão/UOW, sem porta paralela ou nova abstração de domínio.

Em `wager-result-mapper.ts`:

| Método | Entrada e retorno | Fluxo, erros e uso |
|---|---|---|
| `read` privado | WagerResultRecord → snapshot terminal ou comprovante | Valida versão1, IDs, JSON, Money, teto, campos exatos, escala canônica e versão string segura. Aceita pendência sem failure; rejeições incluem INVALID_REFERENCE/REFERENCE_NOT_FOUND. Congela saída e MoneyProps. TypeError/MoneyError/RangeError em corrupção. Usado pelos três métodos públicos. |
| `toSnapshot` | registro → WagerResultSnapshot | Delega read e recusa pendente com TypeError; usado na leitura terminal. |
| `toPendingReceipt` | registro → PendingWagerReceipt | Delega read e exige pendente, senão TypeError; usado na leitura do comprovante. |
| `toRecord` | snapshot ou comprovante, walletVersion number → WagerResultRecord | Número só para versão, nunca dinheiro; valida inteiro seguro, converte versão em string, lê/valida novamente e retorna registro. Chamado pelos INSERTs. |

Em `wager-result-repository.ts`, construtor conserva FinancialSession. Métodos novos:
`findPendingReceipt(id: string): Promise<PendingWagerReceipt|null>` faz SELECT
parametrizado, retorna null se ausente ou chama mapper; `insertPendingReceipt(receipt,
walletVersion): Promise<void>` mapeia, serializa JSON e faz INSERT parametrizado.
Propagam erros do mapper, sessão fechada, constraints/duplicidade/permissões SQL.
Não há UPDATE, UPSERT, publicação ou commit interno. Métodos terminais permanecem.

### Testes deste incremento

`infra/test/wager-support.ts::withWagerDatabase(run): Promise<void>` recebe callback
assíncrono, abre banco dwp_test_* com migrations até00006, ORM app e UOW, executa
callback e fecha ORM em finally; infraestrutura existente remove banco. Propaga erro,
nunca toca principal. `wager-snapshots.test.ts::transaction(walletId,kind,pending=false)`
cria fixture real de WagerTransaction com Money zero para LOSS/40.50 para WIN,
referência missing opcional; não persiste, retorna entidade ou erro de domínio.

Callbacks de teste retornam Promise<void>, usam PostgreSQL real/expect e reconciliação:
`up down reapply...` preserva BET legado sem inventar resposta;
`%s stores locked historical state...` parametriza WIN/LOSS e confere ledger/versão,
resultado, recusa de downgrade; `pending receipt is immutable...` confere exigência
no commit, replay de leitura, versão inválida, duplicidade, permissões e imutabilidade;
`%s terminal cannot commit...` prova rollback quando falta resultado.
Em `test/wager-result-mapper.test.ts`, `pending receipts...` prova congelamento,
roundtrip, separação de tipos e failure indevido; `WIN reference rejection...` prova
leitura do código aprovado. Nenhuma suíte representa um worker de referências.

Validação executada deste incremento: `bun run check` passou typecheck, 478 testes
unitários/aplicação e build. `bun test ./infra/test/bet-persistence.test.ts
./infra/test/wager-snapshots.test.ts`: 12 testes reais, zero falhas. Os novos testes
precisaram usar enums e objetos esperados tipados nas assertions do Bun/TypeScript;
a tipagem foi corrigida antes do commit, sem relaxar strict.

## 32. O mesmo caso de uso processa BET, WIN e LOSS

Resultado de jogo e movimento de saldo não são sinônimos. Se a carteira começa
com 100.00 e a BET consome 25.00, o saldo já é 75.00. Perder a rodada (LOSS) não consome
mais 25.00. Ganhar 40.50 acrescenta 40.50 e resulta em 115.50. WIN pode referenciar a BET
para comprovar o contexto da rodada; não é reversão e não precisa ter o mesmo valor.
Uma referência só é resolvida por `(providerId, externalTransactionId)`, nunca por
ID global ou apenas pela rodada. gameId não é vínculo exigido pelo contrato oficial;
provider, jogador, carteira, moeda, rodada e kind BET são conferidos pelo domínio.

### Fluxo completo e atomicidade

```mermaid
flowchart TD
  A[Validar entrada e hash] --> B[Locks das identidades]
  B --> C{Operação existente?}
  C -->|sim| D[Comparar hash e ler comprovante ou resultado histórico]
  C -->|não| E[Lock da Wallet e validação de identidade]
  E --> F[Inserir PENDING e consultar referência no mesmo provedor]
  F --> G{Resultado de domínio}
  G -->|BET| H[Debitar ou rejeitar sem saldo]
  G -->|WIN| I[Creditar, rejeitar referência/teto, ou aguardar referência]
  G -->|LOSS| J[Marcar PROCESSED sem movimento]
  H --> K[Lifecycle + Wallet/ledger quando aplicáveis]
  I --> K
  J --> K
  K --> L[Outbox + resultado terminal ou comprovante pendente]
  L --> M[COMMIT, inclusive constraints diferíveis]
  M --> N[Retornar DTO]
```

A Outbox é um registro local de intenção de publicação. Nenhum destes eventos foi
publicado no SQS pelo caso de uso. `execute` só resolve depois de COMMIT, inclusive
quando as constraints diferíveis são avaliadas. Uma falha desfaz todos os INSERTs e
UPDATEs. A Wallet em memória pode ter mudado; a próxima tentativa lê outra instância.

| Resultado | Wallet/ledger | Outbox desta operação | Snapshot |
|---|---|---|---|
| BET processada | débito, versão+1, DEBIT | Processed + BalanceChanged | terminal |
| WIN processada | crédito, versão+1, CREDIT | Processed + BalanceChanged | terminal |
| LOSS processada | nenhum, versão preservada | Processed | terminal |
| rejeição | nenhum | Rejected | terminal com failureCode |
| WIN aguardando | nenhum | PendingReference | comprovante pendente |
| replay | nenhum | nenhum novo | lê registro histórico |

### Métodos de ProcessWagerTransaction

Arquivo `src/application/wagering/process-wager-transaction.ts`. Domínio continua
sem imports de Nest/MikroORM. Dependências recebidas: FinancialUnitOfWork, IdGenerator,
Clock; métodos privados usam portas dos repositórios e classes financeiras/eventos.

- **constructor(unit, ids, clock)**: guarda dependências, não consulta banco nem
  cria objetos financeiros; retorna instância. Nest usa sua factory já existente e
  testes usam processor. Não foi criada factory/caso de uso separado para WIN/LOSS.
- **execute(input: WagerInput): Promise<WagerResult>**: valida/copia antes de I/O,
  abre UOW e chama process. Retorna DTO congelado após commit; propaga admissão,
  domínio inesperado e SQL. Apenas RetryableFinancialTransactionError 40001/40P01
  refaz até 3 tentativas inteiras, com espera 10/20ms fora da SQL e entidades novas.
  Rejeição de negócio retorna normalmente, não aciona retry. Chamador futuro: HTTP
  ou fronteira sem Inbox. Exemplo: WIN 40.50 sem referência retorna PROCESSED 115.50.
- **processInTransaction(input, repositories): Promise<WagerResult>**: a mesma
  validação/processamento em UOW do chamador; não abre outra SQL nem faz retry
  parcial. Resultado é provisório. Futuro consumidor comporá Inbox e somente fará
  ACK após a fronteira externa confirmar. Não é worker de referências pendentes.
- **process(prepared: PreparedWager, repos): Promise<WagerResult>**, privado:
  1. obtém locks de key/externalId em ordem determinística;
  2. busca por key, compara hash e lê resultado do status atual; pendente usa receipt,
     terminal usa result. Ausência/incompatibilidade gera ORIGINAL_RESULT_UNAVAILABLE,
     preservando o tratamento fail-closed de legado;
  3. externalId existente com outra key é conflito; nenhum saldo/evento novo;
  4. trava Wallet, exige existência/jogador/moeda; captura Clock e cria transação;
  5. insere PENDING, resolve referência por SELECT após o lock e chama apply;
  6. salva Wallet somente se mudou, atualiza lifecycle, insere ledger quando existe;
  7. escolhe evento por **status**, não pela presença de movimento: isso é essencial
     para LOSS processada, que não possui movimento;
  8. acrescenta BalanceChanged só se movement existe; grava comprovante ou resultado
     com saldo e versão travados; retorna idempotentReplay=false.
  Erros: WagerProcessingError de conflito/identidade/resultado ausente, domínio não
  esperado, erros dos repositórios/SQL. Todos abortam a UOW. Evento/contexto usa tx.id,
  como BET. Não há chamada ao broker, lookup entre provedores ou lock de referência.
- **apply(tx: WagerTransaction, wallet: Wallet, reference: WagerTransaction|undefined,
  at: Date): WalletMovementResult|undefined**, privado e sem I/O: só manipula objetos
  frescos. Para WIN chama ledgerDirectionFor(reference), que já valida todos os vínculos
  e status no domínio; REFERENCE_REQUIRED/REFERENCE_NOT_PROCESSED leva a pendência;
  INVALID_REFERENCE leva a reject(INVALID_REFERENCE). Outros erros propagam. Se a
  referência é válida/omitida, compara Money(balance+prêmio) com teto antes de alterar
  carteira; overflow leva a DOMAIN_RULE_VIOLATION. BET chama debit, WIN chama credit;
  captura somente INSUFFICIENT_FUNDS de Wallet, como antes. LOSS não chama nenhum
  movimento. Encerra com markProcessed(reference,at). undefined pode significar LOSS,
  rejeição ou pendência; por isso process consulta status. Alternativa de estratégia
  polimórfica por kind adicionaria classes sem necessidade para três caminhos curtos.

Referência válida ainda PENDING espera; referência terminal REJECTED/FAILED é
inutilizável e rejeitada. ID que só existe em outro provedor é ausente no escopo
correto. BETs processadas são imutáveis; uma referência confirmada não muda depois.
A leitura após o lock em READ COMMITTED vê o commit do escritor anterior da carteira.
Não travamos a identidade da referência depois da Wallet: isso poderia inverter a
ordem de locks e criar ciclos. Uma referência não visível vira pendência, que é segura.
Base: [isolamento PostgreSQL 17](https://www.postgresql.org/docs/17/transaction-iso.html)
e [locks de linhas](https://www.postgresql.org/docs/17/explicit-locking.html).

### Repetição pendente e transição futura

WIN chega antes da BET: grava PENDING_REFERENCE, comprovante 100.00/versão1 e 1 evento.
BET chega e debita 25.00: Wallet 75.00/versão2. Reenviar a WIN continua retornando o
comprovante 100.00, sem crédito ou evento adicional. O futuro worker deverá adquirir
as mesmas identidades antes da Wallet, reler a pendência e a BET, aplicar o domínio,
gravar movimento/lifecycle/novos eventos/resultado terminal atomicamente. Depois,
replay retornará115.50/PROCESSED. O comprovante 100.00 continua imutável para auditoria.
Isso foi simulado num teste por composição explícita dos repositórios; **não existe
worker, agendamento, TTL nem retry operacional de referências nesta entrega**.

### Helpers e testes funcionais

`infra/test/wager-support.ts::wagerInput(walletId:string, kind:'WIN'|'LOSS'='WIN',
patch:Partial<WagerInput>={}): WagerInput` reutiliza fixture BET, troca kind e Money
(40.50 ou0.00), aplica patch; sem I/O/validação, só testes usam. `wagerState(sql:SQL):
Promise<unknown>` combina databaseState anterior com SELECT ordenado de receipts;
serve de comparação integral antes/depois de falhas/replay. Dinheiro sai como strings;
falha SQL propaga. Ambos usam o banco descartável de withWagerDatabase.

`infra/test/wager-functional.test.ts`: callbacks async recebem os parâmetros indicados,
retornam Promise<void>, usam fixtures reais, PostgreSQL, processor e expect. Erro de
assertion/SQL falha o teste; recursos são encerrados no finally do helper.

| Teste (nome inicial) | Parâmetro, lógica e evidência |
|---|---|
| `BET followed by %s...` | WIN/LOSS: abre 100, debita 25, processa resultado; confere 115.50 ou 75.00, versão3 ou2, ledger, eventos não publicados, snapshot e xmin igual entre registros. |
| `WIN decimal addition...` | Sem parâmetro:0.10+0.20=0.30; wallet no teto rejeita 40.50 com evento e sem ledger. |
| `%s admission leaves...` | 11 casos: WIN zero/negativo/teto; LOSS positivo/referência; ambos com wallet ausente/jogador/moeda incorretos. Estado integral deve permanecer igual. |
| `%s replay survives...` | WIN/LOSS: processa, faz BET posterior, fecha ORM de verdade e abre outro; replay histórico, hash divergente e externalId com outra key não alteram tabelas. |
| `%s same identities...` | WIN/LOSS em dois provedores, mesma key/external: dois IDs diferentes, saldo181 ou100. |
| `WIN resolves processed BET...` | Referência processada, prêmio 40.50 diferente da aposta 25, game diferente permitido; ID interno resolvido e mudar referência conflita com hash. |
| `WIN reference %s...` | 9 cenários: rodada, wallet/jogador, moeda, kind, rejeitada, failed, pending, ausente, outro provedor. Rejeita seis; aguarda os últimos três; nenhum crédito e só um evento, replay sem escrita. Identidades impossíveis pelas FKs não são artificialmente persistidas: wallet/jogador divergentes vêm de outra wallet válida. |
| `WIN before BET...` | Chegada fora de ordem, replay pendente após BET e transição futura simulada com entidades/ledger/eventos; prova coexistência de receipt 100 e result 115.50. |

### Falhas e rollback

`infra/test/wager-rollback.test.ts` usa triggers de falha **no PostgreSQL real**, não
repositórios mockados. Wrappers de UOW só posicionam barreiras/observação.

- `%s rolls back all records...`: matriz11 casos (WIN5 tabelas, LOSS3, pendência3).
  SQL de teste `fail_wager_write(): trigger` lança P0001 antes da escrita selecionada;
  em WIN a falha Outbox ocorre no segundo evento, depois do primeiro. Compara todas
  as tabelas, remove trigger com DROP FUNCTION CASCADE e repete usando estado fresco.
- `%s cannot report success before deferred commit...`: WIN/LOSS/pendência. Wrapper
  executa caso de uso, altera Wallet em 0.01 sem ledger e segura antes do commit.
  Observador vê só estado anterior e promise não retornou sucesso. Libera,23514
  reverte tudo; reutilizar Wallet suja falha ownership; nova execução funciona.
- `WIN retry after a server serialization failure...`: `retry_win(): trigger` usa
  sequência win_attempts, falha 40001 no primeiro INSERT do snapshot (após crédito,
  ledger e eventos). Sequência não é revertida; segunda tentativa confirma um único
  crédito/versão2. Prova tratamento do SQLSTATE injetado, não detector de deadlock.

Todos esses testes terminam reconciliando saldo com soma CREDIT menos DEBIT. Execuções:
29 funcionais novos passaram;15 rollback novos +29 funcionais/rollback BET =44 passaram;
typecheck OK. Concorrência e regressão completa serão registradas no fechamento.

Fechamento do processamento compartilhado: `bun run check` passou 478 testes,
typecheck/build. `bun run test:wager` passou 50 testes (6 snapshots, 29 funcionais,
15 rollback). `bun run test:bet` passou os 40 anteriores. Nenhum teste usa o banco
principal. A ampliação do processador foi mantida em um commit coerente para evitar
duplicar o caminho transacional por kind; provas adicionais de concorrência vêm a seguir.

## 33. Concorrência WIN/LOSS, testes SQL diretos e fechamento

Saldo e versão são observados depois de lock NO KEY UPDATE. Duas WINs de40.50 numa
carteira 100.00 acabam em 181.00/versão3; nenhuma lê 100.00 simultaneamente para substituir
o saldo da outra. BET 25 seguida de WIN 40.50 acaba em115.50, assim como a ordem inversa
quando ambas são admissíveis. Em geral a ordem importa: uma BET sem fundos pode ser
rejeitada se ocorrer antes do prêmio; não deve ser reescrita depois para PROCESSED.
LOSS concorre para observar o saldo confirmado, mas não acrescenta movimento/versão.

### Testes e funções de concorrência

`infra/test/wager-concurrency.test.ts` usa ORM separado, SQL de observação real,
barreiras gate/bounded/observeWait existentes e o mesmo ProcessWagerTransaction.
Callbacks retornam Promise<void>; erros de query/timeout/assertion falham a suíte.
Recursos são liberados em finally; todo caso termina com assertReconciled.

| Teste | Parâmetros, passo a passo e garantia |
|---|---|
| `%s then concurrent %s...` | Cinco pares WIN/WIN, BET/WIN, WIN/BET, WIN/LOSS, LOSS/WIN. Primeira UOW pausa antes do commit; segunda instância espera lock observado em pg_stat_activity; uma terceira operação de outra wallet confirma. Libera primeira, verifica segunda e saldo/versão finais. |
| `20 concurrent %s copies...` | LOSS e WIN pendente. Uma chamada segura commit e 19 chamadas disputam identidades na outra instância. Após liberação, 19 replays iguais, uma transação/evento/snapshot, saldo 100/versão1. |
| `WIN concurrent with BET...` | Modo reference: WIN espera Wallet e depois resolve BET confirmada. Modo external-conflict: disputa mesmo externalId com outra key espera advisory e retorna conflito, sem crédito. |
| `crossed WIN references...` | Duas wallets, cada WIN aponta para externalId da outra. Segura ambos INSERTs reais antes de consultar referências; não adiciona locks cruzados. Concluem pendentes ou rejeitadas conforme visibilidade/identidade, sem crédito e sem ciclo de locks. |
| `50 concurrent WIN copies...` | Trava wallet, inicia 3 processos Bun com 17+17+16 chamadas e nomes distintos; observa os 3 bloqueados no PostgreSQL antes de liberar. Coleta 3 PIDs, 50 respostas, 1 execução/49 replays, 1 crédito/resultado, 2 eventos, saldo 140.50/versão2. |

Helpers locais de teste também têm contratos explícitos:

- Wrappers `paused.run(work)` recebem callback da UOW e retornam sua Promise; delegam
  às queries reais, abrem held após callback e esperam release antes do commit. Usados
  nos três primeiros testes; propagam erro, não substituem PostgreSQL nem repos.
- `pauseAfterInsert(base: FinancialUnitOfWork): FinancialUnitOfWork`, dentro do teste
  cruzado, delega todas as operações; só o callback `transactions.insert(tx)` espera
  após INSERT real até as duas sessões chegarem. `arrived` é sincronização de teste,
  nunca garantia de idempotência. Retorna UOW instrumentada, erros/timeout propagam.
- Callback `blocker` da prova multiprocesso obtém o lock real e o mantém até release;
  retorna Promise<void>. Callback `children.map(count,index)` recebe contagem/index,
  monta URL com application_name e inicia filho com stdin desnecessário e stdout/stderr
  em pipes. Callback de coleta aguarda streams+exitCode, exige zero/stderr vazio e
  interpreta relatório `{pid,results}`; timeout encerra teste e finally termina filhos.
- `infra/test/bet-worker.ts`, programa top-level reaproveitado: só o tipo da entrada
  passou de BetInput a WagerInput. Mantém nomes DWP_BET_* por compatibilidade. Lê URL
  e recusa host fora de 127.0.0.1 ou banco sem prefixo dwp_test_; valida contagem 1..50,
  cria ORM/ProcessWagerTransaction com UUID/Clock reais, executa chamadas em paralelo,
  escreve JSON no stdout e fecha ORM. Erro gera exitCode não zero. Número serve apenas
  à contagem/PID, jamais a dinheiro. Não é consumer SQS nem worker de pendências.

`infra/test/wager-snapshots.test.ts::direct SQL cannot forge...` acrescenta sete
INSERTs SQL inválidos dentro de transações reais: schema 2, identidade diferente,
status incorreto, failureCode em pendência, moeda/saldo divergentes e dinheiro não
canônico. O callback de cada app.begin cria WIN pendente e tenta receipt; espera 23514
com rollback de ambos. Não depende do mapper para barrar dados inválidos. Os sete
casos compõem um teste, e não são contados como sete testes distintos no relatório.

A prova de ausência de deadlock é delimitada aos cenários exercitados, com waits reais
e deadlines. Não promete ausência universal de deadlock para SQL arbitrário ou novos
fluxos futuros. O protocolo não ganhou locks sobre a identidade de referência e o
retry limitado já existente permanece disponível para 40001/40P01.

### Comandos executados e resultados finais

Ambiente: Bun 1.4.3, PostgreSQL 17 em Docker e LocalStack Community 4.14.0. Se Bun não
estiver no PATH, este checkout permite `export PATH="$PWD/.tools/node_modules/.bin:$PATH"`.
`DATABASE_URL=postgresql://wager_app:local_app_only@127.0.0.1:55432/wagering` foi usada
nos checks de configuração. Credencial estritamente local; testes financeiros criam
seu próprio banco descartável, mesmo com essa variável apontando para o principal.

| Comando real | Resultado |
|---|---|
| `bun run check` | typecheck OK, 478 testes/2558 assertions, build OK |
| `bun run test:financial` | 34 testes, 0 falhas |
| `bun run test:persistence` | 15 testes, 0 falhas |
| `bun run test:messaging` | 14 testes, 0 falhas |
| `bun run test:wallet-creation` | 25 testes, 0 falhas |
| `bun run test:bet` | 40 testes, 0 falhas |
| `bun run test:wager` | 62 testes/434 assertions, 0 falhas:7 snapshots, 29 funcionais, 15 rollback, 11 concorrência |
| `bun run test:orm` | 2 testes, 0 falhas |
| `bun run test:migrations` | 2 testes, 0 falhas |
| `bun run test:infra` (por último) | 2 PostgreSQL +4 SQS, 0 falhas; restart/recriação, envio/recebimento/delete/DLQ reais |
| `git diff --check` | sem erros |

Total **678 testes distintos**, 77 além dos 601 anteriores: 13 novos de payload,
2 de mapper e 62 PostgreSQL. Reexecuções não foram somadas. Build/typecheck não são
contados como testes. A consulta abaixo foi executada após os testes de containers:

```bash
docker compose exec -T postgres psql -U wager_admin -d wagering \
  -c "SELECT tablename FROM pg_tables WHERE schemaname='public';" \
  -c "SELECT datname FROM pg_database WHERE datname LIKE 'dwp_test_%';"
```

Resultado de ambas: `(0 rows)`. `docker compose ps`: PostgreSQL e LocalStack healthy.
Nenhuma migration financeira foi aplicada ao principal, nenhum volume foi apagado.
Não há arquivos de execução, dependências instaladas ou segredos nos commits.

Problemas encontrados e tratados: a tabela de resultados aceitava apenas BET e
exigia ledger para todo PROCESSED;00006 estende kinds e respeita LOSS. Pendência não
podia ocupar o único resultado terminal; tabela separada aprovada preserva ambos.
O código antigo escolhia evento pela existência de movimento; agora usa status para
não chamar LOSS de rejeição. Assertions novas exigiram enums/tipos exatos do Bun;
foram corrigidas antes dos commits. Não foi necessário modificar Money, Wallet,
WagerTransaction, eventos de domínio ou migrations anteriores.

A entrega termina aqui. Próxima etapa recomendada: REFUND e depois ROLLBACK no mesmo
fluxo, mediante autorização. O reprocessador de pendências precisará de política
própria de tentativas/TTL; continua pendente junto com HTTP, consumidores, publishers,
autenticação e observabilidade operacional. Não confundir os eventos na Outbox com
publicação realizada ou os testes multiprocesso com um consumer implementado.

## 34. REFUND: contrato e decisão de domínio sobre duplicidade

REFUND devolve integralmente o valor de uma BET processada. Exemplo: 100.00 menos BET 25.00
é 75.00; REFUND 25.00 restaura 100.00, deixando dois lançamentos auditáveis em vez de apagar
a aposta. WIN paga um prêmio independente; ROLLBACK inverte uma operação elegível
(BET/WIN/REFUND), mas ainda não é processado pelo caso de uso. Reembolso parcial não
faz parte do contrato, portanto 10.00 sobre BET 25.00 é referência inválida.

Auditoria: índice parcial `wager_successful_reversal_unique` já garante unicidade de
(reference_transaction_id,kind) para PROCESSED REFUND/ROLLBACK. Não será substituído
por unicidade global da referência. Para a futura interação entre tipos, esse índice
sozinho permitiria REFUND(BET) e ROLLBACK(BET), ambos créditos; antes de implementar
ROLLBACK será necessário decidir explicitamente quais sequências de reversão aceitar,
sem afirmar que o índice atual elimina esse risco entre tipos. Esta etapa só REFUND.
BET em PENDING_REFERENCE é impossível nas regras atuais: BET não recebe referência,
e aquele status exige referência. BET PENDING é o estado de espera alcançável.

### Funções do primeiro incremento

- `prepareWager(input: WagerInput): PreparedWager`, em `src/application/wagering/prepare-wager.ts`:
  passa a aceitar REFUND positivo e exigir referência externa válida, diferente do próprio
  externalId. Reutiliza assertToken/Money/teto/cópia imutável/SHA-256, na mesma ordem de
  campos. Sem referência lança InvalidWagerInputError antes de I/O. Dinheiro inválido
  conserva MoneyError. Chamadores: execute/processInTransaction e testes. Saída mantém
  input, money, canonicalPayload e payloadHash. Não há alteração nos bytes de BET/WIN/LOSS.
  Alternativa de canonicalizador separado duplicaria regras; o campo já existia para WIN.
- `WagerTransaction.assertRefundAvailable(reference: WagerTransaction|undefined,
  previousRefund: WagerTransaction|null): void`, em `src/domain/wagering/wager-transaction.ts`:
  consulta local, não muda lifecycle. Primeiro exige estado mutável e kind REFUND;
  depois delega #assertReference, que já confere identidade, vínculos, valor integral
  e status PROCESSED. Sem anterior retorna void. Havendo evidência anterior, exige
  entidade REFUND processada apontando para o ID interno resolvido; evidência errada
  é TypeError (erro do chamador), não rejeição financeira. Evidência válida lança
  WagerTransactionError/DUPLICATE_REVERSAL. O processador buscará essa entidade no banco
  sob lock e decidirá persistir reject(DuplicateReversal). A consulta local não substitui
  UNIQUE nem promete descobrir registros que o chamador não forneceu. Nenhum ORM no domínio.
  Outros erros: INVALID_KIND, INVALID_TRANSACTION_STATE e os erros de referência já
  existentes. Exemplo: refund-b detecta refund-a processado da BET de 25.00 e permanece PENDING
  até o chamador invocar reject. A extensão de WagerTransactionErrorCode só acrescenta
  DUPLICATE_REVERSAL; a factory de erro mantém construtor/code/name anteriores.

### Testes de contrato e domínio

`test/refund-contract.test.ts::transaction(kind,id,reference?,amount='25.00')` cria
fixture de domínio com IDs/Clock fixos e Money real; retorna WagerTransaction, sem I/O;
factory pode lançar os erros de domínio se o teste fornecer estrutura inválida.
Callbacks de testes retornam void, usam expect e falham com assertion/erro inesperado:

| Teste | Parâmetros e sequência |
|---|---|
| `REFUND canonical hash...` | Normaliza 00025.00, troca key sem mudar hash; troca referência/kind e exige outro hash; verifica imutabilidade. |
| `REFUND rejects missing...` | undefined/null/vazio/espaço/self; todos falham antes da persistência. |
| `REFUND rejects inadmissible...` | zero/negativo/escala 3/teto excedido; todos rejeitados. |
| `refund availability accepts...` | BET processada, nenhum anterior permite; REFUND anterior processado lança DUPLICATE_REVERSAL sem mutar; depois reject torna terminal e proíbe nova consulta mutável. |
| `refund availability delegates...` | Ausência/PENDING/valor parcial/kind errado/evidência anterior ainda pendente; confere códigos e TypeError. |
| `%s hash with reference=%s...` | Quatro vetores BET/WIN sem e com referência/LOSS, hashes calculados independentemente com Python hashlib e JSON ordenado. Protegem compatibilidade, além do vetor BET já existente. |

Validação do contrato: `bun run check` passou typecheck, 494 testes e build; 16 testes
novos nesta etapa. Nenhum SQL financeiro foi aplicado ao principal.

## 35. Persistência de REFUND e consulta do reembolso anterior

`Migration20261023000007.ts` não cria outra tabela nem altera o índice de reversão.
Amplia três funções existentes para incluir REFUND nas garantias de resposta histórica.
As tabelas v1, hashes, valores, dados anteriores, imutabilidade e permissões permanecem.

| Função/SQL | Responsabilidade, parâmetros, fluxo, retorno e erros |
|---|---|
| `up(): Promise<void>` | Chamado pelo migrator, enfileira CREATE OR REPLACE das três funções via addSql. DDL transacional; não recebe parâmetros nem faz backfill. Reaplicar migrations não repete alterações. Falhas SQL propagam e revertem a migration. |
| `check_wager_pending_receipt(): trigger` | BEFORE INSERT recebe NEW; exige WIN ou REFUND pendente, mesma moeda e saldo/versão da carteira sob NO KEY UPDATE. Retorna NEW; 23503 para transação inexistente,23514 para inconsistência; CHECKs/PK existentes continuam ativos. |
| `check_wager_result(): trigger` | Acrescenta REFUND terminal à lista anterior. Valida JSON, vínculo/status/failureCode/moeda, saldo/versão travados; REFUND PROCESSED exige ledger correspondente. Retorna NEW ou 23514/23503. A validação de referência/integralidade do ledger continua nas funções financeiras anteriores. |
| `require_bet_result(): trigger` | Nome legado: no COMMIT consulta estado final; exige resultado de REFUND terminal ou receipt de REFUND pendente, além das regras anteriores. Retorna NULL; falta de resposta causa 23514 e rollback completo. |
| `down(): Promise<void>` | Bloco DO consulta as duas tabelas por kind REFUND e recusa 55000 se houver dados novos. Caso contrário restaura exatamente as três funções da 00006. Preserva WIN/LOSS/BET e tabelas; testado com snapshots anteriores reais. Não descarta auditoria para facilitar downgrade. |

`WagerTransactionRepository.findProcessedRefund(referenceId: string): Promise<WagerTransaction|null>`
foi acrescentado em `src/application/ports/financial-persistence.ts`. Adaptador
`MikroWagerTransactionRepository.findProcessedRefund`, em `wager-transaction-repository.ts`,
executa SELECT parametrizado por ID **interno** da referência, kind='REFUND' e status='PROCESSED'.
Reutiliza read, mapper e ownership da sessão; retorna entidade ou null. Não adquire
lock extra: para decidir um novo movimento, o chamador deve já ter travado Wallet.
Propaga SQL/mapping/sessão fechada. Rejeições e pendências não ocupam a unicidade;
a consulta não considera outro tipo nem outro ID de referência. Alternativa de
listar todos os movimentos para filtrar em memória seria mais cara e menos clara.

`WagerResultMapper.read` (`wager-result-mapper.ts`) acrescenta DUPLICATE_REVERSAL aos
códigos legíveis de rejeição; parâmetros/retorno/freeze/validação estrita são os mesmos
da seção 31. O banco confere se o código é permitido pelo kind da transação. Não há
nova forma de DTO, novo schema_version ou mudança de valores monetários.

### Fixtures e testes

`infra/test/refund-support.ts::withRefundDatabase(run): Promise<void>` aplica até 00007
num banco dwp_test_*, abre ORM app/UOW e executa callback; finally fecha ORM e helper
externo remove banco. Propaga erros sem tocar principal. `refundInput(walletId:string,
patch:Partial<WagerInput>={}): WagerInput` deriva fixture BET 25.00 e preenche REFUND,
IDs refund e referência external-1; patch permite cenários inválidos. Não valida/persiste.

`infra/test/refund-persistence.test.ts::refund(walletId,id='refund')` cria entidade
REFUND 25.00 apontando para external-1, com Money/Clock reais e hash de fixture; retorna
WagerTransaction ou erro da factory. Callbacks async usam PostgreSQL, retornam void
via Promise e propagam erros/expect. Quatro testes:

- `REFUND migration up down reapply...`: cria BET terminal e WIN pendente na 00006;
  captura todas as tabelas, sobe, reaplica, desce e sobe; conteúdo deve ser idêntico.
- `processed refund lookup ignores...`: grava tentativas pendente/rejeitada, consulta
  null; grava REFUND integral com Wallet/ledger/result, consulta entidade. Tenta outro
  PROCESSED sem checagem local e recebe wager_successful_reversal_unique; sem parcial.
- `REFUND %s requires...`: dois parâmetros PENDING_REFERENCE/REJECTED. Falta de resposta
  falha no commit; adicionar resposta apropriada confirma. Downgrade recusa 55000 e
  preserva estado. A rejeição usa DUPLICATE_REVERSAL, exercitando mapper e SQL.

Em `wager-concurrency.test.ts`, o wrapper pauseAfterInsert ganhou apenas a delegação
`findProcessedRefund(id)` ao repositório real para atender à porta ampliada; nenhum
comportamento concorrente anterior foi trocado por mock.

Validação deste incremento: check completo com 494 testes, typecheck/build OK;
11 testes PostgreSQL (4 novos + 7 snapshots anteriores) aprovados, zero falhas.

## 36. REFUND no processador transacional compartilhado

Reembolsar significa registrar um crédito que devolve o débito de uma BET específica.
A BET e seu ledger continuam intactos para auditoria. Se a abertura foi 100.00, BET 25.00
levou a 75.00 e uma WIN posterior acrescentou 40.50, o REFUND 25.00 leva a 140.50. Ele não
substitui o saldo pelo saldo anterior à BET; preserva as outras movimentações. Por isso
exige referência e valor integral. Aceitar 10.00 de uma BET 25.00 exigiria outro contrato,
com controle do total parcialmente reembolsado; não é o contrato oficial desta etapa.
WIN é prêmio, cujo valor pode diferir da BET; ROLLBACK é inversão de operação elegível,
que pode ser débito ou crédito e continua fora do processador atual.

### Caminho de uma solicitação até o COMMIT

```mermaid
flowchart TD
  A[Entrada REFUND com dinheiro em string] --> B[Canonicalização e SHA-256]
  B --> C[UOW e locks das identidades da nova operação]
  C --> D{Operação já existe?}
  D -->|mesmo hash| E[Resposta histórica sem escrever]
  D -->|conflito| F[Erro de admissão e rollback]
  D -->|nova| G[Lock da Wallet e leitura da referência por provedor]
  G --> H[Domínio valida referência e reembolso anterior]
  H -->|ausente ou BET pendente compatível| I[Pendência + receipt + evento Outbox]
  H -->|inválida ou duplicada| J[Rejeição + snapshot + evento Outbox]
  H -->|elegível e dentro do teto| K[Crédito + versão + ledger + status + snapshot + 2 eventos Outbox]
  K --> L[Constraints diferíveis e COMMIT]
  I --> L
  J --> L
  E --> L
  L --> M[execute entrega o resultado]
```

Não há publicação de eventos neste fluxo. Objetos de evento são construídos em memória
na transação; seus envelopes são inseridos na Outbox e só ficam visíveis após commit.
Uma falha em qualquer gravação ou constraint diferível reverte o conjunto. O futuro
publisher lerá registros confirmados para enviar ao SQS; não foi implementado aqui.

### Métodos e dependências

Todos estão em `src/application/wagering/process-wager-transaction.ts`. As assinaturas
públicas permanecem as mesmas, com WagerInput agora admitindo REFUND. Dependências são
portas de UOW, Clock e IdGenerator; regras locais são de Money, Wallet e WagerTransaction.
Nest injeta essa composição já existente, mas o domínio continua sem Nest e MikroORM.

| Método | Parâmetros e retorno | Fluxo, erros, chamadores e decisão |
|---|---|---|
| `constructor(unit, ids, clock)` | FinancialUnitOfWork, IdGenerator, Clock; instancia ProcessWagerTransaction | Mantém dependências existentes; não abre SQL nem valida aposta. Composição Nest e factory processor dos testes o chamam. Não ganhou serviço especial de REFUND. |
| `execute(input)` | WagerInput → Promise<WagerResult> | prepareWager normaliza/valida antes da UOW; unit.run chama process e só resolve após commit. Até três tentativas para RetryableFinancialTransactionError (40P01/40001 traduzidos pela infraestrutura), com nova sessão/entidades e atraso de 10/20 ms fora da transação. Demais erros propagam. Chamado por futuros adaptadores e testes. REFUND 25.00 válido devolve saldo 100.00; replay acrescenta idempotentReplay=true ao DTO histórico. |
| `processInTransaction(input, repositories)` | WagerInput, FinancialRepositories → Promise<WagerResult> | Prepara e delega process usando a fronteira do chamador; não faz commit nem retry interno. Resultado é provisório até a UOW externa confirmar; seu dono repete a fronteira inteira em erro transitório. Prepara futura Inbox, sem implementá-la. Teste lança erro externo após REFUND e verifica rollback. |
| `process(prepared, repos)` | PreparedWager, FinancialRepositories → Promise<WagerResult>; privado | Locks de admissão → procura key/hash → retorna receipt ou snapshot compatível no replay → verifica conflito externo → trava Wallet e valida dono/moeda → cria e insere PENDING → busca referência no mesmo provedor → consulta findProcessedRefund somente para REFUND com referência encontrada → chama apply → persiste movimento/lifecycle/eventos/resposta. Chamado pelos dois métodos anteriores. Falta de Wallet, dono/moeda, hash ou externalId conflitante são WagerProcessingError; resposta original ausente é ORIGINAL_RESULT_UNAVAILABLE, sem reconstrução aproximada. SQL, mapper e demais erros propagam e abortam UOW. |
| `apply(tx, wallet, reference, at, previousRefund)` | WagerTransaction, Wallet, WagerTransaction\|undefined, Date, WagerTransaction\|null → WalletMovementResult\|undefined; privado | WIN usa ledgerDirectionFor; REFUND usa assertRefundAvailable. Traduz REFERENCE_REQUIRED/REFERENCE_NOT_PROCESSED em pendência, INVALID_REFERENCE em rejeição e DUPLICATE_REVERSAL na rejeição homônima. Nenhum desses caminhos movimenta saldo. Referência aprovada passa pelo teto persistível usando Money.add/isLessThan; overflow rejeita DOMAIN_RULE_VIOLATION. Wallet.credit gera ledger/versão, markProcessed grava vínculo interno. Retorna movimento para process persistir. Continua tratando débito BET/saldo insuficiente e LOSS sem movimento como antes. Erros não previstos propagam; não há catch genérico convertendo infraestrutura em regra financeira. |

`previousRefund` não é cache: cada tentativa o lê novamente sob o lock da Wallet. A
aplicação não repete a lista de vínculos nem compara valores da BET por conta própria;
a validação está no domínio. O limite de armazenamento continua usando a regra já
adotada para WIN: 999999999999999999.99, comparação exata, sem float ou arredondamento.
Dinheiro é Money/string; versões, contadores de tentativas e milissegundos são números.

### Referência, duplicidade e resposta histórica

1. A busca usa `(providerId, referenceExternalTransactionId)`. Um ID encontrado só em
   outro provedor é ausente neste namespace, portanto aguarda referência.
2. Se encontrada, o domínio confere BET, player, Wallet, moeda, rodada, valor integral
   e status. BET válida PENDING aguarda; REJECTED/FAILED ou vínculos incompatíveis
   rejeitam com INVALID_REFERENCE. Uma BET PENDING com valor incompatível já é inválida:
   o valor não poderá mudar ao concluir. BET PENDING_REFERENCE é proibida pelo modelo
   existente; a suíte demonstra a incompatibilidade sem relaxar constraints.
3. Só depois dessa validação, REFUND anterior PROCESSED implica DUPLICATE_REVERSAL.
   Uma tentativa rejeitada ou pendente não consome a unicidade de sucesso.
4. O teto do saldo é verificado antes de creditá-lo. Se o prêmio anterior já levou a
   carteira ao máximo, REFUND rejeita DOMAIN_RULE_VIOLATION e preserva esse saldo.
5. A mesma key com mesmo hash retorna a resposta existente; outra key/externalId
   reembolsando a mesma BET cria uma rejeição auditável. Troca do payload sob a key
   anterior é conflito, sem novo registro financeiro. O hash inclui a referência.

Exemplo: REFUND-A devolve 25.00 e responde 100.00. REFUND-B da mesma BET é rejeitado com
saldo 100.00. Outra BET leva a 75.00; replays de A e B ainda retornam 100.00 com os status
originais. Snapshot é a resposta daquela operação, não uma consulta de saldo atual.
O novo evento de rejeição pertence a B; replay de B não produz outro evento.

REFUND recebido antes da BET conserva receipt com saldo/versão observados e um evento
WagerTransactionPendingReference, sem ledger. Quando a BET chegar, redelivery do REFUND
continua retornando o receipt: execute não funciona como worker. O futuro reprocessador
precisará travar admissão/Wallet, reler referência e reembolso anterior, aplicar domínio
e gravar resultado terminal/eventos na mesma UOW. Depois disso o replay lê o snapshot
terminal, enquanto o receipt original permanece imutável. Um teste faz essa composição
manualmente para provar compatibilidade; agendamento, seleção e política de tentativas
ficam pendentes para a etapa do worker.

### Testes funcionais: 29 cenários PostgreSQL

Arquivo `infra/test/refund-functional.test.ts`. Todos os callbacks são chamados pelo
Bun test e retornam Promise<void>; recebem o parâmetro de test.each quando indicado,
abrem withRefundDatabase e propagam erros/expect. Dependem dos helpers reais de
abertura/processamento, wagerState (todas as tabelas) e assertReconciled (saldo/ledger).
Cada cenário final reconcilia; nenhuma resposta financeira é substituída por mock.

| Teste (prefixo do nome no arquivo) | Parâmetro, lógica e evidência |
|---|---|
| `full REFUND of BET %s` (2) | amount:string com 25.00/0.10; abre 100, debita, reembolsa, compara 100/versão 3, referência interna, CREDIT exato e dois eventos não publicados. UNION dos xmin das cinco tabelas retorna um único ID de transação SQL; replay conserva todas as linhas. |
| `REFUND admission %s` (7) | name:string e patch:Record<string,unknown>; ausência de referência, zero, negativo, teto, carteira inexistente, dono e moeda. Chama entrada inválida, exige throw e estado completo inalterado. Cast WagerInput só constrói entrada hostil em teste. |
| `REFUND reference %s` (13) | scenario:string; ausência/PENDING/REJECTED/FAILED/WIN/LOSS/REFUND/outro jogador e carteira/outra moeda e carteira/rodada/provedor/parcial/excesso. Monta referência com domínio ou SQL quando ainda PENDING; exige pendência ou INVALID_REFERENCE, saldo/versão inalterados, zero ledger, evento único e replay sem escrita. |
| `second REFUND identity` (1) | Sem parâmetros; compara original, rejeição duplicada, nova BET, replays históricos e conflitos por valor/referência/key. Garante que rejeição não tem ledger. |
| `REFUND overflow` (1) | Sem parâmetros; abre no teto, BET de 25.00, WIN 25.00, REFUND 25.00. Rejeita sem movimento/versão adicional, sem arredondar. |
| `REFUND %s replay survives` (2) | scenario:processed\|pending; grava resultado, movimenta depois, fecha ORM de fato e inicializa outro. Novo processador devolve resultado original sem alterar tabelas; finally fecha nova instância. |
| `independent providers` (1) | Sem parâmetros; duas iterações com provider-a/provider-b reutilizam keys externas BET/REFUND. Duas operações válidas, cada uma no namespace correto. |
| `pending REFUND keeps original receipt` (1) | Sem parâmetros; recebe antes da BET, prova replay pendente após chegada e compõe conclusão futura na UOW. Receipt continua versão 1, resultado terminal versão 3 e replay PROCESSED. |
| `BET cannot be PENDING_REFERENCE` (1) | Sem parâmetros; insertTransaction tenta formato proibido por SQL, expectSqlState exige 23514; saldo reconciliado. |

Callbacks internos relevantes: `unit.run(async repos => ...)` no caso FAILED carrega
BET PENDING, chama fail e grava snapshot da falha; no caso do worker simulado trava,
valida, credita, grava lifecycle/ledger/dois eventos e resultado. Recebem repositórios
transacionais, retornam Promise<void>, propagam erros para rollback. Os callbacks
map/every dos eventos recebem linhas tipadas e retornam nome/boolean; não fazem I/O.
Os laços de patches e provedores usam dados fixos, sem IDs aleatórios ocultando falhas.

### Falhas e fronteira de commit: 15 cenários PostgreSQL

Arquivo `infra/test/refund-rollback.test.ts`. Mesmos contratos de callbacks/helpers;
a injeção ocorre em PostgreSQL real ou no limite externo da UOW, sem remover constraints.

| Teste/auxiliar | Parâmetros, fluxo, retorno, erros e propósito |
|---|---|
| `failures` e callback map | readonly [string,string][]; lista cinco tabelas para PROCESSED, três para PENDING e duas para REJECTED. map recebe nome da tabela e retorna tupla. Produz 10 casos, não SQL vindo do usuário. |
| `REFUND %s rolls back...%s` (10) | scenario/table:string; prepara saldo/referência, instala trigger de falha, executa REFUND e exige P0001, uma tentativa e estado idêntico. Remove somente função de teste com CASCADE, repete com objetos novos e comprova sucesso/rejeição/pendência esperada. |
| `fail_refund_write(): trigger` | Sem argumentos explícitos, BEFORE INSERT ou UPDATE da tabela escolhida; lança P0001, nunca retorna linha. Na Outbox de sucesso só falha no segundo evento WalletBalanceChanged, provando rollback inclusive do primeiro. Criada/removida exclusivamente no descartável. |
| `counted.run(work)` | FinancialUnitOfWork.run genérico; incrementa attempts e delega work à UOW real, preservando retorno/erro. Demonstra que P0001 não é retry financeiro. |
| `REFUND %s waits for deferred commit` (3) | scenario:PROCESSED\|PENDING\|REJECTED. Wrapper corrupt.run primeiro executa work, depois credita 0.01 sem ledger e salva; gate pausa antes do commit. Outra sessão vê estado anterior e promise ainda não respondeu. Liberação causa 23514, estado inteiro reverte. Tentar inserir Wallet escapada na nova UOW falha por ownership; nova execução normal funciona. |
| `corrupt.run(work)` e callbacks then | run recebe callback transacional e devolve seu resultado só após UOW real; guarda Wallet suja para teste de não reutilização. then marca returned=true apenas no sucesso, handler de erro devolve unknown para inspeção. finally libera barreira mesmo se assertion falhar. Não são implementações alternativas de UOW. |
| `REFUND retries a full fresh transaction` (1) | Sem parâmetros; instala sequência/triggers, primeira gravação de resultado lança 40001, segunda passa. Confere sequence=2, uma transação REFUND e versão 3, com reconciliação. Testa tradução/retry de SQLSTATE gerado pelo servidor; não simula detecção real de deadlock pelo PostgreSQL. |
| `retry_refund(): trigger` | BEFORE INSERT do resultado, nextval(refund_attempts)<2 lança 40001, caso contrário RETURN NEW. Sequência não reverte com rollback, permitindo falhar só uma vez; papel app recebe USAGE/SELECT apenas no descartável. |
| `REFUND processInTransaction participates` (1) | UOW externa recebe repos, processa REFUND e lança Error antes do commit. Resultado era provisório; estado integral é restaurado. Demonstra obrigação de aguardar o commit do dono da fronteira. |

Os erros SQL inesperados são propagados. Não tratamos toda violação UNIQUE como
DUPLICATE_REVERSAL; só a decisão explícita de domínio vira essa rejeição. O retry
transitório começa do zero, relê referência e saldo e não reutiliza objetos mutados.
Validação deste incremento: 44 testes funcionais/rollback, mais 4 de persistência,
494 testes de ./test, typecheck/build e regressões de 40 BET / 62 WIN-LOSS aprovados sem falhas.

## 37. Concorrência de REFUND e evidência final da etapa

A carteira é a fronteira de serialização do saldo. Duas identidades REFUND diferentes
podem passar pelos locks de admissão simultaneamente, mas apenas uma segura o lock
`FOR NO KEY UPDATE` daquela Wallet. A segunda aguarda e, depois, lê novamente o banco:
se a primeira confirmou, encontra o REFUND anterior e grava rejeição; se reverteu,
pode processar. Uma carteira diferente continua avançando. Não há mutex global em
memória nem dependência de FIFO para essa garantia.

O índice parcial existente `wager_successful_reversal_unique` aplica unicidade de
`(reference_transaction_id, kind)` somente a linhas PROCESSED REFUND/ROLLBACK.
Tentativas rejeitadas/pendentes podem coexistir. A checagem UNIQUE do PostgreSQL
aguarda uma inserção concorrente ainda não confirmada antes de decidir conflito;
a suíte observa esse bloqueio e depois o erro 23505 pelo nome exato da constraint.
Ver [documentação de unicidade](https://www.postgresql.org/docs/17/index-unique-checks.html)
e [índices parciais](https://www.postgresql.org/docs/17/indexes-partial.html).

Ler a referência depois da Wallet evita decidir com saldo anterior à BET concorrente
que está sendo concluída pelo mesmo protocolo. Não adicionamos lock de identidade da
referência depois do lock da Wallet, pois isso poderia criar uma ordem circular.
SELECT usa a visibilidade confirmada do READ COMMITTED; se uma BET só foi inserida
PENDING em outra sessão e ainda não está visível, o REFUND fica pendente e não força
espera por aquela identidade. A disponibilidade de saldo não é deduzida de eventos.

### Nove testes de concorrência e seus callbacks

Arquivo `infra/test/refund-concurrency.test.ts`. Bun chama cada teste async com os
parâmetros listados; retorno Promise<void>, erros de SQL/assertion/timeout propagados.
Usa withRefundDatabase, processor/creator, UOWs reais, Money no domínio e SELECTs em
outra conexão para observar resultados. Todos terminam com assertReconciled. As
barreiras gate/bounded/observeWait de `bet-support.ts` são reutilizadas sem alteração.

| Teste (prefixo) | Parâmetros, sequência e resultado observado |
|---|---|
| `two distinct REFUNDs...first %s` (2) | outcome:commit\|rollback. Primeiro REFUND pausa antes do commit; segundo usa outra instância ORM, outra identidade e aguarda lock observado pelo servidor. WIN de outra Wallet termina ainda com a primeira bloqueada. Após commit, segundo é DUPLICATE_REVERSAL; após rollback, segundo é PROCESSED. Em ambos: um crédito REFUND, saldo 100.00/versão 3. |
| `REFUND and concurrent %s` (2) | kind:WIN\|BET. Pausa REFUND, outra sessão tenta movimento e observamos sua espera na Wallet. Após liberação, WIN leva a 140.50 ou BET a 75.00, sempre versão 4 e ledger reconciliado. |
| `REFUND racing BET arrival...%s` (2) | outcome:commit\|rollback. BET segura a carteira antes do commit; REFUND aguarda. BET confirmada permite REFUND processado com saldo 100.00/versão 3; BET revertida deixa REFUND pendente com 100.00/versão 1. |
| `REFUND does not acquire a circular reference lock` (1) | Sem parâmetros. Outra conexão insere BET PENDING e mantém transação aberta. REFUND conclui como pendente antes de liberá-la. Após commit da BET PENDING, replay preserva receipt, só existe ledger de abertura. Demonstra ausência de espera circular nessa janela. |
| `unique reversal index blocks concurrent direct SQL bypass` (1) | Sem parâmetros. Primeiro REFUND pronto pausa antes do commit. Outra sessão tenta INSERT PROCESSED diretamente, com mesma referência e identidade nova, omitindo validação local. pg_stat_activity/pg_blocking_pids comprovam bloqueio do INSERT; primeiro confirma; segundo recebe 23505/wager_successful_reversal_unique. Uma linha REFUND e saldo 100.00/versão 3. |
| `50 identical REFUNDs in three Bun processes` (1) | Sem parâmetros. Processo pai segura Wallet, inicia três Bun filhos com 17/17/16 chamadas e observa três application_names bloqueados no PostgreSQL. Libera; três PIDs distintos retornam 50 respostas: 1 processamento e 49 replays. Um transactionId, saldo 100.00/versão 3, um ledger, um snapshot e dois eventos Outbox. |

Detalhamento das funções internas criadas nesses testes:

- `paused.run(work)` implementa a assinatura genérica FinancialUnitOfWork.run no
  wrapper local de cada cenário. Recebe o callback e o executa nos repos da UOW real;
  abre held, aguarda release e retorna o resultado, ou lança Error quando outcome é
  rollback. Quem o utiliza é ProcessWagerTransaction.execute. A transação real só
  confirma depois do retorno; finally dos testes libera barreiras e fecha ORM.
- O callback `app.begin(async connection => ...)` do PENDING recebe SQL transacional,
  chama insertTransaction e aguarda release; retorna Promise<void>. O callback do
  bypass recebe a mesma interface e retorna a promise de INSERT. Não concede novas
  permissões nem desabilita triggers; erros SQL chegam ao handler para assertions.
- Handlers `.catch((error:unknown) => error)` capturam resultados de promises iniciadas
  em paralelo para inspecionar erro esperado sem rejeição não tratada. Não transformam
  erros em sucesso financeiro na aplicação; o teste exige tipo/código/constraint.
- O callback `unit.run(async repos => ...)` chamado blocker no multiprocesso trava
  Wallet, sinaliza held e aguarda release, retornando void. Serve apenas para garantir
  sobreposição observável; não altera saldo. Recebe FinancialRepositories reais.
- `[17,17,16].map((count,index) => ...)` recebe números de chamadas/índice, monta URL
  do descartável com application_name e chama Bun.spawn com bet-worker.ts já existente.
  Retorna Subprocess com stdout/stderr em pipe. DWP_BET_DB/COUNT/INPUT são configuração
  de fixture, não consumer de produção; o worker recusa bancos fora do prefixo de teste.
- O laço observador consulta pg_stat_activity e pg_blocking_pids por banco/nome até ver
  três conexões esperando Lock com bloqueador real. Há deadline de 6 s e polling de 10 ms;
  o tempo decorrido não é evidência de bloqueio. bounded limita operações a 8 s; timeout
  falha o teste, não tenta corrigir estado financeiro.
- `children.map(async child => ...)` drena stdout/stderr e aguarda exitCode em paralelo,
  exige stderr vazio e saída 0, parseia JSON `{pid:number,results:WagerResult[]}`. Retorna
  relatórios; JSON inválido/filho com erro falha o teste. map/flatMap/filter seguintes
  extraem PIDs, respostas e flags, sem efeitos. Dinheiro continua string nos DTOs.
- `finally` libera blocker e encerra somente filhos ainda vivos, aguardando suas
  saídas com Promise.allSettled. A limpeza dos bancos cabe ao helper externo. Não há
  sleep arbitrário usado como substituto da observação de locks.

### Comandos executados e resultados reais

Ambiente local: Bun 1.4.3, PostgreSQL 17 em Docker e LocalStack Community 4.14.0 fixado.
PATH incluiu `.tools/node_modules/.bin`; DATABASE_URL apontou para o usuário local
restrito `wager_app` em 127.0.0.1:55432/wagering. Helpers criam seus próprios bancos
`dwp_test_*` e aplicam migrations apenas neles. As suites de infraestrutura rodaram
por último, após todas as conexões financeiras fecharem, pois reiniciam os serviços.

| Comando | Testes distintos aprovados |
|---|---:|
| `bun run check` |494; também typecheck e build sem erros |
| `bun run test:financial` |34 |
| `bun run test:persistence` |15 |
| `bun run test:messaging` |14 |
| `bun run test:wallet-creation` |25 |
| `bun run test:bet` |40 |
| `bun run test:wager` |62 |
| `bun run test:refund` |57 |
| `bun run test:orm` |2 |
| `bun run test:migrations` |2 |
| `bun run test:infra` |6 (2 PostgreSQL + 4 SQS) |
| **Total, sem contar reexecuções** |**751**, zero falhas |

A etapa adicionou 73 testes distintos sobre os 678 anteriores: 16 unitários e 57 PostgreSQL
(4 persistência, 29 funcionais, 15 rollback, 9 concorrência). Saídas reais representativas:

```text
bun run test:refund
 57 pass
 0 fail
 389 expect() calls
Ran 57 tests across 4 files. [20.41s]

bun run check
 494 pass
 0 fail
 2584 expect() calls
Ran 494 tests across 14 files. [423.00ms]
$ bun x --bun --no-install tsc -p tsconfig.build.json
```

SQS real emulado aprovou envio, invisibilidade/redelivery, exclusão, DLQ após cinco
entregas e reprovisionamento após restart/recriação. PostgreSQL aprovou consultas
com papel restrito e persistência após restart/recriação. Esses testes validam a
infraestrutura existente; REFUND ainda não passa por transporte HTTP ou SQS.

Inspeção final read-only executada dentro do container PostgreSQL:

```sql
SELECT count(*) AS public_tables
FROM information_schema.tables WHERE table_schema='public';
-- wagering: 0
SELECT count(*) AS disposable_databases
FROM pg_database WHERE datname LIKE 'dwp_test_%';
-- 0
```

`docker compose ps` mostrou os dois serviços healthy. Nenhuma migration financeira
foi aplicada ao principal e seu volume foi preservado. Os testes de falhas e reversão
usaram exclusivamente bancos descartáveis; não apagaram ledger de banco principal.

### Limites e próxima etapa

As evidências cobrem as disputas descritas, sem alegar ausência universal de deadlocks.
O protocolo deve ser seguido por futuros writers; UNIQUE ainda impede duplicidade
se um writer o contornar, mas pode resultar em erro SQL/rollback em vez de rejeição
persistida. O teste 40001 é uma falha SQL injetada, não um deadlock real do detector.
BET PENDING_REFERENCE é incompatível com o contrato existente; BET PENDING foi testada.
Down 00007 é reversível sem respostas REFUND novas e recusa downgrade destrutivo quando
elas existem. Canonicalização BET/WIN/LOSS, Money, DTO v1 e índice por tipo preservados.

A próxima etapa sugerida é ROLLBACK, somente após autorização e decisão explícita sobre
sua interação com REFUND. O índice por referência/tipo não impede ambos sobre a mesma
BET. Não foram implementados ROLLBACK, HTTP, consumer, publisher, worker de referências
ou autenticação. Etapa REFUND encerrada com commits locais; nenhum push.

## 38. ROLLBACK e proteção cruzada de compensações

`prepareWager` agora admite ROLLBACK positivo, integral e com referência obrigatória.
`WagerTransaction.assertReversalAvailable(reference,previous):void` valida mutabilidade,
kind de reversão, referência pelo método de domínio existente e evidência persistida
anterior. Retorna void se disponível; lança INVALID_KIND, erros de referência,
DUPLICATE_REVERSAL ou TypeError para evidência malformada. Chamador: apply do processador.
`assertRefundAvailable` preserva a API anterior e delega após verificar kind REFUND.

`MikroWagerTransactionRepository.findProcessedReversal(referenceId:string)` retorna
Promise<WagerTransaction|null> com SELECT parametrizado por ID interno e kinds
REFUND/ROLLBACK PROCESSED. Usa sessão/mapper existentes; erros SQL propagam. A aplicação
chama após lock da Wallet; não é prova isolada de ausência de corridas.

`ProcessWagerTransaction.apply` usa ledgerDirectionFor para escolher debit/credit:
ROLLBACK(BET) credita, ROLLBACK(WIN/REFUND) debita. Verifica teto somente no crédito;
WalletError de falta de fundos vira REVERSAL_INSUFFICIENT_FUNDS para ROLLBACK. Caminhos
de pendência, rejeição, eventos e snapshot são compartilhados. `process` consulta
findProcessedReversal para os dois kinds. `WagerResultMapper.read` aceita o novo código
já existente no domínio/schema. Não há mudança em Money nem conversão monetária numérica.

Migration20261023000008.up/down são chamadas pelo migrator, sem parâmetros, retornam
Promise<void>. Up adiciona índice parcial único e amplia check_wager_pending_receipt,
check_wager_result e require_bet_result para ROLLBACK (mesmos contratos da seção35).
Down recusa55000 com resultados novos e restaura SQL anterior; duplicidade histórica
faz up falhar23505 sem apagar dados. DDL é transacional. Alternativas e sequências
financeiras constam da ADR-027. Exemplo:100 → BET25 →75 → REFUND25 →100; ROLLBACK(BET)
é rejeitado. ROLLBACK(REFUND) pode debitar25; isso não reabre a compensação da BET.

`infra/test/operational-support.ts::withOperationalDatabase(run)` recebe callback
(db:BetDatabase)=>Promise<void>, cria banco descartável, aplica migrations e ORM app,
executa callback e fecha recursos em finally. Retorna Promise<void>, propaga erros.
`infra/test/rollback.test.ts`: callbacks Bun test.each recebem kind/cenário e exercitam
os três alvos, insuficiência em dois débitos, sete sequências da política, referência
pendente/inválida/parcial e overflow. Testes sem parâmetros verificam migration
up/down/reaplicação, recusa de downgrade, rollback em falha real de ledger e disputa
REFUND/ROLLBACK em dois processos Bun independentes. Todos retornam Promise<void> e
reconciliam saldo/ledger. Fixtures existentes não foram substituídas por mocks.
O callback blocker segura Wallet até observar dois application_names esperando Lock
no PostgreSQL; filhos usam bet-worker.ts real, stdio é drenado e PIDs distintos são
verificados. Finally libera barreira/encerra filhos. Trigger fail_rollback() lança
P0001 no INSERT de ledger para provar rollback de todas as tabelas. Apenas no descartável.

Evidência fase1: `bun run check` aprovou494testes, typecheck e build; rollback14,
refund57, bet40 e wager62 aprovaram em PostgreSQL real. Total executado neste incremento:
667testes distintos, zero falhas. Dois testes inicialmente reutilizaram a key da BET
na fixture WIN; corrigida a identidade da fixture, mantendo a detecção de conflito.
`bun run test:rollback` reproduz os14cenários novos.

## 39. Worker de referências pendentes

Uma pendência não é rejeição e não pode depender de uma fila em memória. A migration9
cria agendamento durável no mesmo commit do receipt. Depois que a BET chegar, o worker
recarrega a referência e o saldo atual; não aplica o saldo antigo do comprovante.
Dois workers usam SKIP LOCKED para não executar o mesmo job. O lock cobre apenas SQL;
um crash libera o trabalho sem confirmar efeitos parciais. Sem timer persistente, o
polling pode reiniciar porque next_attempt_at está no PostgreSQL.

| Arquivo / função | Contrato, fluxo, erros e chamadores |
|---|---|
| `Migration20261023000009.up/down` | Sem parâmetros, Promise<void>, chamadas pelo migrator. Up cria tabela/índice/trigger, backfill de pendentes e privilégios restritos; down recusa55000 se há tentativas, remove apenas agendamento ainda reconstruível. Falhas DDL revertem a unidade. |
| SQL `schedule_pending_reference()` | Trigger AFTER INSERT/UPDATE de status recebe NEW, insere job por ID/data somente para PENDING_REFERENCE, ON CONFLICT não sobrescreve tentativas, retorna NEW. SECURITY DEFINER com search_path fixo e nomes qualificados permite agendar sem conceder INSERT direto ao app; EXECUTE público revogado. |
| `PendingReferenceRepository` | Porta claimDue(now:Date), reschedule(id:string,next:Date), complete(id:string,now:Date); retornos Promise<Job|null>/Promise<void>. Job contém ID, attempts:number e createdAt:Date; não contém dinheiro. |
| `MikroPendingReferenceRepository.constructor/claimDue` | Recebe FinancialSession; SELECT ordena data/ID, limita1 e trava job com SKIP LOCKED; retorna objeto ou null e registra ID reivindicado nesta sessão. Chamado por ResolvePendingReferences. Segundo claim na mesma unidade lança Error. |
| `reschedule/complete/assertClaim` | Exigem ID reivindicado; atualizam attempts+1 e próxima data ou completed_at. assertClaim retorna void/lança Error para ID indevido; erros SQL propagam. A transação externa é responsável pelo commit. |
| `ProcessWagerTransaction.resumeInTransaction(id,repos,expire)` | Promise<WagerResult|null>. Carrega identidade, trava admissão, relê status, retorna histórico se já terminal; trava Wallet e delega settle. Falta de registros/estado indevido lança Error e aborta job. Chamador exclusivo: worker sob claim. |
| `settle(tx,wallet,repos,at,resuming=false,expire=false)` | Extração do caminho já testado, Promise<WagerResult|null>. Resolve referência/compensação, aplica domínio, persiste lifecycle/movimento/eventos/resultado. Espera repetida retorna null sem recriar receipt/evento. Se expire e continua sem dependência, rejeita REFERENCE_NOT_FOUND. Chamado por process e resumeInTransaction. |
| `apply` | Ao aguardar referência, chama markPendingReference só quando ainda PENDING. Reidratação de PENDING_REFERENCE não repete essa transição. Crédito/débito e regras continuam os mesmos. |
| `ResolvePendingReferences.constructor` | unit/process/Clock/policy; exige inteiros positivos, maxAttempts<=1000000 e maxDelay>=initialDelay. Inválidos lançam Error no startup. Não acessa banco. |
| `runOne()` | Promise<boolean>, true se pegou job, false se nenhum devido. Uma UOW faz claim, calcula limite, chama resume; terminal completa job, pendente agenda min(maxDelay,initialDelay*2^attempts). Falha reverte tudo, inclusive attempts. Chamador: runtime e testes. |
| `positiveInteger(env,name,fallback,maximum)` | worker-configuration.ts; valida texto inteiro positivo, converte contagem/tempo (nunca dinheiro), retorna number ou Error sem revelar valor recebido. |
| `referencePolicy(env)` | Retorna ReferenceRetryPolicy com defaults300/24h/1s/5min e overrides explícitos REFERENCE_*. Usada pelo entrypoint; configuração inválida interrompe startup. |
| `runWorker(role,build)` | worker-runtime.ts; abre ORM restrito, valida roleSQL, monta contexto e tarefa, instala SIGINT/SIGTERM, chama runOne até parar. Sem trabalho aguarda250ms; erro loga somente código sanitizado e tenta após1s. Finally fecha tarefa/ORM e remove handlers. Erros de startup propagam. |
| callbacks `stop/build` | stop():void muda flag de admissão; build(WorkerContext):WorkerTask instancia o resolver. runOne corrente termina antes do fechamento. reference-worker.ts é entrypoint Bun; não migra banco. |
| `createRepositories` | Acrescenta pendingReferences à mesma FinancialSession, preservando transação única e as portas existentes. |

`infra/test/pending-reference.test.ts`: nove testes reais. Três test.each(kind) criam
WIN/REFUND/ROLLBACK antes da BET, verificam backoff e conclusão sem apagar receipt.
Três test.each(reason) verificam maxAttempts/TTL/referência terminal inválida e replay.
O teste de dois workers pausa a primeira UOW após processar, comprova SKIP LOCKED e
rollback do agendamento, depois conclui com outra execução. O teste de processo inicia
reference-worker.ts, observa espera no PostgreSQL, envia SIGKILL, reinicia e exige
conclusão e saída0 após SIGTERM. Callbacks spawn/observe/drain só gerenciam processos
de teste; finally encerra filhos. O último injeta40001 no INSERT do resultado, prova
attempts=0 após erro e, sem trigger de falha, rejeita ROLLBACK de WIN por saldo atual
insuficiente. Todos callbacks retornam Promise<void>, propagam assertions/timeouts e
reconciliam saldo com ledger. Nenhum teste modifica o banco principal.

Evidência fase2: check494/typecheck/build, referências9, ROLLBACK14 e regressão de
persistência REFUND4 passaram. O handler catch do entrypoint imprime somente
role/status startup_failed, sem exception/connection string, define exitCode1.

## 40. HTTP real, consultas e reconciliação

A rota traduz transporte; o caso de uso existente decide dinheiro. Criar carteira
com100 e apostar25 produz HTTP200/75.00; reapresentar a key após outro crédito ainda
retorna75.00. O header é fonte de verdade. O correlationId recebido (token até100)
ou gerado volta na resposta; não entra no hash financeiro.

| Arquivo / funções | Responsabilidade, parâmetros, retorno, sequência e erros |
|---|---|
| `transport-validation.ts::objectFields` | unknown, lista permitida/obrigatória → Record. Recusa arrays, campos extras/ausentes; InvalidWagerInputError. Compartilhado com SQS. |
| `token/money/walletInput/wagerInput` | token valida string<=200bytes; money valida campos/limite de tamanho e Money; walletInput retorna CreateWalletInput no teto; wagerInput recebe unknown/key/transporte, valida allowlist e retorna WagerInput normalizado por prepareWager. Erros de contrato/Money antes da UOW. |
| `FinancialController.constructor/open/submit` | Injeta CreateWallet/ProcessWagerTransaction/FinancialQueries. open valida e devolve Promise<CreatedWallet>; submit usa header, aguarda execute e escolhe status pelo resultado. Nenhuma SQL/regra financeira na rota. |
| `wallet/ledger/transaction/external/reconcile` | Recebem params/query, validam IDs/limite e delegam consultas, retornando promises DTO. reconcile usa200. Erros seguem filter central. Chamados pelo roteador Nest nas rotas oficiais. |
| `FinancialQueries.constructor/wallet/transaction` | UOW injetada; ID e provider opcional → DTO de leitura. Repositório retorna null → ResourceNotFoundError. transactionView serializa campos públicos, datas ISO e MoneyProps, sem hash/key. |
| `ledger(walletId,cursor?,limit=50)` | Valida página/cursor1-wallet-version, chama pageByWalletId(limit+1), serializa itens e gera nextCursor ou null. InvalidCursorError em cursor inválido/carteira diferente/limite. Keyset estável sem OFFSET. |
| `MikroLedgerEntryRepository.pageByWalletId` | string,number,number → Promise<readonly PersistedLedgerEntry[]>; SQL parametrizado ordenado numericamente, mapper existente; SQL/mapper propagam. |
| `MikroWagerTransactionRepository.listByWalletId` | string → Promise<readonly WagerTransaction[]>; SELECT por carteira, rehydrate cada linha. Usado na reconciliação; não anexado para escrita. |
| `reconcile(walletId)` | Lock Wallet → ledger/transações → soma créditos menos débitos com Money → verifica cadeia/versão/direção/status/duplicidade/movimento faltante → DTO oficial + issues. ResourceNotFoundError se ausente; SQL propaga. Calcula difference=stored-calculated, pode ser negativa sem violar entrada Money. Não faz UPDATE. |
| `publicError(error)` | unknown → status/code públicos. Mapeia classes de domínio/admissão, códigos SQL de conexão/timeout como503; UNIQUE genérico não vira409. Falhas desconhecidas500. |
| `ApiExceptionFilter.catch` | unknown,ArgumentsHost → void; obtém resposta/request e envia erro sanitizado com correlationId. Não expõe mensagem original nem stack. |
| `ProviderIdentityGuard.canActivate` | boolean true, extensão explícita local para OIDC; não alegamos autenticação. Health fora do guard. |
| `createApplication` | Agora async; monta Nest, registra filter/middleware e devolve app. Callback middleware sanitiza correlationId ou gera UUID, adiciona header e chama next. Startup não aplica migrations. |
| `sqsClient/queueUrl/checkQueue` | Configuração env → SQSClient com timeout/retry; queueUrl(client,name) resolve URL ou Error; checkQueue consulta atributos para comprovar acesso. Promises propagam falhas do SDK; credenciais não são logadas. |
| `HealthController.ready/live` | Injeta ORM. ready consulta SELECT1 e SQS em paralelo e fecha client no finally;200 ready ou503. live retorna ok sem dependências. |

Erros ResourceNotFoundError/InvalidCursorError só fornecem code estável, usados pelo
filter. AppModule injeta FinancialQueries via UOW e registra controllers/guard; SDK
SQS passa a dependency de runtime. Dinheiro nunca usa Number; limit/versão são contadores.

`infra/test/api.test.ts::withApi(run)` abre banco descartável/app em porta efêmera,
restaura env e fecha app no finally. request(url,path,body?,key?) envia HTTP real,
retorna status/header/JSON. payload(walletId,patch) remove key do body de fixture.
Três testes: todas as consultas/abertura/aposta/replay/paginação até versão12 e
reconciliação; matriz de erros/contrato/key/cursor; readiness indisponível sem afetar
live. Callbacks async propagam falhas e usam PostgreSQL/SQS reais. Teste anterior
health.http foi atualizado porque readiness agora existe. check494/typecheck/build e
API3 (54assertions) passaram; enunciado e banco principal preservados.

## 41. Consumidor SQS operacional

`ConsumeWager` (infrastructure/messaging/consume-wager.ts) recebe UOW, processador,
Clock, SQSClient e ConsumerOptions (fila, nome lógico do consumidor, visibilidade,
long poll e retry). `runOne():Promise<boolean>` resolve URL, recebe uma mensagem,
retorna false se vazia; valida envelope/data e calcula SHA256 de type/key/payload
canônico. A callback UOW recebe repos, chama inbox.receive, pula negócio se processada,
senão processInTransaction, markProcessed e save. Ao resolver UOW, executa DeleteMessage
com receipt atual. Resultado true significa mensagem confirmada. Qualquer erro conserva
mensagem e ajusta visibilidade/backoff, depois propaga para runtime. Erros de negócio
persistidos retornam normalmente e recebem ACK; erros de admissão vão para DLQ após
política do broker. `close()` destrói client ao encerrar.

Callback heartbeat serializa ChangeMessageVisibility a cada metade da visibilidade;
clearInterval/await extending precedem ACK/retry. Caso heartbeat falhe, exclusão ainda
é PostgreSQL, não timer. O backoff usa número de recebimentos (contagem, não dinheiro).
ConsumerOptions padrão:30s/longpoll10s/retry1s. `consumer.ts` compõe dependências via
runWorker e sanitiza falhas de startup. O nome lógico wager-processor-v1 é o mesmo em
todas as instâncias: não usar PID como consumerName, pois isso quebraria deduplicação.

Fixtures: `queue-support.ts::withQueues(run)` cria FIFO/DLQ únicas e redrive5, executa
callback e apaga somente suas filas no finally. `send(client,url,body,group?)` usa
dedupId aleatório para provocar duplicatas reais. `receive` recebe até10 por1s.
`consumer-child.ts` valida prefixos descartáveis, abre ORM real e proxy do SDK; callback
send para DeleteMessage sinaliza COMMITTED_BEFORE_ACK e SIGSTOP. Teste envia SIGKILL;
proxy não modifica transação nem dados. Demais chamadas são encaminhadas ao SDK real.

`consumer.test.ts`: envelope(walletId,messageId,patch) constrói contrato oficial.
Cinco callbacks async:10entregas concorrentes com mesma identidade (um débito),
rejeição auditável com ACK; inválida/hash conflitante para DLQ em5recebimentos;
falha40001 antes do commit sem Inbox parcial e redelivery após remover falha; processo
morto depois do commit, outro consumer retoma, mensagem LOSS sentinela comprova
progresso e SIGTERM encerra. Bancos/filas reais isolados, finally fecha filhos/recursos,
assertReconciled em todos. Typecheck e5testes/38assertions aprovados.

## 42. Publisher Outbox com recuperação de lease

`Migration20261023000010.up/down`: cria/remove tabela de claims por evento e permissões
operacionais de INSERT/UPDATE/DELETE. Down lança55000 com claim existente, preservando
trabalho em voo. Não altera payload/evento/dinheiro. `OutboxDispatch.constructor(orm,
leaseMs)` exige inteiro positivo; `claim():Promise<OutboxClaim|null>` abre fork/transaction,
seleciona evento devido sem lease válida, trava SKIP LOCKED, grava UUID/token e prazo
pelo relógio PostgreSQL, mapeia mensagem e confirma. `finish(claim,published):Promise<boolean>`
abre nova transação, exige token/prazo, relê Outbox, chama markPublished ou scheduleRetry,
atualiza lifecycle e remove claim. false significa dono expirado; erros SQL propagam.
Nenhum payload mutável ou dinheiro é calculado pelo publisher.

`PublishOutbox.constructor(dispatch,client,eventQueue,commandQueue)` recusa fila igual.
`runOne()` retorna false se sem evento; caso contrário resolve fila, serializa envelope,
envia com eventId como dedupId e SHA256(walletId) como group. Somente após confirmação
chama finish(true). Erro de envio chama finish(false) e propaga; erro após envio deixa
lease para recuperação, nunca assume publicação confirmada no banco. `close()` fecha
SDK. `publisher.ts` configura lease60s e fila separada, usa runtime com SIGTERM.
`provision.py::main` agora cria/reconcilia também events com ensure_queue e valida
atributos; não apaga mensagens existentes. queues.json declara a topologia extra.

`publisher.test.ts`:3testes reais: duas instâncias disputam duas mensagens sem duplicar
claim; endpoint SQS indisponível grava retry, lease expirada rejeita finish antigo e
novo dono retoma; filho SIGKILL depois do SendMessage confirmado reenvia após lease,
marca publicação e entrega duplicata forçada com eventId idêntico a Inbox downstream
(dois recebimentos/um efeito). `publisher-child.ts` valida banco/fila descartáveis e
proxy send aguarda SDK real antes de SIGSTOP; pai mata o processo. Helpers de fila
existentes fazem isolamento/limpeza. Contagens e saldo reconciliado são assertados,
sem dinheiro alterado pelo publisher. Typecheck e3testes/23assertions aprovados.
