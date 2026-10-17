# T107 — Entrega do Operário (Indicador de conexões desconectadas no menu)

- **Status:** DONE · branch `task/T107` · base `51bf479`
- **Verify:** exit 0 — `node spec/verify/verify.mjs T107 --role operario --base 51bf479`. Passaram typecheck, lint e test (afetados) de `@crm/api` e `@crm/web`, `i18n:check`, `build`, as regras FORBIDDEN e o escopo (12 arquivos).
- **Tempo:** 00:30 → 00:42 (2026-10-17), ~12 min de relógio, incluindo o verify, o harness e a conferência no navegador.

## Arquivos
| Arquivo | O quê |
|---|---|
| `apps/api/src/routes/connections-alert/index.ts` | `GET /api/connections/disconnect-alert` → `{ has_recent_disconnected, last_disconnected_at }`. Relógio injetável em `deps.connectionsAlert.now` (declaration merging em `AppDeps`). |
| `apps/api/src/routes/connections-alert/connections-alert.db.unit.test.ts` | 6 testes: AC-01 (vazio, janela, limite exato de 24 h, reconectada, agendada para exclusão, outra empresa) e AC-03 (owner, admin, member com e sem a chave, support como membro e por concessão) |
| `apps/api/src/routes/index.ts` | **compartilhado, aditivo:** import e `app.route('/', connectionsAlertRoutes(deps))` **antes** de `connectionsRoutes`, com comentário |
| `apps/web/src/features/shell-disconnect/api.ts` | query `['shell-disconnect', companyId]` (`staleTime: Infinity`), `canSeeDisconnectAlert`, `isAlertActive` |
| `apps/web/src/features/shell-disconnect/realtime.ts` | handlers `onRealtime` (ligam o indicador no cache ou refazem a consulta) |
| `apps/web/src/features/shell-disconnect/indicator.tsx` | `DisconnectIndicator` (ponto vermelho; `ml-auto` com a barra aberta, sobre o ícone com ela recolhida) |
| `apps/web/src/features/shell-disconnect/shell-disconnect.unit.test.ts` | 7 testes (AC-01..04) com `QueryObserver` e contador de consultas |
| `apps/web/src/app/shell/nav-list.tsx` | **liberado, aditivo:** import e `{item.id === 'connections' ? <DisconnectIndicator …/> : null}` no conteúdo do item |
| `apps/web/src/app/shell/app-shell.tsx` | **liberado, aditivo:** `import '@/features/shell-disconnect/realtime'` estático, com comentário |
| `apps/web/src/i18n/{pt-BR,en,es}/shell-disconnect.json` | `indicator.label` ("Instância desconectada nas últimas 24h") |

Prettier rodou só nos meus arquivos. Nos compartilhados (`index.ts`, `nav-list.tsx`, `app-shell.tsx`) as mudanças são linhas inseridas, sem reformatação.

## Decisões / Notas
- **Liberação do shell:** usei só o que o Orquestrador liberou: o slot em `nav-list.tsx` e o import estático em `app-shell.tsx`. `nav-list` já importa o `indicator` de forma estática, e o `indicator` importa o `realtime`. Mesmo assim, o import no `app-shell` deixa o registro explícito.
- **Ordem das rotas:** `connectionsAlertRoutes` vem antes de `connectionsRoutes` (`/api/connections/:id`). O teste confirma 200 com o JSON exato.
- **Regra das 24 h:** conta uma conexão da empresa ativa com `disconnected_at > now − 24h` e `scheduled_for_deletion_at IS NULL`. Conexões agendadas para exclusão não contam. Exatamente 24 h atrás não conta (`>`). O `open` não zera `disconnected_at`, então o indicador continua aceso depois de reconectar enquanto a queda tiver menos de 24 h. `last_disconnected_at` é a queda mais recente. No cliente, `isAlertActive` apaga o indicador quando `last_disconnected_at` sai da janela, o que cobre uma aba aberta por muito tempo. Isso é recalculado a cada render; não há timer.
- **Eventos (AC-02):** `connection.disconnected`, `connection.disconnected_alert`, `connection.banned_alert` e `flow.auto_paused` chamam `setQueryData` (sem consulta) na chave da empresa do evento, usando `data.disconnected_at` ou, na falta dele, `e.at`, e mantendo a queda mais recente. `connection.connected` e `connection.deleted` chamam `invalidateQueries` e refazem a consulta. `connection.updated` e `connection.status_changed` **não** fazem nada aqui: isso foge da ref §7, para que a queda não gere consulta. Os handlers `connection.*` da T71 (`features/connections/realtime.ts`) não foram tocados nem são usados.
- **AC-03:** a web não renderiza nem consulta (`enabled: false`) quando `session.isSupport`, quando não há empresa ou quando falta `hasAny(session, ['connections.view'])` (owner passa). A API responde 403 sem `connections.view` (`requirePerm`) e também para support, seja por `ctx.supportGrant`, seja por `user.systemRole === 'support'` mesmo tendo a chave.
- **AC-04:** a chave inclui `companyId`. O `resetQueries` do `switchCompany` refaz a consulta, e o teste unitário cobre isso. O `X-Company-Id` vai pelo cliente HTTP global.
- **Testids e rótulo:** `shell-disconnect-indicator` (`role="img"`, com `aria-label` e `title` = "Instância desconectada nas últimas 24h" em pt-BR) fica dentro de `nav-item-connections` e só existe quando aceso.
- **Conferência no navegador (harness, desktop 1366, sidebar aberta e recolhida):** owner, conexão criada por `POST /api/connections`. Ao carregar: 1 consulta, sem indicador. Depois de `state open`: +1 consulta (`connected`). Depois de `state close`: **+0 consultas** e o indicador aparece com o aria-label correto. Depois de outro `state open`: +1 consulta, e o indicador continua aceso pela regra das 24 h. `member@`: 0 consultas e nenhum indicador. Não conferi no mobile; o brief manda E2E só no desktop. No drawer mobile o mesmo `NavList` mostra o ponto.
- **Sem migration.** Não há consumidor, job nem `configure*` novo para ligar em produção.

## Contrato para o Tester
- API: `GET /api/connections/disconnect-alert` → 200 `{ has_recent_disconnected: boolean, last_disconnected_at: string | null }`. member (sem `connections.view`) → 403; support → 403.
- Web: `[data-testid=nav-item-connections] [data-testid=shell-disconnect-indicator]`, com `aria-label` "Instância desconectada nas últimas 24h". Fica ausente enquanto `false`.
- AC-02: com `page.on('request')` em `/api/connections/disconnect-alert`, a queda (`POST /__e2e/wa/sessions/:sid/state {to:'close'}`) gera 0 requisições a mais e a reconexão (`{to:'open'}`) gera ≥ 1. Atenção: se a conexão acabou de ser criada (pending), o primeiro `open` também gera consulta. Meça a partir do momento imediatamente anterior à queda.
- AC-04: criar a 2ª empresa (`POST /api/companies`), trocar pelo seletor e esperar nova chamada com o `X-Company-Id` da nova empresa.

## Pendências para outras tarefas
- Nenhuma bloqueante. A ref §7 também prevê o modal de desconexão (`disconnect_alert_dismissed_*`, `disconnected_connections[]`, `paused_adsets[]`), que está fora do escopo da T107 (spec 08/14). Se outra tarefa o fizer, pode estender esta rota com campos novos sem quebrar o contrato.
