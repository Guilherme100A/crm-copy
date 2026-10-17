# T82 — Simulador de fluxos (entrega do Operário)

- **Branch/worktree:** `task/T82` · `leonas-crm-wt/T82` · base `903ba1c`
- **Tempo:** início 2026-10-17 00:23, fim do verify 2026-10-17 00:43 (≈ 20 min)
- **STATUS:** DONE

## Arquivos
- `apps/api/src/routes/flow-simulate/simulator.ts` — registry do simulador + `simulate(definition, input)` sobre o `dryRun` da T25 (mesmo `runLoop`, mesmos handlers de mensagem/interativos/intervalo).
- `apps/api/src/routes/flow-simulate/index.ts` — `POST /api/flows/:id/simulate` (`flowSimulateRoutes`).
- `apps/api/src/routes/flow-simulate/simulator.unit.test.ts` (13 testes, sem banco) e `flow-simulate.db.unit.test.ts` (3 testes HTTP, Postgres real).
- `apps/api/src/routes/index.ts` — **aditivo**: import + `app.route('/', flowSimulateRoutes(deps)) // T82` depois de `flowRunsRoutes`.
- `apps/web/src/features/flow-simulator/` — `api.ts` (tipos + cliente), `session.ts` (estado puro da conversa), `simulator.tsx` (botão + painel), `index.ts`, `flow-simulator.unit.test.ts` (5 testes).
- `apps/web/src/i18n/{pt-BR,en,es}/flow-simulator.json`.
- `apps/web/src/features/flow-editor/canvas/editor.tsx` — **liberação aditiva do Orquestrador**: 1 import (`import { FlowSimulator } from '../../flow-simulator'`) + 1 linha no cabeçalho, logo antes de `flow-properties-toggle`:
  `<FlowSimulator flowId={flowId} beforeRun={() => saver.flush()} nodeName={(id) => nodesRef.current.find((n) => n.id === id)?.data.name} />`. A T93 (copiloto) pode entrar na linha ao lado sem conflito.

## Contrato da rota
`POST /api/flows/:id/simulate` — `requirePerm('flows.view')` (simular não grava nada; member com só `flows.view` simula). Fluxo de outra empresa/inexistente → 404 (`FlowStoreError` → `ApiError`); corpo inválido → 422 (zod); `resume.node_key` desconhecido ou `resume.handle` que o nó não oferece → 422 com `details.fields[0].path` = `resume.node_key`/`resume.handle`.

Corpo (todos opcionais): `{ resume?: { node_key, handle, text? }, vars?: {...}, steps_so_far?: int }`.

Resposta `{ simulation }`:
```
status: 'waiting' | 'finished'
steps: [{ seq, node_key, node_type, status: 'done'|'failed', handle?, error? }]   // seq acumulado
messages: [{ seq, node_key, to: 'contact'|'internal', kind: 'text'|'image'|'video'|'audio'|'sticker'|'document'|'contact'|'location'|'react'|'delete', text?/url?/caption?/file_name?/name? }]
notices: [{ seq, code: 'not_simulated', node_key, node_type } | { seq, code: 'jump_flow', node_key, target_flow_id }]
vars, steps_total
wait?: { node_key, node_type, kind, choices: [{ handle, label?, connected }] }
end?: { reason: 'completed'|'no_start'|'no_next'|'failed'|'loop_guard'|'jump_flow', node_key?, handle?, error? }
interrupted?: 'loop_guard'
```

### Protocolo de continuação (stateless)
1. Primeira chamada com `{}`: roda do `entry` do rascunho.
2. Em `waiting`, o cliente reenvia `{ resume: { node_key: wait.node_key, handle: <escolhido>, text?: <texto digitado> }, vars: simulation.vars, steps_so_far: simulation.steps_total }`.
3. O servidor **não reexecuta** o nó em espera: limpa `__await/__replies`, grava a resposta como o nó faria (`response`/`last_user_message` no Aguardar resposta; campo do `save_user_data` com o texto ou o título da opção) e roda o dry-run a partir do destino da aresta `(node_key, handle)`. Handle sem aresta → `finished` com `end.reason = 'no_next'`.
4. Limite: `maxSteps = 50 − steps_so_far`; vale para o caminho inteiro. Ao estourar → `interrupted: 'loop_guard'`, `end: { reason: 'loop_guard', node_key: <nó onde parou> }` (o `LOOP_GUARD_ERROR`/`MAX_STEPS_PER_JOB` da T25).

### Registry do simulador (nunca rede, nunca banco)
`createNodeRegistry()` + `register`, um por simulação:
- **Mesmos handlers do motor** (envios gravados na transcrição por um proxy em `ctx.wa.send`, que segue para o FakeWaGateway do dry-run): `message`, `notification` (→ `to: 'internal'`), `pix`, `interactive_menu`, `menu`, `carousel`, `wait_response` (com `sleep` no-op para o "digitando"/atraso), `smart_interval` (fuso fixo `America/Sao_Paulo`; vira espera com escolha "Pular espera" = `source`), `start`.
- **Viram escolha** (`wait` com os handles de `nodeHandles(node)`): `condition` → `condition_choice` (success/failure), `distributor` → `distributor` (`output:<id>`, rótulo = nome da saída), `integration` → `integration_choice` (success/failure; **o HTTP real nunca é chamado**), `ai` → `ai_choice` (`output:<key>` com o prompt como rótulo, fallback, failure; **nenhum LLM**). Nó sem saídas → erro `invalid_config` (segue `failure` se houver).
- **"ainda não é simulado. Seguindo."** (aviso `not_simulated`): `tags`, `kanban`, `department`, `chat_controller`, `manipulator`, `approved_sale`, `ai_agent`, `pixel`, `payment`, `unsupported`. Seguem o primeiro handle ligado na ordem `source`, `success`, `output:charge_created`, `output:payment_approved`, demais (nunca `failure`).
- `connection_flow`: aviso `jump_flow` com o fluxo de destino e fim (`end.reason = 'jump_flow'`).
- Prova de zero rede: `simulator.unit.test.ts` espiona `fetch`, `http.request` e `https.request` num fluxo com integração (URL real) e IA → nenhuma chamada. O teste HTTP confere que `flow_runs`/`flow_run_steps` da empresa ficam vazios e o `waGateway` injetado não recebe envio.

