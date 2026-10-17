# T57 — UI editores de nó: lógica, CRM e externos (entrega do Operário)

- **Branch/worktree:** `task/T57` · `leonas-crm-wt/T57` · base `1a208a4`
- **Tempo:** início 2026-10-16 23:32, fim do verify 2026-10-16 23:56 (≈ 24 min)
- **STATUS:** DONE

## Arquivos
- `apps/web/src/features/flow-editor/node-editors/registry.ts` — **cópia sem alteração** do registry final da T56 (glob `./*/index.ts` + `collectNodeEditors`). Idêntico ao do worktree T56 (`diff` vazio).
- `node-editors/logic/` — `rules.ts` (ações, validação schema T10 + regras locais, números, ids estáveis, variáveis), `kit.tsx` (rascunho bloqueante, campos, `ne-status`, `ne-var-picker`, `ListNotice`, `OutputsSummary`), `api.ts` (listas reais com 403/404 → vazio + aviso), `logic-rules.ts`, `condition-editor.tsx`, `distributor-editor.tsx`, `smart-interval-editor.tsx`, `connection-flow-editor.tsx`, `index.ts`, `logic.unit.test.ts`.
- `node-editors/crm/` — `crm-rules.ts`, `tags-editor.tsx`, `simple-editors.tsx` (chat_controller, department, ai_agent), `kanban-editor.tsx`, `manipulator-editor.tsx`, `index.ts`, `crm.unit.test.ts`.
- `node-editors/external/` — `external-rules.ts`, `http-editor.tsx`, `ai-editor.tsx`, `pixel-editor.tsx`, `index.ts`, `external.unit.test.ts`.
- `apps/web/src/i18n/{pt-BR,en,es}/node-editors-logic.json` (um JSON para os três grupos).

## Contrato
- Cada grupo exporta só `export const nodeEditors: Record<string, NodeEditor>` em `<grupo>/index.ts`, com `import type` do registry (sem valores, sem `registerNodeEditor` no topo).
  - logic: `condition`, `distributor`, `connection_flow`, `smart_interval`
  - crm: `tags`, `chat_controller`, `department`, `kanban`, `manipulator`, `ai_agent`
  - external: `integration`, `ai`, `pixel`
  - **Não** registrados aqui: `approved_sale` e `payment` (T114).
- Nó novo vem da paleta com `actions: []`: o editor cria a ação principal com config padrão. Se o padrão já é válido (distribuidor 2 saídas, intervalo 1 h, chat "Atendimento", IA "platform"), grava logo; senão espera o usuário preencher.
- **Bloqueio de salvar:** cada mudança valida pelo `getActionSchema(type).safeParse` do T10 **mais** regras locais do motor (operador × tipo da condição, valor numérico, valor do Kanban só em coluna‑meta, conta do Manipulador exige número, URL http(s) ou variável). Com erro, `onChange` NÃO é chamado (o autosave do canvas não dispara), o campo mostra `ne-error-<caminho>` e `ne-status` fica `data-state="blocked"`. Sem erro, `data-state="saved"`. Linhas de headers/mapeamento do HTTP com erro (nome vazio/repetido, valor vazio, caminho inválido) também bloqueiam.
- Ids estáveis: saídas do distribuidor `o_xxxxxx` e `output_key` da IA `saida_xxxxxx`, gerados uma vez no cliente (sem `:`/espaço); a saída padrão da IA é `outros` (criada com a 1ª condição, removida com a última).
- Etiquetas: grava NOMES (`tags[]`); lista de `GET /api/labels` + campo para nome novo (no `add` o motor cria). Condição de etiqueta grava `tagName` (+`tagId` quando bate com uma etiqueta da lista).
- IA: provedores do enum mapeados de `model-options` (`gpt→openai`, `gemini→google`, `openrouter→openrouter`, `platform→openai`); `available:false` → opção desabilitada com "(sem chave)" e aviso `ne-ai-provider-unavailable` se o atual estiver sem chave. Chave BYOK por `GET /api/ai-keys` (só LLM e ativas). Não chamo `/api/ai-keys/:id/models` (chamaria o OpenRouter real). `api_key` manual (legado) nunca é exibida (input password vazio com placeholder "Chave salva (oculta)").
- 403/404 em qualquer lista → lista vazia + `ne-list-denied-<lista>`; vazia → `ne-list-empty-<lista>`. Nomes: `labels`, `departments`, `boards`, `columns`, `agents`, `team`, `flows`, `customFields`, `globals`, `aiKeys`, `models`, `pixels`.
- Nenhuma chamada a terceiros (sem "testar requisição").

