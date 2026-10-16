# AI-MANAGER-MAP — mapa do ai-manager e fronteira de extensão do leonas-crm

> Fonte: leitura de `C:\Users\green\Downloads\leonas\ai-manager` (somente leitura) em 2026-10-15.
> Referências no formato `caminho:linha` relativas à raiz do ai-manager.
> Objetivo: o clone (leonas-crm) roda sozinho, mas é plugável depois como EXTENSÃO do ai-manager **sem abrir uma segunda conexão WhatsApp para a mesma sessão**.

---

## 1. Visão geral

| Item | Valor |
|---|---|
| Nome do monorepo | `wa-session-manager` (`package.json`), pnpm 9.15.9, Node ≥ 20, ESM (`"type": "module"`) |
| Workspaces | `apps/*` e `packages/*` (`pnpm-workspace.yaml`) |
| Escopo npm interno | `@wsm/*` |
| Build | `tsup` (ESM, target node20) por pacote; dev com `tsx watch --conditions=development` |
| Resolução entre pacotes | `exports` com condição `development` → `./src/index.ts` (sem build em dev/teste), `default` → `./dist/index.js` |
| Qualidade | `typescript ~6.0.3`, `eslint 10` + `typescript-eslint 8`, `prettier 3`, `vitest 5.0.1` |
| CI | `.github/workflows/ci.yml`: `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm lint` → `pnpm test` |
| Infra | `docker-compose.yml`: `postgres:16-alpine`, `redis:7-alpine` (AOF), `worker`, `api`, `dashboard` |
| Spec de origem | `leonas-crm/spec/_ref_wsm_SPEC.md` (cópia da SPEC do ai-manager: tarefas T00–T19, regras invioláveis em §1.4, contratos globais em §3) |

### 1.1 Pacotes

| Pacote | Papel | Dependências principais |
|---|---|---|
| `packages/db` (`@wsm/db`) | Schema Drizzle, client, migrations, helpers de teste (banco descartável) | drizzle-orm 0.45.3, pg 8.23.0, drizzle-kit 0.31.11 |
| `packages/core` (`@wsm/core`) | Domínio inteiro: transporte, sessão, proxy, contatos, fila, pipeline de envio, antiban, warm-up, health, alertas, IA, grupos, conversas, relatórios, observabilidade | baileys 7.0.0-rc14 (pin exato), baileys-antiban 4.10.0, bullmq 6.3.8, @anthropic-ai/sdk 0.128.0, nodemailer 10.0.10, pino 10.3.1, prom-client, sharp 0.35.4, nsfwjs/tfjs (filtro de figurinhas), zod 4.6.5 |
| `apps/worker` (`@wsm/worker`) | **Único processo que abre sockets Baileys.** SessionManager, MessageQueue (workers BullMQ), HealthMonitor, automações, alertas, servidor interno RPC | bullmq, ioredis 6.0.0, hono 4.13.8, @hono/node-server 2.1.1 |
| `apps/api` (`@wsm/api`) | API HTTP pública (Hono). Não tem Baileys: fala com o worker pela ponte RPC | hono, ioredis, pino, zod |
| `apps/dashboard` (`@wsm/dashboard`) | SPA React 19 + Vite 8, roteamento por hash feito à mão, recharts 3 | react 19.3.0, vite 8.3.0, recharts 3.10.1 |

`packages/core/src/index.ts` é o "ponto de registro" — cada tarefa adiciona `export *` (regra de arquivos compartilhados: alterações só aditivas, SPEC §2.4).

---

## 2. Interface de transporte (`packages/core/src/transport`)

Contrato em `packages/core/src/transport/types.ts:103` (`WaTransport`). Isola o Baileys atrás de uma interface testável; há duas implementações: `BaileysTransport` (`baileys.ts:320`) e `FakeTransport` (`fake.ts:26`, selecionado por `WA_TRANSPORT=fake`).

```ts
interface WaTransport {
  connect(opts: ConnectOptions): Promise<void>          // auth, proxyUrl, pairingPhone, saveCreds, browser
  on('qr' | 'pairing-code' | 'connection' | 'message' | 'receipt', cb)
  sendMessage(to, content: OutgoingContent): Promise<{ messageId }>
  fetchGroups(); addGroupParticipant(groupId, jid); logout(); close()
  // opcionais: syncChatSettings, sendTyping, saveContact, inspectGroupInvite,
  //            groupInviteCode, groupAcceptInvite, off, ownPhone
}
```

