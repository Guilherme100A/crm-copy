# T83 — UI disparos em massa · entrega do operário

- **Branch/worktree:** `task/T83` · `leonas-crm-wt/T83` · base `0bb9d1a`
- **Verify:** `node spec/verify/verify.mjs T83 --role operario --base 0bb9d1a` → **exit 0** (typecheck, lint, test, i18n:check, build, regras FORBIDDEN, escopo: 12 arquivos)
- **Tempo:** 23:51 → 00:10 (≈ 20 min de trabalho do operário, incluindo a fumaça no harness)

## Arquivos

| Arquivo | O quê |
|---|---|
| `apps/web/src/routes/mass-dispatches/index.tsx` | Substitui o placeholder da T23. Registra o SSE no topo (`registerMassDispatchRealtime()`), lê `history.state.massDispatchDraft` (T77) e o retira do state com `replace` depois de abrir o wizard. |
| `apps/web/src/features/mass-dispatch/api.ts` | DTOs locais (`MassDispatchDto`, `QuotaDto`, `CreateWarning`), queries (lista, cota, detalhe, conexões conectadas, fluxos acionáveis, total de contatos) e `massDispatchApi.create` (multipart) / `cancel`. |
| `apps/web/src/features/mass-dispatch/logic.ts` | Regras puras: presets, validação do wizard (réplica do `rules.ts` do core), manifesto, `FormData`, cards, fases, patch do evento, leitura do rascunho. |
| `apps/web/src/features/mass-dispatch/realtime.ts` | Handler de `mass_dispatch.updated`: aplica status, fase e contagens no detalhe e nas listas em cache e depois faz um refetch com debounce (400 ms) da lista e da cota. |
| `apps/web/src/features/mass-dispatch/page.tsx` | Página: cards, barra da cota, busca no cliente, tabela (desktop) × cartões (mobile), Pager e ações. |
| `apps/web/src/features/mass-dispatch/wizard.tsx` | Wizard de 3 passos + modal de confirmação. |
| `apps/web/src/features/mass-dispatch/dialogs.tsx` | Modais "Preparando", "Ver detalhes" e "Cancelar", selo de status, barra de progresso e formatação. |
| `apps/web/src/features/mass-dispatch/mass-dispatch.unit.test.ts` | 29 testes unitários (lógica, multipart, realtime no `QueryClient`, i18n/chaves). |
| `apps/web/src/i18n/{pt-BR,en,es}/mass-dispatch.json` | Textos nas 3 línguas. |
| `scripts/e2e/api.ts` (liberado, só aditivo) | `const waGateway = new FakeWaGateway()` passado ao `createApp({ …, waGateway })` e `configureMassDispatch({ db, wa: waGateway, redis })` no worker in-process. São 2 imports novos, 2 blocos novos e `, waGateway` no fim da linha do `createApp`. Prettier não foi rodado nele. |

`routeTree.gen.ts` e `nav.ts` não foram alterados (a rota `/mass-dispatches/` já existia).

## Critérios

- **AC-T83-01:** cards Restantes / Usados no ciclo (`used / limit`) / Em andamento / Concluídos; barra "Cota do ciclo" com ajuda e o texto `{used} de {limit} usados ({remaining} restantes) · {slots} número(s) × {rate}/número`; tabela com Nome (+ conexões), Fluxo, Status, Progresso (barra + `enviados / total · falhas`), Agenda e Ações. Com disparo ativo (`preparing|scheduled|running|paused`), lista e cota recarregam a cada 5 s, além do SSE.
- **AC-T83-02:** passos Dados → Configurações → Público.
  - **Dados:** nome opcional e alvos conexão + fluxo; dá para adicionar ou remover alvos. O 1º alvo já vem com a 1ª conexão conectada e o 1º fluxo acionável.
  - **Configurações:** horário comercial (dias + janela; desligado = todos os dias, 00:00–23:59); presets lento 30–120 / normal 5–30 (padrão) / rápido 0–5 / personalizado (sliders 0–120); randomizar (desligado = max = min); limite diário; início.
  - **Público:** "Seleção feita em Contatos" (rascunho) ou "Todos os contatos".
  - **Validação no cliente:** a mesma do servidor, mais `dailyLimitExceedsQuota`, `selectionRequired` e `noQuota`.
  - **Erros do servidor:** os `details.fields[].path` aparecem no campo e levam ao passo do campo. `SESSION_NOT_CONNECTED` volta para Dados e `QUOTA_EXCEEDED` vira erro geral.
  - **Confirmação:** "Disparar cancela qualquer fluxo em andamento do mesmo contato." A confirmação (b) da referência exige WABA e ficou de fora.
