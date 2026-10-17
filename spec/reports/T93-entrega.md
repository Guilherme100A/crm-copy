# T93 — Assistente (copiloto) de fluxo (entrega do Operário)

- **Branch/worktree:** `task/T93` · `leonas-crm-wt/T93` · base `bea292d`
- **Tempo:** início 2026-10-17 00:44, verify aprovado 01:21 (≈ 38 min, ~6 min esperando a fila de verify)
- **STATUS:** DONE — `node spec/verify/verify.mjs T93 --role operario --base bea292d` → exit 0

## Arquivos
- `packages/db/src/schema/crm/flow-copilot.ts` — `crm.flow_copilot_sessions` (company, flow, user, title, status `active|paused_quota|archived`, `status_before_archive`, `last_message_at`) e `crm.flow_copilot_messages` (role `user|assistant`, content, status `completed|failed`, `client_message_id` único por sessão, `tool_calls` jsonb, `credits`, `error_code`).
- `packages/db/drizzle/crm/0034_t93_flow_copilot.sql` + `meta/0034_snapshot.json` + `_journal.json` (gerada com `db:generate:crm --name t93_flow_copilot`, sem SQL manual).
- `packages/db/src/schema/crm/index.ts` — aditivo: `export * from './flow-copilot.js'`.
- `packages/core/src/flow-copilot/` — `edits.ts` (edições puras na FlowDefinition + `newValidationErrors`), `service.ts` (`FlowCopilotService`), `index.ts`, `edits.unit.test.ts` (7), `service.db.unit.test.ts` (9, Postgres/Redis reais, UsageGuard real, FakeLlm).
- `packages/core/src/index.ts` — aditivo: `export * from './flow-copilot'`.
- `apps/api/src/routes/flow-copilot/index.ts` + `flow-copilot.db.unit.test.ts` (4, HTTP).
- `apps/api/src/routes/index.ts` — aditivo: import + `app.route('/', flowCopilotRoutes(deps)) // T93` no fim.
- `packages/shared/src/realtime/events.ts` — aditivo: `copilot.delta`, `copilot.completed` (perm `flows.view`) + comentário documentando `source`/`session_id` opcionais no `flow.graph_updated`.
- `apps/web/src/features/flow-copilot/` — `api.ts`, `stream.ts` (registro SSE + acúmulo de deltas), `copilot.tsx` (botão + painel), `index.ts`, `flow-copilot.unit.test.ts` (4).
- `apps/web/src/i18n/{pt-BR,en,es}/flow-copilot.json`.
- **Liberações aditivas do Orquestrador:**
  - `apps/web/src/features/flow-editor/canvas/editor.tsx`: 1 import (`import { FlowCopilot } from '../../flow-copilot'`, logo depois do import de `./realtime`) + 1 linha logo no início do `<div className="ml-auto …">` do cabeçalho: `<FlowCopilot flowId={flowId} beforeSend={() => saver.flush()} />`. Fica longe das linhas da T82 (import depois de `PropertiesPanel`; `<FlowSimulator/>` antes de `flow-properties-toggle`): a união no gate não conflita.
  - `apps/web/src/routes/flows/$flowId/edit.tsx`: import + `registerFlowCopilotRealtime()` logo depois de `registerFlowEditorRealtime()` (estático, no chunk da rota que não é dividido).

## Rotas (todas `requirePerm('flows.view')`; sessão é do usuário — de outro usuário/empresa → 404)
| Método | Caminho | Corpo / resposta |
|---|---|---|
| GET | `/api/flow-copilot/sessions?flow_id=&include_archived=1` | `{ items: Session[], can_edit, tools: string[] }` (arquivadas só com `include_archived`); fluxo de outra empresa → 404 |
| POST | `/api/flow-copilot/sessions` | `{ flow_id, title? }` → 201 `{ session }`; `flow_id` inválido → 422; de outra empresa → 404 |
| GET / PATCH | `/api/flow-copilot/sessions/:id` | PATCH `{ title }` → `{ session }` |
| POST | `/api/flow-copilot/sessions/:id/archive` \| `/reopen` | `{ session }` (reabrir devolve `paused_quota` se estava pausada) |
| POST | `/api/flow-copilot/sessions/:id/resume` | `paused_quota` → `active` só com saldo; sem saldo → 429 `QUOTA_EXCEEDED` (`details.reason = 'paused_quota'`, sessão continua `paused_quota`); arquivada → 409 `INVALID_TRANSITION` |
| GET | `/api/flow-copilot/sessions/:id/messages` | `{ items: Message[] }` (ordem cronológica) |
| POST | `/api/flow-copilot/sessions/:id/messages` | `{ content (1..8000), client_message_id? }` → 201 `{ session, message, reply, graph_changed }` (síncrono: volta ao fim do turno). Arquivada → 409 `INVALID_TRANSITION` (`reason: 'archived'`); pausada ou cota esgotada no turno → 429 `QUOTA_EXCEEDED` (`details.reason = 'paused_quota'`, `session_id`); conteúdo vazio → 422. Mesmo `client_message_id` devolve o turno já feito (sem LLM). Falha do provedor → 201 com `reply.status = 'failed'` |

