# T106 — UI Facebook: gerenciador, pixel e perfis · entrega do Operário

```text
DONE T106 operario
STATUS: DONE
Arquivos alterados:
  apps/web/src/features/facebook/{api.ts, rules.ts, search.ts, realtime.ts, layout.tsx, campaigns-page.tsx, pixel-page.tsx, profiles-page.tsx, facebook.unit.test.ts}
  apps/web/src/routes/facebook/{index.tsx (substitui o placeholder), campaigns.tsx, pixel.tsx, profiles.tsx}
  apps/web/src/i18n/{pt-BR,en,es}/facebook.json
  apps/web/src/routeTree.gen.ts (regenerado; só inserções, 63 linhas)
  scripts/e2e/api.ts (liberado, só aditivo: FakeMetaGraph + /__e2e/meta/*)
Verify: 0 (node spec/verify/verify.mjs T106 --role operario --base 9bd202b)
Tempo: ~35 min (00:12 → 00:47)
```

## O que foi feito (por AC)

- **AC-T106-01** `/facebook` (index) redireciona (`replace`) para a 1ª sub-rota permitida (campaigns → pixel → profiles).
  Cada sub-rota sem a própria permissão também redireciona (`beforeLoad`, `facebookRedirect` em `rules.ts`). Com só
  `facebook.pixel` → `/facebook/pixel`. Abas do módulo só mostram as permitidas.
- **AC-T106-02** Estados do Gerenciador: sem perfil/contas (`facebook-empty-profiles` + CTA `facebook-cta-profiles`),
  nenhuma conta incluída (`facebook-empty-included`, quando a sessão lê os perfis e há contas mas nenhuma incluída),
  carregando (`facebook-loading` + `facebook-progress` "Carregando contas: X de Y"), parcial (`facebook-partial`),
  pronto (tabela), atualizando com os dados atuais (`facebook-refreshing`), limite da Meta com cache
  (`facebook-rate-limited`, dados visíveis) e sem cache (`facebook-rate-limited-error`), erros por conta
  (`facebook-account-errors`, itens `facebook-account-error-<adAccountLocalId>`, e toast `facebook-account-errors-toast`:
  1 conta → "<conta>: <erro>", várias → "N conta(s) com aviso…"), erro da requisição (`facebook-error` + `facebook-retry`),
  filtros sem resultado (`facebook-empty-results`), cotação faltando (`facebook-fx-missing`).
- **AC-T106-03** "Atualizar" (`facebook-refresh`) manda `force_refresh=1` e fica `disabled` 30 s (texto "Atualizar (Ns)";
  cooldown por empresa no módulo, `Date.now()` + `setInterval` de 1 s — funciona com `page.clock`). "Atualizado há X"
  (`facebook-updated-ago`, re-render a cada 15 s). Colunas: menu `facebook-columns` com setas
  `facebook-column-up-<col>`/`facebook-column-down-<col>` e `facebook-columns-reset` ("Restaurar ordem padrão");
  arrastar os cabeçalhos `facebook-col-<col>` (HTML5 DnD) no desktop sem `pointer: coarse`. Rótulos pareados
  "Faturamento (`<APP_NAME>` / Meta)", "Lucro (… / Meta)", "Compras (… / Pixel)", "ROAS (… / Meta)" + dica
  `facebook-metrics-hint`. Nenhum texto visível com a marca de referência (teste unitário confere os 3 JSONs).
- **AC-T106-04** Switch de status (`facebook-item-status-<id>`, `role=switch`, `aria-checked`) otimista: muda no clique;
  sucesso → toast `facebook-status-updated` + refresh forçado; erro → volta o estado + toast `facebook-status-error`.
  Uma edição por vez (os outros switches/editar ficam `disabled`). Modal `facebook-edit-dialog`: modos
  `facebook-edit-mode-name`/`facebook-edit-mode-budget` em campanha/conjunto; **anúncio sem campo nome** (nem orçamento:
  `facebook-edit-ad-hint`, salvar desabilitado). Campos `facebook-edit-name`, `facebook-edit-daily`,
  `facebook-edit-lifetime` (vírgula decimal aceita; vazio não é enviado; pré-preenchido só se > 0), `facebook-edit-save`,
  `facebook-edit-cancel`, `facebook-edit-error`; sucesso → toast `facebook-edit-saved`.
