STATUS: DONE

T97 — Afiliação: captura de indicação e link externo (branch task/T97, base 5e34a73). Tempo: ~11 min (00:00 → 00:11).

## Arquivos alterados
- `packages/core/src/affiliate/index.ts` (novo): `parsePortalUrl` (só http/https; vazia/inválida → null), `affiliateConfig(env)`, `AppConfigDto`.
- `packages/core/src/affiliate/affiliate.unit.test.ts` (novo).
- `packages/core/src/index.ts` (compartilhado, aditivo: `export * from './affiliate'`).
- `apps/api/src/routes/app-config/index.ts` (novo): `GET /api/app-config` → `{ affiliate_portal_url: string | null }`, env relido a cada request (`deps.appConfigEnv ?? process.env`), autenticada.
- `apps/api/src/routes/app-config/app-config.unit.test.ts` (novo).
- `apps/api/src/routes/index.ts` (compartilhado, aditivo: 1 import + 1 `app.route`).
- `apps/web/src/features/affiliate/referral.ts` (novo): `REFERRAL_CODE_RE`, `validReferral`, `pickReferral({ ref, via })`.
- `apps/web/src/features/affiliate/api.ts` (novo): `appConfigQuery()` (key `['app-config']`), `portalUrlOf`.
- `apps/web/src/features/affiliate/affiliate-entry.tsx` (novo): botão + modal (Base UI Dialog) + link da nova aba.
- `apps/web/src/features/affiliate/affiliate.unit.test.ts` (novo).
- `apps/web/src/i18n/{pt-BR,en,es}/affiliate.json` (novos).
- `apps/web/src/features/auth/register-route.tsx` (liberado, aditivo: 1 import; `referral={pickReferral(search)}`).
- `apps/web/src/app/shell/app-shell.tsx` (liberado, aditivo: 1 import + `<AffiliateEntry collapsed={collapsed} />` no topo do `ShellFooter`, que vale para sidebar e drawer).

## Verify: 0 (node spec/verify/verify.mjs T97 --role operario --base 5e34a73)
APROVADO: api/core/web typecheck, lint, test (afetados); web i18n:check e build; todas as regras FORBIDDEN; escopo (15 arquivos).

## Conferência no navegador (harness E2E, desktop 1366 e mobile 390)
- `/register?ref=a&via=b` → `referral_code: "a"`; `?via=b` → `"b"`; sem query → campo ausente; `?ref=<65 x>&via=ok` → `"ok"`.
- `/api/app-config` com `null` → `affiliate-entry` não existe no DOM (sidebar e drawer).
- Com URL → item "Programa de afiliados" no rodapé → modal → "Continuar" abre nova aba (`window.opener === null`), modal fecha; "Cancelar" fecha.

## Notas
- **AC-T97-01/02:** regra pura `pickReferral` replica `REFERRAL_CODE_RE` do core (`/^[A-Za-z0-9_-]{1,64}$/`). **Decisão (Orquestrador): `ref` inválido conta como ausente e cai para `via`.** O `referralSearch` da T36 (trim, max 120) foi mantido; a regra entra depois dele.
- **AC-T97-03:** a URL vem de `GET /api/app-config` (autenticada; não está em `PUBLIC_API_ROUTES`). Sem URL (ou inválida) não renderiza botão nem modal (`return null`). O "Continuar" é `<a target="_blank" rel="noopener noreferrer" href=<url>>`.
- **Testids para o Tester:** `affiliate-entry` (botão no rodapé da sidebar/drawer; no recolhido só ícone com `aria-label`), `affiliate-modal`, `affiliate-modal-text`, `affiliate-modal-continue` (o `<a>`; conferir `rel` com regex `/noopener/` e `href`), `affiliate-modal-cancel`.
- **E2E (Tester):** alternar com `page.route('**/api/app-config', …)` devolvendo `{ affiliate_portal_url: null }` ou uma URL. Para a nova aba, interceptar o host do portal com `context.route` (não `page.route`, que não vale para a aba nova) e esperar com `context.waitForEvent('page')`. No mobile o item fica no drawer (`shell-drawer-open`).
- **Liberações usadas:** `register-route.tsx`, `apps/api/src/routes/app-config/**`, `app-shell.tsx` (todas aditivas, conforme a ficha).
- **Acordo com a T108:** rota única `GET /api/app-config`. Para acrescentar `tutorials_url`/`support`: ampliar `AppConfigDto` (core) e o spread em `appConfig(env)` (`apps/api/src/routes/app-config/index.ts`); na web, o `AppConfigDto`/`appConfigQuery` estão em `features/affiliate/api.ts` (a T108 pode importar de lá ou mover para `lib/` de forma aditiva).
- **Pendente / fora do escopo:** o item no `UserMenu` (link direto, sem modal — 13 §1) e o banner do dashboard com link ao portal não foram feitos (não estão nos AC; `controls.tsx` fora dos Paths). Nada a ligar no boot de produção; basta definir `AFFILIATE_PORTAL_URL` (já no `.env.example`). Sem migration.