`Session = { id, flow_id, title, status, last_message_at, created_at, updated_at }` (título = primeiros 60 caracteres da 1ª mensagem).
`Message = { id, session_id, role, content, status, client_message_id, tool_calls: [{ name, input, ok, output }], credits, error_code, created_at }`.

## Eventos (SSE)
- `copilot.delta` (só para o dono, `userId`): `{ session_id, flow_id, message_id, kind: 'tool', tool, ok, error? }` — um por ferramenta, emitido NA HORA em que ela roda; e `{ …, kind: 'text', delta }` — o texto final em até ~20 pedaços (concatenados = `reply.content`). `message_id` = id da resposta do assistente.
- `copilot.completed` (dono): `{ session_id, flow_id, message_id, status: 'completed'|'failed'|'paused_quota', graph_changed, error_code? }`.
- `flow.graph_updated` (empresa, `flows.view`): `{ flow_id, actor_id: null, mutation, source: 'ai', session_id }` — um por edição gravada, publicado DEPOIS do `fromDefinition` (commit). `mutation` ∈ `add_node`, `update_action`, `add_connection`, `delete_connection`, `delete_node`.

## Ferramentas (FakeLlm chama pelo nome)
- Sempre: `get_flow {}` (nós com ids/ações/saídas possíveis, arestas, erros de `validate`), `list_block_types {}`.
- Só com `flows.edit` no momento do turno: `create_node { type, name?, position?, actions?: [{type, config}], connect_from?: {node_id, handle} }` → `{ ok, node_id, action_ids, edge_id? }`; `update_action { node_id, action_id, config, replace? }` (mescla; `replace` substitui); `connect { from, handle, to }` (troca o destino se a saída já estava ligada); `disconnect { from, handle }`; `delete_node { node_id }` (Início não).
- Validação (AC-02): a edição é aplicada em memória, `validate()` (T10) roda antes e depois e **só erros novos** recusam. Toleramos os de rascunho em construção: `unreachable_node`, `no_node_after_start`, `missing_action` (o editor também deixa bloco solto/sem ação; a ativação continua exigindo zero erros). Recusa = a ferramenta lança → volta ao modelo como resultado com erro (`isError`) "Alteração recusada pela validação (nada foi gravado): invalid_action_config (nó …): …"; nada é gravado nem publicado; o loop continua.

## Roteiro do FakeLlm por AC (harness: `POST /__e2e/llm/script { steps, replace: true }`; saldo: `POST /api/platform/companies/<id>/ai/topups {credits, note}` como `platform@demo.test`)
- **AC-01:** `[{kind:'text', text:'Olá!'}]` → POST messages 201; `copilot.delta` kind text + `copilot.completed` status completed; GET messages = user, assistant; archive → POST messages 409; reopen → active.
- **AC-02:** `[{kind:'tool-calls', calls:[{name:'create_node', input:{type:'message', actions:[{type:'send_message', config:{}}], connect_from:{node_id:<entry>, handle:'source'}}}]}, {kind:'text', text:'…'}]` → `reply.tool_calls[0].ok = false`, `output` cita `invalid_action_config`, definição (`GET /api/flows/:id/editor-bundle`) inalterada, nenhum `flow.graph_updated`. (Também: `connect` com handle que o nó não tem → `invalid_handle`.)
- **AC-03:** igual com `config:{message_text:'Olá!'}` e `name:'Boas-vindas IA'` → `graph_changed: true`, nó na definição, `flow.graph_updated {actor_id:null, source:'ai', mutation:'add_node'}`; na UI o canvas (`flow-canvas`) mostra o bloco sem recarregar e aparece o toast `flow-copilot-canvas-updated` ("Canvas atualizado"). Conferido no navegador (harness, desktop e 390 px).
- **AC-04:** empresa sem saldo (o seed não tem créditos) → POST messages 429 `QUOTA_EXCEEDED` (`details.reason:'paused_quota'`), `GET /sessions/:id` status `paused_quota`, LLM não é chamado, `copilot.completed` status `paused_quota`; `resume` → 429; recarga → `resume` 200 `active`.
- **AC-05:** membro só com `flows.view` (ex.: `member@demo.test` com permissões ajustadas) → `GET sessions` `can_edit:false`, `tools:['get_flow','list_block_types']`; roteiro com `create_node` → a ferramenta não existe para o modelo (FakeLlm devolve "Tool desconhecida"), resposta `completed`, definição inalterada; painel mostra `flow-copilot-readonly`.

