# STATUS — execução da SPEC (fonte da verdade do andamento)

> Mantido pelo Orquestrador ("Claude Code"). Estados: `TODO`, `IN_PROGRESS`, `VERIFYING`, `REJECTED (n)`, `BLOCKED`, `ACCEPTED`, `MERGED`.
> Gerado em 2026-10-15 a partir de `spec/verify/tasks.mjs`. Ondas e dependências: SPEC §4. Comando útil: `node spec/verify/verify.mjs list`.

## Resumo
- Tarefas: 116 · Ondas: 14 (0–13) · ACs: 565 · Paralelismo: 4 pares (revisão 1)
- Em andamento (3 pares): T46 (Cinzel/Radar), T51 (Bigorna/Lupa), T68 (Torno/Sonda).
- Bloqueios: nenhum
- Revisão 1 da SPEC aplicada em 2026-10-15 (novas: T109–T115; T93/T94 antecipadas para a onda 6)
- Dúvidas abertas para o usuário: nenhuma (SPEC §10.3)

## Tarefas

| Onda | Tarefa | Título | Estado | Operário | Tester | Rejeições | Notas |
|---|---|---|---|---|---|---|---|
| 0 | T00 | Scaffold do monorepo | MERGED | Bigorna | Lupa | 0 | 197d4c2 |
| 1 | T01 | @crm/db: client, migrações e tabelas-base | MERGED | Bigorna | Lupa | 0 | 779aa56 |
| 1 | T02 | @crm/shared: contratos isomórficos | MERGED | Fole | Prisma | 0 | 92ea70c |
| 1 | T03 | @crm/wa-port: WaGateway, WaEvent, fake e suíte de contrato | MERGED | Cinzel | Radar | 0 | eff38af |
| 1 | T04 | @crm/ai: portas LLM/TTS/STT e fakes | MERGED | Fole | Prisma | 0 | 911e046 |
| 1 | T05 | @crm/node-kit: logger, cripto, config, Redis/BullMQ, storage, e-mail | MERGED | Torno | Sonda | 0 | e1d9947 |
| 2 | T06 | WA: schema public.* e auth state cifrado | MERGED | Cinzel | Radar | 0 | e578080 |
| 2 | T07 | WA: transporte (interface, Fake e Baileys) | MERGED | Fole | Prisma | 1 | 3dc6d3e |
| 2 | T08 | API: esqueleto, middlewares e contexto multiempresa | MERGED | Torno | Sonda | 0 | e3575e7 |
| 2 | T09 | Worker: esqueleto, consumidor do wsm:events e jobs | MERGED | Cinzel | Radar | 0 | 8350d8d |
| 2 | T10 | Fluxos: FlowDefinition, handles, validate e configs de ação | MERGED | Bigorna | Lupa | 0 | 99960bf |
| 2 | T11 | Templating: interpolação de variáveis | MERGED | Fole | Prisma | 0 | 08ed152 |
| 2 | T12 | Adapters de IA: AI SDK 7, ElevenLabs, Groq e áudio | MERGED | Cinzel | Radar | 0 | 29da6b8 |
| 2 | T18 | Consumo de IA: preços, ledger, carteira e porta BillingProvider | MERGED | Torno | Sonda | 0 | ef61f0b |
| 3 | T13 | WA: SessionManager e proxy | MERGED | Fole | Prisma | 0 | 41738af |
| 3 | T14 | WA: fila por sessão, antiban, warm-up e limites | MERGED | Cinzel | Radar | 0 | 9edeadc |
| 3 | T15 | Autenticação, cadastro, perfil e senha | MERGED | Torno | Sonda | 0 | 224aad1 |
| 3 | T16 | Realtime: SSE, fan-out e replay | MERGED | Bigorna | Lupa | 0 | 53c0005 |
| 3 | T17 | Harness E2E (API com fakes, seed, reset) | MERGED | Torno | Sonda | 0 | 06e42c8 |
| 3 | T19 | Fluxos: schema e repositório | MERGED | Cinzel | Radar | 0 | 744ecca |
| 3 | T24 | UsageGuard e provider medido | MERGED | Torno | Sonda | 0 | 7c3ecd8 |
| 4 | T20 | WA: SendPipeline, deliver e health | MERGED | Cinzel | Radar | 0 | b77551d |
| 4 | T21 | WA: outbox de eventos, mídia e contatos | MERGED | Cinzel | Radar | 0 | 0106f10 |
| 4 | T22 | Empresas, equipe, convites e permissões | MERGED | Bigorna | Lupa | 0 | 23a441a |
| 4 | T23 | Web: shell, design system, i18n, guards e cliente HTTP | MERGED | Fole | Prisma | 0 | 0e50449 |
| 4 | T25 | Motor de fluxos: runner, registro de nós e dry-run | MERGED | Bigorna | Lupa | 0 | 0119e46 |
| 4 | T26 | Contatos, etiquetas e campos personalizados | MERGED | Fole | Prisma | 0 | 02c7c96 |
| 4 | T27 | Jobs genéricos de exportação e importação | TODO | | | 0 | |
| 4 | T28 | API de fluxos, pastas, nós e arestas | MERGED | Bigorna | Lupa | 0 | 98d18dc |
| 5 | T29 | App wa-worker e RPC interno | MERGED | Cinzel | Radar | 0 | 57c6669 |
| 5 | T30 | Motor de fluxos: timers, esperas, cancelamento e pausa | MERGED | Bigorna | Lupa | 0 | edee67b |
| 5 | T31 | Departamentos e horários de atendimento | MERGED | Torno | Sonda | 0 | 9cd0f6a |
| 5 | T32 | Acesso de suporte | TODO | | | 0 | |
| 5 | T33 | Chats: modelo e ingestão de eventos WhatsApp | MERGED | Fole | Prisma | 0 | c4f303c |
| 5 | T34 | Vendas, produtos, despesas e grupos de filtro | MERGED | Torno | Sonda | 0 | 4a243c8 |
| 5 | T35 | Conteúdo: respostas rápidas, modelos, variáveis globais, figurinhas | MERGED | Bigorna | Lupa | 0 | f48c9b5 |
| 5 | T36 | UI: autenticação, perfil e troca de empresa | TODO | | | 0 | |
| 5 | T37 | API de consumo de IA (empresa e plataforma) | TODO | | | 0 | |
| 5 | T38 | Chaves de provedores de IA (BYOK) | TODO | | | 0 | |
| 5 | T39 | Agentes de IA: schema e CRUD | MERGED | Torno | Sonda | 0 | 9b9a320 |
| 5 | T40 | Conexões: API, QR, pareamento, proxy e perfil | MERGED | Cinzel | Radar | 0 | e3baa0e |
| 5 | T41 | Nós de lógica (condição, distribuidor, conexão de fluxo, intervalo) | TODO | | | 0 | |
| 5 | T42 | Nós externos (HTTP e IA) | TODO | | | 0 | |
| 5 | T43 | API de execuções, compartilhar, importar e exportar | MERGED | Bigorna | Lupa | 0 | b59f8d4 |
| 5 | T44 | UI fluxos: lista e pastas | TODO | | | 0 | |
| 5 | T45 | UI fluxos: canvas do editor | TODO | | | 0 | |
| 5 | T67 | Contatos: importação CSV e do WhatsApp | TODO | | | 0 | |
| 5 | T72 | Webhooks de entrada: CRUD e recepção pública | TODO | | | 0 | |
| 5 | T99 | Meta: cliente Graph, OAuth, perfis e contas de anúncio | TODO | | | 0 | |
| 5 | T109 | Pagamentos ao lead: porta, chaves e adapter XPag | TODO | | | 0 | |
| 6 | T46 | @crm/wa-gateway-rpc: adapter WaGateway por RPC + stream | IN_PROGRESS | Cinzel | Radar | 0 | |
| 6 | T47 | Conexões: projeção de status, eventos e alertas | TODO | | | 0 | |
| 6 | T48 | Chats: lista, filtros, escopo e ciclo de vida | MERGED | Torno | Sonda | 0 | 27d8e7f |
| 6 | T49 | Chats: envio, mídia e leitura | MERGED | Fole | Prisma | 0 | 3cd9d36 |
| 6 | T50 | Kanban: quadros, colunas e cards | MERGED | Bigorna | Lupa | 0 | 151c34c |
| 6 | T51 | Nós de mensagem (mensagem, modelo, notificação, Pix) | IN_PROGRESS | Bigorna | Lupa | 0 | |
| 6 | T52 | Agentes de IA: base de conhecimento | TODO | | | 0 | |
| 6 | T53 | UI: empresa, departamentos e horários | TODO | | | 0 | |
| 6 | T54 | UI: equipe, permissões, convites e suporte | TODO | | | 0 | |
| 6 | T55 | Dashboard: métricas de vendas, bootstrap e marcos | TODO | | | 0 | |
| 6 | T56 | UI editores de nó: mensagem e interativos | TODO | | | 0 | |
| 6 | T57 | UI editores de nó: lógica, CRM e externos | TODO | | | 0 | |
| 6 | T58 | UI: respostas rápidas, modelos, variáveis, campos e etiquetas | TODO | | | 0 | |
| 6 | T59 | UI: consumo de IA, chaves e hub de integrações | TODO | | | 0 | |
| 6 | T60 | Disparos em massa: API e cota | TODO | | | 0 | |
| 6 | T61 | Gatilhos, fluxos padrão por conexão e ação fora do horário | TODO | | | 0 | |
| 6 | T73 | Fontes de venda (webhook genérico) e atribuição UTM/CTWA | TODO | | | 0 | |
| 6 | T80 | Vozes (ElevenLabs) | TODO | | | 0 | |
| 6 | T84 | UI: central de notificações | TODO | | | 0 | |
| 6 | T93 | Assistente (copiloto) de fluxo | TODO | | | 0 | |
| 6 | T94 | Servidor MCP (token estático) | TODO | | | 0 | |
| 6 | T101 | Meta: estrutura, insights e bundle assíncrono | TODO | | | 0 | |
| 6 | T104 | Meta: Pixel, Conversions API e nó de fluxo pixel | TODO | | | 0 | |
| 6 | T110 | Pagamentos ao lead: adapter Zenith (chave, OAuth e webhook) | TODO | | | 0 | |
| 6 | T111 | Bloco Pagamento no fluxo e confirmação por webhook | TODO | | | 0 | |
| 6 | T112 | Emissão de NF (Notasy) na venda aprovada | TODO | | | 0 | |
| 6 | T113 | UTMify: integração e envio de vendas aprovadas | TODO | | | 0 | |
| 7 | T62 | Nós interativos (menu, carrossel, espera de resposta) | TODO | | | 0 | |
| 7 | T63 | Nós de CRM (etiquetas, chat, departamento, kanban, manipulador, venda, agente) | TODO | | | 0 | |
| 7 | T64 | Agendamento de mensagens | TODO | | | 0 | |
| 7 | T65 | Dashboard: métricas de atendimento | TODO | | | 0 | |
| 7 | T66 | Contatos: filtros avançados e ações em massa | TODO | | | 0 | |
| 7 | T68 | Runtime do agente de IA | IN_PROGRESS | Torno | Sonda | 0 | |
| 7 | T69 | UI chats: lista e filtros | TODO | | | 0 | |
| 7 | T70 | UI kanban: lista e quadro | TODO | | | 0 | |
| 7 | T71 | UI conexões | TODO | | | 0 | |
| 7 | T74 | Disparos em massa: preparação e agendador | TODO | | | 0 | |
| 7 | T78 | UI dashboard: filtros e vendas | TODO | | | 0 | |
| 7 | T81 | Webhooks de entrada: processador e escuta de amostras | TODO | | | 0 | |
| 7 | T90 | UI fontes de venda e produtos | TODO | | | 0 | |
| 7 | T103 | Meta: edição de status, nome e orçamento | TODO | | | 0 | |
| 7 | T105 | Meta: vendas internas × anúncios (CTWA) e ROAS | TODO | | | 0 | |
| 7 | T107 | Indicador de conexões desconectadas no menu | TODO | | | 0 | |
| 7 | T114 | UI: pagamentos, NF, UTMify e editores dos blocos Pagamento e Venda aprovada | TODO | | | 0 | |
| 7 | T115 | MCP: OAuth para conectores (Claude) | TODO | | | 0 | |
| 8 | T75 | UI chats: conversa | TODO | | | 0 | |
| 8 | T76 | UI kanban: modais, filtros, estatísticas e exportação | TODO | | | 0 | |
| 8 | T77 | UI contatos: lista e seleção em massa | TODO | | | 0 | |
| 8 | T79 | Agentes: teste ao vivo, geração de prompt e criação assistida | TODO | | | 0 | |
| 8 | T82 | Simulador de fluxos | TODO | | | 0 | |
| 8 | T83 | UI disparos em massa | TODO | | | 0 | |
| 8 | T87 | UI dashboard: histórico, atendimento e marcos | TODO | | | 0 | |
| 8 | T89 | UI webhooks de entrada | TODO | | | 0 | |
| 8 | T106 | UI Facebook: gerenciador, pixel e perfis | TODO | | | 0 | |
| 9 | T85 | UI chats: compositor | TODO | | | 0 | |
| 9 | T86 | UI contatos: formulário, importação e jobs | TODO | | | 0 | |
| 9 | T88 | UI agentes: lista e editor | TODO | | | 0 | |
| 9 | T91 | UI chats: painel lateral e agendamentos | TODO | | | 0 | |
| 10 | T92 | UI agentes: teste ao vivo, criação assistida e vozes | TODO | | | 0 | |
| 11 | T95 | Admin: usuários, empresas, limites e cotas | TODO | | | 0 | |
| 11 | T96 | Admin: avisos, banners, saúde, sessões WhatsApp e IA | TODO | | | 0 | |
| 11 | T97 | Afiliação: captura de indicação e link externo | TODO | | | 0 | |
| 11 | T98 | Extensão: perfil ai-manager do gateway e documentação | TODO | | | 0 | |
| 11 | T108 | Tutoriais e widget de suporte plugável | TODO | | | 0 | |
| 12 | T100 | UI admin interno | TODO | | | 0 | |
| 4 | T117 | Ajustes de integração: logout encerra SSE, shutdown do hub, cache de chaves único | MERGED | Torno | Sonda | 0 | e6c4bf9 |
| 5 | T118 | Harness de testes: E2E sem travar, porta por worktree, timeouts para máquina compartilhada | MERGED | Fole | Prisma | 0 | 95ea5ae |
| 5 | T119 | Escopo de chat nas rotas de mensagens e mídia (segurança) | MERGED | Torno | Sonda | 0 | 1df6c84 |
| 13 | T102 | Integração E2E final | TODO | | | 0 | |

