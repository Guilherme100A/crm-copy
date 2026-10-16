# Harness E2E por worktree (T17, T118, T122)

`node scripts/e2e/serve.mjs` sobe banco descartável, API (fakes, `E2E=1`, worker in-process) e, se houver, a web.
Vários worktrees rodam o harness ao mesmo tempo na mesma máquina sem dividir nada:

| Recurso | Derivação (hash sha256 do caminho do worktree, `scripts/e2e/ports.mjs`) | Sobrescrever |
|---|---|---|
| Portas | web = 20000 + 2·(hash mod 10000), api = web + 1 | `E2E_WEB_PORT`, `E2E_API_PORT` (`0` = livre) |
| Redis db | 2 + (hash mod 14), ou seja 2..15 (0 é o padrão, 1 é dos testes vitest) | `E2E_REDIS_URL` (exatamente essa URL, db incluso) |
| Stream de eventos WhatsApp | `wsm:events:e2e-<8 hex do hash>` | `WA_EVENTS_STREAM` |
| Prefixo das filas BullMQ | `crm-e2e-<8 hex do hash>` (passado em `CRM_QUEUE_PREFIX`; vale quando a T121 ler a variável) | `CRM_QUEUE_PREFIX` |

`E2E_PORTS_ROOT` finge outro worktree para todas as derivações.

## Reserva do db do Redis

O db derivado pode coincidir entre dois worktrees (14 opções). Por isso, ao subir, o `serve.mjs` grava no db a
chave `e2e:harness:owner` (`{ root, pid }`, `SET NX EX 30`, renovada a cada 10 s e apagada ao sair). Se o db já
tem dono de outro worktree com o processo vivo, ele tenta o próximo (cíclico em 2..15) e avisa no stderr. Dono
morto (harness derrubado sem limpar) é substituído. Com `E2E_REDIS_URL` não há reserva: usa-se aquela URL.

Isso importa porque o `POST /__e2e/reset` apaga as chaves `crm:*` do db inteiro e porque o grupo `crm` do stream
entrega cada evento a um só consumidor: no db 14 fixo de antes, dois harnesses perdiam eventos um do outro.

## Onde ver o que foi usado

- stdout: `E2E_REDIS_URL=<url, senha mascarada>` e `E2E_WA_EVENTS_STREAM=<stream>`, antes de `E2E_READY`;
- `test-results/e2e-server.json`: campo `redis` = `{ url, db, stream, queue_prefix, source: "derived" | "env" }`;
- `GET /__e2e` devolve `{ seed, stream, group }` efetivos.

## Disparos em massa na montagem de produção (T122)

`startProductionWorker` (via `configureWorkerProduction`) chama `configureMassDispatch`: a fila `mass-dispatch`
prepara o disparo criado pela API (T60) e roda os ticks (T74). Cada envio inicia o fluxo do alvo com o mesmo
registry de nós da produção (a mensagem fica no chat com `sender_type: flow`), o LLM das empresas e os timers
`flow-timer`/`flow-step`.

## Reset serializado e bancos órfãos (T124)

- `POST /__e2e/reset` roda um por vez por processo da API: o segundo espera o primeiro (resposta com `waited_ms`).
  O timeout vem de `E2E_RESET_TIMEOUT_MS` (padrão 60000, também em `reset_timeout_ms` no `e2e-server.json`); ao estourar,
  responde 504 `{ ok: false, error: "reset_timeout" }`, mas o reset continua e segura a fila até terminar.
- Ao subir, o harness apaga bancos `crm_e2e_*`, `crm_test_*` e `crm_acc_*` sem conexão ativa (`pg_stat_activity`) e mais
  antigos que `E2E_ORPHAN_MIN_AGE_MIN` minutos (padrão 30; idade pelo arquivo `PG_VERSION` do banco). Nunca toca outros
  nomes (`crm`, `postgres`, `wsm*`…) nem os bancos de harnesses vivos (registrados na reserva `e2e:harness:owner` do
  Redis). O DROP é sem FORCE. `E2E_ORPHAN_CLEANUP=0` desliga. Resultado: `orphans` no `e2e-server.json` e
  `E2E_ORPHANS_DROPPED=<n>` no stdout. Função: `cleanupOrphanDatabases` em `scripts/e2e/orphans.mjs`.
