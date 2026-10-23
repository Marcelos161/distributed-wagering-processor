# Arquitetura e registro de decisões

## ADR-006 — MikroORM e identidade de aplicação (adotada)

MikroORM/core/postgresql 7.2.5, integração oficial Nest 7.1.0, ESM/NodeNext e Bun
1.4.3. PersistenceModule usa forRootAsync, lê somente DATABASE_URL e registra
providers oficiais. Alternativa de providers/middleware próprios foi descartada
por duplicar lifecycle e RequestContext já fornecidos pela integração.

Lista explícita de entidades vazia; sem schema update/create, ensureDatabase ou
ensureIndexes. allowGlobalContext=false; contexto HTTP oficial por requisição;
operações fora de HTTP usam fork. Pool de até 5 conexões por processo é ponto
inicial, sujeito a dimensionamento quando existirem múltiplos workers.

ApplicationDatabaseCheck verifica papel PostgreSQL real no startup e recusa
superuser/createdb/createrole/bypassrls. Não troca grants nem audita todos os
privilégios indiretos. Aplicação usa wager_app; não lê MIGRATION_DATABASE_URL.
Sem conexão válida, inicialização falha; liveness não consulta banco por request.
Readiness completa continua pendente.

Futuras entidades/mapeadores/repositórios ficam em infrastructure/persistence;
domínio continua sem imports Nest/ORM. Não antecipamos classes base ou repositórios
genéricos. Locks pessimistas futuros usarão EM transacional; ainda não implementados.

Evidência: Nest + SQL real + HTTP, schema vazio e DDL negado para app em banco
descartável; credencial admin recusada. Nenhuma tabela criada no banco principal.

Estado em 22/10/2026: **NestJS, PostgreSQL/SQS, MikroORM, migrations, Money, WalletLedgerEntry, Wallet e WagerTransaction implementados**. Há decisões
aprovadas para etapas futuras e propostas ainda em avaliação; nenhuma delas
representa garantia já entregue. Fonte de requisitos: [README](README.md).
Plano e rastreabilidade: [IMPLEMENTATION_PLAN](docs/IMPLEMENTATION_PLAN.md).

## ADR-001 — Base executável (adotada)

**Problema:** validar a combinação obrigatória Bun, NestJS e TypeScript estrito
antes de acrescentar estado financeiro ou serviços externos.

**Escolha:** Bun 1.4.3 como runtime, gerenciador e test runner; NestJS 12.2.0
com o adaptador Express; TypeScript 5.9.3 com `strict` e verificações adicionais.
Versões diretas exatas e `bun.lock` versionado. TypeScript 5.9.3 é uma escolha
conservadora de compilador para esta base, não uma afirmação de ser a versão mais recente.

**Alternativas:** gerador Nest CLI ou montagem mínima; execução direta do TypeScript
ou JavaScript previamente compilado; Express ou Fastify. Montagem mínima evita um
runner de testes diferente do Bun e scaffolding sem função. Express reduz decisões
iniciais; nenhuma alegação de superioridade de desempenho foi feita.

**Consequências:** `bun run start` executa TS; `bun run typecheck` verifica tipos;
`bun run build` emite JS; `bun run start:built` executa esse JS com Bun. Executar
não substitui checar tipos. Imports internos usam extensão `.js`, resolvida para
os fontes pelo ambiente de desenvolvimento e preservada na saída compilada ESM.
`skipLibCheck` dispensa checagem interna de declarações de terceiros; os fontes e
testes do projeto continuam sujeitos a `strict`.

`createApplication` monta o grafo Nest sem abrir porta; o entrypoint configura e
abre o servidor. Isso permite testes com a aplicação real numa porta efêmera.
Falha de inicialização termina com exit code 1. Hooks de SIGINT/SIGTERM fecham a
aplicação; drenagem e visibilidade de mensagens ainda precisam ser implementadas.

## ADR-002 — Liveness e limite da etapa (adotada)

`GET /health/live` é público e retorna `200 {"status":"ok"}` quando o processo
consegue responder. Nenhum acesso a banco/fila ocorre nessa rota (o startup agora
valida PostgreSQL pela ADR-006). `/health/ready` ainda não
existe (404): a aplicação ainda não implementa probes das dependências.

Alternativa rejeitada: readiness retornando 200 fixo. Isso permitiria encaminhar
apostas a uma instância incapaz de persistir. A readiness real virá com PostgreSQL
e SQS. Os logs de inicialização são JSON; correlação financeira e métricas ainda
não foram entregues.

## Estrutura alvo (pastas futuras criadas apenas quando necessárias)

