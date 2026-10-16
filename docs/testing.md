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

# Banco-modelo das migrações (T128)

Rodar todas as migrações em cada banco descartável ficou caro (~1,5 a 2,5 s por banco, e muito mais com vários processos ao mesmo tempo). Agora as migrações rodam **uma vez por versão** delas, num banco-modelo, e cada banco descartável é uma cópia (`CREATE DATABASE … TEMPLATE`).

## Como funciona

- **Nome do modelo:** `crm_tpl_<set>_<hash12>`, um por conjunto de migrações (`all`, `wa`, `crm`). O hash é o SHA-256 do `meta/_journal.json` e dos `.sql` (nome e conteúdo) de cada pasta do conjunto (`packages/db/drizzle/<set>`), com fim de linha normalizado (CRLF e LF dão o mesmo hash). Qualquer migração nova ou alterada gera outro nome, então outro modelo.
- **Criação:** `ensureTemplateDatabase` (`packages/db/src/testing/template.ts`, exportado por `@crm/db/testing`). O processo toma `pg_advisory_lock(7345128, hashtext(<nome>))` numa conexão ao banco `postgres` (advisory locks valem por banco, então todos usam o mesmo). Com o lock, confere de novo: se o modelo já existe, só reaproveita. Senão, cria o banco, migra, marca `IS_TEMPLATE true` e `ALLOW_CONNECTIONS false` e espera as conexões da migração terminarem. Vale entre processos e entre worktrees: o primeiro cria, os outros esperam o lock e reaproveitam. Um banco com o nome do modelo que **não** é modelo é sobra de um criador que morreu no meio; é removido e refeito.
- **Clone:** `cloneTemplateDatabase(nome, { baseUrl, set })`. Se o Postgres recusa a cópia porque há sessão na origem (`55006`, "source database is being accessed by other users"), tenta de novo com espera crescente (50 ms a 500 ms) por até 15 s. Se o modelo sumiu entre a checagem e o clone (`3D000`, removido pela limpeza), refaz o modelo e clona.
- **`createTempDatabase({ migrate: true })`** clona o modelo do `set` pedido e não roda migração nenhuma. O retorno traz `template: { name, created }`. `created` é `true` só na chamada que criou e migrou o modelo. Sem `migrate`, nada muda: banco vazio.
- **Harness E2E** (`scripts/e2e/serve.mjs`): o banco `crm_e2e_*` é clonado do modelo `all` por `scripts/e2e/template-db.mjs`. Quando o modelo já existe, esse script clona em JS puro; carregar o `template.ts` pelo tsx custa ~1 s e só acontece se for preciso criar o modelo. Depois a API confere as migrações (nenhuma pendente) e aplica o seed. O `POST /__e2e/reset` esvazia as tabelas e reaplica o seed nesse mesmo banco clonado. O harness imprime `E2E_DATABASE_TEMPLATE` e `E2E_DATABASE_READY_MS` e grava `database_template` no `e2e-server.json`.
- O modelo só contém o **schema** (e o controle das migrações). Seed e dados de teste vêm sempre depois do clone.

## Limpeza dos modelos antigos

- `cleanupOrphanDatabases` (`scripts/e2e/orphans.mjs`, chamada pelo harness ao subir) também considera `crm_tpl_(all|wa|crm)_<12 hex>`.
- Os modelos do **hash atual** deste checkout nunca caem (`kept` com motivo `current`). O hash é calculado em JS puro por `currentTemplateNames()`; a cópia JS do hash é comparada com a do TS em `template.unit.test.ts`.
- Um modelo de hash antigo cai quando está sem conexão, é mais antigo que `E2E_ORPHAN_MIN_AGE_MIN` (padrão 30) e ninguém o está criando (`pg_try_advisory_lock` no mesmo lock da criação; senão fica com o motivo `locked`). Antes do `DROP`, o modelo perde o `IS_TEMPLATE`. Se o `DROP` falhar, volta a ser modelo e fica (`in_use`).
- Worktrees com migrações diferentes (tarefas que criam migração) têm modelos diferentes. A limpeza feita num worktree pode remover o modelo de outro, se ele tiver mais de 30 min; o outro só recria na próxima chamada (custa uma migração completa, uma vez).

## Forçar a recriação ou desligar

- `node scripts/e2e/template-db.mjs` lista os modelos do hash atual e diz se existem.
- `node scripts/e2e/template-db.mjs --rebuild` remove os modelos do hash atual e recria o `all`. `--drop` só remove. Use quando o modelo ficar inconsistente (por exemplo, alguém mexeu nele à mão). Mudar uma migração **não** exige isso: o hash muda sozinho.
- `dropTemplateDatabases(baseUrl, nomes?)` de `@crm/db/testing` faz o mesmo por código.
- `CRM_TEST_TEMPLATE=0` desliga o modelo: `createTempDatabase({ migrate: true })` volta a migrar o banco inteiro e o harness cria o banco vazio para a API migrar. Serve para diagnóstico e para medir.

## Medições (2026-10-16, esta máquina, com outros agentes rodando)

Postgres 16.4 nativo, modelo `all` com 13 MB. Os números oscilam com a carga da máquina.

| Cenário | Migração completa (`CRM_TEST_TEMPLATE=0`) | Clone do modelo |
|---|---|---|
| `createTempDatabase({ migrate: true })`, 1 por vez (mediana de 5) | 1,75 a 2,36 s | 0,81 a 0,86 s |
| 8 `createTempDatabase({ migrate: true })` simultâneos (mediana por banco) | 7,2 a 8,0 s | 3,4 a 5,7 s |
| Só o `CREATE DATABASE … TEMPLATE` (13 MB, `STRATEGY WAL_LOG`, o padrão) | — | 0,56 a 0,77 s |
| Harness `serve.mjs` sem web, até `E2E_READY` (3 rodadas cada) | 5,0 a 5,9 s | 4,2 a 5,6 s (clone 0,6 a 1,2 s) |
| Criação do modelo (só na primeira vez por hash) | — | ~3,7 s (migração + `ALTER`) |

- O `STRATEGY FILE_COPY` foi medido e é pior: 1,2 a 1,9 s, porque força um checkpoint. Fica o padrão `WAL_LOG`.
- No harness, quase todo o tempo é a subida da API (tsx, worker in-process). O banco deixou de ser a maior parte: o clone leva cerca de 0,7 s, contra cerca de 1,5 s da migração dentro da API.
- `POST /__e2e/reset` no banco clonado: 50 a 70 ms. Ele não refaz migração; só esvazia as tabelas e reaplica o seed.
