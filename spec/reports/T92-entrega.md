# T92 — UI agentes: teste ao vivo, criação assistida e vozes (entrega do Operário)

- **Branch/worktree:** `task/T92` · `leonas-crm-wt/T92` · base `bea292d`
- **Tempo:** início 2026-10-17 00:31, fim do verify 2026-10-17 00:58 (≈ 27 min)
- **STATUS:** DONE
- **Verify:** 0 (`node spec/verify/verify.mjs T92 --role operario --base bea292d`) — APROVADO: typecheck/lint/test (afetados) de api e web, i18n:check, build, regras FORBIDDEN e escopo (25 arquivos)

## Arquivos
Novos (Paths da tarefa):
- `apps/web/src/features/agent-lab/` — `api.ts` (labApi: test-messages, DELETE, estimate, runs, transcriptions; `runQuery`/`runKey`), `lab.ts` (regras puras: bolhas, erros por `details.reason`, créditos, estágios, mescla do run do SSE, avisos, `history.state` do banner, ditado), `realtime.ts` (`registerAgentLabRealtime()` → `ai_agent.run.updated`), `recorder.ts` (MediaRecorder), `dictation.tsx`, `live-test-panel.tsx`, `assisted-create.tsx`, `review-banner.tsx`, `agent-lab.unit.test.ts`.
- `apps/web/src/features/agent-voices/` — `api.ts` (create multipart, preview binário, keep, remove), `form.ts` (1–3 amostras ≤10 MB, formatos, erros por `error_code`), `voices.tsx` (`VoiceCreate`, `VoiceActions`), `agent-voices.unit.test.ts`.
- `apps/web/src/i18n/{pt-BR,en,es}/agent-lab.json` (inclui os textos da aba Vozes, chave `voices.*`; não existe `i18n('agent-voices')`).
- `apps/api/src/routes/ai-agent-lab/ai-agent-lab.unit.test.ts` (novo, prova o LLM preguiçoso).

Liberados pelo Orquestrador (só aditivo):
- `features/agents/editor-page.tsx` — +2 imports; botão `LiveTestButton` no cabeçalho (só com `flows.edit`); `<ReviewBanner />` abaixo do aviso de não salvo.
- `features/agents/list-page.tsx` — +2 imports; `AssistedCreateButton` ao lado de "Novo agente"; na aba Vozes `VoiceCreate` no topo e `VoiceActions` em cada item (testids da T88 preservados: `agents-voices-panel`, `agents-voice-<id>`, `agents-voices-empty`).
- `features/agents/tabs.tsx` — +2 imports; helper `dictated(key)` = o mesmo `text(key)` + botão de ditado; as 5 chamadas `text(...)` da `InstructionsTab` viraram `dictated(...)` (única linha alterada, não removida).
- `routes/agentes/{index,$agentId,novo}.tsx` — `registerAgentLabRealtime()` logo após `registerAgentsRealtime()` (estático, antes do shell abrir o SSE).
- `apps/api/src/routes/ai-agent-lab/index.ts` — `labLlm(deps, fallback)`: `aiLabLlm` > FakeLlm do E2E **lido a cada chamada** > LLM da empresa. Corrige o FakeLlm "congelado" depois de `/__e2e/reset` ou `/__e2e/llm/script {replace:true}`.
- `scripts/e2e/api.ts` — no `createApp` do harness: `aiAgentLabInline: true`, `aiLabComposeModel: openai:gpt-6-luna` (só se não houver preset `balanced`), `aiLabStt: FakeStt` (texto `"Texto ditado pelo teste de voz."`, ou `E2E_STT_TEXT`), `aiLabSiteHttp.lookup` que recusa todo DNS (site → aviso `site_unread`, sem rede), `aiVoicesFetch` reescrevendo toda URL para um `FakeElevenLabsVoices` local (iniciado no boot e fechado no shutdown).