- **AC-T106-05** Perfis: cartão `facebook-profile-<id>` (`data-expanded`), botão `facebook-profile-toggle-<id>`
  (`aria-expanded`; 1 perfil abre expandido), lista `facebook-profile-accounts-<id>`, conta `facebook-account-<id>` com
  checkbox `facebook-account-toggle-<id>` otimista (rollback + toast `facebook-account-toggle-error`) e check
  `facebook-account-included-<id>`; contador `facebook-profile-count-<id>`. Toast do OAuth: `facebook-oauth-success` /
  `facebook-oauth-error` (descrição = `meta_message`), e os params saem da URL (`replace`). Pixel: tabela com
  `facebook-pixel-item-pixel-id-<id>` e `facebook-pixel-item-token-<id>` mascarados; excluir pede
  `facebook-pixel-confirm` → `facebook-pixel-confirm-ok`. **Mobile:** status e nome ficam no painel
  `facebook-filters-panel`, aberto por `facebook-filters-open` (no mobile `facebook-filter-status` não existe fora dele);
  a tabela vira cartões (`facebook-cards`), sem rolagem horizontal.

## Testids (contrato com o Tester)

| Área | Testids |
|---|---|
| Layout | `page-facebook`, `facebook-toolbar`, `facebook-tab-campaigns|pixel|profiles` |
| Toolbar | `facebook-accounts-filter` (popup `facebook-accounts-popup`, `facebook-accounts-search`, `facebook-accounts-option-<adAccountLocalId>`, `facebook-accounts-all`, `facebook-accounts-clear`, `facebook-accounts-apply`, `facebook-accounts-cancel`), `facebook-period` (+ `facebook-since`/`facebook-until` em custom), `facebook-currency`, `facebook-refresh`, `facebook-updated-ago` |
| Níveis/filtros | `facebook-level-campaign|adset|ad`, `facebook-level-count-<level>`, `facebook-filter-status`, `facebook-filter-name`, `facebook-filters-open`, `facebook-filters-panel`, `facebook-filters-close` |
| Tabela | `facebook-table` (desktop) / `facebook-cards` (mobile), `facebook-item-<entityId>`, `facebook-item-name-<id>`, `facebook-item-status-<id>` (switch), `facebook-item-status-label-<id>` (`data-status`), `facebook-item-budget-<id>`, `facebook-item-<col>-<id>`, `facebook-item-edit-<id>`, `facebook-col-<col>`, `facebook-sort-<key>`, `facebook-totals`, `facebook-total-<col>` |
| Colunas | `facebook-columns`, `facebook-columns-popup`, `facebook-columns-order`, `facebook-column-<col>`, `facebook-column-up-<col>`, `facebook-column-down-<col>`, `facebook-columns-reset` |
| Toasts | `facebook-status-updated`, `facebook-status-error`, `facebook-edit-saved`, `facebook-account-errors-toast`, `facebook-oauth-success`, `facebook-oauth-error`, `facebook-oauth-start-error`, `facebook-account-toggle-error`, `facebook-profile-refreshed`, `facebook-profile-removed`, `facebook-pixel-saved`, `facebook-pixel-deleted` |
| Perfis | `facebook-profiles-connect` (só gestor), `facebook-profiles-readonly`, `facebook-profiles-empty`, `facebook-profiles-loading`, `facebook-profile-name|status|count|expires|refresh|reconnect|remove-<id>`, `facebook-profile-confirm`/`-confirm-ok`/`-confirm-cancel` |
| Pixel | `facebook-pixel-new`, `facebook-pixel-table`/`-cards`, `facebook-pixel-item-<id>`, `facebook-pixel-item-edit-<id>`, `facebook-pixel-item-delete-<id>`, `facebook-pixel-empty`, `facebook-pixel-editor`, `facebook-pixel-name`, `facebook-pixel-platform`, `facebook-pixel-pixel-id`, `facebook-pixel-token`, `facebook-pixel-auto-send`, `facebook-pixel-save`, `facebook-pixel-cancel`, `facebook-pixel-error`, `facebook-pixel-confirm`, `facebook-pixel-confirm-ok` |

