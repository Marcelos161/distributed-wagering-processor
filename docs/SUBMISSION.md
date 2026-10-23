# Preparação para envio

Entrega técnica publicada em repositório privado do candidato:
<https://github.com/Marcelos161/distributed-wagering-processor>. A branch `main`
acompanha `origin/main`. Nenhum formulário ou mensagem de recrutamento foi enviado.

## Passos para envio

1. Obter os nomes de usuário GitHub dos avaliadores e conceder acesso `Read` em
   **Settings → Collaborators → Add people**, pois o repositório é privado.
2. Confirmar que cada avaliador consegue abrir a URL acima e visualizar a `main`.
3. No formulário oficial confirmado, preencher nome/e-mail reais do candidato,
   URL do repositório e resumo abaixo. Revisar e enviar manualmente, ou autorizar
   explicitamente automação com o endereço correto. Esses dados não foram inventados.

## Texto sugerido para descrição técnica

> Distributed Wagering Processor em Bun, TypeScript strict, NestJS, PostgreSQL,
> MikroORM e SQS em LocalStack. Implementa OPENING, BET, WIN, LOSS, REFUND e ROLLBACK,
> ledger imutável, idempotência persistente, Inbox/Outbox e referências fora de ordem.
> A integridade usa transações SQL, locks por carteira e constraints, com API HTTP,
> consumer, publisher, resolução de pendências e reconciliação. Foram aprovados 792
> testes distintos, incluindo três processos reais, concorrência, DLQ e crashes nos
> intervalos críticos de commit/ACK/publicação, além de lint, typecheck e build.
> Instalação limpa e inicialização dos quatro papéis foram verificadas. O README
> preserva o enunciado e aponta para um guia reproduzível. Autenticação foi omitida
> conforme permitido; perfil local, entrega at-least-once e limites do emulador estão
> documentados. Repositório:
> https://github.com/Marcelos161/distributed-wagering-processor

## COMO DEFENDER ESTE PROJETO NA ENTREVISTA

1. **Dinheiro exato.** Strings no transporte, decimal.js na classe Money e NUMERIC
   com CHECK de escala/faixa. Evita erro binário e arredondamento silencioso de 1.005.
2. **Lock pessimista por carteira.** O saldo é recurso disputado: ler sob FOR UPDATE
   faz a segunda BET 80 enxergar 20 e ser rejeitada. Carteiras distintas continuam em paralelo.
3. **Unicidade no banco.** Locks organizam a admissão, mas índices impedem identidades
   duplicadas mesmo com outro processo ou SQL direto. FIFO sozinho não protege dinheiro.
4. **Replay histórico.** A resposta imutável é gravada no commit. Repetir uma BET
   retorna o saldo observado por ela, não o saldo atual depois de outros movimentos.
5. **Ledger e saldo juntos.** Wallet é estado atual; ledger é trilha auditável.
   Triggers diferíveis exigem correspondência de versão e valores ao confirmar SQL.
6. **Inbox e ACK.** Se o servidor cair depois do commit e antes do ACK, SQS reentrega.
   Inbox persistida reconhece a mensagem; o sistema confirma sem debitar novamente.
7. **Outbox e duplicatas.** A intenção de publicar entra no mesmo commit financeiro.
   Publisher usa lease fora da chamada de rede. Crash após enviar pode repetir evento;
   eventId estável permite deduplicação no destino, sem promessa de exactly-once.
8. **REFUND versus ROLLBACK.** REFUND devolve BET; ROLLBACK inverte BET/WIN/REFUND.
   Uma compensação bem-sucedida por referência evita dupla devolução. Reverter REFUND
   não reabre a BET; débitos de reversão exigem saldo suficiente no momento da execução.
9. **Referências fora de ordem.** Comprovante pendente imutável e job durável guardam
   o pedido; worker relê referência e saldo com locks, resolve ou expira com código
   auditável. Indisponibilidade técnica faz rollback, não rejeição financeira fictícia.
10. **Evidência e limites.** Três PIDs de API/consumer, SQL real, SQS real e SIGKILL
    provam casos críticos; não equivalem a benchmark nem a produção. Auth omitida,
    LocalStack descartável, catálogo de moedas e reconciliação O(N) são limites claros.
