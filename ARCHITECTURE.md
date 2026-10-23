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
produz lançamentos em memória para cada mudança de saldo aceita. A correspondência
persistente Wallet/Transaction/Ledger está protegida pelo schema testado via SQL;
a aplicação Nest ainda não possui o caso de uso que escreve nessas tabelas.
O schema financeiro e suas proteções estão versionados e validados em bancos
descartáveis (ADR-012); não foram aplicados ao banco principal. Não existem casos de
uso financeiros, mappers/repositórios financeiros, replay completo, autenticação,
reconciliação, métricas ou testes distribuídos completos. Atomicidade com Inbox/Outbox
e recuperação de processamento continuam pendentes. Os testes reais de infraestrutura provam conexão, configuração,
mensageria, persistência PostgreSQL e rollback de migrations. Testes de schema provam
consistência Wallet/Transaction/Ledger por SQL; não provam atomicidade com inbox/outbox.

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

Segundo incremento ADR-012: wager_transactions entregue com identidade/key únicas
por provedor, FK composta à wallet, FK nullable à referência interna, CHECKs de
kind/status/valor/lifecycle/código e trigger BEFORE para inputs/terminais imutáveis e
referência processada compatível. Referência externa permanece sem FK para aceitar
ordem de chegada invertida. Índices parciais reservam somente reversões/OPENING
PROCESSED; índices de pendentes/histórico/referência atendem buscas futuras.
Não há validação de efeito financeiro no ledger até o terceiro incremento.


Terceiro incremento ADR-012: wallet_ledger_entries tem PK, FKs, UNIQUE(transaction_id,
wallet_id), UNIQUE(wallet_id,wallet_version), equação e valores validados. O índice de
versão também permite busca de predecessor e futura paginação estável sem depender
do relógio. Currency é protegida pela FK composta à transação, que referencia a wallet.

BEFORE triggers impedem mutação/exclusão de ledger, exclusão de wallets, TRUNCATE nas
três tabelas, mudança da identidade da wallet e salto/alteração indevida de version.
Permissões do app bloqueiam essas operações independentemente das triggers.
Constraint triggers DEFERRABLE INITIALLY DEFERRED validam cada evento de saldo contra
seu ledger/version; cada ledger contra operação PROCESSED, direção, valor, predecessor
e último saldo; cada transação contra a existência/ausência de ledger em seu estado
final. Abertura positiva exige OPENING/version1/0→saldo; zero não produz entrada1.
São consultas indexadas locais, sem varrer/somar todo histórico a cada movimento.

Para proteger a validação das escritas concorrentes, BEFORE INSERT do ledger toma
FOR NO KEY UPDATE somente na wallet. A primeira tentativa com FOR UPDATE produziu
deadlock40P01 no teste de duas sessões que já possuíam KEY SHARE das FKs. O modo
mais fraco preserva exclusão entre escritores de saldo e é compatível com essas FKs;
o teste mantém exigência de um sucesso e um23505, sem aceitar deadlock como sucesso.
Isso é defesa SQL do schema, não implementação de lock/caso de uso de apostas.
Nenhuma garantia de ausência universal de deadlocks foi demonstrada.

Correspondência é verificada por evento: várias mudanças na mesma wallet numa unidade
SQL exigem vários UPDATEs/version e seus respectivos ledgers. Um futuro mapper/Unit
of Work não poderá condensar esse lote em um UPDATE final sem preservar movimentos.
Múltiplas operações não são coordenadas por esta etapa. Não há Inbox/Outbox operacionais,
publicação, replay, processamento distribuído nem controle de tentativas/TTL.

A terceira migration recusa dados financeiros preexistentes sem histórico, sem
corrigi-los/destruí-los. Seu down remove ledger/garantias; reaplicar sobre efeitos que
restaram exige migration de dados explícita. Roundtrip down0/up é ensaiado apenas em
bancos descartáveis. Principais limitações: owner/superuser pode alterar DDL e desativar
proteções; entrada já arredondada pelo cliente não pode ser recuperada; identificadores
text estão sujeitos aos limites físicos dos índices PostgreSQL. Valores acima do teto
de armazenamento são recusados embora Money consiga calculá-los.

