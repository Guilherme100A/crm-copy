# T102 — Operário (Baluarte) — entrega parcial

Base: be546d6. Sem commit. Só correções de integração, nenhuma feature nova.

## Correções (arquivo · causa · tarefa dona)
1. **Fuso fora da lista → 422** · `apps/api/src/routes/companies/index.ts` (refine no `time_zone` de POST/PUT) e `packages/core/src/companies/service.ts` (`isSupportedTimeZone`, novo, aceita a lista e o nome curto `America/Buenos_Aires`) · causa: `normalizeTimeZone` gravava America/Sao_Paulo com 200 · dona T22.
   - Testes: `apps/api/src/routes/companies/companies.db.unit.test.ts` (novo) e ajuste aditivo em `packages/core/src/team/team.unit.test.ts` (caso de `isSupportedTimeZone`).
2. **`company_inactive` global na web** · `apps/web/src/lib/http.ts` (`COMPANY_INACTIVE`, `isCompanyInactive`, `setCompanyInactiveHandler`, 1 aviso a cada 5 s) e `apps/web/src/main.tsx` (toast `shell-company-inactive`), com a chave `guards.companyInactive` em `i18n/{pt-BR,en,es}/shell.json` · causa: nenhum código da web tratava o 403 do `companyActiveGuard` · dona T53/T23.
3. **`company.updated` no SSE** · `apps/web/src/features/settings-company/realtime.ts` (novo; invalida empresa, perfil e `company-switcher`) com import estático em `apps/web/src/app/shell/app-shell.tsx` · causa: nenhum handler registrado antes de o SSE abrir (hub lazy) · dona T53.
   - Testes: `apps/web/src/features/settings-company/company-inactive.unit.test.ts` (novo).

4. **Reinício do wa-worker pausava os runs em espera (AC-T102-07, achado do Sextante)** · `packages/wa-engine/src/session/manager.ts` (`stop()` descarta os runtimes com `dispose(rt, 'local', { silent: true })`: sem o evento `disconnected`, mas o hook `onDisconnected` do monitor ainda roda) · causa: o shutdown gracioso emitia `disconnected` → outbox publicava `session.connection close` sem motivo → o `ConnectionStatusProjector` (T47) pausava os runs `waiting` da conexão (`paused_by: connection`), que não voltavam na reconexão. Agora o reinício planejado se comporta como o crash (nenhum evento de queda). Queda real e pausa/logout do usuário continuam emitindo `close` · dona T13.
   - Teste: caso novo em `packages/wa-engine/src/session/manager.db.unit.test.ts` (aditivo). wa-engine 172/172, wa-worker 25/25, aceitação T29+T46 41/41 e `tests/acceptance/T102/restart.test.ts` ok.

5. **401 gerava 2 sondas de perfil (AC-T23-06, achado do Sextante)** · `apps/web/src/lib/http.ts` (`sessionDead`: depois que a sonda dá a sessão como morta, os 401 seguintes não sondam até uma resposta OK) · causa: as queries do `/chats` (T69) disparam depois do redirect ao login e cada 401 sondava de novo (a sonda é liberada no tick seguinte) · dona T23.
   - Teste: `apps/web/src/lib/probe-once.unit.test.ts` (novo). `tests/acceptance/T23/shell.e2e.ts` 13/13 desktop e mobile com o dist novo (execução do Sextante).

## Verificado sem mudança
- **Job que lança antes do runner:** já resolvido (`processorOf` + `failBackgroundJob` em `apps/worker/src/jobs/exports/index.ts`; AC-T127-07 cobre). Nada a fazer.
- **Rota `/__e2e` para STABLE:** já existe: `POST /__e2e/wa/sessions/:sessionId/state {to:'open', session_state?}` (T71). A lição em `docs/licoes.md` ("não há rota… STABLE") está desatualizada.
- **Fetch global no harness:** XPag/Notasy/UTMify já vão para fakes locais (T114), vozes para o FakeElevenLabsVoices (T92) e a Meta para o FakeMetaGraph (T106).

## Decisão: worker de produção NÃO montado no harness
Combinado com o Tester (Sextante): AC-03/04/05/07 e a varredura de API/SSE do AC-06 vão no sistema montado (vitest, padrão T127: wa-worker real, `startProductionWorker`, `createProductionApiDeps`). O harness Playwright cobre só AC-01, AC-02 e as URLs do AC-06, que já funcionam com o harness atual. Montar flow-step/gatilhos/agente no harness mudaria os E2E existentes: o `waitingRun` da T71 grava o run em waiting direto no banco, e o FakeLlm do `/__e2e/llm/script` é compartilhado com o laboratório da T92.

## Verificação local
- `vitest run src/routes/companies` (api): 2 arquivos e 4 testes ok. `vitest run src/team/team.unit.test.ts` (core): 8 ok. Web `src/features/settings-company src/lib src/i18n`: 18 ok.
- `pnpm --filter @crm/{core,api,web} typecheck` ok; eslint nos arquivos tocados ok; `i18n:check` ok.
- Verify formal: `VITEST_MAX_WORKERS=2 node spec/verify/verify.mjs T102 --role operario --base be546d6` → exit 0 (typecheck 75 s, lint 30 s, test 476 s, build 15 s, regras F-* e escopo ok).

## Pendências para outras tarefas
- Atualizar a lição da T77 em `docs/licoes.md` (a rota de STABLE existe).
- `member.permissions_changed` também não tem handler na web (o perfil só se atualiza pelo staleTime de 60 s). Não foi corrigido porque não estava na lista.
- Hub sem abas permitidas mostra "Nenhuma seção"; "Nova Conta", "Convidar membro" e "Sair da empresa" seguem sem AC (T53).
- `META_CAPI_JOB_OPTS` com backoff de 30 s e a publicação de efeitos de nó antes do commit ficaram como estavam: nenhuma jornada quebrou por eles até agora.
