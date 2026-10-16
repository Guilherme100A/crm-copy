# Testes sob carga: filas, Redis, teardown e relógio (T126)

Vários worktrees rodam suítes ao mesmo tempo nesta máquina, no mesmo Postgres (`localhost:5432`) e no mesmo Redis (`localhost:6379`, db 1). As regras abaixo valem para os testes `*.unit.test.ts` e `*.db.unit.test.ts` de `apps/*` e `packages/*`.

## Prefixo de fila por arquivo

- O `vitest.config.ts` de cada pacote define o prefixo da **execução** (`CRM_QUEUE_PREFIX=crm-t-<pid>-<rand>`, `WA_QUEUE_PREFIX=wsm-t-…`, T121).
- O `src/test-setup.ts` do pacote (em `setupFiles`, com caminho absoluto, então vale também com `mergeConfig` e outro `root`) roda antes de **cada arquivo** e chama `isolateTestQueues(expect.getState().testPath)` de `@crm/db/testing`. O prefixo fica `<prefixo da execução>-f<hash do arquivo>-<rand>`, por exemplo `crm-t-4120-ab12cd-f0a1b2c3d-9f3e`.
- Assim, um worker de um arquivo nunca consome um job enfileirado por outro arquivo da mesma execução, nem de outra execução.
- `testQueuePrefix()` devolve os prefixos efetivos (`{ crm, wa }`) do processo.
- Leia o prefixo na hora de criar a fila ou o worker (`crmQueuePrefix()`, `defineQueue`, `defineWorker`). Não guarde o prefixo em constante de módulo.
- Um teste que precisa de prefixo próprio (por exemplo um boot de produção com `env`) pode sobrescrever `process.env.CRM_QUEUE_PREFIX` no `beforeAll` e restaurar no `afterAll`.
- Pacotes sem filas nos testes (`ai`, `node-kit`, `shared`, `wa-port`, `web`) não têm `test-setup.ts`.
- A prova é `packages/core/src/jobs/queue-isolation-{a,b}.db.unit.test.ts`: os dois arquivos usam a mesma fila, cada um com o seu prefixo (AC-T126-01).

## Redis exclusivo para quem apaga chaves em massa

- Teste que apaga chaves por padrão (como o reset do harness E2E, que apaga `crm:*`) não pode rodar no db 1 compartilhado nem num db fixo.
- Use `claimTestRedisDb(expect.getState().testPath)` de `apps/api/src/test-setup-redis.ts`. Ele reserva um db livre entre 2 e 15 pela mesma reserva dos harnesses (`scripts/e2e/redis-claim.mjs`, chave `e2e:harness:owner` com TTL renovado). O db inicial é escolhido pelo hash do arquivo.
- Comece limpo com `clearCrmKeys(redis)` e chame `release()` no `afterAll`, depois de fechar as conexões.
- Quem usa isso: `apps/api/src/e2e/e2e.db.unit.test.ts` e `e2e-reset.db.unit.test.ts`. Antes usavam o db 13 fixo, e duas execuções simultâneas apagavam as chaves uma da outra (AC-T17-03).

## Teardown

- Ordem no `afterAll`: (1) workers, filas, schedulers e hubs em segundo plano (`stop()`/`close()`); (2) servidores HTTP; (3) pools do Postgres (`db.$client.end()`); (4) Redis (`quit()`); (5) `temp.drop()` por último.
- `TempDatabase.drop()` (`@crm/db/testing`) **não usa** `DROP … WITH (FORCE)`. Ele espera as conexões do banco terminarem (até `dropWaitMs`, padrão 15 s) e faz um `DROP` simples.
- Se ainda houver conexão viva no fim da espera, o banco **fica**: o processo recebe um aviso `TempDatabaseWarning` e a limpeza de órfãos (`scripts/e2e/orphans.mjs`) remove o banco depois. Nada é derrubado por baixo de quem ainda usa o banco, então não aparece `57P01 admin_shutdown`.
- Se aparecer o aviso `banco temporário … mantido`, algum pool ou worker do arquivo não foi fechado antes do `drop()`. Corrija a ordem.

## Tempo: sem sleep para medir janelas

- Não use `sleep`/`setTimeout` real para provar que algo **ainda não** aconteceu dentro de uma janela (buffer, debounce, timers). Sob carga, o tempo gasto em cada passo encurta a janela e o teste falha.
- Prefira o agendador ou relógio injetável do código (`AiAgentRuntime` aceita `scheduler`; os serviços aceitam `now`) ou fake timers do vitest (`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(ms)`, com `vi.useRealTimers()` no `finally`).
- Exemplos: AC-T68-01 em `packages/core/src/ai-runtime/runtime.db.unit.test.ts` (relógio virtual no agendador) e `scheduler.unit.test.ts` (fake timers).
- Para esperar algo que **vai** acontecer (job processado, mensagem gravada), use um laço `until` com prazo generoso (≥ 60 s) e passos curtos, nunca um sleep fixo.
- Uma espera curta fixa só serve como folga para um evento indevido aparecer **depois** de o esperado já ter acontecido (por exemplo, "não reenviou"). Ela nunca é a medida da janela.

## Corridas com eventos internos

- O chat aparece na API logo depois do commit do ingest, mas os ouvintes do `crm.inbound` (fluxos, agente de IA) rodam depois, em sequência.
- Um teste que muda o chat (por exemplo `PATCH ai_agent_id`) e precisa que a mensagem anterior **não** seja vista pela mudança deve esperar o `crm.inbound` dela terminar.
- Para isso, inscreva um ouvinte com `onCrmInbound` antes de receber a mensagem. Ele entra depois dos ouvintes do processo, então quando ele dispara os outros já rodaram. Exemplo: AC-T120-03 em `apps/worker/src/boot/production-worker.db.unit.test.ts`.