Mapeamento futuro: Wallet ↔ wallets; WagerTransaction ↔ wager_transactions;
WalletLedgerEntry + walletVersion ↔ wallet_ledger_entries. IDs são texto; Money é
amount/currency (balance na wallet); null se torna undefined e datas viram Date.
Migrations oficiais SQL independem de EntitySchemas. Não antecipamos repositórios;
a futura implementação manterá domínio sem decorators Nest/ORM e dinheiro em strings.

## ADR-013 — Fronteira explícita de mapeamento financeiro

Mappers independentes do ORM traduzem registros SQL em factories rehydrate e vice-versa.
Money permanece sem teto aritmético; a fronteira de armazenamento aplica limite de
18 inteiros/2 decimais e não negatividade, normalizando apenas texto exato. Não há
mudança no domínio nem repetição de transições. Ledger transporta walletVersion em
envelope separado; datas e referências são preservadas. A alternativa de decorators
no domínio foi descartada para preservar encapsulamento e isolamento. A estratégia
específica de escrita dos repositórios será registrada no próximo incremento.

## ADR-014 — Repositórios SQL pelo EntityManager transacional

Escolha aprovada pelo usuário: SQL parametrizado via `em.execute`, dentro de
`EntityManager.transactional`, com mappers explícitos. Alternativa: EntitySchemas
separados e dirty checking com flush a cada movimento. Escolhemos escrita explícita
para preservar um UPDATE por saldo/versão e controlar a ordem exigida pelas FKs e
triggers, evitando que dois movimentos sejam condensados pelo Unit of Work do ORM.
Trade-off: escrevemos/manutenimos SQL e mappers; não usamos identity map/dirty checking
para estas entidades. Não substituímos o driver/transações oficiais por outro cliente.

Portas em application/ports não importam Nest/MikroORM. Adaptadores na infraestrutura
recebem a mesma FinancialSession, que exige EM dentro de transação e fecha no fim do
escopo. Nenhuma porta expõe SQL arbitrário, delete financeiro ou update do ledger.
Leituras por unicidade retornam objeto/null; histórico ordena por wallet_version,id.
Status é atualizado apenas nos quatro campos de lifecycle. Falhas SQL propagam,
sem tratar colisão UNIQUE como sucesso ou implementar replay antecipadamente.

Wallet carregada sem lock é apenas snapshot para leitura. `findByIdForUpdate` consulta
novamente com FOR NO KEY UPDATE, sem reutilizar objetos de leitura; mantém lock até
fim SQL. `save` exige objeto desta sessão, lock/inserção local e version anterior+1,
usa WHERE id/version e exige um RETURNING. Múltiplos movimentos exigem save após cada
um e respectivos ledgers. INSERT de wallet nova já detém proteção de escrita.
WeakMaps guardam propriedade de objetos, não coordenam processos; exclusão real vem
exclusivamente do PostgreSQL. Wallet/Transaction de uma sessão anterior devem ser
recarregadas mesmo após sucesso; rollback não restaura objetos JavaScript.

Locks de wallets existentes devem preceder decisões e escritas; adquirir IDs em ordem
crescente (comparação lexical JS, a mesma em todos os chamadores). A sessão recusa
inversão. Isso reduz deadlocks, não elimina toda possibilidade (outros recursos e
escritores externos existem). Para abertura, ordem wallet → transação → ledger;
referências processadas precisam existir antes de atualizar/inserir dependente.
Futuras operações com várias wallets devem adquirir todos os locks primeiro; esta
etapa não oferece um caso de uso de transferência. Não há lock global ou mutex.

## ADR-015 — Fronteira transacional financeira e evidência de concorrência

MikroFinancialUnitOfWork implementa a porta com `run(callback)`, injetado pelo token
FINANCIAL_UNIT_OF_WORK. Recebe o ORM de aplicação já validado pelo startup; não lê
MIGRATION_DATABASE_URL e não cria schema. Cada run cria fork limpo/useContext:false,
usa transactional oficial em READ COMMITTED e cria uma sessão compartilhada pelos
três adaptadores. AsyncLocalStorage recusa fronteira financeira aninhada; helpers
internos devem receber os repositórios existentes. Chamadas concorrentes externas
usam contextos independentes, não uma fila global.