## Pendências para tarefas futuras (incluir no despacho da tarefa indicada)

| Tarefa | Pendência | Origem |
|---|---|---|
| T21 | `incomingMessageSchema` (wa-port) ganha `historical: z.literal(true).optional()` (aditivo), senão o AC-T33-03 só vale via `history.batch`; `SendRequest` ganha `clientMessageId?` (aditivo) para idempotência ponta a ponta do envio dos chats | T33, T49 |
| T40 | criar `crm.connections` com `session_id` e `company_id` (o resolver padrão da T33 consulta essas colunas); registrar a fonte com `registerCompanySessionsSource` (T22); FK `chats.connection_id` | T22, T33 |
| T31 / T39 | FKs `chats.department_id` (T31) e `chats.ai_agent_id` (T39) | T33 |
| T46 / T29 | injetar `waGateway` e resolver no worker via `configureChatsConsumer` | T33 |
| T29 | composição do wa-worker: `queue = new MessageQueue({ deliver: createDeliver({ antiban, health: monitor, limits }), antiban })`; `monitor = new HealthMonitor({ db, queueControl: queue, manager })`; no SessionManager `onConnected/onDisconnected/resumeState` = hooks do monitor + `bindTransportSession` no connect | T20 |
| endurecimento | `requestLogger` (T08) loga `c.req.path` com token em `/api/invitations/:token*` e `/api/auth/password-resets/:token` — redigir | T22, T15 |
| endurecimento | FK composta `(company_id, contact_id)` em `flow_runs` (hoje FK só por `contact_id`) | T19 |
| endurecimento | Streams SSE de empresa desativada não caem (heartbeat confere sessão/vínculo, não `active`) | T22 |
| T30 | BullMQ 6.3.8 recusa `:` em jobId: usar `run-<id>-seq-<n>` (`flowStepJobId` da T25), não `run:<id>:seq:<n>` | T25 |
| T21 / wa-port | `SendRequest` sem `quoted` (resposta citada) e `viewOnce`; porta sem `markRead` (recibo de leitura) — hoje só gravados no CRM | T49 |
| T29 / wa-engine | mídia enviada pelo CRM chega como `MediaRef { url: 'blob:<sha256>' }`: o engine lê do BlobStore compartilhado (`STORAGE_DIR`) | T49 |
| revisar | loop_guard de 50 nós por job (T25) falha fluxos legítimos > 50 nós sem espera; janela at-least-once entre `send` e o registro do passo (fechar com idempotency key no gateway) | T25 |
| ambiente | cota mensal do context7 esgotada (2026-10-16): agentes usam STACK.md + código/tipos instalados | T25 |
| ambiente | testes instáveis sob carga (8 agentes no mesmo Postgres/Redis): o gate repete 1x antes de rejeitar | T20 |
| T29 / T46 | SendPipeline (T20) deduplica por `clientMessageId` quando presente; `markRead` real no engine (transport.markRead) e no RPC/gateway | T21 |
| engine (T14/T20) | `quoted`/`viewOnce` aceitos no RPC mas não aplicados: deliver precisa levar `SendOptions` — mudança aditiva no engine | T29 |
| transporte (T07) | `profile.setName/setStatus/setPicture` respondem 501 NOT_SUPPORTED: falta API no transporte | T29 |
| engine | reconciliação de mensagens `processing` após crash não gracioso (send-guard/reconcile do ai-manager) | T29 |
| T46 / boot do worker | produção chama `configureFlowTimer({ db })` e `configureFlowStep({ wa })` (respostas via crm.inbound e envio pelos nós) | T30 |
| T50 | filtro `crm/kanban` na lista de chats (T48) e `PATCH /api/chats/:id` de coluna/quadro ficam com a T50 | T48 |
| T46 / wa-port / T29 | método `sessions.setProxy` (ou update) na porta, no RPC e no gateway: hoje o proxy fica cifrado no CRM e a conexão só é marcada `requires_restart` | T40 |
| teste instável | `apps/api/src/routes/auth/realtime-end.db.unit.test.ts` "fecha em < 2 s" (T117) mediu 2372 ms sob carga: avaliar folga | T40 |
| SPEC (Codice) | Paths das tarefas de UI devem seguir as URLs da spec 18 (ex.: `/customers`, `/chats`, `/crms`, `/agentes`); `requiredFile` da T36 é `routes/auth/login.tsx` mas a URL é `/login` (a T23 renderiza `features/auth/login-page.tsx` em `routes/login.tsx`) | T23 |
| worker (T25/T30) | ninguém publica `flow_run.updated` (está no catálogo): o worker deve publicar mudanças de estado dos runs | T43 |
| T08/server.ts | no shutdown fechar as filas BullMQ criadas sob demanda pela API (flow-step, flow-timer) | T43 |
| endurecimento | `GET /api/media/:id` escopado só por empresa (id = HMAC do conteúdo, não adivinhável, só aparece em mensagens visíveis): avaliar vínculo mídia↔chat | T119 |
| teste instável | `packages/wa-engine/src/send/forbidden.db.unit.test.ts` (T20) falhou 1x com "expected 1 to be 0.5" (redução após 403) sob carga | T40 |
| T46 / T38 | produção do worker chama `configureAiAgent({ llm, waGateway, ... })` (T68): na T46 com o provedor da plataforma (env); a T38 troca por resolução BYOK por empresa | T68 |