- **AC-T83-03:** aviso fixo no passo Configurações (repetido na confirmação e no detalhe): "O ritmo real pode ser mais lento que o configurado: cada conexão tem limites de segurança (aquecimento…)". Também há aviso extra quando um alvo tem o selo `warming`, e o warning `daily_limit_exceeds_warmup` (e `only_first_n`) do 201 aparece no modal de preparação.
- **AC-T83-04:** depois de criar, o modal "Preparando disparo em massa" mostra as 5 fases (`queued → resolving_recipients → counting → scheduling → completed`, com estado done/current/pending/failed), `agendados / alvo` e o erro de preparação. Os dados vêm do SSE, com polling de 2 s como reserva. "Ver detalhes" mostra status, progresso, preparação, Distribuição A/B (Fluxo A = fluxos dos alvos; Fluxo B = `flow_b_name` ou "Sem teste A/B"), alvos ("N agendados · N disparados · N falhas"), configuração e o botão **Cancelar**, que pede confirmação e mostra um toast com `released_count`. Cancelar só aparece com `mass_dispatch.create` e status cancelável.

## Testids (contrato com o Tester)

Página: `page-mass-dispatch` (mantido), `mass-dispatch-new` (só com `mass_dispatch.create`), `mass-dispatch-overview`, `mass-dispatch-card-{remaining|used|running|completed}` (`data-count`), `mass-dispatch-quota`, `mass-dispatch-quota-bar` (`data-percent`), `mass-dispatch-quota-text`, `mass-dispatch-quota-exhausted`, `mass-dispatch-search`, `mass-dispatch-loading|error|retry|empty`, `mass-dispatch-table` (desktop) / `mass-dispatch-cards` (mobile), Pager `mass-dispatch-*` (kit).

Linha: `mass-dispatch-item-${id}` (`data-status`), `mass-dispatch-item-name-${id}`, `-connection-`, `-flow-`, `-status-` (`data-status`), `-progress-` (`data-percent`), `-schedule-`, `-details-`, `-cancel-` (botões) `${id}`.

Wizard: `mass-dispatch-wizard`, `mass-dispatch-step-indicator-{data|settings|audience}` (`aria-current="step"`), `mass-dispatch-step-{data|settings|audience}`, `mass-dispatch-wizard-{cancel|back|next|submit|error}`.
- Dados: `mass-dispatch-name`, `mass-dispatch-target-${i}`, `mass-dispatch-target-connection-${i}` / `-flow-${i}` (`<select>`), `mass-dispatch-target-remove-${i}`, `mass-dispatch-target-add`, `mass-dispatch-targets-no-connections`, `mass-dispatch-targets-no-flows`, `mass-dispatch-targets-load-error`.
- Configurações: `mass-dispatch-business-hours` (checkbox), `mass-dispatch-weekday-{0..6}` (`aria-pressed`), `mass-dispatch-window-start|end`, `mass-dispatch-full-day`, `mass-dispatch-preset-{slow|normal|fast|custom}` (`role=radio`, `aria-checked`), `mass-dispatch-randomize`, `mass-dispatch-interval-min|max` (range, só em custom), `mass-dispatch-interval-summary` (`data-min`/`data-max` efetivos), `mass-dispatch-pace-notice` (AC-03), `mass-dispatch-warming-notice`, `mass-dispatch-daily-limit`, `mass-dispatch-starts-at`.
- Público: `mass-dispatch-audience-draft` (só com rascunho) / `mass-dispatch-audience-all` (`aria-checked`), `mass-dispatch-audience-count` (`data-count`), `mass-dispatch-audience-contacts-link`.
- Erros de campo: `mass-dispatch-error-<path com . → ->`, por exemplo `-error-daily_limit`, `-error-weekdays`, `-error-window_end`, `-error-interval_max_seconds`, `-error-targets-0-flow_id`, `-error-targets`, `-error-manifest`, `-error-quota`, `-error-starts_scheduling_at`.
- Confirmação: `mass-dispatch-confirm`, `mass-dispatch-confirm-summary`, `mass-dispatch-confirm-flow-notice`, `mass-dispatch-confirm-back`, `mass-dispatch-confirm-ok`.

Preparação: `mass-dispatch-preparing`, `mass-dispatch-phases` (`data-phase` = fase atual), `mass-dispatch-phase-${phase}` (`data-state` = done|current|pending|failed), `mass-dispatch-preparing-count`, `mass-dispatch-preparing-done`, `mass-dispatch-preparing-error`, `mass-dispatch-warning-${code}`, `mass-dispatch-preparing-details`, `mass-dispatch-preparing-close`.