`<col>` ∈ `meta_spend, revenue_pair, profit_pair, purchases, roas_pair, cost_per_purchase_meta, conversations_meta,
cost_per_lead_meta, meta_link_clicks, meta_impressions`. `<id>` das linhas = id da entidade na Meta (o `id` semeado no fake).

**Search params** de `/facebook/campaigns`: `fb_level` (`adset|ad`; ausente = campaign), `fb_status` (ausente = `active`;
`all` ou código, ex. `PAUSED`), `fb_q`, `fb_period` (`today|yesterday|7d|30d|month|custom`), `fb_since`, `fb_until`.
Nunca `?status=`. Trocar de nível zera `fb_status` e `fb_q`. `/facebook/profiles`: `meta_oauth`, `meta_message`.

## Harness: como semear a Meta (sem rede)

`scripts/e2e/api.ts` sobe um `FakeMetaGraph`, passa `metaConfig` ao `createApp` e chama `configureMetaAds` no worker
in-process (job `meta-sync` roda contra o fake). Rotas de controle (pelo `baseURL` da web; header
`x-requested-with: crm`), só com `E2E=1`:

| Rota | Corpo | Efeito |
|---|---|---|
| `POST /__e2e/meta/users` | `{ id, name, picture_url?, ad_accounts: [{ id: 'act_111', name, currency, account_status? }] }` | cadastra o usuário Meta e o torna o usuário do diálogo OAuth |
| `PUT /__e2e/meta/users/:id/ad-accounts` | `{ ad_accounts }` | troca as contas (testar "Atualizar lista") |
| `POST /__e2e/meta/oauth` | `{ user_id?, error? }` | escolhe o usuário do diálogo ou faz o diálogo negar (`error` vira `meta_message`) |
| `POST /__e2e/meta/structure` | `{ account: 'act_111', campaigns, adsets, ads }` | estrutura no formato da Graph (`effective_status`, orçamento em centavos string, `campaign_id`, `adset_id`) |
| `POST /__e2e/meta/insights` | `{ account, level, rows }` | linhas de insights (`spend`, `impressions`, `inline_link_clicks`, `actions[]`, `action_values[]`) |
| `POST /__e2e/meta/fail-account` / `DELETE /__e2e/meta/fail-account/:account` | `{ account, status?, error? }` | toda chamada da conta falha (erro por conta; afeta leitura E mutação) |
| `POST /__e2e/meta/fail-next` | `{ status?, error? }` | só a próxima chamada à Graph falha (ex.: rollback do switch) |
| `POST /__e2e/meta/usage` | `{ account \| '*', usage: 0..100, regain_minutes? }` | header de uso (>75 → limite da Meta/`rate_limited`) |
| `GET /__e2e/meta/requests`, `GET /__e2e/meta/mutations` | — | o que a "Meta" recebeu (mutações com `fields`, ex. `daily_budget: "7550"`) |
| `GET /__e2e/meta`, `POST /__e2e/meta/reset` | — | estado / zera o fake (o `POST /__e2e/reset` também zera) |

OAuth ponta a ponta no navegador: semeie o usuário, abra `/facebook/profiles`, clique `facebook-profiles-connect` → o
`oauth_url` vira `/__e2e/meta/v26.0/dialog/oauth?...` (mesma origem) → 302 para `/api/meta/oauth/callback?code&state`
→ 302 para `/facebook/profiles?meta_oauth=success` (toast + URL limpa). Depois marque as contas
(`facebook-account-toggle-<localId>`; o id local vem de `GET /api/meta/profiles`). Exemplo usado na fumaça:
usuário `u1` com `act_111`/`act_222`, campanha `c1` ACTIVE com `daily_budget: '5000'`, insights de `c1` com
`spend: '100.50'` e `action_values` purchase 450 → célula "— / R$ 450,00" (interno nulo até a T105).
Rate limit: `POST /__e2e/meta/usage { account: '*', usage: 95, regain_minutes: 5 }` antes de um `Atualizar` (com
bundle anterior → `facebook-rate-limited`; sem → `facebook-rate-limited-error`).

## Verificação feita

