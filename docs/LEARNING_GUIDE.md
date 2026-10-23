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
retry/publicação e proibição de alterar payload ou truncar. Usa app.json(value) no
cliente Bun: JSON.stringify seguido de inferência JSONB duplicava a codificação; o
CHECK rejeitou corretamente o escalar e a fixture foi corrigida. Todos usam PG real.