## Comportamento
- **Teste ao vivo (AC-01):** painel lateral (`fixed`, direita) aberto pelo botão do cabeçalho; desabilitado em `/agentes/novo` (precisa de id). Envia `draft` = `payloadOf(rascunho)` só quando há mudança não salva. Uma bolha por `blocks[]`; abaixo da última bolha de cada resposta: habilidades disparadas, campos preenchidos, handoff e "−N créditos · T tokens". Cabeçalho: créditos acumulados da conversa e "Testes hoje: used de limit". Bloco "Campos preenchidos" = `collected` da última resposta. Erros (`not_configured`, `no_balance`, `eval_cap`, 422 do draft) viram bolha de erro. Enter envia, Shift+Enter quebra linha. "Limpar conversa" = DELETE.
- **Criação assistida (AC-02):** modal com pitch (+ditado), site, "Estimar custo" e "Criar" (estima antes; `enough:false` bloqueia). Run: cache `['agent-lab','run',id]` atualizado pelo SSE `ai_agent.run.updated` (mescla sem regredir estágio nem reabrir terminado) **e** polling de 1,2 s como rede de segurança (07 §7). 409 `create_in_progress` passa a acompanhar o `run_id` existente. Concluído: o modal mostra os 3 estágios feitos e os avisos por 1,5 s e abre `/agentes/<agent_id>` com `history.state.agentReview = { runId, warnings }` (sem search param). O banner lê esse estado; "Entendi" remove a chave do estado (`router.history.replace`).
- **Vozes (AC-03):** "Nova voz" → nome, idioma (`pt|en|es|hi`), 1–3 amostras anexadas (input múltiplo) ou gravadas no navegador; validação local igual à do servidor; erros por `details.error_code` (`provider_not_configured`, `audios_count`, `too_large`, `unsupported_audio`…). Cada voz: "Ouvir" (POST preview → Blob → `<audio>` com controles, tenta tocar), "Manter" (só pendente), "Excluir/Descartar" com diálogo que avisa que a voz sai dos agentes; após excluir, toast com o nº e os nomes dos agentes afetados. Tudo invalida `[...AGENTS_KEY,'voices']` (a mesma do `voicesQuery()`/seletor das Configurações).
- **Ditado (AC-04):** em cada textarea da aba Instruções (e no pitch da criação assistida): botão "Ditar" (MediaRecorder; clica de novo para parar e transcrever) e um clipe que envia um arquivo de áudio. `POST /api/ai-agents/transcriptions` (multipart `file`); o texto entra no fim do campo (espaço como separador) e deixa o agente "sujo" (Salvar habilita).

## Testids (contrato com o Tester)
| Área | Testids |
|---|---|
| Painel de teste | `agent-lab-open` (cabeçalho do editor), `agent-lab-panel`, `agent-lab-close`, `agent-lab-input`, `agent-lab-send`, `agent-lab-clear`, `agent-lab-messages`, `agent-lab-empty`, `agent-lab-typing`, `agent-lab-bubble` (`data-role` = user/agent/error), `agent-lab-error` (bolha de erro), `agent-lab-skills`, `agent-lab-skill-<action_type>` (`data-skill-id`), `agent-lab-filled`, `agent-lab-filled-<key>`, `agent-lab-fields`, `agent-lab-field-<key>`, `agent-lab-handoff`, `agent-lab-msg-credits`, `agent-lab-credits` (`data-credits`), `agent-lab-eval` (`data-used`, `data-limit`) |
| Criação assistida | `agent-lab-assisted-open` (lista `/agentes`), `agent-lab-assisted-dialog`, `agent-lab-assisted-pitch`, `agent-lab-assisted-site`, `agent-lab-dictate-pitch` (+`-file`, `-upload`, `-busy`), `agent-lab-assisted-estimate-btn`, `agent-lab-assisted-estimate` (`data-enough`), `agent-lab-assisted-insufficient`, `agent-lab-assisted-start`, `agent-lab-assisted-cancel`, `agent-lab-assisted-run` (`data-status`), `agent-lab-assisted-stages`, `agent-lab-assisted-stage-{extract,compose,persist}` (`data-state` = done/active/failed/pending), `agent-lab-assisted-warnings`, `agent-lab-assisted-warning-<código>` (`site_unread`, `empty_knowledge`), `agent-lab-assisted-error` |
| Banner | `agent-lab-review-banner`, `agent-lab-review-warning-<código>`, `agent-lab-review-dismiss` |
| Vozes | `agent-voices-new`, `agent-voices-form`, `agent-voices-name`, `agent-voices-language` (select), `agent-voices-files` (input file múltiplo), `agent-voices-attach`, `agent-voices-record`, `agent-voices-samples`, `agent-voices-sample-<i>`, `agent-voices-sample-remove-<i>`, `agent-voices-error`, `agent-voices-submit`, `agent-voices-cancel`; por voz: `agent-voices-preview-<id>`, `agent-voices-audio-<id>`, `agent-voices-keep-<id>`, `agent-voices-delete-<id>`; diálogo: `agent-voices-delete-dialog`, `agent-voices-delete-warning`, `agent-voices-delete-confirm`, `agent-voices-delete-cancel`. Toasts: `agent-voices-created`, `agent-voices-kept`, `agent-voices-deleted`, `agent-voices-removed-from-agents` (aviso de agentes afetados), `agent-voices-error`. Linhas da lista (T88): `agents-voice-<id>` com `data-status` pending/kept |
| Ditado | `agent-lab-dictate-{purpose,audience,example-messages,business-rules,never-talk-about}` (gravar/parar; só aparece se o navegador tem MediaRecorder), `…-upload` (clipe), `…-file` (input file: o caminho mais simples no E2E), `…-busy` |