## Testids
Comuns (iguais à T56): `ne-status` (`data-state` saved|blocked), `ne-error-<caminho>` (caminho do schema, ex. `ne-error-conditions.1.value`, `ne-error-weekly_schedule.monday`, `ne-error-request_url`), `ne-var-picker` / `ne-var-list` / `ne-var-<nome>`, `ne-outputs` / `ne-output-<handle>` (ex. `ne-output-success`, `ne-output-output:o_abc123`).

| Editor | Raiz | Testids |
|---|---|---|
| Condição | `ne-condition` | `ne-cond-rule-type` (all/any), `ne-cond-add`, `ne-cond-list`, `ne-cond-<i>`, `ne-cond-<i>-{category,subtype,field,operator,value,remove,tag,weekday,time,minute,date,window,attendance,attendants}`, `ne-cond-<i>-attendant-<user_id>`, opções `ne-cond-<i>-operator-<op>` |
| Distribuidor | `ne-distributor` | `ne-dist-outputs`, `ne-dist-row-<id>`, `ne-dist-output-<id>` (nome), `ne-dist-qty-<id>`, `ne-dist-share-<id>` (texto `NN%`), `ne-dist-remove-<id>`, `ne-dist-add`, `ne-dist-always-next`, `ne-dist-prevent-repetition` |
| Intervalo | `ne-interval` | `ne-interval-type` (time/date/weekly), `ne-interval-value`, `ne-interval-unit`, `ne-interval-date` (datetime-local), `ne-interval-date-past`, `ne-interval-days`, `ne-interval-day-<weekday>-{enabled,start,end}` |
| Conexão de fluxo | `ne-connection-flow` | `ne-flow-select`, opções `ne-flow-option-<id>`, `ne-flow-notice` |
| Etiquetas | `ne-tags` | `ne-tags-mode` (add_tags/remove_tags), `ne-tags-select` (opções `ne-tags-option-<label_id>`, value = nome), `ne-tags-new`, `ne-tags-new-add`, `ne-tags-chosen`, `ne-tags-chip-<nome>`, `ne-tags-chip-<nome>-new`, `ne-tags-remove-<nome>` |
| Controlador de chat | `ne-chat-controller` | `ne-chat-status` (Aguardando/Atendimento/Resolvidos) |
| Departamento | `ne-department` | `ne-dept-select`, opções `ne-dept-option-<id>` |
| Kanban | `ne-kanban` | `ne-kanban-mode` (create/remove_kanban_card), `ne-kanban-board` (opções `ne-kanban-board-option-<id>`), `ne-kanban-column` (opções `ne-kanban-column-option-<id>`; meta tem " · meta"), `ne-kanban-value` (só coluna‑meta), `ne-kanban-remove-notice` |
| Manipulador | `ne-manipulator` | `ne-manip-mode`, `ne-manip-field`, `ne-manip-operation`, `ne-manip-value-type`, `ne-manip-value` |
| Agente de IA | `ne-ai-agent` | `ne-agent-mode` (activate/deactivate), `ne-agent-select` (opções `ne-agent-option-<id>`), `ne-agent-deactivate-notice` |
| HTTP | `ne-http` | `ne-http-method`, `ne-http-url`, `ne-http-headers`, `ne-http-header-add`, `ne-http-header-<i>-{key,value,remove}`, `ne-http-body` (some no GET), `ne-http-body-warning`, `ne-http-maps`, `ne-http-map-add`, `ne-http-map-<i>-{key,value,remove}`; erros `ne-error-http-header-<i>-key` etc. |
| IA | `ne-ai` | `ne-ai-key-source` (platform/integration), `ne-ai-key` (chave BYOK; opções `ne-ai-key-option-<id>`), `ne-ai-manual-key`, `ne-ai-provider` (opções `ne-ai-provider-<p>`, `disabled` sem chave), `ne-ai-provider-unavailable`, `ne-ai-model` (opções `ne-ai-model-<modelo>`; vazio = padrão), `ne-ai-system-prompt`, `ne-ai-user-message`, `ne-ai-response-var`, `ne-ai-auto-send`, `ne-ai-context`, `ne-ai-context-n`, `ne-ai-understand-{audio,image,pdf,receipt}`, `ne-ai-validate-pix`, `ne-ai-expected-pix`, `ne-ai-validate-recipient`, `ne-ai-expected-recipients`, `ne-ai-outputs`, `ne-ai-output-add`, `ne-ai-output-<key>`, `ne-ai-output-<key>-{prompt,remove}`, `ne-ai-fallback` |
| Pixel | `ne-pixel` | `ne-pixel-select` (opções `ne-pixel-option-<id>`), `ne-pixel-event` (Compra/Lead), `ne-pixel-value`, `ne-pixel-currency` |