## UI (AC-T82-04)
Botão "Simular" no cabeçalho (também em modo leitura). Ao abrir, salva o rascunho pendente (`saver.flush()`) e chama a rota. Painel fixo à direita no desktop (`lg:w-96`) e gaveta de baixo (85dvh) no mobile < 1024 px, sem rolagem horizontal. Conversa em chat: balões do bot (mídia como `[Imagem] url/legenda`; notificação marcada "Notificação para outro número"), balões da resposta escolhida, avisos e linha de fim. Rodapé: tipo da espera + botões das respostas possíveis (rótulo da config ou texto fixo: "Simular timeout", "Outra resposta", "Sucesso", "Falha", "Pular espera"); saída sem aresta aparece tracejada com `data-connected="false"`. Aguardar resposta tem campo de texto (handle `source`) + botão "Simular timeout" quando houver prazo.

### Testids para o Tester
| Elemento | testid / atributos |
|---|---|
| Botão Simular | `flow-simulate` (`aria-expanded`; clicar de novo fecha) |
| Painel | `flow-simulator` (`data-state` = `running` \| `waiting` \| `finished` \| `error`) |
| Lista da conversa | `flow-simulator-messages` |
| Balão do bot | `flow-simulator-bot` (`data-node`, `data-to` = contact \| internal) |
| Balão da resposta | `flow-simulator-user` (`data-handle`) |
| Aviso | `flow-simulator-notice` (`data-code` = not_simulated \| jump_flow, `data-node`) |
| Carregando | `flow-simulator-loading` |
| Tipo da espera | `flow-simulator-wait` (`data-kind` = wait_response, menu, carousel, smart_interval, condition_choice, distributor, ai_choice, integration_choice) |
| Botões de resposta | `flow-simulator-choices` / `flow-simulator-choice-<handle>` (ex. `flow-simulator-choice-option:o1`, `-timeout`, `-other`, `-success`, `-failure`, `-output:<id>`, `-source`), `data-connected` |
| Texto livre | `flow-simulator-input` + `flow-simulator-send` |
| Loop/interrupção | `flow-simulator-interrupted` (`data-reason="loop_guard"`, `data-node`) |
| Fim | `flow-simulator-end` (`data-reason` = completed \| no_start \| no_next \| failed \| jump_flow) |
| Erro da chamada | `flow-simulator-error` |
| Reiniciar / Fechar | `flow-simulator-restart` / `flow-simulator-close` |

Mobile: o painel abre por cima do canvas (z 60) direto pelo `flow-simulate` (visível no cabeçalho em 390 px); não depende de `flow-properties-toggle`.

### Como o Tester monta o cenário
Padrão da T45: login → `POST /api/flows` → `GET /api/flows/<id>/editor-bundle` (nó start) → `PUT /api/flows/<id>/definition` → `/flows/<id>/edit` → `flow-simulate`. Cenário conferido à mão no harness (desktop 1366 e mobile 390, sem rolagem horizontal): start → mensagem → etiquetas (aviso) → menu com 2 opções (botões Vendas/Suporte/Outra resposta/Simular timeout) → opção 1 → ciclo de 2 mensagens → `flow-simulator-interrupted` "Parado por segurança… (em loop1)"; reiniciar volta a `waiting`; fechar remove o painel.

## Verify
`node spec/verify/verify.mjs T82 --role operario --base 903ba1c` → **exit 0, APROVADO** (typecheck/lint/test afetados de `@crm/api` e `@crm/web`, i18n:check, build, 11 regras FORBIDDEN, escopo 14 arquivos). Unit: 16 da API (13 sem banco + 3 HTTP/Postgres) e 5 da web.

## Notas / pendências
1. **Permissão:** `flows.view` (simular não grava; decisão sugerida no brief).
2. **Liberação de `editor.tsx`:** usada só de forma aditiva (1 import + 1 linha). Nada em `node-editors/registry.ts`.
3. **Variáveis globais** continuam vazias no simulador (pendência T25 `ctx.render` sem globais; `defaultGlobals` sem banco → `{}`); contato é nulo (variáveis de contato saem vazias; telefone fake `+5500000000000`).
4. **Pagamento:** segue `charge_created` com aviso, conforme a decisão do Orquestrador; o "Simular webhook (pagamento aprovado)"/`payment_choice` de 06 §5.6 não foi feito — se quiserem, é trocar `payment` de `NOT_SIMULATED_NODES` para `CHOICE_NODES` em `simulator.ts`.
5. **Não feito (06 §5.6):** detecção de "loop curto" separada do limite de 50 passos (o `loop_guard` cobre os dois) e simulação de `delete_on_label`. Modelos (`template`/`kieai_choice`) não existem como nó suportado.
6. Nenhum consumidor/job novo: nada a ligar no boot de produção.
7. Testes E2E do AC-T82-04 (desktop + mobile) e títulos `AC-T82-nn` em `tests/**` ficam com o Tester.