- `IncomingMessage` (`types.ts:28`): `id, from, fromAlt (PN quando o chat é LID), participant, fromMe, timestamp, pushName, text, type`. **Não carrega mídia** (só o `type`, ex. `imageMessage`), nem `quoted`, nem dados de anúncio (CTWA).
- `OutgoingContent` (`types.ts:56`): `text | image | video | audio (ptt?) | document | sticker`, mídia sempre por `MediaRef { url }`.
- `ReceiptUpdate`: `messageId` + `delivered|read`.
- `ConnectionUpdate`: `open|close` + `DisconnectKind` (`loggedOut` 401, `forbidden` 403, `transient`) (`baileys.ts:21-34`).
- Baileys é carregado por factory (`BaileysSocketFactory`, `baileys.ts:129`) → testes injetam socket fake (`BaileysSocketLike`, `baileys.ts:84`).
- Proxy por sessão: `createProxyAgent` (http/https/socks5) vira `agent` e `fetchAgent` do socket (`baileys.ts:62`, `:365`).
- Fingerprint do aparelho fixo por sessão: `browserForSession(sessionId)` (`fingerprint.ts:20`), gravado em `sessions.browser`.
- Detalhes LID: o transporte guarda tempo de mensagens temporárias por JID de telefone **e** LID (`rememberEphemeral`, `baileys.ts:338`); `normalizeJid`/`phoneFromUserJid` (`baileys.ts:271-276`).
- Histórico sob demanda: guarda a última key por conversa e pede histórico ao celular quando precisa (`CHAT_CHECK_INTERVAL` 6 h, `baileys.ts:164`).

## 3. SessionManager (`apps/worker/src/sessions/manager.ts`)

- `class SessionManager extends EventEmitter<SessionManagerEvents>` (`manager.ts:140`). Eventos: `connected`, `disconnected`, `state`, `qr`, `pairing-code`, `reconnect` (`:131`).
- Opções injetáveis (`:46`): `db`, `transportFactory(sessionId)`, `sleep`, `backoff` (1s·2^n), `maxReconnectAttempts` (5), `onConnected/onDisconnected` (hooks do HealthMonitor), `resumeState`, `pairingTimeoutMs` (30 s), `connectTimeoutMs` (60 s), `authStateFactory` (default `usePostgresAuthState`).
- API pública: `start/stop/whenIdle`, `create/list/get`, `getTransport(id)`, `isConnected`, `runtimeInfo`, `startQr/getQr` (QR como data URL PNG), `requestPairingCode`, `pause/resume/restart/logout/remove`, `recoverAfterProxy` (`:165-512`).
- Cada sessão tem um `Runtime` com uma **cadeia serializada** (`chain`, `enqueue`, `:438`) — operações por sessão nunca concorrem.
- Toda conexão passa por `connectSession` (core/proxy): proxy configurado é obrigatório, sem fallback direto.
- Estados da sessão (`packages/db/src/schema/enums.ts:4`): `NEW → WARMING → STABLE ↔ DEGRADED`, `PAUSED`, `DISCONNECTED`; transições validadas por `canTransition/assertAction` (`core/session/states.ts`).
- Auth state Baileys no Postgres **cifrado** (AES-256-GCM, AAD = `sessionId/keyType/keyId`, `core/auth-state/index.ts:32-36`), tabela `session_credentials`. Chave em `CREDENTIALS_KEY`.

## 4. Pipeline de envio e antiban

Ordem fixa de gates (`packages/core/src/send/pipeline.ts:13`):

```
auth → sessionExists → connected → contactAllowed → warmupLimit → rateLimit → enqueue
```