- Verify formal: exit 0 (saída acima). Unitários: `src/features/facebook/facebook.unit.test.ts` (33 testes).
- Fumaça Playwright manual contra o harness (desktop 1366 e mobile 390): redirect do índice, estado sem perfil,
  OAuth fake (sucesso e erro com mensagem, params removidos), toggle de conta otimista, Gerenciador pronto com erro
  de uma conta (banner + toast), valores/totais, cooldown, ordem de colunas persistida após reload e restaurada,
  switch otimista (sucesso com mutação `PAUSED`; erro com rollback e toast), orçamento "75,5" → `daily_budget: "7550"`,
  anúncio sem campo nome, Pixel criar/mascarado/edição com token/excluir com confirmação, painel de filtros no mobile e
  sem rolagem horizontal.

## Notas

- **Moeda de exibição:** escolha no cliente, por empresa, em `localStorage` `facebook.currency.v1:<companyId>` (padrão
  BRL), enviada em `display_currency`. Não há coluna na empresa (pendência T101).
- **Ordem das colunas:** `localStorage` `facebook.columns.v1:<companyId>` (JSON da lista; chaves desconhecidas são
  ignoradas e as que faltam entram na ordem padrão). Todo acesso via `readStorage`/`writeStorage` (try/catch).
- **Filtro de status:** `fb_status=active` → servidor `status_filter=active`; qualquer outro valor → `all` + filtro no
  cliente. O switch filtra pelo status do servidor e exibe o otimista (a linha não some antes do bundle novo).
- **Contas no filtro do Gerenciador:** sem rota de contas para `facebook.campaigns`; com `facebook.profiles` usa as
  incluídas dos perfis, senão as contas vistas no bundle.
- **Realtime:** `meta.bundle.progress` registrado no topo das rotas `routes/facebook/*` (conferido: o SSE escuta o tipo).
  Parcial → relê `async`; pronto → lê em modo síncrono. Reserva: polling de 3 s enquanto pendente.
- **PENDÊNCIA (backend T101, fora do escopo):** bundle pronto com erro de conta não vai para o cache; o GET `async`
  seguinte reenfileira com o mesmo jobId `bundle-<key>`, que o BullMQ deduplica contra o job concluído retido
  (`removeOnComplete` 24 h) → o estado fica `loading` até o TTL (15 min). A UI contorna: após 4 leituras `async` sem
  avanço (~12 s) lê sem `async`. Sugestão: jobId com sufixo de tempo quando não há estado, ou cachear o "último pronto"
  com erro para o GET async.
- `purchases_leona`/`purchase_value_leona` aparecem como "—" até a T105.
- Pixel: coluna "Conta de anúncios" mostra o placeholder "Será implementado" (como a referência).
- Ações de gestão de perfis ficam ocultas para quem não é owner/admin/platform_admin; checkbox desabilitado.
- Harness: rotas `/__e2e/meta/*` vivem num wrapper do `fetch` em `scripts/e2e/api.ts` (o processo da API não conhece a
  porta da web; o diálogo e a volta do callback são reescritos para caminhos relativos). Nada sai para a Graph real.
- Nenhum teste de outra tarefa foi alterado. Nada a ligar no boot de produção (o `configureMetaAds` de produção já existe).

## Retrabalho (REJECT do Tester, spec/reports/T106.md)

```text
DONE T106 operario (retrabalho)
Arquivos alterados: apps/web/src/features/facebook/{rules.ts, campaigns-page.tsx, facebook.unit.test.ts}
Verify: 0 (node spec/verify/verify.mjs T106 --role operario --base 9bd202b)
Tempo: ~5 min (01:45 → 01:50)
```

- **Bug 1 (sem cache, "Carregando" eterno):** `shouldReplace` agora troca o pendente exibido quando os `warnings` mudam
  (ex.: entra `rate_limited`) com mesmo status/linhas/`targets_done`, desde que o novo não perca linhas nem progresso.
  Reforço: `managerView(bundle, profiles, refreshing, latest)` recebe o `query.data` e usa `shownRateLimited` (aviso do
  exibido OU do envelope mais recente da mesma `bundle_key`), então o `facebook-rate-limited-error` aparece mesmo que o
  polling pare. E2E `AC-T106-02 limite da Meta sem cache` **passa** (desktop).
