# Contrato de trabalho neste projeto

Leia o README oficial completo antes de mudanças de escopo. O enunciado é a fonte
de verdade; não substitua requisitos por preferências. Responda em português brasileiro.

## Desenvolvimento incremental e ensino

- Atue como engenheiro e mentor: explique problema, alternativas, decisão e limites.
- Antes de decisões arquiteturais significativas, apresente alternativas e solicite
  participação do usuário. Pode avançar em escolhas rotineiras já autorizadas.
- Implemente uma funcionalidade coerente por vez, com testes apropriados e documentação.
- Mantenha `docs/LEARNING_GUIDE.md`: cada função/método/construtor/factory/helper/teste
  criado ou significativamente modificado deve ter nome e arquivo, responsabilidade,
  parâmetros e tipos, retorno, lógica passo a passo, chamadores, dependências, erros,
  justificativa e exemplo quando aplicável. Explique conceitos novos em português.
- Mantenha `ARCHITECTURE.md` para alternativas, decisões, trade-offs e limites.
- Após cada funcionalidade, relate: funcionalidade implementada, o que aprendemos,
  arquivos alterados, explicação do código, decisões técnicas, testes executados,
  hash/mensagem do commit e próxima etapa. Não alegue validações não executadas.
- O pedido inicial limita a entrega à primeira etapa coerente. Consulte
  `docs/IMPLEMENTATION_PLAN.md` para o restante, sem implementar tudo de uma vez.

## Git

- Antes de mudanças, execute `git status`, identifique a branch e mudanças anteriores.
- Preserve trabalho do usuário; interrompa somente operações que conflitem com ele.
- Revise o diff e crie um Conventional Commit por funcionalidade, incluindo testes
  e documentação. Adicione arquivos explicitamente; não use `git add .`.
- Não faça push, force push ou reescrita destrutiva de histórico sem autorização.
- Não versione segredos, dependências instaladas, binários ou artefatos de execução.

## Garantias financeiras

- Dinheiro nunca usa `number`, `float` ou `double`; transporte usa strings decimais.
- Domínio encapsulado em classes, factories e transições explícitas; sem Nest/ORM no domínio.
- Banco garante unicidade, não-negatividade e ledger imutável; memória/FIFO não bastam.
- Nenhum evento antes do commit; nenhuma alteração de saldo sem ledger correspondente.
- Testes de persistência/concorrência/mensageria usam PostgreSQL e SQS reais em containers.
- Diferencie plano, implementação e evidência. A base HTTP não prova correção financeira.
