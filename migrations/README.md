# Migrations de produção

Nenhuma migration de schema foi criada nesta etapa. A demonstração é gerada
em diretório temporário e executada apenas em banco `dwp_test_<UUID>`.

Use `bun run migration:create --name NomeDescritivo` para gerar uma migration
vazia com a CLI oficial. Implemente e revise `up` e `down`, teste no banco
descartável e versione o arquivo junto à funcionalidade. Nunca edite uma migration
que já tenha sido aplicada em ambiente compartilhado; acrescente outra.

Criação vazia explícita evita gerar drops a partir do registro de entidades ainda
vazio. Snapshot está desabilitado nesta etapa de SQL revisado manualmente.
Não use `schema:update`, `schema:fresh` ou `migration:fresh` no banco principal.
`down` não é backup: remover tabela/coluna pode perder dados. Reversibilidade de
DDL só é demonstrada nos bancos descartáveis dos testes.