- **Bug 2 (com cache, Atualizar sem aviso):** do lado da UI, o envelope `ready` `cached: true` com `rate_limited` substitui o
  exibido (pronto novo sempre entra) e a view mostra `facebook-rate-limited` com a tabela; um envelope `refreshing` com
  `rate_limited` também acende o aviso sobre o pronto exibido (via `latest`), e nesse caso o "Atualizando" some (o
  polling para). Coberto em unitários. E2E `AC-T106-02 limite da Meta com dados em cache` **continua falhando** até a
  T129 entrar: hoje o GET `async=1` do refresh devolve `ready cached:true warnings=[]`.
- Unitários: `facebook.unit.test.ts` 35 testes (2 novos: limite sem cache / com cache).
- Pendente para outras tarefas: T129 (servidor propagar `rate_limited` no envelope async/refresh).

## Retrabalho 2 (servidor da T129: limite sem último pronto → `ready` vazio + `rate_limited`) — 01:53 → 01:55; verify exit 0

- `managerView` (`rules.ts`): sem linhas e com `rate_limited` (no exibido ou no envelope mais recente da mesma chave)
  agora dá `rate_limited_error` em **qualquer** status. Antes exigia status ≠ `ready`, e o `ready` vazio da T129 cairia em
  `data` (tabela vazia com "sem resultados"). O caso antigo (`loading` + `rate_limited`) continua coberto. `ready` vazio
  **sem** aviso continua `data`. Nada mudou em `campaigns-page.tsx`: `ready` já para o polling, `shouldReplace` já troca o
  pendente pelo pronto, e `staleTime` já é 0 com o aviso, então o próximo acesso consulta de novo.
- Unitários: `facebook.unit.test.ts` 36 testes (1 novo: `ready` vazio / `cached` vazio com aviso → aviso; pendente
  trocado pelo pronto vazio; pronto vazio + refresh limitado → aviso; `loading` + aviso → aviso; `ready` vazio sem aviso → dados).
- Verify: `node spec/verify/verify.mjs T106 --role operario --base 9bd202b` → APROVADO (exit 0).
- Pendente: o E2E `AC-T106-02` com o servidor novo depende de a T129 entrar na main.

## Retrabalho 3 (AC-T106-02 com cache: "Atualizar" sem o aviso) — 02:24 → 02:32; verify exit 0

- **Causa:** `campaigns-page.tsx` relia em `sync` (sem `force_refresh`) ao receber o SSE `meta.bundle.progress`
  `ready`. O servidor (T129) grava o pronto com `rate_limited` no estado do bundle antes de publicar o SSE, e só o GET
  `async` lê esse estado. O `sync` sem force devolve o cache com `warnings=[]`, então o polling parava sem o aviso.
- **Correção:** função pura `progressReadMode(current, p)` (`rules.ts`). SSE `partial`/`ready` sobre o bundle pendente
  da tela agora relê em **`async`**. Outro bundle, bundle já pronto ou outros status continuam ignorados. Com a T129, o
  async já sai de `loading` no pronto com erro de conta, que era o motivo do `sync`. O contorno `STALL_POLLS → sync`
  ficou só como reserva: quando ele dispara, as leituras async eram `refreshing`/`loading` sem aviso, então nenhum
  `rate_limited` se perde ali. Cooldown e erros de conta não mudaram.
- Unitários: `facebook.unit.test.ts` 37 testes (1 novo: `progressReadMode`). `tsc --noEmit` ok.
- E2E do tester, desktop, `-g "AC-T106-02"`: **8/8 passam**, inclusive `limite da Meta com dados em cache`.
  Atenção: `scripts/e2e/serve.mjs` só faz build da web se `apps/web/dist` não existir. A 1ª rodada usou o dist antigo
  (01:54) e falhou. Depois de `pnpm --filter @crm/web build`, passou.
- Verify: `node spec/verify/verify.mjs T106 --role operario --base 1410f76` → APROVADO (exit 0).
- Pendente: nada da T106. Sugestão para o harness (fora do Path): `serve.mjs` reconstruir o dist quando ele estiver
  mais velho que `apps/web/src`.
