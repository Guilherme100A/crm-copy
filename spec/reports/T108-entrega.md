STATUS: DONE

T108 — Tutoriais e widget de suporte plugável (branch task/T108, base dec9225). Tempo: ~13 min (00:53 → 01:06).

## Arquivos alterados
- `packages/core/src/affiliate/index.ts` (aditivo): `SupportProvider`, `SupportConfigDto`, `AppConfigDto` ampliado (`tutorials_url`, `support`), `parseSupportPhone`, `supportConfig(env)`, padrões neutros `SUPPORT_SCRIPT_GLOBAL_DEFAULT='SupportChat'` / `SUPPORT_STORAGE_PREFIX_DEFAULT='support_chat_'`.
- `packages/core/src/affiliate/support.unit.test.ts` (novo).
- `apps/api/src/routes/app-config/index.ts` (aditivo): `appConfig(env)` = `{ ...affiliateConfig(env), ...supportConfig(env) }` (env relido a cada request).
- `apps/api/src/routes/app-config/app-config.unit.test.ts`: os 3 `toEqual` da T97 viraram `toMatchObject` (o JSON ganhou campos) + caso novo da T108.
- `apps/web/src/features/affiliate/api.ts` (aditivo): `tutorials_url?` e `support?` no DTO web.
- `apps/web/src/features/tutorials/tutorials.ts` (novo): `tutorialsUrlOf`, `withTutorials`, `useTutorialsUrl`, `TUTORIALS_LINK_REL`, `safeExternalUrl`; `tutorials.unit.test.ts` (novo).
- `apps/web/src/features/support-widget/provider.ts` (novo): provedor plugável `createScriptProvider` (`load`, `identify`, `open`, `close`, `clearLocalKeys`, `unload`), DOM/timers injetáveis.
- `apps/web/src/features/support-widget/runtime.ts` (novo): `supportModeOf`, `whatsappLinkOf`, `identityOf`, `syncSupportWidget`, `teardownSupportWidget` (singleton do provedor ativo).
- `apps/web/src/features/support-widget/support-widget.tsx` (novo): `SupportWidget` (efeito, sem UI), `SupportButton`, `SupportMenuItem`; `support-widget.unit.test.ts` (novo).
- `apps/web/src/i18n/{pt-BR,en,es}/support-widget.json` (novos).
- `apps/web/src/app/nav.ts` (compartilhado; decisão do Orquestrador): fallback `'https://www.youtube.com/'` removido (`VITE_TUTORIALS_URL || ''`).
- `apps/web/src/app/shell/nav-list.tsx` (liberado): `withTutorials(visibleSections(...), NAV_SECTIONS, useTutorialsUrl(), isSupport)`; `rel` dos itens externos `noreferrer` → `noopener noreferrer`.
- `apps/web/src/app/shell/app-shell.tsx` (liberado, aditivo): import estático; `<SupportButton>` no topo do `ShellFooter` (sidebar + drawer); `<SupportWidget>` ao lado do `SupportApprovalModal`.
- `apps/web/src/app/shell/controls.tsx` (liberado, aditivo): `teardownSupportWidget(queryClient.getQueryData(appConfigKey))` na 1ª linha do `logout`; `<SupportMenuItem>` no `UserMenu` quando `compact`.
- `.env.example` (compartilhado, aditivo): `TUTORIALS_URL`, `SUPPORT_PROVIDER`, `SUPPORT_SCRIPT_URL`, `SUPPORT_PHONE`, `SUPPORT_SCRIPT_GLOBAL`, `SUPPORT_STORAGE_PREFIX`.

## Verify: 0 (node spec/verify/verify.mjs T108 --role operario --base dec9225)
APROVADO: api/core/web typecheck, lint, test (afetados); web i18n:check e build; todas as regras FORBIDDEN; escopo (19 arquivos).

## Conferência no navegador (harness E2E, desktop 1366 e mobile 390; `page.route` em `/api/app-config` + script FAKE)
- Script: `identify({email, name})` chamado; `#support-widget-script` 1 só após recolher/expandir a sidebar e navegar (1 request do script); "Suporte" chama `show`+`open`; logout → `close`, script removido, `support_chat_user` apagada.
- whatsapp-link: `support-button` = `<a href="https://wa.me/5511999998888" target=_blank rel="noopener noreferrer">`; sem script.
- none / `tutorials_url: null`: sem `support-button`, sem `nav-item-tutorials`.
- `support@demo.test`: sem tutoriais, sem botão, sem script; chave `support_chat_*` que sobrou é apagada.
- Mobile: `support-menu-item` no menu do usuário; drawer com Suporte e Tutoriais.

## Notas
- **AC-T108-01:** URL de runtime (`tutorials_url`); com config carregada ela manda (null = sem item); antes de carregar vale só `VITE_TUTORIALS_URL` (vazia por padrão). `withTutorials` põe o item no fim de GESTÃO para todo papel não-support, recriando a seção GESTÃO se ela sumiu (membro sem `settings.view`; lacuna 18 §10.4). `support` nunca vê.
- **AC-T108-02:** injeção idempotente por id fixo `support-widget-script` E por `src` igual; `identify` com polling 100 ms, desiste aos 10 s em silêncio (fake timers nos unitários). Não injeta para `support` nem usuário sem e-mail. `phone` = `user.personal_whatsapp` quando houver.
- **AC-T108-03:** `SUPPORT_PROVIDER` normalizado no core: `script` sem URL http/https válida ou `whatsapp-link` sem telefone (8–15 dígitos) viram `none`; valor desconhecido → `none`.
- **AC-T108-04 — gancho de logout:** `UserMenu.logout` em `apps/web/src/app/shell/controls.tsx` (único ponto de logout da web; liberado). Não há logout por 401 automático na web. Usuário `support`: o próprio `SupportWidget` encerra (close, remove script, limpa prefixo).
- **Marca neutra:** global configurável `SUPPORT_SCRIPT_GLOBAL` (padrão `SupportChat`), prefixo `SUPPORT_STORAGE_PREFIX` (padrão `support_chat_`; com "token"/"session" volta ao padrão); eventos de fallback `support-chat-show`/`support-chat-open`; atributo `data-button-style="floating"`. Nada de `leona_*`.
- **Acordo com a T97:** rota única `GET /api/app-config`; campos novos `tutorials_url` e `support: { provider, script_url, phone, script_global, storage_prefix }`. O teste da T97 passou a `toMatchObject` (único ajuste no que era dela).
- **Testids para o Tester:** `nav-item-tutorials` (`<a target=_blank rel="noopener noreferrer">`), `support-button` (rodapé sidebar/drawer; `<a>` no whatsapp-link, `<button>` no script; `data-provider`), `support-menu-item` (menu do usuário só no modo compacto/mobile; testid diferente para não duplicar com o rodapé recolhido), `support-widget-script` (id e data-testid do `<script>`).
- **E2E (Tester):** `page.route('**/api/app-config', r => r.fulfill({ json: { affiliate_portal_url: null, tutorials_url, support: {...} } }))` e servir o script FAKE com `page.route(<script_url>)` expondo `window.SupportChat = { identify, show, open, close }` (ou o `script_global` do JSON). A config é lida no carregamento; para trocar de caso, rotear antes do `goto`.
- **Pendente / fora do escopo:** flag dev `?chat=1` da ref (§9.2) não implementada (não está nos AC). Nada a ligar no boot de produção; basta definir as variáveis (já no `.env.example`). Sem migration.
