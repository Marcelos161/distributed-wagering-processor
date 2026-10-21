# Arquitetura e registro de decisões

Estado em 21/10/2026: **somente a base NestJS foi implementada**. O restante é
proposta, não garantia já entregue. Fonte de requisitos: [README](README.md).
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
consegue responder. Nenhum acesso a banco/fila ocorre. `/health/ready` ainda não
existe (404): não há dependências configuradas para atestar prontidão.

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

## Decisões propostas para as próximas etapas

Estas propostas foram apresentadas para participação do usuário; a base atual
não depende da adoção delas. Detalhes serão fechados antes de sua implementação.

| Tema | Recomendação | Alternativas e trade-offs |
|---|---|---|
| ORM | MikroORM, entidades de persistência separadas do domínio | TypeORM é aceito; separar mapeamento exige código adicional, mas mantém domínio independente |
| Emulador | LocalStack em Compose | MiniStack é permitido; verificar disponibilidade/licença e imagem antes de fixar versão |
| Dinheiro | `bigint` em centavos internamente; string decimal na borda; PostgreSQL `NUMERIC(p,2)` | Decimal de precisão configurada também serve; bigint elimina arredondamento implícito nas operações exigidas (soma/subtração), mas exige serialização explícita. Definir limite `p` e rejeição de overflow antes do schema |
| Concorrência | Lock pessimista na linha da wallet durante a transação SQL | Lock otimista precisa retries; UPDATE condicionado também protege saldo, mas exige coordenar resultado, ledger e reversões. Lock por wallet simplifica raciocínio e limita vazão de uma carteira muito disputada |
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
2. Definir tratamento de referência existente porém pendente, rejeitada ou falha,
   além de referência inexistente. `WIN` pode ter referência opcional: definir
   validação e espera quando ela vier preenchida.
3. Quantias zero em BET/WIN/REFUND/ROLLBACK não estão completamente especificadas.
   Definir comportamento em relação a ledger e `version`; abertura zero não gera OPENING.
4. Contratos exigem escala fixa 2 e citam rejeição de mais de 2 casas. Decidir se
   `"25"`/`"25.0"` serão rejeitados ou normalizados antes de definir hash canônico.
5. Estados terminais não mudam. Especificar snapshot de replay, respostas pendentes
   e falhas permanentes sem marcar uma falha transitória como terminal.
6. Destino dos eventos Outbox, ordenação por agregado e política de retries precisam
   de decisão explícita; o README não nomeia uma fila de saída.

## Limitações atuais

Não existem domínio financeiro, banco, migrations, filas, idempotência, autenticação,
reconciliação, métricas ou testes distribuídos. Nenhuma garantia financeira foi
demonstrada. O teste HTTP real desta etapa não substitui as integrações exigidas.

## Referências consultadas na base

- [Bun: instalação](https://bun.sh/docs/installation)
- [Bun: TypeScript](https://bun.sh/docs/typescript)
- [Nest: primeiros passos](https://docs.nestjs.com/first-steps)

As versões exatas também foram consultadas no registro npm e verificadas localmente
por instalação, typecheck, teste HTTP e execução compilada.
