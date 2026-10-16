# STATUS — execução da SPEC (fonte da verdade do andamento)

> Mantido pelo Orquestrador ("Claude Code"). Estados: `TODO`, `IN_PROGRESS`, `VERIFYING`, `REJECTED (n)`, `BLOCKED`, `ACCEPTED`, `MERGED`.
> Gerado em 2026-10-15 a partir de `spec/verify/tasks.mjs`. Ondas e dependências: SPEC §4. Comando útil: `node spec/verify/verify.mjs list`.

## Resumo
- Tarefas: 116 · Ondas: 14 (0–13) · ACs: 565 · Paralelismo: 4 pares (revisão 1)
- Em andamento: T17 (Torno/Sonda), T18 (aguarda regen de migration), T19 (Cinzel/Radar, regen), T22 (Bigorna/Lupa), T33 (Fole/Prisma).
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
| 2 | T18 | Consumo de IA: preços, ledger, carteira e porta BillingProvider | IN_PROGRESS | Torno | Sonda | 0 | |
| 3 | T13 | WA: SessionManager e proxy | MERGED | Fole | Prisma | 0 | 41738af |
| 3 | T14 | WA: fila por sessão, antiban, warm-up e limites | MERGED | Cinzel | Radar | 0 | 9edeadc |
| 3 | T15 | Autenticação, cadastro, perfil e senha | MERGED | Torno | Sonda | 0 | 224aad1 |
| 3 | T16 | Realtime: SSE, fan-out e replay | MERGED | Bigorna | Lupa | 0 | 53c0005 |
| 3 | T17 | Harness E2E (API com fakes, seed, reset) | IN_PROGRESS | Torno | Sonda | 0 | |
| 3 | T19 | Fluxos: schema e repositório | IN_PROGRESS | Cinzel | Radar | 0 | |
| 3 | T24 | UsageGuard e provider medido | TODO | | | 0 | |
| 4 | T20 | WA: SendPipeline, deliver e health | TODO | | | 0 | |
| 4 | T21 | WA: outbox de eventos, mídia e contatos | TODO | | | 0 | |
| 4 | T22 | Empresas, equipe, convites e permissões | IN_PROGRESS | Bigorna | Lupa | 0 | |
| 4 | T23 | Web: shell, design system, i18n, guards e cliente HTTP | TODO | | | 0 | |
| 4 | T25 | Motor de fluxos: runner, registro de nós e dry-run | TODO | | | 0 | |
| 4 | T26 | Contatos, etiquetas e campos personalizados | MERGED | Fole | Prisma | 0 | 02c7c96 |
| 4 | T27 | Jobs genéricos de exportação e importação | TODO | | | 0 | |
| 4 | T28 | API de fluxos, pastas, nós e arestas | TODO | | | 0 | |
| 5 | T29 | App wa-worker e RPC interno | TODO | | | 0 | |
| 5 | T30 | Motor de fluxos: timers, esperas, cancelamento e pausa | TODO | | | 0 | |
| 5 | T31 | Departamentos e horários de atendimento | TODO | | | 0 | |
| 5 | T32 | Acesso de suporte | TODO | | | 0 | |
| 5 | T33 | Chats: modelo e ingestão de eventos WhatsApp | IN_PROGRESS | Fole | Prisma | 0 | |
| 5 | T34 | Vendas, produtos, despesas e grupos de filtro | TODO | | | 0 | |
| 5 | T35 | Conteúdo: respostas rápidas, modelos, variáveis globais, figurinhas | TODO | | | 0 | |
| 5 | T36 | UI: autenticação, perfil e troca de empresa | TODO | | | 0 | |
| 5 | T37 | API de consumo de IA (empresa e plataforma) | TODO | | | 0 | |
| 5 | T38 | Chaves de provedores de IA (BYOK) | TODO | | | 0 | |
| 5 | T39 | Agentes de IA: schema e CRUD | TODO | | | 0 | |
| 5 | T40 | Conexões: API, QR, pareamento, proxy e perfil | TODO | | | 0 | |
| 5 | T41 | Nós de lógica (condição, distribuidor, conexão de fluxo, intervalo) | TODO | | | 0 | |
| 5 | T42 | Nós externos (HTTP e IA) | TODO | | | 0 | |
| 5 | T43 | API de execuções, compartilhar, importar e exportar | TODO | | | 0 | |
| 5 | T44 | UI fluxos: lista e pastas | TODO | | | 0 | |
| 5 | T45 | UI fluxos: canvas do editor | TODO | | | 0 | |
| 5 | T67 | Contatos: importação CSV e do WhatsApp | TODO | | | 0 | |
| 5 | T72 | Webhooks de entrada: CRUD e recepção pública | TODO | | | 0 | |
| 5 | T99 | Meta: cliente Graph, OAuth, perfis e contas de anúncio | TODO | | | 0 | |
| 5 | T109 | Pagamentos ao lead: porta, chaves e adapter XPag | TODO | | | 0 | |
| 6 | T46 | @crm/wa-gateway-rpc: adapter WaGateway por RPC + stream | TODO | | | 0 | |
| 6 | T47 | Conexões: projeção de status, eventos e alertas | TODO | | | 0 | |
| 6 | T48 | Chats: lista, filtros, escopo e ciclo de vida | TODO | | | 0 | |
| 6 | T49 | Chats: envio, mídia e leitura | TODO | | | 0 | |
| 6 | T50 | Kanban: quadros, colunas e cards | TODO | | | 0 | |
| 6 | T51 | Nós de mensagem (mensagem, modelo, notificação, Pix) | TODO | | | 0 | |
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
| 7 | T68 | Runtime do agente de IA | TODO | | | 0 | |
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
| 13 | T102 | Integração E2E final | TODO | | | 0 | |