- Cada gate lança `SendRejectedError` com código/HTTP (`UNAUTHORIZED 401, SESSION_NOT_FOUND 404, SESSION_NOT_CONNECTED 409, CONTACT_NOT_ALLOWED 403, WARMUP_LIMIT 429, RATE_LIMIT 429`, `:16`). Gates são substituíveis por injeção (`opts.gates`).
- `SendRequest` (`:43`): `sessionId, phone (E.164), groupId?, content, actor, contactId?`. `sendGroup` para grupos.
- `contactAllowed` usa `canMessage` (consentimento + opt-out, `core/contacts/policy.ts`).
- Limites por sessão em `session_limits` (`SessionLimitsService`, `core/safety/limits.ts`); warm-up por cronograma (`core/warmup`).
- **Ponto único de entrega** (`packages/core/src/send/deliver.ts`): `antiban.beforeSend → sleep(delayMs) → transport.sendMessage → antiban.afterSend`. 403 no envio → sinal `forbidden_403` ao HealthMonitor + redução de limites (fator 0.5). `bindTransportSession(transport, sessionId)` associa transporte → sessão (WeakMap).
- `AntibanAdapter` (`core/antiban/adapter.ts:33`): modos `real` (envolve `AntiBan` do baileys-antiban, presets `conservative|moderate|aggressive|high-volume`, default `conservative`) e `passthrough` (só testes, via `ANTIBAN_MODE=passthrough` explícito no `vitest.config.ts`). `onDelivered` alimenta a taxa de entrega — sem receipts o antiban corta limites a 25%.
- Pesquisa de regras: `docs/pesquisa-regras-antiban.md`.

## 5. Filas (BullMQ + ioredis)

- `MessageQueue` (`packages/core/src/queue/queue.ts:116`): **uma fila BullMQ por sessão**, nome lógico `session:<id>`; como BullMQ proíbe `:` no nome, o prefixo é `<prefix>:session` e o nome da fila é o id (`:94`, `:118`).
- `queue.setGlobalConcurrency(1)` + `Worker({ concurrency: 1, runRetryDelay: 1000 })` → envio estritamente serial por chip, mesmo entre processos (`:335-362`).
- Retentativas: 3 tentativas, backoff 1 s; "hold" de 2 s (`:87-89`).
- Estado autoritativo da mensagem fica no Postgres (`MessageStore`, `queue/store.ts`, tabelas `messages` + `message_events`); Redis só transporta o job (`{ messageId }`).
- Ligação com sessões em `apps/worker/src/queue/attach.ts`: `PAUSED` pausa a fila; `connected` inicia o worker da fila e liga `receipt` → `queue.handleReceipt` + `antiban.onDelivered`.
- Outros usos de Redis: estado de conversas automáticas (`wsm:conversations:*`, `apps/worker/src/conversations/store.ts`), histórico de grupos, figurinhas, temporárias. ioredis criado com `maxRetriesPerRequest: 3` (`apps/worker/src/boot/start.ts:113`) — ⚠ os `Worker` BullMQ recebem `ConnectionOptions` e criam conexões próprias.

## 6. Schema do banco (`packages/db/src/schema`)

Drizzle `pgTable` em schema `public`. Helpers `createdAt()/updatedAt()` com `timestamp(..., { withTimezone: true })`; `bytea` customizado (`schema/bytea.ts`).

| Tabela | Conteúdo relevante |
|---|---|
| `proxies` | protocolo (enum), host/porta, senha cifrada (ciphertext/iv/authTag/keyVersion), disponibilidade |
| `sessions` | `id uuid`, `name`, `phone` (nullable até conectar), `status` (enum), `proxy_id` UNIQUE, `browser jsonb`, `warmup_started_at`, `last_connected_at` |
| `session_credentials` | PK (session_id, key_type, key_id), só material cifrado |
| `contacts` | `phone` UNIQUE com CHECK E.164, `consent/consent_at/consent_source`, `opt_out`, `last_contact_at` — **sem LID, sem tenant, sem campos de CRM** |
| `messages` | `session_id`, `contact_id`, `direction` (outbound/inbound), `phone`, `content jsonb`, `status` (enum de 8 estados), `transport_message_id`, `attempts`, timestamps de sent/delivered/read |
| `message_events` | trilha de transição de status (bigserial) |
| `health_events` | sinais de saúde por sessão |
| `webhooks` | canais de **alerta** (discord/telegram/email/http) + eventos assinados |
| `audit_logs` | auditoria de toda chamada `/api/*` |
| `session_limits`, `suggestions`, `ai_settings` (linha única id=1), `session_links` + `session_route_runs`, `proxy_settings` | ver arquivos homônimos |

