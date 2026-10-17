# T71 — UI conexões · entrega do operário

```text
DONE T71 operario
STATUS: DONE
Verify: 0 (node spec/verify/verify.mjs T71 --role operario --base d0ed1aa) — APROVADO, 17 arquivos no escopo
```

Rodei o verify duas vezes, as duas com exit 0: na 1ª entrega e de novo depois do ajuste do proxy (23:29).

## Arquivos alterados
- `apps/web/src/routes/connections/index.tsx`: substitui o placeholder. Tem `validateSearch` e chama `registerConnectionsRealtime()` no topo.
- `apps/web/src/features/connections/{api.ts,logic.ts,realtime.ts,page.tsx,dialogs.tsx,connections.unit.test.ts}` (novos).
- `apps/web/src/i18n/{pt-BR,en,es}/connections.json` (novos).
- `packages/core/src/connections/service.ts` (aditivo):
  - `list()` devolve `limits` e, em cada item, `paused_flows_count`;
  - `limits()` é novo e o `assertBelowLimit` passa a usá-lo;
  - a regra da senha do proxy mudou (ajuste abaixo).
- `packages/core/src/connections-status/paused-flows.ts` e `paused-flows.db.unit.test.ts` (novos); `index.ts` só ganhou o export.
- `apps/api/src/routes/connections/index.ts` (aditivo: rotas `paused-flows`) e `connections-t71.db.unit.test.ts` (novo).
- `apps/api/src/e2e/index.ts` (aditivo): `POST /__e2e/wa/sessions/:sessionId/state`, `sessionStateSchema` e `driveFakeSession`.

## Ajuste pedido pelo Orquestrador: senha do proxy (2ª rodada)
- **Backend** (`ConnectionsService.setProxy`, rota `POST /api/connections/:id/proxy`):
  - `password` ausente, `null` ou `''` **mantém** a senha salva, como nos outros segredos do CRM;
  - senha nova substitui a salva;
  - `remove_password: true` apaga só a senha e mantém o proxy;
  - `remove_password` que não seja booleano → 422;
  - `password` junto com `remove_password: true` → 422 `VALIDATION_ERROR` (`fields[].path = remove_password`);
  - `DELETE /:id/proxy` ("Remover proxy") continua apagando tudo.
- **Teste:** `apps/api/src/routes/connections/connections-t71.db.unit.test.ts`, describe "AC-T71-03 proxy: senha vazia mantém a salva". Ele decifra a senha gravada em cada passo: mantém (ausente, `''`, `null`), troca, recusa o par senha+remover (422), apaga com `remove_password`.
- **UI:**
  - novo hint "Há uma senha salva (não é exibida). Deixe em branco para mantê-la ou digite uma nova para trocar.";
  - checkbox `connections-proxy-remove-password` ("Apagar a senha salva"), que só aparece quando existe senha salva e fica desabilitado enquanto há senha digitada;
  - `proxyInputOf` só manda `password` quando há valor e `remove_password: true` quando o checkbox está marcado sem senha nova;
  - teste unitário em `connections.unit.test.ts`;
  - i18n nas 3 línguas.
- A asserção existente da T40 (`connections.db.unit.test.ts`, AC-T40-04) não dependia do comportamento antigo e não foi alterada.

## Backend
- **Limite:** `GET /api/connections` agora traz `limits: { connections: number|null, used }` (`used` não conta as conexões com `scheduled_for_deletion_at`). Cada item traz `paused_flows_count`.
- **Fluxos pausados na queda:**
  - `GET /api/connections/:id/paused-flows` (`flows.view`) → `{ paused_count, total_leads }`;
  - `POST /:id/paused-flows/resume` (`flows.run`) → `{ resumed }`. O run volta a `waiting` com prazo = agora + `remaining_ms` e `timer_gen + 1`. O timer é reagendado via `FlowControl.scheduleWait`. Saem `paused_by`, `connection_id` e `paused_at`. Publica `flow.resumed { connection_id, session_id, resumed_count }`;
  - `POST /:id/paused-flows/cancel` (`flows.run`) → `{ cancelled }`. Usa `FlowControl.cancel` para cada run e publica `flow_run.cancelled`;
  - conexão de outra empresa → 404.