```text
src/
  main.ts                      # processo, configuração e sinais
  app.module.ts                # composição Nest
  create-application.ts        # fábrica da aplicação HTTP
  domain/
    money/                     # Money e erros de moeda/valor
    wallet/                    # Wallet e ledger
    wagering/                  # transação, estados e regras
    events/                    # eventos e envelope abstrato
  application/
    ports/                     # contratos de persistência, identidade, relógio etc.
    use-cases/                 # operações usadas por HTTP e SQS
  infrastructure/
    config/                    # configuração validada
    http/                      # controllers, DTOs e mapeamento de erros
    persistence/               # MikroORM, mapeadores, migrations, transações
    messaging/                 # cliente SQS e adaptadores
    workers/                   # inbox, outbox e referências pendentes
    observability/             # logs e métricas
test/
  integration/                 # PostgreSQL + emulador SQS reais
  concurrency/                 # processos distintos e injeção de falhas
docs/
```

O domínio não importa NestJS nem ORM. Aplicação coordena regras e persistência
através de contratos; infraestrutura implementa esses contratos. HTTP e SQS
chamam o mesmo caso de uso. Não se criam interfaces para cada classe sem necessidade.

## ADR-003 — ORM, emulador e concorrência (aprovada; locks pendentes)

Em 21/10/2026, o usuário aprovou explicitamente a recomendação: **MikroORM,
LocalStack e lock pessimista por carteira no PostgreSQL**.

MikroORM será o ORM; LocalStack emulará SQS no ambiente Compose. O processamento
financeiro adquirirá lock na linha da wallet dentro da transação SQL. Operações
da mesma carteira serão serializadas; carteiras distintas poderão avançar em
paralelo. Isso simplifica a proteção contra disputa de saldo, com o custo de
espera em carteiras muito concorridas. Não haverá lock global de todas as wallets.

TypeORM, MiniStack e locking otimista foram considerados como alternativas. Os
trade-offs estão na tabela abaixo. A aprovação define a direção, mas não substitui
os testes de integração, concorrência e recuperação exigidos pelo README.

## Decisões para as próximas etapas

As três escolhas da ADR-003 estão aprovadas. Os demais temas da tabela continuam
como propostas; detalhes de schema, versões, mapeamento e retries serão definidos
nas etapas correspondentes.

| Tema | Recomendação | Alternativas e trade-offs |
|---|---|---|
| ORM (aprovado) | MikroORM; proposta de entidades de persistência separadas do domínio | TypeORM é aceito; separar mapeamento exige código adicional, mas mantém domínio independente |
| Emulador (aprovado) | LocalStack em Compose | MiniStack é permitido; verificar disponibilidade/licença e imagem antes de fixar versão |
| Dinheiro (adotado na ADR-008) | decimal.js encapsulado; precisão por operação e strings com escala 2 | Substitui a proposta de bigint em centavos, seguindo o pedido do usuário. Limite e mapeamento PostgreSQL NUMERIC(p,2) serão definidos antes do schema |
| Concorrência (aprovada) | Lock pessimista na linha da wallet durante a transação SQL | Lock otimista precisa retries; UPDATE condicionado também protege saldo, mas exige coordenar resultado, ledger e reversões. Lock por wallet simplifica raciocínio e limita vazão de uma carteira muito disputada |
| Idempotência | Unicidade persistente da key e de `(providerId, externalTransactionId)`; hash canônico e snapshot do resultado | Cache e deduplicação FIFO não sobrevivem como garantia suficiente. Resolver colisão com a linha persistida sem duplicar efeito; definir escopo exato da key |
| Inbox | `(consumerName, messageId)` único, hash do conteúdo e processamento atômico | Inbox sozinha não identifica uma mesma transação enviada com outro messageId; a idempotência de negócio continua necessária |
| Outbox | Evento salvo junto ao efeito; publishers reivindicam lotes com exclusão mútua no PostgreSQL e recuperação de posse | `SKIP LOCKED` com lease reduz bloqueio durante I/O; manter lock durante publicação é mais simples, mas segura transação durante rede. Escolha final e timeout exigem teste de crash |
| Referências | Worker agendado persistente com backoff limitado e rejeição auditável após TTL/tentativas | Apenas esperar nova mensagem não garante reprocessamento. TTL e número de tentativas ainda não definidos |
| Autenticação | Adiar IdP e adicionar porta de identidade antes dos endpoints financeiros | Keycloak/Zitadel OIDC são opções; omissão é aceita no README. Health público; fila confiável não elimina validação do provider |

### Garantias que o schema deverá proteger

- `UNIQUE(player_id, currency)` e saldo `CHECK >= 0`.
- Unicidade de idempotência e identidade externa; no máximo um ledger por
  `(transaction_id, wallet_id)`; reversão única por referência e tipo.
- Coerência aritmética do ledger, moeda/referências e integridade referencial.
- Imutabilidade do ledger por privilégios e proteção SQL contra UPDATE/DELETE
  (avaliar também TRUNCATE e papel efetivamente usado pela aplicação).
- Atomicidade wallet + transação + ledger + inbox (se SQS) + outbox.
- A correspondência entre alteração de saldo e ledger é uma invariante entre
  tabelas: um simples CHECK de linha não basta. Avaliar trigger de constraint
  diferida ou caminho de escrita controlado, e testar SQL direto com o papel da app.

Migrations serão versionadas e reversíveis. Reverter schema com dados financeiros
é operação destrutiva potencial: a demonstração de reversibilidade será em banco
descartável, sem prometer reversão segura de dados reais.

