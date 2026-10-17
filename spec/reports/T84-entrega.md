# T84 — UI: central de notificações · entrega do operário

STATUS: DONE

Tempo: 23:33 → 23:46 (≈ 13 min), 2026-10-16. Base 1bb962d (branch não avançou).

## Arquivos alterados
- `apps/web/src/features/notifications/model.ts`: regras puras. Preferências com os padrões de 14#10 e volume preso em 0–100, badge "9+", TTL de 1 h, chat aberto por `/chats/<id>`, decisão de som, itens de mensagem e genéricos, destino do clique.
- `apps/web/src/features/notifications/store.ts`: store de módulo (`useSyncExternalStore`). Itens em `localStorage["notification_center"]`, preferências em `localStorage["notification_settings"]`, sinal de som.
- `apps/web/src/features/notifications/effects.ts`: efeitos no navegador.
  - Toast `notifications-toast` de 3 s.
  - Som por oscilador WebAudio.
  - Notification API: só com a aba em segundo plano, fecha em 5 s. A permissão só é pedida ao ligar "Receber no dispositivo".
- `apps/web/src/features/notifications/realtime.ts`: handlers de `message.created` e `notification.created`. O nome do contato vem do cache (`['chat', id]` / `['chat-list', …]`). Fora do cache, faz `GET /api/chats/:id` via `chatDetailQuery`, com timeout de 1,5 s; se falhar, usa "Nova mensagem".
- `apps/web/src/features/notifications/bell.tsx`: sino, badge, popover, lista e preferências.
- `apps/web/src/features/notifications/notifications.unit.test.ts`: 26 testes, cada `describe` com o AC no título.
- `apps/web/src/i18n/{pt-BR,en,es}/notifications.json`
- `apps/web/src/app/shell/app-shell.tsx` (liberado, só aditivo, +4 linhas, sem prettier):
  - import estático de `NotificationBell`;
  - `<NotificationBell session collapsed />` na sidebar, logo acima do `ShellFooter`;
  - `<NotificationBell session />` no header mobile, antes do `UserMenu`.

## Verify
`node spec/verify/verify.mjs T84 --role operario --base 1bb962d` → **exit 0**: typecheck, lint, test, i18n:check, build, regras FORBIDDEN e escopo (10 arquivos), todos ok.

Também rodei um smoke manual com Playwright contra o harness (`serve.mjs`, build atualizado), com tudo ok:
- badge 1 e depois 9+;
- som `data-sound-count`, toast, 11 itens;
- clique leva a `/chats/<id>`;
- com o chat aberto, não notifica;
- volume 0 e prefs persistidas após recarregar;
- "Restaurar padrão";
- `notification.created` gera toast e item genérico;
- item com mais de 1 h some;
- sino no header mobile.

## Contrato com o Tester (testids)
- **Sino:** `notifications-bell` (botão; também abre e fecha a central).
  - **Sinal de som:** `data-sound-count` conta quantas vezes o som foi decidido e disparado (começa em 0 a cada carga da página). `data-last-sound-volume` guarda o volume dessa última vez e `data-last-sound-at` o horário em epoch ms. Com volume 0, sons desligados, central desligada ou gravação de áudio em curso, o contador NÃO muda.
- **Badge:** `notifications-badge`, só existe com não lidas. O texto vai de "1" a "9" ou é "9+"; `data-count` traz o número real.
  - Fechar a central marca todas como lidas, e o badge some.
  - Clicar num item marca só aquele item.
- **Central:** `notifications-panel`, `notifications-list`, `notifications-empty` ("Nenhuma notificação") e `notifications-clear` ("Limpar").
- **Item:** `notifications-item-<id>` com `data-kind` (`message` ou `generic`), `data-chat-id` (só `message`) e `data-read`. Título em `notifications-item-title-<id>` e corpo em `notifications-item-body-<id>`.
  - Em `message`, `<id>` = id da mensagem (`message.id` do evento).
  - Em `generic`, `<id>` = `n-<id do evento SSE>`.
  - Para achar sem o id: `[data-testid^="notifications-item-"][data-kind="message"][data-chat-id="<chatId>"]`.