- **Harness:** `POST /__e2e/wa/sessions/:sessionId/state`.
  - Corpo: `{ to: 'qr'|'connecting'|'open'|'close', qr?, code?, session_state?: WARMING|STABLE|DEGRADED (padrão STABLE), reason?: transient|loggedOut|forbidden, status_code? }`.
  - Resposta: 202 `{ session, events: [{ type, stream_id }], stream }`.
  - A rota muda o estado da sessão no FakeWaGateway e faz XADD no stream dos eventos que o fake gerou:

    | `to` | O que acontece no fake | Eventos no stream |
    |---|---|---|
    | `qr` | `startQr` | `session.qr` (o último leva o `qr` pedido) |
    | `connecting` | sessão volta a `NEW` | `session.state` + `session.pairing_code` |
    | `open` | sessão em `session_state` | `session.state` + `session.connection open` |
    | `close` | sessão `DISCONNECTED` | `session.state` + `session.connection close` com `reason`/`status_code` |

  - No `qr`, o `GET /:id/qr` continua devolvendo o `FAKE_QR`; só o evento leva o valor pedido.
  - Sessão desconhecida → 404; corpo inválido → 422.
  - Como a sessão do fake muda de verdade, o refetch do `GET /api/connections` confirma o status. Não há escrita direta no cache do cliente.
- **Produção:** nada novo para ligar no boot. As rotas ficam só na API e o projetor da T47 não mudou.

## Web
- **Cache × refetch:**
  - `connection.status_changed`, `connected` e `disconnected` aplicam o payload no cache (`setQueryData`); um invalidate com debounce de 400 ms confirma pela API;
  - `qr_updated` e `pairing_code` gravam o valor no cache do modal.
- **Realtime:** registrado de forma eager no topo de `routes/connections/index.tsx`.
- **Search params:** `?search=&filter=<status>&page=`. O filtro se chama `filter`, como em `/agentes`. Com `status`, o tipo colidia com o reducer da lista de chats.
- **Permissões:**
  - as ações seguem `connections.edit` e `connections.delete`;
  - "Parar todos", "Fluxos pausados", Retomar e Cancelar exigem `flows.run`;
  - member: o guard do shell exige `connections.view`.

## Testids (contrato com o Tester)
- **Página:**
  - `page-connections`;
  - cards `connections-count-{total|pending|connecting|connected|paused|disconnected|banned}` (`data-count`; o clique filtra);
  - `connections-search` e `connections-status-filter` (`<select>`; o valor `''` mostra todos);
  - `connections-table` (desktop) e `connections-cards` (mobile, < 1024 px);
  - estados: `connections-loading|error|retry|empty|empty-new`;
  - paginação: `connections-prev|next|page`.
- **Item:**
  - `connections-item-${id}` (`data-status`);
  - `connections-item-name-${id}` e `connections-item-phone-${id}`;
  - `connections-item-status-${id}` (`data-status`);
  - `connections-item-badge-{warming|degraded|requires_restart|scheduled_deletion|proxy}-${id}`;
  - `connections-item-created-${id}` e `connections-item-disconnected-${id}` (`'—'` quando nulo).
- **Menu:** `connections-item-actions-${id}` → `connections-actions-menu` → `connections-action-{connect|resume|disconnect|restart|rename|proxy|instance|paused-flows|stop-flows|delete}-${id}`.
- **Nova conexão:**
  - `connections-new` fica desabilitado no limite, com `data-disabled-reason="limit_reached"` e `aria-describedby`;
  - `connections-limit-reason` traz a explicação e só aparece com o limite atingido;
  - `connections-usage` mostra "N de M" ou "N conexões";
  - modal do nome: `connections-name-editor`, `connections-name-input`, `connections-name-save|cancel|error`.
- **Conectar:**
  - `connections-connect`;
  - abas `connections-connect-tab-qr|phone` (`aria-selected`);
  - QR: `connections-qr-image` (`data-qr` = data URL), `connections-qr-loading`, `connections-qr-refresh`;
  - código: `connections-pairing-phone`, `connections-pairing-submit`, `connections-pairing-code` (`data-code`), `connections-pairing-phone-error`;
  - `connections-connect-close`;
  - fecha sozinho quando chega `connection.connected` (toast `connections-connected`).