## Como o Tester chega a cada editor
Padrão do `tests/acceptance/T45/editor.e2e.ts`: login → `POST /api/flows {name}` → `GET /api/flows/<id>/editor-bundle` (pegar `start`) → `PUT /api/flows/<id>/definition` com o nó (pode ir com `actions: []`; o editor completa) ligado ao start → `page.goto('/flows/<id>/edit')` → clicar `.react-flow__node[data-id="<nó>"]` → ler dentro de `flow-node-editor`. Persistência: esperar `flow-save-status` = saved e reler o `editor-bundle`. Mobile (não exigido): clicar no nó e depois `flow-properties-toggle` (há duas instâncias do painel no DOM; usar a visível).

Dados reais para o AC‑03 (o seed não tem): `POST /api/labels {name,color}`, `POST /api/departments {name,color}`, `POST /api/crms {name}` (o quadro já nasce com colunas padrão: Novo/Qualificação/Ganho‑meta) + `POST /api/crms/<id>/columns {name, conversion_goal}`, agente via `POST /api/ai-agents`. Fluxos destino: `POST /api/flows`.

Conferido à mão no harness (desktop 1366 e mobile 390, sem rolagem horizontal): condição com etiqueta da lista + campo personalizado numérico (`abc` bloqueia com "Informe um número…", `18` salva; `any` salvo), Kanban com quadro/coluna‑meta + valor `{venda.valor}`, etiquetas da lista + nome novo, departamento, HTTP com header/corpo/mapeamento, IA com 2 saídas condicionais (`output:saida_*` + `output:outros` + `failure`), intervalo semanal com fim < início bloqueando. Tudo relido do `editor-bundle`.

## Verify
`node spec/verify/verify.mjs T57 --role operario --base 1a208a4` → **exit 0, APROVADO** (typecheck, lint, test afetados, i18n:check, build, 11 regras FORBIDDEN, escopo 27 arquivos). Unit: 43 testes da T57 (56 no flow-editor).

## Notas / pendências para outras tarefas
1. **Conflito com teste da T56:** `node-editors/messaging/messaging.unit.test.ts` (T56) tem `expect(getNodeEditor('condition')).toBeNull()`. Com a T57 junto, `condition` passa a ter editor e esse assert falha no gate. A T56 (ou o Tester) deve trocar por um tipo sem editor (ex. `payment`, até a T114) ou remover a linha.
2. **Registry:** o `registry.ts` da T57 é cópia exata do da T56; quem entrar segundo não tem diff real nele.
3. **Pixel/Pagamento:** editor do `pixel` é da T57 (decisão do Orquestrador, em `external/`); `payment` e `approved_sale` ficam para a T114 (`node-editors/payment/**`).
4. **IA no worker (fora dos Paths):** com `api_key_source=integration` o motor só usa a chave se `configureExternalNodes({ llmForKey, guard })` estiver ligado na produção (pendência T42/T38 → T127 item 4). Sem isso, o bloco cai nas chaves da empresa/plataforma.
5. A lista de modelos vem do catálogo de preços (`model-options`); não uso `/api/ai-keys/:id/models` porque chama o OpenRouter real.
6. `platform` (créditos da empresa) é considerado disponível quando há chave OpenAI (empresa ou plataforma), que é o preset do motor.
