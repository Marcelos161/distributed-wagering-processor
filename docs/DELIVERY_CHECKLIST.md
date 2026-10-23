# Auditoria da missão final

Base auditada: `1d48b8b`, branch main limpa, sem remote configurado. README oficial
lido integralmente; esta missão autoriza avançar continuamente pelas fases restantes.
Os estados abaixo descrevem a auditoria inicial e serão atualizados com evidências.

| Requisito oficial | Estado inicial | Evidência / trabalho restante |
|---|---|---|
| Stack, Money, Wallet, ledger, WagerTransaction | IMPLEMENTADO E TESTADO | Suítes unitárias e PostgreSQL existentes |
| Schema, migrations, permissões, atomicidade | IMPLEMENTADO E TESTADO | Migrations 00001–00007 e testes descartáveis |
| OPENING, BET, WIN, LOSS, REFUND | IMPLEMENTADO E TESTADO | Casos de uso; replay, rejeição e concorrência reais |
| ROLLBACK e proteção entre compensações | IMPLEMENTADO E TESTADO | 14 testes PostgreSQL, incluindo dois processos e SQL direto; 667 testes executados na fase 1 |
| Domínio/repositórios Inbox e Outbox | IMPLEMENTADO E TESTADO | Atomicidade local, sem transporte operacional |
| Referências pendentes: registro e replay | IMPLEMENTADO E TESTADO | Comprovante e resultado terminal separados |
| Worker automático de referências | IMPLEMENTADO E TESTADO | 9 testes PostgreSQL, incluindo SIGKILL/restart/SIGTERM, retry e TTL |
| HTTP financeiro, consultas e paginação | PENDENTE | Rotas exatas da seção 9 |
| Consumer SQS / ACK pós-commit | PENDENTE | Inbox existente não prova consumer |
| Publisher Outbox | PENDENTE | Claim, confirmação, retry e crash |
| Reconciliação pública | PENDENTE | Asserções de teste existem; falta caso de uso/endpoint |
| Observabilidade / readiness | PENDENTE | Liveness/log de startup existentes; falta integração |
| ≥3 processos financeiros | IMPLEMENTADO E TESTADO | BET/WIN/REFUND; falta cenário completo de transporte/crash |
| Docker PostgreSQL/SQS | IMPLEMENTADO E TESTADO | Containers healthy; broker local perde mensagens ao recriar |
| Instalação limpa e entrega final | PENDENTE | Scripts, documentação, testes e revisão final |
| Autenticação | PENDENTE | Omissão permitida; documentar e criar extensão explícita |

Estado IMPLEMENTADO, MAS SEM TESTE INTEGRADO será usado somente quando houver código
novo ainda sem evidência ponta a ponta. Não equivale a requisito concluído.

Eliminatórios: dinheiro em number; saldo negativo por corrida; efeito duplicado;
idempotência apenas em memória; correção só numa instância; publicação antes do
commit; movimento sem ledger; substituir PostgreSQL/SQS integralmente por mocks.
Todas as migrations de validação continuam limitadas a bancos descartáveis.