## Interpretações que precisam ser fechadas antes do módulo financeiro

1. A regra explícita 7.4 permite unicidade **por tipo** de reversão. Não impor
   silenciosamente proibição conjunta de REFUND e ROLLBACK da mesma BET.
2. Política local de referências fechada na ADR-011: WIN opcional validada como BET;
   dependentes aguardam referências não processadas. Falta implementar resolução,
   backoff/TTL persistidos e tratamento operacional das referências terminais inválidas.
3. Política de quantias aprovada na ADR-011: LOSS zero; demais kinds positivos.
   Abertura de Wallet zero continua válida e não gera OPENING.
4. Escala de Money fechada nesta etapa: `"25"`/`"25.0"` são rejeitados; exigimos
   exatamente duas casas, conforme o pedido. Zeros à esquerda são normalizados
   na saída; a futura definição de hash canônico deverá considerar essa representação.
5. Estados terminais não mudam. Especificar snapshot de replay, respostas pendentes
   e falhas permanentes sem marcar uma falha transitória como terminal.
6. Destino dos eventos Outbox, ordenação por agregado e política de retries precisam
   de decisão explícita; o README não nomeia uma fila de saída.

## Limitações atuais

Money, WalletLedgerEntry, Wallet e WagerTransaction possuem invariantes locais testadas. Wallet
produz lançamentos em memória para cada mudança de saldo aceita; não há garantia
persistente entre entidades nesta etapa.
Não existem ledger persistido, processamento, migrations de schema financeiro, idempotência, autenticação,
reconciliação, métricas ou testes distribuídos. As garantias financeiras entre
entidades continuam pendentes. Os testes reais de infraestrutura provam conexão, configuração,
mensageria, persistência PostgreSQL e rollback de migrations/transações de prova;
não provam atomicidade financeira entre wallet, ledger, inbox e outbox.

## ADR-010 — Wallet, abertura com lançamento e confirmação local do estado

**Contrato aprovado pelo usuário em 22/10/2026:** Wallet.open retorna
{wallet,openingEntry}. Abertura positiva exige IDs de ledger/transação e retorna
um CREDIT de zero até o saldo inicial; zero retorna null e recusa contexto de
movimento desnecessário. O outro caminho considerado foi retornar só Wallet e
deixar a geração do ledger no caso de uso. O par mantém o requisito de histórico
explícito já na criação do domínio. Não cria/simula WagerTransaction OPENING.
Version inicia em 1 em ambos os casos: open não chama credit.

O futuro caso de uso reservará IDs, criará OPENING com o mesmo transactionId do
lançamento, e persistirá Wallet+OPENING+ledger em uma única transação. Zero não
gera OPENING/ledger. Banco deverá assegurar a correspondência entre alteração
de saldo e entrada financeira, inclusive abertura, além de UNIQUE(player_id,currency),
CHECK saldo >= 0, FK, equação e unicidade do ledger. O desenho concreto de constraint
diferida/escrita SQL controlada será decidido na persistência e testado por SQL
direto. A existência de um objeto resultado não impede seu descarte pelo chamador.

Wallet é Entity/Aggregate Root: identidade/moeda são fixas, saldo/version/updatedAt
mudam somente por debit/credit. Money e WalletLedgerEntry permanecem inalterados.
Inputs de movimento incluem Money, IDs de ledger/transação e Date fornecido;
retorno {entry,walletVersion} guarda a versão correspondente àquela entrada.
Não há lista de ledger em memória, bus de eventos, repository ou interface genérica.

O helper privado valida objeto, Money, moeda, positividade, data, capacidade de
incremento de version e saldo suficiente em débito; calcula o novo Money; cria
ledger real; prepara snapshot e resultado; só então substitui #state uma vez.
Nenhuma validação/alocação/callback/I/O ocorre depois dessa troca. Alternativa de
mutar saldo/versão/data separadamente e tentar desfazer ao capturar erros foi
descartada: preparar tudo antes simplifica a garantia local e seus testes.
O estado permanece igual quando a factory de ledger falha, comprovado com IDs
inválidos reais, sem mocks. Insuficiência lança WalletError/INSUFFICIENT_FUNDS.

Superfície pública congelada; campos privados permitem transições controladas.
Balance retorna Money imutável; createdAt/updatedAt devolvem Date novos a partir
de instantes privados. Datas são fornecidas pelo chamador e apenas validadas como
instantes finitos, seguindo a política do ledger: não garantem monotonicidade ou
ordem causal. updatedAt reflete o último movimento aceito, mesmo se relógio recuar.
IDs mantêm política opaca sem whitespace/controles, sem impor UUID ou gerar valores.
Version é inteiro positivo seguro; MAX_SAFE_INTEGER impede novo movimento antes
de qualquer alteração. Esses números são metadados, nunca quantias financeiras.

Rehydrate reconstrói estado com checks estruturais, sem abrir carteira, emitir
lançamento ou exigir OPENING. É fronteira confiável da futura persistência, não
factory para aceitar financiamento externo. Preserva version e datas recebidas.
Nenhuma consulta de unicidade ou idempotência em memória é introduzida.