- **Toast:** `notifications-toast` (3 s; título = nome do contato ou título do evento; descrição = corpo).
- **Preferências** (dentro da central):
  - Sempre visíveis: `notifications-prefs-browser` (checkbox), `notifications-prefs-volume` (`input[type=range]` 0–100; use `fill('0')`) e `notifications-prefs-volume-value` ("50%").
  - Depois de clicar em `notifications-prefs-advanced`: `notifications-prefs-enabled`, `notifications-prefs-toast`, `notifications-prefs-sounds` (checkboxes) e `notifications-prefs-reset`.
- **Persistência:** `localStorage["notification_settings"]` = `{enabled, volume, browserNotifications, toastNotifications, sounds}`.

## Como disparar no E2E
- **AC-T84-01/02/03:** use `createConnection` + `inbound(page, session_id, phone, {text})` de `tests/acceptance/helpers/chats-e2e.ts`. A página precisa estar fora de `/chats/<id>` desse chat; para o AC-02, abra `/chats/<id>` e emita de novo. "9+": 10 inbound.
- **Expiração (AC-T84-03):**
  - Opção 1: `page.clock.install()` antes do `goto`, emitir e depois `page.clock.fastForward('01:01:00')`. A limpeza roda a cada 10 min e a lista refiltra ao abrir.
  - Opção 2: envelhecer `at` dos itens em `localStorage["notification_center"]` e recarregar (é o que o smoke fez).
- **AC-T84-05 (`notification.created`):** não há rota `/__e2e` que publique evento.
  - **Caminho real:** fluxo com o bloco Venda aprovada e template de push (`tests/acceptance/T112/setup.ts` `saleFlow` + `runSale`/T123). Só owner/admin recebem.
  - **Caminho simples, testado no smoke:** embrulhar o `EventSource` com `addInitScript` e despachar um evento sintético na conexão real.
    ```js
    await context.addInitScript(() => { const O = window.EventSource; window.__es = []; window.EventSource = class extends O { constructor(...a) { super(...a); window.__es.push(this) } } })
    // depois do sino aparecer:
    await page.waitForFunction(() => window.__es.length > 0)
    await page.evaluate(() => window.__es.at(-1).dispatchEvent(new MessageEvent('notification.created', { data: JSON.stringify({ title: 'Venda aprovada', body: 'R$ 97,00', url: null }), lastEventId: 'e2e-1' })))
    // → toast notifications-toast com "Venda aprovada" e item notifications-item-n-e2e-1 (data-kind=generic)
    ```

## Notas
- **Liberação do shell:** `app-shell.tsx` recebeu só acréscimos (import + 2 usos), no padrão T59/T54. O import estático garante que `message.created` e `notification.created` estejam registrados antes de o SSE abrir.
- **`/chats` vs `/chat`:** o AC-T84-03 cita `/chat/<id>`, mas o clique navega para a rota real `/chats/<id>`. O Tester deve esperar `/chats/<id>`.
- **Permissão:** `notification.created` exige `dashboard.sales` (owner/admin); member não recebe, por decisão do servidor. Não pedi mudança.
- **Dados só no navegador:** não há rota nem tabela nova; itens e preferências ficam no `localStorage`, como na ref (14 §Lacunas). Os itens são filtrados pela empresa ativa (`company_id` do envelope).
- **"Ativo" desligado:** sem item, toast, som ou navegador. **Toast desligado:** o item entra e o som toca. **Navegador:** só notifica com permissão concedida e aba oculta.
- **Item genérico com `url`:**
  - caminho interno (`/x`): navega;
  - `http(s)`: abre em nova aba (`noopener`);
  - outro formato (`javascript:`, `//`): ignorado.

  O único produtor hoje (T63) manda `url: null`.
- **Dedupe por id:** a reentrega do SSE após reconectar não duplica o item nem toca de novo.
- **Pendências para outras tarefas:**
  - O `Toaster` do shell (T23) passa `limit={3}`, mas numa rajada (10 mensagens) mostrou os 11 toasts empilhados; parece faltar o estilo de colapso do Base UI. É cosmético e sai em 3 s; fica com quem mantém `components/toaster.tsx`.
  - Anúncios e banners (14 itens 12–15) estão fora da T84.