- Client: `createDb(url)` → `drizzle(pool, { schema })`, tipo `Database = NodePgDatabase<Schema> & { $client: pg.Pool }` (`packages/db/src/client.ts:22`).
- Migrations SQL geradas por drizzle-kit em `packages/db/drizzle/0000..0007` e aplicadas no boot por `runMigrations` com **advisory lock** (`pg_advisory_lock(7345001)`) porque api e worker migram ao subir (`client.ts:29`).
- Não usa `relations()` nem `db.query.*` de forma central; queries são `select/insert/update` + `sql` cru (ex.: `conversations/chats.ts`).

## 7. Auth

- `/api/*` exige Bearer (`apps/api/src/middleware/auth.ts`): **ou** token de login do painel `wsm1.<payload b64url>.<HMAC-SHA256>` (stateless, `exp` + revogação por `jti`, `auth/token.ts`), **ou** `API_TOKEN` de integração (comparação em tempo constante). Única rota pública: `POST /api/auth/login`.
- Só existe o papel `admin` (`TokenClaims.role: 'admin'`). Não há usuários múltiplos com papéis, nem times, nem tenant.
- `c.set('actor', ...)` alimenta o gate `auth` do pipeline e o `auditMiddleware`.
- Ponte interna worker: `POST /internal/rpc` com `Bearer INTERNAL_TOKEN` (`apps/worker/src/boot/internal-server.ts:165-205`).

## 8. Padrão de rotas (API Hono)