### Limite da atomicidade e concorrência

As garantias desta etapa são locais à chamada síncrona. Uma falha SQL posterior
não desfaz Wallet JavaScript já alterada: o caso de uso deve descartar a instância
e recarregar após rollback antes de retry. A transação PostgreSQL protegerá os
registros persistidos, incluindo ledger/transação/inbox/outbox quando existirem.

Duas cópias de Wallet no mesmo saldo/version podem aceitar o mesmo débito: o teste
local demonstra esse limite, sem alegar teste distribuído. Version sozinha não
faz lock nem UPDATE condicional. O lock pessimista aprovado será adquirido na
linha da wallet dentro da transação antes de decidir saldo; não foi implementado.
Constraints, lock e idempotência persistente continuarão necessários.
A máquina de estados WagerTransaction foi entregue na ADR-011; processamento de BET/WIN/LOSS continua futuro.

Referências: [transações PostgreSQL](https://www.postgresql.org/docs/17/tutorial-transactions.html),
[locks por linha](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS).

## ADR-009 — Lançamento imutável, criação validada e reconstrução de estado

Implementado WalletLedgerEntry em domain/wallet, sem Wallet ou dependência Nest/ORM.
Reutiliza Money inalterado. Enum LedgerDirection.Debit/Credit tem valores DEBIT/CREDIT,
conforme o esqueleto. Estado contém IDs, direção, três Money e createdAt. Interfaces
readonly e alias CreateLedgerEntryProps evitam duplicação de formatos idênticos.

create exige objeto, IDs string não vazios sem whitespace/controles ASCII, direção
conhecida, Date válido, instâncias Money, mesma moeda, movimento > 0 e saldos >= 0;
depois valida before ± money = after. Não gera IDs/tempo, não arredonda e não corrige
saldo. IDs opacos preservam a assinatura string sem impor UUID não exigido no README.
Unicidade/existência das referências não são verificáveis neste modelo isolado.

rehydrate preserva estado e faz as mesmas verificações estruturais, incluindo
sinais/moeda, mas não chama create nem recalcula a equação. Assim não repete a
transição; isBalanced pode detectar divergência histórica sem corrigir dados.
Foi descartado delegar rehydrate a create, pois repetiria essa validação. Também
não aceitamos estrutura arbitrária sem validar tipos/invariantes permanentes.
Uma divergência aritmética reidratada não autoriza nova gravação: o futuro mapeador
será fronteira confiável e o banco também exigirá equação consistente. Não existe
verificação de origem confiável em um objeto TypeScript por si só.

Imutabilidade: campos readonly, Object.freeze, Money imutável compartilhado e
instante privado em milissegundos. createdAt é getter que devolve Date novo;
Object.freeze aplicado apenas a Date não bloquearia métodos mutadores. Mantemos
a API Date do README sem criar abstração temporal adicional. O number privado
representa tempo, nunca dinheiro. Token Symbol não exportado protege construtor
também em runtime. Nenhum setter, método de transição ou efeito colateral externo.

LedgerEntryError fornece códigos locais, sem hierarquia genérica nem HTTP.
isBalanced usa somente add/subtract/equals de Money e retorna boolean; não compara
float, não tolera diferenças e não garante a continuidade entre linhas de histórico.

### Requisitos de persistência futura — ainda não implementados

- PK(id), NOT NULL nos campos e UNIQUE(transaction_id, wallet_id). Não duplicar
  o índice que a constraint única já fornecerá.
- FKs para wallet e transação, preservando histórico sem CASCADE de exclusão;
  verificar pertencimento da transação à wallet e igualdade de moeda, possivelmente
  com referências compostas, a definir no desenho do schema.
- Valores exatos/FINITOS, movimento > 0, saldos >= 0, direção DEBIT/CREDIT e CHECK
  da equação na própria linha. Definir precisão NUMERIC e rejeição de entradas com
  escala excessiva antes de qualquer coerção/arredondamento do banco. Moeda única
  por linha pode representar os três Money; precisa corresponder às referências.
- Índice (wallet_id, created_at, id) proposto para extrato paginado com desempate.
  Timestamp/id não provam ordem causal: sequência/version da Wallet será decidida
  junto à persistência. Não prometemos ordenação por commit com esse índice.
- Impedir UPDATE/DELETE/TRUNCATE do ledger com privilégios e proteção SQL a testar,
  inclusive caminhos indiretos e papel real da aplicação, que não será dono/admin.
- Escrita de saldo + ledger + transação/inbox/outbox em mesma transação PostgreSQL,
  com lock por wallet aprovado. Verificar correspondência entre mudanças e entradas,
  continuidade de saldo e ausência de lançamentos para LOSS/rejeitadas no desenho
  de escrita controlada/constraints entre tabelas; CHECK de linha sozinho não basta.

Uma transação gera no máximo uma entrada por wallet; essa garantia é futura UNIQUE,
não coleção em memória. Abertura positiva gera CREDIT via futura Wallet/use case.
Atomicidade entre tabelas e proteção contra escrita SQL direta ainda exigem testes
de integração e concorrência. Não criamos migrations, repositório ou fluxo financeiro.

Referências de desenho: [constraints PostgreSQL 17](https://www.postgresql.org/docs/17/ddl-constraints.html),
[transações PostgreSQL 17](https://www.postgresql.org/docs/17/tutorial-transactions.html).

## ADR-008 — Money decimal imutável e contratos externos restritos (adotada)

Pedido da etapa 4 escolhe decimal.js encapsulado, domínio sem Nest/ORM e entradas
com exatamente duas casas. O usuário aprovou **precisão ajustada aos operandos**,
sem teto monetário de negócio nesta etapa, e **lista inicial BRL/USD/EUR**. A
proposta anterior de bigint em centavos foi substituída; esse modelo também seria
exato para soma/subtração, mas seguimos a biblioteca preferida para esta entrega.

decimal.js 10.6.0, import nomeado compatível com NodeNext/Bun. MoneyDecimal é clone
privado: configuração global externa não altera Money. Parsing da string não
arredonda. Cada add/subtract usa outro clone cuja precisão é max(comprimentos dos
operandos em escala fixa)+1. Esse limite excede o número de dígitos necessários
para soma/subtração, inclusive transporte, negativos e cancelamento. Não há
conversão de quantias para number. Escala/contagem de dígitos são metadados numéricos.
Alternativa de precisão fixa exigiria teto/overflow explícitos; usar o default 20
em todas as contas não preservaria centavos em valores grandes. Clone por conta
tem custo de alocação, aceito sem alegação de desempenho antes de medições.

from é o limite externo não negativo: valida estrutura, tipo, formato estrito e
moeda antes de Decimal. Não aceita expoente, sinais, whitespace, NaN/Infinity ou
escala diferente de 2; não corrige por trim, uppercase ou arredondamento. Zeros à
esquerda são aceitos e a saída decimal os elimina. Lista explícita de moedas evita
admitir qualquer sequência de três letras; ampliar suporte exige revisão de escala.

Subtract/negate podem produzir negativos internamente. Não existe factory pública
de valores assinados, flag para ignorar validação ou rehydrate nesta etapa. toJSON
pode representar resultados negativos; from continua recusando esses valores.
Assim podemos expressar diferenças e inversos sem admitir quantia externa negativa.
Wallet terá a responsabilidade distinta de não admitir saldo negativo. Um futuro
mapeamento de valores assinados persistidos precisará de decisão própria.

Campo #value e helper #calculate são privados em runtime; currency readonly e
Object.freeze protegem estado externo. Decimal não é exposto. Construtor private
recebe token Symbol interno para também rejeitar construção direta em JavaScript.
Operações retornam novas instâncias, inclusive zero; toJSON retorna DTO independente.
toString usa `quantia moeda`; serialização de transporte usa toJSON. Todas as
operações binárias, inclusive equals, lançam MoneyError/CURRENCY_MISMATCH entre
moedas diferentes. Outros códigos: INVALID_AMOUNT e UNSUPPORTED_CURRENCY. Não há
hierarquia genérica de domínio nem mapeamento HTTP antecipado.

Limites técnicos de memória/strings/decimal.js permanecem; ausência de teto de
negócio não significa capacidade infinita. Limite de payload e NUMERIC(p,2) serão
decididos antes da persistência/exposição financeira. Testes cobrem 25, 100 e 1000
dígitos inteiros, 0.10+0.20, entradas inválidas, sinais, imutabilidade e isolamento
da configuração decimal. Nenhum schema, endpoint ou fluxo financeiro foi criado.

## ADR-007 — Migrations administrativas explícitas e testes isolados (adotada)

CLI e Migrator oficiais 7.2.5, executados com Bun em job separado. Configuração raiz
usa apenas MIGRATION_DATABASE_URL; runtime Nest usa apenas DATABASE_URL. Não há
fallback de credenciais nem migração no startup. Dependências de migration são
de desenvolvimento: job administrativo precisa de instalação completa e fontes TS;
o runtime compilado não importa scripts de migration.

Migrations versionadas em `/migrations`, glob Migration*.ts/js, histórico
mikro_orm_migrations. Criação vazia por CLI oficial, SQL explícito revisado e up/down
obrigatórios no processo de revisão. Não usamos diff automático enquanto não há
entidades; snapshot=false evita estado auxiliar inútil. Alternativa futura de diff
será avaliada com metadados reais. Não se executam schema:update/fresh.

transactional=true, allOrNothing=true, disableForeignKeys=false: falha desfaz o
lote. Operações não transacionais exigiriam desenho separado. Down reverte schema,
mas não recupera dados removidos; histórico administrativo permanece vazio após
reverter a última migration. Rastreabilidade usa nomes registrados e Git; não é
checksum automático do conteúdo. Não editar migration aplicada. Jobs administrativos
devem ser serializados; não afirmamos exclusão distribuída entre CLIs concorrentes.

Testes criam bancos dwp_test_<UUID> com template0 via credencial administrativa já
existente. Fixture recusa qualquer outro nome. Arquivos de prova são gerados em
.tools e limpos em finally; nenhuma migration fictícia entra no diretório de produção.
Cleanup remove só o banco criado pelo helper, sem apagar volume nem modificar
tabelas em wagering. O teste antigo de persistência foi adaptado para usar esse
isolamento. Restart/recriação ainda interrompe o serviço de teste, portanto esses
testes de infraestrutura requerem ambiente ocioso.

Evidência real: geração pela CLI; up e repetição com um único histórico; SELECT de
schema independente; down e retorno à baseline; falha na segunda migration desfaz
DDL de ambas e não deixa histórico aplicado. App pode SELECT/INSERT concedidos,
mas não CREATE/DROP nem ler histórico administrativo. EM.transactional confirmou
um INSERT e desfez outro quando callback lançou erro. Dump do schema wagering
permaneceu igual e nenhum banco de teste sobrou após a execução.

## ADR-004 — PostgreSQL local persistente (adotada)

Imagem oficial PostgreSQL 17.11 (tag 17-alpine fixada por digest), volume nomeado
em `/var/lib/postgresql/data`, rede dedicada do Compose e porta loopback 55432.
As portas 5432/5433 do host já estavam ocupadas por outros projetos; nenhum deles
foi alterado. Não há mounts de diretórios de outros projetos nem Docker socket.

Alternativa: bind mount para dados; volume nomeado evita depender de permissões e
layout da máquina. Volume sobrevive a restart/recriação e a `down` sem `--volumes`.
Credenciais são exclusivamente locais. O usuário `wager_admin` inicializa e migrará
o schema; `wager_app` conecta sem superuser/createdb/createrole. Grants de tabelas
pertencem às migrations futuras. O healthcheck faz SELECT 1 autenticado via TCP.

Scripts de init só executam sobre volume vazio. Alterar a senha no Compose não
migra a credencial persistida; essa alteração requer ALTER ROLE explícito.
O cliente SQL Bun aparece apenas nos testes de infraestrutura, não na persistência
da aplicação: a escolha de MikroORM permanece válida.

## ADR-005 — SQS local sem credenciais de conta (adotada)

**Decisão aprovada pelo usuário em 21/10/2026:** usar LocalStack Community anterior,
sem token. A imagem escolhida é `localstack/localstack:4.14.0`, fixada pelo digest
registrado no Compose. Versões atuais exigem token de conta, conforme o
[anúncio oficial](https://blog.localstack.cloud/localstack-single-image-next-steps/).
Alternativas discutidas: LocalStack atual autenticado ou reavaliar MiniStack.
Esta imagem é antiga e não recebe automaticamente atualizações; a fixação torna
a execução reproduzível, mas exige revisão deliberada para futuras atualizações.

O container habilita somente SQS, expõe 4566 em loopback e usa `test/test` como
identidade AWS fictícia. Não recebe token LocalStack, perfil AWS do host, credenciais
reais ou socket Docker. `SQS_ENDPOINT_STRATEGY=dynamic` produz URLs acessíveis a
partir do hostname utilizado pelo cliente, tanto no host quanto na rede Compose.

**Ciclo de vida:** `PERSISTENCE=0`. O emulador é descartável: filas/configuração são
reconstruídas pelo hook `ready.d` a cada início. Mensagens pendentes são perdidas
ao reiniciar/recriar o LocalStack. Essa limitação não afeta a persistência PostgreSQL
e não deve ser confundida com durabilidade de SQS real. Nos testes futuros de crash
da aplicação, manter o broker em execução; não usar restart do emulador como prova
de recuperação de mensagens. Persistência do broker exigiria outra decisão explícita.

**Provisionamento:** `queues.json` define o estado desejado. O script Python utiliza
boto3 já incluído na imagem; não instala ferramentas em startup. Cria a DLQ primeiro,
depois a origem, consulta os ARNs e aplica atributos mutáveis. Reexecução obtém as
filas existentes e reconcilia atributos sem delete/purge. FifoQueue é imutável: o
script valida esse atributo e falha se incompatível. Modo `check` só lê e é usado no
healthcheck; falha se o broker não responder, uma fila faltar ou atributos divergirem.
Não há marcador de sucesso obsoleto que possa tornar o container falsamente healthy.

| Parâmetro | Escolha e justificativa |
|---|---|
| Filas | `wager-transactions.fifo` e `wager-transactions-dlq.fifo`, ambas FIFO, como exige o README |
| ContentBasedDeduplication | false: produtor informa MessageDeduplicationId explicitamente; não esconder identidades de negócio num hash automático de corpo |
| VisibilityTimeout | 30s iniciais; deve superar duração normal do processamento. Futuro worker poderá renovar/alterar por mensagem. Não é deadline de transação SQL |
| ReceiveMessageWaitTimeSeconds | 20s: long polling reduz consultas vazias. Testes sobrescrevem apenas o tempo de espera da requisição |
| maxReceiveCount | 5: permite falhas transitórias sem retry ilimitado. Após 5 entregas sem DeleteMessage, próxima tentativa de entrega direciona à DLQ |
| Retenção origem/DLQ | 345600s (4 dias) / 1209600s (14 dias): mais tempo para diagnóstico na DLQ. Retenção ativada no emulador; expiração em dias não foi ensaiada |
| RedriveAllowPolicy | byQueue, somente ARN da origem; limita qual fila pode usar essa DLQ |

Visibility timeout permite reentrega; o broker não implementa sozinho nosso futuro
backoff exponencial de negócio. FIFO ordena por MessageGroupId, não globalmente;
produtores financeiros deverão usar walletId como grupo. Deduplicação do broker
tem janela limitada e não substitui Inbox nem idempotência SQL. Encaminhar à DLQ
libera um grupo e pode quebrar a sequência completa de operações; validação de
referências fora de ordem permanece requisito da aplicação.

**Evidência:** 4 testes Bun com SDK AWS e LocalStack reais: reconciliação de drift
e reexecução preservando mensagem; invisibilidade/reentrega/ACK; movimento efetivo
à DLQ; restart e recriação seguidos de nova troca de mensagens. O SDK está em
devDependencies, usado somente pelo teste; nenhum worker definitivo foi implementado.

Referências: [hooks LocalStack](https://docs.localstack.cloud/aws/customization/advanced/initialization-hooks/),
[URLs e retenção SQS local](https://docs.localstack.cloud/aws/services/sqs/),
[visibility timeout AWS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html),
[DLQ AWS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html).

## Referências consultadas na base

- [Bun: instalação](https://bun.sh/docs/installation)
- [Bun: TypeScript](https://bun.sh/docs/typescript)
- [Nest: primeiros passos](https://docs.nestjs.com/first-steps)

As versões exatas também foram consultadas no registro npm e verificadas localmente
por instalação, typecheck, teste HTTP e execução compilada.


## ADR-011 — WagerTransaction e regras locais do ciclo de vida

**Decisões aprovadas em 22/10/2026:** valores positivos em OPENING/BET/WIN/REFUND/
ROLLBACK; LOSS exatamente zero. Alternativa discutida: admitir zero em operações
financeiras. A escolha mantém toda operação com efeito monetário apta a gerar um
ledger positivo. Wallet.open com saldo zero continua sem OPENING.

WIN pode referenciar opcionalmente uma BET processada, validando provider, player,
wallet, moeda e rodada; o prêmio pode diferir da aposta. BET/LOSS/OPENING não aceitam
referência. REFUND exige BET; ROLLBACK exige BET/WIN/REFUND; ambos pelo valor integral.
Não acrescentamos igualdade de gameId: ela não faz parte do escopo exigido em §7.

Alternativa ao ID opaco em markProcessed: receber a **entidade referenciada**, aprovada
pelo usuário. Isso permite validar os vínculos locais antes de registrar seu ID interno.
O caso de uso buscará a referência por providerId + referenceExternalTransactionId;
a entidade não consulta banco. Referência pendente lança REFERENCE_NOT_PROCESSED;
rejeitada/falha lança INVALID_REFERENCE. Nenhum desses erros muda o estado sozinho.

Máquina aprovada: PENDING → PENDING_REFERENCE apenas com referência externa;
ambos → PROCESSED/REJECTED/FAILED; sem volta a PENDING e sem repetição da transição
para PENDING_REFERENCE. Terminais recusam todas as transições, mesmo repetidas ou
com parâmetros inválidos. Replays deverão retornar o resultado persistido, sem chamar
markProcessed novamente. Retries verificam status antes de aguardar novamente.

Factory externa create recusa OPENING em runtime; createOpening explicita o fluxo
interno sem token de provedor nem valores mágicos. IDs, hash e metadados de abertura
continuam fornecidos pelo futuro caso de uso. Não é barreira de autenticação: futuros
adaptadores HTTP/SQS devem usar somente create e recusar OPENING. Rehydrate é fronteira
confiável de persistência, admite OPENING e verifica estrutura/coerência do snapshot,
sem buscar a referência nem reexecutar transições. Não substitui constraints SQL.

Estado público congelado, identidade/Money somente leitura; datas copiadas por epoch;
apenas snapshot privado de lifecycle é substituído depois de validar a transição.
Datas são instantes fornecidos, sem impor ordenação por relógio distribuído. A entidade
não gera IDs, hash, timestamps, ledger, saldo, eventos ou I/O. Nenhuma mudança em Money,
Wallet ou WalletLedgerEntry foi necessária.

ledgerDirectionFor retorna **LedgerDirection | null**: LOSS/REJECTED/FAILED não geram
lançamento. BET débito; OPENING/WIN/REFUND crédito; ROLLBACK inverte a referência
(BET → crédito, WIN/REFUND → débito). Referências preenchidas são verificadas também
nessa consulta; no estado PROCESSED, devem coincidir com o ID interno já registrado.
Alternativa de lançar erro em LOSS descartada: ausência de lançamento é resultado
normal. affectsBalance indica efeito potencial/histórico, não autorização de reaplicar
PROCESSED nem prova de saldo disponível em PENDING_REFERENCE.

FailureCode separa rejeições de negócio de FAILED permanente de infraestrutura.
INSUFFICIENT_FUNDS só BET; REVERSAL_INSUFFICIENT_FUNDS só ROLLBACK (REFUND apenas
credita); REFERENCE_NOT_FOUND/INVALID_REFERENCE exigem referência externa;
DUPLICATE_REVERSAL apenas REFUND/ROLLBACK; DOMAIN_RULE_VIOLATION é rejeição geral.
PERMANENT_INFRASTRUCTURE_FAILURE é exclusivo de fail. IDEMPOTENCY_CONFLICT é código
de admissão/API futura: nunca altera a transação original para REJECTED/FAILED.
Erros de validação/transição são exceções de domínio e não respostas HTTP.

**Limites e trabalho futuro:** matchesPayload compara hashes opacos exatamente,
sem calcular/canonicalizar JSON. Unicidade da key no escopo aprovado, identidade
(provider_id, external_transaction_id), reversão bem-sucedida única por
(reference_transaction_id, kind), FK de referência e ledger único por
(transaction_id, wallet_id) dependerão do schema. O índice de reversão deve reservar
somente sucesso, permitindo auditar rejeições e tentativas inválidas sem consumi-lo;
o desenho exato será discutido antes da migration. REFUND e ROLLBACK são tipos
separados: não adicionamos bloqueio conjunto da mesma BET. Constraints devem proteger
amount/currency/status, coerência de lifecycle e imutabilidade de resultados terminais.
Saldo não negativo e ledger imutável continuam requisitos do banco, além das classes.

O futuro caso de uso validará saldo, duplicidade, retries/TTL e obterá o lock da Wallet.
Persistirá saldo, ledger, status, resultado original, inbox/outbox na mesma transação
SQL. Falha permanente só depois de determinar o resultado da tentativa anterior:
commit de resultado desconhecido exige consulta/reconciliação, nunca marcar FAILED
cegamente. Falha transitória permanece recuperável. Não implementado nesta etapa.

**Evidência local:** suíte dedicada ao lifecycle, referências e encapsulamento, com
cenário que aceita duas reversões em objetos independentes para mostrar o limite da
entidade. Resultados e comandos reais estão na seção 15 do LEARNING_GUIDE.

## ADR-012 — Schema financeiro: decisões aprovadas em 23/10/2026

- Capacidade monetária equivalente a NUMERIC(20,2): 18 dígitos inteiros e dois
  decimais, máximo 999999999999999999.99. Colunas usam o domínio SQL
  financial_amount sobre NUMERIC **sem typmod**, CHECK de faixa não negativa e
  scale <= 2. Isso rejeita 1.005 em vez de arredondar para 1.01. O domínio SQL é
  apenas um tipo validado reutilizado nas colunas; não é a camada de domínio DDD.
  Alternativa recusada: NUMERIC(20,2) literal com validação obrigatória anterior em
  funções de escrita. Money mantém precisão aritmética maior; armazenamento tem teto.
- Idempotência aprovada por provedor: UNIQUE(provider_id,idempotency_key), além
  de UNIQUE(provider_id,external_transaction_id), sem recalcular a chave recebida.
- Correspondência de saldo e ledger: constraint triggers diferíveis e wallet_version
  como metadado persistido do lançamento. Alternativa considerada: escrita apenas
  por funções SQL. Os detalhes e evidências serão acrescentados com o ledger.
- IDs continuam text, compatíveis com o domínio; não impomos UUID nem inventamos
  identidades externas. Índices B-tree têm limites físicos de tamanho de entrada;
  limites de payload do futuro contrato deverão considerar isso.
- Dinheiro entra/sai como string; nada de parseFloat ou DecimalType em modo number.
  SQL admite escala 0/1 sem perda; futura leitura normalizará para as duas casas de
  Money. Não consegue recuperar dígitos que o cliente já arredondou antes de enviar.
- Version usa bigint limitado ao inteiro seguro positivo do domínio; moeda BRL/USD/EUR;
  timestamps timestamptz(3), finitos, compatíveis com Date em milissegundos.
- Migrations SQL explícitas e oficiais, sem auto-sync. Cada etapa usa apenas bancos
  descartáveis. DOWN remove dados e não é um procedimento de recuperação financeira.

Primeiro incremento: wallets e financial_amount entregues. PK(id),
UNIQUE(player_id,currency), UNIQUE(id,player_id,currency) para futura FK composta;
CHECKs e NOT NULL protegem representação. wager_app pode SELECT/INSERT e UPDATE
somente balance/version/updated_at; não DELETE/TRUNCATE/DDL/alteração de identidade.
Ainda não protege saldo contra mudança sem ledger até a migration de integridade.
Proprietário/migrador continua responsável por DDL; superuser não é fronteira de
segurança contra adulteração do schema. O papel da aplicação não é administrador.