READ COMMITTED + lock obtido antes da decisão é suficiente para os cenários de wallet
serializados testados; alternativa SERIALIZABLE exigiria tratamento explícito de
serialization failures. Não há retries automáticos nesta etapa: eles precisam repetir
a operação inteira com objetos novos e serão definidos com idempotência/casos de uso.
O ORM faz flush após callback; nenhuma entidade financeira está em dirty checking,
portanto os INSERT/UPDATE já ocorreram pelo em.execute. O commit roda as constraints
diferíveis; run só resolve depois dele. Erro no callback ou commit rejeita e faz rollback.
Fechar a sessão no finally impede usar repos escapados. WeakMaps guardam tokens Symbol,
não referências aos EntityManagers; objetos antigos não mantêm o pool/contexto vivo.

Rollback restaura o banco, não Money/Wallet/WagerTransaction em memória. Mesmo objeto
anterior com valores aparentemente corretos não é reutilizável para escrita por estes
adaptadores: recarregar via nova sessão, lockar e decidir novamente. O contrato exige
await em todas as chamadas: não iniciar tarefas soltas/efeitos externos no callback.
Inbox/Outbox futuras precisam gravar usando o **mesmo EM/SQL transaction**, estendendo
as portas deste escopo. A publicação SQS pertence a um relay depois do commit.
Nada nesta etapa implementa o relay ou autoriza responder replay HTTP como concluído.

Prova concorrente em PostgreSQL real: barreiras mantêm sessão A com lock e crédito
não confirmado; sessão B lê snapshot antigo, insere FK (KEY SHARE compatível), tenta
NO KEY UPDATE e é observada em pg_stat_activity/pg_blocking_pids como bloqueada por A.
Enquanto isso C movimenta outra wallet e confirma. Liberar A por commit faz B ler110;
rollback faz B ler100; B credita20 e o banco termina130/v3 ou120/v2, respectivamente.
PIDs distintos, resultados exatos e ausência de deadlock são exigidos nos dois cenários.
Polling de observação não presume aquisição por atraso. Isso não prova ausência
universal de deadlocks nem performance sob carga ou resiliência a falhas de rede.