## Receita de E2E (conferida num smoke Playwright local contra o harness, desktop 1366×768)
1. `POST /__e2e/reset`; login `platform@demo.test` → `POST /api/platform/companies/<demo>/ai/topups { credits: 1000, note }`; login owner.
2. `POST /api/ai-keys { provider:'openai', name:'Chave OpenAI', secret }` (nome ≥ 2 chars) e, para vozes, `{ provider:'elevenlabs', … }`.
3. Agente: `{ name, generated_prompt, model:{provider:'openai',model:'gpt-6-luna'}, collection_fields:[{key:'nome',label:'Nome',enabled:true}], skills:[{… action_type:'transfer_human', silence_amount: 1 …}] }`.
4. AC-01: `POST /__e2e/llm/script { replace:true, steps:[{kind:'tool-calls',calls:[{name:'fill_field',input:{key:'nome',value:'Ana'}},{name:'transfer_human',input:{}}],usage:{inputTokens:100,outputTokens:20}},{kind:'text',text:'Oi, Ana!',usage:{…}}] }` → resultado: bolha do agente, `agent-lab-skill-transfer_human`, `agent-lab-field-nome`, créditos 1 e "Testes hoje: 1 de 200".
5. AC-02: script `{kind:'output', value:{name,role,purpose,audience,personality:'casual',primary_goal:'sell',example_messages,business_rules,never_talk_about}}`; pitch ≥ 10 chars + site qualquer (`site_unread` garantido, sem rede) → estágios todos `done`, avisos visíveis por 1,5 s, URL `/agentes/<novo id>` com o banner.
6. AC-03: `agent-voices-files.setInputFiles([...mp3, ...wav])` → submit → linha `pending` → preview → `<audio>` → keep → `kept` → delete → aviso → some.
7. AC-04: `agent-lab-dictate-purpose-file.setInputFiles({ name:'a.webm', mimeType:'audio/webm', buffer })` → `agent-purpose` contém "Texto ditado pelo teste de voz.". O botão de microfone também funciona com `--use-fake-device-for-media-stream` + permissão `microphone`.

## Testes
- `agent-lab.unit.test.ts` (12) e `agent-voices.unit.test.ts` (8): regras puras, mapeamento de erros, mescla/aplicação do SSE no cache, corpo das chamadas (draft, multipart `file`/`audios`, preview binário e erro JSON).
- `ai-agent-lab.unit.test.ts` (2): depois de trocar `deps.e2e.llm`, o lab usa a nova instância; `aiLabLlm` tem prioridade; sem E2E usa o da empresa.
- Rodados também (lição do harness): `apps/api/src/e2e/*.db.unit.test.ts`, `scripts/e2e/*.unit.test.mjs` e `ai-agent-lab.db.unit.test.ts` — 9 arquivos / 37 testes ok. `scripts/e2e/api.ts` não está em nenhum tsconfig: conferi com um `tsc -p` temporário (sem erros) e subindo o harness.

## Notas
- **Liberações usadas:** as da seção "Decisões do Orquestrador" (pontos de montagem T88, lab preguiçoso, harness). Nenhum outro arquivo fora dos Paths.
- **FakeLlm do laboratório:** `labLlm()` lê `deps.e2e.llm` a cada `generate` (o roteiro do `/__e2e/llm/script` vale depois do reset). `countTokens` não é repassado (o lab não usa).
- **SSE ou polling dos runs:** os dois. SSE registrado estático nas 3 rotas de `/agentes`; polling 1,2 s enquanto o run não termina.
- **Harness:** criação assistida inline; montagem com `aiLabComposeModel` openai:gpt-6-luna quando não há preset `balanced` (sem isso o run falhava `not_configured` no harness); STT = FakeStt; vozes = FakeElevenLabsVoices local via `aiVoicesFetch` (qualquer `xi-api-key`); site sem DNS. Nenhuma chamada à rede.
- **Pendências para outras tarefas:**
  - Montagem de produção (T79, segue aberta): `configureAiAgentLab({ db, redis, llm, guard, publisher })` no boot do worker; hoje o job monta o serviço pelo env.
  - A pendência "aiVoicesFetch no harness" (T59/T80/T92) está resolvida para vozes; a listagem de vozes da chave (`aiKeysFetch`) continua devolvendo lista vazia.
  - Criação assistida pela fonte "Conhecimento interno" (fluxo/etiqueta, 07 §5 item 4) e "Modelos prontos" não têm backend; ficaram fora.
  - Histórico (auditoria) do editor e seletor de voz por agente não fazem parte desta tarefa.
- **Desvios:** o painel de teste é um drawer aberto por botão (não uma coluna fixa), para manter a montagem aditiva no `editor-page`. A navegação após concluir espera 1,5 s para os estágios e avisos ficarem visíveis.