- **Proxy:** `connections-proxy-editor`, `-restart-warning`, `-protocol`, `-host`, `-port`, `-username`, `-password` (`type=password`; placeholder •••• quando `has_password`), `-remove-password` (novo), `-remove`, `-save`, `-cancel`.
- **Instância:** `connections-instance-editor`, `-ephemeral` (`off|1d|7d|90d`), `-save-contacts`, `-notify-mine`, `-save`.
- **Parar todos:** `connections-stop-flows`, `connections-stop-flows-name`, `connections-stop-flows-confirm` (desabilitado até o nome bater exatamente), `-cancel`, `-error`.
- **Retomar/Cancelar:**
  - `connections-paused-flows`;
  - contagens `connections-paused-flows-{paused-count|waiting-count|failed-count|received-count|total-leads}` (`data-count`);
  - botões `connections-paused-flows-resume|cancel|later`.
- **Excluir:** `connections-delete-confirm`, `-confirm-ok`, `-confirm-cancel`.

## Como o Tester dirige pelo harness
- **Criar:** `POST /api/connections {name}` devolve o `session_id`.
- **QR:** menu → Conectar (a UI chama `POST /connect` e `GET /qr`).
- **QR que atualiza:** `POST /__e2e/wa/sessions/<session_id>/state {to:'qr', qr:'data:image/png;base64,...'}` e esperar o `data-qr` mudar.
- **Código no telefone:** aba phone, número `5511999999999` → `FAKE1234`. Outra forma: `{to:'connecting', code:'X'}` pelo evento.
- **Conectar:** `{to:'open'}` → o modal fecha, o status fica `connected` e continua `connected` depois do refetch.
- **Desconectar:** `{to:'close', reason:'transient'}` → `disconnected` e a data em "desconectada em". Banida: `reason:'forbidden'`.
- **AC-T71-04:**
  1. Ter um run `waiting` num chat da conexão ANTES da queda: chat criado por `/__e2e/wa/emit message.inbound` e fluxo com espera de resposta disparado nele (rota de disparo da T43 ou gatilho).
  2. `{to:'close'}`: o projetor pausa os runs.
  3. `{to:'open'}`: o projetor publica `reconnected_with_paused_flows` e o modal abre.
  - Não testei esse cenário montado no navegador. O modal aberto pelo evento está coberto em unit; Retomar e Cancelar estão nos `db.unit` de core e api.
- **AC-T71-05:** com login `platform@demo.test`, `PATCH /api/admin/companies/:id {limits:{connections:N}}`. `null` volta a ilimitado.

## Conferido no navegador
Harness real, desktop 1366 e mobile 390 (1ª rodada). Passaram:
- contagens, busca e filtro na URL;
- QR atualizado pelo evento e código no telefone;
- modal fecha no `connected`, e o status sobrevive ao refetch;
- "desconectada em" preenchida na queda;
- proxy: aviso de reinício, senha mascarada e selo de reinício;
- instância;
- "Parar todos" com o nome digitado;
- limite: botão desabilitado no desktop e no mobile;
- cartões no mobile sem rolagem horizontal;
- sem erros de página e sem textos proibidos.

O checkbox de apagar a senha (2ª rodada) foi coberto só pelos testes unitários.

## Testes unitários
- **core:** `paused-flows.db.unit.test.ts` (4 testes).
- **api:** `connections-t71.db.unit.test.ts` (7 testes: 6 da 1ª entrega e 1 do proxy); com os da T40, são 18 no diretório.
- **web:** `connections.unit.test.ts` (10 testes).

## Pendências / outras tarefas
- Ficaram fora (não estão nos ACs): proxy por localização, credenciais, notificar desconexão e perfil do WhatsApp.
- A API não tem a contagem de execuções ativas para o "Parar todos". Não inventei uma.
- O FakeWaGateway não tem setter público para o QR. Por isso o `{to:'qr', qr}` só muda o valor do evento, e o `GET /qr` continua devolvendo o `FAKE_QR`.
- Este arquivo (`spec/reports/T71-entrega.md`) foi criado depois do verify, a pedido do Orquestrador. Se o escopo do gate reclamar dele, é por isso.

## Tempo e brief
- Tempo: ~22 min na 1ª entrega (23:01–23:23) e ~6 min no ajuste do proxy (até 23:29).
- Faltou no brief:
  - o nome do search param do filtro (`status` colide no tipo com chats);
  - como montar um run `waiting` para o E2E do AC-T71-04;
  - a regra da senha vazia do proxy (agora decidida).
