# Migrations de produção

Migration20261023000001 cria wallets e o domínio SQL financial_amount.
As migrations financeiras versionadas são testadas em bancos `dwp_test_<UUID>`.
A demonstração antiga continua isolada em diretório temporário.
Não aplicamos as migrations no banco principal automaticamente nesta etapa.

Use `bun run migration:create --name NomeDescritivo` para gerar uma migration
vazia com a CLI oficial. Implemente e revise `up` e `down`, teste no banco
descartável e versione o arquivo junto à funcionalidade. Nunca edite uma migration
que já tenha sido aplicada em ambiente compartilhado; acrescente outra.

Criação vazia explícita evita gerar drops a partir do registro de entidades ainda
vazio. Snapshot está desabilitado nesta etapa de SQL revisado manualmente.
Não use `schema:update`, `schema:fresh` ou `migration:fresh` no banco principal.
`down` não é backup: remover tabela/coluna pode perder dados. Reversibilidade de
DDL só é demonstrada nos bancos descartáveis dos testes.

Migration20261023000002 acrescenta wager_transactions, referências, constraints,
índices e trigger de lifecycle. Seu down preserva wallets; reverta migrations
posteriores primeiro. Funções SQL ficam versionadas na própria migration para que
mudanças futuras no domínio TypeScript não alterem o histórico de DDL.


Migration20261023000003 cria ledger, imutabilidade e consistência entre as três tabelas.
Exige que dados anteriores ainda não tenham efeitos financeiros sem histórico;
caso contrário falha, sem apagá-los. O comando `bun run test:financial` testa as
três migrations pelo Migrator oficial em bancos novos descartáveis, inclusive up
repetido, down e reaplicação. Não usar auto-sync/schema:fresh.

DOWN destrói histórico. Depois de reverter só a terceira migration, wallets com
saldo/version acumulados não permitem reaplicação sem um plano de reconstrução de
histórico. Não desative a guarda para contornar isso. A demonstração de reversibilidade
completa usa down até 0 e up num banco descartável, sem dados a preservar.

As funções SQL estão embutidas nas migrations, não importadas do código de domínio
que pode evoluir. Somente a credencial de migrations aplica DDL. App tem DML limitado;
nenhuma migration foi aplicada ao banco wagering durante esta etapa.