## Testids (UI)
| Elemento | testid / atributos |
|---|---|
| Botão no cabeçalho | `flow-copilot-toggle` (`aria-expanded`) |
| Painel | `flow-copilot` (`data-state` = `idle` \| `sending` \| `paused` \| `archived` \| `error`; `data-session-id`) |
| Seletor de conversas | `flow-copilot-sessions` (select) · nova `flow-copilot-new` · arquivar `flow-copilot-archive` · reabrir `flow-copilot-reopen` · mostrar arquivadas `flow-copilot-show-archived` (checkbox) · fechar `flow-copilot-close` |
| Lista | `flow-copilot-messages`; item `flow-copilot-message` (`data-role` user\|assistant, `data-status` completed\|failed\|sending) |
| Resposta em andamento (deltas) | `flow-copilot-streaming` |
| Ferramenta usada | `flow-copilot-tool` (`data-tool`, `data-ok` true\|false) |
| Entrada / enviar | `flow-copilot-input` (textarea; Enter envia) · `flow-copilot-send` |
| Pausa por cota | `flow-copilot-paused` + `flow-copilot-resume`; sem saldo ao retomar: `flow-copilot-resume-error` |
| Somente leitura | `flow-copilot-readonly` |
| Estados | `flow-copilot-loading`, `flow-copilot-empty`, `flow-copilot-load-error`, `flow-copilot-error` |
| Toast | `flow-copilot-canvas-updated` |

## Notas
- **Delta sem streaming na porta:** `copilot.delta` é sintético — um por ferramenta, emitido quando ela roda (enquanto o loop do modelo continua), e o texto final quebrado em pedaços (≤ ~20) depois do `generate`. O POST de mensagem é síncrono e devolve o turno completo; o SSE serve para mostrar o andamento.
- **`actor_id` do `graph_updated`:** `null` (com `source: 'ai'` e `session_id`), porque o `isForeign` da T45 descarta eventos do próprio usuário; assim o canvas de quem conversa também recarrega (conferido no navegador).
- **LLM lido a cada turno:** `llm: () => deps.flowCopilotLlm ?? deps.e2e?.llm ?? createCompanyLlmProvider(...)` — sobrevive ao `replace` do harness. Nunca LLM real nos testes (FakeLlm).
- **Medição/cota:** turno passa pelo `UsageGuard` (feature `flow_copilot`, `agent_id` nulo) com reserva fixa de 1 crédito (só exige saldo positivo; o débito real vem do uso, overrun como a referência). `LlmQuotaExceededError` → sessão `paused_quota`. `resume` confere saldo com o mesmo `reserve` (sem débito). Modelo: preset `balanced` da empresa/plataforma → env `FLOW_COPILOT_MODEL=provider:model` → `anthropic:claude-sonnet-5-5` (tem preço no seed).
- **Permissão:** `flows.edit` lida do contexto da requisição a cada turno; sem ela as ferramentas de escrita nem são enviadas ao modelo e as instruções dizem que é só leitura.
- **`chat_only` do resume:** não implementado (opcional pela decisão).
- **Concorrência:** cada edição faz ler → aplicar → `fromDefinition` (substitui o rascunho inteiro, transação). Uma edição manual simultânea no mesmo instante pode ser sobrescrita (o painel salva o pendente — `saver.flush()` — antes de enviar).
- **Regra F-SEND-CHOKEPOINT:** o 1º verify reprovou porque o método do serviço se chamava `sendMessage`; renomeado para `runTurn`.
- **Eventos novos em `events.ts`:** `copilot.delta`, `copilot.completed`.
- **Migration:** `0034_t93_flow_copilot` gerada normalmente; se colidir no gate, regenerar com o mesmo nome.
- **Pendências para outras tarefas:** nada a ligar no worker (tudo roda no processo da API). Histórico de uso por sessão (07 §3.9 "Usage history") e anexos/voz do composer ficaram fora do AC. Painel do assistente e do simulador (T82) usam a mesma posição fixa à direita; se os dois forem abertos juntos, um cobre o outro (ajuste de layout fica para o gate/tarefa de UI se desejado).
- Harness encerrado ao terminar.
