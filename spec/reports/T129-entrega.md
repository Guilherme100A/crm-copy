# T129 — entrega (Operário)

```text
DONE T129 operario
STATUS: DONE
Arquivos alterados:
  - packages/core/src/meta-ads/structure/service.ts
  - packages/core/src/meta-ads/structure/service.db.unit.test.ts
  - apps/worker/src/jobs/meta-ads/production-bundle-error.db.unit.test.ts (novo)
Verify: 0 (node spec/verify/verify.mjs T129 --role operario --base 170f8ae) — APROVADO, 3 arquivos no escopo
Tempo: ~12 min (01:10 → 01:22)
```

## Causa
`MetaBundleService.enqueue` usava jobId fixo `bundle-<key>` fora do force_refresh. Bundle `ready` com erro de conta
não vai ao cache de 5 min e o estado era apagado; o GET `async=1` seguinte gravava `loading` e fazia `add` com o mesmo
jobId, que o BullMQ ignorava (job concluído retido) → `loading` até o estado expirar (15 min).

## Correção (só no core; API e worker inalterados)
1. **jobId único por geração**: `bundle-<key>-<ts36><rand>` (sem `:`; lição do BullMQ).
2. **Dedupe de concorrência pela chave de estado**: o GET async sem force grava o estado com `SET … EX 900 NX`
   (`claimState`). Quem grava, publica e enfileira; quem perde a corrida devolve o estado já gravado sem enfileirar.
   `force_refresh` continua sobrescrevendo o estado (`refreshing`) e criando job novo.
3. **Pronto com erro fica no estado por `BUNDLE_ERROR_TTL_S` = 60 s** (em vez de apagar). O GET async seguinte
   (ex.: cliente relendo após o SSE `ready`) recebe 200 `ready` com `errors[]`, sem job novo e sem laço
   reler → job → ready → reler batendo na Meta. Depois dos 60 s, o próximo GET enfileira um job novo, que roda.
   Pronto sem erro: igual a antes (cache 5 min + estado apagado).
4. Limite de uso (caminho que não grava estado): jobId `bundle-<key>-rl-<blockedUntil>`. Os GETs da mesma janela
   de limite reaproveitam o job adiado; uma janela nova gera job novo.

## Testes
- Core (`service.db.unit.test.ts`; o fake `enqueue` agora imita o BullMQ e ignora jobId repetido):
  AC-T129-01 (erro → releitura `ready` com errors, TTL ≤ 60 s; expirado → job novo com outro jobId → pronto sem erro → cache),
  AC-T129-02 (cache sem job ×3; force_refresh ×2 → 2 jobs novos), AC-T129-03 (5 GETs simultâneos → 1 job, inclusive
  depois de um pronto com erro expirado), e limite de uso (mesma janela → 1 job `-rl-`).
- Montado como produção (`apps/worker/src/jobs/meta-ads/production-bundle-error.db.unit.test.ts`):
  `startProductionWorker` + `createProductionApiDeps` + BullMQ real + FakeMetaGraph `failAccount`. Cobre os 3 ACs pela
  rota HTTP e conta os jobs na fila (`queue.getJobs`).
- **Prova de regressão**: com o `service.ts` da base (170f8ae) trocado temporariamente, o teste montado falha com
  `timeout esperando pronto com erro` (preso em loading) e 3 testes do core falham. Com a correção, todos passam.
- A expiração dos 60 s é simulada com `DEL` da chave de estado. Não há espera real.

## Notas / pendências
- Nenhum teste em `tests/**` depende do jobId antigo (grep feito). Não toquei `tests/**`.
- Não há consumidor web de `structure-bundle` na main ainda. A tela futura deve tratar `ready` com `errors[]` como
  estado final e não reler em laço; no máximo um "tentar de novo" (o `force_refresh` já cria job novo).
- Fora do escopo: se o job `meta-sync` falhar por erro não tratado (não de conta, não de limite), o estado `loading`
  ainda vale até os 15 min (comportamento anterior). Sugestão para uma tarefa futura: `runJob` apagar o estado nesse caso.
- Sem migration e sem boot novo: nada para ligar em `production.ts`.

## Retrabalho (T106 Bug 2: limite da Meta no modo async) — 01:45 → 01:52; verify exit 0

**Causa:** o job `meta-sync` que caía no limite só lançava `MetaRateLimitedError` (o worker adia). O estado ficava em
`refreshing`/`loading` e o GET `async=1` seguinte achava o cache de 5 min (lido antes de qualquer checagem de limite) e
devolvia `ready cached:true warnings []`. Só o sync com `force_refresh` passava pelo `rateLimitedFallback`.

**Correção (só `packages/core/src/meta-ads/structure/service.ts`; worker e API inalterados):**
1. `runJob`: em `MetaRateLimitedError`, grava no estado o mesmo fallback do sync e publica no SSE antes de relançar
   (o worker continua adiando o job). TTL do estado = até o `retryAt` (teto de 15 min). Quando o job adiado roda e
   termina, o `build` apaga ou substitui o estado como antes.
2. `getBundle` async sem force: com cache e uma conta em espera de limite, devolve o cache com `warnings: ['rate_limited']`.
   O sync sem force fica como antes (cache sem aviso). O T101 só exige o aviso no sync com `force_refresh`.
3. `rateLimitedFallback` sem último pronto: `status: 'ready'` (vazio, `rate_limited`) em vez de `loading`, no sync e no
   async. Nada está sendo montado nessa hora. A UI deve mostrar o aviso, não um spinner.

**Testes (core `service.db.unit.test.ts`, FakeMetaGraph `setUsage` 95%):**
- com cache: async+force → `refreshing` → job cai no limite → SSE `ready` + `rate_limited` → GET async: `ready cached:true
  warnings ['rate_limited']` com as linhas do cache; o sync com force dá o mesmo resultado; nenhum job extra.
- sem cache: async → `loading` → job cai no limite → SSE `ready` + aviso → GET async: `ready`, `rate_limited`, linhas
  vazias, TTL do estado ≤ 15 min, 1 job só; o sync dá o mesmo status e aviso.
- **Prova de regressão:** com o `service.ts` da base, os 2 testes falham. Com a correção, os 12 testes do arquivo e
  os 18 da pasta `structure/` passam.

**Notas / pendências:** a UI da T106 já trata o aviso. Com o bundle vazio em `ready` + `rate_limited`, ela deve mostrar
o aviso e não a tabela vazia como se não houvesse dados. Isso fica para a T106 conferir. O teste montado como produção
(`production-bundle-error.db.unit.test.ts`) não foi estendido ao limite, porque o caso já é coberto no core sem fila real.