Referências: [MikroORM transactions](https://mikro-orm.io/docs/transactions),
[Unit of Work](https://mikro-orm.io/docs/unit-of-work),
[PostgreSQL17 locks](https://www.postgresql.org/docs/17/explicit-locking.html).
A implementação instalada 7.2.5 também foi inspecionada: SqlEntityManager.execute usa
getTransactionContext; TransactionManager.executeTransactionFlow chama flush antes
que Connection.transactional tente confirmar. Nenhuma migration foi alterada.

## ADR-016 — Eventos de integração v1

Aprovado: OPENING positiva emite WagerTransactionProcessed e WalletBalanceChanged;
abertura zero não emite nenhum dos dois. Eventos de transação usam aggregateId=tx.id;
BalanceChanged usa wallet.id. Todos carregam walletId para futura correlação/agrupamento.
Alternativa discutida: omitir OPENING ou usar walletId como agregado de todos os eventos.
Factories recebem entidades no estado correspondente e contexto explícito, sem gerar
IDs/datas. Tipos e version=1 pertencem às classes. Money vira MoneyProps; payload e
serialização são cópias recursivamente congeladas, Date é defensiva. Integração não
significa publicação: as classes apenas descrevem fatos para posterior persistência.

## ADR-017 — Lifecycle da Inbox/Outbox

Aprovado: Inbox deduplica consumerName/messageId, compara hash e só considera replay
quando processedAt existe; registro ainda pendente é retomado sob lock. Não equivale
a idempotencyKey financeira. Hash é calculado pelo futuro consumidor confiável sobre
conteúdo canônico, não recebido como prova do remetente. O domínio recebe hash opaco
como os contratos existentes; algoritmo de admissão completo continua pendente.

Outbox usa eventId como id, envelope imutável, tentativas como **falhas de publicação**,
backoff determinístico1s×2^falhas anteriores, teto5min. Não descarta evento por limite
de tentativas; contador int32 recusa overflow. Sem jitter nesta etapa para testes
reproduzíveis; futura política operacional pode evoluir explicitamente. Published é
terminal, limpa nextAttemptAt; retry exige evento pendente e devido. Limite do atraso
reduz pressão sem abandonar evento; não implementa DLQ do broker. Rehydrate valida
estrutura, não executa retry/publicação/transições novamente.

## ADR-018 — Schema de mensagens

Migration00004 adiciona Inbox PK(consumer_name,message_id) e Outbox PK(id=eventId).
JSONB exige envelope v1 conhecido, IDs, timestamp UTC, tipos/status por evento, Money
string escala2/moeda/teto e equação quando BalanceChanged. Não usa float. Colunas
espelham envelope; checks recusam lifecycle incoerente. Guardas mantêm identidades/
payload imutáveis e estados finais terminais, inclusive sob DML do owner; app só pode
SELECT/INSERT e UPDATE das colunas de lifecycle. Retenção/delete fica para decisão
futura: nenhuma limpeza automática de Inbox que permita replay antigo.

Índice parcial outbox_due_idx em COALESCE(next_attempt_at,occurred_at),occurred_at,id
para published_at NULL permite seleção futura ordenada com FOR UPDATE SKIP LOCKED.
Não há publisher/claim implementado. Não adicionamos FK polimórfica para aggregateId
nem exigência retroativa de evento em todas as transações antigas. Atomicidade é
fornecida pela unidade compartilhada **quando o chamador inclui os eventos**; validar
a semântica dos fatos corresponde às factories/casos de uso, não a um JOIN genérico
no CHECK JSONB. Isso preserva os contratos/migrations financeiros anteriores.

## ADR-019 — Inbox/Outbox na unidade financeira

As portas FinancialRepositories passam a incluir inbox/outbox; createRepositories
constrói os cinco adaptadores sobre a **mesma FinancialSession/EntityManager**. Nenhuma
transação paralela de mensagens, connection.execute sem contexto ou chamada SQS foi
introduzida. HTTP pode omitir Inbox, mas inclui Outbox junto dos efeitos. Para SQS,
ordem de aquisição: Inbox → wallets em ordem de ID → escritas financeiras → Outbox
→ Inbox processada. Não adquirir Inbox depois de lock financeiro em outro fluxo.

MikroInboxRepository.receive: INSERT ON CONFLICT DO NOTHING RETURNING; se não inseriu,
SELECT FOR UPDATE em **comando separado** obtém snapshot READ COMMITTED posterior à
espera pela unicidade. Compara hash antes de qualquer retorno de replay. Resultado
new/pending permite trabalhar; processed instrui o futuro caso de uso a não repetir
efeitos. Uma Inbox ainda pendente exige retomada sob lock, não é replay concluído.
Alternativa de SELECT antes do INSERT teria race; capturar23505 dentro da transação
sem savepoint a deixaria abortada. Não fazemos upsert que sobrescreva hash/receivedAt.

Outbox INSERT mantém id=eventId único; colisão23505 é explícita, não sucesso silencioso.
listDue é uma consulta limitada1..1000 e ordenada; não reivindica eventos nem permite
salvar seus snapshots. findByIdForUpdate permite transição unitária sob lock; save só
atualiza lifecycle. Um futuro publisher pode implementar lote SKIP LOCKED sobre o
índice parcial, mas ainda precisa decidir duração de lock/lease, ordenação por wallet,
política de falhas e envio fora da transação financeira. Só possuir lista não é claim.

Mappers convertem datas/null e JSONB sem passar dinheiro por number. O envelope
permanece profundamente imutável; rehydrate conserva identidade e agendamento sem
repetir transições. Sessão usa ownership por token também para Inbox/Outbox: objetos
mutados em rollback ou vindos de outra unidade não podem ser salvos/reinseridos; devem
ser recarregados. Mapas não são deduplicação distribuída: UNIQUE e locks são a garantia.

Evidência: transação de fixture confirma cinco tabelas com dois eventos; falhas antes
ou durante commit deixam todas vazias. Nova instância ORM encontra Inbox processada,
retorna replay sem segundo ledger. Duas sessões concorrentes esperam na mesma chave;
hash igual retorna replay, diferente gera INBOX_PAYLOAD_CONFLICT. Outra carteira/
mensagem confirma durante espera. EventId duplicado espera e falha23505. Cenários não
substituem consumidores/publishers reais, testes de kill-process,50 redeliveries ou
replay HTTP. Hash continua sendo entrada confiável do futuro adaptador de admissão.

Referências: [PostgreSQL READ COMMITTED](https://www.postgresql.org/docs/17/transaction-iso.html)
e [AWS Transactional Outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html).
A Outbox evita perda entre commit e intenção de publicação, mas a publicação pode
repetir depois de falha entre envio e registro published. Consumidores precisarão
deduplicar eventId persistente; FIFO não substitui esse contrato.

## ADR-020 — Caso de uso CreateWallet

A camada de aplicação coordena as factories reais e a FinancialUnitOfWork existente.
CreateWallet não importa Nest/ORM, não executa SQL e não publica eventos. Entrada é
playerId + MoneyProps; saída é snapshot plain profundamente congelado com id, playerId,
balance e version, conforme README. A Promise só resolve após COMMIT. Criar o DTO no
callback não o entrega ao chamador antes da resolução de run; erro diferível rejeita
também execute. Nenhuma instância de Wallet/Transaction é guardada entre chamadas.

Admissão verifica playerId, Money.from e teto de armazenamento999999999999999999.99
antes de abrir transação. Essa verificação usa Money, nunca number; o domínio conserva
capacidade aritmética e o DOMAIN PostgreSQL continua sendo a autoridade final.
Não houve alteração em entidades, schema, migrations, permissões ou níveis de isolamento.

Ordem: Wallet.open → INSERT Wallet → createOpening/markProcessed → INSERT OPENING
→ INSERT ledger → INSERT dois eventos Outbox. A factory Wallet.open já cria o CREDIT
em memória; não repetimos a operação com wallet.credit, que incrementaria versão.
As FKs são imediatas e as verificações de correspondência saldo/ledger são diferíveis.
Saldo zero persiste somente Wallet versão1. Inbox é omitida porque a origem futura
será API, e não recepção de mensagem. Não há transação aninhada nem SELECT preventivo
para unicidade;23505 é traduzido apenas para wallets_player_currency_unique (seção24
do guia). Outros erros mantêm causa/origem. Não há retry/replay automático de abertura.

**Metadados aprovados pelo usuário:** providerId reservado internal:wallet-opening;
roundId/gameId wallet-opening; externalTransactionId e idempotencyKey iguais ao ID da
OPENING. SHA-256 sobre JSON de campos fixos/ordem fixa, valores Money normalizados e
data UTC, contrato versão1. Inclui IDs da carteira/transação/ledger, jogador e metadados.
É hash de identidade/conteúdo dessa abertura interna, não chave para replay HTTP nem
assinatura de autenticidade. Uma nova tentativa tem novos IDs. A admissão futura de
provedores deverá proibir esse namespace; não há tal endpoint implementado nesta etapa.
Alternativa discutida: tabela/modelo independente para abertura, com mudanças de schema.
Escolha mantém o modelo aprovado pelo README e evita uma segunda representação.

IdGenerator.next e Clock.now são portas pequenas. Produção usa randomUUID (v4) e Date;
testes fornecem sequência/data fixa. UUID não determina ordem de eventos: futura
ordenação por carteira precisa de versão/contrato, não comparação lexical de IDs.
Gerar IDs/datas nas entidades dificultaria testes e acoplaria o domínio ao runtime.
Um helper privado usa node:crypto para SHA-256, disponível no Bun testado; não criamos
serviço genérico de hashing ou canonicalização de payloads externos antecipadamente.
Eventos usam correlationId=wallet.id e causationId=OPENING.id, com o mesmo timestamp
da abertura. Propagação de trace/request HTTP é uma preocupação de etapa futura.

WalletApplicationModule faz a composição por useFactory e exporta CreateWallet.
AppModule o importa, preservando PersistenceModule e health. Não cria rota financeira.
Instanciar o módulo não aplica migrations nem grava carteiras. O banco principal
continua sem schema financeiro; a utilização real do caso de uso foi testada somente
em bancos dwp_test_* migrados e removidos pelo suporte existente.

Provas: consultas após commit, um único xmin para os cinco INSERTs; observador não
enxerga registros antes do commit; falhas de factory/escrita/constraint diferível
revertem tudo. Concorrência usa duas instâncias ORM, barreiras e pg_blocking_pids:
mesma chave espera e conflita após commit, ou prossegue após rollback; outro jogador
confirma durante espera. Testes não provam HTTP, publicação SQS ou recuperação de
resultado quando a conexão cai exatamente após confirmação do servidor.

Referências primárias: [unicidade PostgreSQL](https://www.postgresql.org/docs/17/index-unique-checks.html),
[constraints diferíveis](https://www.postgresql.org/docs/17/sql-set-constraints.html),
[UUID e crypto](https://nodejs.org/api/crypto.html#cryptorandomuuidoptions).

## ADR-021 — Contrato canônico de admissão BET

prepareBet valida o DTO de transporte e produz Money/input imutáveis e SHA-256 de
JSON UTF-8. Lista explícita de campos em ordem lexicográfica, também em money;
externalTransactionId, gameId, kind, money, playerId, providerId, roundId, walletId.
Exclui idempotencyKey e metadata: a chave localiza a operação, o hash compara conteúdo.
Normaliza dinheiro por Money.toJSON sem number, sem trim/case folding de IDs. Não é
RFC8785 genérico nem hash de todo body. Outra política futura requer versão explícita
e compatibilidade com registros existentes. OPENING/provider interno e referências
não são admitidos por este contrato BET; outros kinds aguardam autorização própria.

Alternativas: serializar o input inteiro dependeria da ordem/metadata; hashear apenas
valor/carteira deixaria passar mudanças relevantes. Hash não é autenticação. Limite
monetário igual ao schema é validado antes de I/O, mantendo Money intacto.

## ADR-022 — Snapshot original e locks de admissão

Aprovado pelo usuário: tabela wager_transaction_results com resposta v1 imutável,
PK/FK da WagerTransaction e wallet_version como metadado. Rejeições não têm ledger;
saldo atual não serve para replay. Alternativa de colunas na WagerTransaction exigiria
alterar entidade e guardas existentes. Snapshot separado mantém domínio aprovado e
justifica redundância de status/moeda para contrato histórico, conferida por trigger.
BEFORE INSERT captura estado sob NO KEY UPDATE; PROCESSED confere ledger. Exigência
de snapshot para BET terminal nova é diferível. Nenhum backfill inventado para legado;
ausência de resultado deve ser erro explícito, nunca débito/rejeição reexecutado.

Advisory transaction locks por (provider,key) e (provider,externalId), escopos distintos,
endereços SHA-256 truncados para 64 bits assinados, ordenados numericamente. Colisões
podem gerar espera extra; valores exatos/UNIQUE continuam soberanos. O protocolo é
admissão → Wallet NO KEY UPDATE → escritas → resultado/Outbox → commit. Futura Inbox
deve ser adquirida antes da admissão, na mesma UOW. Uma operação por UOW evita ordem
invertida entre pares. Nenhum lock global. Alternativa INSERT de reserva foi discutida:
UNIQUE/FK antes do lock exigiria resolver disputas e transações abortadas; a ordem
escolhida permite resolver replay/conflito antes de tocar Wallet. Escritores fora do
protocolo ainda são limitados pelas constraints, mas não recebem automaticamente a
taxonomia de conflitos do caso de uso.

Referências: [locks PostgreSQL](https://www.postgresql.org/docs/17/explicit-locking.html)
e [advisory transaction locks](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS).

## ADR-023 — ProcessWagerTransaction restrito a BET

Entrada validada/copiada antes da UOW; mesma função de processamento serve execute
e processInTransaction. Execute é a fronteira pública que retorna após COMMIT e
refaz até 3 tentativas completas para 40P01/40001. ProcessInTransaction é ponto interno
de composição para futura Inbox: aceita os repositórios de uma UOW já aberta, não
abre transação nem faz retry local. Seu resultado é provisório até o dono confirmar;
futuro consumidor deverá executar Inbox → processamento → Inbox processada numa única
UOW, fazer retry da fronteira inteira e ACK só após commit. Nenhum consumidor/Inbox
operacional foi antecipado nesta etapa. Não usar execute dentro de outra UOW.

Ordem: locks das duas identidades → lookup por key → lookup identidade externa
→ Wallet NO KEY UPDATE → validar jogador/moeda → INSERT PENDING → Wallet.debit
→ save Wallet → terminalizar transação → INSERT ledger → eventos → snapshot → COMMIT.
Para saldo insuficiente, catch apenas WalletError/INSUFFICIENT_FUNDS: reject explícito,
sem save da Wallet/ledger; um evento Rejected e snapshot do saldo observado sob lock.
Não convertimos SQL ou qualquer Error em rejeição de negócio. Não usamos aritmética
duplicada nem UPDATE condicional para repetir a regra que pertence à Wallet.

Replay consulta apenas transação/snapshot e marca idempotentReplay=true. Não adquire
lock de Wallet, não gera IDs/data, não compara com saldo atual e não reinsere eventos.
Mesmo key/hash diferente dá IDEMPOTENCY_CONFLICT; externalId com outra key dá
EXTERNAL_TRANSACTION_CONFLICT. Esses erros são de admissão, não status REJECTED.
Wallet inexistente, jogador/moeda divergentes também são admissão inválida, conforme
aprovação: não violamos FK para registrar uma operação sobre identidade inexistente.
Registro legado PENDING ou terminal sem snapshot retorna ORIGINAL_RESULT_UNAVAILABLE;
não é automaticamente retomado nem respondido com um saldo inventado.

A UOW só traduz SQLSTATE40001/40P01 em RetryableFinancialTransactionError depois da
rejeição da transactional oficial (rollback). O caso de uso espera 10/20ms fora da
transação e refaz locks/leituras/objetos com novo EntityManager; máximo3 tentativas.
Não há retry de 23505, conexão caída, commit de resultado incerto ou rejeição de domínio.
Falha esgotada não deixa FAILED: a tentativa inteira foi revertida. IDs podem ter
lacunas porque tentativas abortadas consomem UUIDs; nada parcial é publicado/persistido.
Backoff pequeno e limitado é suficiente para esta etapa local; política operacional
de filas/telemetria não foi inferida. Alternativa sem retry automático foi discutida.
Referência: [repetir a transação completa](https://www.postgresql.org/docs/17/mvcc-serialization-failure-handling.html).

Eventos usam correlationId=transactionId/causationId=transactionId como contexto
interno, payloads das factories existentes, occurredAt capturado depois do lock da
Wallet. Requisições/trace/messageId pertencem à integração futura. Domínio e constraints
financeiras anteriores permanecem intactos; quinta migration só acrescenta resultados.
Composição Nest exporta ProcessWagerTransaction, sem controller ou rota financeira.

Provas incluídas: saldo exato, rejeição, replay histórico após outros movimentos e
recriação do ORM, rollback antes/depois de débito/Outbox/snapshot e no commit, composição
de fronteira externa, retry limitado com falhas SQLSTATE injetadas no PostgreSQL.
Essas injeções exercitam tratamento de falhas; não alegamos que provocam o detector
real de deadlocks. Os locks reais são observados nos testes concorrentes. Resta provar
recuperação por queda abrupta de processo em janelas de publicação/ACK quando esses
componentes existirem, além dos demais kinds e transportes.

## ADR-024 — Extensão incremental para WIN/LOSS

prepareWager compartilha validação/canonicalização; prepareBet permanece como fachada
BET-only. Nenhum campo novo é inserido em hashes BET. WIN inclui referência opcional
em ordem lexicográfica, LOSS exige zero. Reutilizamos domínio e um único processador.

Decisões aprovadas para os próximos incrementos desta etapa: comprovante pendente
imutável em tabela separada; replay pendente sem novo evento, resultado terminal
preferido quando o futuro worker concluir. Alternativa: mudar a PK da tabela de
resultados para histórico por estado; recusada para preservar o contrato terminal.
Referência ausente/BET compatível não terminal aguarda; vínculos/kind incorretos ou
BET rejeitada/falha geram INVALID_REFERENCE persistido. Lookup restrito ao provedor:
ID que só existe em outro provedor é ausente, sem vazamento entre provedores.
Crédito que ultrapassa o teto do saldo é rejeitado com DOMAIN_RULE_VIOLATION; Money
e limite SQL permanecem intactos. Implementação e evidência seguem nos incrementos.

ADR-024, persistência implementada: migration00006 amplia os resultados terminais
para WIN/LOSS e cria wager_pending_receipts. PK por transação garante um comprovante;
ambos são imutáveis, com saldo/versão verificados sob lock. Pendência não é resultado
terminal e não bloqueia a inserção dele futuramente. A função diferível legado
require_bet_result agora cobre os três kinds e pendências WIN. LOSS mantém as guardas
anteriores que proíbem ledger. Downgrade restaura versão5 somente sem dados novos;
com dados WIN/LOSS/pendentes recusa55000, preservando evidência em vez de apagá-la.
Alternativa de apagar comprovantes automaticamente foi recusada por perda de auditoria.

## ADR-025 — Um fluxo financeiro para BET, WIN e LOSS

ProcessWagerTransaction compartilha admissão/replay/locks/persistência/eventos/resultados.
Método apply concentra decisões por kind usando Wallet e validação de referência já
existente em WagerTransaction. Sem entidades/estratégias duplicadas, sem ORM no domínio.
Evento é escolhido pelo status; movimento opcional só controla Wallet/ledger/BalanceChanged.

WIN: referência opcional resolvida pelo provedor depois do lock da própria Wallet.
ledgerDirectionFor reutiliza validação local; pendência, INVALID_REFERENCE e overflow
seguem aprovações da ADR024. LOSS zero usa mesmo lock para fotografar saldo e versão
consistentes; custa serialização curta com movimentos da mesma carteira. Alternativa
sem lock dependeria de isolamento/snapshot adicionais e permitiria capturar estado
anterior a uma movimentação ainda em andamento. Não incrementa versão nem salva Wallet.

Não adicionamos locks de identidade da referência ou outra carteira depois do lock da
Wallet. READ COMMITTED permite reler estado confirmado pelo escritor anterior;
referências processadas são imutáveis. Uma operação não visível fica pendente, sem
bloqueio circular entre WINs. Reprocessador futuro deverá seguir admissão → Wallet →
consulta de referência e nunca reutilizar objetos de tentativa abortada. Nenhuma
redelivery ativa reprocessamento de pendência nesta etapa. Resultado terminal é lido
conforme lifecycle atual; receipt inicial permanece para auditoria.

Retentativas SQL continuam limitadas aos 40001/40P01 já aprovados. Falha de infraestrutura
não vira rejeição financeira. Scripts/testes em bancos descartáveis não aplicam migrations
ao principal. HTTP, consumers, publishers, REFUND/ROLLBACK e worker aguardam nova etapa.
Fontes: [READ COMMITTED](https://www.postgresql.org/docs/17/transaction-iso.html),
[locks PostgreSQL](https://www.postgresql.org/docs/17/explicit-locking.html).

Evidência final da ADR025: 62 testes PostgreSQL novos, incluindo 11 de concorrência,
50 WINs em 3 processos, 20 duplicatas LOSS/pendente, referências cruzadas, disputas de
identidade e carteiras independentes. Saldo reconciliado com ledger; callbacks não
retornam sucesso antes de commit, falhas diferíveis revertem tudo. Regressão completa:
678 testes distintos, typecheck/build OK; principal sem tabelas financeiras. Não se
alega ausência universal de deadlocks: provas cobrem os cenários observados e protocolo
cooperativo; novos writers precisam manter ordem de locks e constraints.

## ADR-026 — REFUND integral e unicidade por referência/tipo

A etapa autorizada mantém canonicalização, UOW, locks, mappers e eventos existentes.
Domínio já valida referência BET processada e mesmo valor; assertRefundAvailable
recebe evidência persistida do reembolso anterior para decidir duplicidade no domínio.
A aplicação coordena lookup e persistência da rejeição, sem repetir vínculos/aritmética.
O índice parcial existente continua a barreira definitiva, inclusive para SQL direto.

Ordem planejada: identidades da nova operação → Wallet → leitura da referência e
REFUND processado anterior. Sem locks novos na identidade da referência ou outra Wallet.
Rejeição DUPLICATE_REVERSAL é outra operação, com evento/snapshot próprios; replay é
mesma operação e não escreve. Pendência/overflow reutilizam políticas já aprovadas.

Limite explícito: unicidade é por tipo conforme README, não exclusão cruzada. REFUND(BET)
e ROLLBACK(BET) cabem em linhas distintas desse índice. A política dessa combinação
precisa ser discutida antes de habilitar ROLLBACK; não se permite implicitamente esse
fluxo pelo processador atual, que continua recusando ROLLBACK. Não mudamos constraints
para impor uma interpretação adicional. BET PENDING_REFERENCE é estruturalmente
impossível; mantemos espera para BET PENDING e ausência da referência.
Fontes: [índices parciais](https://www.postgresql.org/docs/17/indexes-partial.html),
[unicidade concorrente](https://www.postgresql.org/docs/17/index-unique-checks.html).

ADR026, persistência:00007 substitui três funções para aceitar/exigir resultados e
receipts REFUND, sem mudar tabelas/índices/bytes antigos. Down protegido recusa dados
REFUND; sem esses dados restaura00006 preservando WIN/LOSS/BET. Lookup dedicado por
referenceId interno, REFUND e PROCESSED reutiliza índice parcial e mapper. Nenhum lock
sobre referência é adicionado. Teste SQL contorna verificação local e comprova que o
índice existente ainda rejeita o segundo reembolso processado.