- `createApp(deps)` não abre porta (testes com `app.request()`), `apps/api/src/app.ts`: `requestId` → contexto de log → `requestLogger` → `loginTokenAuth` → `bearerAuth` → `auditMiddleware`; `onError`/`notFound` centralizados.
- `registerRoutes` (`routes/index.ts`) monta sub-apps por domínio com `app.route('/', xRoutes(deps))`; cada módulo é uma fábrica `(deps) => new Hono<AppEnv>()` com caminhos absolutos `/api/...`.
- Validação: `validate(target, zodSchema)` sobre `hono/validator` (`apps/api/src/validate.ts`) → erro `400 VALIDATION_ERROR` com paths. Respostas de erro: `{ error: { code, message, details? } }` (`errors.ts`). Campos JSON em snake_case.
- Injeção: `AppDeps { db, redis, logger, apiToken, ... }` + controles do worker (`SessionsControl`, `MessagesControl`, `HealthControl`).
- **Ponte API → worker** (`apps/api/src/bridge/client.ts`): clientes que implementam as mesmas interfaces das rotas e chamam `POST /internal/rpc { target, method, args }`; erros de domínio são re-hidratados com as classes originais. Alvos expostos (`apps/worker/src/boot/bridge-targets.ts`): `sessions.*` (create, list, get, startQr, getQr, requestPairingCode, pause, resume, restart, logout, remove, addGroupParticipant, runGroupInvite…), `messages` (a própria `MessageQueue`), `health`.
- Endpoints existentes (resumo): sessions (CRUD, qr, pairing-code, health, limits, chats, conversation, groups/*), messages (`POST /api/sessions/:id/messages`, list, events, cancel), contacts (CRUD + import CSV), proxies, webhooks, suggestions, ai/settings, session-links, reports, autoreply-targets, auth, `/health`, `/metrics`.

## 9. Recebimento (inbound) e automações

- Não há barramento de eventos externo: consumidores se penduram nos eventos do transporte **dentro do worker**.
  - `transportFactory` decorado em `start.ts:152` (atividade, histórico de grupos).
  - `attachAi(manager, …)` (`apps/worker/src/ai/attach.ts`) é o consumidor principal de `message`: persiste o inbound em `messages` (direction `inbound`) → aplica opt-out → roteamento (`SessionRouter`) → sugestão de IA `pending_approval`.
  - Padrão "attach": `attachX(manager, deps) → () => void` (desfaz a ligação); registrado com `onStop(...)` no boot.
- Conversas no painel são derivadas da tabela `messages` (`core/conversations/chats.ts`), sem tabela de chats.
- `webhooks` só cobrem **alertas operacionais** (`ALERT_EVENTS`: forbidden_403, disconnected, error_burst, proxy_unavailable, warmup_paused, health_degraded), não mensagens.

## 10. Testes

- vitest 5 por pacote (`vitest run --passWithNoTests`). Convenção de nomes: `*.unit.test.ts` (puros/fakes) e `*.db.unit.test.ts` (Postgres real).
- Banco descartável: `createTempDatabase({ migrate: true })` cria `wsm_test_<rand>` e `drop()` no fim (`packages/db/src/testing.ts`). Redis real em `REDIS_URL`.
- `FakeTransport` + `/internal/fake/*` (só com `WA_TRANSPORT=fake`) permitem E2E sem WhatsApp: emitir QR, abrir/fechar, receber mensagem, receipt, falhar próximo envio (`internal-server.ts:215-257`).
- `ANTIBAN_MODE=passthrough` explícito no `vitest.config.ts` (o código de produção nunca decide por `NODE_ENV`).
- Use `127.0.0.1` e não `localhost` no Windows (ver `spec/INFRA.md`).

## 11. Dashboard

- React 19.3 + Vite 8.3, **sem lib de roteamento** (hash router manual `src/lib/router.ts`), sem lib de data fetching (hooks próprios `src/lib/hooks.ts`, `api.ts` com `fetch` relativo a `/api`), CSS próprio (`src/styles.css`), recharts 3.10.1 para gráficos, tema claro/escuro (`lib/theme.ts`).
- Lógica de página separada em `*.logic.ts` testável (`Groups.logic.ts`, `Report.logic.ts`); playwright 1.63 como devDependency para verificação visual.
- Token de login guardado no cliente (`lib/auth.ts`) e enviado como Bearer.

## 12. Lacunas do ai-manager para um CRM (o que o clone precisa e o ai-manager não tem)

1. **Mídia recebida**: `IncomingMessage` não expõe mídia nem `downloadMediaMessage` → inbox de CRM precisa de imagem/áudio/documento (e STT de áudio).
2. **Eventos para fora do worker**: não há stream de `message/receipt/connection` consumível por outro serviço.
3. **Identidade LID**: `contacts.phone` é E.164 obrigatório e único; contatos que só chegam com LID (sem PN) não cabem.
4. **Multiusuário/times/permissões**: só `admin`. CRM precisa de atendentes, filas de atendimento, atribuição.
5. **Chats como entidade** (status aberto/fechado, responsável, etiquetas, não lidos): hoje é agregação sobre `messages`.
6. **Presença/“gravando áudio”**: só `sendTyping(composing/paused)`.
7. **Dados de anúncio (CTWA)**: `contextInfo.externalAdReply`/`ctwa_clid` não são extraídos → atribuição Meta Ads.
8. **Mensagens citadas, reações, edição/remoção** não modeladas.

---

## 13. PROPOSTA de fronteira de extensão

### 13.1 Princípios

1. **Um dono por socket.** Em qualquer modo, só um processo abre o Baileys de uma sessão. No modo extensão esse processo é o worker do ai-manager; o CRM nunca instancia `makeWASocket`.
2. **O CRM depende de uma porta estreita, não de `@wsm/core` inteiro.** Todo código de CRM fala com o WhatsApp por uma interface `WaGateway` (comandos) + um stream de eventos versionado. Trocar de modo = trocar o adaptador.
3. **Todo envio passa pelo SendPipeline** (gates + fila por sessão + antiban). O CRM nunca chama `transport.sendMessage` direto.
4. **Mesmo Postgres, schema separado.** Tabelas do CRM ficam em `pgSchema('crm')`; as do WhatsApp continuam com os nomes/colunas do ai-manager (`public.sessions`, `public.messages`, …). Assim, no modo extensão, o CRM só aponta para o banco do ai-manager.
5. **Mudanças no ai-manager somente aditivas** (mesma regra da SPEC §2.4) e atrás de feature flag.

### 13.2 Estrutura sugerida do leonas-crm

```
leonas-crm/
  packages/
    wa-port/        @crm/wa-port   — CONTRATO: interface WaGateway, tipos/zod dos eventos (WaEvent v1), erros
    wa-engine/      @crm/wa-engine — modo standalone: fork alinhado de @wsm/core (transport, session, auth-state,
                                       send pipeline, queue, antiban, warmup, health) + @wsm/db (tabelas WhatsApp)
                                       mantendo nomes de tabela, enums, prefixo Redis e nomes de fila do ai-manager
    wa-gateway-local/      implementa WaGateway chamando o wa-engine no mesmo processo/worker
    wa-gateway-aimanager/  implementa WaGateway via POST /internal/rpc do worker do ai-manager + consumo do stream
    crm-db/         @crm/crm-db    — Drizzle em pgSchema('crm'), migrations próprias (tabela de migrations separada)
    crm-core/       @crm/crm-core  — domínio CRM (contatos/leads, chats, pipeline/kanban, fluxos, campanhas,
                                       agentes IA, Meta Ads, cobrança) — depende SÓ de wa-port + crm-db
  apps/
    crm-api/        fábrica `createCrmRoutes(deps): Hono` montável em `/api/crm` (standalone OU dentro da API do ai-manager)
    crm-worker/     consumidores do stream de eventos + filas BullMQ do CRM (prefixo `crm`)
    crm-web/        dashboard React (pode ser servido separado ou embutido no dashboard do ai-manager)
    standalone/     composição: wa-engine + crm-api + crm-worker num deploy só (modo independente)
```

### 13.3 O contrato `WaGateway` (pacote `wa-port`)

Espelha os nomes do ai-manager para que o adaptador seja fino:

```ts
// comandos (síncronos do ponto de vista do CRM)
interface WaGateway {
  sessions: Pick<SessionsControl, 'list' | 'get' | 'create' | 'startQr' | 'getQr' | 'requestPairingCode'
                                 | 'pause' | 'resume' | 'restart' | 'logout' | 'remove'>
  send(req: SendRequest): Promise<MessageView>            // = SendPipeline.send (gates → fila → antiban)
  sendGroup(req): Promise<MessageView>
  cancel(messageId: string): Promise<MessageView>
  fetchGroups(sessionId: string): Promise<GroupSummary[]>
  downloadMedia(sessionId: string, ref: MediaHandle): Promise<ReadableStream | Buffer>   // NOVO (lacuna 1)
  presence?(sessionId: string, to: string, kind: 'composing' | 'recording' | 'paused'): Promise<void> // NOVO
}
// eventos (assíncronos): WaEvent v1, schema zod, JSON
type WaEvent =
  | { v: 1; type: 'message.inbound';  sessionId; message: IncomingMessage & { media?: MediaHandle; quotedId?; ad?: CtwaInfo } }
  | { v: 1; type: 'message.status';   sessionId; messageId; transportMessageId; status: MessageStatus }
  | { v: 1; type: 'session.state';    sessionId; from; to }
  | { v: 1; type: 'session.connection'; sessionId; state: 'open' | 'close'; reason? }
  | { v: 1; type: 'contact.lid-mapping'; sessionId; lid; pn }
```

`SendRequest`, `MessageView`, `SessionView`, `GroupSummary`, `IncomingMessage`, `MessageStatus` têm **exatamente** a forma dos tipos de `@wsm/core` (copiar, não reinventar).

### 13.4 Transporte dos eventos: Redis Streams

- Stream `wsm:events` (XADD com `MAXLEN ~ 100000`), payload `WaEvent` JSON; o CRM consome com **consumer group** `crm` (XREADGROUP/XACK) — entrega pelo menos uma vez, retomada após queda, múltiplas réplicas do crm-worker.
- Idempotência no CRM pela chave `(sessionId, message.id)` (unique no `crm`), já que o stream é *at-least-once*.
- Por que Streams e não pub/sub: pub/sub perde eventos com o consumidor fora do ar; webhooks HTTP exigiriam reentrega própria. Por que não BullMQ: o produtor não deve conhecer os consumidores (fan-out para vários grupos é nativo do Streams).
- No **standalone**, o `wa-engine` publica no mesmo stream com o mesmo formato → o código do `crm-worker` é idêntico nos dois modos.

### 13.5 Mudanças aditivas necessárias no ai-manager (quando for plugar)

| # | Mudança | Onde | Observação |
|---|---|---|---|
| A1 | `attachEventOutbox(manager, queue, redis)` publica `WaEvent` no stream | novo `apps/worker/src/events/` + 1 linha em `boot/start.ts` | mesmo padrão `attachX` → `onStop` |
| A2 | `IncomingMessage.media?` + `WaTransport.downloadMedia?()` | `core/transport/types.ts`, `baileys.ts` (`downloadMediaMessage`) | campos opcionais: não quebra consumidores |
| A3 | Novos alvos RPC `media.download`, `presence.update` | `bridge-targets.ts` | lista fechada continua fechada |
| A4 | Extração de `contextInfo.externalAdReply`/CTWA e quoted no `toIncomingMessage` | `baileys.ts:236` | opcional |
| A5 | Evento de mapeamento LID↔PN (`lid-mapping.update`) | `baileys.ts` | o CRM guarda a identidade; `public.contacts` não muda |
| A6 | Montagem opcional `app.route('/api/crm', createCrmRoutes(deps))` | `apps/api/src/routes/index.ts` (aditivo) | só se o usuário quiser API única; senão o crm-api roda em porta própria |
| A7 | Alvos RPC `contacts.recordConsent`, `contacts.optOut`, `contacts.list` (sobre `ContactsService`) | `apps/worker/src/boot/bridge-targets.ts` | o gate `contactAllowed` do ai-manager exige consentimento em `public.contacts`; o CRM registra consentimento `inbound` e opt-out por esta via (SPEC 1.4 nº 3, T20/T26/T33) |

Nenhuma tabela `public.*` do ai-manager é alterada; o CRM só **lê** `public.sessions`/`public.messages` (views ou queries) e grava em `crm.*`.

### 13.6 Modos de execução

| Modo | Quem abre o Baileys | Gateway usado | Banco |
|---|---|---|---|
| **standalone** (`WA_GATEWAY=local`) | worker do leonas-crm (`wa-engine`) | `wa-gateway-local` | Postgres próprio: `public.*` (tabelas WhatsApp com o schema do ai-manager) + `crm.*` |
| **extensão** (`WA_GATEWAY=ai-manager`) | worker do ai-manager | `wa-gateway-aimanager` (RPC `INTERNAL_TOKEN` + stream) | Postgres do ai-manager: `public.*` dele + `crm.*` (migrations do CRM com tabela de controle própria em `crm`) |

Migração standalone → extensão: como `public.*` do wa-engine tem o mesmo schema e as mesmas credenciais cifradas (`CREDENTIALS_KEY` igual), as sessões podem ser movidas sem novo QR (dump das tabelas `sessions`, `session_credentials`, `proxies`, `session_limits`). **Regra operacional:** nunca rodar os dois workers com a mesma sessão ao mesmo tempo (o WhatsApp derruba um dos dois e o antiban perde a contagem).

### 13.7 Auth na fronteira

- O CRM tem usuários/papéis próprios (`crm.users`, `crm.memberships`) — o modelo `admin` único do ai-manager não basta.
- O crm-api aceita: (a) sessão própria do CRM; (b) no modo extensão, o token `wsm1.*` do painel do ai-manager, verificado com o mesmo `AUTH_SECRET`, mapeado para um usuário CRM `owner`. Interface `AuthPort.verify(token) → { userId, role }`.
- Chamadas CRM → worker usam `INTERNAL_TOKEN`; o `actor` enviado ao pipeline é `crm:<userId>` (aparece em `audit_logs`).

### 13.8 Regras para o código do clone (para manter a plugabilidade)

- `crm-core` e `crm-api` **não importam** `@crm/wa-engine` nem `@whiskeysockets/baileys`; só `@crm/wa-port`. Fazer cumprir com regra ESLint `no-restricted-imports`.
- Tipos e nomes do `wa-engine` seguem o ai-manager 1:1 (`SessionManager`, `MessageQueue`, `SendPipeline`, `GATE_ORDER`, estados de sessão/mensagem, prefixo Redis `wsm`, fila `session:<id>`); divergência só por acréscimo.
- Testes do CRM rodam contra `FakeWaGateway` (implementa `WaGateway` + emite `WaEvent`) — mesmo espírito do `FakeTransport`.
- Filas do CRM usam prefixo BullMQ próprio (`crm`) para não colidir com `wsm:session:*`.
