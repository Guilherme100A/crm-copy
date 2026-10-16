# SPEC — CRM WhatsApp multiempresa (execução orquestrada)

> Clone funcional do CRM descrito em `spec/features/*.md`, com backend no padrão do ai-manager (`spec/AI-MANAGER-MAP.md`) e stack fixada em `spec/STACK.md`.
> Esta spec converte as features em **tarefas executáveis** por um **Orquestrador**, seus **Operários** (implementam) e **Testers** (validam).
> Todo critério de aceitação tem um ID `AC-Txx-nn` rastreável até um teste que passa (`spec/verify/verify.mjs`).
> Gerada em 2026-10-15. Método e rigor copiados de `spec/_ref_wsm_SPEC.md` (já validado pelo usuário).
> **Revisão 1 (2026-10-15):** respostas do usuário à antiga §10.2 incorporadas (consentimento sem gate para importados, integrações de venda iguais à referência, OpenRouter, copiloto e MCP antecipados com OAuth, i18n pt-BR/en/es, marcos com nomes próprios, KPIs fechados, limites ilimitados por padrão, 4 pares em paralelo). Regra geral do usuário: em dúvida de escopo, fazer como o produto de referência faz.

---

## 0. Como ler esta spec

| Seção | Quem usa |
|---|---|
| 1. Papéis e regras invioláveis | todos |
| 2. Protocolo de execução | Orquestrador |
| 3. Contratos globais (arquitetura, pacotes, multiempresa, auth, erros, realtime, filas, testes, UI) | Operários e Testers |
| 4. Grafo de tarefas (ondas e paralelismo) | Orquestrador |
| 5. Tarefas T00–T115 com critérios de aceitação | Operários e Testers |
| 6. Scripts de verificação | todos |
| 7. Prompts de despacho | Orquestrador |
| 8. Fora de escopo | todos |
| 9. Riscos | Orquestrador e humano |
| 10. Decisões fechadas, decisões assumidas e dúvidas | Orquestrador e humano |

- Raiz do projeto: `C:\Users\green\Downloads\leonas\leonas-crm` (repositório git próprio). A spec fica em `spec/`.
- Referência somente leitura: `C:\Users\green\Downloads\leonas\ai-manager` (padrões, código a espelhar no `wa-engine`).
- **Referências de feature** aparecem como `NN-arquivo.md#âncora` (em `spec/features/`). O Operário **lê a seção citada inteira** antes de implementar. Quando a feature e esta SPEC divergirem, **vale esta SPEC** (ela já aplica as decisões: só Baileys, sem cobrança, marca neutra).
- Marcas `[REQUER WABA]` e `[INSTÁVEL NO BAILEYS]` nas specs de feature: tratamento consolidado na seção 8 e em cada tarefa.

---

## 1. Papéis e regras

### 1.1 Orquestrador — agente "Claude Code"
- **Não escreve código de produto nem testes.** Planeja, despacha, verifica, decide e **é o único que faz commit**.
- Despacha por onda (seção 4), respeitando dependências e o limite de lotes (`verify.mjs plan --max N`).
- Para cada tarefa despacha **em paralelo** um Operário e um Tester, no mesmo worktree da tarefa (2.4).
- Roda `verify.mjs <Txx> --role operario` quando o Operário reporta `DONE`, e `--role tester` quando o Tester reporta `DONE`.
- Só marca `ACCEPTED` quando **os dois** scripts terminam com exit 0. Então commita no branch da tarefa, integra em `main` e roda a regressão da onda.
- Mantém `spec/STATUS.md` (fonte da verdade do andamento).
- Após **3 ciclos de rejeição** na mesma tarefa, escala ao humano com o relatório de `spec/reports/`.

### 1.2 Operário
- Implementa **uma tarefa por vez**, só dentro dos **Paths** da tarefa (seção 5) e dos arquivos compartilhados (2.4, só aditivo).
- **Não edita** `tests/**`. Escreve testes unitários próprios (`*.unit.test.ts`, `*.db.unit.test.ts`) junto do código.
- Antes de reportar `DONE`: `node spec/verify/verify.mjs <Txx> --role operario` com exit 0.
- Critério ambíguo → `BLOCKED` com a pergunta. Não inventa requisito. Não commita.

### 1.3 Tester
- Escreve testes de aceitação **a partir dos critérios**, não da implementação (caixa-preta sempre que possível: HTTP, portas públicas, navegador).
- Arquivos em `tests/acceptance/Txx/`: `*.test.ts` (Vitest) e, em tarefas de UI, `*.e2e.ts` (Playwright, projeto `desktop`; os ACs de layout também no `mobile`, ver 3.10).
- **Todo teste inclui o ID `AC-Txx-nn` no título.** Um AC só está coberto com ≥ 1 teste com o ID e status `passed`; se for E2E, passa nos dois projetos.
- **Não edita** `apps/**` nem `packages/**`. Bug de produto → `REJECT` com evidência.
- Nunca usa WhatsApp real nem API paga: `FakeTransport`, `FakeWaGateway`, `FakeLlm`, `FakeTts`, `FakeStt`, mailer em memória, servidor fake da Meta.
- Antes de reportar `DONE`: `node spec/verify/verify.mjs <Txx> --role tester`. Não commita.

### 1.4 Regras invioláveis (valem para todo código)
1. Credenciais do WhatsApp **nunca** em texto puro (DB, logs, arquivos, respostas da API). Auth state só cifrado no Postgres.
2. Nenhum envio fora do pipeline: todo envio do CRM passa por `WaGateway.send` → `SendPipeline` (gates + fila por sessão + antiban). `transport.sendMessage` só existe em `packages/wa-engine/src/send|transport`.
3. Nenhum envio para contato com `opt_out = true` — o opt-out **sempre** bloqueia (gate `contactAllowed`). Como no produto de referência, não há exigência de consentimento prévio para importados: todo contato criado pelo CRM recebe consentimento automaticamente com a origem (`consent_source = 'inbound' | 'manual' | 'import' | 'webhook' | 'sale'`), repassado ao `WaGateway.recordConsent`, para que o pipeline (e o gate do ai-manager no modo extensão) aceite o envio.
4. O sistema **para** a sessão diante de sinais anormais (403, rajada de erros, health crítico). Nunca aumenta atividade automaticamente para compensar.
5. Proibido: entrar em grupos automaticamente, fabricar conversas, gerar mensagens artificiais para "aquecer" ou alterar reputação.
6. Proibido prometer segurança contra ban em UI, API, logs ou docs. Health Score é só indicador operacional.
7. **Isolamento multiempresa:** toda tabela `crm.*` de dados de cliente tem `company_id`; toda query filtra pela empresa do contexto; recurso de outra empresa responde **404** (nunca 403, para não vazar existência).
8. Segredos (chaves de IA, tokens de webhook/MCP, senhas de proxy, tokens Meta) cifrados em repouso (AES-256-GCM), **nunca** devolvidos pela API (só `configured`/máscara) e redigidos nos logs.
9. **Marca neutra:** nenhum "Leona"/"Leona AI"/"Leona Pay" em código, UI, e-mails ou docs de produto. O nome exibido vem de `APP_NAME`.
10. Testes nunca acessam serviços externos reais (WhatsApp, LLMs, ElevenLabs, Groq, Meta, SMTP). Todo serviço externo fica atrás de uma porta com fake.
11. **Fronteiras de pacote:** `packages/core`, `packages/shared`, `apps/api`, `apps/worker`, `apps/web` nunca importam Baileys nem `@crm/wa-engine` — só `@crm/wa-port`. SDKs de IA (`ai`, `@ai-sdk/*`, `@anthropic-ai/sdk`, `openai`, `@google/genai`, `@elevenlabs/*`, `groq-sdk`) só nos adapters de `packages/ai`.
12. WhatsApp **só via Baileys**. Nada de Cloud API/WABA/uazapi/z-api. Feature marcada `[REQUER WABA]` só entra adaptada (seção 8.2).

---

## 2. Protocolo de execução (Orquestrador)

### 2.1 Ciclo de vida de uma tarefa
```text
TODO ──dispatch──▶ IN_PROGRESS ──operário DONE──▶ VERIFYING ──ambos verify OK──▶ ACCEPTED ──merge──▶ MERGED
                        ▲                              │
                        └────────── REJECTED ◀─────────┘   (falha em verify ou REJECT do tester)
                   BLOCKED (pergunta pendente ao orquestrador/humano)
```

### 2.2 Passo a passo por onda
1. `node spec/verify/verify.mjs plan --max 4` lista os lotes da onda, ordenados pelo caminho crítico (`h` = altura). **N = 4 pares** (4 Operários + 4 Testers) por vez — decisão do usuário.
2. Para cada tarefa do lote cujas dependências estão `MERGED`: criar o worktree (2.4), despachar Operário e Tester em paralelo (prompts da seção 7) com `maestri ask --batch`.
3. Operário reporta `DONE` → `node spec/verify/verify.mjs Txx --role operario --base <ref-de-partida>` dentro do worktree.
   - Falhou → `REJECTED`; reenviar a saída e `spec/reports/Txx-operario.json`.
4. Avisar o Tester de que a implementação está pronta. Tester reporta `DONE` → `node spec/verify/verify.mjs Txx --role tester --base <ref-de-partida>`.
   - AC falhando por bug de produto → `REJECTED` para o Operário. AC sem cobertura ou teste mal escrito → devolver ao Tester.
5. Os dois com exit 0 → `ACCEPTED`. Commitar no branch `task/Txx`, integrar em `main` (2.5), atualizar `STATUS.md`.
6. Ao fim de cada onda, em `main`: `node spec/verify/verify.mjs wave <n>` (regressão de tudo até a onda).

### 2.3 Formato de reporte (Operário e Tester → Orquestrador)
```text
<STATUS> Txx <papel>
STATUS: DONE | BLOCKED | REJECT
Arquivos alterados: <lista>
Verify: <exit code> (<comando>)
Notas: <decisões, desvios, perguntas>
```
Envio: `maestri ask "Claude Code" "<mensagem>"`.

### 2.4 Paralelismo, worktrees e arquivos compartilhados
- **Um worktree por tarefa:** `git worktree add ../leonas-crm-wt/Txx -b task/Txx main`. Operário e Tester da tarefa trabalham nele (o Tester só em `tests/acceptance/Txx/**`). `pnpm install` no worktree (store do pnpm compartilhado, sem custo de disco relevante).
- O verify roda com `--base <commit de partida>`, o que torna a **checagem de escopo bloqueante**.
- Duas tarefas da mesma onda têm **Paths disjuntos** (garantido pela seção 4). A sobreposição permitida é só nos **arquivos compartilhados** (lista exata em `SHARED_PATHS` de `spec/verify/tasks.mjs`), que só podem ser alterados de forma **aditiva**:
  - manifestos (`package.json`s, `pnpm-lock.yaml`, `pnpm-workspace.yaml`), `.env.example`, `docs/**`;
  - pontos de registro: `packages/*/src/index.ts`, `apps/*/src/index.ts`, `apps/api/src/routes/index.ts`, `apps/api/src/middleware/public-routes.ts` (rotas públicas), `apps/worker/src/registry.ts`, `apps/web/src/app/nav.ts`, `apps/web/src/features/settings/tabs.ts`, `apps/web/src/routeTree.gen.ts` (gerado);
  - catálogos: `packages/shared/src/permissions/catalog.ts`, `packages/shared/src/permissions/defaults.ts` (matriz padrão, só chaves novas), `packages/shared/src/realtime/events.ts`, `packages/shared/src/errors/codes.ts`;
  - banco: `packages/db/src/schema/crm/index.ts`, `packages/db/drizzle/crm/**`, `packages/db/src/seed/modules/**`.
- **Testes unitários de outras tarefas** (`*.unit.test.ts`, `*.db.unit.test.ts`): o Operário pode fazer ajuste **mínimo** quando a tarefa atual invalida legitimamente uma suposição deles (ex.: rota que passou a existir, contagem exata de tabelas). Deve preservar o que o teste prova e **declarar no relatório** (arquivo, motivo). Testes de aceitação (`tests/**`) nunca.
- **Migrations:** cada tarefa que cria tabela escreve o schema em `packages/db/src/schema/crm/<módulo>.ts` (Path da própria tarefa) e gera **uma migration nova** com `pnpm --filter @crm/db db:generate:crm --name <txx>_<slug>`. Nunca edita migration existente. Se o journal conflitar na integração, o Orquestrador pede ao Operário que **regenere** a migration sobre o `main` atualizado.
- `apps/web/src/routeTree.gen.ts` é gerado pelo plugin do TanStack Router: em conflito, regenerar (`pnpm --filter @crm/web routes:gen`) em vez de mesclar à mão.

### 2.5 Integração em `main`
1. No worktree: `git add -A && git commit` (só o Orquestrador), mensagem `Txx: <título>` + linha de coautoria definida pelo Orquestrador.
2. `git rebase main` (ou merge) resolvendo só arquivos compartilhados de forma aditiva; migrations conflitantes → regenerar (2.4).
3. Em `main`: `node spec/verify/verify.mjs Txx --role operario` e `--role tester` de novo (sem `--base`).
4. `git worktree remove ../leonas-crm-wt/Txx`.

---

## 3. Contratos globais

### 3.1 Estrutura do repositório
```text
leonas-crm/
├── apps/
│   ├── api/          # @crm/api — Hono: createApp(deps); routes/<módulo>/**; SSE /api/events
│   ├── worker/       # @crm/worker — jobs BullMQ do CRM + consumidor do stream wsm:events
│   ├── wa-worker/    # @crm/wa-worker — DONO dos sockets Baileys (wa-engine) + RPC interno; não roda no modo extensão
│   └── web/          # @crm/web — React 19 + Vite 8 + TanStack Router/Query + Tailwind 4 + shadcn (Base UI)
├── packages/
│   ├── shared/       # @crm/shared — contratos isomórficos (zod): erros, paginação, permissões, eventos realtime, DTOs, FlowDefinition
│   ├── db/           # @crm/db — Drizzle: schema/wa/** (public.*, igual ao ai-manager) e schema/crm/** (pgSchema 'crm')
│   ├── node-kit/     # @crm/node-kit — logger pino com redação, AES-256-GCM, config zod, Redis/BullMQ, BlobStore, mailer, hash de senha
│   ├── wa-port/      # @crm/wa-port — FRONTEIRA: WaGateway, WaEvent v1, erros, FakeWaGateway, suíte de contrato
│   ├── wa-engine/    # @crm/wa-engine — fork alinhado do @wsm/core: transport, auth-state, session, queue, antiban, warm-up, send, health, events, media
│   ├── wa-gateway-rpc/ # @crm/wa-gateway-rpc — WaGateway via RPC interno + consumo do stream (perfis: crm-wa-worker e ai-manager)
│   ├── ai/           # @crm/ai — portas LlmProvider/TtsProvider/SttProvider, adapters (AI SDK 7, ElevenLabs, Groq), áudio PTT, fakes
│   └── core/         # @crm/core — domínio do CRM: src/<módulo>/**
├── tests/acceptance/ # propriedade dos Testers: Txx/*.test.ts e Txx/*.e2e.ts; vitest.config.ts; playwright.config.ts; helpers/
├── scripts/          # e2e/serve.mjs (harness), utilitários
├── docs/             # docs técnicas (aditivo)
├── spec/             # esta spec, features, verify, status, reports
└── .env.example
```
- Gerenciador **pnpm 9** (workspaces), **Node 22 LTS** (`engines >= 22.12`), TypeScript `~6.0.3` `strict: true`, ESM. Versões exatas: `spec/STACK.md` §0.1 (vale a versão do lock do ai-manager quando existir).
- Resolução entre pacotes como no ai-manager: `exports` com condição `development` → `src/index.ts`; `default` → `dist`.
- Nomes neutros `@crm/*`. Nome do produto só via `APP_NAME`.

### 3.2 Fronteiras e dependências entre pacotes
```text
shared ◀── db ◀── core ◀── api / worker
  ▲          ▲      ▲
  │          │      ├── wa-port (só contrato)      wa-gateway-rpc ──▶ wa-port
  │          │      └── ai (portas + adapters)
node-kit ◀───┴── wa-engine ◀── wa-worker
web ──▶ shared (somente)  — fala com a API por HTTP/SSE
```
- `core` depende de `shared`, `db`, `node-kit`, `wa-port`, `ai`. **Nunca** de `wa-engine` ou Baileys (regra F-ENGINE-BOUNDARY / F-WA-BOUNDARY).
- `api` e `worker` recebem um `WaGateway` por injeção: `wa-gateway-rpc` em produção, `FakeWaGateway` em teste/E2E (`WA_GATEWAY=rpc|fake`).
- Fronteira de extensão (AI-MANAGER-MAP §13): o CRM roda **sozinho** (wa-worker próprio) ou **sobre o ai-manager** trocando só o perfil do `wa-gateway-rpc` e o banco. Nada no domínio muda.