Detalhes: `mass-dispatch-details`, `-details-status` (`data-status`), `-details-progress`, `-details-counts`, `-details-ab` (`data-ab` on|off), `-details-ab-a`, `-details-ab-b`, `-details-targets`, `-details-target-${targetId}`, `-details-days`, `-details-window`, `-details-interval`, `-details-daily-limit`, `-details-starts-at`, `-details-cancel`, `-details-close`, `-details-error`. Cancelar: `mass-dispatch-cancel-confirm`, `-cancel-confirm-ok`, `-cancel-confirm-back`. Todo modal tem `<testId>-x` (fechar).

## Dados no harness (E2E)

Roteiro que passou na fumaça manual (Playwright em scratch, desktop 1366 e mobile 390):
1. `POST /__e2e/reset`; login `owner@demo.test` / `Senha-e2e-123`.
2. Contatos: `POST /api/contacts { name, phone }` (o seed não tem contatos).
3. Conexão: `POST /api/connections { name }` → `connection.session_id`; `POST /__e2e/wa/sessions/:sessionId/state { to: 'open' }` e esperar `GET /__e2e/wa/deliveries?stream_id=…&wait_ms=10000` (`acked`). Sem isso a criação dá 409 `SESSION_NOT_CONNECTED`.
4. Fluxo acionável: `POST /api/flows { name }` → `PUT /api/flows/:id/definition` (start → message, como em `tests/acceptance/T60/setup.ts`) → `POST /api/flows/:id/activate`.
5. `/mass-dispatches` → `mass-dispatch-new` → (1º alvo pré-preenchido) → next → next → `mass-dispatch-wizard-submit` → `mass-dispatch-confirm-ok`.

Observado:
- A preparação roda no harness (com a mudança no `scripts/e2e/api.ts`) e chega a `completed` em ~120 ms, `3 / 3 agendados`. As fases intermediárias passam rápido demais para o olho: no teste, confira `data-phase="completed"` e `data-state` das fases, não cada transição.
- **SSE confirmado:** com o GET do detalhe bloqueado (`page.route` com abort), o modal chegou a `completed` só pelo evento `mass_dispatch.updated`.
- Atalho de Contatos: marcar 2 contatos (`contacts-select-${id}`) e clicar `contacts-bulk-dispatch` abre o wizard em `/mass-dispatches` com `mass-dispatch-audience-draft` marcado e `data-count=2`. Recarregar não reabre o wizard.
- Cancelar pelo detalhe → `data-status="cancelled"`, toast "3 envio(s) devolvido(s) à cota", "Usados" volta a 0. Member vê a página sem `mass-dispatch-new` e sem `-item-cancel-`.
- Limite diário 50 numa conexão nova → warning `mass-dispatch-warning-daily_limit_exceeds_warmup` ("…capacidade de aquecimento… hoje (20)").
- Mobile 390 px: sem rolagem horizontal (`scrollWidth = clientWidth = 390`). Sem erros no console.

## Notas / pendências

- **Cards "Em andamento"/"Concluídos"** contam só a página carregada (`limit=100`, página atual do Pager), porque não há rota de contagem. Com mais de 100 disparos os números ficam parciais. Uma rota `status_counts` na API (T60) resolveria.
- **A/B:** o DTO não traz contagens por variante (aSent/bSent da referência), então o detalhe mostra os nomes do fluxo A e B e "Sem teste A/B". O wizard não expõe `flow_b_id`, igual à referência ([NÃO VERIFICADO] no doc). Para mostrar contagens A/B, a T60 precisaria somar por `variant` no DTO.
- **Público sem rascunho:** além da seleção vinda de Contatos, o wizard oferece "Todos os contatos" (`all_except` sem filtros) e um link para Contatos. Não há seleção por ids dentro do wizard (a referência também usa Contatos).
- **Fuso:** a web não envia `time_zone` (vale o padrão da empresa no servidor); o detalhe mostra o fuso gravado.
- **Cancelado mostra `0 / 0`** no progresso, porque `total_count` da T60 não conta os cancelados. O detalhe mostra pendentes e ignorados.
- **`scripts/e2e/api.ts`:** a linha do `createApp` também é tocada pela T90 (`configureInboundSales`). Se houver conflito no gate, mantenha `waGateway` no `createApp` e as duas chamadas `configure*`.
- Na produção já existe `configureMassDispatch` (T122), sem pendência de boot. Não há migration.
- Envio real (ticks / `flow-step`) não roda no harness, como decidido. Os ACs não dependem dele.
