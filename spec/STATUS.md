# STATUS — execução da SPEC (fonte da verdade do andamento)

> Mantido pelo Orquestrador ("Claude Code"). Estados: `TODO`, `IN_PROGRESS`, `VERIFYING`, `REJECTED (n)`, `BLOCKED`, `ACCEPTED`, `MERGED`.
> Gerado em 2026-10-15 a partir de `spec/verify/tasks.mjs`. Ondas e dependências: SPEC §4. Comando útil: `node spec/verify/verify.mjs list`.

## Resumo
- Tarefas: 127 · Ondas: 14 (0–13) · ACs: 565 · Paralelismo: 4 pares (revisão 1)
- Em andamento (força total; gate em LOTE): operário T114 (Lastro); tester T106 (Sentinela); aprovada esperando lote: T107; fila de tester: T92 → T108 → T115 → T93 → T129. Zenith fora de escopo (T110 CANCELLED). Por último: T102.
- Bloqueios: nenhum (T110 cancelada: Zenith fora de escopo)
- Revisão 1 da SPEC aplicada em 2026-10-15 (novas: T109–T115; T93/T94 antecipadas para a onda 6)
- Dúvidas abertas para o usuário: nenhuma (T110/Zenith: fora de escopo, SPEC 10.1 nº 13).

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
| 4 | T27 | Jobs genéricos de exportação e importação | MERGED | Bigorna | Lupa | 0 | b597667 |
| 4 | T28 | API de fluxos, pastas, nós e arestas | MERGED | Bigorna | Lupa | 0 | 98d18dc |
| 5 | T29 | App wa-worker e RPC interno | MERGED | Cinzel | Radar | 0 | 57c6669 |
| 5 | T30 | Motor de fluxos: timers, esperas, cancelamento e pausa | MERGED | Bigorna | Lupa | 0 | edee67b |
| 5 | T31 | Departamentos e horários de atendimento | MERGED | Torno | Sonda | 0 | 9cd0f6a |
| 5 | T32 | Acesso de suporte | MERGED | Prisma2 | Sentinela | 0 | daefc03 (op ~20 min + ajuste 403/404; tester ~6 min) |
| 5 | T33 | Chats: modelo e ingestão de eventos WhatsApp | MERGED | Fole | Prisma | 0 | c4f303c |
| 5 | T34 | Vendas, produtos, despesas e grupos de filtro | MERGED | Torno | Sonda | 0 | 4a243c8 |
| 5 | T35 | Conteúdo: respostas rápidas, modelos, variáveis globais, figurinhas | MERGED | Bigorna | Lupa | 0 | f48c9b5 |
| 5 | T36 | UI: autenticação, perfil e troca de empresa | MERGED | Torno | Sonda | 0 | c4e120e |
| 5 | T37 | API de consumo de IA (empresa e plataforma) | MERGED | Cinzel | Radar | 0 | a7bbd86 |
| 5 | T38 | Chaves de provedores de IA (BYOK) | MERGED | Torno | Sonda | 0 | 69bc234 |
| 5 | T39 | Agentes de IA: schema e CRUD | MERGED | Torno | Sonda | 0 | 9b9a320 |
| 5 | T40 | Conexões: API, QR, pareamento, proxy e perfil | MERGED | Cinzel | Radar | 0 | e3baa0e |
| 5 | T41 | Nós de lógica (condição, distribuidor, conexão de fluxo, intervalo) | MERGED | Bigorna | Lupa | 0 | 347b8ff |
| 5 | T42 | Nós externos (HTTP e IA) | MERGED | Bigorna | Sonda | 0 | 5e15536 |
| 5 | T43 | API de execuções, compartilhar, importar e exportar | MERGED | Bigorna | Lupa | 0 | b59f8d4 |
| 5 | T44 | UI fluxos: lista e pastas | MERGED | Prumo | Vigia | 0 | 884d7d2 (op ~21 min, tester ~5 min) |
| 5 | T45 | UI fluxos: canvas do editor | MERGED | Torno | Sonda | 0 | 9dab063 |
| 5 | T67 | Contatos: importação CSV e do WhatsApp | MERGED | Bigorna | Lupa | 0 | 358c67f |
| 5 | T72 | Webhooks de entrada: CRUD e recepção pública | MERGED | Bigorna | Lupa | 0 | c7c9abb |
| 5 | T99 | Meta: cliente Graph, OAuth, perfis e contas de anúncio | MERGED | Cinzel | Radar | 0 | 0bea180 |
| 5 | T109 | Pagamentos ao lead: porta, chaves e adapter XPag | MERGED | Bigorna | Lupa | 0 | 9556291 |
| 6 | T46 | @crm/wa-gateway-rpc: adapter WaGateway por RPC + stream | MERGED | Cinzel | Radar | 0 | be05ef4 |
| 6 | T47 | Conexões: projeção de status, eventos e alertas | MERGED | Bigorna | Lupa | 0 | 39fb4fd |
| 6 | T48 | Chats: lista, filtros, escopo e ciclo de vida | MERGED | Torno | Sonda | 0 | 27d8e7f |
| 6 | T49 | Chats: envio, mídia e leitura | MERGED | Fole | Prisma | 0 | 3cd9d36 |
| 6 | T50 | Kanban: quadros, colunas e cards | MERGED | Bigorna | Lupa | 0 | 151c34c |
| 6 | T51 | Nós de mensagem (mensagem, modelo, notificação, Pix) | MERGED | Bigorna | Lupa | 0 | 8c9bcc3 |
| 6 | T52 | Agentes de IA: base de conhecimento | MERGED | Cinzel | Radar | 0 | 6a89eb9 |
| 6 | T53 | UI: empresa, departamentos e horários | MERGED | Prumo | Sentinela | 0 | aaaed12 (piloto: operário ~15 min, tester ~8 min; 1 ajuste de teste por corrida sob carga) |
| 6 | T54 | UI: equipe, permissões, convites e suporte | MERGED | Esquadro | Vigia | 0 | 8fc5f28 (op ~24 min, tester ~8 min) |
| 6 | T55 | Dashboard: métricas de vendas, bootstrap e marcos | MERGED | Bigorna | Lupa | 0 | f3a73bb |
| 6 | T56 | UI editores de nó: mensagem e interativos | MERGED | Prumo | Vigia | 0 | 5083c1e (op ~20 min, tester ~9 min) |
| 6 | T57 | UI editores de nó: lógica, CRM e externos | MERGED | Lastro | Sentinela | 0 | 84cda3a (op ~24 min, tester ~13 min) |
| 6 | T58 | UI: respostas rápidas, modelos, variáveis, campos e etiquetas | MERGED | Esquadro | Vigia | 0 | b8cc9f8 (piloto: op ~25 min, tester ~6 min; 1 ajuste de teste pelo select mobile da T53) |
| 6 | T59 | UI: consumo de IA, chaves e hub de integrações | MERGED | Prumo | Sentinela | 0 | 9a72b21 (op ~22 min + probe fake; tester ~4 min) |
| 6 | T60 | Disparos em massa: API e cota | MERGED | Bigorna | Lupa | 0 | d56ed8e |
| 6 | T61 | Gatilhos, fluxos padrão por conexão e ação fora do horário | MERGED | Cinzel | Radar | 0 | 858cc08 |
| 6 | T73 | Fontes de venda (webhook genérico) e atribuição UTM/CTWA | MERGED | Cinzel | Radar | 0 | 85fc26e |
| 6 | T80 | Vozes (ElevenLabs) | MERGED | Cinzel | Radar | 0 | 25d436d |
| 6 | T84 | UI: central de notificações | MERGED | Esquadro | Sentinela | 0 | 65f5a20 (1º gate em LOTE com a T90; op 13 min, tester ~4 min) |
| 6 | T93 | Assistente (copiloto) de fluxo | VERIFYING | Lastro | (vaga) | 0 | op ~38 min (verify 0, base bea292d); tester na fila |
| 6 | T94 | Servidor MCP (token estático) | MERGED | Cinzel | Radar | 0 | 5fc1505 |
| 6 | T101 | Meta: estrutura, insights e bundle assíncrono | MERGED | Cinzel | Radar | 0 | b661cb0 |
| 6 | T104 | Meta: Pixel, Conversions API e nó de fluxo pixel | MERGED | Cinzel | Radar | 0 | 34f8dd4 |
| 6 | T110 | Pagamentos ao lead: adapter Zenith (chave, OAuth e webhook) | CANCELLED | | | 0 | fora de escopo por decisão do usuário (2026-10-17, SPEC 10.1 nº 13): só XPag |
| 6 | T111 | Bloco Pagamento no fluxo e confirmação por webhook | MERGED | Cinzel | Radar | 0 | 40de8cf |
| 6 | T112 | Emissão de NF (Notasy) na venda aprovada | MERGED | Lastro | Vigia | 0 | 08cc19c (op ~34 min, tester ~6 min; migration regenerada como 0031) |
| 6 | T113 | UTMify: integração e envio de vendas aprovadas | MERGED | Lastro | Sentinela | 0 | d4011a9 (op ~29 min, tester ~5 min) |
| 7 | T62 | Nós interativos (menu, carrossel, espera de resposta) | MERGED | Bigorna | Lupa | 0 | c0ba53e |
| 7 | T63 | Nós de CRM (etiquetas, chat, departamento, kanban, manipulador, venda, agente) | MERGED | Bigorna | Lupa | 0 | 3f0cb0c |
| 7 | T64 | Agendamento de mensagens | MERGED | Torno | Sonda | 0 | 28473c1 |
| 7 | T65 | Dashboard: métricas de atendimento | MERGED | Cinzel | Radar | 0 | ecdf3c6 |
| 7 | T66 | Contatos: filtros avançados e ações em massa | MERGED | Bigorna | Lupa | 0 | 5352144 |
| 7 | T68 | Runtime do agente de IA | MERGED | Torno | Sonda | 0 | 2c0684c |
| 7 | T69 | UI chats: lista e filtros | MERGED | Torno | Sonda | 0 | 10fa4d0 |
| 7 | T70 | UI kanban: lista e quadro | MERGED | Torno | Sonda | 1 | 9867959 |
| 7 | T71 | UI conexões | MERGED | Esquadro | Sentinela | 0 | 391cb46 (op ~22 min + ajuste do proxy, tester ~9 min) |
| 7 | T74 | Disparos em massa: preparação e agendador | MERGED | Bigorna | Lupa | 0 | 567330b |
| 7 | T78 | UI dashboard: filtros e vendas | MERGED | Torno | Sonda | 0 | 5bf4999 |
| 7 | T81 | Webhooks de entrada: processador e escuta de amostras | MERGED | Cinzel | Radar | 0 | bb6a6b0 |
| 7 | T90 | UI fontes de venda e produtos | MERGED | Forja | Vigia | 0 | 8e88be3 (1º gate em LOTE com a T84; op ~16 min, tester ~5 min) |
| 7 | T103 | Meta: edição de status, nome e orçamento | MERGED | Cinzel | Radar | 0 | 2958a88 |
| 7 | T105 | Meta: vendas internas × anúncios (CTWA) e ROAS | MERGED | Forja | Sentinela | 0 | f879ad6 (4º lote com a T100; montagem de produção incluída) |
| 7 | T107 | Indicador de conexões desconectadas no menu | VERIFYING | Forja | Vigia | 0 | tester APROVADO (6 + 8 E2E); aguarda lote com a T106 |
| 7 | T114 | UI: pagamentos, NF, UTMify e editores dos blocos Pagamento e Venda aprovada | IN_PROGRESS | (sob demanda) | (vaga) | 0 | sem Zenith; libera node-editors/sales e harness (aditivo) |
| 7 | T115 | MCP: OAuth para conectores (Claude) | VERIFYING | Forja | (vaga) | 0 | op ~32 min (verify 0, base bea292d); tester na fila |
| 8 | T75 | UI chats: conversa | MERGED | Torno | Sonda | 0 | cdef514 |
| 8 | T76 | UI kanban: modais, filtros, estatísticas e exportação | MERGED | Torno | Sonda | 0 | 50fc2e0 |
| 8 | T77 | UI contatos: lista e seleção em massa | MERGED | Torno | Sonda | 0 | 8b8ccba |
| 8 | T79 | Agentes: teste ao vivo, geração de prompt e criação assistida | MERGED | Bigorna | Lupa | 1 | d0bd44b |
| 8 | T82 | Simulador de fluxos | MERGED | Lastro | Sentinela | 0 | e76a98e (lote com T98) |
| 8 | T83 | UI disparos em massa | MERGED | Forja | Vigia | 0 | 89c58f2 (gate individual após conflito manual no scripts/e2e/api.ts com a T90) |
| 8 | T87 | UI dashboard: histórico, atendimento e marcos | MERGED | Esquadro | Sentinela | 0 | 09cd6a8 (2º lote com a T86; op ~16 min, tester ~4 min) |
| 8 | T89 | UI webhooks de entrada | MERGED | Torno | Sonda | 0 | c3a0d8f |
| 8 | T106 | UI Facebook: gerenciador, pixel e perfis | VERIFYING | Prumo | Sentinela | 0 | op ~35 min (verify 0, base 9bd202b); tester em andamento |
| 9 | T85 | UI chats: compositor | MERGED | Torno | Sonda | 0 | 6798cec |
| 9 | T86 | UI contatos: formulário, importação e jobs | MERGED | Prumo | Vigia | 0 | bddc2b0 (2º lote com a T87; op ~16 min, tester ~7 min) |
| 9 | T88 | UI agentes: lista e editor | MERGED | Torno | Sonda | 0 | c719354 |
| 9 | T91 | UI chats: painel lateral e agendamentos | MERGED | Torno | Sonda | 1 | 7d49cfa |
| 10 | T92 | UI agentes: teste ao vivo, criação assistida e vozes | VERIFYING | Esquadro | (vaga) | 0 | op ~27 min (verify 0, base bea292d); tester na fila |
| 11 | T95 | Admin: usuários, empresas, limites e cotas | MERGED | Prisma2 | Vigia | 0 | edeb8ba (op ~25 min, tester ~4 min) |
| 11 | T96 | Admin: avisos, banners, saúde, sessões WhatsApp e IA | MERGED | Esquadro | Sentinela | 0 | 6043c6f (op ~20 min, tester ~6 min; migration regenerada como 0033) |
| 11 | T97 | Afiliação: captura de indicação e link externo | MERGED | Prumo | Sentinela | 0 | 96113e7 (lote; op ~11 min, tester ~5 min) |
| 11 | T98 | Extensão: perfil ai-manager do gateway e documentação | MERGED | Esquadro | Vigia | 0 | 2b21bdc (lote com T82) |
| 11 | T108 | Tutoriais e widget de suporte plugável | VERIFYING | Prumo | (vaga) | 0 | op ~13 min (verify 0, base dec9225); tester na fila |
| 12 | T100 | UI admin interno | MERGED | Lastro | Vigia | 0 | 29b5725 (4º lote com a T105) |
| 4 | T117 | Ajustes de integração: logout encerra SSE, shutdown do hub, cache de chaves único | MERGED | Torno | Sonda | 0 | e6c4bf9 |
| 5 | T118 | Harness de testes: E2E sem travar, porta por worktree, timeouts para máquina compartilhada | MERGED | Fole | Prisma | 0 | 95ea5ae |
| 5 | T119 | Escopo de chat nas rotas de mensagens e mídia (segurança) | MERGED | Torno | Sonda | 0 | 1df6c84 |
| 7 | T120 | Montagem de produção e registro de mensagens automáticas no chat | MERGED | Cinzel | Radar | 0 | a357920 |
| 7 | T121 | Isolamento de filas BullMQ nos testes e remetente flow | MERGED | Cinzel | Radar | 0 | bdc4846 |
| 8 | T122 | Redis do harness E2E por worktree e disparos na montagem de produção | MERGED | Bigorna | Lupa | 0 | b3c4ef7 |
| 8 | T123 | Montagem: eventos dos nós de lógica e CRM e alias customer.name | MERGED | Bigorna | Lupa | 1 | 3c26ad8 |
| 8 | T124 | Harness E2E: reset serializado e limpeza de bancos órfãos | MERGED | Bigorna | Lupa | 0 | 6f2cfff |
| 8 | T125 | Montagem de produção da Meta (insights, CAPI e vendas ao Pixel) | MERGED | Cinzel | Radar | 0 | b209e1d |
| 8 | T126 | Estabilidade dos testes sob carga (filas, Redis, teardown e relógio) | MERGED | Bigorna | Lupa | 1 | eec841e |
| 8 | T127 | Montagem de produção: webhooks, fontes de venda, pagamentos, nós externos e IA | MERGED | Cinzel | Radar | 1 | 60e0037 |
| 8 | T128 | Harness de testes: banco-modelo por hash das migrações | MERGED | Forja | Sentinela | 0 | b9a9cb7 (piloto: op ~42 min, tester ~8 min) |
| 8 | T129 | Meta: bundle assíncrono não fica preso em loading após erro de conta | VERIFYING | Prumo | (vaga) | 0 | op ~12 min (verify 0, base 170f8ae; jobId único por geração); tester na fila |
| 13 | T102 | Integração E2E final | TODO | | | 0 | |