### 3.3 Multiempresa, papéis e permissões
- **Empresa** (`crm.companies`) = "conta" das specs de feature. Usuário pertence a N empresas via `crm.company_members (company_id, user_id, role)`.
- Papéis na empresa: `owner` (exatamente 1), `admin`, `member`. Papéis de sistema (`users.system_role`): `user` (padrão), `platform_admin` (admin interno), `support` (acesso de suporte com concessão).
- **Catálogo de permissões** (`packages/shared/src/permissions/catalog.ts`, arquivo compartilhado aditivo) com as chaves de `16-configuracoes-empresa-equipe.md#81-catálogo` **sem** `billing.*`; matriz padrão por papel (16#8.2); lista explícita por membro substitui a matriz; `owner` tem tudo; dependências (edit/delete ⇒ view; `chat.block` ⇒ `chat.view`) normalizadas no servidor. Novas chaves de módulo são acrescentadas pela tarefa do módulo.
- **Enforcement no backend** com `requirePerm('<chave>')` em toda rota de domínio. A UI esconde/desabilita, mas nunca é a única barreira.
- **Escopo de chat** (`chatScope`): departamentos e conexões do membro (vazio = todos; owner/admin ignoram). Aplica-se a listas, detalhes, contadores, SSE e notificações.
- **Empresa ativa:** header `X-Company-Id` em toda requisição autenticada (validado contra a membership); sem header, vale `users.last_company_id`. SSE recebe `?company_id=`. Troca de empresa no cliente = trocar o header, invalidar todo o cache do TanStack Query e reabrir o SSE.
- Toda tabela de domínio em `crm.*` tem `company_id uuid not null` + índice começando por `company_id`. Repositórios recebem `ctx.companyId` obrigatório. Cross-tenant → 404 `NOT_FOUND`.
- **Limites de quantidade por empresa** (conexões, agentes de IA, membros, fluxos, webhooks): **ilimitados por padrão** (`null`); o admin da plataforma pode definir um limite por empresa (T95). Limite definido e atingido → 409 `LIMIT_REACHED`. A cota mensal de disparos em massa segue a regra do produto de referência (T60).

### 3.4 Autenticação
- Sessão por **token opaco** (32 bytes aleatórios), guardado só como SHA-256 em `crm.auth_sessions` (`user_id, token_hash, expires_at, revoked_at, last_seen_at, user_agent, ip`). TTL **30 dias deslizante** (`AUTH_SESSION_TTL_DAYS`).
- Navegador: cookie `crm_session` **httpOnly, SameSite=Lax, Secure em produção**. Nada de token em `localStorage` (regra F-NO-TOKEN-LOCALSTORAGE). Requisições mutantes do navegador exigem header `X-Requested-With: crm` (proteção CSRF simples, além do SameSite).
- Integrações: `Authorization: Bearer crm_pat_<…>` (token de API por empresa, hash no banco, criado em Configurações por owner/admin).
- Senhas com `scrypt` (node:crypto) via `@crm/node-kit` (`hashPassword`/`verifyPassword`, comparação em tempo constante).
- Login: mesma mensagem para usuário inexistente e senha errada; 10 falhas/15 min por IP+e-mail → 429 `RATE_LIMIT`.

### 3.5 Erros da API
Formato: `{ "error": { "code": "…", "message": "…", "details"?: … } }`. Validação: `details.fields = [{ path, message }]`.

| Código | HTTP | Quando |
|---|---|---|
| `MALFORMED_REQUEST` | 400 | JSON inválido, multipart quebrado |
| `UNAUTHORIZED` | 401 | sem sessão/token ou token inválido/expirado/revogado |
| `FORBIDDEN` | 403 | autenticado sem a permissão exigida |
| `NOT_FOUND` | 404 | inexistente **ou de outra empresa** |
| `CONFLICT` | 409 | unicidade, estado incompatível (ex.: chat já tem card) |
| `INVALID_TRANSITION` | 409 | transição de estado não permitida |
| `LIMIT_REACHED` | 409 | limite de quantidade da empresa (conexões, agentes, etc.) |
| `GONE` | 410 | convite/token expirado ou já usado |
| `PAYLOAD_TOO_LARGE` | 413 | upload acima do limite do tipo |
| `UNSUPPORTED_MEDIA` | 415 | mime não aceito |
| `VALIDATION_ERROR` | 422 | corpo/params/query fora do schema zod ou regra de negócio |
| `RATE_LIMIT` | 429 | limite de taxa (API ou gate do pipeline WhatsApp) |
| `WARMUP_LIMIT` | 429 | limite diário de warm-up da sessão |
| `QUOTA_EXCEEDED` | 429 | créditos/cota de IA ou cota de disparos esgotada |
| `SESSION_NOT_CONNECTED` | 409 | conexão WhatsApp fora de `WARMING/STABLE` |
| `CONTACT_NOT_ALLOWED` | 403 | contato com opt-out (ou sem consentimento registrado no engine) |
| `UPSTREAM_ERROR` | 502 | provedor externo (IA, Meta) falhou; mensagem sanitizada |
| `INTERNAL` | 500 | erro não tratado (sem stack na resposta) |

Fonte única: `packages/shared/src/errors/codes.ts` (compartilhado aditivo). Erros do `WaGateway` (`SendRejectedError` do ai-manager) mantêm código e HTTP.

### 3.6 Convenções de API
- Prefixo `/api/*` (autenticado, exceto rotas públicas explícitas). Públicas: `POST /api/auth/login|register|password-resets`, `GET|POST /api/invitations/:token*`, `POST /api/hooks/**` (webhooks de entrada, por token), `GET /health`.
- JSON em **snake_case** no fio (como o ai-manager); DTOs zod em `@crm/shared` são a fonte das formas.
- Paginação por página: `?page=1&limit=20` → `{ items, page: { page, limit, total_count, total_pages, has_more } }` (`total_count`/`total_pages` podem ser `null` com `skip_total=1`). Por cursor: `?cursor=&limit=` → `{ items, next_cursor }`.
- Datas ISO 8601 UTC no fio; agregações por dia/hora no **fuso da empresa** (`companies.time_zone`, padrão `America/Sao_Paulo`).
- Dinheiro: `amount_cents bigint` + `currency char(3)`. Custos de IA: `*_micros bigint` (USD).
- Toda rota mutante grava `crm.audit_logs (company_id, actor_user_id, action, target_type, target_id, detail, created_at)` sem segredos.
- Rotas de módulo montadas como sub-app `new Hono<AppEnv>()` exportado por `apps/api/src/routes/<módulo>/index.ts` e registradas em `routes/index.ts` (compartilhado aditivo).

### 3.7 Realtime (SSE)
- Endpoint único `GET /api/events?company_id=` (Hono `streamSSE`), autenticado por cookie. Heartbeat (`event: ping`) a cada **20 s**. Fecha no logout.
- Envelope: `{ id, type, company_id, at, data }`; `event:` = `type`; `id:` = id do Redis Stream.
- Publicação: `RealtimePublisher.publish(companyId, type, data, { scope? })` → `XADD crm:rt:<companyId> MAXLEN ~ 10000` + `PUBLISH crm:rt` (fan-out entre réplicas). Eventos por usuário: stream `crm:rt:user:<userId>`.
- Reconexão com `Last-Event-ID` reenvia o que ficou no stream da empresa. Filtro no servidor por empresa, permissão do tipo de evento e `chatScope`.
- Catálogo tipado (zod) em `packages/shared/src/realtime/events.ts` (compartilhado aditivo). Nomes `<domínio>.<ação>` — mapeamento ActionCable → SSE em `21-realtime-e-plataforma.md#realtime-actioncable` e nas tarefas.

### 3.8 WhatsApp (via `@crm/wa-port`)
- Contrato `WaGateway` = proposta do AI-MANAGER-MAP §13.3 + acréscimos exigidos pelos módulos: `sessions.*`, `send`, `sendGroup`, `cancel`, `fetchGroups`, `downloadMedia`, `presence(composing|recording|paused)`, `react`, `deleteForEveryone`, `listContacts`, `recordConsent`/`optOut`, `profile.*` (opcionais por capacidade). Tipos 1:1 com `@wsm/core` quando existirem.
- Eventos `WaEvent v1` no Redis Stream **`wsm:events`** (consumer group `crm`): `message.inbound`, `message.status`, `session.state`, `session.connection`, `session.qr`, `session.pairing_code`, `contact.upsert`, `contact.lid_mapping`, `presence.update`, `history.batch`. Entrega *at-least-once*; idempotência no CRM por `(session_id, message_id)`.
- Estados da sessão (fonte: ai-manager): `NEW → WARMING → STABLE ↔ DEGRADED`, `PAUSED`, `DISCONNECTED`. Mapeamento para a UI de Conexões: `08-conexoes.md` + T40.
- Identidade: contato com `phone_e164` **ou** `wa_lid` (unicidade parcial por empresa em cada um); merge quando chega `contact.lid_mapping`. Nunca usar o JID cru como chave.
- **Mensagens de grupo não entram no inbox do CRM** (como no produto de referência; o ingest as ignora — decisão fechada 10.1).
- Menus, botões, listas, carrossel e Pix são enviados **como texto** (menu numerado, chave Pix + copia-e-cola). Mensagens interativas nativas: fora de escopo (8.3).

### 3.9 Filas, streams e jobs
- `wa-engine`: prefixo BullMQ `wsm`, fila `session:<id>` (concorrência 1 global), stream `wsm:events` — idênticos ao ai-manager.
- CRM: prefixo BullMQ **`crm`**, nomes com `-` (BullMQ proíbe `:`): `flow-step`, `flow-timer`, `flow-trigger`, `exports`, `imports`, `schedules`, `mass-dispatch`, `inbound-webhooks`, `inbound-sales`, `ai-agent`, `ai-knowledge`, `mail`, `meta-sync`.
- Conexões de Worker com `maxRetriesPerRequest: null`; `removeOnComplete`/`removeOnFail` sempre configurados; retry do BullMQ é a única política de retry (adapters de IA com `maxRetries: 0`).
- Cadências recorrentes com `upsertJobScheduler` (API `repeat` não existe no BullMQ 6).
- Jobs são idempotentes (chave determinística em `jobId` e/ou unique no banco).

### 3.10 Testes
- Unitários junto do código: `*.unit.test.ts` (puros/fakes) e `*.db.unit.test.ts` (Postgres real em banco descartável `crm_test_<rand>` via `createTempDatabase({ migrate: true })` do `@crm/db/testing`).
- Aceitação: `tests/acceptance/Txx/*.test.ts` (Vitest; HTTP via `app.request()` ou servidor local; worker via filas reais em Redis db 1 com prefixo aleatório) e `tests/acceptance/Txx/*.e2e.ts` (Playwright 1.63, projetos **`desktop`** 1366×768 e **`mobile`** 390×844, Chromium). **Revisão 2:** no verify cada E2E roda só no `desktop`; o `mobile` roda apenas os ACs de layout/responsivo (o texto do AC cita *mobile*/responsivo, ou a tarefa lista o AC em `mobile` no `tasks.mjs`).
- **Verify em dois níveis (revisão 2):** durante a tarefa, `pnpm --filter X test` roda só os testes afetados desde `--base` (`vitest run --changed <base>`); a suíte completa roda uma vez, no gate (`--full`), e a repetição por instabilidade do gate roda só o que falhou (`--retry-failed`). `VITEST_MAX_WORKERS=2`.
- E2E usa o **harness** (T17): `node scripts/e2e/serve.mjs` sobe API + web com `WA_GATEWAY=fake`, `AI_MODE=fake`, `MAIL_TRANSPORT=memory`, banco descartável com seed, e expõe `/__e2e/*` (reset, emitir evento WhatsApp, ler e-mails) **somente com `E2E=1`**.
- Fakes oficiais: `FakeTransport` (wa-engine), `FakeWaGateway` (wa-port/testing), `FakeLlm`/`FakeTts`/`FakeStt` (ai/testing), mailer `memory` (node-kit), `FakeMetaGraph` (T99), `FakeXPag`/`FakeZenith` (T109/T110), `FakeNotasy` (T112), `FakeUtmify` (T113) — servidores HTTP locais.
- `ANTIBAN_MODE=passthrough` explícito na config de teste (produção nunca decide por `NODE_ENV`).

### 3.11 UI (padrões que todo AC de UI pressupõe)
- Rotas TanStack Router baseadas em arquivo (`apps/web/src/routes/**`); filtros e abas em **search params tipados** (`validateSearch` com zod). Dados com TanStack Query; eventos SSE atualizam/invalidam o cache.
- Design system: Tailwind 4 + shadcn (Base UI), tokens claro/escuro, tema segue o sistema e alterna com Ctrl/Cmd+M.
- **i18n completo em pt-BR, en e es** (pt-BR é o padrão e o fallback). Cada tarefa de UI entrega as chaves do seu módulo nas **três** línguas em `apps/web/src/i18n/{pt-BR,en,es}/<módulo>.json`; nenhum texto visível fica fora do i18n. O comando `pnpm --filter @crm/web i18n:check` (T23) falha se faltar chave em alguma língua e roda no verify de toda tarefa de UI.
- **Estados obrigatórios** em toda tela de dados: carregando (skeleton), vazio (com ação primária), erro (mensagem + "Tentar novamente"), sem permissão (oculto ou "Acesso negado").
- **Mobile (390 px):** sem rolagem horizontal da página, navegação inferior, tabelas viram cartões, painéis laterais viram *sheet*.
- `data-testid` kebab-case `<módulo>-<elemento>` em todo elemento citado num AC (os Testers preferem papéis/rótulos acessíveis e usam `data-testid` quando não houver).
- Diálogos de confirmação com componente (nunca `window.confirm`). Textos com `APP_NAME` quando citarem o produto.

### 3.12 Variáveis de ambiente (mínimo; `.env.example`)
`APP_NAME`, `NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL` (padrão `postgres://wsm:wsm@127.0.0.1:5432/crm`), `REDIS_URL` (padrão `redis://127.0.0.1:6379/1`), `CREDENTIALS_KEY` (32 bytes base64), `AUTH_SESSION_TTL_DAYS`, `API_PUBLIC_URL`, `WEB_PUBLIC_URL`, `STORAGE_DIR`, `MAIL_TRANSPORT` (`smtp|memory`), `SMTP_URL`, `MAIL_FROM`, `WA_GATEWAY` (`rpc|fake`), `WA_RPC_URL`, `WA_RPC_PROFILE` (`crm|ai-manager`), `INTERNAL_TOKEN`, `WA_TRANSPORT` (`baileys|fake`, só wa-worker), `ANTIBAN_MODE`, `ANTIBAN_PRESET`, `WA_EVENTS_STREAM` (`wsm:events`), `AI_MODE` (`real|fake`), `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ELEVENLABS_API_KEY`, `GROQ_API_KEY`, `FFMPEG_PATH`, `META_GRAPH_URL` (padrão `https://graph.facebook.com/v26.0`), `META_APP_ID`, `META_APP_SECRET`, `AFFILIATE_PORTAL_URL`, `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` (seed), `E2E` (só harness).

**3.12.1 Variáveis acrescentadas por tarefas posteriores** (cada tarefa adiciona as suas ao `.env.example`, que é compartilhado e aditivo; o AC-T00-05 cobre só a lista acima): `OPENROUTER_API_KEY` (T12), `TUTORIALS_URL`, `SUPPORT_PROVIDER`, `SUPPORT_SCRIPT_URL`, `SUPPORT_PHONE` (T108), `XPAG_API_URL` (T109), `ZENITH_API_URL`, `ZENITH_CLIENT_ID`, `ZENITH_CLIENT_SECRET`, `ZENITH_REDIRECT_URI` (T110), `NOTASY_API_URL` (T112), `UTMIFY_API_URL` (T113), `MCP_OAUTH_ISSUER` (T115). URLs de provedores externos sempre configuráveis para apontar aos fakes nos testes.

## 4. Grafo de tarefas (ondas)

> Gerado de `spec/verify/tasks.mjs` (a onda é o caminho mais longo de dependências; `minWave` adia de propósito tarefas de baixa prioridade). `verify.mjs lint-spec` confere esta tabela.

### 4.1 Paralelismo por onda

| Onda | Tarefas | Tarefas na onda (máx. paralelo teórico) | Lotes com 4 pares |
|---|---|---|---|
| 0 | T00 | 1 | 1 |
| 1 | T01, T02, T03, T04, T05 | 5 | 2 |
| 2 | T06, T07, T08, T09, T10, T11, T12, T18 | 8 | 2 |
| 3 | T13, T14, T15, T16, T17, T19, T24 | 7 | 2 |
| 4 | T20, T21, T22, T23, T25, T26, T27, T28 | 8 | 2 |
| 5 | T29, T30, T31, T32, T33, T34, T35, T36, T37, T38, T39, T40, T41, T42, T43, T44, T45, T67, T72, T99, T109 | 21 | 6 |
| 6 | T46, T47, T48, T49, T50, T51, T52, T53, T54, T55, T56, T57, T58, T59, T60, T61, T73, T80, T84, T93, T94, T101, T104, T110, T111, T112, T113 | 27 | 7 |
| 7 | T62, T63, T64, T65, T66, T68, T69, T70, T71, T74, T78, T81, T90, T103, T105, T107, T114, T115 | 18 | 5 |
| 8 | T75, T76, T77, T79, T82, T83, T87, T89, T106 | 9 | 3 |
| 9 | T85, T86, T88, T91 | 4 | 1 |
| 10 | T92 | 1 | 1 |
| 11 | T95, T96, T97, T98, T108 | 5 | 2 |
| 12 | T100 | 1 | 1 |
| 13 | T102 | 1 | 1 |

**Total:** 116 tarefas em 14 ondas. Execução decidida pelo usuário: **4 pares Operário+Tester em paralelo** (8 agentes), o que dá **36 lotes** no total; dentro da onda, a ordem segue o caminho crítico (`verify.mjs plan --max 4`).

### 4.2 Tabela de tarefas

| Onda | Tarefa | Título | Depende de | UI (E2E) |
|---|---|---|---|---|
| 0 | T00 | Scaffold do monorepo | — |  |
| 1 | T01 | @crm/db: client, migrações e tabelas-base | T00 |  |
| 1 | T02 | @crm/shared: contratos isomórficos | T00 |  |
| 1 | T03 | @crm/wa-port: WaGateway, WaEvent, fake e suíte de contrato | T00 |  |
| 1 | T04 | @crm/ai: portas LLM/TTS/STT e fakes | T00 |  |
| 1 | T05 | @crm/node-kit: logger, cripto, config, Redis/BullMQ, storage, e-mail | T00 |  |
| 2 | T06 | WA: schema public.* e auth state cifrado | T01, T05 |  |
| 2 | T07 | WA: transporte (interface, Fake e Baileys) | T03, T05 |  |
| 2 | T08 | API: esqueleto, middlewares e contexto multiempresa | T01, T02, T05 |  |
| 2 | T09 | Worker: esqueleto, consumidor do wsm:events e jobs | T01, T03, T05 |  |
| 2 | T10 | Fluxos: FlowDefinition, handles, validate e configs de ação | T02 |  |
| 2 | T11 | Templating: interpolação de variáveis | T02 |  |
| 2 | T12 | Adapters de IA: AI SDK 7, ElevenLabs, Groq e áudio | T04, T05 |  |
| 2 | T18 | Consumo de IA: preços, ledger, carteira e porta BillingProvider | T01, T02, T04 |  |
| 3 | T13 | WA: SessionManager e proxy | T06, T07 |  |
| 3 | T14 | WA: fila por sessão, antiban, warm-up e limites | T06, T07 |  |
| 3 | T15 | Autenticação, cadastro, perfil e senha | T08 |  |
| 3 | T16 | Realtime: SSE, fan-out e replay | T08 |  |
| 3 | T17 | Harness E2E (API com fakes, seed, reset) | T08, T03, T04 |  |
| 3 | T19 | Fluxos: schema e repositório | T01, T10 |  |
| 3 | T24 | UsageGuard e provider medido | T18, T12 |  |
| 4 | T20 | WA: SendPipeline, deliver e health | T13, T14 |  |
| 4 | T21 | WA: outbox de eventos, mídia e contatos | T13 |  |
| 4 | T22 | Empresas, equipe, convites e permissões | T15 |  |
| 4 | T23 | Web: shell, design system, i18n, guards e cliente HTTP | T15, T16, T17 | sim |
| 4 | T25 | Motor de fluxos: runner, registro de nós e dry-run | T19, T11, T09 |  |
| 4 | T26 | Contatos, etiquetas e campos personalizados | T15 |  |
| 4 | T27 | Jobs genéricos de exportação e importação | T09, T16 |  |
| 4 | T28 | API de fluxos, pastas, nós e arestas | T19, T15 |  |
| 5 | T29 | App wa-worker e RPC interno | T20, T21 |  |
| 5 | T30 | Motor de fluxos: timers, esperas, cancelamento e pausa | T25 |  |
| 5 | T31 | Departamentos e horários de atendimento | T22 |  |
| 5 | T32 | Acesso de suporte | T22, T16 |  |
| 5 | T33 | Chats: modelo e ingestão de eventos WhatsApp | T26, T09, T16 |  |
| 5 | T34 | Vendas, produtos, despesas e grupos de filtro | T26 |  |
| 5 | T35 | Conteúdo: respostas rápidas, modelos, variáveis globais, figurinhas | T26, T11 |  |
| 5 | T36 | UI: autenticação, perfil e troca de empresa | T22, T23 | sim |
| 5 | T37 | API de consumo de IA (empresa e plataforma) | T24, T22 |  |
| 5 | T38 | Chaves de provedores de IA (BYOK) | T12, T22 |  |
| 5 | T39 | Agentes de IA: schema e CRUD | T22, T26 |  |
| 5 | T40 | Conexões: API, QR, pareamento, proxy e perfil | T22, T03 |  |
| 5 | T41 | Nós de lógica (condição, distribuidor, conexão de fluxo, intervalo) | T25 |  |
| 5 | T42 | Nós externos (HTTP e IA) | T25, T24 |  |
| 5 | T43 | API de execuções, compartilhar, importar e exportar | T25, T28 |  |
| 5 | T44 | UI fluxos: lista e pastas | T28, T23 | sim |
| 5 | T45 | UI fluxos: canvas do editor | T28, T23 | sim |
| 5 | T67 | Contatos: importação CSV e do WhatsApp | T26, T27 |  |
| 5 | T72 | Webhooks de entrada: CRUD e recepção pública | T26 |  |
| 5 | T99 | Meta: cliente Graph, OAuth, perfis e contas de anúncio | T22 |  |
| 5 | T109 | Pagamentos ao lead: porta, chaves e adapter XPag | T22 |  |
| 6 | T46 | @crm/wa-gateway-rpc: adapter WaGateway por RPC + stream | T29 |  |
| 6 | T47 | Conexões: projeção de status, eventos e alertas | T40, T09, T16 |  |
| 6 | T48 | Chats: lista, filtros, escopo e ciclo de vida | T33, T31 |  |
| 6 | T49 | Chats: envio, mídia e leitura | T33 |  |
| 6 | T50 | Kanban: quadros, colunas e cards | T33 |  |
| 6 | T51 | Nós de mensagem (mensagem, modelo, notificação, Pix) | T25, T35 |  |
| 6 | T52 | Agentes de IA: base de conhecimento | T39 |  |
| 6 | T53 | UI: empresa, departamentos e horários | T31, T36 | sim |
| 6 | T54 | UI: equipe, permissões, convites e suporte | T32, T36 | sim |
| 6 | T55 | Dashboard: métricas de vendas, bootstrap e marcos | T34 |  |
| 6 | T56 | UI editores de nó: mensagem e interativos | T45, T10 | sim |
| 6 | T57 | UI editores de nó: lógica, CRM e externos | T45, T10 | sim |
| 6 | T58 | UI: respostas rápidas, modelos, variáveis, campos e etiquetas | T35, T26, T23 | sim |
| 6 | T59 | UI: consumo de IA, chaves e hub de integrações | T37, T38, T23 | sim |
| 6 | T60 | Disparos em massa: API e cota | T26, T43 |  |
| 6 | T61 | Gatilhos, fluxos padrão por conexão e ação fora do horário | T30, T33, T40, T31 |  |
| 6 | T73 | Fontes de venda (webhook genérico) e atribuição UTM/CTWA | T34, T33 |  |
| 6 | T80 | Vozes (ElevenLabs) | T38, T12 |  |
| 6 | T84 | UI: central de notificações | T33, T23 | sim |
| 6 | T93 | Assistente (copiloto) de fluxo | T28, T24, T12, T16, T45 | sim |
| 6 | T94 | Servidor MCP (token estático) | T26, T28, T40 | sim |
| 6 | T101 | Meta: estrutura, insights e bundle assíncrono | T99, T09, T16 |  |
| 6 | T104 | Meta: Pixel, Conversions API e nó de fluxo pixel | T99, T25, T34 |  |
| 6 | T110 | Pagamentos ao lead: adapter Zenith (chave, OAuth e webhook) | T109 |  |
| 6 | T111 | Bloco Pagamento no fluxo e confirmação por webhook | T109, T30 |  |
| 6 | T112 | Emissão de NF (Notasy) na venda aprovada | T34, T22 |  |
| 6 | T113 | UTMify: integração e envio de vendas aprovadas | T34, T22 |  |
| 7 | T62 | Nós interativos (menu, carrossel, espera de resposta) | T30, T51 |  |
| 7 | T63 | Nós de CRM (etiquetas, chat, departamento, kanban, manipulador, venda, agente) | T25, T48, T50, T34 |  |
| 7 | T64 | Agendamento de mensagens | T49, T35 |  |
| 7 | T65 | Dashboard: métricas de atendimento | T48 |  |
| 7 | T66 | Contatos: filtros avançados e ações em massa | T26, T27, T50 |  |
| 7 | T68 | Runtime do agente de IA | T39, T24, T12, T33, T49 |  |
| 7 | T69 | UI chats: lista e filtros | T48, T23 | sim |
| 7 | T70 | UI kanban: lista e quadro | T50, T23 | sim |
| 7 | T71 | UI conexões | T40, T47, T23 | sim |
| 7 | T74 | Disparos em massa: preparação e agendador | T60, T30 |  |
| 7 | T78 | UI dashboard: filtros e vendas | T55, T23 | sim |
| 7 | T81 | Webhooks de entrada: processador e escuta de amostras | T72, T61, T50 |  |
| 7 | T90 | UI fontes de venda e produtos | T73, T23 | sim |
| 7 | T103 | Meta: edição de status, nome e orçamento | T101 |  |
| 7 | T105 | Meta: vendas internas × anúncios (CTWA) e ROAS | T101, T73 |  |
| 7 | T107 | Indicador de conexões desconectadas no menu | T47, T23 | sim |
| 7 | T114 | UI: pagamentos, NF, UTMify e editores dos blocos Pagamento e Venda aprovada | T110, T111, T112, T113, T45, T59 | sim |
| 7 | T115 | MCP: OAuth para conectores (Claude) | T94 | sim |
| 8 | T75 | UI chats: conversa | T69, T49 | sim |
| 8 | T76 | UI kanban: modais, filtros, estatísticas e exportação | T70, T27 | sim |
| 8 | T77 | UI contatos: lista e seleção em massa | T66, T23 | sim |
| 8 | T79 | Agentes: teste ao vivo, geração de prompt e criação assistida | T68 |  |
| 8 | T82 | Simulador de fluxos | T41, T42, T51, T62, T63, T45 | sim |
| 8 | T83 | UI disparos em massa | T60, T74, T23 | sim |
| 8 | T87 | UI dashboard: histórico, atendimento e marcos | T78, T65 | sim |
| 8 | T89 | UI webhooks de entrada | T81, T23 | sim |
| 8 | T106 | UI Facebook: gerenciador, pixel e perfis | T101, T103, T104, T23 | sim |
| 9 | T85 | UI chats: compositor | T75, T64 | sim |
| 9 | T86 | UI contatos: formulário, importação e jobs | T77, T67 | sim |
| 9 | T88 | UI agentes: lista e editor | T79, T80, T52, T23 | sim |
| 9 | T91 | UI chats: painel lateral e agendamentos | T75, T64 | sim |
| 10 | T92 | UI agentes: teste ao vivo, criação assistida e vozes | T88 | sim |
| 11 | T95 | Admin: usuários, empresas, limites e cotas | T22, T60 |  |
| 11 | T96 | Admin: avisos, banners, saúde, sessões WhatsApp e IA | T22, T46, T37 |  |
| 11 | T97 | Afiliação: captura de indicação e link externo | T36 | sim |
| 11 | T98 | Extensão: perfil ai-manager do gateway e documentação | T46 |  |
| 11 | T108 | Tutoriais e widget de suporte plugável | T23 | sim |
| 12 | T100 | UI admin interno | T95, T96, T23 | sim |
| 13 | T102 | Integração E2E final | T85, T86, T87, T91, T92, T89, T90, T83, T82, T76, T71, T84, T53, T54, T58, T59, T44, T56, T57, T93, T94, T97, T98, T100, T105, T106, T107, T108, T114, T115 | sim |

---

## 5. Tarefas

> As tarefas aparecem em ordem aproximada de onda; **a onda oficial de cada tarefa é a da tabela 4.2** (calculada pelo `tasks.mjs`).
> Formato: **Objetivo**, **Paths** (onde o Operário pode escrever, além dos compartilhados), **Depende de**, **Ref** (seções de feature a ler),
> **Entregáveis/Contratos**, **Critérios de aceitação** e **Notas para o Tester**. Paths exatos e comandos de verificação: `spec/verify/tasks.mjs`.
> Toda tarefa de API inclui implicitamente: isolamento multiempresa (3.3, cross-tenant → 404), `requirePerm` nas rotas, validação zod (422) e auditoria das mutações (3.6). Toda tarefa de UI inclui os estados e o comportamento mobile da seção 3.11. Esses itens são cobrados pelos ACs listados quando citados explicitamente.

---

### T00 — Scaffold do monorepo
**Objetivo:** base que todas as tarefas usam, espelhando o ai-manager (`AI-MANAGER-MAP.md#1-visão-geral`).
**Paths:** manifestos e configs da raiz (inclui `.gitattributes`), `apps/*/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}`, `packages/*/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}`, `scripts/**`, `docs/README.md`.
**Depende de:** —
**Entregáveis:** workspaces `apps/{api,worker,wa-worker,web}` e `packages/{shared,db,node-kit,wa-port,wa-engine,wa-gateway-rpc,ai,core}` com scripts `build`, `typecheck`, `lint`, `test`; `tsconfig.base.json` strict; ESLint 10 flat config com `typescript-eslint` e **`no-restricted-imports`** aplicando a regra 1.4 nº 11; Prettier; `.nvmrc` = 22; `engines.node >= 22.12`; `.env.example` (3.12); `git init`.
**Critérios de aceitação**
- **AC-T00-01** `pnpm install` seguido de `pnpm -r build` termina com exit 0 em Node 22.
- **AC-T00-02** Os 12 workspaces existem com os nomes `@crm/*` da seção 3.1 e cada `package.json` tem `build`, `typecheck`, `lint` e `test`.
- **AC-T00-03** `tsconfig.base.json` tem `strict: true` e é herdado por todos os workspaces; `engines.node` declara `>=22.12`.
- **AC-T00-04** Um arquivo em `packages/core/src` que importe `@whiskeysockets/baileys`, `@crm/wa-engine` ou `openai` faz `pnpm --filter @crm/core lint` falhar (regra `no-restricted-imports`).
- **AC-T00-05** `.env.example` contém todas as variáveis da seção 3.12, sem segredo real, e `APP_NAME` tem valor neutro.
- **AC-T00-06** Nenhum arquivo do repositório (fora de `spec/`) contém a palavra "Leona" (case-insensitive).

**Notas para o Tester:** criar `tests/acceptance/vitest.config.ts` (config da suíte, `ANTIBAN_MODE=passthrough`, timeouts) e `tests/acceptance/helpers/` (exec de comandos, cliente HTTP, factories, banco descartável).

---

### T01 — @crm/db: client, migrações e tabelas-base
**Objetivo:** persistência com dois conjuntos de migrations independentes (WhatsApp em `public`, CRM em `crm`), para conviver com o banco do ai-manager.
**Paths:** `packages/db/**`
**Depende de:** T00
**Ref:** `AI-MANAGER-MAP.md#6-schema-do-banco-packagesdbsrcschema`, `STACK.md` Bloco B (drizzle 0.45 / kit 0.31).
**Entregáveis/Contratos:**
- `createDb(url)` (node-postgres Pool) → `Database`; `runMigrations(db, { set: 'wa' | 'crm' | 'all' })` com **advisory lock**; `drizzle.wa.config.ts` (out `drizzle/wa`) e `drizzle.crm.config.ts` (out `drizzle/crm`, `schemaFilter: ['crm']`, `migrations.schema: 'crm'`); scripts `db:generate:wa`, `db:generate:crm`, `migrate`.
- `pgSchema('crm')` e tabelas-base em `src/schema/crm/`: `companies` (name, slug, active, time_zone, settings jsonb, deactivated_at), `users` (email único case-insensitive, password_hash, name, system_role, locale, avatar_key, last_company_id, referral_code), `company_members` (company_id, user_id, role, permission_keys text[] null, unique), `auth_sessions`, `api_tokens`, `password_resets`, `audit_logs`, `platform_settings`.
- `@crm/db/testing`: `createTempDatabase({ migrate })` (`crm_test_<rand>`) e `drop()`.
**Critérios de aceitação**
- **AC-T01-01** `runMigrations({ set: 'crm' })` num banco vazio cria o schema `crm` com as 8 tabelas-base e grava o controle de migrations dentro do schema `crm` (não em `public`).
- **AC-T01-02** Rodar `runMigrations({ set: 'all' })` duas vezes seguidas termina sem erro, e duas chamadas concorrentes não falham (advisory lock).
- **AC-T01-03** `users.email` é único sem diferenciar maiúsculas; `company_members` aceita no máximo um `owner` por empresa (índice parcial) e um vínculo por (empresa, usuário).
- **AC-T01-04** `createTempDatabase({ migrate: true })` devolve um banco migrado e `drop()` o remove mesmo com conexões abertas.
- **AC-T01-05** As migrations `crm` aplicadas num banco que já tem as tabelas `public.*` do ai-manager não alteram nenhuma tabela `public`.

---

### T02 — @crm/shared: contratos isomórficos
**Objetivo:** tipos e schemas zod usados por API, worker e web.
**Paths:** `packages/shared/**`
**Depende de:** T00
**Ref:** `16-configuracoes-empresa-equipe.md#8-permissões`, `21-realtime-e-plataforma.md#cliente-http`.
**Entregáveis:** `errors/codes.ts` (tabela 3.5 com HTTP), `pagination.ts`, `phone.ts` (E.164 com `libphonenumber-js`, BR 10–11 dígitos), `money.ts`, `ids.ts`, `permissions/{catalog,defaults,resolve}.ts` (`can(member, key)`, normalização de dependências), `realtime/events.ts` (envelope + catálogo base), `dto/` (company, user, member). Zero dependência de Node.
**Critérios de aceitação**
- **AC-T02-01** `ERROR_CODES` contém exatamente os códigos da seção 3.5 com o HTTP correspondente, e `httpStatusOf(code)` os devolve.
- **AC-T02-02** `can()`: `owner` sempre `true`; lista explícita não vazia substitui a matriz do papel; `profile.view` e `settings.global_variables.view` sempre concedidos; nenhuma chave `billing.*` existe no catálogo.
- **AC-T02-03** `normalizePermissions(['chat.block','contacts.edit'])` acrescenta `chat.view`, `contacts.view` e `settings.view` quando aplicável, sem duplicar.
- **AC-T02-04** `parsePhone('+55 (11) 99999-8888')` → `+5511999998888`; número BR com 9 dígitos sem DDD → erro; `toE164` rejeita menos de 8 dígitos.
- **AC-T02-05** O schema de envelope realtime rejeita `type` fora do catálogo e aceita os tipos-base (`company.updated`, `member.permissions_changed`).
- **AC-T02-06** O pacote compila para browser: `import('@crm/shared')` num bundle Vite sem polyfills de Node funciona (teste de build).

---

### T03 — @crm/wa-port: WaGateway, WaEvent, fake e suíte de contrato
**Objetivo:** a fronteira única entre o CRM e o WhatsApp (AI-MANAGER-MAP §13.3).
**Paths:** `packages/wa-port/**`
**Depende de:** T00
**Ref:** `AI-MANAGER-MAP.md#133-o-contrato-wagateway-pacote-wa-port`, `STACK.md` Bloco C.
**Entregáveis/Contratos:**
- `gateway.ts`: interface `WaGateway` (3.8) com tipos `SendRequest`, `MessageView`, `SessionView`, `GroupSummary`, `IncomingMessage` (+ `media?: MediaHandle`, `quoted_id?`, `ad?: CtwaInfo`, `alt_jid?`), `MessageStatus`, `OutgoingContent` (texto, imagem, vídeo, áudio `ptt`, documento, figurinha, contato vCard, localização, reação, apagar), `WaCapabilities` (`nativeButtons`, `nativeCarousel`, `calls`, `labelsSync`, `businessProfile` — **todas `false` por padrão**).
- `errors.ts`: `SendRejectedError` com os códigos/HTTP do ai-manager (`SESSION_NOT_FOUND`, `SESSION_NOT_CONNECTED`, `CONTACT_NOT_ALLOWED`, `WARMUP_LIMIT`, `RATE_LIMIT`), `TransportNotConnectedError`.
- `events.ts`: `WaEvent` v1 (zod discriminado por `type`, 3.8) + `parseWaEvent`.
- `testing/fake-gateway.ts` (subpath `@crm/wa-port/testing`): `FakeWaGateway` com `sent[]`, `emit(event)`, `failNext(code)`, sessões simuladas, `downloadMedia` com fixture.
- `contract/suite.ts`: suíte Vitest parametrizada por fábrica de gateway.
**Critérios de aceitação**
- **AC-T03-01** `parseWaEvent` aceita cada tipo de 3.8 com payload válido, rejeita `v !== 1` e faz round-trip JSON idêntico.
- **AC-T03-02** `SendRejectedError` expõe `code` e `status` iguais à tabela do pipeline do ai-manager (`AI-MANAGER-MAP.md#4-pipeline-de-envio-e-antiban`).
- **AC-T03-03** `FakeWaGateway`: `send` registra em `sent[]` e devolve `MessageView` `queued`; `failNext('SESSION_NOT_CONNECTED')` faz o próximo `send` rejeitar com 409; `emit` entrega o evento a todos os assinantes.
- **AC-T03-04** A suíte de contrato roda verde contra o `FakeWaGateway` (send, cancel, sessions, downloadMedia, eventos).
- **AC-T03-05** `defaultCapabilities()` devolve todas as flags `false`; o pacote não tem dependência além de `zod`.

---

### T04 — @crm/ai: portas LLM/TTS/STT e fakes
**Objetivo:** contrato único de IA (STACK Bloco F §F.2) e fakes determinísticos.
**Paths:** `packages/ai/src/port/**`, `packages/ai/src/testing/**`
**Depende de:** T00
**Ref:** `STACK.md#bloco-f--llm-multi-provider-anthropic--openai--google-gemini` (F.2), `07-agentes-ia.md#9-integrações-externas`.
**Entregáveis:** `LlmProvider`, `LlmRequest/LlmResult/LlmUsage/LlmTool/LlmMessage/LlmModelRef`, erros (`LlmQuotaExceededError`, `LlmUpstreamError`), `UsageMeter` (interface chamada antes/depois de cada chamada); `TtsProvider.synthesize({text, voiceId, format}) → {audio, mime, chars}`, `SttProvider.transcribe({audio, mime, language}) → {text, seconds}`; `FakeLlm` (roteiro de respostas e tool calls), `FakeTts`, `FakeStt`.
**Critérios de aceitação**
- **AC-T04-01** `FakeLlm` com roteiro `[toolCall('move_card', {...}), text('ok')]` executa a tool via `execute` e devolve `steps.length === 2`, `finish: 'stop'` e `usage` somado.
- **AC-T04-02** Com `maxSteps: 1` e roteiro de 2 tool calls, `finish === 'tool-limit'`.
- **AC-T04-03** `output` (zod) inválido no roteiro → `LlmResult.finish === 'error'` com mensagem de validação; válido → `object` tipado.
- **AC-T04-04** `UsageMeter.before` lançando `LlmQuotaExceededError` impede a chamada do fake (contador de chamadas = 0).
- **AC-T04-05** `FakeTts` devolve bytes determinísticos por (texto, voz); `FakeStt` devolve o texto configurado e `seconds > 0`.

---

### T05 — @crm/node-kit: logger, cripto, config, Redis/BullMQ, storage, e-mail
**Objetivo:** utilitários de Node compartilhados por API, workers e engine.
**Paths:** `packages/node-kit/**`
**Depende de:** T00
**Ref:** `AI-MANAGER-MAP.md#2-interface-de-transporte-packagescoresrctransport` (redação), `STACK.md` Bloco A (pino 10) e Bloco E §6 (nodemailer 10.1.1).
**Entregáveis:** `createLogger` (pino, redação profunda de `password`, `token`, `secret`, `apiKey`, `creds`, `keys`, `noiseKey`, `signedIdentityKey`, `authorization`, `cookie`), `encrypt/decrypt` AES-256-GCM com AAD e `keyVersion` (`CREDENTIALS_KEY`), `hashPassword/verifyPassword` (scrypt), `loadConfig(schema)` (zod sobre `process.env`), `redisConnection()` e `bullConnection()` (`maxRetriesPerRequest: null`), `BlobStore` (porta) + `FsBlobStore` (`STORAGE_DIR`, chave por sha256), `Mailer` (porta) + `SmtpMailer` (transporte singleton com `pool`) + `MemoryMailer`.
**Critérios de aceitação**
- **AC-T05-01** `decrypt(encrypt(x, aad), aad) === x` para string e Buffer; AAD diferente, IV ou tag adulterados → erro; `CREDENTIALS_KEY` ausente ou ≠ 32 bytes → erro na inicialização.
- **AC-T05-02** Logar `{ user: { password: 'p', apiKey: 'k' }, creds: {...} }` não produz os valores no output (redação em qualquer profundidade, inclusive em child loggers).
- **AC-T05-03** `verifyPassword(await hashPassword('s3nha!'), 's3nha!')` é `true`, senha errada `false`, e o hash não contém a senha.
- **AC-T05-04** `FsBlobStore.put(buffer, mime)` devolve `{ key, size, sha256, mime }`; `get(key)` devolve os mesmos bytes; chave com `..` é rejeitada.
- **AC-T05-05** `MemoryMailer` guarda as mensagens enviadas (to, subject, html, text); `loadConfig` com variável obrigatória ausente lança erro listando o nome.
- **AC-T05-06** `bullConnection()` devolve opções com `maxRetriesPerRequest: null` e respeita o número do banco na `REDIS_URL` (`/1`).

---

### T06 — WA: schema public.* e auth state cifrado
**Objetivo:** tabelas do WhatsApp **idênticas** às do ai-manager e auth state Baileys cifrado no Postgres.
**Paths:** `packages/db/src/schema/wa/**`, `packages/db/drizzle/wa/**`, `packages/db/drizzle.wa.config.ts`, `packages/wa-engine/src/auth-state/**`, `packages/wa-engine/src/db/**`
**Depende de:** T01, T05
**Ref:** `AI-MANAGER-MAP.md#6-schema-do-banco-packagesdbsrcschema` e §3 (auth state); `ai-manager/packages/db/src/schema/**` e `ai-manager/packages/core/src/auth-state/**` (copiar e adaptar).
**Entregáveis:** schema `wa` (proxies, sessions, session_credentials, contacts, messages, message_events, health_events, session_limits, proxy_settings) com mesmos nomes, colunas, enums e constraints; migrations `drizzle/wa` equivalentes a `0000..0007` do ai-manager; `usePostgresAuthState(db, sessionId)` com AES-256-GCM (AAD `sessionId/keyType/keyId`) envolvido por `makeCacheableSignalKeyStore`.
**Critérios de aceitação**
- **AC-T06-01** Após migrar `wa` num banco vazio, a lista de tabelas, colunas (nome, tipo, nulidade) e enums de `public` é idêntica à fixture extraída do ai-manager (comparação de `information_schema`).
- **AC-T06-02** `session_credentials` só tem colunas cifradas; um valor marcador salvo como credencial não aparece em nenhuma coluna lida em texto.
- **AC-T06-03** `keys.set({ 'pre-key': { '1': null } })` remove a chave; `keys.get` de tipos arbitrários (incluindo `lid-mapping` e `app-state-sync-key`) faz round-trip; recriar o state (restart) recarrega `creds` idênticas.
- **AC-T06-04** Credencial gravada com um `sessionId` e lida com outro falha na decifragem (AAD).
- **AC-T06-05** Leituras repetidas da mesma chave dentro do cache não geram nova query (spy no client).

---

### T07 — WA: transporte (interface, Fake e Baileys)
**Objetivo:** isolar o Baileys 7.0.0-rc14 atrás de `WaTransport`, com os acréscimos que o CRM precisa.
**Paths:** `packages/wa-engine/src/transport/**`
**Depende de:** T03, T05
**Ref:** `AI-MANAGER-MAP.md#2-interface-de-transporte-packagescoresrctransport`, `STACK.md` Bloco C (C.2–C.10), `03-chats.md#compatibilidade-baileys-clone`.
**Entregáveis:** `WaTransport` do ai-manager + `downloadMedia`, `sendPresence`, `react`, `deleteForEveryone`, `markRead`, `listContacts`, eventos `contact`, `lid-mapping`, `presence`, `history`; `IncomingMessage` com `media`, `quoted_id`, `ad` (de `contextInfo.externalAdReply`: `sourceId`, `ctwaClid`, `sourceUrl`, mídia); `FakeTransport` com helpers de simulação; `BaileysTransport` com `markOnlineOnConnect: false`, `getMessage`, cache de grupos, ack de `<status>`, guarda de socket substituído, proxy agent, fingerprint por sessão. Baileys **fixado em `7.0.0-rc14`** e `baileys-antiban@4.10.0` exatos.
**Critérios de aceitação**
- **AC-T07-01** (socket fake `BaileysSocketLike`) `messages.upsert` tipo `notify` emite `message` com `alt_jid` vindo de `key.remoteJidAlt`; tipo `append` emite com `historical: true` e não como mensagem nova.
- **AC-T07-02** Mensagem com `contextInfo.externalAdReply { sourceId, ctwaClid, sourceUrl }` produz `ad` preenchido; sem esses campos, `ad` é `undefined` e nada lança.
- **AC-T07-03** `DisconnectReason` 401 → `loggedOut`, 403 → `forbidden`, 515 e demais → `transient`; eventos de um socket já substituído são ignorados.
- **AC-T07-04** `sendMessage` de áudio com `ptt: true` envia `mimetype: 'audio/ogg; codecs=opus'`; reação envia `{ react: { text, key } }` com a key original completa.
- **AC-T07-05** `FakeTransport` expõe `emitQr`, `emitPairingCode`, `open`, `close(reason)`, `receive(msg)`, `receipt(id, status)`, `failNextSend`, `emitLidMapping`, `emitContact` e registra envios em `sent[]`.
- **AC-T07-06** Nenhum arquivo fora de `packages/wa-engine/src/transport/**` (e dos demais diretórios do engine listados na regra F-WA-BOUNDARY) importa `@whiskeysockets/baileys`.

---

### T08 — API: esqueleto, middlewares e contexto multiempresa
**Objetivo:** servidor Hono testável sem porta, com auth, empresa ativa, permissões, erros, validação e auditoria.
**Paths:** `apps/api/src/{app.ts,server.ts,config.ts}`, `apps/api/src/middleware/**`, `apps/api/src/lib/**`, `apps/api/src/routes/health/**`, `packages/core/src/platform/**`, `packages/db/src/schema/crm/platform.ts`
**Depende de:** T01, T02, T05
**Ref:** `AI-MANAGER-MAP.md#8-padrão-de-rotas-api-hono`, `21-realtime-e-plataforma.md#cliente-http`, `STACK.md` Bloco A (hono 4.13.8, `@hono/node-server` 2.1.1).
**Entregáveis:** `createApp(deps)`; middlewares `requestId`, logger, `sessionAuth` (cookie `crm_session` ou Bearer `crm_pat_`), `companyContext` (`X-Company-Id` / `last_company_id`), `requirePerm(key)`, `requirePlatformRole(role)`, `csrfGuard`, `audit`, `rateLimit` (Redis); `validate(target, schema)`; `onError`/`notFound` no formato 3.5; `GET /health`; `packages/core/src/platform` com `SessionService.verify`, `AuditService`, `ctx` tipado `{ user, companyId, member, perms }`.
**Critérios de aceitação**
- **AC-T08-01** `GET /health` → 200 `{ status, db, redis }` sem auth; com Redis fora → `redis: "down"` e 200.
- **AC-T08-02** `/api/*` sem sessão → 401 `UNAUTHORIZED`; com cookie de sessão revogada ou expirada → 401.
- **AC-T08-03** `X-Company-Id` de uma empresa da qual o usuário não é membro → 404 `NOT_FOUND`; sem header, vale `last_company_id`.
- **AC-T08-04** Rota com `requirePerm('contacts.edit')` → 403 `FORBIDDEN` para membro sem a chave e 2xx para `owner`.
- **AC-T08-05** Corpo inválido → 422 `VALIDATION_ERROR` com `details.fields[].path`; JSON malformado → 400 `MALFORMED_REQUEST`; erro não tratado → 500 sem stack na resposta.
- **AC-T08-06** Mutação bem-sucedida grava `audit_logs` com `company_id`, `actor_user_id`, `action` e sem campos de senha/segredo; POST de navegador sem `X-Requested-With: crm` → 403.

---

### T09 — Worker: esqueleto, consumidor do wsm:events e jobs
**Objetivo:** processo de jobs do CRM e framework de consumo do stream de eventos WhatsApp.
**Paths:** `apps/worker/src/{main.ts,boot/**,consumers/framework/**}`, `packages/core/src/jobs/**`, `packages/db/src/schema/crm/jobs.ts`
**Depende de:** T01, T03, T05
**Ref:** `AI-MANAGER-MAP.md#134-transporte-dos-eventos-redis-streams`, `STACK.md` Bloco B (bullmq 6.3.8, ioredis 6).
**Entregáveis:** boot com shutdown gracioso; `registry.ts` (compartilhado) onde módulos registram handlers/filas; `StreamConsumer` (`XREADGROUP` grupo `crm`, `XACK` só após sucesso, `XAUTOCLAIM` de pendentes após 60 s, DLQ após 5 falhas em `crm:wa-events:dlq`); tabela `crm.processed_events (consumer, event_key)` para idempotência; `defineQueue(name)`/`defineWorker(name, handler, opts)` com prefixo `crm` e defaults (removeOnComplete/Fail, backoff exponencial).
**Critérios de aceitação**
- **AC-T09-01** Evento publicado em `wsm:events` com `XADD` chega ao handler registrado para o seu `type` com o payload validado por `parseWaEvent`.
- **AC-T09-02** Handler que lança não faz `XACK`; após o reclaim, o evento é reprocessado; após 5 falhas vai para a DLQ e é confirmado.
- **AC-T09-03** O mesmo evento entregue duas vezes executa o efeito uma vez (idempotência por `event_key`).
- **AC-T09-04** Duas instâncias do worker no mesmo grupo dividem os eventos sem processar o mesmo evento duas vezes.
- **AC-T09-05** `defineQueue` cria filas com prefixo `crm` e nome sem `:`; SIGTERM fecha workers e consumidores sem perder job ativo (o job termina antes do exit).

---

### T10 — Fluxos: FlowDefinition, handles, validate e configs de ação
**Objetivo:** formato versionado e isomórfico dos fluxos (usado por API, motor, editor e import/export).
**Paths:** `packages/shared/src/flows/**`
**Depende de:** T02
**Ref:** `06-fluxos.md#3-modelo-de-dados--campos` (3.3–3.9), `06-fluxos.md#compatibilidade-baileys-clone`.
**Entregáveis:** `FlowDefinition` (`schema: 'crm.flow/v1'`, `nodes`, `edges`, `entry`, `variables`, `refs`) em zod; handles normalizados `kind[:id]` (`source`, `option:<id>`, `timeout`, `other`, `failure`, `success`, `output:<key>`); um schema por `node_type` e por `action_type` (`flows/actions/<type>.ts`); tipos fora de escopo (`kieai_integration`, `leonapay`, `make_call`, `template_meta`) presentes só como `unsupported`; `payment` (bloco Pagamento) e `approved_sale` (Venda aprovada) são **suportados** (revisão 1); `validate(def)` → lista de erros por `nodeId`; `migrate(def)` (ex.: `menu` → `interactive_menu`).
**Critérios de aceitação**
- **AC-T10-01** `validate` acusa, com o `nodeId`: nenhum nó após o start, dois edges no mesmo (nó, handle), nó inalcançável, ciclo sem nó de espera, config inválida do action.
- **AC-T10-02** Fluxo válido de exemplo (start → mensagem → menu → 2 opções + timeout) passa sem erros e faz round-trip JSON idêntico.
- **AC-T10-03** `migrate` converte `menu` legado em `interactive_menu` com handles `option:<id>` estáveis (reordenar opções não muda o handle).
- **AC-T10-04** Node type `unsupported` faz `validate` retornar erro `unsupported_node` e a ativação não é permitida.
- **AC-T10-05** Cada `action_type` suportado tem schema e exemplo válido testado. Suportados = os action types listados em `06-fluxos.md#36-tipos-de-ação-action_type-e-config` **menos** os fora de escopo: `kieai_generate`, `make_call`, `send_template` (template oficial da Meta) e a cobrança pelo gateway da referência (`leonapay`) — **31 action types** no total; os excluídos existem só como `unsupported`.

---

### T11 — Templating: interpolação de variáveis
**Objetivo:** renderização única de variáveis para fluxos, respostas rápidas, modelos e agentes.
**Paths:** `packages/core/src/templating/**`
**Depende de:** T02
**Ref:** `06-fluxos.md#39-variáveis-de-template-`, `17-configuracoes-conteudo.md#3c-variável-global-`, `03-chats.md#produtividade-f48f51`.
**Entregáveis:** `render(template, scope, { timeZone, missing: 'empty' | 'keep' })` suportando `{campo}`, `{g_variavel}`, `{{customer.full_name}}`, campos personalizados, variáveis de sistema (`{saudacao}`, `{hora}`, `{data}`, `{dia}`, `{first_name}`), dot-path em respostas (`{response.data.0.status}`); escape `\{`.
**Critérios de aceitação**
- **AC-T11-01** `{saudacao}` rende "Bom dia" às 09:00, "Boa tarde" às 14:00 e "Boa noite" às 20:00 no fuso `America/Sao_Paulo` (relógio injetado).
- **AC-T11-02** `{first_name}` de "Maria da Silva" → "Maria"; `{{customer.full_name}}` usa o nome completo.
- **AC-T11-03** Variável inexistente → vazio com `missing: 'empty'` e literal com `'keep'`.
- **AC-T11-04** `{response.data.0.status}` lê o caminho; `\{literal}` não é interpolado.
- **AC-T11-05** Renderização não executa código nem acessa protótipos (`{__proto__}`, `{constructor}` → vazio).

---

### T12 — Adapters de IA: AI SDK 7, ElevenLabs, Groq e áudio
**Objetivo:** implementações reais das portas de T04, testadas só com mocks.
**Paths:** `packages/ai/src/{aisdk,elevenlabs,groq,audio}/**`
**Depende de:** T04, T05
**Ref:** `STACK.md` Bloco F (F.1–F.4, F.6, F.7) e Bloco E §2–3.
**Entregáveis:** `createAiSdkProvider({ resolveCredentials })` (cria `createAnthropic|createOpenAI|createGoogle|createOpenRouter` **por empresa**; OpenRouter via `@openrouter/ai-sdk-provider@3.1.0` — STACK F.8, `maxRetries: 0`, `instructions`, `isStepCount(maxSteps (+1 com output))`, `store: false` na OpenAI, usage normalizado, `providerData` preservado); `ElevenLabsTts`; `GroqStt` (`whisper-large-v3-turbo`, `language: 'pt'`); `toPttOgg(buffer)` via ffmpeg (`FFMPEG_PATH`, Ogg/Opus mono 48 kHz, duração) com runner injetável. Versões exatas do STACK F.1.
**Critérios de aceitação**
- **AC-T12-01** (com `MockLanguageModelV4`) uma chamada com 2 tools e `output` devolve `object` validado, `steps` e `usage` com `cacheReadTokens`/`reasoningTokens` mapeados de `inputTokenDetails`/`outputTokenDetails`.
- **AC-T12-02** O adapter nunca passa `model` como string: o modelo vem de uma instância criada por empresa com a chave resolvida (spy em `resolveCredentials` por `companyId`).
- **AC-T12-03** Para OpenAI, `providerOptions.openai.store === false`; `maxRetries === 0` para os três provedores.
- **AC-T12-04** `ElevenLabsTts` e `GroqStt` (fetch injetado) enviam modelo, voz/idioma corretos e mapeiam 401/429/5xx para `LlmUpstreamError` com mensagem sem a chave.
- **AC-T12-05** `toPttOgg` chama o ffmpeg com `-ac 1 -c:a libopus` e saída `ogg`; runner falhando → erro tipado; nenhum teste executa ffmpeg real.
- **AC-T12-06** Provedor `openrouter`: modelo no formato `fornecedor/modelo` (ex.: `anthropic/claude-sonnet-5-5`), `compatibility: 'strict'`, `usage: { include: true }`, sem fallback silencioso de provedor; o custo informado pela OpenRouter é exposto em `LlmUsage` (fetch mockado).

---

### T18 — Consumo de IA: preços, ledger, carteira e porta BillingProvider
**Objetivo:** contabilidade de uso de IA por empresa (substitui o módulo de cobrança) e a porta de cobrança futura, só interface.
**Paths:** `packages/core/src/ai-usage/**`, `packages/core/src/billing/**`, `packages/db/src/schema/crm/ai-usage.ts`
**Depende de:** T01, T02, T04
**Ref:** `12-cobrancas-assinaturas-tokens.md#310-carteira-de-tokens-get-leona_aiwallet--wallet`, `#55-tokens-leona`, `#56-admin-referência`; `STACK.md` F.2 (custo por tabela própria).
**Entregáveis:** tabelas `llm_prices` (vigência, por provedor/modelo/tipo), `ai_pricing_settings` (markup, `credits_per_usd`, arredondamento), `ai_usage` (só inserção, `request_id` único), `ai_wallet_entries` (ledger), `ai_wallets` (projeção: saldo, limiar baixo, overrun máximo, status), `ai_quotas` (período dia/mês, máx créditos/custo/tokens, `hard`); `PricingService.costOf(usage, at)`; `WalletService.credit/debit/refund/adjust` transacional; `NoopBillingProvider` + interface `BillingProvider` mínima (createCheckout, parseWebhook; definida na própria T18) sem nenhuma rota.
**Critérios de aceitação**
- **AC-T18-01** `costOf` escolhe o preço vigente na data (antes e depois de `effective_from`), cobra cache read/write e reasoning à parte e aplica markup e arredondamento configurados; modelo sem preço → `PriceNotFoundError`.
- **AC-T18-02** Após 100 débitos concorrentes, `ai_wallets.balance_credits` = soma de `ai_wallet_entries` da empresa.
- **AC-T18-03** Cruzar o limiar muda `status` para `low` e saldo ≤ `-max_overrun` para `exhausted`; recarga volta a `ok`.
- **AC-T18-04** `refund(usageId)` é idempotente (segunda chamada não credita) e marca `ai_usage.status = 'refunded'`.
- **AC-T18-05** `NoopBillingProvider.createCheckout` lança `BillingNotConfiguredError`; nenhuma rota HTTP importa `billing/`.

---

### T13 — WA: SessionManager e proxy
**Objetivo:** criar, autenticar, persistir, reconectar e controlar sessões (fork do ai-manager).
**Paths:** `packages/wa-engine/src/session/**`, `packages/wa-engine/src/proxy/**`
**Depende de:** T06, T07
**Ref:** `AI-MANAGER-MAP.md#3-sessionmanager-appsworkersrcsessionsmanagerts`, `_ref_wsm_SPEC.md` T05/T06/T17/T22.
**Entregáveis:** máquina de estados (3.8) com `canTransition`; `SessionManager` (eventos `connected/disconnected/state/qr/pairing-code/reconnect`, cadeia serializada por sessão, backoff 1 s·2ⁿ até 5, timeouts de pareamento/conexão); proxy **opcional** por sessão (http/https/socks5, senha cifrada; com proxy configurado nunca conecta direto).
**Critérios de aceitação**
- **AC-T13-01** Abrir conexão no `FakeTransport` leva a sessão a `WARMING`, grava `health_event` `connected` e persiste as credenciais cifradas.
- **AC-T13-02** `close(loggedOut)` → `DISCONNECTED` sem reconexão e credenciais apagadas; `close(forbidden)` → `PAUSED`; `close(transient)` → reconexões com backoff (sleep injetado) e `DISCONNECTED` após 5 falhas.
- **AC-T13-03** Reiniciar o manager com o mesmo banco reconecta as sessões com credenciais e estado ≠ `DISCONNECTED`; `PAUSED` reconecta mas continua `PAUSED`.
- **AC-T13-04** `requestPairingCode` só pede o código após o primeiro `qr` e uma vez por socket; QR exposto como data URL PNG.
- **AC-T13-05** Duas operações concorrentes na mesma sessão (restart + logout) executam em série; transição inválida → `INVALID_TRANSITION`.
- **AC-T13-06** Sessão com proxy indisponível falha a conexão e fica `DISCONNECTED`, sem tentativa direta; sessão sem proxy conecta direto.

---

### T14 — WA: fila por sessão, antiban, warm-up e limites
**Objetivo:** envio serializado por chip com antiban e cronograma de aquecimento (fork do ai-manager).
**Paths:** `packages/wa-engine/src/{queue,antiban,warmup,safety}/**`
**Depende de:** T06, T07
**Ref:** `AI-MANAGER-MAP.md#5-filas-bullmq--ioredis` e #4; `STACK.md` C.8 (antiban 4.10.0); `ai-manager/docs/pesquisa-regras-antiban.md`.
**Entregáveis:** `MessageQueue` (fila `session:<id>`, prefixo `wsm`, `setGlobalConcurrency(1)`, 3 tentativas, estado em `messages`/`message_events`, `handleReceipt`); `AntibanAdapter` real/passthrough (preset por env, instância por sessão, warm-up interno do pacote desligado); cronograma de warm-up; `SessionLimitsService` (redução automática, nunca aumento).
**Critérios de aceitação**
- **AC-T14-01** Duas mensagens da mesma sessão nunca são processadas ao mesmo tempo, mesmo com dois processos worker (concorrência global 1).
- **AC-T14-02** `queued → processing → sent` grava `message_events`; receipts levam a `delivered` e `read`; status nunca regride.
- **AC-T14-03** Falha de envio → `retrying` até 3 tentativas com backoff; esgotadas → `failed` com o erro.
- **AC-T14-04** Receipts chamam `antiban.onDelivered`; `ANTIBAN_MODE` ausente = `real`; preset inválido → erro na inicialização.
- **AC-T14-05** O limite diário segue o cronograma a partir de `warmup_started_at`; o serviço de limites só reduz (fator 0,5 após 403) e nunca ultrapassa o cronograma.

---

### T15 — Autenticação, cadastro, perfil e senha
**Objetivo:** contas de usuário e sessões (spec 01) com empresa criada no cadastro.
**Paths:** `packages/core/src/auth/**`, `apps/api/src/routes/auth/**`, `packages/db/src/schema/crm/auth.ts`
**Depende de:** T08
**Ref:** `01-auth-conta-multiempresa.md#5-ações-e-regras-de-negócio`, `#6-endpoints-da-api`, `#3-modelo-de-dados--campos`; `13-afiliacao.md#5-ações-e-regras-de-negócio` (campo `referral_code`).
**Entregáveis:** `POST /api/auth/login|logout|register`, `GET|PUT /api/auth/profile`, `POST|DELETE /api/auth/profile/avatar`, `POST /api/auth/password-resets`, `GET|PATCH /api/auth/password-resets/:token`, `POST /api/auth/api-tokens` (owner/admin); cadastro cria a empresa "Minha empresa" com o usuário `owner`; e-mails (reset) via `Mailer` com `APP_NAME`.
**Critérios de aceitação**
- **AC-T15-01** Login correto → 200 com cookie `crm_session` httpOnly e `{ user, companies[] }`; senha errada e e-mail inexistente → 401 com a mesma mensagem; 10 falhas em 15 min → 429.
- **AC-T15-02** Cadastro (senha ≥ `PASSWORD_MIN_LENGTH` = 8 de `@crm/shared`, e confirmação) cria usuário `system_role=user`, empresa e membership `owner`; e-mail repetido (qualquer caixa) → 409; `referral_code` opcional (código do afiliado que indicou) fica gravado em `crm.user_profiles.referred_by_code` (sem unique; `users.referral_code` é o código de afiliado do próprio usuário e não é tocado) se casar `^[A-Za-z0-9_-]{1,64}$` e é ignorado caso contrário.
- **AC-T15-03** Logout revoga a sessão: o mesmo cookie depois → 401.
- **AC-T15-04** Pedido de reset responde 200 neutro para e-mail inexistente; para existente envia e-mail (MemoryMailer) com link; o token vale uma vez e expira (GET devolve `{ valid: false, reason }`).
- **AC-T15-05** `PUT /api/auth/profile` trocando e-mail sem `current_password` correto → 422 `error_code: current_password_invalid`; locale no fio e no banco é `pt-BR` | `en` | `es` (`LOCALES` de `@crm/shared`); a entrada aceita `pt_BR` como sinônimo e locale inválido é normalizado para `pt-BR`.
- **AC-T15-06** Avatar: jpeg/png/webp até 5 MB aceito; 6 MB → 413; gif → 415; DELETE zera o avatar.

---

### T16 — Realtime: SSE, fan-out e replay
**Objetivo:** canal único de eventos para o navegador (3.7), substituindo o ActionCable.
**Paths:** `packages/core/src/realtime/**`, `apps/api/src/routes/events/**`
**Depende de:** T08
**Ref:** `21-realtime-e-plataforma.md#realtime-actioncable`, `STACK.md` Bloco A (`streamSSE`) e D §6.
**Entregáveis:** `RealtimePublisher.publish(companyId, type, data, { scope?, userId? })`; `GET /api/events?company_id=` com heartbeat 20 s, filtro por empresa/permissão do tipo/`chatScope` (hook `ScopeFilter` registrável por módulo), replay por `Last-Event-ID`.
**Critérios de aceitação**
- **AC-T16-01** Usuário da empresa A não recebe evento publicado para a empresa B.
- **AC-T16-02** Evento com `scope: { connection_id, department_id }` não chega ao membro fora desse escopo e chega ao owner.
- **AC-T16-03** Reconectar com `Last-Event-ID` recebe, em ordem, os eventos publicados durante a desconexão.
- **AC-T16-04** Sem tráfego, o stream envia `ping` a cada ≤ 20 s; logout encerra o stream.
- **AC-T16-05** Com duas instâncias da API, um evento publicado por qualquer processo chega aos clientes das duas.

---

### T17 — Harness E2E (API com fakes, seed, reset)
**Objetivo:** ambiente reprodutível para os testes Playwright das tarefas de UI.
**Paths:** `apps/api/src/e2e/**`, `packages/db/src/seed/{index,base}.ts`, `scripts/e2e/**`
**Depende de:** T08, T03, T04
**Ref:** seção 3.10.
**Entregáveis:** `node scripts/e2e/serve.mjs` sobe banco descartável migrado + seed, API (`WA_GATEWAY=fake`, `AI_MODE=fake`, `MAIL_TRANSPORT=memory`, `E2E=1`) e web (`vite preview` com proxy `/api`), imprime as URLs; seed-base (platform admin, empresa "Empresa Demo", owner, admin, member com senha conhecida); rotas `/__e2e/reset`, `/__e2e/wa/emit` (injeta `WaEvent` no FakeWaGateway e no stream), `/__e2e/mail` (lista e-mails), `/__e2e/llm/script` (roteiro do FakeLlm); registro de seeds por módulo (`packages/db/src/seed/modules/*`).
**Critérios de aceitação**
- **AC-T17-01** `serve.mjs` sobe e responde `GET /health` em ≤ 60 s; ao encerrar, o banco descartável é removido.
- **AC-T17-02** Sem `E2E=1`, qualquer rota `/__e2e/*` → 404 (teste com app criado sem a flag).
- **AC-T17-03** `/__e2e/reset` restaura o seed-base em ≤ 3 s e limpa streams/filas de teste.
- **AC-T17-04** `/__e2e/wa/emit` com um `message.inbound` válido entrega o evento aos consumidores do worker (observável via `/__e2e`).
- **AC-T17-05** Seeds de módulo registrados em `seed/modules` são aplicados em ordem determinística.

---

### T19 — Fluxos: schema e repositório
**Objetivo:** persistência dos fluxos, versões publicadas e execuções.
**Paths:** `packages/core/src/flows/store/**`, `packages/db/src/schema/crm/flows.ts`
**Depende de:** T01, T10
**Ref:** `06-fluxos.md#31-flow` a `#38`, `#4-estados-e-transições` (o modelo de tabelas está nos Entregáveis abaixo).
**Entregáveis:** tabelas `flow_folders`, `flows` (status `draft|active|paused|archived`), `flow_nodes`, `flow_node_actions`, `flow_edges` (unique `(from_node_id, handle)`), `flow_versions` (definição imutável), `flow_runs` (índice único parcial: 1 run `running|waiting` por (empresa, contato)), `flow_run_steps` (`idempotency_key` único), `flow_distributor_counters`, `flow_share_codes`; repositório `FlowStore` (rascunho ↔ `FlowDefinition`, publicar versão).
**Critérios de aceitação**
- **AC-T19-01** Dois edges com o mesmo (nó de origem, handle) → violação de unicidade.
- **AC-T19-02** Um segundo run `running|waiting` para o mesmo contato na mesma empresa é rejeitado pelo banco; em empresas diferentes é aceito.
- **AC-T19-03** `FlowStore.toDefinition(flowId)` seguido de `fromDefinition` reproduz nós, ações e edges (round-trip).
- **AC-T19-04** `publish(flowId)` grava uma `flow_versions` imutável com número sequencial; editar o rascunho depois não altera a versão publicada.
- **AC-T19-05** Pasta não pode ter como pai uma descendente (checagem no repositório → `CONFLICT`).

---

### T24 — UsageGuard e provider medido
**Objetivo:** toda chamada de IA (LLM, TTS, STT) passa por reserva/commit de créditos e cota.
**Paths:** `packages/core/src/ai-metering/**`
**Depende de:** T18, T12
**Ref:** `12-cobrancas-assinaturas-tokens.md#410-códigos-de-erro-de-tokens`, `#55-tokens-leona`; `STACK.md` Bloco F §F.2 (UsageGuard, custo por tabela própria).
**Entregáveis:** `UsageGuard.reserve(companyId, estimate, feature)` (saldo − estimativa < −overrun ou cota `hard` estourada → `LlmQuotaExceededError`), `commit(usage)` idempotente por `request_id`, contador quente em Redis com reconciliação; `meter(provider)` decorando `LlmProvider`/`TtsProvider`/`SttProvider` com `feature` e `agent_id`; evento `ai_wallet.updated`/`ai_wallet.low` via `RealtimePublisher` (injetado).
**Critérios de aceitação**
- **AC-T24-01** Com cota `hard` mensal estourada, `reserve` lança `LlmQuotaExceededError` antes de chamar o provedor (FakeLlm com 0 chamadas).
- **AC-T24-02** Cota `soft` estourada permite a chamada e emite `ai_wallet.low`.
- **AC-T24-03** Cada chamada medida grava exatamente uma linha em `ai_usage` com tokens, `cost_micros`, `credits` (créditos cobrados, coluna da T18) e `feature`; `commit` repetido com o mesmo `request_id` debita uma vez.
- **AC-T24-04** Erro do provedor grava `ai_usage.status = 'error'` sem débito.
- **AC-T24-05** A reconciliação corrige divergência entre o contador Redis e o Postgres (teste com contador adulterado).

### T20 — WA: SendPipeline, deliver e health
**Objetivo:** todo envio passa pelos gates e pelo antiban; sinais anormais pausam a sessão.
**Paths:** `packages/wa-engine/src/{send,health}/**`
**Depende de:** T13, T14
**Ref:** `AI-MANAGER-MAP.md#4-pipeline-de-envio-e-antiban`, `_ref_wsm_SPEC.md` T09/T10.
**Entregáveis:** `SendPipeline` com `GATE_ORDER = auth → sessionExists → connected → contactAllowed → warmupLimit → rateLimit → enqueue`; `deliver` = `beforeSend → sleep(delay) → transport.sendMessage → afterSend`; `ConsentService` sobre `public.contacts` (`recordConsent(phone, source)`, `optOut(phone)`); Health Score (função pura) e `HealthMonitor` (403 → `PAUSED` + redução de limites; score < 70 → `DEGRADED`; < 40 → `PAUSED`; resume só manual).
**Critérios de aceitação**
- **AC-T20-01** Gates espiões provam a ordem e o curto-circuito: o primeiro que falha interrompe com o código e HTTP da tabela.
- **AC-T20-02** Contato com `opt_out = true` ou sem consentimento → `CONTACT_NOT_ALLOWED` (403); após `recordConsent(phone, 'inbound')` o envio é aceito.
- **AC-T20-03** `deliver` chama, em ordem, `beforeSend`, a espera, `sendMessage` e `afterSend`; falha → `afterSendFailed` e a mensagem segue o fluxo de retry.
- **AC-T20-04** 403 no envio → sessão `PAUSED`, fila pausada, `health_event forbidden_403` e limites × 0,5; nenhuma retomada automática.
- **AC-T20-05** Health Score: tabela de casos (falhas, desconexões, 403, taxa de resposta) produz score e rótulos `Good ≥ 70`, `Warning 40–69`, `Critical < 40`.

---

### T21 — WA: outbox de eventos, mídia e contatos
**Objetivo:** publicar tudo o que o CRM precisa no stream `wsm:events` e baixar mídia recebida.
**Paths:** `packages/wa-engine/src/{events,media,contacts}/**`
**Depende de:** T13
**Ref:** `AI-MANAGER-MAP.md#135-mudanças-aditivas-necessárias-no-ai-manager-quando-for-plugar` (A1, A2, A4, A5), `STACK.md` C.5.
**Entregáveis:** `attachEventOutbox(manager, queue, redis)` (XADD `wsm:events` MAXLEN ~100000, formato `WaEvent v1`, retry com buffer se o Redis cair); `MediaService` (download eager para áudio/imagem/documento ≤ limite, lazy acima; `reuploadRequest` em mídia expirada; grava no `BlobStore`; `MediaHandle { session_id, message_id, mime, size, sha256, key, status }`); `ContactSync` (`contacts.upsert` e `lid-mapping.update` → eventos).
**Critérios de aceitação**
- **AC-T21-01** Mensagem recebida, status, mudança de estado/conexão, QR, código de pareamento, contato e mapeamento LID↔PN geram `WaEvent` válidos no stream, na ordem de ocorrência por sessão.
- **AC-T21-02** Mídia de imagem recebida é gravada no `BlobStore` e o evento `message.inbound` traz `media.key`, `mime`, `size` e `sha256` corretos.
- **AC-T21-03** Mídia expirada (erro 410 no download) aciona `reuploadRequest` uma vez; falha definitiva publica o evento com `media.status = 'unavailable'` (o evento não é bloqueado).
- **AC-T21-04** Redis indisponível não derruba a sessão: os eventos ficam em buffer e são publicados quando o Redis volta.
- **AC-T21-05** `detach()` remove todos os listeners do transporte.

---

### T22 — Empresas, equipe, convites e permissões
**Objetivo:** gestão multiempresa (specs 01 e 16): contas, troca, saída, membros, papéis, permissões e convites.
**Paths:** `packages/core/src/{companies,team,invitations}/**`, `apps/api/src/routes/{companies,team,invitations}/**`, `packages/db/src/schema/crm/team.ts`
**Depende de:** T15
**Ref:** `01-auth-conta-multiempresa.md#5-ações-e-regras-de-negócio`, `16-configuracoes-empresa-equipe.md#34-membro` a `#36`, `#5-ações-e-regras-de-negócio`, `#8-permissões`.
**Entregáveis:** `GET|POST /api/companies`, `PUT|DELETE /api/companies/:id` (soft delete/reativar), `POST /api/companies/:id/switch|leave`; `GET /api/team`, `PATCH|DELETE /api/team/:userId`, `POST /api/team/:userId/transfer-ownership`, `GET /api/permissions/definitions`; convites unificados (`invitations` com `kind: member|platform`): criar, listar com `status_counts`, reenviar (3/dia, cooldown), cancelar, link, `GET|POST /api/invitations/:token[/accept|decline]` (público; aceitar exige login ou cria usuário no aceite); evento `member.permissions_changed`.
**Critérios de aceitação**
- **AC-T22-01** Usuário não-membro não consegue `switch` nem ler a empresa (404); `leave` do owner → 409 até transferir a propriedade.
- **AC-T22-02** Transferência de propriedade é atômica: termina com exatamente 1 `owner` e o antigo vira `admin`; só o owner pode transferir, e só para um admin existente.
- **AC-T22-03** Admin não remove nem rebaixa o owner (403); chaves de permissão inválidas → 422; chaves salvas são normalizadas (edit sem view recebe view).
- **AC-T22-04** O 4º reenvio de convite no mesmo dia → 429 com `resends_remaining_today: 0`; aceitar convite expirado → 410; aceitar cria a membership com o papel do convite; o token só existe como hash no banco.
- **AC-T22-05** Desativar a empresa bloqueia o acesso dos membros (403 em `/api/*` com `company_inactive`) e pausa as conexões via `WaGateway.sessions.pause` (FakeWaGateway); reativar libera.
- **AC-T22-06** Mudança de papel ou permissões publica `member.permissions_changed` para o usuário afetado.

---

### T23 — Web: shell, design system, i18n, guards e cliente HTTP
**Objetivo:** a casca do dashboard sobre a qual todas as telas são montadas (specs 18 e 21).
**Paths:** `apps/web/**` (depois desta tarefa, as demais tarefas de UI só escrevem nos seus Paths e nos registros compartilhados)
**Depende de:** T15, T16, T17
**Ref:** `18-shell-navegacao-tutoriais-suporte.md#24-shell-layout-e-seus-elementos` a `#28`, `#51-atalhos-de-teclado`, `#52-home-por-papel`, `#53-guarda-de-permissões-por-rota-…`, `#510-seletor-de-empresa-…`, `#23-página-404`; `21-realtime-e-plataforma.md#plataforma`; `STACK.md` Bloco D.
**Entregáveis:** Vite 8 + React 19.3 + TanStack Router (rotas por arquivo, `routeTree.gen.ts`) + Query; Tailwind 4 + shadcn (Base UI) com tokens claro/escuro; layout (sidebar 240/64 px colapsável e persistida, header, breadcrumbs, barra inferior mobile Início/Chats/Kanban/Fluxos/Mais), `nav.ts` (registro de itens com permissão), `features/settings/tabs.ts` (registro do hub `/settings?tab=`), guards (autenticado, público, permissão por prefixo com toast 1× por caminho, platform admin, support), home por papel (sem loop em `/welcome`), página 404, `lib/http.ts` (cookie, `X-Company-Id`, `X-Requested-With`, 401 → sonda única em `/api/auth/profile` → `/login?redirect=`), `lib/realtime.ts` (`useRealtime`: EventSource, reconexão em `online`/`visibilitychange`, despacho para o cache), i18n com as **três** línguas (`pt-BR`, `en`, `es`; arquivos por módulo em `src/i18n/<língua>/<módulo>.json`, carregados por glob) e script `i18n:check`, seletor de idioma no menu do usuário, tema + Ctrl/Cmd+M (ignora inputs), `APP_NAME` no título.
**Critérios de aceitação**
- **AC-T23-01** Sem sessão, qualquer rota interna redireciona para `/login?redirect=<rota>`; o redirect ignora valores com `//`, `://` ou `\`.
- **AC-T23-02** Com sessão, a sidebar mostra só os itens permitidos pelo papel do seed; acessar por URL uma rota sem permissão leva à primeira rota permitida e mostra o aviso uma vez.
- **AC-T23-03** Ctrl/Cmd+M alterna o tema fora de campos de texto e não alterna dentro de um input; a preferência persiste após recarregar.
- **AC-T23-04** No `mobile` (390 px) a barra inferior aparece, a sidebar vira drawer e nenhuma página do shell tem rolagem horizontal.
- **AC-T23-05** Rota inexistente mostra a página 404 com link para a home do papel; usuário sem permissão de dashboard não entra em loop em `/welcome`.
- **AC-T23-06** Um 401 numa chamada qualquer gera uma única sonda de perfil e redireciona ao login; o título da aba e os textos usam `APP_NAME`.
- **AC-T23-07** Trocar o idioma para `en` e para `es` muda os textos do shell e o atributo `<html lang>` sem recarregar, e a escolha persiste; `pnpm --filter @crm/web i18n:check` falha quando uma chave existe em `pt-BR` e falta em `en` ou `es` (teste com arquivo temporário).

**Notas para o Tester:** criar `tests/acceptance/playwright.config.ts` (projetos `desktop` 1366×768 e `mobile` 390×844 Chromium, `webServer` = `node scripts/e2e/serve.mjs`, `baseURL` impresso pelo harness) e `tests/acceptance/helpers/e2e.ts` (login por papel do seed, reset entre testes).

---

### T25 — Motor de fluxos: runner, registro de nós e dry-run
**Objetivo:** executar versões publicadas de fluxo de forma idempotente sobre BullMQ.
**Paths:** `packages/core/src/flows/engine/{runner,registry,context,dry-run}*`, `packages/core/src/flows/nodes/index.ts`, `apps/worker/src/jobs/flow-step/**`
**Depende de:** T19, T11, T09
**Ref:** `06-fluxos.md#42-execução`, `#55-execução-pelo-chat` (o desenho do motor está nos Entregáveis abaixo).
**Entregáveis:** run = estado em `flow_runs`; job `flow-step { runId, expectedSeq }`; `SELECT … FOR UPDATE` + `seq`; laço síncrono até nó de espera/fim com limite de **50 passos por job** (`failed: loop_guard`); `NodeHandler.execute(ctx) → { next } | { wait } | { end } | { jump }`; `ctx` com `wa` (WaGateway), `vars`, `render`, `repo`, `llm`, `log`, `idempotencyKey(actionId)` = hash(runId, seq, actionId); registro de grupos de nós em `nodes/index.ts` (stubs para os grupos das tarefas T41, T42, T51, T62, T63, T104, T111); erro → handle `failure` se existir, senão `failed`; modo dry-run com gateway fake e store em memória.
**Critérios de aceitação**
- **AC-T25-01** Um run com handlers de teste percorre start → A → B → fim, grava um `flow_run_steps` por nó e termina `completed`.
- **AC-T25-02** Grafo com ciclo sem espera termina `failed` com `loop_guard` após 50 passos.
- **AC-T25-03** Dois workers recebendo o mesmo `{runId, expectedSeq}` executam o passo uma vez (o segundo vira no-op).
- **AC-T25-04** Reprocessar o mesmo job após crash simulado não repete envios (mesma `idempotency_key` → sem novo `wa.send`).
- **AC-T25-05** Ação que lança segue o handle `failure` quando ele existe; sem ele, o run fica `failed` com o erro gravado.
- **AC-T25-06** O dry-run executa o mesmo grafo sem gravar no banco nem chamar o gateway real.

---

### T26 — Contatos, etiquetas e campos personalizados
**Objetivo:** cadastro de contatos por empresa com identidade LID/PN, etiquetas e catálogo de campos.
**Paths:** `packages/core/src/{contacts,labels,custom-fields}/**`, `apps/api/src/routes/{contacts,labels,custom-fields}/**`, `packages/db/src/schema/crm/contacts.ts`
**Depende de:** T15
**Ref:** `05-contatos.md#31-contato-customer--formulário-…`, `#32-campo-personalizado-…`, `#5-ações-e-regras-de-negócio-features`, `#6-endpoints-da-api`; `17-configuracoes-conteudo.md#3d-campo-personalizado-…`, `#3e-etiqueta-label`.
**Entregáveis:** `contacts` (`phone_e164` e `wa_lid` com unicidade parcial por empresa, nome, e-mail, UF, cidade, CEP, `custom_fields` jsonb, `consent`, `consent_source`, atribuição `ctwa_clid/source_id/source_url/ad_media_url`, `origin`), `contact_labels`, `labels` (nome 2–50, cor hex), `custom_field_defs` (chave minúscula imutável), campos de sistema somente leitura; CRUD, busca de duplicados, `mergeIdentity(lid, pn)`; `ContactsService.upsertFromWhatsApp()` usado pelo ingest; ao criar/atualizar consentimento chama `WaGateway.recordConsent`.
**Critérios de aceitação**
- **AC-T26-01** Telefone BR com 10–11 dígitos e internacionais de 8–15 são normalizados para E.164; telefone duplicado na mesma empresa → 409 com o `id` existente; em outra empresa é aceito.
- **AC-T26-02** Contato só com `wa_lid` (sem telefone) é aceito; `mergeIdentity` funde o contato LID no contato PN, preservando etiquetas, campos e o id do mais antigo.
- **AC-T26-03** Chave de campo personalizado nova gravada num contato aparece no catálogo; `PATCH /api/custom-fields/:key` só muda a descrição; chave < 2 caracteres → 422; campos de sistema não editáveis.
- **AC-T26-04** Etiqueta: nome 2–50 e cor `#RRGGBB` (senão 422); excluir remove os vínculos; listagem traz `contacts_count`.
- **AC-T26-05** Todo contato criado (manual, via API) recebe `consent = true` com `consent_source = 'manual'`, repassado ao `WaGateway.recordConsent` (FakeWaGateway registra a chamada); marcar `opt_out` chama `optOut` e bloqueia envios até ser revertido manualmente.
- **AC-T26-06** Membro sem `contacts.view` recebe 403 em `GET /api/contacts`; contato de outra empresa → 404.

---

### T27 — Jobs genéricos de exportação e importação
**Objetivo:** infraestrutura de jobs com progresso em tempo real, usada por contatos, vendas e kanban.
**Paths:** `packages/core/src/exports/**`, `apps/worker/src/jobs/exports/**`, `apps/api/src/routes/exports/**`, `packages/db/src/schema/crm/exports.ts`
**Depende de:** T09, T16
**Ref:** `05-contatos.md#35-job-de-exportação-…`, `#36-job-de-importação-…`; `02-dashboard.md#5-ações-e-regras-de-negócio-features` (export de vendas).
**Entregáveis:** tabela `background_jobs` (kind, status `queued|processing|completed|failed`, progress jsonb, counters, error, file_key, file_size, filters, created_by); filas `exports`/`imports`; registro `registerExportKind(kind, { query, columns })`; writer CSV em streaming (UTF-8 com BOM, `;` opcional); `GET /api/jobs/:id`, `GET /api/jobs?kind=&limit=3`, `GET /api/jobs/:id/file`; SSE `job.progress`.
**Critérios de aceitação**
- **AC-T27-01** Um export registrado de 10 000 linhas termina `completed` com `row_count` correto e arquivo CSV válido (cabeçalho + linhas), sem carregar tudo em memória (stream).
- **AC-T27-02** O progresso é publicado em `job.progress` ao menos a cada 10% e no fim.
- **AC-T27-03** O download só é permitido ao criador ou a quem tem a permissão do kind, na mesma empresa (outra empresa → 404).
- **AC-T27-04** Job com erro termina `failed` com mensagem e sem arquivo parcial acessível.
- **AC-T27-05** `GET /api/jobs?kind=contacts_export&limit=3` lista os 3 mais recentes da empresa.

---

### T28 — API de fluxos, pastas, nós e arestas
**Objetivo:** CRUD do editor de fluxos (autosave do rascunho, publicação de versões).
**Paths:** `apps/api/src/routes/flows/**`
**Depende de:** T19, T15
**Ref:** `06-fluxos.md#5-ações-e-regras-de-negócio` (5.1–5.4), `#6-endpoints-da-api`, `#8-permissões`.
**Entregáveis:** `GET|POST /api/flows`, `GET|PATCH|DELETE /api/flows/:id`, `GET /api/flows/:id/editor-bundle`, `GET /api/flows/names?triggerable=1`, `POST /api/flows/:id/{activate,pause,archive,unarchive,duplicate,move,reorder}`, `GET /api/flows/:id/deletion-impact`, `POST /api/flows/:id/validate`, nós/ações/arestas (`POST /api/flows/:id/connections` faz upsert por (nó, handle)), `POST /api/flows/:id/nodes/positions` (lote); pastas `GET|POST /api/flow-folders`, `PATCH|DELETE /api/flow-folders/:id`, `POST /api/flow-folders/:id/move`; permissões `flows.view|edit|delete`; evento `flow.graph_updated` (com `actor_id`).
**Critérios de aceitação**
- **AC-T28-01** `activate` com definição inválida → 422 com a lista de erros por nó; válida → status `active` e nova `flow_versions`.
- **AC-T28-02** Conectar um handle já ligado substitui a aresta anterior (upsert) e publica `flow.graph_updated`.
- **AC-T28-03** Mover pasta para dentro de uma descendente → 409; excluir pasta move os fluxos para a raiz (ou conforme `06-fluxos.md#54-excluir`).
- **AC-T28-04** `deletion-impact` conta runs ativos, configs de conexão e referências em outros fluxos; excluir fluxo referenciado por configuração de conexão → 409 com as referências.
- **AC-T28-05** Membro com só `flows.view` lê o editor-bundle e recebe 403 em qualquer mutação.
- **AC-T28-06** `duplicate` copia nós, ações e arestas com novos ids e status `draft`.

---

### T29 — App wa-worker e RPC interno
**Objetivo:** processo dono dos sockets Baileys, falando com o CRM pelo mesmo protocolo de RPC do ai-manager.
**Paths:** `apps/wa-worker/**`
**Depende de:** T20, T21
**Ref:** `AI-MANAGER-MAP.md#8-padrão-de-rotas-api-hono` (ponte API → worker) e §13.5.
**Entregáveis:** boot (migra `wa`, sobe SessionManager, MessageQueue, HealthMonitor, outbox, mídia); servidor interno Hono `POST /internal/rpc { target, method, args }` com `Bearer INTERNAL_TOKEN` e lista fechada de métodos (`sessions.*`, `messages.*`, `media.download`, `presence.update`, `contacts.recordConsent|optOut|list`, `profile.*`); erros de domínio serializados como no ai-manager; `WA_TRANSPORT=fake` habilita `/internal/fake/*` (emitir QR, abrir/fechar, receber mensagem, receipt, falhar próximo envio).
**Critérios de aceitação**
- **AC-T29-01** Sem `Bearer INTERNAL_TOKEN` válido → 401; método fora da lista (incluindo `constructor` e propriedades herdadas) → 400 `UNKNOWN_METHOD`.
- **AC-T29-02** Com `WA_TRANSPORT=fake`: criar sessão → QR → abrir conexão → `sessions.get` devolve `WARMING`, e o evento `session.state` aparece em `wsm:events`.
- **AC-T29-03** `messages.enqueue` para contato consentido percorre o pipeline até `sent` e `delivered` (receipt fake) com eventos `message.status` no stream.
- **AC-T29-04** `SendRejectedError` do pipeline volta pela RPC com o mesmo `code` e HTTP.
- **AC-T29-05** SIGTERM fecha sockets e filas e, ao subir de novo, as sessões reconectam sem perder nem duplicar mensagens enfileiradas.

---

### T30 — Motor de fluxos: timers, esperas, cancelamento e pausa
**Objetivo:** atrasos, espera de resposta com timeout e controle de runs.
**Paths:** `packages/core/src/flows/engine/{timers,waits,control}*`, `apps/worker/src/jobs/flow-timer/**`
**Depende de:** T25
**Ref:** `06-fluxos.md#45-unidades-de-tempo` (máx. 31 dias), `#55-execução-pelo-chat`, `#35-tipos-de-nó-…` (wait_response, smart_interval).
**Entregáveis:** `wait { kind: 'timer'|'reply', handles, deadline_at }`; job delayed `flow-timer` com `jobId = run:<id>:seq:<n>`; `resolveReply(runId, inbound)`; `cancel(runId)` (remove timer), `pauseFlow(flowId)` (runs `waiting` congelam; timers reagendam no resume), atrasos curtos (≤ 5 s) em processo.
**Critérios de aceitação**
- **AC-T30-01** Espera de resposta com timeout: chegando a resposta antes, segue o handle de resposta; sem resposta, o timer segue `timeout`. Resposta e timer simultâneos → só um avança (teste de corrida).
- **AC-T30-02** Atraso de 2 dias agenda um job delayed com o `jobId` determinístico; reagendar o mesmo passo não cria job duplicado.
- **AC-T30-03** `cancel` deixa o run `cancelled`, remove o timer e o timer antigo, se disparar, vira no-op.
- **AC-T30-04** Pausar o fluxo congela runs em espera (o timer vencido não avança) e retomar reagenda a partir do restante do prazo.
- **AC-T30-05** Prazo acima de 31 dias → erro de validação na definição.

---

### T31 — Departamentos e horários de atendimento
**Objetivo:** departamentos (escopo de chat e transferência) e horários por conexão.
**Paths:** `packages/core/src/{departments,business-hours}/**`, `apps/api/src/routes/{departments,business-hours}/**`, `packages/db/src/schema/crm/departments.ts`
**Depende de:** T22
**Ref:** `16-configuracoes-empresa-equipe.md#32-departamento`, `#33-horário`, `#5-ações-e-regras-de-negócio`.
**Entregáveis:** `departments` (nome, cor hex, padrão `#3B82F6`), `member_departments`, `member_connections`; `GET /api/departments?page&search`, `GET /api/departments/all`, CRUD; `business_hour_configs` (por `connection_id`, ação `message|flow`) + intervalos; `PUT /api/business-hours/:connectionId` transacional; função pura `isOpen(config, now, timeZone)`; `chatScopeFor(member)` exportado para chats/realtime.
**Critérios de aceitação**
- **AC-T31-01** Departamentos paginados (20) com busca; cor fora de hex → 422; excluir remove os vínculos dos membros.
- **AC-T31-02** `isOpen` com vários intervalos no dia, no fuso da empresa (teste com `America/Manaus` e `America/Sao_Paulo`), trata o minuto final como fechado (`[início, fim)`).
- **AC-T31-03** Config ativa com ação `message` sem texto, ou `flow` sem fluxo → 422; `PUT` substitui config e intervalos numa transação.
- **AC-T31-04** `chatScopeFor`: membro com departamentos/conexões devolve só esses; sem seleção devolve "todos"; owner/admin sempre "todos".

---

### T32 — Acesso de suporte
**Objetivo:** usuário `support` pede acesso a uma empresa; owner/admin aprova uma concessão temporária.
**Paths:** `packages/core/src/support-access/**`, `apps/api/src/routes/support-access/**`, `packages/db/src/schema/crm/support-access.ts`
**Depende de:** T22, T16
**Ref:** `01-auth-conta-multiempresa.md` (suporte), `16-configuracoes-empresa-equipe.md#37-suporte`.
**Entregáveis:** pedidos (lookup por e-mail do owner/admin, criar, reenviar, cancelar), aprovar/rejeitar (owner/admin), concessão de 12 h com escopo só `flows.*` e `settings.mcp.*`, revogação; middleware que deixa o `support` agir na empresa só com concessão ativa; eventos `support_access.requested|granted|revoked|cancelled`.
**Critérios de aceitação**
- **AC-T32-01** Só owner/admin aprova (member → 403); aprovar cria concessão que expira em 12 h.
- **AC-T32-02** Com concessão ativa, o `support` lê e edita fluxos da empresa; fora do escopo (ex.: contatos) → 403; concessão expirada ou revogada → 403.
- **AC-T32-03** Pedir, aprovar e revogar publicam os eventos na empresa e para o usuário `support`.
- **AC-T32-04** Usuário que não é `support` não consegue criar pedido (403).

---

### T33 — Chats: modelo e ingestão de eventos WhatsApp
**Objetivo:** transformar `WaEvent` em contatos, chats e mensagens do CRM.
**Paths:** `packages/core/src/chats/{model,ingest}/**`, `apps/worker/src/consumers/chats/**`, `packages/db/src/schema/crm/chats.ts`
**Depende de:** T26, T09, T16
**Ref:** `03-chats.md#ciclo-de-vida-do-chat-f15f22`, `#mensagens--leitura-f23f30`, `#realtime--chatschannel-account_id`, `#compatibilidade-baileys-clone`.
**Entregáveis:** `chats` (empresa, `connection_id`, contato, status `waiting|attending|resolved`, responsável, departamento, `ai_agent_id`, não lidas, prévia, `last_inbound_at`, `opened_at`, `first_human_reply_at/by`, `resolved_at`, bloqueado; único por (empresa, conexão, contato)), `messages` (direção, `sender_type contact|user|bot|ai|system`, tipo, corpo, mídia, citada, status, `wa_message_id`, chave Baileys, apagada), `message_reactions`, `chat_notes`, `chat_labels`, `chat_events`; handlers de `message.inbound`, `message.status`, `contact.upsert`, `contact.lid_mapping`; registra consentimento `inbound`; eventos `message.created`, `message.status`, `chat.created`, `chat.updated`, `contact.updated`, e `crm.inbound` interno para fluxos/agentes.
**Critérios de aceitação**
- **AC-T33-01** O mesmo `message.inbound` entregue duas vezes gera uma única mensagem e um único incremento de não lidas.
- **AC-T33-02** Primeira mensagem de um número desconhecido cria contato (com consentimento `inbound` repassado ao gateway), chat `waiting` e publica `chat.created` e `message.created`.
- **AC-T33-03** Mensagem nova num chat `resolved` reabre para `waiting`; mensagem com `historical: true` é gravada sem alterar status, não lidas nem disparar `crm.inbound`.
- **AC-T33-04** `message.status` nunca regride (`read` não volta a `delivered`); `contact.lid_mapping` funde contato e chats sem duplicar.
- **AC-T33-05** Mensagens de grupo (`@g.us`) e de status (`status@broadcast`) são ignoradas pelo ingest.
- **AC-T33-06** Dados de anúncio (`ad`) da primeira mensagem preenchem a atribuição do contato; mensagens seguintes não sobrescrevem.
- **AC-T33-07** Mensagem recebida cujo texto normalizado é uma palavra de opt-out (`SAIR`, `PARAR`, `STOP`, `CANCELAR`; lista configurável por empresa) marca `opt_out = true` no contato, chama `WaGateway.optOut` e grava auditoria; reverter só por ação manual com novo consentimento.

---

### T34 — Vendas, produtos, despesas e grupos de filtro
**Objetivo:** dados de vendas que alimentam dashboard, marcos, Meta e fontes de venda.
**Paths:** `packages/core/src/{sales,products}/**`, `apps/api/src/routes/{sales,products}/**`, `packages/db/src/schema/crm/sales.ts`
**Depende de:** T26
**Ref:** `02-dashboard.md#35-regra-de-despesa-expense_rule`, `#36-grupo-de-filtros-…`, `#37-venda-sale`; `19-integracoes.md#35-product-…`, `#57-produtos`.
**Entregáveis:** `products` (public_id, nome 2–255, moeda ISO, `price_min/max/fallback`), `sales` (contato, conexão, produto, `amount_cents`, moeda, `sold_at`, `source manual|flow|webhook`, `source_id` de anúncio, `external_id`, status `approved|refunded|chargeback|pending`, unique (empresa, origem, external_id)), `expense_rules` (fixa/percentual, base, período, vigência), `dashboard_filter_groups`; `SalesService.record()` único para manual/fluxo/webhook com evento `sale.recorded`; CRUD e listagem com filtros; permissões `dashboard.sales` (+ `sales.edit`).
**Critérios de aceitação**
- **AC-T34-01** `record` com o mesmo (origem, `external_id`) duas vezes cria 1 venda e atualiza o status; `sale.recorded` é emitido uma vez por venda criada.
- **AC-T34-02** Produto com `price_max < price_min` ou `fallback ≤ 0` → 422; `resolvePrice(product, amount)` usa o fallback fora da faixa.
- **AC-T34-03** Regra de despesa percentual sem `percent_base` → 422; nome de grupo de filtro repetido (sem diferenciar caixa) → 409.
- **AC-T34-04** `GET /api/sales` filtra por período (no fuso da empresa), conexão, produto e status, com paginação infinita de 20.
- **AC-T34-05** Venda de contato com `source_id` herda a atribuição do contato.

---

### T35 — Conteúdo: respostas rápidas, modelos, variáveis globais, figurinhas
**Objetivo:** conteúdo reutilizável (spec 17) no lugar dos templates WABA.
**Paths:** `packages/core/src/content/**`, `apps/api/src/routes/content/**`, `packages/db/src/schema/crm/content.ts`
**Depende de:** T26, T11
**Ref:** `17-configuracoes-conteudo.md#3a-resposta-rápida-quick_reply`, `#3b-template-whatsapp-…` (adaptado), `#3c-variável-global-…`, `#5-ações-e-regras-de-negócio`, `#compatibilidade-baileys-clone`; `03-chats.md#produtividade-f48f51`.
**Entregáveis:** `quick_replies` (atalho normalizado `[a-z0-9_ -]`, único por empresa) + ações ordenadas (`send_message|send_multi_media|send_sticker|send_contact`); `message_templates` (modelo **interno**: cabeçalho texto/mídia, corpo com `{var}`, rodapé, botões renderizados como menu numerado/links no texto; sem status Meta); `global_variables` (`g_` + `[A-Za-z0-9_]`, tipo `text|number`, nome imutável); `stickers` (+ favoritas por usuário); `POST /api/content/render { template, contact_id }` (prévia).
**Critérios de aceitação**
- **AC-T35-01** Atalho "Boas Vindas!" é normalizado para `boas vindas` (ou rejeitado conforme 17#3a) e duplicado na empresa → 409.
- **AC-T35-02** Variável global numérica com valor "abc" → 422; renomear variável → 422 (imutável).
- **AC-T35-03** Modelo com botões é renderizado como texto com menu numerado e links no corpo; a prévia substitui variáveis do contato.
- **AC-T35-04** Membro com `settings.quick_replies.edit` (exceção da matriz) edita respostas rápidas; sem a chave → 403.
- **AC-T35-05** Figurinha: só `image/webp` aceita (outros → 415, ou convertidos com sharp, conforme decisão registrada em `docs/`); favoritas são por usuário.

---

### T36 — UI: autenticação, perfil e troca de empresa
**Objetivo:** telas públicas, perfil, aceite de convite e seletor de empresa.
**Paths:** `apps/web/src/{routes,features}/{auth,profile}/**`, `apps/web/src/features/company-switcher/**`, i18n `auth`/`profile`
**Depende de:** T22, T23
**Ref:** `01-auth-conta-multiempresa.md#2-telas-e-rotas`, `18-shell-navegacao-tutoriais-suporte.md#510-seletor-de-empresa-…`.
**Entregáveis:** `/login`, `/register` (alias `/cadastro`, lê `?ref`/`?via`), `/forgot-password`, `/reset-password?token=`, `/invitation/:token`, `/welcome` mínimo, `/profile` (abas pessoal, segurança com medidor de força, preferências tema/idioma), seletor de empresa no header (busca com debounce 300 ms, páginas de 20, "Carregar mais", criar empresa).
**Critérios de aceitação**
- **AC-T36-01** Login com credenciais do seed leva à home do papel; credencial errada mostra erro na tela sem limpar o e-mail.
- **AC-T36-02** Cadastro com senhas diferentes não envia o formulário; cadastro válido redireciona para `/login` com o e-mail preenchido.
- **AC-T36-03** Reset com token expirado mostra o estado "link inválido ou expirado"; token válido troca a senha e redireciona.
- **AC-T36-04** Trocar de empresa no seletor atualiza o nome no header, invalida os dados carregados (lista recarrega com dados da nova empresa) e reabre o SSE.
- **AC-T36-05** Convite aberto sem login leva ao login com retorno ao convite; aceitar mostra a empresa nova no seletor.
- **AC-T36-06** Todas as telas desta tarefa funcionam no projeto `mobile` sem rolagem horizontal.
- **AC-T36-07** Em `/profile` → Preferências, escolher `en` ou `es` salva o `locale` no servidor e as telas passam a usar a língua escolhida também após novo login.

---

### T37 — API de consumo de IA (empresa e plataforma)
**Objetivo:** expor carteira, extrato, cotas e a administração de créditos pela plataforma.
**Paths:** `apps/api/src/routes/{ai-usage,platform-ai}/**`
**Depende de:** T24, T22
**Ref:** `12-cobrancas-assinaturas-tokens.md#62-tokens--…`, `#64-admin-referência`, `#56-admin-referência`.
**Entregáveis:** empresa (`ai_usage.view`): `GET /api/ai/wallet`, `GET /api/ai/usage`, `GET /api/ai/usage/summary?group_by=day|feature|model|agent`, `GET /api/ai/quotas`; plataforma (`platform_admin`): `POST /api/platform/companies/:id/ai/topups|adjustments`, `POST /api/platform/ai/usage/:id/refund`, `GET|PUT /api/platform/companies/:id/ai/quotas`, `PATCH /api/platform/companies/:id/ai/wallet`, `GET|POST|PATCH /api/platform/ai/prices`, `GET|PATCH /api/platform/ai/pricing-settings`, `GET /api/platform/ai/usage`, `GET /api/platform/ai/wallets?negative=1`.
**Critérios de aceitação**
- **AC-T37-01** Recarga pelo admin da plataforma exige nota, gera entrada `topup` com `actor_user_id` e publica `ai_wallet.updated` na empresa.
- **AC-T37-02** Usuário sem `platform_admin` → 403 em qualquer `/api/platform/*`; sem `ai_usage.view` → 403 em `/api/ai/*`.
- **AC-T37-03** Preço novo com vigência futura não altera o custo de usos anteriores; listagem de preços mostra o histórico.
- **AC-T37-04** O extrato pagina de forma estável e o summary agrupa corretamente por dia (fuso da empresa), feature e modelo (fixture conhecida).

---

### T38 — Chaves de provedores de IA (BYOK)
**Objetivo:** empresa cadastra as próprias chaves (Anthropic, OpenAI, Google, ElevenLabs, Groq).
**Paths:** `packages/core/src/ai-keys/**`, `apps/api/src/routes/ai-keys/**`, `packages/db/src/schema/crm/ai-keys.ts`
**Depende de:** T12, T22
**Ref:** `07-agentes-ia.md#38-aiintegration-integrationsai`, `19-integracoes.md#33-ai_integration-…`, `#56-ia`.
**Entregáveis:** `ai_provider_keys` (provedores `anthropic|openai|google|openrouter|elevenlabs|groq`; provedor fixo após criar, nome, segredo cifrado, dica `…abcd`); CRUD; `POST /api/ai-keys/:id/test`; `GET /api/ai-keys/:id/models` e `/voices` (ElevenLabs); `resolveCredentials(companyId, provider)` (chave da empresa, senão chave da plataforma por env); permissão `settings.integrations.*`.
**Critérios de aceitação**
- **AC-T38-01** O segredo nunca aparece em resposta da API nem no log (teste capturando o output do pino); a listagem mostra só `configured` e a dica.
- **AC-T38-02** `PATCH` com segredo vazio mantém o segredo atual; trocar o provedor → 422.
- **AC-T38-03** `test` usa o provedor injetado (fake) e devolve `{ ok, latency_ms, error? }` com erro sem a chave.
- **AC-T38-04** Excluir chave usada por agente → 409 com a lista de agentes.
- **AC-T38-05** `resolveCredentials` prefere a chave da empresa e cai para a da plataforma; sem nenhuma → erro tipado.
- **AC-T38-06** Chave `openrouter`: `GET /api/ai-keys/:id/models` devolve a lista de modelos da OpenRouter (fetch mockado) no formato `fornecedor/modelo`, usada pelos seletores de modelo de agentes e do nó de IA.

---

### T39 — Agentes de IA: schema e CRUD
**Objetivo:** cadastro e configuração dos agentes (spec 07), com modelo por agente.
**Paths:** `packages/core/src/ai-agents/**`, `apps/api/src/routes/ai-agents/**`, `packages/db/src/schema/crm/ai-agents.ts`
**Depende de:** T22, T26
**Ref:** `07-agentes-ia.md#31-aiagent`, `#32-agentsettings`, `#33-agentskill-habilidade`, `#35-collectionfield-…`, `#36-media-enviável`, `#4-estados-e-transições`, `#5-ações-e-regras-de-negócio`, `#6-endpoints-da-api`.
**Entregáveis:** `ai_agents` (status `draft|active|paused`, objetivo, persona, regras, prompt gerado/editado, blocos travados, `model: LlmModelRef`, preset `economy|balanced|advanced` resolvido por empresa), `ai_agent_settings` (zod com defaults de 07#3.2: buffer, divisão, áudio, entender áudio/imagem/comprovante, assinar nome, horário, pausar com humano, limite de travamento, ação sem saldo), `ai_agent_skills`, `ai_collection_fields` (5 padrão), `ai_agent_media` (≤ 8 arquivos, 8 MB); `GET|POST /api/ai-agents`, `GET|PATCH|DELETE /api/ai-agents/:id`, `POST /:id/{duplicate,publish,pause}`, avatar e mídia; limite opcional de agentes por empresa (ilimitado por padrão); permissões `flows.view|edit` (07#8).
**Critérios de aceitação**
- **AC-T39-01** Criar agente sem settings aplica os defaults de 07#3.2; settings inválidas → 422 com o campo.
- **AC-T39-02** `publish` de agente sem prompt ou sem modelo → 422; publicado → `active`; `pause` → `paused`; transições inválidas → 409.
- **AC-T39-03** Sem limite definido (padrão), a empresa cria quantos agentes quiser; com limite definido pelo admin da plataforma e atingido, criar/duplicar → 409 `LIMIT_REACHED`.
- **AC-T39-04** `duplicate` copia settings, habilidades e campos de coleta, com status `draft`.
- **AC-T39-05** Excluir agente vinculado a fluxo ou chat ativo devolve 409 com as referências, a menos que `force=1`.
- **AC-T39-06** Modelo de provedor sem chave configurada (empresa nem plataforma) → 422 `provider_not_configured`.

---

### T40 — Conexões: API, QR, pareamento, proxy e perfil
**Objetivo:** conexões WhatsApp da empresa (spec 08) sobre o `WaGateway`.
**Paths:** `packages/core/src/connections/**`, `apps/api/src/routes/connections/**`, `packages/db/src/schema/crm/connections.ts`
**Depende de:** T22, T03
**Ref:** `08-conexoes.md#31-connection`, `#32-perfil-whatsapp`, `#5-ações-e-regras-de-negócio`, `#6-endpoints-da-api`, `#compatibilidade-baileys-clone`.
**Entregáveis:** `crm.connections` 1:1 com a sessão (`session_id`, empresa, nome 2–100, `disconnected_at`, notificar envios pelo celular, mensagens temporárias, salvar contatos, agendada para exclusão); status de UI derivado (`pending|connecting|connected|paused|disconnected|banned`, com badges de aquecimento/saúde); `GET /api/connections` (busca, status, `status_counts`), `POST`, `GET|PUT /:id`, `POST /:id/{connect,disconnect,restart,schedule-deletion}`, `GET /:id/qr`, `POST /:id/pairing-code` (`^[1-9]\d{6,14}$`), `POST|DELETE /:id/proxy`, `POST /:id/instance-settings`, `GET|PATCH /:id/whatsapp-profile` (só se `capabilities.businessProfile`); limite opcional de conexões por empresa (ilimitado por padrão); permissões `connections.view|edit|delete`.
**Critérios de aceitação**
- **AC-T40-01** Criar conexão cria a sessão no gateway (FakeWaGateway) e o vínculo `crm.connections`; sem limite definido não há teto; com limite definido pelo admin e atingido → 409 `LIMIT_REACHED`.
- **AC-T40-02** `GET /:id/qr` devolve o QR mais recente do gateway; `pairing-code` com número inválido → 422 e válido → código.
- **AC-T40-03** O status de UI segue o mapeamento (ex.: `STABLE` + aberto → `connected` com badge; `PAUSED` → `paused`; `loggedOut` → `disconnected`; `forbidden` → `banned`).
- **AC-T40-04** Proxy com senha: a resposta mostra só host, porta, usuário e `has_password`; alterar o proxy marca "requer reinício".
- **AC-T40-05** Conexão de outra empresa → 404; membro sem `connections.edit` → 403 em `connect`/`restart`.

---

### T41 — Nós de lógica (condição, distribuidor, conexão de fluxo, intervalo)
**Paths:** `packages/core/src/flows/nodes/logic/**`
**Depende de:** T25
**Ref:** `06-fluxos.md#35-tipos-de-nó-…` (condition, distributor, connection_flow, smart_interval), `#36-tipos-de-ação-…`.
**Critérios de aceitação**
- **AC-T41-01** `condition` com regras `all`/`any` sobre etiqueta, dia da semana, hora, data, status de atendimento, atendente, campo, campo personalizado e variável global (operadores numéricos aceitam vírgula decimal) segue o handle certo; `message_window` é sempre verdadeiro.
- **AC-T41-02** `distributor` respeita as quantidades configuradas, com a opção "evitar repetição" por contato, e publica `flow.distributor_updated`.
- **AC-T41-03** `connection_flow` encerra o run atual e cria um run no fluxo de destino (que precisa estar ativo, senão `failure`).
- **AC-T41-04** `smart_interval` (por hora, data e semanal) calcula o próximo instante correto no fuso da empresa, inclusive na virada de dia e de semana.

---

### T42 — Nós externos (HTTP e IA)
**Paths:** `packages/core/src/flows/nodes/external/**`
**Depende de:** T25, T24
**Ref:** `06-fluxos.md#35-tipos-de-nó-…` (integration, ai), `#36-tipos-de-ação-…` (make_http_request, ai_call).
**Critérios de aceitação**
- **AC-T42-01** `make_http_request` aplica timeout, método, headers e corpo com variáveis, e mapeia `response.*` para variáveis; resposta não 2xx segue `failure`.
- **AC-T42-02** Proteção SSRF: destinos `127.0.0.1`, `localhost`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` e `::1` (inclusive via redirect ou DNS) são bloqueados.
- **AC-T42-03** `ai_call` com saídas condicionais usa structured output (`FakeLlm`) e segue `output:<chave>`; resposta inválida usa a saída padrão; erro → `failure` com `ai.fail.reason`.
- **AC-T42-04** Toda chamada de IA do nó passa pelo provider medido (linha em `ai_usage` com `feature = 'flow_ai'`); cota esgotada → `failure` com motivo `quota_exceeded`.

---

### T43 — API de execuções, compartilhar, importar e exportar
**Paths:** `apps/api/src/routes/{flow-runs,flow-share}/**`
**Depende de:** T25, T28
**Ref:** `06-fluxos.md#5-ações-e-regras-de-negócio` (5.3 copiar/colar, 5.5 execução pelo chat), `#6-endpoints-da-api`.
**Entregáveis:** `POST /api/flows/:id/trigger { chat_id }`, `GET /api/flows/:id/runs`, `GET /api/flow-runs/:id` (+ passos), `POST /api/flow-runs/:id/cancel`, `GET /api/chats/:id/flow-runs`, `POST /api/connections/:id/cancel-all-flow-runs { confirmation_name }`; `GET /api/flows/:id/share-code`, `POST /api/flows/import { codes[] }`, `GET /api/flows/:id/export`, `POST /api/flows/import-json`, `POST /api/flows/:id/paste-nodes`; permissão `flows.run` (nova) para disparar/cancelar; eventos `flow_run.created|updated|cancelled`.
**Critérios de aceitação**
- **AC-T43-01** Disparo manual cria run no fluxo ativo e cancela o run ativo anterior do contato; fluxo inativo → 409.
- **AC-T43-02** Share-code importado em outra empresa recria o fluxo com etiquetas criadas por nome e mídias copiadas; referências a fluxos inexistentes viram aviso.
- **AC-T43-03** Export → import JSON reproduz o grafo (exceto ids) e o import valida com `validate`.
- **AC-T43-04** `cancel-all-flow-runs` exige o nome exato da conexão (senão 422) e cancela só os runs daquela conexão.
- **AC-T43-05** Colar nós de outro fluxo da mesma empresa clona nós e arestas internas com deslocamento de posição.

---

### T44 — UI fluxos: lista e pastas
**Paths:** `apps/web/src/{routes,features}/flows/**`, i18n `flows`
**Depende de:** T28, T23
**Ref:** `06-fluxos.md#21-lista-de-fluxos-flows`, `#23-telas-auxiliares-modais`, `#51-lista`.
**Critérios de aceitação**
- **AC-T44-01** `/flows` lista cards e tabela, com busca, filtro de status e árvore de pastas com breadcrumb; pasta na URL (`?folder=`).
- **AC-T44-02** Arrastar um fluxo para outra pasta e reordenar persistem após recarregar; arrastar pasta para dentro de uma descendente é bloqueado.
- **AC-T44-03** Excluir mostra o impacto (runs, configs, referências) e exige confirmação; compartilhar mostra o código copiável; importar aceita vários códigos.
- **AC-T44-04** Estado vazio mostra "Criar primeiro fluxo"; usuário sem `flows.edit` não vê ações de edição.
- **AC-T44-05** No `mobile`, a lista vira cartões e a árvore de pastas fica num sheet, sem rolagem horizontal.

---

### T45 — UI fluxos: canvas do editor
**Paths:** `apps/web/src/features/flow-editor/{canvas,palette,properties}/**`, `apps/web/src/features/flow-editor/index.ts*`
**Depende de:** T28, T23
**Ref:** `06-fluxos.md#22-editor-flowsidedit`, `#52-persistência`, `#53-copiar-colar`, `#54-excluir`; `STACK.md` D §4 (@xyflow/react 12.12).
**Entregáveis:** rota `/flows/$id/edit` e `/flows/$id` (somente leitura); canvas @xyflow/react (zoom 0,02–2, minimapa, controles), nós customizados por tipo com handles dinâmicos, paleta com busca e arrastar, painel de propriedades, autosave ("Salvo às HH:MM"), copiar/colar (Ctrl+C/V), excluir com confirmação, badges de erro de validação por nó, ativar/pausar; aplica `flow.graph_updated` de outros usuários; registro de editores de nó (`node-editors/registry.ts`) preenchido por T56/T57.
**Critérios de aceitação**
- **AC-T45-01** Arrastar um nó da paleta cria o nó (id gerado no cliente) e o autosave mostra "Salvo às"; recarregar mantém o nó na mesma posição.
- **AC-T45-02** Ligar um handle já ligado substitui a aresta anterior.
- **AC-T45-03** Ctrl+C/Ctrl+V duplica os nós selecionados com deslocamento; Delete pede confirmação.
- **AC-T45-04** Ativar fluxo inválido marca os nós com erro e lista os problemas; válido mostra status "Ativo".
- **AC-T45-05** Sem `flows.edit`, o editor abre só em leitura (sem paleta e sem arrastar); uma mudança feita por outro usuário (evento SSE) aparece sem recarregar.

---

### T67 — Contatos: importação CSV e do WhatsApp
**Paths:** `packages/core/src/contacts-import/**`, `apps/api/src/routes/contacts-import/**`, `apps/worker/src/jobs/contacts-import/**`
**Depende de:** T26, T27
**Ref:** `05-contatos.md#36-job-de-importação-…`, `#5-ações-e-regras-de-negócio-features`, `#9-integrações-externas`.
**Entregáveis:** `POST /api/contacts/imports` (multipart CSV, modo upsert, criar etiquetas ausentes, etiquetas padrão, coluna opcional de opt-out), `GET /api/contacts/imports/:id`, `GET /api/contacts/import-template.csv`; parse em streaming (papaparse no servidor, `NODE_STREAM_INPUT`, detecção de `;`/`,` e de Windows-1252); `POST /api/contacts/import-from-whatsapp { connection_id }` via `WaGateway.listContacts`; progresso por `job.progress`.
**Critérios de aceitação**
- **AC-T67-01** Linha sem telefone válido entra no relatório como "Linha N: telefone inválido" e as demais são importadas; o relatório agrupa erros iguais.
- **AC-T67-02** Reimportar o mesmo arquivo atualiza (contagem `updated`) em vez de duplicar.
- **AC-T67-03** Etiqueta inexistente é criada só com a opção ligada; etiquetas do CSV têm prioridade sobre as padrão.
- **AC-T67-04** CSV em Windows-1252 com `;` é lido com acentos corretos.
- **AC-T67-05** Importar do WhatsApp exige conexão conectada (senão 409); contatos só com LID entram sem telefone; o resultado traz `imported/updated/skipped`.
- **AC-T67-06** Todo contato importado (CSV ou WhatsApp) recebe `consent = true` com `consent_source = 'import'`, repassado ao `WaGateway.recordConsent`; uma coluna `opt_out` verdadeira no CSV importa o contato já com opt-out.

---

### T72 — Webhooks de entrada: CRUD e recepção pública
**Paths:** `packages/core/src/inbound-webhooks/**`, `apps/api/src/routes/{inbound-webhooks,hooks}/**`, `packages/db/src/schema/crm/inbound-webhooks.ts`
**Depende de:** T26
**Ref:** `09-webhooks-entrada.md#31-inboundwebhook`, `#32-webhookconfig`, `#33-inboundwebhookrequest-histórico`, `#5-ações-e-regras-de-negócio`, `#6-endpoints-da-api`.
**Entregáveis:** `inbound_webhooks` (token público ≥ 32 bytes, config zod de 09#3.2, contagem mensal, limite por empresa), `inbound_webhook_requests` (status, corpo truncado + flag, hash, passos, erro; retenção 1 000 por webhook); CRUD (`webhooks.view|edit|delete`); público `POST /api/hooks/in/:token` (limite de corpo 256 KB, rate limit por token, responde 202 e enfileira `inbound-webhooks`).
**Critérios de aceitação**
- **AC-T72-01** Token inexistente → 404; webhook inativo → 202 e request gravado como `skipped` (`webhook_inactive`).
- **AC-T72-02** Corpo acima do limite é truncado com a flag e o request ainda é registrado; acima do rate limit → 429.
- **AC-T72-03** Request válido → 202 em ≤ 200 ms (sem processar inline) e job enfileirado com o id do request.
- **AC-T72-04** Retenção: o 1 001º request remove o mais antigo do webhook.

---

### T99 — Meta: cliente Graph, OAuth, perfis e contas de anúncio
**Objetivo:** integração Meta Marketing API (spec 11) sem WABA, testada contra servidor fake.
**Paths:** `packages/core/src/meta-ads/{client,profiles}/**`, `apps/api/src/routes/{meta-oauth,meta-profiles}/**`, `packages/db/src/schema/crm/meta-ads.ts`
**Depende de:** T22
**Ref:** `11-facebook-ads.md#23-perfis-e-contas-facebookprofiles`, `#31-meta_profile-…`, `#32-meta_ad_account`, `#51-perfis-e-contas`, `#6-endpoints-da-api`, `#8-permissões`; `STACK.md` Bloco E §1 (Graph v26.0, BUC, System User).
**Entregáveis:** `GraphClient` (`fetch` injetável, `META_GRAPH_URL`, `appsecret_proof` em toda chamada, paginação por `paging.next`, mapeamento de erros); OAuth (`POST /api/meta/oauth/start` → URL com `state` assinado empresa+usuário; `GET /api/meta/oauth/callback` → redirect `/facebook/profiles?meta_oauth=success|error`); `meta_profiles` (token longo cifrado, expiração), `meta_ad_accounts` (`included_in_dashboard`); `GET|DELETE /api/meta/profiles[/:id]`, `POST /:id/refresh-ad-accounts`, `PUT /api/meta/ad-accounts/:id`; `FakeMetaGraph` (servidor HTTP local) em `packages/core/src/meta-ads/client/testing/`; permissões `facebook.campaigns|pixel|profiles`.
**Critérios de aceitação**
- **AC-T99-01** `GraphClient.getAll` segue `paging.next` e junta 3 páginas do fake numa lista; toda requisição leva `appsecret_proof = HMAC-SHA256(token, secret)` e a versão configurada.
- **AC-T99-02** Callback com `state` inválido ou de outra empresa redireciona com `meta_oauth=error` e não cria perfil.
- **AC-T99-03** `refresh-ad-accounts` faz upsert das contas sem mudar `included_in_dashboard` das existentes.
- **AC-T99-04** Nenhuma resposta de `/api/meta/profiles` contém o token (snapshot do JSON).
- **AC-T99-05** Membro sem `facebook.profiles` (ou não owner/admin) → 403 em PUT/DELETE/refresh.

### T46 — @crm/wa-gateway-rpc: adapter WaGateway por RPC + stream
**Objetivo:** a implementação de produção do `WaGateway`, igual para o wa-worker próprio e para o ai-manager.
**Paths:** `packages/wa-gateway-rpc/**`
**Depende de:** T29
**Ref:** `AI-MANAGER-MAP.md#13-proposta-de-fronteira-de-extensão`, `ai-manager/apps/api/src/bridge/client.ts` (padrão do cliente).
**Entregáveis:** `createRpcGateway({ url, token, profile, redis })`: comandos via `POST /internal/rpc`, erros re-hidratados (`SendRejectedError` etc.), timeout configurável (60 s para pareamento), `WorkerUnavailableError`; `profiles.ts` (mapa método do `WaGateway` → `target.method`) com o perfil `crm` completo; capacidades consultadas no worker; suíte de contrato do T03 executada contra o wa-worker com `WA_TRANSPORT=fake`.
**Critérios de aceitação**
- **AC-T46-01** A suíte de contrato de `@crm/wa-port` passa contra o wa-worker real (transporte fake) usando o gateway RPC.
- **AC-T46-02** Rejeição do pipeline volta como `SendRejectedError` com o mesmo `code` e `status`.
- **AC-T46-03** Worker fora do ar → `WorkerUnavailableError` em ≤ timeout, sem exceção não tratada.
- **AC-T46-04** Método sem mapeamento no perfil (capacidade ausente) lança `CapabilityNotSupportedError` sem chamar a rede.

---

### T47 — Conexões: projeção de status, eventos e alertas
**Paths:** `packages/core/src/connections-status/**`, `apps/worker/src/consumers/connections/**`
**Depende de:** T40, T09, T16
**Ref:** `08-conexoes.md#4-estados-e-transições`, `#7-eventos-realtime`, `01-auth-conta-multiempresa.md#compatibilidade-baileys-clone` (e-mail de desconexão), `21-realtime-e-plataforma.md#realtime-actioncable` (ConnectionsChannel).
**Entregáveis:** handlers de `session.state`, `session.connection`, `session.qr`, `session.pairing_code` → atualizam `crm.connections` e publicam os eventos SSE `connection.created|updated|deleted|status_changed|qr_updated|pairing_code|connected|disconnected|disconnected_alert|banned_alert|reconnected_with_paused_flows|health_degraded` e `flow.auto_paused|resumed`; ao cair: pausa runs de fluxo daquela conexão; ao voltar com runs pausados: evento com contagens; e-mail de desconexão para owner/admin (se `connection_status_emails_enabled`), com dedupe.
**Critérios de aceitação**
- **AC-T47-01** `session.connection close` (transient) → `connection.disconnected` + `disconnected_at`; alerta `connection.disconnected_alert` deduplicado em 5 s.
- **AC-T47-02** `close` com `forbidden` → status `banned` + `connection.banned_alert`; `loggedOut` → `disconnected`.
- **AC-T47-03** Queda pausa os runs `waiting` da conexão (`flow.auto_paused`); reconexão publica `connection.reconnected_with_paused_flows` com a contagem.
- **AC-T47-04** E-mail de desconexão vai uma vez por queda para owner/admin da empresa (MemoryMailer), com `APP_NAME` e sem mencionar "API Oficial".
- **AC-T47-05** Evento de sessão sem conexão `crm` correspondente é ignorado (empresa nenhuma recebe).

---

### T48 — Chats: lista, filtros, escopo e ciclo de vida
**Paths:** `packages/core/src/chats/{query,lifecycle}/**`, `apps/api/src/routes/chats/**`
**Depende de:** T33, T31
**Ref:** `03-chats.md#lista-de-conversas-f01f14`, `#ciclo-de-vida-do-chat-f15f22`, `#painel-lateral-do-contato-f52f62`, `#permissões`.
**Entregáveis:** `GET /api/chats` (status, busca nome/telefone, responsável, não respondidas, não lidas, período, conexões, departamentos, etiquetas, kanban, contato; cursor, 15 por página; contadores por aba), `GET /api/chats/filter-options`, `POST /api/chats` (abrir chat com contato+conexão), `POST /api/chats/mark-all-read`, `PATCH /api/chats/:id/assign`, `POST /api/chats/:id/{unassign,resolve,reopen,block,unblock}`, `DELETE /api/chats/:id`, `PATCH /api/chats/:id` (departamento = transferência, kanban, agente IA), notas, etiquetas do chat; `chat_events`; permissões `chat.view`, `chat.assign_others`, `chat.block`, `chat.delete`.
**Critérios de aceitação**
- **AC-T48-01** Membro com escopo do departamento X não vê (lista, contadores, detalhe → 404) chats do departamento Y; owner vê todos.
- **AC-T48-02** Filtro "não respondidas" traz só chats cuja última mensagem é do contato; período exige início e fim (senão 422); busca casa nome e telefone parcial.
- **AC-T48-03** Assumir chat de outro atendente exige `chat.assign_others` (senão 403); `resolve` grava `resolved_at`, `reopen` volta a `waiting`; transição inválida → 409.
- **AC-T48-04** Transferir departamento publica `chat.updated` e o chat some da lista (e do SSE) de quem perde o escopo.
- **AC-T48-05** Notas internas são só do CRM (nenhuma chamada ao gateway) e aparecem no histórico com autor.
- **AC-T48-06** Contadores por aba (`waiting`, `attending`, `resolved`) batem com a lista sob os mesmos filtros.

---

### T49 — Chats: envio, mídia e leitura
**Paths:** `packages/core/src/{chats/send,media}/**`, `apps/api/src/routes/{chat-messages,media}/**`
**Depende de:** T33
**Ref:** `03-chats.md#mensagens--envio-f31f42`, `#ações-na-mensagem-f43f47`, `#compatibilidade-baileys-clone`.
**Entregáveis:** `GET /api/chats/:id/messages?before=` (25), `POST /api/chats/:id/messages` (texto, imagem, vídeo, áudio PTT, documento, figurinha, localização, contato, Pix em texto; `quoted_id`; `view_once`; assinatura `*Nome*:` opcional), `POST /api/chats/:id/messages/:mid/{react,forward,delete}`, `POST /api/chats/:id/read`, `POST /api/media` (upload: imagem/vídeo 20 MB, áudio 16 MB, documento 30 MB), `GET /api/media/:id` (só da empresa); auto-atribuição ao responder chat da fila; mensagem `pending → sent → delivered → read | failed` com `message.status`; `presence` antes de enviar texto/áudio.
**Critérios de aceitação**
- **AC-T49-01** Envio de texto chama `WaGateway.send` uma vez com o conteúdo e o `client_message_id` idempotente; reenviar a mesma requisição (mesmo `Idempotency-Key`) não duplica.
- **AC-T49-02** Arquivo acima do limite do tipo → 413; mime não aceito → 415; áudio enviado como PTT é convertido para Ogg/Opus (conversor injetado) antes do gateway.
- **AC-T49-03** Responder um chat na fila sem responsável atribui ao remetente e muda para `attending`; registra `first_human_reply_at` na primeira resposta humana.
- **AC-T49-04** Reação usa a chave original da mensagem; apagar para todos chama `deleteForEveryone`; falha do gateway marca `failed` e publica `message.status`.
- **AC-T49-05** `GET /api/media/:id` de outra empresa → 404; o conteúdo vem com o mime correto.
- **AC-T49-06** Conexão desconectada → 409 `SESSION_NOT_CONNECTED` e a mensagem não é criada como enviada.

---

### T50 — Kanban: quadros, colunas e cards
**Paths:** `packages/core/src/kanban/**`, `apps/api/src/routes/kanban/**`, `packages/db/src/schema/crm/kanban.ts`
**Depende de:** T33
**Ref:** `04-kanban-crm.md#31-crm-crm`, `#32-coluna-crm_column`, `#33-card-crm_card`, `#36-estatísticas-calculadas-no-front-…`, `#5-ações-e-regras-de-negócio-features`, `#6-endpoints-da-api`.
**Entregáveis:** `crms`, `crm_columns` (posição 0..n−1, cor `#RRGGBB|null`, meta de conversão), `crm_cards` (um por chat por quadro, posição fracionária, valor); CRUD de quadros (3 colunas padrão), colunas (mover recompacta), cards (`PATCH /move { column_id, before_card_id }` em transação), `GET /api/crms/:id/cards?column_id&label_ids[]&assigned_to&updated_from&updated_to&page` com totais por coluna, `GET /api/crms/:id/available-chats`, `GET /api/crms/:id/stats`; `KanbanService.createCard()` para fluxos/webhooks; eventos `kanban.card.*`, `kanban.column.changed`; permissões `kanban.view|edit|delete`.
**Critérios de aceitação**
- **AC-T50-01** Criar quadro cria 3 colunas padrão; mover coluna recompacta as posições 0..n−1; cor inválida → 422.
- **AC-T50-02** Chat que já tem card no quadro → 409; mover card entre colunas preserva a ordem pedida e atualiza contagens e totais.
- **AC-T50-03** Totais por coluna (`total_count`, `total_value`) respeitam os filtros; filtro por etiquetas é OU.
- **AC-T50-04** `stats` reproduz as fórmulas de `04-kanban-crm.md#36` com uma fixture conhecida (funil acumulado e conversão por etapa).
- **AC-T50-05** Excluir coluna remove os cards dela; mover card publica `kanban.card.moved` para a empresa.

---

### T51 — Nós de mensagem (mensagem, modelo, notificação, Pix)
**Paths:** `packages/core/src/flows/nodes/messaging/**`
**Depende de:** T25, T35
**Ref:** `06-fluxos.md#35-tipos-de-nó-…` (message, template, notification, pix), `#36-tipos-de-ação-…`, `#compatibilidade-baileys-clone`.
**Critérios de aceitação**
- **AC-T51-01** `send_message`, `send_multi_media` (imagem, vídeo, áudio PTT, `view_once`, vídeo-nota), `send_file`, `send_sticker` e `send_contact` chamam o gateway com o conteúdo correto e variáveis renderizadas.
- **AC-T51-02** `delay_between_messages` aleatório entre mín e máx (RNG injetado, ≤ 120 s) e presença `composing`/`recording` antes do envio.
- **AC-T51-03** Nó "modelo" usa o modelo interno (T35): corpo renderizado e botões como menu numerado em texto.
- **AC-T51-04** Nó Pix envia a chave e o "copia e cola" EMV com CRC16 válido (teste com vetor conhecido).
- **AC-T51-05** `send_notification` envia para o número interno configurado pela mesma conexão, passando pelo pipeline.

---

### T52 — Agentes de IA: base de conhecimento
**Paths:** `packages/core/src/ai-knowledge/**`, `apps/api/src/routes/ai-knowledge/**`, `apps/worker/src/jobs/ai-knowledge/**`
**Depende de:** T39
**Ref:** `07-agentes-ia.md#34-knowledgesource`, `#5-ações-e-regras-de-negócio`.
**Entregáveis:** fontes `site|pdf|text|file|faq|flow` com limites por slot (site 1, pdf 2, texto 2, FAQ 10, fluxo 1; arquivo ≤ 8 MB), ingestão em job (`pending → ready|failed` com os códigos de erro de 07#3.4), trechos indexados por busca textual (Postgres full-text, sem embeddings nesta versão), reindexar, excluir; evento `ai_knowledge_source.updated`; busca SSRF-safe para `site`.
**Critérios de aceitação**
- **AC-T52-01** PDF, texto e FAQ válidos terminam `ready` com `pages_count`/`questions_count`; arquivo > 8 MB → 413.
- **AC-T52-02** Exceder o limite do slot (ex.: 3º PDF) → 409 `LIMIT_REACHED`.
- **AC-T52-03** Site interno (IP privado) é bloqueado com o código de erro correspondente; site fora do ar → `failed` com código.
- **AC-T52-04** `search(agentId, consulta)` devolve os trechos mais relevantes da fixture; reindexar volta a `pending` e publica o evento.

---

### T53 — UI: empresa, departamentos e horários
**Paths:** `apps/web/src/{routes,features}/{settings-company,settings-departments,settings-hours}/**`
**Depende de:** T31, T36
**Ref:** `16-configuracoes-empresa-equipe.md#21-abas-do-hub-…`, `#22-sub-abas-da-empresa-…`, `#5-ações-e-regras-de-negócio`.
**Critérios de aceitação**
- **AC-T53-01** `/settings?tab=accounts` mostra dados da empresa; salvar fica desabilitado com nome vazio; fuso só editável por owner/admin.
- **AC-T53-02** Desativar empresa abre diálogo crítico listando os efeitos e exige confirmação; reativar volta ao normal.
- **AC-T53-03** Departamentos: criar com paleta de 10 cores ou cor própria, buscar e excluir com diálogo de confirmação.
- **AC-T53-04** Horários: escolher a conexão (com status), adicionar intervalo (padrão 09:00–18:00), validação igual à do servidor; salvar persiste.
- **AC-T53-05** Aba inválida ou sem permissão na URL é trocada (replace) pela primeira aba permitida; no `mobile` as abas viram um select pesquisável.

---

### T54 — UI: equipe, permissões, convites e suporte
**Paths:** `apps/web/src/{routes,features}/{settings-team,settings-invitations,settings-support}/**`
**Depende de:** T32, T36
**Ref:** `16-configuracoes-empresa-equipe.md#34-membro` a `#37`, `#8-permissões`.
**Critérios de aceitação**
- **AC-T54-01** Lista da equipe filtra por papel e departamento ("Sem departamento"), ordena owner < admin < member; sem permissão mostra "Acesso negado".
- **AC-T54-02** Modal de permissões: matriz área × (ver, editar, excluir) aplica as dependências ao marcar; owner aparece travado; escopo de chat só habilitado com `chat.view`; contador "N ativa(s)".
- **AC-T54-03** Transferir propriedade mostra as consequências e, confirmado, troca os papéis na lista.
- **AC-T54-04** Convites: cards de contagem por status, filtro, copiar link, reenviar mostra "Limite de 3 reenvios por dia" ao esgotar.
- **AC-T54-05** Pedido de acesso de suporte recebido por SSE abre o modal global de aprovação; aprovar/rejeitar avança para o próximo pendente.

---

### T55 — Dashboard: métricas de vendas, bootstrap e marcos
**Paths:** `packages/core/src/dashboard/{sales,bootstrap,milestones}/**`, `apps/api/src/routes/dashboard/**`
**Depende de:** T34
**Ref:** `02-dashboard.md#31-filtros-estado-da-página`, `#32-get-dashboard--sales`, `#34-get-dashboardbootstrap`, `#5-ações-e-regras-de-negócio-features`; `15-trilha-do-predador.md#32-níveis-…`.
**Entregáveis:** `GET /api/dashboard?start_date&end_date&connection_ids[]&product_ids[]&force_refresh` (bloco `sales` só com `dashboard.sales`), cache Redis 5 min por (empresa, período, filtros); `GET /api/dashboard/bootstrap` (produtos, conexões, grupos de filtro, avisos/banners ativos, `lifetime_revenue`, `leads_count`); fórmulas **fechadas** (decisão do usuário, documentadas em `docs/kpis.md`): `ticket médio = faturamento ÷ vendas`, `conversão = vendas ÷ leads novos` (leads novos = contatos que iniciaram conversa no período), `ROAS = faturamento ÷ gasto Meta` (nulo com gasto 0), `lucro antes das taxas = faturamento − gasto Meta`, `lucro = lucro antes das taxas − despesas`, onde cada regra de despesa vigente (02#3.5) soma: `fixed` → valor × (dias do intervalo ∩ vigência ÷ dias do período `day|week|month`), `percent` → % sobre a base `revenue|spend|profit_pre`; gasto Meta vem da porta `AdSpendProvider` (padrão 0; T101 registra a implementação); marcos de faturamento (`computeMilestone`) com os 6 limiares da referência e **nomes próprios**: 1 "Primeira Marca" (R$ 50 mil), 2 "Tração" (R$ 100 mil), 3 "Escala" (R$ 250 mil), 4 "Expansão" (R$ 500 mil), 5 "Clube do Milhão" (R$ 1 milhão), 6 "Referência no Mercado" (R$ 2 milhões), com descrições curtas próprias e i18n.
**Critérios de aceitação**
- **AC-T55-01** Com a fixture de vendas, KPIs, séries (granularidade hora para 1 dia, dia para o resto), por hora, por conexão, por UF ("Desconhecido") e por produto batem com os valores esperados no fuso da empresa.
- **AC-T55-02** Período anterior = mesma duração terminando no dia anterior ao início; tendência neutra quando o anterior é 0 ou |Δ| < 0,05%.
- **AC-T55-03** Segunda chamada idêntica vem do cache; `force_refresh=1` recalcula.
- **AC-T55-04** Sem `dashboard.sales`, a resposta não tem o bloco de vendas nem `lifetime_revenue`.
- **AC-T55-05** `computeMilestone`: < 50 mil → sem selo (progresso relativo a 0); 75 mil → "Primeira Marca" com 50% até "Tração"; ≥ 2 milhões → "Referência no Mercado" e nível máximo; nenhum nome ou descrição do produto de referência aparece.
- **AC-T55-06** Com fixture de vendas, gasto Meta (fake de `AdSpendProvider`) e duas regras de despesa (fixa mensal rateada e percentual sobre faturamento), ticket, conversão, ROAS, lucro antes das taxas e lucro batem com os valores calculados à mão; ROAS é nulo com gasto 0.

---

### T56 — UI editores de nó: mensagem e interativos
**Paths:** `apps/web/src/features/flow-editor/node-editors/{messaging,interactive}/**`
**Depende de:** T45, T10
**Ref:** `06-fluxos.md#35-tipos-de-nó-…`, `#36-tipos-de-ação-…`, `#compatibilidade-baileys-clone`.
**Critérios de aceitação**
- **AC-T56-01** Editor do nó Mensagem adiciona, reordena e remove ações (texto, mídia, arquivo, figurinha, contato, atraso), com upload via `/api/media` e inserção de variável.
- **AC-T56-02** Erros de validação (schema do T10) aparecem inline no campo e bloqueiam salvar.
- **AC-T56-03** Editor de menu interativo cria opções com handles estáveis e mostra o aviso "enviado como menu numerado em texto"; timeout configurável até 31 dias.
- **AC-T56-04** Carrossel e Pix mostram prévia em formato de chat do texto que será enviado.

---

### T57 — UI editores de nó: lógica, CRM e externos
**Paths:** `apps/web/src/features/flow-editor/node-editors/{logic,crm,external}/**`
**Depende de:** T45, T10
**Critérios de aceitação**
- **AC-T57-01** Editor de condição monta regras `all`/`any` com todas as categorias de T41 e operadores coerentes com o tipo.
- **AC-T57-02** Distribuidor ajusta quantidades por saída; intervalo inteligente valida horários e dias.
- **AC-T57-03** Nós de CRM listam etiquetas, departamentos, quadros/colunas e agentes da empresa (dados reais da API).
- **AC-T57-04** Nó HTTP permite método, URL com variáveis, headers, corpo e mapeamento de resposta; nó de IA escolhe provedor/modelo configurados e saídas condicionais.

---

### T58 — UI: respostas rápidas, modelos, variáveis, campos e etiquetas
**Paths:** `apps/web/src/{routes,features}/{settings-quick-replies,settings-templates,settings-variables,settings-fields,settings-labels}/**`
**Depende de:** T35, T26, T23
**Ref:** `17-configuracoes-conteudo.md#21-abas-do-hub-…`, `#5-ações-e-regras-de-negócio`.
**Critérios de aceitação**
- **AC-T58-01** Respostas rápidas: tabela com busca e paginação; editor de ações reordenáveis com mídia; atalho duplicado mostra o erro do servidor.
- **AC-T58-02** Modelos de mensagem: editor com prévia em formato de chat e variáveis do contato de exemplo; não existe nenhuma menção a aprovação da Meta.
- **AC-T58-03** Variáveis globais: prefixo `g_` mostrado fixo; tipo número rejeita texto no cliente.
- **AC-T58-04** Campos personalizados: abas "Customizados" e "Sistema" (sistema só leitura de valor, descrição editável); etiquetas com cor e contagem de contatos.
- **AC-T58-05** Membro sem permissão de edição vê as listas sem botões de criar/editar/excluir; layout `mobile` em cartões.

---

### T59 — UI: consumo de IA, chaves e hub de integrações
**Paths:** `apps/web/src/{routes,features}/{settings-ai-usage,integrations}/**`
**Depende de:** T37, T38, T23
**Ref:** `12-cobrancas-assinaturas-tokens.md#2-telas-e-rotas` (adaptado: sem compra), `19-integracoes.md#22-tela-integrações-hub-…`.
**Critérios de aceitação**
- **AC-T59-01** Chip "Créditos de IA" na sidebar mostra saldo e destaque `low`/`exhausted`; atualiza ao receber `ai_wallet.updated` e ao focar a janela; não existe botão de compra.
- **AC-T59-02** `/settings?tab=ai_usage` mostra cards (saldo, uso no período, última recarga), gráfico por dia/feature, extrato filtrável e cotas com barra de progresso; vazio mostra "Nenhum uso de IA nesta empresa".
- **AC-T59-03** Hub de integrações com busca (ignora acentos) e abas IA/Vendas/Rastreamento; status Ativo/Inativo por chave configurada.
- **AC-T59-04** Modal de chave de IA: segredo mascarado, "Testar" mostra latência ou erro; editar com segredo em branco mantém o atual.

---

### T60 — Disparos em massa: API e cota
**Paths:** `packages/core/src/mass-dispatch/**`, `apps/api/src/routes/mass-dispatch/**`, `packages/db/src/schema/crm/mass-dispatch.ts`
**Depende de:** T26, T43
**Ref:** `10-disparos-em-massa.md#31-formulário-de-criação-wizard` a `#34-cota-…`, `#4-estados-e-transições`, `#5-ações-e-regras-de-negócio`, `#compatibilidade-baileys-clone`.
**Entregáveis:** `mass_dispatches` (status `preparing|scheduled|running|paused|completed|cancelled|failed`, dias da semana, janela, fuso, intervalo mín/máx 0–120 s, limite diário, início, contadores, progresso de preparação), `mass_dispatch_targets` (conexão + fluxo), `mass_dispatch_recipients` (variante A/B, status `pending|started|failed|cancelled|skipped`); manifesto `ids | all_except + filtros`; cota mensal `conexões × limite_por_conexão (500) + bônus`; `GET /api/mass-dispatches/quota`, CRUD de leitura, `POST` (multipart manifest), `POST /:id/cancel`; contatos com opt-out entram como `skipped` (sem exigência de consentimento prévio — regra 1.4 nº 3); permissão nova `mass_dispatch.create`.
**Critérios de aceitação**
- **AC-T60-01** Criar sem cota suficiente → 429 `QUOTA_EXCEEDED`; com público maior que a cota restante → aviso `only_first_n` e só N destinatários.
- **AC-T60-02** `interval_max < interval_min`, janela vazia ou sem dias da semana → 422; limite diário acima da capacidade de warm-up das conexões gera aviso.
- **AC-T60-03** Manifesto `all_except` com filtros resolve o público excluindo os ids informados; contatos com opt-out entram como `skipped`; contatos importados sem histórico de conversa são aceitos.
- **AC-T60-04** Cancelar devolve a cota dos destinatários não iniciados (`released_count`) e cancela os jobs pendentes.
- **AC-T60-05** Fluxos-alvo precisam estar ativos e ser acionáveis; conexão desconectada no alvo → 409.

---

### T61 — Gatilhos, fluxos padrão por conexão e ação fora do horário
**Paths:** `packages/core/src/flows/triggers/**`, `apps/api/src/routes/connection-flow-configs/**`, `apps/worker/src/consumers/flow-triggers/**`, `packages/db/src/schema/crm/flow-triggers.ts`
**Depende de:** T30, T33, T40, T31
**Ref:** `06-fluxos.md#38-connectionflowconfig-…`, `08-conexoes.md#33-connectionflowconfig`, `17-configuracoes-conteudo.md#3f-fluxos-padrões-…`, `16-configuracoes-empresa-equipe.md#33-horário`.
**Entregáveis:** `connection_flow_configs` (boas-vindas, resposta padrão + atraso 1–168 h, conversa finalizada, atendimento finalizado) e `keyword_triggers` (6 tipos de casamento, `any|all`, posição, ativo); API com edição em massa (sentinelas `keep`/`clear`); consumidor de `crm.inbound` com precedência **palavra-chave > boas-vindas > conversa finalizada > resposta padrão**; mensagem que responde a um run `waiting` vai para o run e não dispara gatilho; supressão quando o chat está `attending` com humano ou com agente de IA ativo (exceto palavra-chave); ação fora do horário (mensagem ou fluxo) uma vez por janela de 12 h por chat.
**Critérios de aceitação**
- **AC-T61-01** Palavra-chave casada (equals, contains, different, excludes, starts_with, ends_with; `any`/`all`) dispara o fluxo dela mesmo havendo boas-vindas configurada.
- **AC-T61-02** Boas-vindas só no primeiro contato; resposta padrão só após `delay_hours` sem mensagem do contato.
- **AC-T61-03** Mensagem que responde a um run em espera vai para o run e nenhum gatilho dispara; o mesmo evento entregue duas vezes não cria dois runs.
- **AC-T61-04** Chat em atendimento humano ou com agente de IA ativo não recebe boas-vindas nem resposta padrão.
- **AC-T61-05** Fora do horário (fuso da empresa), a ação configurada roda uma vez por janela de 12 h; dentro do horário, não roda.
- **AC-T61-06** Edição em massa com `keep` não altera o campo e com `clear` o anula.

---

### T73 — Fontes de venda (webhook genérico) e atribuição UTM/CTWA
**Paths:** `packages/core/src/{sale-sources,attribution}/**`, `apps/api/src/routes/{sale-sources,hooks-sales}/**`, `apps/worker/src/jobs/inbound-sales/**`, `packages/db/src/schema/crm/sale-sources.ts`
**Depende de:** T34, T33
**Ref:** `19-integracoes.md#55-mapeamento-evento-de-pagamento--ações`, `11-facebook-ads.md#37-atribuição-em-contatos-e-vendas`, `05-contatos.md#compatibilidade-baileys-clone` (CTWA).
**Entregáveis:** `sale_sources` (token, segredo HMAC opcional cifrado, mapeamento JSONPath → `SaleEvent`, tabela de status), `inbound_sale_events` (bruto, status, erro, venda); público `POST /api/hooks/sales/:token` (202 + fila `inbound-sales`); `POST /api/sale-sources/:id/test` (dry-run do mapeamento), replay, rotação de token; contato encontrado/criado pelo telefone E.164; `contact_attribution` (first/last touch com `utm_*`, `ctwa_clid`, `source_id`).
**Critérios de aceitação**
- **AC-T73-01** Token inválido → 404; HMAC errado → 401; mesmo `external_id` duas vezes → 1 venda com status atualizado.
- **AC-T73-02** Payload que o mapeamento não resolve vira evento `failed` com o caminho que faltou; replay reprocessa após corrigir o mapeamento.
- **AC-T73-03** `test` devolve o `SaleEvent` resultante de uma amostra colada sem gravar nada.
- **AC-T73-04** Venda cria ou encontra o contato pelo telefone (contato novo com `consent_source = 'sale'`) e herda a atribuição; first touch nunca é sobrescrito, last touch sim.
- **AC-T73-05** Rotacionar o token invalida a URL antiga (404).

---

### T80 — Vozes (ElevenLabs)
**Paths:** `packages/core/src/ai-voices/**`, `apps/api/src/routes/ai-voices/**`, `packages/db/src/schema/crm/ai-voices.ts`
**Depende de:** T38, T12
**Ref:** `07-agentes-ia.md#37-voz-da-conta`, `#6-endpoints-da-api` (vozes).
**Critérios de aceitação**
- **AC-T80-01** Criar voz com 1–3 amostras de áudio aceitas (formatos de 07#3.7) chama a clonagem do `TtsProvider` (fake) e fica `pending`; 0 ou 4 amostras → 422.
- **AC-T80-02** `preview` sintetiza um texto curto e devolve áudio; `keep` muda para `kept`.
- **AC-T80-03** Excluir voz usada por agente remove a referência do agente (volta à voz padrão) e avisa na resposta.
- **AC-T80-04** Sem chave ElevenLabs (empresa nem plataforma) → 422 `provider_not_configured`; uso de TTS é medido (`feature = 'tts'`).

---

### T84 — UI: central de notificações
**Paths:** `apps/web/src/features/notifications/**`, i18n `notifications`
**Depende de:** T33, T23
**Ref:** `14-notificacoes.md#features`, `#realtime`.
**Critérios de aceitação**
- **AC-T84-01** `message.created` de entrada (no escopo do usuário) incrementa o badge do sino (mostra "9+" acima de 9), cria item na central e toca o som se ligado.
- **AC-T84-02** Mensagem do chat aberto no momento não notifica.
- **AC-T84-03** Clicar no item abre `/chat/<id>`; itens com mais de 1 h somem.
- **AC-T84-04** Preferências (ativo, volume 0–100, navegador, toast, sons) persistem e "Restaurar padrão" volta aos valores de 14#10; volume 0 não toca som.
- **AC-T84-05** Evento genérico `notification.created { title, body, url? }` (ex.: push da Venda aprovada) aparece como toast e item na central, respeitando as mesmas preferências.

---

### T101 — Meta: estrutura, insights e bundle assíncrono
**Paths:** `packages/core/src/meta-ads/structure/**`, `apps/api/src/routes/meta-structure/**`, `apps/worker/src/jobs/meta-ads/**`
**Depende de:** T99, T09, T16
**Ref:** `11-facebook-ads.md#21-gerenciador-facebookcampaigns`, `#34-linha-da-estrutura-…`, `#35-envelope-do-bundle-…`, `#41-status-de-entidade-…`, `#42-níveis-períodos-e-ordenação`, `#44-ciclo-do-bundle`, `#52-gerenciador--carregamento`, `#7-eventos-realtime`.
**Entregáveis:** `GET /api/meta/structure-bundle` (nível, filtro de status, período/preset no fuso da empresa, contas, moeda de exibição, `force_refresh`, `async`); job que monta campanhas/conjuntos/anúncios + insights por conta, mapeia `actions[]`, junta métricas internas quando disponíveis; rate limit BUC por conta em Redis (adia o job, não falha); cache 5 min; SSE `meta.bundle.progress` (`loading → partial → ready`); serviço `metaSpend(companyId, período)` para o dashboard.
**Critérios de aceitação**
- **AC-T101-01** O bundle junta estrutura e insights e mapeia `actions[]` por `action_type` (fixture com array embaralhado).
- **AC-T101-02** Com 2 contas e 1 falhando, o status final é `ready` com `errors[{ ad_account_id, error }]` e a outra conta preenchida.
- **AC-T101-03** `x-business-use-case-usage` acima de 75% ou erro 17/80004 adia o job (não conta como falha) e devolve o bundle em cache com aviso.
- **AC-T101-04** A segunda chamada idêntica em 5 min não chama o fake; `force_refresh=1` chama.
- **AC-T101-05** O SSE publica `loading → partial (targets_done crescente) → ready` na ordem; moeda de exibição diferente da conta gera campos `_display`.

---

### T104 — Meta: Pixel, Conversions API e nó de fluxo pixel
**Paths:** `packages/core/src/meta-capi/**`, `packages/core/src/flows/nodes/pixel/**`, `apps/api/src/routes/meta-pixels/**`, `apps/worker/src/jobs/meta-capi/**`, `packages/db/src/schema/crm/meta-pixels.ts`
**Depende de:** T99, T25, T34
**Ref:** `11-facebook-ads.md#22-pixel-facebookpixel`, `#33-pixel_config--pixel_configs`, `#54-pixel`; `06-fluxos.md#35-tipos-de-nó-…` (pixel); `STACK.md` Bloco E §1.7.
**Entregáveis:** `pixel_configs` (nome, `pixel_id` numérico, token cifrado), CRUD mascarado (`include_access_token=true` só com `facebook.pixel`); `CapiService.send(event)` com hash SHA-256 de telefone/e-mail normalizados, `event_id` com dedupe em `capi_event_log`, `action_source` `chat`/`system_generated` (nunca `business_messaging`), `test_event_code` fora de produção; nó `pixel`/`send_pixel_event` e envio automático opcional em `sale.recorded`.
**Critérios de aceitação**
- **AC-T104-01** Telefone "+55 (11) 99999-8888" é enviado como `sha256("5511999998888")` e o e-mail é normalizado (trim, minúsculas) antes do hash.
- **AC-T104-02** O mesmo `event_id` enviado duas vezes resulta em 1 POST ao fake.
- **AC-T104-03** Moeda vazia ou inválida vira `BRL`; `value` com variável (`{preco}`) é renderizado.
- **AC-T104-04** A listagem mascara `pixel_id` e token; o nó `pixel` no fluxo envia o evento configurado e segue `success`/`failure`.
- **AC-T104-05** Nenhum payload enviado usa `action_source: business_messaging` nem campos de WABA.

---

### T62 — Nós interativos (menu, carrossel, espera de resposta)
**Paths:** `packages/core/src/flows/nodes/interactive/**`
**Depende de:** T30, T51
**Ref:** `06-fluxos.md#35-tipos-de-nó-…` (interactive_menu, menu, carousel, wait_response), `#compatibilidade-baileys-clone`.
**Critérios de aceitação**
- **AC-T62-01** Menu é enviado como texto numerado ("1 - Vendas"); resposta "2", o título exato ou o título sem diferenciar caixa/acentos seguem `option:<id>`; texto não reconhecido segue `other`; sem resposta no prazo segue `timeout`.
- **AC-T62-02** `save_user_data` grava a resposta na variável/campo configurado.
- **AC-T62-03** `wait_response` com buffer de N s junta as mensagens recebidas no intervalo numa só variável antes de seguir.
- **AC-T62-04** Carrossel envia as imagens com legenda e depois a lista numerada das opções; os handles das opções continuam válidos.
- **AC-T62-05** Com `capabilities.nativeButtons = false` (padrão), nenhum conteúdo `buttonsMessage`/`listMessage` é enviado.

---

### T63 — Nós de CRM (etiquetas, chat, departamento, kanban, manipulador, venda, agente)
**Paths:** `packages/core/src/flows/nodes/crm/**`
**Depende de:** T25, T48, T50, T34
**Ref:** `06-fluxos.md#35-tipos-de-nó-…` (tags, chat_controller, department, kanban, manipulator, ai_agent), `19-integracoes.md#39-bloco-venda-aprovada-…`.
**Critérios de aceitação**
- **AC-T63-01** `add_tags`/`remove_tags` são idempotentes e publicam `contact.updated`.
- **AC-T63-02** `change_chat_status` aceita só o enum interno (`waiting|attending|resolved`) e publica `chat.updated`; `set_department` transfere o chat.
- **AC-T63-03** `create_kanban_card` cria o card com valor (ou atualiza se o chat já tiver card no quadro); `remove_kanban_card` remove.
- **AC-T63-04** Manipulador: `set`, `add`, `subtract`, `multiply`, `divide` (divisão por zero → `failure`); `set_created_at` aceita `dd/MM/aaaa HH:mm:ss` e ISO.
- **AC-T63-05** `register_approved_sale` grava a venda pelo `SalesService` (origem `flow`) com produto, valor (fallback fora da faixa), moeda e cliente renderizados, guarda `note_issuer_id` e `utmify_integration_id` da configuração na venda (consumidos por T112/T113) e publica `notification.created` com o título/corpo de push renderizados; `control_ai_agent` liga/desliga o agente no chat.

---

### T64 — Agendamento de mensagens
**Paths:** `packages/core/src/schedules/**`, `apps/api/src/routes/schedules/**`, `apps/worker/src/jobs/schedules/**`, `packages/db/src/schema/crm/schedules.ts`
**Depende de:** T49, T35
**Ref:** `03-chats.md#produtividade-f48f51` (agendar), `#lacunas`.
**Critérios de aceitação**
- **AC-T64-01** Agendar mensagem ou fluxo para até 31 dias; acima → 422; data no passado → 422.
- **AC-T64-02** Na hora, a mensagem sai pelo `WaGateway` (pipeline) e o agendamento fica `sent`; fluxo agendado cria o run.
- **AC-T64-03** Recorrência diária/semanal/mensal reagenda a próxima ocorrência após executar.
- **AC-T64-04** Cancelar remove o job; lista `GET /api/schedules` filtra por chat e status.

---

### T65 — Dashboard: métricas de atendimento
**Paths:** `packages/core/src/dashboard/attendance/**`, `apps/api/src/routes/dashboard-attendance/**`
**Depende de:** T48
**Ref:** `02-dashboard.md#33-get-dashboard--attendance`, `#5-ações-e-regras-de-negócio-features`.
**Critérios de aceitação**
- **AC-T65-01** Novos, atendidos, resolvidos e sem resposta batem com a fixture no período e fuso da empresa; período > 92 dias → 422.
- **AC-T65-02** Tempo de primeira resposta considera só respostas humanas (`sender_type = user`); bot e IA não contam; chat sem resposta fica fora da média.
- **AC-T65-03** Mapa de calor dia × hora no fuso da empresa e pico identificado.
- **AC-T65-04** Desempenho por atendente e por departamento com as mesmas contagens da visão geral (somas batem).

---

### T66 — Contatos: filtros avançados e ações em massa
**Paths:** `packages/core/src/contacts-bulk/**`, `apps/api/src/routes/contacts-bulk/**`, `apps/worker/src/jobs/contacts-bulk/**`
**Depende de:** T26, T27, T50
**Ref:** `05-contatos.md#33-filtros-de-listagem-…`, `#34-seleção-em-massa-…`, `#35-job-de-exportação-…`, `#37-job-de-exclusão-em-massa-…`.
**Critérios de aceitação**
- **AC-T66-01** Busca ignora termos numéricos com menos de 4 dígitos; filtro por etiqueta inclui contatos cuja etiqueta está no contato **ou** num chat dele; filtro por etapa do kanban e por campo personalizado (contém, sem diferenciar caixa).
- **AC-T66-02** `skip_total=1` devolve `total_count: null` e mantém a paginação.
- **AC-T66-03** Exportar com modo `all_except` exclui os ids informados e respeita os filtros; as 3 exportações mais recentes ficam listadas.
- **AC-T66-04** Exclusão em massa por manifesto roda em lotes com progresso, apaga chats/mensagens/cards do CRM desses contatos e não toca em dados de outra empresa nem nas tabelas `public.*` do WhatsApp.

---

### T68 — Runtime do agente de IA
**Paths:** `packages/core/src/ai-runtime/**`, `apps/worker/src/consumers/ai-agent/**`, `apps/worker/src/jobs/ai-agent/**`
**Depende de:** T39, T24, T12, T33, T49
**Ref:** `07-agentes-ia.md#32-agentsettings`, `#33-agentskill-habilidade`, `#5-ações-e-regras-de-negócio`, `#9-integrações-externas`.
**Entregáveis:** turno do agente disparado por `crm.inbound` de chat com agente ativo: buffer (reinicia a cada mensagem), STT de áudio recebido (Groq), visão para imagem/comprovante (structured output), busca na base de conhecimento, chamada LLM medida com habilidades como tools (`transfer_human`, `apply_label`, `fill_field`, `trigger_flow`, `close_conversation`, `move_card`), coleta de dados, divisão em mensagens, presença `composing`/`recording`, áudio TTS opcional (regra: link, preço, Pix, código, endereço e lista nunca viram áudio; limite por conversa), `pause_on_human`, limite de travamento → transfere, cota esgotada → `no_balance_action`; estado em `ai_conversation_state` (inclui `providerData`).
**Critérios de aceitação**
- **AC-T68-01** Três mensagens em 3 s com buffer de 5 s geram um único turno com as três como entrada.
- **AC-T68-02** Habilidade "transferir para humano" chamada pelo `FakeLlm` desliga o agente no chat, atribui ao departamento configurado e publica `chat.updated`.
- **AC-T68-03** Áudio recebido é transcrito (FakeStt) antes do turno; resposta com link ou preço nunca vira áudio mesmo com áudio ativo.
- **AC-T68-04** Atendente humano envia mensagem com `pause_on_human` → o agente pausa naquele chat e não responde mais.
- **AC-T68-05** Cota esgotada → nenhuma chamada ao LLM e a ação `no_balance_action` (transferir/fluxo/notificar) é executada.
- **AC-T68-06** Todo envio do agente passa pelo `WaGateway.send` com `sender_type = ai`; o `providerData` do turno anterior é reenviado no turno seguinte.

---

### T69 — UI chats: lista e filtros
**Paths:** `apps/web/src/{routes,features}/chat/**`, `apps/web/src/features/chat-list/**`
**Depende de:** T48, T23
**Ref:** `03-chats.md#telas-e-rotas`, `#lista-de-conversas-f01f14`, `#observado-no-app-portal`.
**Entregáveis:** rota `/chat/$chatId?` com filtros em search params; layout de 3 painéis (desktop) e telas separadas lista ↔ conversa (mobile); slots para conversa (T75), compositor (T85) e painel (T91).
**Critérios de aceitação**
- **AC-T69-01** Abas por status com contadores; filtros rápidos "Tudo", "Não lidas", "Não respondidas"; filtros avançados (modal) refletidos na URL e mantidos ao recarregar.
- **AC-T69-02** Mensagem nova via SSE (harness `/__e2e/wa/emit`) move o chat para o topo e atualiza não lidas sem recarregar.
- **AC-T69-03** Rolagem infinita carrega a próxima página; estado vazio por aba.
- **AC-T69-04** No `mobile`, só a lista aparece; tocar num chat abre a conversa em tela cheia com botão de voltar.

---

### T70 — UI kanban: lista e quadro
**Paths:** `apps/web/src/{routes,features}/crms/**`
**Depende de:** T50, T23
**Ref:** `04-kanban-crm.md#2-telas-e-rotas`, `#5-ações-e-regras-de-negócio-features`; `STACK.md` D §5 (@dnd-kit/react 0.5.1).
**Critérios de aceitação**
- **AC-T70-01** `/crms` mostra indicadores (quadros, cards, valor, conversão média = Σ conversões / Σ cards), grade com mini-funil e busca local.
- **AC-T70-02** Arrastar card entre colunas atualiza contagens e somas na hora; erro do servidor desfaz o movimento com aviso.
- **AC-T70-03** Arrastar coluna reordena e persiste; "Carregar mais" por coluna pagina.
- **AC-T70-04** Clicar no card abre `/chat/<id>`; cards mostram nome, telefone formatado, etiquetas, prévia, não lidas e valor.
- **AC-T70-05** No `mobile`, colunas rolam com snap horizontal dentro do quadro (sem rolagem horizontal da página) e o card tem a ação "Mover para…".

---

### T71 — UI conexões
**Paths:** `apps/web/src/{routes,features}/connections/**`
**Depende de:** T40, T47, T23
**Ref:** `08-conexoes.md#2-telas-e-rotas`, `#5-ações-e-regras-de-negócio`.
**Critérios de aceitação**
- **AC-T71-01** Lista com cards de contagem, busca, filtro de status e tabela (conexão, status com badge de aquecimento/saúde, criada em, desconectada em, ações).
- **AC-T71-02** Conectar: abas QR (atualiza com `connection.qr_updated`) e "Código no telefone"; ao conectar (`connection.connected` via harness), o modal fecha e o status muda sem recarregar.
- **AC-T71-03** Modais de proxy (senha mascarada, aviso de reinício), configurações da instância e "Parar todos os fluxos" (exige digitar o nome).
- **AC-T71-04** Reconexão com fluxos pausados abre o modal "Retomar/Cancelar"; nenhum texto da tela menciona API Oficial, Embedded Signup ou "imune a ban".
- **AC-T71-05** Sem limite definido, "Nova conexão" fica sempre disponível; com limite definido e atingido, o botão fica desabilitado com a explicação; layout `mobile` em cartões.

---

### T74 — Disparos em massa: preparação e agendador
**Paths:** `packages/core/src/mass-dispatch-runner/**`, `apps/worker/src/jobs/mass-dispatch/**`
**Depende de:** T60, T30
**Ref:** `10-disparos-em-massa.md#4-estados-e-transições`, `#5-ações-e-regras-de-negócio`, `#compatibilidade-baileys-clone`; `AI-MANAGER-MAP.md#4-pipeline-de-envio-e-antiban` (gates e antiban).
**Critérios de aceitação**
- **AC-T74-01** Preparação passa por `resolving_recipients → counting → scheduling → completed` com progresso no SSE (`mass_dispatch.updated`, no máximo 1/s).
- **AC-T74-02** Envios só dentro da janela e dias da semana no fuso da empresa; intervalo aleatório entre mín e máx (RNG injetado); limite diário pausa e retoma no próximo dia permitido.
- **AC-T74-03** `RATE_LIMIT`/`WARMUP_LIMIT` do gateway reagendam o destinatário (não `failed`); `CONTACT_NOT_ALLOWED` vira `skipped`; conexão desconectada pausa o alvo e retoma quando ela volta.
- **AC-T74-04** Distribuição entre alvos proporcional à capacidade restante; A/B 50/50 determinístico por hash do contato.
- **AC-T74-05** Iniciar o fluxo de um destinatário cancela o run ativo dele (como avisado no wizard).

---

### T78 — UI dashboard: filtros e vendas
**Paths:** `apps/web/src/{routes,features}/dashboard/**`
**Depende de:** T55, T23
**Ref:** `02-dashboard.md#2-telas-e-rotas`, `#5-ações-e-regras-de-negócio-features`, `#observado-no-app-portal`; `15-trilha-do-predador.md#2-telas-e-rotas`.
**Critérios de aceitação**
- **AC-T78-01** Presets (hoje, ontem, 7 dias = hoje−6..hoje, 30 dias, este mês, personalizado), conexões e produtos ficam na URL; "Atualizar" força recálculo e mostra "Última atualização".
- **AC-T78-02** KPIs com tendência (verde/vermelho, invertida para "menor é melhor"), lucro negativo destacado, gráficos com estado vazio.
- **AC-T78-03** Grupos de filtro salvos: criar, aplicar e excluir.
- **AC-T78-04** Saudação pelo horário no fuso da empresa e pílula de marcos de faturamento com modal de progresso; sem `dashboard.sales` a aba Vendas some e abre Atendimento.

---

### T81 — Webhooks de entrada: processador e escuta de amostras
**Paths:** `packages/core/src/inbound-webhooks-processor/**`, `apps/worker/src/jobs/inbound-webhooks/**`
**Depende de:** T72, T61, T50
**Ref:** `09-webhooks-entrada.md#5-ações-e-regras-de-negócio`, `#7-eventos-realtime`.
**Critérios de aceitação**
- **AC-T81-01** Os passos rodam na ordem de 09#5 (resolver contato → identidade → campos → etiquetas → kanban → disparar fluxo) e cada um grava `ok|failed|skipped` com motivo.
- **AC-T81-02** Corpo repetido (mesmo hash em 10 min) vira `skipped`; condições `any/all` não satisfeitas não disparam o fluxo.
- **AC-T81-03** Conexão por número casa os 8 últimos dígitos; ambígua ou inexistente não dispara e registra o motivo.
- **AC-T81-04** Durante a escuta de amostra, um request publica `webhook.sample_received` só para quem está escutando aquele webhook.

---

### T90 — UI fontes de venda e produtos
**Paths:** `apps/web/src/{routes,features}/{settings-sale-sources,settings-products}/**`
**Depende de:** T73, T23
**Critérios de aceitação**
- **AC-T90-01** Produtos: tabela e modal com validações de faixa e fallback iguais às do servidor.
- **AC-T90-02** Fonte de venda: URL e segredo copiáveis; colar uma amostra mostra o `SaleEvent` resultante; rotacionar token pede confirmação.
- **AC-T90-03** Log de eventos com filtro de status e botão de reprocessar.
- **AC-T90-04** Layout `mobile` sem rolagem horizontal.

---

### T103 — Meta: edição de status, nome e orçamento
**Paths:** `packages/core/src/meta-ads/mutations/**`, `apps/api/src/routes/meta-entities/**`
**Depende de:** T101
**Ref:** `11-facebook-ads.md#53-gerenciador--escrita-na-meta-…`.
**Critérios de aceitação**
- **AC-T103-01** Alternar status envia `status=PAUSED|ACTIVE` ao fake e invalida o cache do bundle da empresa.
- **AC-T103-02** Orçamento "12,50" vira `1250` centavos; campo vazio não é enviado.
- **AC-T103-03** `name` com `level=ad` → 422; sem `fb_ad_account_id` → 422.
- **AC-T103-04** Erro da Meta → 502 `UPSTREAM_ERROR` com mensagem "Não foi possível atualizar na Meta"; sem `facebook.campaigns` → 403.

---

### T105 — Meta: vendas internas × anúncios (CTWA) e ROAS
**Paths:** `packages/core/src/meta-ads/sales-join/**`
**Depende de:** T101, T73
**Ref:** `11-facebook-ads.md#37-atribuição-em-contatos-e-vendas`, `#55-atribuição-de-vendas`.
**Critérios de aceitação**
- **AC-T105-01** `purchases_internal` e `purchase_value_internal` por anúncio somam as vendas cujo `source_id` é o id do anúncio, dentro do período no fuso da empresa.
- **AC-T105-02** Agregados por conjunto e campanha batem com a soma dos anúncios.
- **AC-T105-03** ROAS é nulo quando o gasto é ≤ 0.
- **AC-T105-04** Vendas sem `source_id` não entram em nenhum anúncio.

---

### T107 — Indicador de conexões desconectadas no menu
**Paths:** `apps/web/src/features/shell-disconnect/**`, `apps/api/src/routes/connections-alert/**`
**Depende de:** T47, T23
**Ref:** `18-shell-navegacao-tutoriais-suporte.md#55-indicador-de-conexões-desconectadas-no-menu-…`.
**Critérios de aceitação**
- **AC-T107-01** `GET /api/connections/disconnect-alert` devolve `has_recent_disconnected: true` se houve queda nas últimas 24 h da empresa.
- **AC-T107-02** `connection.disconnected` via SSE liga o indicador sem nova consulta; `connection.connected` dispara nova consulta.
- **AC-T107-03** Não aparece para `support` nem para quem não tem `connections.view` (owner sempre vê).
- **AC-T107-04** Trocar de empresa refaz a consulta.

### T75 — UI chats: conversa
**Paths:** `apps/web/src/features/chat-thread/**`
**Depende de:** T69, T49
**Ref:** `03-chats.md#mensagens--leitura-f23f30`, `#ações-na-mensagem-f43f47`.
**Critérios de aceitação**
- **AC-T75-01** Histórico em rolagem reversa: subir carrega mais 25 mantendo a posição; abrir o chat marca como lido.
- **AC-T75-02** Renderiza texto, imagem, vídeo, áudio (player), documento, figurinha, localização, contato, reação, mensagem apagada, visualização única e notas internas (estilo distinto).
- **AC-T75-03** Ticks de status mudam ao receber `message.status` sem recarregar; mensagem com falha mostra "Tentar novamente".
- **AC-T75-04** Menu por mensagem: responder (mostra citação), encaminhar, reagir, copiar, apagar para todos e baixar mídia.
- **AC-T75-05** Mensagem recebida via SSE aparece no fim e rola automaticamente só se o usuário já estava no fim.

---

### T76 — UI kanban: modais, filtros, estatísticas e exportação
**Paths:** `apps/web/src/features/kanban-tools/**`
**Depende de:** T70, T27
**Ref:** `04-kanban-crm.md#2-telas-e-rotas`, `#36-estatísticas-…`.
**Critérios de aceitação**
- **AC-T76-01** Modal de coluna com 8 cores + "Automático" e marcação de conversão; modal de criar card busca chats paginados e mostra "Todos os chats já possuem cartões" quando vazio.
- **AC-T76-02** Filtros (etapa, atualizado em, etiquetas, responsável): filtro de etapa carrega só aquela coluna.
- **AC-T76-03** Painel de estatísticas mostra o funil acumulado e pode ser ocultado.
- **AC-T76-04** Exportar gera o job, mostra o progresso (`job.progress`) e oferece o download ao terminar.

---

### T77 — UI contatos: lista e seleção em massa
**Paths:** `apps/web/src/{routes,features}/contacts/**`
**Depende de:** T66, T23
**Ref:** `05-contatos.md#2-telas-e-rotas`, `#34-seleção-em-massa-…`.
**Critérios de aceitação**
- **AC-T77-01** Contagem no cabeçalho ("N+" quando desconhecida), busca com debounce de 500 ms, filtros com chips removíveis.
- **AC-T77-02** Seleção em massa: Shift+clique seleciona intervalo; "todos do filtro" mostra a contagem efetiva considerando exclusões.
- **AC-T77-03** Barra de ações em massa: excluir (com confirmação e progresso), disparo em massa (abre o wizard com os selecionados) e exportar.
- **AC-T77-04** "Importar do WhatsApp" só aparece com conexão conectada; trocar de empresa limpa seleção e filtros.
- **AC-T77-05** No `mobile`, a tabela vira cartões e a seleção continua funcionando.

---

### T79 — Agentes: teste ao vivo, geração de prompt e criação assistida
**Paths:** `packages/core/src/ai-agent-lab/**`, `apps/api/src/routes/ai-agent-lab/**`, `apps/worker/src/jobs/ai-agent-lab/**`
**Depende de:** T68
**Ref:** `07-agentes-ia.md#5-ações-e-regras-de-negócio`, `#6-endpoints-da-api` (test-messages, generate-prompt, estimate, runs, transcriptions).
**Critérios de aceitação**
- **AC-T79-01** `POST /api/ai-agents/:id/test-messages { text, draft }` roda o mesmo runtime do T68 em modo teste (sem WhatsApp) e devolve blocos, habilidades disparadas, campos preenchidos, `trace` e créditos cobrados.
- **AC-T79-02** Limite diário de testes por empresa (`eval_cap`) → 429 ao exceder.
- **AC-T79-03** `generate-prompt` monta o prompt a partir dos campos do agente respeitando os blocos travados.
- **AC-T79-04** Criação assistida (`pitch`, `site_url`) roda como job com estágios `extract → compose → persist`, avisos (`site_unread`, `empty_knowledge`) e SSE `ai_agent.run.updated`; um run por empresa por vez (`create_in_progress` → 409).

---

### T82 — Simulador de fluxos
**Paths:** `apps/api/src/routes/flow-simulate/**`, `apps/web/src/features/flow-simulator/**`
**Depende de:** T41, T42, T51, T62, T63, T45
**Ref:** `06-fluxos.md#44-simulador`, `#56-simulador`.
**Critérios de aceitação**
- **AC-T82-01** `POST /api/flows/:id/simulate` executa o rascunho em dry-run (mesmos handlers do motor) e devolve a transcrição das mensagens e o caminho percorrido, sem gravar runs nem chamar o gateway.
- **AC-T82-02** Respostas simuladas escolhem o handle (opção, timeout, outro, sucesso/falha) e o simulador continua a partir dele.
- **AC-T82-03** Loop ou caminho acima de 50 passos é interrompido e marcado no resultado.
- **AC-T82-04** No editor, o painel do simulador mostra a conversa em formato de chat com botões das respostas possíveis (desktop e `mobile`).

---

### T83 — UI disparos em massa
**Paths:** `apps/web/src/{routes,features}/mass-dispatch/**`
**Depende de:** T60, T74, T23
**Ref:** `10-disparos-em-massa.md#2-telas-e-rotas`, `#31-formulário-de-criação-wizard`.
**Critérios de aceitação**
- **AC-T83-01** Página com cards (restantes, usados, em andamento, concluídos), barra de cota e tabela com progresso.
- **AC-T83-02** Wizard em 3 passos (alvos conexão+fluxo, configurações com presets lento/normal/rápido/personalizado, público) com as validações do servidor e a confirmação de que o fluxo em andamento do contato será cancelado.
- **AC-T83-03** A interface informa que o ritmo real pode ser mais lento que o configurado por causa dos limites de segurança da conexão.
- **AC-T83-04** Modal de preparação mostra as fases (SSE) e "Ver detalhes" mostra A/B, alvos e o botão Cancelar.

---

### T87 — UI dashboard: histórico, atendimento e marcos
**Paths:** `apps/web/src/features/{dashboard-attendance,dashboard-history}/**`
**Depende de:** T78, T65
**Critérios de aceitação**
- **AC-T87-01** Histórico de vendas com rolagem infinita; criar venda no modal coloca-a no topo; exportar bloqueado com 0 linhas.
- **AC-T87-02** Aba Atendimento: KPIs, mapa de calor com pico destacado, tempos formatados (s/min/h) e tabela por atendente ordenável.
- **AC-T87-03** Gráfico por departamento agrupa em "Outros" acima do limite de fatias.
- **AC-T87-04** Período acima de 92 dias na aba Atendimento mostra o aviso em vez de quebrar.

---

### T89 — UI webhooks de entrada
**Paths:** `apps/web/src/{routes,features}/settings-webhooks/**`
**Depende de:** T81, T23
**Ref:** `09-webhooks-entrada.md#2-telas-e-rotas`.
**Critérios de aceitação**
- **AC-T89-01** Lista com busca e "disparos no mês"; criar/editar com URL copiável.
- **AC-T89-02** "Escutar exemplo" fica 90 s em `listening` e mostra o corpo recebido (via `webhook.sample_received` do harness); expira com mensagem.
- **AC-T89-03** Árvore JSON da amostra permite clicar num campo para mapeá-lo ao destino; segmentos literais podem ser concatenados.
- **AC-T89-04** Aba Histórico com estatísticas, filtro de status e JSON formatado de cada request.

---

### T106 — UI Facebook: gerenciador, pixel e perfis
**Paths:** `apps/web/src/{routes,features}/facebook/**`
**Depende de:** T101, T103, T104, T23
**Ref:** `11-facebook-ads.md#21-gerenciador-facebookcampaigns`, `#22-pixel-facebookpixel`, `#23-perfis-e-contas-facebookprofiles`, `#4-estados-e-transições`.
**Critérios de aceitação**
- **AC-T106-01** `/facebook` vai para a primeira sub-rota permitida (com só `facebook.pixel` → `/facebook/pixel`).
- **AC-T106-02** Estados renderizados: sem perfil/contas (CTA para Perfis), nenhuma conta incluída, carregando/parcial/pronto, rate limit (dados em cache + aviso) e erros por conta.
- **AC-T106-03** "Atualizar" fica desabilitado por 30 s após o uso; a ordem das colunas de métricas persiste por empresa e "Restaurar" volta ao padrão; métricas pareadas rotuladas "<APP_NAME> / Meta".
- **AC-T106-04** Alternar status na tabela é otimista e desfaz em erro; modal de nome/orçamento sem campo nome para anúncios.
- **AC-T106-05** Perfis: cartões expansíveis, toggle de conta otimista com rollback, toast do retorno do OAuth; Pixel: tabela mascarada e confirmação ao excluir; no `mobile` os filtros ficam num painel.

---

### T85 — UI chats: compositor
**Paths:** `apps/web/src/features/chat-composer/**`
**Depende de:** T75, T64
**Ref:** `03-chats.md#mensagens--envio-f31f42`, `#produtividade-f48f51`.
**Critérios de aceitação**
- **AC-T85-01** Texto com formatação do WhatsApp (*negrito*, _itálico_, ~riscado~); Enter envia e Shift+Enter quebra linha; envio otimista com confirmação pelo SSE.
- **AC-T85-02** Anexos validam limites por tipo no cliente (bloqueia antes de enviar); figurinhas e emojis; Pix como texto com chave copiável.
- **AC-T85-03** Gravar áudio (permissão do microfone simulada no Playwright) e enviar como PTT; durante a gravação os sons de notificação ficam mudos.
- **AC-T85-04** `/` abre as respostas rápidas com busca e insere já com variáveis renderizadas; assinatura `*Nome*:` liga/desliga e persiste.
- **AC-T85-05** Conexão desconectada mostra banner e bloqueia o envio; falha de envio permite tentar de novo.

---

### T86 — UI contatos: formulário, importação e jobs
**Paths:** `apps/web/src/features/{contact-form,contact-jobs}/**`
**Depende de:** T77, T67
**Ref:** `05-contatos.md#31-contato-customer--formulário-…`, `#36-job-de-importação-…`.
**Critérios de aceitação**
- **AC-T86-01** Novo contato: passo de busca prévia (≥ 2 caracteres, debounce 450 ms) mostra duplicados antes do formulário.
- **AC-T86-02** Formulário: telefone com seletor de país e validação E.164, UF → cidade (cidade limpa ao trocar UF), CEP com máscara, etiquetas e campos personalizados; "Salvar e abrir conversa" leva ao chat.
- **AC-T86-03** Importar CSV mostra progresso (SSE, com polling de reserva) e, no fim, o relatório com erros agrupados; o modelo CSV pode ser baixado.
- **AC-T86-04** Painel de exportações recentes com download; exclusão em massa mostra progresso até o fim.

---

### T88 — UI agentes: lista e editor
**Paths:** `apps/web/src/{routes,features}/agents/**` Liberações (2026-10-16, aditivas): `apps/api/src/routes/ai-agents/index.ts` e seu teste db.unit (`GET /api/ai-agents/model-options`, flows.view → `{ providers: [{ provider, available }], models: [{ provider, model }] }`, sem expor chaves), `apps/worker/src/index.ts` (export do job ai-knowledge) e `scripts/e2e/api.ts` (job ai-knowledge no harness).
**Depende de:** T79, T80, T52, T23
**Ref:** `07-agentes-ia.md#2-telas-e-rotas`, `#4-estados-e-transições`.
**Critérios de aceitação**
- **AC-T88-01** `/agentes` com abas Agentes|Vozes, filtros (todos, ativos, rascunhos, pausados), busca e cota "N de M agentes"; limite atingido abre o modal correspondente.
- **AC-T88-02** Editor com abas Foto, Instruções, Habilidades, Conhecimento, Coleta de dados e Configurações; salvar mostra erros do servidor no campo.
- **AC-T88-03** Seletor de modelo lista provedores/modelos disponíveis para a empresa (com chave) e marca os indisponíveis.
- **AC-T88-04** Publicar/Pausar refletem o status; conhecimento mostra o estado de cada fonte atualizado por SSE.

---

### T91 — UI chats: painel lateral e agendamentos
**Paths:** `apps/web/src/features/chat-panel/**`
**Depende de:** T75, T64
**Ref:** `03-chats.md#painel-lateral-do-contato-f52f62`, `#produtividade-f48f51`.
**Critérios de aceitação**
- **AC-T91-01** Painel mostra contato, quadro/etapa do kanban, departamento, responsável ("Atribuir a mim"), etiquetas, notas e fluxos ativos com botão de parar.
- **AC-T91-02** Transferir de departamento tira o chat da lista de quem perde o escopo (teste com dois usuários).
- **AC-T91-03** Agendar mensagem/fluxo (até 31 dias, recorrência) e listar/cancelar agendamentos.
- **AC-T91-04** "Disparar fluxo" lista só fluxos acionáveis e respeita `flows.run`; ações destrutivas pedem confirmação; no `mobile` o painel abre como sheet.

---

### T92 — UI agentes: teste ao vivo, criação assistida e vozes
**Paths:** `apps/web/src/features/{agent-lab,agent-voices}/**`
**Depende de:** T88
**Critérios de aceitação**
- **AC-T92-01** Painel "Teste ao vivo" conversa com o agente (roteiro do FakeLlm via harness) e mostra habilidades disparadas, campos preenchidos e créditos.
- **AC-T92-02** Criação assistida mostra os estágios por SSE e os avisos; ao terminar, abre o agente com o banner "revise antes de publicar".
- **AC-T92-03** Aba Vozes: enviar 1–3 amostras, ouvir a prévia, manter ou excluir.
- **AC-T92-04** Ditado por voz nas instruções usa a transcrição (FakeStt) e insere o texto.

---

### T93 — Assistente (copiloto) de fluxo
**Objetivo:** assistente de IA que lê e edita o fluxo aberto por ferramentas validadas (sem marca).
**Paths:** `packages/core/src/flow-copilot/**`, `apps/api/src/routes/flow-copilot/**`, `packages/db/src/schema/crm/flow-copilot.ts`, `apps/web/src/features/flow-copilot/**`
**Depende de:** T28, T24, T12, T16, T45
**Ref:** `07-agentes-ia.md#39-leona-ai` (renomeado "Assistente de fluxo"), `#7-eventos-realtime`.
**Critérios de aceitação**
- **AC-T93-01** Sessões por fluxo (`GET|POST /api/flow-copilot/sessions`, mensagens, arquivar/reabrir); resposta transmitida por SSE (`copilot.delta`, `copilot.completed`).
- **AC-T93-02** Ferramentas de edição (criar nó, editar ação, ligar handle, remover nó) passam pela validação do T10; alteração inválida volta como erro para o modelo e não grava.
- **AC-T93-03** Toda edição feita pelo assistente publica `flow.graph_updated` com `source: 'ai'` e o canvas atualiza.
- **AC-T93-04** Cota esgotada pausa a sessão (`paused_quota`) e `resume` só funciona com saldo.
- **AC-T93-05** Sem `flows.edit` o assistente só responde perguntas (nenhuma ferramenta de escrita disponível).

---

### T94 — Servidor MCP (token estático)
**Objetivo:** permitir que clientes MCP leiam dados da empresa com token próprio.
**Paths:** `packages/core/src/mcp/**`, `apps/api/src/routes/mcp/**`, `packages/db/src/schema/crm/mcp.ts`, `apps/web/src/{routes,features}/settings-mcp/**`
**Depende de:** T26, T28, T40
**Ref:** `09-webhooks-entrada.md#34-mcpcredential`, `#6-endpoints-da-api` (MCP).
**Entregáveis:** credenciais (`auth_type: static`, hash do token mostrado uma vez, expiração, último uso); endpoint MCP (Streamable HTTP, `@modelcontextprotocol/sdk` — versão a confirmar no context7 antes de usar) com ferramentas **somente leitura** (contatos, conexões, fluxos, chats resumidos) isoladas por empresa; tela `/settings?tab=mcp_credentials`. O tipo `oauth` (conector do Claude) é entregue no T115.
**Critérios de aceitação**
- **AC-T94-01** Criar credencial mostra o token uma única vez; a listagem só mostra nome, status, expiração e último uso.
- **AC-T94-02** Token inválido, expirado ou revogado → 401 no endpoint MCP.
- **AC-T94-03** As ferramentas listadas são só de leitura e devolvem apenas dados da empresa do token.
- **AC-T94-04** A tela permite criar, copiar (uma vez) e revogar, com estado vazio e layout `mobile`.

---

### T95 — Admin: usuários, empresas, limites e cotas
**Paths:** `packages/core/src/admin/**`, `apps/api/src/routes/admin/**`
**Depende de:** T22, T60
**Ref:** `20-admin-interno.md#3-modelo-de-dados--campos` (3.1, 3.2, 3.8), `#5-ações-e-regras-de-negócio`, `#compatibilidade-baileys-clone`.
**Entregáveis:** `GET|POST /api/admin/users`, `GET|PUT /api/admin/users/:id` (e-mail imutável, senha opcional), `GET /api/admin/users/:id/companies`; `GET /api/admin/companies` (busca, owner, usuários), `PATCH /api/admin/companies/:id` (ativa, limites: conexões, agentes, membros, `inbox_limits`), cota de disparos (`GET|PATCH /api/admin/mass-dispatch-settings`, `PATCH /api/admin/companies/:id/mass-dispatch-quota { bonus_delta }`); `GET /api/admin/statistics` (novas empresas, usuários, conexões conectadas, mensagens/dia — sem dinheiro); `admin_audit_log`.
**Critérios de aceitação**
- **AC-T95-01** Qualquer `/api/admin/*` sem `platform_admin` → 403 (inclusive owner de empresa).
- **AC-T95-02** `PUT` de usuário ignora mudança de e-mail e só troca a senha quando informada (≥ 6); toda ação grava `admin_audit_log`.
- **AC-T95-03** Limites de empresa são opcionais (vazio = ilimitado, o padrão) e validados (inteiros ≥ 0); definir o limite de conexões abaixo do atual impede novas, sem desconectar as existentes; remover o limite volta a ilimitado.
- **AC-T95-04** Bônus de disparos soma no período atual sem mudar o limite global; mudar `per_connection_limit` recalcula a cota base.

---

### T96 — Admin: avisos, banners, saúde, sessões WhatsApp e IA
**Paths:** `packages/core/src/admin-ops/**`, `apps/api/src/routes/admin-ops/**`, `packages/db/src/schema/crm/admin.ts`
**Depende de:** T22, T46, T37
**Ref:** `20-admin-interno.md#36-aviso`, `#37-banner`, `#314-infra`, `#39-ia`; `14-notificacoes.md#features` (12–15).
**Critérios de aceitação**
- **AC-T96-01** CRUD de avisos (tipo `info|warning|error|success`, prioridade, expiração, ativo) e banners (imagem obrigatória); o cliente (`GET /api/announcements`, `/api/banners` e bootstrap) recebe só ativos e não expirados, por prioridade decrescente.
- **AC-T96-02** `GET /api/admin/health` devolve por fila BullMQ (waiting/active/failed/delayed/paused), Redis (memória), Postgres (conexões, tamanho) e lag do grupo `crm` no `wsm:events`.
- **AC-T96-03** `GET /api/admin/wa/sessions` lista as sessões de todas as empresas pelo `WaGateway` com estado e empresa dona no perfil `crm`; com `WA_RPC_PROFILE=ai-manager` (modo extensão) a rota responde 404 e o admin mostra só dados do CRM — as sessões ficam no painel do ai-manager.
- **AC-T96-04** Segredos de plataforma (chaves de IA/ElevenLabs/Groq) são só de escrita: a leitura devolve `configured` e máscara; o uso de IA por empresa/modelo agrega `ai_usage`.

---

### T97 — Afiliação: captura de indicação e link externo
**Paths:** `packages/core/src/affiliate/**`, `apps/web/src/features/affiliate/**`
**Depende de:** T36
**Ref:** `13-afiliacao.md` (inteiro).
**Critérios de aceitação**
- **AC-T97-01** `/register?ref=a&via=b` envia `referral_code = a`; só `?via=b` envia `b`; sem query não envia o campo.
- **AC-T97-02** Código com mais de 64 caracteres ou fora de `[A-Za-z0-9_-]` é ignorado.
- **AC-T97-03** Com `AFFILIATE_PORTAL_URL` definida, o item "Programa de afiliados" abre o modal de site externo e depois nova aba com `rel=noopener`; sem a variável, nada aparece.

---

### T98 — Extensão: perfil ai-manager do gateway e documentação
**Objetivo:** deixar o CRM pronto para rodar sobre o ai-manager trocando só configuração.
**Paths:** `packages/wa-gateway-rpc/src/profiles/ai-manager/**`, `docs/extension/**`
**Depende de:** T46
**Ref:** `AI-MANAGER-MAP.md#13-proposta-de-fronteira-de-extensão` (13.4–13.8).
**Entregáveis:** perfil `ai-manager` (mapa de métodos para os alvos RPC atuais do ai-manager + os aditivos A1–A7 da seção 13.5), detecção de capacidades ausentes; `docs/extension/ai-manager.md` com o patch aditivo proposto para o ai-manager (sem alterá-lo), migração de sessões standalone → extensão, variáveis (`WA_RPC_PROFILE=ai-manager`, `WA_RPC_URL`, `INTERNAL_TOKEN`, `DATABASE_URL` do ai-manager) e a regra "um dono por socket"; servidor RPC simulado do ai-manager para teste.
**Critérios de aceitação**
- **AC-T98-01** Contra um servidor RPC que simula **só** os alvos que o ai-manager tem hoje, o gateway com perfil `ai-manager` passa a parte da suíte de contrato correspondente (sessions, send, cancel, groups) e marca o resto como capacidade ausente.
- **AC-T98-02** Com os alvos aditivos simulados (media, presence, contacts), a suíte inteira passa.
- **AC-T98-03** As migrations `crm` aplicadas num banco com o schema do ai-manager (fixture de `public.*`) não alteram tabelas `public`.
- **AC-T98-04** `docs/extension/ai-manager.md` existe e cita cada mudança aditiva (A1–A7) com arquivo de destino no ai-manager.

---

### T108 — Tutoriais e widget de suporte plugável
**Paths:** `apps/web/src/features/{support-widget,tutorials}/**`
**Depende de:** T23
**Ref:** `18-shell-navegacao-tutoriais-suporte.md#91-tutoriais`, `#92-widget-de-chat-de-suporte-…`.
**Critérios de aceitação**
- **AC-T108-01** Com `TUTORIALS_URL`, o item "Tutoriais" aparece para todos os papéis exceto `support` e abre em nova aba (`rel=noopener`); sem a variável, não aparece.
- **AC-T108-02** `SUPPORT_PROVIDER=script` injeta o script uma única vez (mesmo com remontagem) e chama `identify` com e-mail/nome/telefone após carregar, falhando em silêncio após 10 s.
- **AC-T108-03** `SUPPORT_PROVIDER=whatsapp-link` faz "Suporte" abrir `wa.me/<SUPPORT_PHONE>`; `none` esconde os botões.
- **AC-T108-04** Logout ou usuário `support` fecha o widget e limpa as chaves locais do provedor.

---

### T100 — UI admin interno
**Paths:** `apps/web/src/{routes,features}/admin/**`
**Depende de:** T95, T96, T23
**Ref:** `20-admin-interno.md#2-telas-e-rotas`.
**Critérios de aceitação**
- **AC-T100-01** `/admin?tab=` com aba inválida volta para "Visão geral"; o item "Admin" só aparece para `platform_admin`.
- **AC-T100-02** Usuários e Empresas: listas paginadas (20) com busca (debounce 450 ms) que reiniciam ao trocar de aba; modal de usuário valida e-mail e senha ≥ 6.
- **AC-T100-03** Avisos e Banners com upload de imagem e prévia; um aviso ativo aparece como pop-up no app do cliente e respeita "fechar".
- **AC-T100-04** Saúde, Sessões WhatsApp e IA mostram "atualizado às HH:MM" com botão Atualizar (a aba Sessões não aparece no modo extensão); recarga/ajuste de créditos com nota obrigatória e confirmação.

---

### T109 — Pagamentos ao lead: porta, chaves e adapter XPag
**Objetivo:** cobrança ao lead dentro do fluxo, como no produto de referência, atrás de uma porta por gateway. (Não confundir com a porta `BillingProvider` da plataforma, que continua só interface.)
**Paths:** `packages/core/src/payments/{port,keys,xpag}/**`, `apps/api/src/routes/payment-integrations/**`, `packages/db/src/schema/crm/payments.ts`
**Depende de:** T22
**Ref:** `19-integracoes.md#31-payment_integration-chave-de-pagamento-…`, `#46-matriz-gateway--moeda--método-…` (linhas XPag), `#52-xpag--zenith-modal-de-chave`, `#6-endpoints-da-api` (Pagamentos), `#8-permissões`.
**Entregáveis/Contratos:**
- Porta `PaymentGateway { id; supported(): {currency, methods[]}[]; createCharge(req) → { transaction_id, status, checkout_url?, payment_code?, qr_image_url?, bank_info?, expires_at? }; parseWebhook(rawBody, headers) → PaymentEvent[]; testConnection() }` e `PaymentEvent { type: 'payment.approved'|'payment.failed'|'payment.expired'|'payment.refunded', transaction_id, amount_cents, currency, paid_at }`.
- `payment_integrations` (empresa, `label` ≥ 2, `gateway` fixo após criar, `client_id`, `client_secret` cifrado, `secret_configured`, `secret_hint`, `webhook_secret` cifrado, `webhook_url` derivada), `payment_charges` (empresa, integração, run/contato, valor, moeda, método, `transaction_id`, status `created|approved|failed|expired|refunded`, `listener_until`).
- CRUD `GET|POST /api/payment-integrations`, `PUT|DELETE /:id`, `POST /:id/test-connection`; permissão `settings.integrations.*`.
- Adapter **XPag** (BRL PIX; MXN SPEI/OXXO; COP NEQUI/BREB; ARS sem "chave sem valor"; limites OXXO MX$10–10.000 e COP ≥ 10.000) com `XPAG_API_URL` e `FakeXPag` (servidor HTTP local). **Contrato HTTP real (XPag):** não há sandbox. O Operário pesquisa a **documentação pública** (WebSearch/WebFetch), implementa por ela, **cita a(s) URL(s)** no cabeçalho do adapter e em `docs/integrations/xpag.md` (endpoints, autenticação, formato do webhook e assinatura) e testa contra o fake; a validação com chave real fica com o usuário depois. `BLOCKED` só se não existir documentação pública.
- O gateway "Leona Pay" **não** é implementado (ver 10.3).
**Critérios de aceitação**
- **AC-T109-01** Segredos (`client_secret`, `webhook_secret`) nunca aparecem em resposta nem em log; editar com segredo vazio mantém o atual; trocar o `gateway` → 422.
- **AC-T109-02** `test-connection` chama o `FakeXPag` e devolve `{ ok: true }`; credencial recusada pelo fake → `{ ok: false, error }` sem expor a chave.
- **AC-T109-03** `createCharge` no XPag com BRL/PIX devolve `transaction_id` e código copia-e-cola; combinação moeda × método fora da matriz → erro de validação antes da chamada; ARS com "chave sem valor" → erro "em breve".
- **AC-T109-04** `parseWebhook` do XPag com assinatura válida converte o payload do fake em `payment.approved`; assinatura inválida → erro e nenhum evento.
- **AC-T109-05** Excluir integração usada por bloco Pagamento de fluxo ativo → 409 com a lista de fluxos.

---

### T110 — Pagamentos ao lead: adapter Zenith (chave, OAuth e webhook)
**Paths:** `packages/core/src/payments/zenith/**`, `apps/api/src/routes/zenith-oauth/**`
**Depende de:** T109
**Ref:** `19-integracoes.md#46-…` (linhas Zenith), `#47-estados-de-callback-oauth`, `#52-xpag--zenith-modal-de-chave`.
**Entregáveis:** adapter **Zenith** (BRL pix; COP pse/bre-b-llave/nequi; MXN oxxo/spei/codi; PEN yape/plin/bank-transfer/cash; ARS bank-transfer; INR upi; PHP gcash/maya; com as expirações e validações de telefone/documento da matriz) por chave (`X-API-Key`/`X-API-Secret`) ou OAuth (`POST /api/zenith-oauth/start {label?, installation_id?}` → `oauth_url`; `POST /api/zenith-oauth/exchange {code, state}` no servidor; `state` assinado empresa+usuário e de uso único); registro automático do webhook na Zenith ao conectar; `POST /api/payment-integrations/:id/rotate-credentials`; `FakeZenith`. **Contrato HTTP real (Zenith):** não há sandbox. O Operário pesquisa a **documentação pública** (WebSearch/WebFetch), implementa por ela, **cita a(s) URL(s)** no cabeçalho do adapter e em `docs/integrations/zenith.md` (endpoints, autenticação, formato do webhook e assinatura) e testa contra o fake; a validação com chave real fica com o usuário depois. `BLOCKED` só se não existir documentação pública.
**Critérios de aceitação**
- **AC-T110-01** OAuth: `start` devolve URL com `state` assinado; `exchange` com `state` inválido, reutilizado ou de outra empresa → erro e nenhuma integração criada; válido → integração com `zenith_oauth = true` e chaves só no servidor.
- **AC-T110-02** Ao conectar, o webhook é registrado no `FakeZenith` com a URL pública da integração (`zenith_webhook_url` exibida somente leitura).
- **AC-T110-03** `createCharge` respeita moeda × método e validações (Nequi exige celular colombiano de 10 dígitos começando com 3; GCash/Maya celular filipino; BRL pix exige nome, e-mail e CPF/CNPJ) antes de chamar o fake.
- **AC-T110-04** `rotate-credentials` troca as credenciais no fake e a antiga deixa de funcionar; webhook do fake com pagamento aprovado vira `payment.approved`.

---

### T111 — Bloco Pagamento no fluxo e confirmação por webhook
**Paths:** `packages/core/src/flows/nodes/payment/**`, `packages/core/src/payments/webhooks/**`, `apps/api/src/routes/hooks-payments/**`, `apps/worker/src/jobs/payment-webhooks/**`
**Depende de:** T109, T30
**Ref:** `19-integracoes.md#38-bloco-pagamento-do-fluxo-…`, `#55-mapeamento-evento-de-pagamento--ações`; `06-fluxos.md#35-tipos-de-nó-…` (payment).
**Entregáveis:** handler do nó `payment` (`create_payment_charge`: gateway, integração, moeda, método, valor com variáveis e "chave sem valor", dados do pagador com variáveis, escuta por `listener_ttl`), saídas `charge_created`, `payment_approved`, `error`; variáveis expostas (`{gateway.transaction_id}`, `{gateway.checkout_url}`, `{gateway.payment_code}`, `{gateway.qr_url}`, `{gateway.value}`, `{gateway.error}`); espera `kind: 'payment'` até o fim do TTL; endpoint público `POST /api/hooks/payments/:integrationId/:token` (202 + fila `payment-webhooks`), idempotente por `transaction_id`. Formatos e assinaturas de webhook seguem o que T109/T110 documentaram a partir da documentação pública de cada gateway.
**Critérios de aceitação**
- **AC-T111-01** O nó cria a cobrança (fake), segue `charge_created` com as variáveis preenchidas e deixa o run esperando a confirmação.
- **AC-T111-02** Webhook de pagamento aprovado dentro do TTL retoma o run pelo handle `payment_approved` e preenche `{gateway.value}`; o mesmo webhook entregue duas vezes retoma uma vez só.
- **AC-T111-03** Webhook depois do TTL só atualiza `payment_charges` (não retoma o run); erro do gateway na criação segue `error` com `{gateway.error}`.
- **AC-T111-04** Token inválido no endpoint público → 404; assinatura inválida → 401 e nada é processado.
- **AC-T111-05** O valor aceita vírgula ou ponto e variáveis (`{preco}`); "chave sem valor" cria cobrança sem valor fixo e usa o valor pago informado pelo webhook.

---

### T112 — Emissão de NF (Notasy) na venda aprovada
**Paths:** `packages/core/src/invoicing/**`, `apps/api/src/routes/invoice-integrations/**`, `apps/worker/src/jobs/invoices/**`, `packages/db/src/schema/crm/invoicing.ts`
**Depende de:** T34, T22
**Ref:** `19-integracoes.md#32-invoice_integration-emissor-de-nf-…`, `#42-status-de-emissão-de-nf-da-venda-…`, `#54-emissão-de-nf-notasy`, `#6-endpoints-da-api` (Emissores de NF).
**Entregáveis:** porta `InvoiceIssuer { issue(sale, customer, product) → { external_id, status, pdf_url? } }` + adapter **Notasy** (`NOTASY_API_URL`, token por empresa) + `FakeNotasy`; `invoice_integrations` (provedor `notasy`, nome da empresa ≥ 2, token cifrado, `token_configured`); `sale_invoices` (venda, emissor, status conforme 19#4.2, tentativas, erro, número/PDF); job na fila `invoices` disparado por `sale.recorded` quando a venda tem `note_issuer_id`; `POST /api/sales/:id/reemit-invoice { invoice_integration_id? }`; CRUD `/api/invoice-integrations`. **Contrato HTTP real (Notasy):** não há sandbox. O Operário pesquisa a **documentação pública** (WebSearch/WebFetch), implementa por ela, **cita a(s) URL(s)** no cabeçalho do adapter e em `docs/integrations/notasy.md` (endpoints, autenticação, formato do webhook e assinatura) e testa contra o fake; a validação com chave real fica com o usuário depois. `BLOCKED` só se não existir documentação pública.
**Critérios de aceitação**
- **AC-T112-01** Venda aprovada com `note_issuer_id` enfileira uma emissão; o fake responde e o status da nota passa pelos estados de 19#4.2 até emitida, com evento `sale.updated`.
- **AC-T112-02** Venda sem `note_issuer_id` não emite; emissor sem token configurado → status de erro "emissor não configurado".
- **AC-T112-03** Falha do fake → nova tentativa com backoff (no máximo 3) e depois status de erro com a mensagem; `reemit-invoice` reenfileira, inclusive escolhendo outro emissor.
- **AC-T112-04** O token nunca aparece em resposta nem em log; excluir emissor usado por bloco "Venda aprovada" avisa que o bloco deixará de emitir.

---

### T113 — UTMify: integração e envio de vendas aprovadas
**Paths:** `packages/core/src/utmify/**`, `apps/api/src/routes/utmify/**`, `apps/worker/src/jobs/utmify/**`, `packages/db/src/schema/crm/utmify.ts`
**Depende de:** T34, T22
**Ref:** `11-facebook-ads.md#36-utmify_integration-…`, `19-integracoes.md#34-utmify_integration--ver-arquivo-11`, `#39-bloco-venda-aprovada-…`.
**Entregáveis:** porta `SalesTracker { pushSale(sale, attribution) }` + adapter **UTMify** (`UTMIFY_API_URL`) + `FakeUtmify`; `utmify_integrations` (nome da empresa ≥ 2, token cifrado, `token_configured`); job na fila `utmify` disparado por `sale.recorded` quando a venda tem `utmify_integration_id`, enviando valor, moeda, produto, cliente e atribuição (`utm_*`, `source_id`/CTWA) e o status (aprovada, reembolsada); CRUD `/api/utmify-integrations`. **Contrato HTTP real (UTMify):** não há sandbox. O Operário pesquisa a **documentação pública** (WebSearch/WebFetch), implementa por ela, **cita a(s) URL(s)** no cabeçalho do adapter e em `docs/integrations/utmify.md` (endpoints, autenticação, formato do webhook e assinatura) e testa contra o fake; a validação com chave real fica com o usuário depois. `BLOCKED` só se não existir documentação pública.
**Critérios de aceitação**
- **AC-T113-01** Venda aprovada com `utmify_integration_id` envia um evento ao fake com valor, moeda, produto e os `utm_*` do contato.
- **AC-T113-02** Reembolso da mesma venda envia atualização de status; o mesmo evento não é enviado duas vezes (idempotência por venda + status).
- **AC-T113-03** Erro do fake → retry com backoff e, esgotado, registro de falha visível na venda.
- **AC-T113-04** Token só de escrita (nunca devolvido nem logado).

---

### T114 — UI: pagamentos, NF, UTMify e editores dos blocos Pagamento e Venda aprovada
**Paths:** `apps/web/src/{routes,features}/settings-payments/**`, `apps/web/src/features/flow-editor/node-editors/payment/**`, `apps/web/src/features/sale-invoice/**`, i18n `settings-payments`
**Depende de:** T110, T111, T112, T113, T45, T59
**Ref:** `19-integracoes.md#2-telas-e-rotas`, `#25-modais`, `#51-hub`, `#52-xpag--zenith-modal-de-chave`, `#38-bloco-pagamento-…`, `#39-bloco-venda-aprovada-…`.
**Critérios de aceitação**
- **AC-T114-01** O hub de integrações ganha os cards de Pagamentos (XPag, Zenith), NF (Notasy) e UTMify (registrados no catálogo compartilhado), com status Ativo/Inativo e busca.
- **AC-T114-02** Modal de chave XPag/Zenith: validações do servidor, segredo mascarado, "Testar conexão" na edição; "Conectar com Zenith" leva ao OAuth (fake) e volta com toast de sucesso ou erro.
- **AC-T114-03** Editor do bloco Pagamento mostra só moedas e métodos válidos para o gateway escolhido (matriz 19#4.6), campos condicionais por método e as saídas `charge_created`/`payment_approved`/`error` no canvas.
- **AC-T114-04** Editor do bloco Venda aprovada: produto (com "+ Criar novo produto…"), valor/moeda/cliente com variáveis, emissor de NF ("Não emitir nota automaticamente") e UTMify ("Não enviar para UTMify"), título e corpo do push.
- **AC-T114-05** No histórico de vendas, a venda mostra o status da nota e o botão "Reemitir nota", que reenfileira e mostra "Emissão reenfileirada"; textos em pt-BR, en e es; layout `mobile` sem rolagem horizontal.

---

### T115 — MCP: OAuth para conectores (Claude)
**Objetivo:** credenciais MCP do tipo `oauth` exigidas pela spec 09, para conectores como o do Claude.
**Paths:** `packages/core/src/mcp-oauth/**`, `apps/api/src/routes/mcp-oauth/**`, `packages/db/src/schema/crm/mcp-oauth.ts`, `apps/web/src/features/mcp-oauth/**`, i18n `mcp-oauth`
**Depende de:** T94
**Ref:** `09-webhooks-entrada.md#34-mcpcredential`, `#4-estados-e-transições`, `#5-ações-e-regras-de-negócio` (item 9). Especificação de autorização do MCP e versão do `@modelcontextprotocol/sdk`: confirmar no context7 antes de implementar.
**Entregáveis:** servidor de autorização OAuth 2.1 para o endpoint MCP da empresa: metadados (`/.well-known/oauth-authorization-server` e `oauth-protected-resource`), registro dinâmico de cliente, `/authorize` com login do usuário e tela de consentimento (escolhe a empresa), PKCE S256 obrigatório, `/token` com access token curto + refresh token (hash no banco), revogação; credencial `auth_type: oauth` com status `pending → connected` (com `connected_client_hint`) → revogada; UI de criação mostra a URL e os passos do conector.
**Critérios de aceitação**
- **AC-T115-01** Fluxo completo com cliente de teste: registro dinâmico → `/authorize` (login + consentimento) → código → `/token` com PKCE válido → token aceito no endpoint MCP; PKCE inválido ou ausente → `invalid_grant`.
- **AC-T115-02** A credencial passa de `pending` para `connected` com o nome do cliente; revogar invalida access e refresh tokens na hora (401 no endpoint MCP).
- **AC-T115-03** O token OAuth só dá acesso à empresa escolhida no consentimento, com as mesmas ferramentas somente leitura do T94.
- **AC-T115-04** Refresh token usado duas vezes (reuso) revoga a cadeia inteira.
- **AC-T115-05** Na UI, criar credencial do tipo OAuth mostra a URL do servidor MCP e as instruções do conector; o status muda para "Conectada · <cliente>" ao recarregar após a conexão (desktop e `mobile`).

### T124 — Harness E2E: reset serializado e limpeza de bancos órfãos
**Objetivo:** dois defeitos do harness (T17/T122) vistos sob carga: (a) `POST /__e2e/reset` passa de 15 s, o cliente desiste e o próximo reset começa por cima → 500 duplicate key (seed); (b) bancos `crm_e2e_*`/`crm_test_*`/`crm_acc_*` de execuções mortas acumulam (72 apagados à mão em 2026-10-16, após o Postgres cair por memória).
**Paths:** `scripts/e2e/**`, `apps/api/src/e2e/**`.
**Depende de:** T17, T122
**Entregáveis:** (1) reset serializado no servidor (mutex: um reset por vez; o segundo espera o primeiro) e timeout do reset configurável (padrão ≥ 60 s); (2) ao subir, o harness remove bancos de teste do projeto (`crm_e2e_*`, `crm_test_*`, `crm_acc_*`) SEM conexão ativa e mais antigos que N minutos (padrão 30), nunca outros bancos.
**Critérios de aceitação**
- **AC-T124-01** Dois `POST /__e2e/reset` simultâneos terminam ambos com 200 e o seed fica íntegro (sem 500 por chave duplicada).
- **AC-T124-02** Ao subir, o harness apaga bancos de teste do projeto sem conexão e antigos, e preserva: bancos com conexão ativa, recentes, e qualquer banco fora dos prefixos de teste (ex.: `crm`, `postgres`, `wsm*`).
- **AC-T124-03** O timeout do reset vem de `E2E_RESET_TIMEOUT_MS` (padrão ≥ 60000) e aparece no `e2e-server.json`.

### T126 — Estabilidade dos testes sob carga (filas, Redis, teardown e relógio)
**Objetivo:** acabar com as falhas intermitentes que reprovaram gates de integração em 2026-10-16 quando vários pares rodam suítes ao mesmo tempo. Detalhes dos casos em `spec/STATUS.md` (linhas "testes instáveis").
**Paths:** `apps/*/vitest.config.ts`, `packages/*/vitest.config.ts`, `apps/*/src/test-setup*.ts`, `packages/*/src/test-setup*.ts`, `packages/db/src/testing.ts`, `packages/db/src/seed/index.ts` (só `resetDatabase`), `apps/*/src/**/*.unit.test.ts`, `packages/*/src/**/*.unit.test.ts`, `docs/testing.md`.
**Depende de:** T121, T124, T125
**Entregáveis:** (1) Prefixo de fila BullMQ (`CRM_QUEUE_PREFIX`/`WA_QUEUE_PREFIX`) único **por arquivo de teste**, e não só por execução (hoje vem do `vitest.config.ts` e é dividido por todos os arquivos da mesma execução). (2) Os testes que usam Redis db fixo (`apps/api/src/e2e/e2e.db.unit.test.ts` e `e2e-reset.db.unit.test.ts`, db 13) passam a usar um espaço isolado por execução (db livre ou prefixo de chaves) sem perder o que o AC-T17-03 prova. (3) Teardown seguro: workers, filas e pools em segundo plano são fechados ANTES do `drop()` do banco temporário; o `drop()` do `createTempDatabase` não derruba conexões vivas de outro arquivo. (4) O teste de buffer do AC-T68-01 (`packages/core/src/ai-runtime/runtime.db.unit.test.ts`) e outros com `sleep` real para medir janelas de tempo usam relógio injetável ou fake timers. (5) `docs/testing.md` com as regras (prefixo por arquivo, teardown, sem sleep para medir tempo).
**Regra:** nenhuma asserção de produto muda de significado; só a infraestrutura dos testes e a forma de medir o tempo. Código de produção só pode mudar para expor um relógio injetável, sem alterar comportamento. Exceção autorizada (2026-10-16): `resetDatabase` (usado só pelo harness E2E) pode trocar o TRUNCATE por DELETE das tabelas com linhas, em ordem de FK, reiniciando as sequências, desde que o estado final seja o mesmo (com teste unitário que prove). Segunda exceção autorizada (2026-10-16, rejeição 1): `sendSaleToPixels` (`packages/core/src/meta-capi/sales.ts`) lança erro retentável quando a venda ainda não está visível (job enfileirado antes do commit do passo do fluxo), em vez de concluir sem enviar; o enqueue/backoff do job meta-capi (`apps/worker/src/jobs/meta-capi/index.ts`) permite o retry em poucos segundos; tentativas limitadas, e uma venda que nunca aparece termina `failed`.
**Critérios de aceitação**
- **AC-T126-01** Dois arquivos de teste da mesma execução do vitest recebem prefixos de fila diferentes, e um worker de um arquivo nunca consome um job enfileirado pelo outro (prova com dois arquivos de fixture e a mesma fila).
- **AC-T126-02** Duas execuções simultâneas de `pnpm --filter @crm/api test` no mesmo Redis e Postgres terminam as duas sem falhas (inclui AC-T17-03 do reset ≤ 3 s em cada uma).
- **AC-T126-03** As suítes completas de `@crm/api`, `@crm/core` e `@crm/worker` passam 3 vezes seguidas com outra suíte completa rodando em paralelo, sem nenhuma falha e sem erro 57P01 (admin_shutdown) no log.
- **AC-T126-04** O AC-T68-01 (buffer do agente) e o AC-T125-02 (Purchase da fila meta-capi) passam 10 vezes seguidas sob carga de CPU (outra suíte em paralelo).

### T125 — Montagem de produção da Meta (insights, CAPI e vendas ao Pixel)
**Objetivo:** fechar as pendências de montagem da T101 e da T104.
**Paths:** `apps/worker/src/boot/**`, `apps/api/src/server.ts`.
**Depende de:** T101, T104, T120
**Entregáveis:** `startProductionWorker` chama `configureMetaAds({ db, redis, publisher })` e `configureMetaCapi({ db })`; API e worker envolvem o publisher com `capiSalePublisher(publisher, { enqueue: metaCapiEnqueuer() })`; `.env.example` ganha `META_CAPI_TEST_EVENT_CODE` (opcional, aditivo).
**Critérios de aceitação**
- **AC-T125-01** Montado como produção (padrão da T120) com FakeMetaGraph: `GET /api/meta/structure-bundle?async=1` é processado pelo worker (job meta-sync) e fica `ready`.
- **AC-T125-02** Montado como produção: uma venda aprovada (API de vendas da T34 ou nó approved_sale) gera exatamente 1 evento Purchase no FakeMetaGraph para o pixel com `auto_send_sales`, com `event_id` sale-<id>.
- **AC-T125-03** Repetir a mesma venda (mesmo external_id) não gera um segundo evento no FakeMetaGraph.

### T123 — Montagem: eventos dos nós de lógica e CRM e alias customer.name
**Objetivo:** fechar as pendências de montagem da T41 e da T63 (os nós funcionam mas não publicam no SSE em produção) e a paridade de variável apontada na T85.
**Paths:** `apps/worker/src/boot/**`, `packages/core/src/templating/**`.
**Depende de:** T41, T63, T120
**Entregáveis:** (1) `startProductionWorker` chama `configureLogicNodes({ publisher })` e `configureCrmNodes({ publisher })` com o `RealtimePublisher` do processo. (2) O render (T11) aceita `{{customer.name}}` como alias de `full_name` (e `{name}` se a referência usar), sem mudar as variáveis existentes.
**Critérios de aceitação**
- **AC-T123-01** Montado como produção (padrão da T120): um run que passa por um nó distribuidor publica `flow.distributor_updated` recebido por um cliente SSE da empresa.
- **AC-T123-02** Montado como produção: um nó de etiqueta publica `contact.updated`, um nó de status publica `chat.updated` e um nó de venda aprovada publica `notification.created`, todos recebidos via SSE.
- **AC-T123-03** `{{customer.name}}` renderiza o nome completo do contato; os testes de templating existentes (T11) continuam passando sem alteração.

### T122 — Redis do harness E2E por worktree e disparos na montagem de produção
**Objetivo:** dois achados das ondas 7–8: (a) o harness E2E (T17/T118) usa Redis db 14 fixo e dois harnesses simultâneos dividem o stream `wsm:events`/grupo `crm`, perdendo eventos (T75); (b) o boot de produção (T120) não chama `configureMassDispatch` (T74).
**Paths:** `scripts/e2e/**`, `apps/worker/src/boot/**`.
**Depende de:** T74, T118, T120
**Entregáveis:** (1) `serve.mjs` deriva do worktree (mesmo hash das portas da T118) o db do Redis OU os nomes de stream/prefixos usados pelo harness, sobrescrevível por `E2E_REDIS_URL`; documentar em `docs/`. (2) `startProductionWorker` chama `configureMassDispatch({ db, wa, redis })`.
**Critérios de aceitação**
- **AC-T122-01** Dois harnesses de worktrees diferentes rodando ao mesmo tempo: cada `message.inbound` emitido por `/__e2e/wa/emit` em um deles é entregue ao worker daquele harness (0 perdas em 20 eventos por harness).
- **AC-T122-02** No worker montado como produção (padrão da T120), um disparo em massa criado pela API (T60) é preparado e envia ao menos 1 mensagem pelo wa-worker fake, terminando `completed`.
- **AC-T122-03** Com `E2E_REDIS_URL` definida, o harness usa exatamente aquele Redis (db/streams), e o arquivo `test-results/e2e-server.json` registra o Redis efetivo usado.

### T121 — Isolamento de filas BullMQ nos testes e remetente flow
**Objetivo:** eliminar a interferência entre worktrees: as filas do CRM têm nome/prefixo fixos e todos usam o Redis db 1, então workers de testes de um worktree consomem jobs de outro (runs presos, imports em queued — observado na T120).
**Paths:** `packages/core/src/jobs/**`, `packages/db/src/schema/crm/chats.ts`, `apps/*/vitest.config.ts`, `packages/*/vitest.config.ts` (o Tester ajusta `tests/acceptance/vitest.config.ts`/helpers).
**Depende de:** T09, T120
**Entregáveis:** (1) o prefixo padrão das filas/workers do CRM vem de `CRM_QUEUE_PREFIX` (padrão `crm`), lido no momento da criação; documentar no `.env.example` (aditivo). (2) Todas as suítes (vitest de apps/packages e aceitação) definem um prefixo único por execução (ex.: `crm-t-<pid>-<rand>`) antes de importar o código. (3) `MESSAGE_SENDER_TYPES` inclui `flow` (usado pela T120 com cast).
**Critérios de aceitação**
- **AC-T121-01** Dois workers do CRM com `CRM_QUEUE_PREFIX` diferentes no MESMO Redis db: um job enfileirado num prefixo só é processado pelo worker daquele prefixo.
- **AC-T121-02** As configs de teste de todos os apps/packages e da aceitação definem um `CRM_QUEUE_PREFIX` único por execução (verificável lendo o ambiente dentro de um teste).
- **AC-T121-03** `MESSAGE_SENDER_TYPES` contém `flow`; uma mensagem gravada por `recordOutbound` com sender_type `flow` tipa sem cast.

### T120 — Montagem de produção e registro de mensagens automáticas no chat
**Objetivo:** fechar as ligações de produção que cada tarefa deixou documentadas (spec/STATUS.md, "Pendências") e provar o sistema MONTADO como em produção: `WA_GATEWAY=rpc` com o wa-worker real (`WA_TRANSPORT=fake`), API e worker como processos ou montados pelas mesmas funções de boot.
**Paths:** `apps/worker/src/boot/**`, `apps/worker/src/main.ts`, `apps/api/src/server.ts`, `packages/core/src/chats/send/**`, `packages/core/src/chats/lifecycle/**`, `packages/core/src/flows/nodes/messaging/**`, `packages/core/src/flows/triggers/**`, `packages/core/src/ai-runtime/**`.
**Depende de:** T24, T27, T38, T46, T48, T51, T61, T67, T68
**Entregáveis:** (1) boot do worker chama `configureExports` (T27), `configureContactsImport` (T67), `configureFlowTriggers` (T61), `configureFlowStep` com as deps dos nós de mensagem (`mediaUrl` via MediaService, `record`) e `configureAiAgent` com `createCompanyLlmProvider({ keys })` (BYOK, T38), `UsageGuard` (T24) e TTS/STT por empresa (`resolveTts/resolveStt`); API e worker apontam para o mesmo `STORAGE_DIR`. (2) `ChatSendService.recordOutbound` grava em `crm.messages` uma mensagem já enviada (sender_type `flow` ou `system`, actor, sem reenviar) e publica `message.created`; usado pelos nós de mensagem (T51 `deps.record`) e pela ação fora do horário (T61). (3) Resolver o chat (lifecycle T48) chama `FlowTriggers.handleAttendanceFinished`. (4) O worker publica `flow_run.updated` nas mudanças de estado dos runs.
**Critérios de aceitação**
- **AC-T120-01** Montado como produção: mensagem recebida que casa uma palavra-chave dispara o fluxo; o nó de mensagem envia 1 vez pelo wa-worker e a mensagem aparece em `GET /api/chats/:id/messages` com `sender_type: flow` (sem envio duplicado).
- **AC-T120-02** Fora do horário configurado, a mensagem automática é enviada e aparece no histórico do chat com `sender_type: system`.
- **AC-T120-03** Agente de IA ativo com chave BYOK da empresa responde (LLM falso injetado pelo resolvedor da empresa) e grava 1 linha em `ai_usage`; com a carteira esgotada, nenhuma chamada ao LLM é feita.
- **AC-T120-04** Importação de contatos (CSV, T67) e uma exportação (kind registrado no teste; a exportação de contatos em si é da T66) rodam no worker montado e terminam `completed`, com o arquivo no `STORAGE_DIR` compartilhado e baixável pela API.
- **AC-T120-05** Resolver um chat dispara o gatilho de "atendimento finalizado" configurado na conexão; uma mudança de estado de run publica `flow_run.updated` via SSE.

### T118 — Harness de testes: E2E sem travar, porta por worktree, timeouts para máquina compartilhada
**Objetivo:** tornar a suíte confiável com 4 pares testando em paralelo na mesma máquina (falhas transitórias observadas nas ondas 3–5).
**Paths:** `scripts/e2e/**`, `apps/*/vitest.config.ts`, `packages/*/vitest.config.ts` (o Tester ajusta `tests/acceptance/playwright.config.ts` e `tests/acceptance/vitest.config.ts`).
**Depende de:** T17, T23
**Entregáveis:** (1) `serve.mjs` nunca herda o stdin nos processos filhos (build do web com `stdio: ['ignore', 'inherit', 'inherit']`). (2) Portas do harness derivadas do worktree (ex.: `E2E_API_PORT`/`E2E_WEB_PORT` por hash do caminho, sobrescrevíveis por env) e `reuseExistingServer` só quando a porta é do próprio worktree. (3) `testTimeout`/`hookTimeout` dos vitest de apps e packages: 30 s / 60 s; testes de tempo real com folga explícita.
**Critérios de aceitação**
- **AC-T118-01** Num checkout sem `apps/web/dist`, `node scripts/e2e/serve.mjs` faz o build e fica pronto (sem travar) em ≤ 180 s.
- **AC-T118-02** Dois worktrees diferentes sobem o harness ao mesmo tempo em portas diferentes; o Playwright de cada um fala com o seu próprio servidor.
- **AC-T118-03** Os `vitest.config.ts` de todos os apps e packages declaram `testTimeout` ≥ 30000 e `hookTimeout` ≥ 60000.

### T119 — Escopo de chat nas rotas de mensagens e mídia (segurança)
**Objetivo:** fechar o vazamento apontado na T48: as rotas da T49 não aplicam o escopo de chat (T31/T48).
**Paths:** `apps/api/src/routes/chat-messages/**`, `apps/api/src/routes/media/**`, `packages/core/src/chats/send/**`.
**Depende de:** T48, T49
**Entregáveis:** todas as rotas de mensagens (listar, enviar, mídia, ler, reagir, apagar, encaminhar) resolvem o chat por `ChatQueryService.row(actor, id)` (T48); chat fora do escopo → 404, sem efeito colateral (nada gravado, nada enviado ao gateway).
**Critérios de aceitação**
- **AC-T119-01** Membro com escopo do departamento X recebe 404 ao listar mensagens, enviar texto, enviar mídia, marcar como lido, reagir e apagar num chat do departamento Y; o FakeWaGateway não registra envio.
- **AC-T119-02** Owner/admin e membro sem restrição continuam conseguindo todas essas ações; um membro passa a ver o chat assim que ganha o escopo.
- **AC-T119-03** Encaminhar uma mensagem de um chat fora do escopo → 404.

### T117 — Ajustes de integração: logout encerra SSE, shutdown do hub, cache de chaves único
**Objetivo:** fechar pendências cruzadas encontradas na integração das ondas 2–3 (T13/T15/T16 feitas em paralelo).
**Paths:** `apps/api/src/routes/auth/**`, `apps/api/src/server.ts`, `packages/wa-engine/src/transport/baileys.ts`, `packages/wa-engine/src/auth-state/index.ts` (só para marcar o store cacheável).
**Depende de:** T13, T15, T16
**Entregáveis:** (1) `POST /api/auth/logout` chama `RealtimePublisher.endSession(sessionId)` (T16) após revogar a sessão; o reset de senha (T15, que revoga todas as sessões) chama `endUserSessions(userId)`. (2) `server.ts` chama `stopRealtimeHub(redis)` no shutdown, antes de fechar o Redis. (3) `BaileysTransport` não reaplica `makeCacheableSignalKeyStore` quando o auth state recebido já é cacheável (T06 já envolve); um único cache por sessão.
**Critérios de aceitação**
- **AC-T117-01** Com um cliente SSE conectado em `/api/events`, `POST /api/auth/logout` da mesma sessão fecha o stream em **< 2 s** (sem esperar o heartbeat); outra sessão do mesmo usuário continua recebendo eventos.
- **AC-T117-02** Concluir um reset de senha (`PATCH /api/auth/password-resets/:token`) fecha em < 2 s todos os streams SSE abertos daquele usuário.
- **AC-T117-03** O `server.ts` (processo real) com um cliente SSE conectado encerra com exit 0 em < 5 s após SIGTERM/`process.emit('SIGTERM')`.

---

### T127 — Montagem de produção: webhooks, fontes de venda, pagamentos, nós externos e IA
**Objetivo:** fechar as pendências de "montagem do worker" acumuladas no `spec/STATUS.md` (T42, T52, T73, T79, T81, T111 e o job travado em `queued` da T27), para que o worker de produção execute tudo o que já passa nos testes de unidade.
**Paths:** `apps/worker/src/boot/**`, `apps/worker/src/main.ts`, `apps/worker/src/jobs/exports/**`, `packages/core/src/exports/**`.
**Depende de:** T42, T47 (projeção de `connection_state`, exigida pelo processador de webhooks no AC-T127-01), T52, T73, T79, T81, T111, T125
**Entregáveis:** em `configureWorkerProduction` (padrão da T120/T125, com as dependências do processo e filas criadas no primeiro uso): (1) `configureInboundWebhooks({ db, engine, control, redis, publisher })` com o `FlowControl` e o registry do processo, e `scheduleInboundWebhooksSweep` no start do worker. (2) `configureInboundSales({ db, publisher: capiSalePublisher(...), capiEnqueue })` reaproveitando o `capiEnqueue` preguiçoso da T125. (3) `configurePaymentWebhooks({ db, control })` com o mesmo `FlowControl` e `configurePaymentNodes({ paymentIntegrations })` com o cipher/env de produção. (4) `configureExternalNodes({ llm, llmForKey, guard })`: `llmForKey` via `AiKeysService.credentialsForKey` e o `UsageGuard` do processo. (5) `configureAiKnowledge({ db, redis })` e `knowledge: new AiKnowledgeService({ db }).asKnowledgeSearch()` no `configureAiAgent`. (6) `configureAiAgentLab({ db, redis, llm, guard, publisher })` com o LLM do processo (inclusive o fake de `AI_MODE=fake`). (7) Job de `crm.background_jobs` cujo processor lança erro antes do runner fica `failed` com a mensagem, e não `queued` para sempre.
**Critérios de aceitação**
- **AC-T127-01** Montado como produção: um POST na URL pública de um webhook de entrada com fluxo vinculado é processado pelo worker (o request sai de `pending` com `processed_at` preenchido) e inicia o fluxo para o contato do mapeamento; o agendador da varredura de pendentes fica registrado na fila.
- **AC-T127-02** Montado como produção: um evento aprovado numa fonte de venda (T73) cria a venda e gera exatamente 1 Purchase no FakeMetaGraph para o pixel com `auto_send_sales`; um evento que nasce `pending` não gera Purchase, e a mesma venda passando a `approved` gera exatamente 1.
- **AC-T127-03** Montado como produção: num fluxo com bloco Pagamento (T111) aguardando, o webhook de confirmação do gateway (fake) retoma o run pela saída `paymentApproved`.
- **AC-T127-04** Montado como produção: o nó de IA de um fluxo grava uma linha em `ai_usage` com `feature = 'flow_ai'`; com `ai_integration_id` usa a chave daquela integração; com a cota esgotada, o nó segue a saída de falha sem chamar o LLM.
- **AC-T127-05** Montado como produção: um documento enviado à base de conhecimento de um agente é processado pelo job ai-knowledge (fica pronto) e o turno do agente (FakeLlm) recebe o trecho buscado da base.
- **AC-T127-06** Montado como produção: o teste ao vivo do agente (job ai-agent-lab, T79) usa o LLM do processo (o FakeLlm configurado registra a chamada) e mede o consumo pelo `UsageGuard`.
- **AC-T127-07** Um job de exportação cujo kind não tem processor configurado (ou cujo processor lança erro antes do runner) termina com `status = 'failed'` e a mensagem do erro em `crm.background_jobs`.

### T128 — Harness de testes: banco-modelo por hash das migrações
**Objetivo:** baratear a criação de bancos descartáveis (revisão 2, SPEC 10.1 nº 12): migrar uma vez e clonar com `CREATE DATABASE … TEMPLATE`, em vez de rodar todas as migrações em cada `createTempDatabase({ migrate: true })` e em cada subida do harness E2E.
**Paths:** `packages/db/src/testing.ts`, `packages/db/src/testing/**`, `scripts/e2e/serve.mjs`, `scripts/e2e/orphans.mjs`, `scripts/e2e/template-db.mjs`, `scripts/e2e/*.unit.test.mjs`, `docs/testing.md`.
**Depende de:** T124, T126
**Entregáveis:** banco-modelo `crm_tpl_<set>_<hash12>` por conjunto de migrações (`set`), onde o hash é o SHA-256 do conteúdo dos arquivos de migração (e do journal) desse conjunto; criação do modelo serializada por `pg_advisory_lock` (o primeiro cria e migra; os demais esperam e reaproveitam), modelo marcado `IS_TEMPLATE true` e `ALLOW_CONNECTIONS false`; clonagem com nova tentativa curta quando o Postgres recusa a cópia por haver sessão na origem (`55006`); `createTempDatabase({ migrate: true })` e o harness (`serve.mjs`, inclusive o reset) passam a clonar o modelo e aplicar só o seed depois; modelos de hash antigo sem conexões são removidos pela limpeza de órfãos; `docs/testing.md` explica o mecanismo e como forçar a recriação.
**Critérios de aceitação**
- **AC-T128-01** `createTempDatabase({ migrate: true })` devolve um banco com o mesmo schema (tabelas, colunas e índices de `crm` e `public`) que a migração completa, e a partir da segunda chamada com as mesmas migrações nenhuma migração é executada (o banco nasce do modelo `crm_tpl_*`).
- **AC-T128-02** Oito chamadas concorrentes para o mesmo conjunto criam o modelo uma única vez e as oito devolvem bancos utilizáveis, sem erro de "source database is being accessed by other users".
- **AC-T128-03** Alterar o conteúdo de uma migração (hash diferente) faz a próxima chamada criar um modelo novo; a limpeza de órfãos (`scripts/e2e/orphans.mjs`) remove o modelo antigo sem conexões e nunca remove o modelo do hash atual.
- **AC-T128-04** O harness E2E (`node scripts/e2e/serve.mjs`) sobe com banco clonado do modelo mais o seed, e o `POST /__e2e/reset` volta ao estado do seed também a partir do modelo; o tempo de criação do banco do harness cai em relação à migração completa (medido e registrado em `docs/testing.md`).

---

### T102 — Integração E2E final
**Objetivo:** provar o sistema montado. Tarefa principalmente do Tester; o Operário só corrige integrações.
**Paths (Operário):** `apps/**`, `packages/**`, `scripts/**` (só correções de integração, nada de feature nova)
**Depende de:** todas as tarefas de UI, T98 e T115
**Critérios de aceitação**
- **AC-T102-01** Jornada de onboarding: cadastro → empresa criada → conectar WhatsApp (QR fake) → conexão "Conectada" → contato manda mensagem → chat aparece na fila em tempo real.
- **AC-T102-02** Jornada de atendimento: atendente assume, responde (texto e áudio PTT), move o card no kanban, resolve; métricas de atendimento refletem o chat.
- **AC-T102-03** Jornada de automação: fluxo com boas-vindas + menu + espera; contato responde "2" e recebe o ramo certo; timeout segue o ramo de timeout.
- **AC-T102-04** Jornada de IA: agente ativo responde com o FakeLlm, transfere para humano por habilidade e consome créditos; com créditos esgotados transfere sem chamar o LLM.
- **AC-T102-05** Jornada de risco: conexão recebe 403 → `PAUSED`/banida, alerta por e-mail, envio seguinte rejeitado com `SESSION_NOT_CONNECTED`; contato manda "SAIR" → opt-out → envio rejeitado com `CONTACT_NOT_ALLOWED`.
- **AC-T102-06** Isolamento: usuário da empresa B não vê nenhum dado da empresa A por URL, API ou SSE (varredura das rotas de listagem).
- **AC-T102-07** Reiniciar `wa-worker`, `worker` e `api` com mensagens na fila e runs em espera não perde nem duplica mensagens, e os runs continuam.

---
## 6. Scripts de verificação

Todos em `spec/verify/`, Node puro (sem dependências), multiplataforma.

```bash
node spec/verify/verify.mjs list                        # tarefas, ondas, deps, nº de ACs e status dos relatórios
node spec/verify/verify.mjs plan --max 4                # lotes por onda ordenados pelo caminho crítico (4 pares = decisão do usuário)
node spec/verify/verify.mjs lint-spec                   # SPEC.md × tasks.mjs (seções, ACs únicos e em sequência, ≥3 por tarefa, tabela de ondas)
node spec/verify/verify.mjs T26 --role operario --base <ref>   # checks do Operário (escopo bloqueante com --base)
node spec/verify/verify.mjs T26 --role tester --base <ref>     # checks do Tester (cobertura e execução dos ACs)
node spec/verify/verify.mjs wave 5                      # regressão de todas as tarefas até a onda 5
node spec/verify/infra-local.mjs                        # sobe Postgres/Redis nativos e garante o banco `crm`
```

**`--role operario`** executa:
1. **Arquivos obrigatórios** da tarefa (`requiredFiles`).
2. **Comandos**: `typecheck`, `lint` e `test` dos workspaces da tarefa (+ `build` do web em tarefas de UI).
3. **Regras proibidas** (grep no código de produto, `FORBIDDEN` em `tasks.mjs`): `sendMessage` fora do ponto único, Baileys fora do engine, `@crm/wa-engine` no domínio, SDK de IA fora de `packages/ai`, `groupAcceptInvite`, promessa de imunidade a ban, `useMultiFileAuthState`, marca "Leona", Cloud API/WABA, token em `localStorage`, `console.log` em código de servidor.
4. **Escopo**: arquivos alterados ⊆ Paths da tarefa + `SHARED_PATHS`, e nada em `tests/**`. Bloqueante com `--base`/`--strict-scope`.

**`--role tester`** executa:
1. Regras do Tester: sem import de Baileys, sem host de API paga, sem `.skip/.todo/.only/.fixme`.
2. Extrai de `SPEC.md` os IDs `AC-Txx-nn` da tarefa e confere que cada um aparece em `tests/acceptance/Txx/**`.
3. Sobe a infra (`CRM_INFRA=local` padrão: `infra-local.mjs`; `CRM_INFRA=docker` usa `docker compose`).
4. Roda **Vitest** (`*.test.ts`, reporter JSON) e, se houver, **Playwright** (`*.e2e.ts`, `tests/acceptance/playwright.config.ts`, reporter JSON). Tarefa de UI sem `*.e2e.ts` reprova.
5. Cada AC precisa de ≥ 1 teste `passed`, nenhum `failed`/`skipped`; se o AC tem teste E2E, ele passa no projeto **`desktop`** e, se for AC de layout/responsivo (3.10), também no **`mobile`**.
6. **Escopo**: o Tester só alterou `tests/**`.

**Relatório:** `spec/reports/Txx-<papel>.json` com `{ version: 1, task, role, ok, at, commit, base, changedFiles[], checks[{ name, status, detail, output?, failures? }] }`, mais `Txx-vitest.json`/`Txx-playwright.json` brutos. Exit `0` aprovado, `1` reprovado, `2` uso incorreto.

**Ambiente dos comandos** (definido pelo verify, sobrescrevível por env): `DATABASE_URL=postgres://wsm:wsm@127.0.0.1:5432/crm`, `REDIS_URL=redis://127.0.0.1:6379/1`, `ANTIBAN_MODE=passthrough`, `WA_GATEWAY=fake`, `WA_TRANSPORT=fake`, `AI_MODE=fake`, `MAIL_TRANSPORT=memory`, `VITEST_MAX_WORKERS=2`, `pnpm -r` com concorrência 1.

---

## 7. Prompts de despacho (Orquestrador → agentes)

### 7.1 Operário
```text
Você é OPERÁRIO na tarefa {Txx} — {título}.
Worktree: ../leonas-crm-wt/{Txx} (branch task/{Txx}). Trabalhe só nele.
Leia spec/SPEC.md: seções 1, 3 e a tarefa {Txx} inteira; leia as seções de feature citadas em "Ref".
Antes de usar qualquer API de biblioteca, confira a versão em spec/STACK.md e consulte o context7 nessa versão.
Escreva SOMENTE dentro dos Paths da tarefa e, de forma aditiva, nos arquivos compartilhados (SPEC 2.4). Não toque em tests/**.
Implemente os entregáveis e atenda a todos os critérios AC-{Txx}-nn. Escreva testes unitários (*.unit.test.ts / *.db.unit.test.ts).
Antes de reportar: node spec/verify/verify.mjs {Txx} --role operario --base {ref}  (exit 0 obrigatório).
Não faça commit. Reporte com: maestri ask "Claude Code" "<relatório no formato da seção 2.3>"
Dúvida de requisito → BLOCKED com a pergunta. Não invente requisito.
```

### 7.2 Tester
```text
Você é TESTER na tarefa {Txx} — {título}.
Worktree: ../leonas-crm-wt/{Txx}. Escreva só em tests/acceptance/{Txx}/ (e helpers compartilhados em tests/acceptance/helpers, de forma aditiva).
Leia spec/SPEC.md: seções 1, 3 (3.10 e 3.11) e a tarefa {Txx} inteira.
Um ou mais testes por critério; o título de cada teste DEVE conter o ID (ex.: it('AC-{Txx}-03 reabre chat resolvido', ...)).
API/worker: *.test.ts (Vitest). UI: *.e2e.ts (Playwright, projeto desktop; ACs de layout/responsivo também no mobile; harness scripts/e2e/serve.mjs).
Teste pelos contratos (HTTP, portas, navegador), não por detalhes internos. Nunca WhatsApp real nem API paga: use os fakes.
Não edite apps/** nem packages/**. Não faça commit.
Escreva os testes já; quando o Orquestrador avisar que a implementação está pronta, rode:
  node spec/verify/verify.mjs {Txx} --role tester --base {ref}
Reporte com: maestri ask "Claude Code" "<relatório no formato da seção 2.3>"
Teste falhando por bug de produto → REJECT com o ID do AC, o esperado e o obtido.
```

### 7.3 Orquestrador (lembrete)
```text
Você é o ORQUESTRADOR ("Claude Code") do leonas-crm. Siga a seção 2. Não escreve código de produto nem testes; só você commita.
Antes de cada onda: verify.mjs plan --max 4 (4 pares Operário+Tester em paralelo). Para cada tarefa: worktree, Operário + Tester em paralelo (7.1, 7.2) via maestri ask --batch.
Verifique com --base, aceite só com os dois verify em exit 0, integre em main (2.5), rode a regressão da onda e atualize spec/STATUS.md.
Após 3 rejeições na mesma tarefa, pare e escale ao humano.
```

---

## 8. Fora de escopo

### 8.1 Cobrança do SaaS (assinatura da plataforma)
Assinaturas por instância, planos e preços, faturas, reembolsos, checkout do SaaS (cartão, Pix, boleto), gateways da plataforma (Stripe, Pagar.me, Paddle, Guru, Asaas), legado Stripe, inadimplência e bloqueio, downgrade/troca de conexões, compra de tokens, cotação e pacotes, autorrecarga, admin de assinaturas e migrações de billing, comprovante Pix no admin. Ref: `12-cobrancas-assinaturas-tokens.md` (exceto tokens), `20-admin-interno.md` (3.3–3.4, 3.11).
**Fica:** consumo e cota de IA por empresa com recarga manual pelo admin (T18, T24, T37, T59) e a porta `BillingProvider` só como interface (T18).
**Não confundir:** cobrança **ao lead** dentro dos fluxos (gateways XPag/Zenith, T109–T111), NF (T112) e UTMify (T113) **estão no escopo** (revisão 1).

### 8.2 Requer WABA / Cloud API (`[REQUER WABA]`)
| Item | Spec | Tratamento no clone |
|---|---|---|
| Templates oficiais da Meta (aba, CRUD, sync, aprovação, quality score, categorias, OTP, COPY_CODE, Pix ORDER_DETAILS, botões oficiais) | 03, 06, 16, 17, 18 | **Fora.** Substituídos por modelos internos de mensagem (T35) e respostas rápidas |
| Janela de 24 h e condição `message_window` | 03, 06, 10 | **Fora.** Sem janela (condição sempre verdadeira); o ritmo é controlado pelo antiban |
| Provedor `meta_cloud`, envio por Cloud API, fila `meta_webhooks`, contadores `official_*` | 03, 08, 10, 20 | **Fora.** Só Baileys |
| Embedded Signup, coexistência, PIN 2FA, `exchange_code`, SDK do Facebook para cadastro | 01, 08, 11, 21 | **Fora.** Pareamento por QR ou código (T40, T71) |
| `waba_id`, `phone_number_id`, "Reconectar API Oficial", slot oficial | 08 | **Adaptado:** JID + auth state Baileys; reconectar por novo QR |
| Status `restricted` | 08 | **Adaptado:** `banned` (403/forbidden) ou `disconnected` (loggedOut) |
| Referral CTWA do webhook oficial | 05, 11 | **Adaptado:** `contextInfo.externalAdReply` da 1ª mensagem (T07, T33, T73) |
| Conversions API `business_messaging` (exige WABA) | 11 | **Fora.** CAPI com `action_source` `chat`/`system_generated` (T104) |
| Template inicial de disparo para alvos oficiais | 10 | **Fora.** Primeira mensagem livre do fluxo |

### 8.3 Instável no Baileys (`[INSTÁVEL NO BAILEYS]`)
Regra: `WaCapabilities` (T03) com todas as flags **desligadas** por padrão; com a flag desligada, cai no tratamento abaixo.
| Item | Tratamento |
|---|---|
| Botões, listas e menus interativos; carrossel; imagem em botões | Texto: menu numerado com casamento por número/título (T62); carrossel = imagens com legenda + menu numerado. Nativo: **fora desta versão** |
| Botão Pix | Texto com chave e "copia e cola" EMV (T51); cobranças de gateway enviam o código/URL como texto (T111) |
| Reagir, marcar como lido | Melhor esforço com a key salva; a UI esconde a ação se faltar a key |
| Chamadas de voz (`make_call`, `missed_call`) | Só registro do evento `call`; originar chamada: **fora** |
| Importar/sincronizar etiquetas do WhatsApp Business | **Fora** (etiquetas internas são a fonte da verdade) |
| Perfil comercial (sobre, endereço, site) | Atrás de `capabilities.businessProfile` (desligada) até confirmar a API no `.d.ts` do rc14 |
| Variáveis CTWA | Opcionais; vazias quando ausentes |

### 8.4 Outros
- **Mensagens de grupo no inbox** (como no produto de referência: ignoradas pelo ingest).
- **Gateway "Leona Pay"** (gateway da própria empresa de referência): **fora** — decisão do usuário (10.1 nº 9); conflita com a marca neutra (regra 1.4 nº 9).
- Tradução de fluxo e de chat; provedores Kie.ai, Fish Audio, Qwen, Lara.
- Ferramentas do assistente de fluxo além da edição do grafo (busca na web, interpretador de código, geração de imagem).
- Programa de afiliados interno e Rewardful (só captura do código + link externo, T97); resgate de prêmios dos marcos (link externo só se configurado).
- Infra de nuvem no admin (AWS, ALB, Supabase, Sidekiq, ActionCable); tradutor de fluxo no admin.
- Codec ofuscado do editor de fluxos; telemetria `client_debug_events`; widget de suporte de terceiros fixo (vira provedor plugável, T108); onboarding/tour.
- Armazenamento S3 (só `FsBlobStore` + porta), deploy com Docker em produção (compose só opcional), embeddings/vetores na base de conhecimento (busca textual).

---

## 9. Riscos

| # | Risco | Impacto | Mitigação |
|---|---|---|---|
| R1 | Baileys é RC (7.0.0-rc14) e não oficial: mudanças de protocolo e risco de banimento dos números | Alto | Versão fixa, transporte isolado (T07), antiban + warm-up + pausa automática (T14, T20), FakeTransport em todos os testes, nenhuma promessa de imunidade |
| R2 | Antiban e warm-up deixam disparos e respostas mais lentos do que o usuário espera | Médio | UI explica o ritmo real (T83); reagendamento em vez de falha (T74); limites por conexão visíveis |
| R3 | Sem gate de consentimento para importados: disparos para listas frias aumentam o risco de denúncia e banimento | Alto | Opt-out por palavra-chave sempre ativo (T33), antiban/warm-up e pausa em 403 (T20), cota de disparos e intervalos (T60, T74), aviso no wizard de disparo |
| R4 | Identidade LID × telefone: contatos duplicados ou fundidos errado | Médio | Unicidade parcial dupla + merge por `lid_mapping` (T26, T33), testes de idempotência |
| R5 | Ondas 5–7 com 18–27 tarefas: conflitos em arquivos compartilhados e migrations; com 4 pares em paralelo, essas ondas levam vários lotes | Médio | Worktrees, Paths disjuntos, registros aditivos, regeneração de migration, regressão por onda; ordem pelo caminho crítico (`plan --max 4`) |
| R6 | APIs de XPag, Zenith, Notasy e UTMify sem sandbox: implementadas só pela documentação pública | Médio | Adapters atrás de portas com fakes; URLs da doc citadas no código e em `docs/integrations/`; validação com chave real pelo usuário depois (10.1 nº 10) |
| R7 | AI SDK 7 e o provider da OpenRouter mudam rápido e atrasam recursos novos | Médio | Só um adapter importa `ai`/`@openrouter/ai-sdk-provider` (T12); porta `LlmProvider` permite adapter direto |
| R8 | Custo de IA sem cobrança do SaaS: consumo sem receita | Médio | Cota `hard` por empresa, recarga manual, ledger com custo real × créditos (T18, T24) |
| R9 | Testes E2E instáveis (SSE, timers, Windows) e o triplo de chaves de i18n | Médio | Harness determinístico (T17), relógio e RNG injetáveis, reset entre testes; `i18n:check` em todo verify de UI |
| R10 | Máquina de dev Windows: memória, disco (chegou a 0 bytes livres em 2026-10-15), Postgres/Redis nativos, ffmpeg e Chromium | Médio | `VITEST_MAX_WORKERS=4`, `pnpm -r` serial, `infra-local.mjs`, ffmpeg mockado nos testes, espaço livre conferido antes de cada onda (`spec/INFRA.md`) |
| R11 | Modo extensão depende de mudanças aditivas no ai-manager (fora deste repo) | Médio | Perfil `ai-manager` com detecção de capacidades e doc do patch A1–A7 (T98); o CRM funciona sozinho |
| R12 | Meta Graph v26.0 muda a cada versão; rate limit BUC | Baixo | Versão em env, cliente próprio com fake (T99), adiamento de job em vez de falha (T101) |
| R13 | Volume do history sync FULL na primeira conexão | Baixo | Sync completo desligado por padrão (10.2); mensagens históricas não disparam automações (T33) |
| R14 | OAuth do MCP (servidor de autorização próprio) é superfície de segurança nova | Médio | PKCE obrigatório, tokens curtos com hash, rotação e detecção de reuso de refresh token, consentimento por empresa (T115) |

---

## 10. Decisões

### 10.1 Decisões fechadas pelo usuário (revisão 1, 2026-10-15)
Regra geral: em dúvida de escopo, fazer como o produto de referência faz.
1. **Consentimento:** sem exigência de consentimento prévio para importados. Importação (CSV/WhatsApp), cadastro manual, webhooks e vendas registram consentimento automaticamente (`consent_source = 'import' | 'manual' | 'webhook' | 'sale'`; `inbound` quando o contato inicia), repassado ao gateway para o pipeline e o gate do ai-manager aceitarem o envio. **Opt-out sempre bloqueia.** (Regra 1.4 nº 3; T26, T33, T60, T67, T73.)
2. **Grupos de WhatsApp:** não entram no inbox (como na referência). (3.8, T33.)
3. **Integrações de venda iguais à referência:** cobrança ao lead dentro do fluxo com gateways (XPag e Zenith, com webhooks de confirmação), emissão de NF (Notasy) e UTMify no bloco "Venda aprovada", tudo atrás de portas com fakes. A porta `BillingProvider` da plataforma continua só interface; a assinatura do SaaS segue fora. (T109–T114; gateway "Leona Pay": ver 10.3.)
4. **Extras iguais à referência:** OpenRouter como provedor de LLM (`@openrouter/ai-sdk-provider@3.1.0`, STACK F.8; T12, T38); assistente (copiloto) de fluxo e servidor MCP na onda mais cedo que as dependências permitem (agora onda 6), com credenciais por token Bearer e **OAuth** (exigido pela spec 09; T94, T115); **i18n completo pt-BR/en/es** (T23 cria as três línguas e o `i18n:check`; toda tarefa de UI entrega as chaves nas três; AC de troca de idioma em T23 e T36).
5. **Marcos de faturamento:** os 6 limiares da referência (R$ 50 mil, 100 mil, 250 mil, 500 mil, 1 milhão, 2 milhões) com nomes próprios: "Primeira Marca", "Tração", "Escala", "Expansão", "Clube do Milhão", "Referência no Mercado". (T55, T78.)
6. **KPIs:** ticket médio = faturamento ÷ vendas; conversão = vendas ÷ leads novos; ROAS = faturamento ÷ gasto Meta; lucro = faturamento − gasto Meta − despesas pelas regras de 02#3.5 (fixa rateada pelo período, percentual sobre faturamento/gasto/lucro antes das taxas). (T55.)
7. **Limites por empresa:** ilimitados por padrão; o admin da plataforma pode definir limites por empresa (conexões, agentes, membros, fluxos, webhooks). A cota de disparos em massa segue a regra da referência (`conexões × limite por conexão + bônus`, ajustável pelo admin). **Admin interno no modo extensão:** mostra só dados do CRM; as sessões ficam no painel do ai-manager. (3.3, T39, T40, T60, T71, T95, T96, T100.)
8. **Execução:** 4 pares Operário+Tester em paralelo (`verify.mjs plan --max 4`). (2.2.)
9. **Gateway "Leona Pay":** fora de escopo; ficam XPag e Zenith. (8.4.)
10. **Sem sandbox de XPag, Zenith, Notasy e UTMify:** implementação pela documentação pública (pesquisada pelo Operário, com URLs citadas no código e em `docs/integrations/`) + fakes; o usuário valida com chave real depois. `BLOCKED` só se não houver documentação pública. (T109–T113.)
11. **Cota de disparos em massa:** como a referência — `conexões × 500/mês + bônus`, ajustável pelo admin da plataforma; "ilimitado por padrão" vale só para limites de quantidade. (T60, T95.)

12. **Revisão 2 (2026-10-16, custo do verify):** E2E `mobile` só nos ACs de layout/responsivo; verify em dois níveis (testes afetados durante a tarefa, suíte completa uma vez no gate); `VITEST_MAX_WORKERS=2`; Postgres de **teste** sem durabilidade (`fsync`, `synchronous_commit`, `full_page_writes` desligados) e banco-modelo migrado uma vez por hash das migrações. (3.10, 6.)

### 10.2 Decisões assumidas (revisáveis; o Orquestrador pode seguir com elas)
1. Cadastro cria automaticamente a empresa "Minha empresa" com o usuário como `owner` (T15).
2. Sessão por cookie httpOnly com TTL de 30 dias deslizante; empresa ativa por header `X-Company-Id` (permite abas com empresas diferentes).
3. Convites de membro e de plataforma unificados num só modelo (`kind`); o aceite cria o usuário se ele ainda não existir.
4. Chat por (empresa, conexão, contato); contato compartilhado entre conexões da mesma empresa.
5. Um run de fluxo ativo por contato; gatilho de palavra-chave ou disparo manual cancela o run atual; gatilhos automáticos (boas-vindas, resposta padrão) são suprimidos com atendente humano ou agente de IA no chat.
6. Fluxo pausado: runs em espera congelam e retomam no `resume`; editar um fluxo ativo só afeta novos runs após publicar.
7. Simulador no servidor, reaproveitando os handlers do motor (dry-run).
8. Proxy opcional por conexão (como "chip pessoal" do ai-manager); com proxy configurado nunca conecta direto.
9. Mídia recebida baixada na hora (áudio, imagem, documento até o limite) para STT e visão; armazenamento em disco local.
10. History sync FULL desligado: só mensagens novas entram no CRM.
11. Créditos de IA como saldo pré-pago com recarga manual pelo admin + cota mensal opcional; uso com chave própria da empresa (BYOK, inclusive OpenRouter) é medido, mas não debita créditos.
12. Mover card para coluna de conversão **não** cria venda automaticamente.
13. Vendas em várias moedas são exibidas por moeda (sem câmbio automático), exceto o gasto Meta, que usa a moeda de exibição escolhida.
14. Variáveis globais editáveis por owner/admin.
15. Base de conhecimento com busca textual no Postgres (sem embeddings).
16. "Push" do bloco Venda aprovada = notificação no app (`notification.created`, T63/T84); não há app móvel nativo.

### 10.3 Dúvidas abertas para o usuário
1. **T110 (Zenith):** não há documentação pública da Zenith (homônimos: zenithpayments.support AU, zenithpay.in, xenithpay, zen.com). Opções: (a) o usuário fornece a documentação do parceiro; (b) contrato provisório marcado `[NÃO VERIFICADO]`, validado depois com chave real; (c) tirar a Zenith do escopo (fica só XPag). Em aberto desde 2026-10-16 12:21.