## Pendências para tarefas futuras (incluir no despacho da tarefa indicada)

| Tarefa | Pendência | Origem |
| T89 (resolvido: aviso na UI do mapeamento) | Mapeamento com literal + caminho (ex. do doc 09: `+55` + `$.phone`): payload SEM telefone gera "+55", que não conta como ausente, e o request falha no resolve_customer em vez de `missing_required_fields`. Decidir: tratar campo de identidade só com literais (sem nenhum segmento de caminho resolvido) como ausente, ou avisar na UI do mapeamento. | T81 (Radar) |
| T126 | `apps/worker/src/boot/production-worker.db.unit.test.ts` AC-T120-03 falha na main 2/4 isolado (fake.callCount 2 em vez de 1): provável corrida do teste (o PATCH ai_agent_id na linha 274 acontece antes de o "oi" ser processado). Repassado à Bigorna. | gate T81 |
| empresas (T22) | `PUT /api/companies/:id { time_zone }` com fuso fora de COMPANY_TIME_ZONES (ex.: Asia/Tokyo) responde 200 e grava America/Sao_Paulo em silêncio (normalizeTimeZone em packages/core/src/companies/service.ts). Deve responder 422 VALIDATION, ou aceitar qualquer fuso IANA válido se a referência permitir. Incluir no despacho da próxima tarefa que tocar packages/core/src/companies ou na T102. | T78 (Torno) |
|---|---|---|
| T102 | `tests/acceptance/T23/shell.e2e.ts` (linhas 72/80/88) procura `data-testid="page-chats"`, o placeholder de /chats que a T69 substituiu: 9 testes do desktop falham na suíte inteira. Atualizar para um testid estável da inbox (ou do shell) sem perder o que o AC-T23 prova. | T45 (Torno) |
| T81 | Mascarar o token público em /api/hooks/** no apps/api/src/middleware/request-logger.ts (hoje loga c.req.path com o token): liberar esse arquivo no despacho. Varrer requests `pending` cujo enqueue falhou; dedupe por body_hash (duplicate_payload); preencher steps/error/reason/processed_at; evento realtime sample_received. | T72 (Bigorna) |
| T111 | A rota de hooks de pagamento deve repassar o query token no header x-webhook-token ao parseWebhook e NÃO logar a query string (mesmo mascaramento do request-logger). | T109 (Bigorna) |
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
| worker (T25/T30) | ninguém publica `flow_run.updated` (está no catálogo): o worker deve publicar mudanças de estado dos runs | T43 |
| T08/server.ts | no shutdown fechar as filas BullMQ criadas sob demanda pela API (flow-step, flow-timer) | T43 |
| endurecimento | `GET /api/media/:id` escopado só por empresa (id = HMAC do conteúdo, não adivinhável, só aparece em mensagens visíveis): avaliar vínculo mídia↔chat | T119 |
| teste instável | `packages/wa-engine/src/send/forbidden.db.unit.test.ts` (T20) falhou 1x com "expected 1 to be 0.5" (redução após 403) sob carga | T40 |
| T46 / T38 | produção do worker chama `configureAiAgent({ llm, waGateway, ... })` (T68): na T46 com o provedor da plataforma (env); a T38 troca por resolução BYOK por empresa | T68 |
| fluxos (T63 ou ajuste) | mensagens enviadas por nós de fluxo (T51, `ctx.wa.send` idempotente, actor `flow:<runId>`) não ficam registradas no chat: gravar `crm.messages` (sender_type flow) sem reenviar, ex. `ChatSendService.recordOutbound` | T51 |
| risco | `ai_conversation_state.history` em jsonb reordena chaves do `providerData`; hoje ok (assinaturas são strings), mas se um provedor exigir bytes exatos, guardar como texto | T68 |
| wa-port | `OutgoingContent.video` ganha `ptv?: boolean` (vídeo-nota); hoje o nó envia com cast e o adapter ignora | T51 |
| T25 (motor) | `ctx.render` não aplica variáveis globais (g_*, {{global.x}}): a T51 resolveu localmente (`applyGlobals` exportado); T62/T63 devem reutilizar ou o motor deve incorporar | T51 |
| montagem (T46) | nós de mensagem precisam de `deps.mediaUrl` (cabeçalho de mídia de modelos) e `deps.record` (registro no chat) na composição de produção | T51 |
| T29 | `wa-worker` sem alvo RPC `meta.capabilities` (o gateway usa as do perfil, todas false); `/internal/fake/sessions/:id/receive` não aceita id/mídia; falta rota fake para pausar a fila | T46 |
| montagem do worker | trocar `platformLlmFromEnv` por `createCompanyLlmProvider({ keys })` (T38, BYOK por empresa) e ligar `resolveTts/resolveStt` e o `UsageGuard` (T24) no `configureAiAgent` (T46 deixou sem medição de cota) | T46, T38 |
| montagem do worker | `configureExports({ db, redis, files })` (T27) não é chamado no boot de produção; API e worker devem apontar para o mesmo `STORAGE_DIR/exports` e importar os módulos que registram os kinds | T27 |
| verificar antes de produção | endpoints não confirmados (context7 sem cota): OpenRouter `GET /key` (probe) — conferir na doc oficial. ElevenLabs CONFERIDO pela Radar na T80 (doc oficial): a listagem é `GET /v2/voices` (não /v1); clonar `POST /v1/voices/add`; excluir `DELETE /v1/voices/{voice_id}`. Se o probe da T38 usa /v1/voices, trocar para /v2/voices | T38 |
| montagem do worker | o runtime da T68 recebe um único tts/stt: voz por empresa (BYOK) precisa de um wrapper que chame `resolveTts/resolveStt(companyId)` (T38) | T38 |
| decisão (UI) | Paths de UI seguem a URL (spec 18): `ui(m)` mapeia contacts→customers, chat→chats, agents→agentes, dashboard→welcome, mass-dispatch→mass-dispatches, settings-webhooks→settings/inbound-webhooks; auth inclui routes/login.tsx etc. Abas de Configurações entram por `features/settings/tabs.ts` (compartilhado) | T23 |
| montagem do worker | `configureFlowTriggers({ db, waGateway, logger })` (T61) não é chamado no boot de produção — sem isso o consumidor ignora o crm.inbound | T61 |
| T48 (lifecycle) | ao resolver o chat, chamar `FlowTriggers.handleAttendanceFinished({ companyId, chatId })` (T61) | T61 |
| decisão | mensagem automática fora do horário (T61) e mensagens de nós de fluxo (T51) não aparecem no histórico do chat — mesma pendência de registro no chat | T61 |
| T75 / T85 / T91 (UI do chat) | usar o contrato de slots da T69: criar `apps/web/src/features/<módulo>/chat-slot.tsx` com `export const chatSlot = { area: thread|composer|panel, Component }` (props chatId, chat, isDesktop; ver features/chat/slots.ts) — sem editar arquivos da T69 | T69 |
| wa-port / engine | cronograma de warm-up replicado no core (T60: 7 dias, 20, ×1.8) para avisos de capacidade: se o engine ficar configurável, expor o cronograma pela wa-port (risco de divergência) | T60 |
| T74 | jobs de preparação/envio do disparo devem levar `dispatchId` em `data` (o cancel da T60 remove por ele); distribuição dos destinatários com `target_id` null entre vários alvos | T60 |
| ambiente (resolvido pela T121) | filas BullMQ do CRM com prefixo fixo + Redis db 1 compartilhado: workers de testes de worktrees diferentes roubam jobs | T120 |
| ingest (T33) | `reactionMessage` recebida é ignorada; localização, contato e view_once de entrada chegam só como texto (WaEvent sem esses campos) | T75 |
| T102 / web | Sem tratamento global de `company_inactive` (403) na web; `company.updated` não chega ao SSE (handler em módulo lazy: registrar no boot do realtime); hub sem abas permitidas mostra "Nenhuma seção"; "Nova Conta", "Convidar membro", "Sair da empresa" e redirects /departments e /business-hours sem AC | T53 |
| T54 | Tela do próprio usuário de suporte (`apps/web/src/routes/support/access.tsx`, hoje placeholder) não está em nenhum Path: incluir na T54 | T32 (brief) |
| T54 | Com X-Company-Id de empresa cuja concessão expirou, até /api/support/* responde 403 support_access_expired: a web zera a empresa ativa (decisão no brief da T54) | T32 |
| T114 | Consumir GET /api/sales/:id/invoice, /api/sale-invoices, sale.updated e /usage + ?force=1 da T112; card do catálogo | T112 |
| integrações | Webhook de saída da Notasy (nota autorizada/cancelada, HMAC) documentado e não consumido; fontes de venda (T73) não gravam note_issuer_id; validar com token real o JSON inferido (docs/integrations/notasy.md) | T112 |
| harness E2E | `scripts/e2e/api.ts` ainda usa o fetch global em aiVoicesFetch (ElevenLabs, T80/T92), paymentsFetch (T109/T114) e metaFetch (T106): E2E que acione esses caminhos sai para a rede. Injetar fakes na tarefa dona (T92, T114, T106) | T59 |
| T54/T95 | POST /api/companies/:id/switch exige vínculo: suporte com 2+ concessões não escolhe a empresa ativa; /flows do suporte sem empresa ativa não tratado | T54 |
| web (sem AC) | Rota /settings/invitations (página própria), remoção em lote, "Convidar membro" na aba Empresa (T53) | T54 |
| vendas | Vendas de fontes de venda (T73) não carregam note_issuer_id nem utmify_integration_id: aprovação/reembolso vindos de fonte de venda não disparam NF/UTMify | T112/T113 |
| T114 | Consumir rotas/DTO/SSE do UTMify e ?configured=1 no seletor do bloco Venda aprovada | T113 |
| integrações | UTMify: validar com credencial real (códigos HTTP, e-mail vazio, paymentMethod=pix, src/sck) | T113 |
| harness E2E | Um 2º usuário support no seed facilitaria E2E (hoje criado por SQL no teste da T54) | T54 |
| T100 | UI do admin consome os contratos da T95 (usuários, empresas, limites, cotas, estatísticas, auditoria) e da T96 (avisos, banners, saúde, sessões, segredos, uso de IA) | T95/T96 |
| admin | inbox_limits gravado e exposto, sem consumidor; upload global de imagem de banner (hoje só URL); desativar pelo admin herda o SSE que não cai (T22) | T95/T96 |
| harness E2E | scripts/e2e/api.ts não chama configureFlowStep: runs disparados no E2E ficam running ("flow-step: WaGateway não configurado") — ligar o flow-step no worker do harness | T71 |
| web | Toaster do shell (T23) empilha muitos toasts numa rajada apesar de limit=3 (cosmético) | T84 |
| editor de fluxos | vary_text_with_ai e delete_on_label do texto; áudio IA/ptv; buffer e reação do Aguardar resposta; readchat do carrossel; "Copiar para bloco Menu" (T45) | T56 |
| editor de fluxos | Operador órfão ("equal") ao trocar variável global para numérica; testid ne-var-phone_number duplicado no ne-var-list | T57 |
| web | Afiliados: link no UserMenu e banner do dashboard para o portal (fora do AC) | T97 |
| T60 | status_counts na lista de disparos e contagem por variante A/B | T83 |
| vendas | Exportação de vendas (core/worker); editar/excluir venda no histórico | T87 |
| extensão | Alvos sem equivalente no ai-manager: markRead, profile, react, deleteForEveryone; sessions.setProxy (T40, as duas pontas); meta.capabilities (T29) | T98 |
| T101 (bug) | Bundle Meta pronto com erro de conta não vai ao cache e o GET async reenfileira com o mesmo jobId bundle-<key>, deduplicado pelo BullMQ contra o job concluído (24 h) → "loading" preso até 15 min (a UI da T106 contorna relendo sem async após ~12 s). Corrigir depois da T105 (mesmo arquivo service.ts) | T106 |
| admin (web) | Busca nova com lista na página 2 dispara 1 GET page=2 antes do page=1 (resultado final certo) | T100 |
| simulador | globais vazias (T25); payment_choice/"Simular webhook"; detecção de loop curto; delete_on_label | T82 |
| shell | Modal de desconexão (spec 08/14) | T107 |
| teste instável | packages/wa-gateway-rpc contract.db.unit.test.ts "subscribe recebe os eventos que o próprio worker publica" (prazo 10 s) falha sob carga | T98 |
| admin | URLs de imagem do admin assinadas com chave derivada de CREDENTIALS_KEY: trocar a chave invalida as já gravadas; API_PUBLIC_URL precisa ser a URL pública; GC de blobs não usados | T100 |
| teste instável | `packages/db/src/migrations.db.unit.test.ts` (timeout 30 s) estoura sob carga: `DROP DATABASE` no PG16/Windows espera checkpoint (10–16 s). Avaliar timeout 60 s ou drop em segundo plano | T128 |
| produção | OpenRouter sem preço padrão no seed (T37): o admin cadastra pela API `POST /api/platform/ai/prices` | T37 |
| implantação | envio de áudio PTT exige ffmpeg no servidor (ou `FFMPEG_PATH`); no harness E2E o conversor é passthrough (T85) | T85 |
| UI chat (polimento) | a 1366 px com lista + conversa + painel a conversa fica com ~370 px e o compositor (T85) aperta: lista recolhível (T69) ou container queries no compositor | T91 |
| T50 (desempenho) | painel do chat (T91) acha o card do chat com 1 chamada por coluna: criar rota dedicada "card do chat por quadro" | T91 |
| Meta | `meta_ads_display_currency` da empresa não existe no schema (default BRL ou query); métricas internas `purchases_leona` ficam null até a T105 | T101 |
| regra (motor de fluxos) | código executado DENTRO de um passo não pode gravar por outra conexão linhas que a transação do passo pode travar (deadlock no processo, achado na T123): usar ctx.repo.db | T123 |
| motor de fluxos (T25) | eventos realtime dos nós saem ANTES do commit do passo (cliente pode ver evento de dado ainda não gravado ou desfeito): publicar após o commit (fila de eventos do passo) | T123 |
| montagem do worker | `configureExternalNodes({ llm por empresa, llmForKey via AiKeysService.credentialsForKey, guard: UsageGuard })` (T42) no boot: sem isso o nó de IA usa o ctx.llm sem medição | T42 |
| exports/jobs (T27) | Job cujo processor lança erro ANTES do runner fica `queued` para sempre em crm.background_jobs (ex.: configureExports ausente). O worker deve marcar `failed` com a mensagem. Incluir no despacho da próxima tarefa que tocar packages/core/src/exports ou na T102. | T76 (Torno) |
| testes instáveis | `packages/core/src/ai-runtime/runtime.db.unit.test.ts` (AC-T68-01 buffer) usa sleep real de 300 ms e falha sob carga (verify paralelo); passou 3/3 isolado. Tornar o relógio injetável (fake timers) quando alguém tocar no runtime. | gate T52 |
| testes instáveis | Sob carga (CPU ~70%, ~65 processos node), relatado pela Bigorna no verify da T79: (1) 57P01 admin_shutdown num crm_test_* da suíte da API. NÃO é o orphans.mjs (DROP sem FORCE, só sem conexões); provável teardown com `DROP ... WITH (FORCE)` do createTempDatabase (packages/db/src/testing.ts:41) antes de parar jobs/pools em segundo plano no mesmo arquivo. (2) hooks AC-T72-04 e um vitest abortado (exit 134) em ai-agents; passam isolados. (3) AC-T125-02 do worker (timeout de 62 s esperando o Purchase da fila meta-capi) intermitente: filas com o mesmo CRM_QUEUE_PREFIX por execução consumidas por workers de outros arquivos. Corrigir com prefixo por arquivo de teste e teardown que fecha workers antes do drop. | verify T79 |
| montagem do worker | `configureAiKnowledge({ db, redis })` no boot (senão o job ai-knowledge falha com "dependências não configuradas") e `knowledge: new AiKnowledgeService({ db }).asKnowledgeSearch()` no configureAiAgent do worker de produção e no teste ao vivo (T79) | T52 |
| montagem do worker | `configureAiAgentLab({ db, redis, llm, guard, publisher })` no boot de produção (inclusive o fake de AI_MODE=fake); hoje o job ai-agent-lab monta o serviço sozinho pelo env | T79 || ai-runtime (T68) | O lab da T79 reproduz o turno do agente com as mesmas peças (instruções, tools, HISTORY_LIMIT, splitReply, canSpeak), porque o AiAgentRuntime não tem modo teste. Para um único código de turno, extrair o turno do runtime numa função pública e usá-la nos dois. | T79 |
| montagem do worker | `configurePaymentWebhooks({ db, control })` com o FlowControl do processo (mesmo enqueueStep/timers) e `configurePaymentNodes({ paymentIntegrations })` com cipher/env de produção | T111 |
| montagem do worker | `configureInboundWebhooks({ db, engine: FlowEngine com o enqueue do flow-step, control: FlowControl do processo, redis, publisher })` e `scheduleInboundWebhooksSweep(queue)` no boot; sem isso os requests ficam pending | T81 |
| testes (T17) | `apps/api/src/e2e/e2e.db.unit.test.ts` usa Redis db 13 fixo e o reset apaga crm:* — pode ser o db de um harness vivo (T122 usa 2..15): usar a reserva de db da T122 (e2eRedis/redis-claim) | T124 |
| montagem do worker | `configureInboundSales({ db, publisher: capiSalePublisher(publisher, …), capiEnqueue: (d, o) => (capiEnqueue ??= metaCapiEnqueuer())(d, o), …logger })` em `apps/worker/src/boot/production.ts`, junto do configureMetaCapi; sem isso os eventos das fontes de venda ficam pending | T73 |
| fontes de venda (T73) | `external_id` gravado bruto: a idempotência da T34 é por (empresa, webhook, external_id), então duas fontes de venda com o mesmo id compartilham a venda. Avaliar prefixar com a fonte | T73 |
| falha na main (resolvido em 4c7b5f3) | `apps/wa-worker/src/boot/start.db.unit.test.ts` AC-02/03/04: corrida do teste (session.connection sai depois do state WARMING); o waitFor agora espera os dois | T126 (Bigorna) |
| T83 | A lista de contatos (T77) navega para /mass-dispatches com `history.state.massDispatchDraft = { open_create, mode, ids, except_ids, filters, count }` (tipo `MassDispatchDraft` exportado em `apps/web/src/features/contacts/selection.ts`): a T83 deve abrir o modal de criação com esse rascunho | T77 |
| harness E2E | Não há rota `/__e2e` para levar uma sessão a STABLE (o `session_state` vem do FakeWaGateway); o E2E da T77 intercepta `GET /api/connections`. Avaliar rota no harness quando a T71/T107 precisarem | T77 |
| motor de fluxos (endurecimento) | Publicar efeitos dos nós (realtime e enfileiramentos como o `sale.recorded` → meta-capi) só DEPOIS do commit da transação do passo (gancho pós-commit no runner). A T126 contornou o Purchase com retry no job (opção A); esta é a correção estrutural (opção B da Bigorna, mesma causa do achado da T123) | T126 |
| API (production.ts) | `META_CAPI_JOB_OPTS` em `apps/api/src/production.ts` ainda usa backoff exponencial de 30 s: alinhar com a fila meta-capi da T126 (`{ attempts: 5, backoff: { type: 'meta-capi' } }`) para que uma venda ainda não visível também tente em 2 s | T126 |
| T115 (pendência) | Breadcrumb 'Oauth / Consent' (shell T23); sem rate limit no register; sem limpeza de pedidos expirados | T115 |
| T93 (pendência) | chat_only do resume (opcional); histórico de uso por sessão; anexos/voz; painéis do assistente e do simulador na mesma posição à direita | T93 |
| T129 (pendência) | Job do bundle que quebra com erro inesperado ainda deixa 'loading' até 15 min (o job deveria limpar o estado ao falhar) | T129 |
| harness | isOwnServerRunning confia só no pid de test-results/e2e-server.json; o Windows reaproveita pids → conferir porta/linha de comando | T107 (Vigia) |
| doc extensão | downloadMedia depende de A2+A3 mas missingChanges lista só A3 (a sonda vê só o alvo RPC) | T98 (Vigia) |
