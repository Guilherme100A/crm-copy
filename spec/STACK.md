# STACK — leonas-crm

> Pesquisa de 2026-10-15. **Regra de versão:** quando a lib existe no `pnpm-lock.yaml` do ai-manager, vale **a versão do lock** (paridade para rodar como extensão). Desvios só por segurança ou necessidade, e estão marcados com ⚠.
> Docs: MCP context7 (`resolve-library-id` → `query-docs`) na versão do lock ou na mais próxima indexada (cada bloco diz qual). Baileys e baileys-antiban foram conferidos também nos tarballs publicados (`npm pack`), porque o context7 segue o master do Baileys e não indexa o antiban. Versões "latest" vêm de `registry.npmjs.org` na data acima.
> Arquitetura e fronteira de extensão: ver `spec/AI-MANAGER-MAP.md`.

## 0. Resumo executivo

### 0.1 Versões fixadas (backend + base)

| Pacote | Versão | Origem | Nota |
|---|---|---|---|
| node (engines) | **≥ 22.12** (usar Node 22 LTS) | ⚠ desvio | vitest 5 exige Node ≥ 22.12 (o ai-manager ainda declara `>=20`); openai@7 também exige 22 |
| pnpm | 9.15.9 | ai-manager | |
| typescript | ~6.0.3 | lock | |
| hono | 4.13.8 | lock | latest 4.13.13 (patch) — subir junto com o ai-manager |
| @hono/node-server | 2.1.1 | lock | WebSocket nativo; **não** usar `@hono/node-ws` (deprecado) |
| zod | 4.6.5 | lock | latest 4.6.7 (patch) |
| pino | 10.3.1 | lock | Baileys traz pino 9.14 transitivo |
| vitest | 5.0.1 | lock | |
| drizzle-orm / drizzle-kit | 0.45.3 / 0.31.11 | lock | **não** misturar com drizzle v1 RC (APIs `defineRelations` etc. não existem na 0.45) |
| pg | 8.23.0 | lock | |
| bullmq | 6.3.8 | lock | API `repeat` removida no v6 → Job Schedulers |
| ioredis | 6.0.0 | lock | RESP3 default; `maxRetriesPerRequest: null` em conexões de Worker |
| @whiskeysockets/baileys | **7.0.0-rc14 (exato)** | lock | nomes mudam entre RCs |
| baileys-antiban | **4.10.0 (exato, sem `^`)** | lock | ai-manager usa `^` — fixar no clone |
| sharp | 0.35.4 | lock | binário nativo na mesma imagem do worker |
| ai (Vercel AI SDK) | **7.0.142 (exato)** | novo | Node ≥ 22, ESM; só o adapter `llm-aisdk` importa (Bloco F) |
| @ai-sdk/anthropic / openai / google | **4.0.81 / 4.0.95 / 4.0.98 (exatos)** | novo | major 4 ↔ `ai@7`; subir os quatro juntos |
| @anthropic-ai/sdk | 0.128.0 | lock | 0.135.0 disponível sem breaking; usado pelo `AiProvider` do ai-manager e por adapter direto se preciso |
| openai / @google/genai | 7.34.0 / 2.30.0 | novo (opcional) | só para adapter direto atrás da mesma porta; openai@7 exige Node ≥ 22 |
| @elevenlabs/elevenlabs-js / groq-sdk | 2.73.0 / 1.6.0 | novo | TTS / STT confirmados pelo usuário |
| nodemailer | **10.1.1** | ⚠ desvio (lock 10.0.10) | 10.1.1 corrige vazamento de credenciais em redirect |
| react / react-dom / react-is | 19.3.0 | lock | |
| vite / @vitejs/plugin-react | 8.3.0 / 6.1.1 | lock | Rolldown + Oxc |
| recharts | 3.10.1 | lock | |

### 0.2 Decisões recomendadas (uma por item)

| Item | Escolha | Por quê (resumo; detalhes no bloco) |
|---|---|---|
| Roteamento + data fetching | **TanStack Router 1.170.44 + TanStack Query 5.104.3** | filtros tipados na URL (`validateSearch` com zod 4 direto); cache do Query é o alvo dos eventos realtime; react-router 8 tem search params sem tipo |
| UI | **Tailwind CSS 4.3.3 (`@tailwindcss/vite`) + shadcn/ui (CLI 4.21.5, Base UI 1.9.0)** | CSS-first, código no repo; shadcn usa Base UI por padrão desde jul/2026 (`--base radix` se preferir Radix) |
| Builder de fluxos | **@xyflow/react 12.12.0** | padrão de mercado; persistir formato próprio validado por zod (não o `toObject()` cru) |
| Kanban DnD | **@dnd-kit/react 0.5.1 (exato)** | API nova recomendada pelos docs (`useSortable({ group })` + `move()`); `@dnd-kit/core` sem release desde dez/2024. Risco 0.x → isolar num componente |
| Realtime de chats | **SSE (Hono `streamSSE` + `EventSource`)** | tráfego servidor→cliente; cookie same-origin; retomada com `Last-Event-ID` lendo do Redis Stream `wsm:events` (mesmo barramento da fronteira de extensão) |
| CSV | **papaparse 5.7.0** | cliente com worker+chunk para prévia/mapeamento; arquivos grandes no servidor (`NODE_STREAM_INPUT`) num job BullMQ |
| Gráficos | **recharts 3.10.1** (via componente Chart do shadcn) | já usado no ai-manager |
| Meta Marketing / CAPI | **cliente `fetch` próprio sobre Graph API v26.0** | SDK oficial publicado (24.0.1) ainda aponta para v24, que expirou em 06/10/2026, e usa token global (ruim p/ multi-tenant) |
| TTS (vozes dos agentes) | **ElevenLabs** (`@elevenlabs/elevenlabs-js` 2.73.0, `eleven_flash_v2_5`) — ✅ confirmado pelo usuário | melhor pt-BR, clonagem de voz, saída opus; sempre passar por ffmpeg → Ogg/Opus mono para PTT. Fallback: OpenAI `gpt-4o-mini-tts` |
| STT (áudios recebidos) | **Groq `whisper-large-v3-turbo`** (`groq-sdk` 1.6.0) — ✅ confirmado pelo usuário | ~US$0,04/h, aceita ogg, API compatível com OpenAI; `language: 'pt'` sempre |
| LLM (multi-provider por agente) — ✅ requisito do usuário | **Porta própria `LlmProvider` + adapter único sobre Vercel AI SDK 7** (`ai` + `@ai-sdk/anthropic\|openai\|google`); adapter direto do SDK oficial só para recurso exclusivo | um `generateText` cobre tools multi-step, structured output e usage dos 3 provedores; porta limita o lock-in a 1 arquivo; custo calculado por tabela própria `crm.llm_prices`; ver Bloco F |
| Limites de uso de IA (substitui cobrança) | **cota de tokens/custo por empresa** (Redis + `crm.ai_usage`), checada antes de cada chamada | ✅ decisão do usuário: sem cobrança por agora (Stripe/Asaas fora do escopo) |
| E-mail | **nodemailer 10.1.1** com transporte singleton `pool: true` + DKIM | alternativa transacional: Resend / SES v2 |

### 0.3 Armadilhas de versão mais perigosas (top 14)

1. **Node:** vitest 5 → Node ≥ 22.12. Padronizar Node 22 LTS no clone (Docker e CI).
2. **drizzle:** docs do context7 são da v1 beta. Em 0.45.3 use `relations()` clássico + `drizzle(pool, { schema })`; nada de `defineRelations`, `drizzle-orm/_relations`, `pgTable.withRLS`.
3. **drizzle-kit:** prompt interativo de rename trava CI/agentes; migrations geradas em paralelo colidem no `prevId`. Gerar migrations numa única branch/tarefa por vez. Para conviver com o ai-manager: `pgSchema('crm')` + `migrationsSchema: 'crm'`.
4. **bullmq 6:** `repeat`/repeatables removidos → `upsertJobScheduler`; `queue.resume()` async; `queue.client` → `await queue.getBackend().client`; groups (limite por chave) só no Pro → uma fila por chave. `pg` aparece como peer porque o v6 tem backend Postgres opcional — **manter Redis**.
5. **ioredis 6:** RESP3 por default; Worker do BullMQ precisa `maxRetriesPerRequest: null`; pub/sub em conexão `duplicate()`.
6. **Baileys rc14:** ESM-only; LID via `key.remoteJidAlt`/`participantAlt` (não `senderPn`), `sock.signalRepository.lidMapping`, evento `lid-mapping.update`; `isJidUser` → `isPnUser`/`isLidUser`; `printQRInTerminal` removido; `group-participants.update` entrega objetos.
7. **Baileys defaults:** `markOnlineOnConnect: true` silencia notificações do celular do cliente → `false`; `shouldSyncHistoryMessage` descarta FULL sync mesmo com `syncFullHistory: true`; `getMessage`/`cachedGroupMetadata` são no-op e precisam de implementação.
8. **Contatos/LID no CRM:** deduplicar por duas colunas únicas (`wa_lid`, `phone_e164`), nunca pelo JID cru.
9. **Antiban:** receipts precisam chegar em `onDelivered`, senão após 10 envios/h os limites caem a 25%. Não combinar `wrapSocket` com o adapter (delay dobrado). Não tratar 428 como fatal (no Baileys é connectionClosed).
10. **zod 4:** `error` substitui `required_error`/`invalid_type_error`/`errorMap`; `z.email()`/`z.url()` top-level; `z.record` exige 2 args; `.default` curto-circuita (use `.prefault` p/ semântica v3); `z.coerce.boolean('false') === true`.
11. **SSE:** `EventSource` não manda `Authorization` → cookie (ou token curto em query); heartbeat 15–25 s (o `streamSSE` não faz keepalive); `proxy_buffering off` no nginx; não comprimir `text/event-stream`.
12. **Modelos Claude 5.5:** desligar thinking ou passar `budget_tokens` → 400; `tool_choice` `any`/`tool` → 400; sem prefill.
13. **AI SDK 7:** `ai@7` só funciona com `@ai-sdk/*@4`; renames (`isStepCount`, `instructions`, `onStepEnd/onEnd`, `output`), `generateObject` deprecado, `usage` já é total com `inputTokenDetails/outputTokenDetails`; `model` como string solta passa pelo Vercel AI Gateway — sempre instância de provider criada por empresa; `maxRetries: 0` (retry é do BullMQ). Exemplos v4–v6 não compilam.
14. **OpenAI / Gemini:** Responses API com `store: true` por padrão → `store: false` para dados de cliente; Gemini exige reenviar o turno do modelo com `thoughtSignature` (guardar `providerData` opaco); `@google/generative-ai` é legado (usar `@google/genai`); preços do Gemini dobram em 2026-12-01/2027-01-01 → preços em tabela, não no código.

### 0.4 Pontos não verificados (marcados nos blocos)

Preços de Google/Azure TTS, AssemblyAI, OpenAI TTS/`gpt-transcribe`; se a saída opus da ElevenLabs vem em container Ogg (por isso ffmpeg sempre); semântica de cada 4xx de `groupParticipantsUpdate`; alias `zod/v4` e API exata de `z.stringbool`; se omitir `thoughtSignature` no Gemini dá 400 ou só piora o raciocínio; linhas v4→v5→v6 da tabela de armadilhas do AI SDK e `RetryError.lastError` (memória do agente, não docs v7).

---

## Bloco A — hono, @hono/node-server, zod 4, pino 10, vitest 5

Versões tiradas do `pnpm-lock.yaml` do ai-manager (referência, somente leitura):

| Pacote | Versão no lock | Docs no context7 | Versão coberta pelas docs |
|---|---|---|---|
| hono | 4.13.8 | `/honojs/hono/v4.13.0` (com versão) | 4.13.0 (não há 4.13.8 exato; mesma minor) |
| @hono/node-server | 2.1.1 | `/honojs/node-server` (sem versões listadas) | branch `main` (linha 2.x) |
| @hono/zod-validator / @hono/standard-validator / @hono/node-ws | não usados no ai-manager | `/honojs/middleware` (sem versões) | branch `main` |
| zod | 4.6.5 | `/colinhacks/zod/v4.6.5` | 4.6.5 (exato) |
| pino | 10.3.1 (+ 9.14.0 transitivo) | `/pinojs/pino/v10.1.0` | 10.1.0 (não há 10.3.x; mesma major) |
| vitest | 5.0.1 | `/vitest-dev/vitest/v5.0.3` | 5.0.3 (patch acima; mesma major) |
| vite (para referência) | 8.3.0 | — | — |
| ws (para referência) | 8.21.3 | — | — |

---

### 1. hono 4.13.8 + @hono/node-server 2.1.1

**Library ID:** `/honojs/hono/v4.13.0` (docs versionadas disponíveis, 4.13.0); `/honojs/node-server` (sem versão, conteúdo do main = v2); `/honojs/middleware` (main).

#### Como o ai-manager usa
- `apps/api/src/app.ts`: `createApp(deps)` retorna `new Hono<AppEnv>()` **sem abrir porta**; middlewares globais (`requestId` de `hono/request-id`, request logger pino, `bearerAuth` próprio em `/api/*`, auditoria), `app.onError(onError)`, `app.notFound(notFound)`, e `registerRoutes(app, deps)`. `export type App = ReturnType<typeof createApp>`.
- Cada rota é um arquivo `apps/api/src/routes/*.ts` com `new Hono()` montado via `app.route(...)`.
- Validação: **não usa @hono/zod-validator**; tem um wrapper próprio em `apps/api/src/validate.ts` sobre `validator` de `hono/validator` + `schema.safeParseAsync`, lançando `ApiError('VALIDATION_ERROR')`.
- Erros: `apps/api/src/errors.ts` — `ApiError(code, message, details)` com tabela `ERROR_STATUS` tipada como `ContentfulStatusCode` (`hono/utils/http-status`); corpo `{ error: { code, message, details? } }`.
- Server: `serve` de `@hono/node-server` em `apps/api/src/server.ts` e um servidor interno no worker (`apps/worker/src/boot/internal-server.ts`). `getConnInfo` de `@hono/node-server/conninfo`.
- **Não há SSE nem WebSocket hoje** no ai-manager (grep por `streamSSE`/`upgradeWebSocket` vazio). O clone vai introduzir o primeiro.

#### Rotas / sub-apps
```ts
const book = new Hono()
book.get('/list', (c) => c.json({ books: [] }))
book.onError((err, c) => c.text('Book error: ' + err.message, 500))
const app = new Hono()
app.route('/api/book', book) // GET /api/book/list
// alternativa: new Hono().basePath('/api')
```
Docs 4.13: em `app.route`, as rotas do sub-app são re-registradas e o `onError` próprio do sub-app é preservado.

#### Middleware tipado (Variables)
```ts
import { createMiddleware } from 'hono/factory'
type Env = { Variables: { user: { name: string } } }
const setUser = createMiddleware<Env>(async (c, next) => {
  c.set('user', { name: c.req.header('x-user') ?? 'anonymous' })
  await next()
})
// handler: c.var.user / c.get('user') tipados
```
- Preferir passar o `Env` como genérico (`new Hono<AppEnv>()`, `createMiddleware<AppEnv>`) — padrão do ai-manager (`AppEnv` em `types.ts`). `declare module 'hono' { interface ContextVariableMap {...} }` também funciona, mas é global (vaza entre apps; evitar se o clone vai rodar como extensão no mesmo processo).
- `createFactory<Env>()` (`hono/factory`) oferece `createApp`, `createMiddleware`, `createHandlers` já tipados.

#### Erros
```ts
import { HTTPException } from 'hono/http-exception'
throw new HTTPException(400, { message: 'Bad input', cause: e })
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'erro' } }, 500)
})
```

#### Validação com zod 4
- `@hono/zod-validator` (main): peer `hono >=4.11.2`, `zod ^3.25.0 || ^4.0.0` → **compatível com zod 4.6.5 e hono 4.13.8**.
- `@hono/standard-validator` (`sValidator`) aceita qualquer Standard Schema (zod 4 implementa) — mesma API, com hook:
```ts
import * as z from 'zod'
import { sValidator } from '@hono/standard-validator'
app.post('/post',
  sValidator('json', schema, (result, c) => {
    if (!result.success) return c.text('Invalid!', 400)
  }),
  (c) => c.json(c.req.valid('json')))
```
- **Recomendação:** manter o padrão do ai-manager (wrapper `validate(target, schema)` sobre `hono/validator`) para que o formato de erro 400 seja idêntico ao do ai-manager — essencial para plugar como extensão. Se quisermos dependência pronta, `@hono/zod-validator` com hook que lança o mesmo `ApiError`.

#### Streaming / SSE (realtime de chats)
Assinatura (4.13): `streamSSE(c, cb, onError?)`; `SSEMessage = { data, event?, id?, retry? }`; `StreamingApi` tem `aborted`, `closed`, `onAbort(listener)`, `sleep(ms)`, `close()`.
```ts
import { streamSSE } from 'hono/streaming'
app.get('/api/chats/stream', (c) => streamSSE(c, async (stream) => {
  const off = bus.subscribe((ev) => stream.writeSSE({ event: ev.type, data: JSON.stringify(ev), id: ev.id }))
  stream.onAbort(() => off())             // cliente desconectou
  while (!stream.aborted) {               // keepalive manual
    await stream.writeSSE({ event: 'ping', data: '' }); await stream.sleep(25_000)
  }
}, async (err, stream) => { logger.error({ err }, 'sse') }))
```
- **Não há keepalive embutido**: fazer loop com `sleep` (proxies/ELB derrubam conexão ociosa ~30–60 s).
- Se o callback lançar, o `onError` roda e um frame `event: error` é emitido antes de fechar.
- `id` + `retry` permitem retomada com `Last-Event-ID` (ler `c.req.header('last-event-id')`).
- Autenticação: `EventSource` do browser não manda header `Authorization` → usar cookie de sessão ou token em query (o ai-manager já tem `loginTokenAuth`; verificar se aceita cookie).

#### WebSocket no Node (@hono/node-server 2.x)
**Armadilha importante:** `@hono/node-ws` (`createNodeWebSocket` + `injectWebSocket`) está **DEPRECATED** — o README diz que o Node adapter v2 tem WebSocket embutido. Com `@hono/node-server@2.1.1` use:
```ts
import { serve, upgradeWebSocket } from '@hono/node-server'
import { WebSocketServer } from 'ws'
app.get('/ws', upgradeWebSocket(() => ({
  onOpen: (_e, ws) => ws.send('welcome'),
  onMessage: (e, ws) => ws.send(e.data),
  onClose: (e) => log.info({ code: e.code }, 'ws closed'),
}), { onError: (err) => log.error({ err }) }))
serve({ fetch: app.fetch, websocket: { server: new WebSocketServer({ noServer: true }) } })
```
- Requer `ws` (lock já tem `ws@8.21.3`) e `@types/ws` no pacote consumidor.
- Fora de `serve` com `websocket` configurado (ex.: `app.request()` em teste), o middleware devolve 500.
- Binário chega como `ArrayBuffer`; `onClose` reason é `Uint8Array`.
- A assinatura de `serve()` não mudou de 1.x para 2.x.

#### RPC client `hc` (opcional para o dashboard)
```ts
import { hc } from 'hono/client'
const client = hc<AppType>('/') // AppType = typeof app (rotas encadeadas)
const res = await client.users.$post({ json: { name: 'x' } })
```
Só infere tipos se as rotas forem **encadeadas** (`new Hono().get(...).post(...)`) e o validador for tipado; o padrão `registerRoutes(app, deps)` do ai-manager (mutação, sem encadeamento) **não gera tipos para hc**. Para o clone: decidir entre (a) rotas encadeadas por módulo + `hc`, ou (b) manter padrão ai-manager e tipos compartilhados via zod (recomendado para consistência com o ai-manager).

#### Testes
```ts
const res = await app.request('/hello', { method: 'POST', body: 'x' }) // sem porta
import { testClient } from 'hono/testing'                            // hc ligado a app.request
const client = testClient(app); await client.users.$get()
```
ai-manager: `createApp(deps)` com deps injetadas + `app.request(...)`; teste de auth usa `serve` real (`routes/auth.db.unit.test.ts`).

#### Armadilhas de versão — hono
- context7 só tem 4.13.0; lock é 4.13.8 (patch). APIs acima estáveis desde 4.x.
- `@hono/node-ws` deprecated em favor de `upgradeWebSocket` do `@hono/node-server` 2.x — não instalar node-ws.
- `@hono/zod-validator` exige `hono >= 4.11.2` (ok).
- SSE: sem keepalive automático; sem header Authorization no `EventSource`.
- `ContextVariableMap` global vaza entre apps montadas no mesmo processo — preferir genérico `Env`.
- `hc` exige rotas encadeadas; não funciona com o padrão de registro por mutação.

---

### 2. zod 4.6.5

**Library ID:** `/colinhacks/zod/v4.6.5` — docs da versão exata disponíveis.

#### Como o ai-manager usa
`import { z } from 'zod'` (core/ai/provider.ts, conversations/index.ts); `import type { z } from 'zod'` + `z.ZodType`/`z.output<T>` no `validate.ts`; `ZodError` em `errors.ts` (converte `issues` em `{ path: 'a.b.0', message, code }`).

#### Import path
- Em zod ≥ 4.0, `'zod'` **é** a v4 (classic) (docs 4.6.5 usam `import * as z from "zod"`). `'zod/v4'` continua como alias (de memória, não confirmado no context7); `'zod/v3'` dá a API antiga; `'zod/v4/core'` é para autores de libs; `'zod/mini'` é a variante tree-shakable. **Padronizar `import { z } from 'zod'`** (igual ao ai-manager). Nunca misturar `zod/v3` e `zod` no mesmo schema.

#### Mudanças principais v3 → v4 (verificadas)
- Formatos de string no topo: `z.email()`, `z.url()`, `z.uuid()`, `z.iso.date()`… `z.string().email()` ainda existe mas é `@deprecated`. Formatos aceitam `.min/.max`: `z.email().min(10)`.
- Customização de erro unificada no param `error` (string ou função). `message` é deprecated; **`required_error`, `invalid_type_error`, `errorMap` foram removidos**.
```ts
z.string().refine((v) => v.length > 8, { error: (iss) => `Too short: "${iss.input}"` })
z.config({ customError: (iss) => 'Erro genérico' }) // mapa global
```
- Objetos: `z.strictObject({...})` / `z.looseObject({...})`; `.strict()` ainda existe (sugere `z.strictObject`), `.passthrough()` deprecated → `.loose()`; `.strip()` é o default; `.merge()` deprecated → `A.extend(B.shape)`.
- `z.record` exige **dois argumentos** (`z.record(z.string(), z.string())`); com chave `z.enum` a checagem é exaustiva.
- `ZodError`: `.format()`/`.flatten()` deprecated → `z.treeifyError(err)`; `z.prettifyError(err)` para string legível; `.addIssue` deprecated (push em `.issues`).
- `z.coerce.*` tem input `unknown` por padrão; tipar com genérico `z.coerce.number<string>()`. `z.coerce.boolean()` usa `Boolean(v)` → `"false"` vira `true` (verificado); para env/query usar `z.stringbool()` (existe em v4, não reconsultado no context7).
- `.default(v)` recebe valor do **output** e curto-circuita o parse; `.prefault(v)` recebe input e passa pelo parse (verificado 4.6.5).
- `z.toJSONSchema(schema)` nativo (sem lib extra); objetos geram `additionalProperties: false`, exceto com `{ io: 'input' }`. Útil para schemas de tool use do LLM.
- `z.infer<typeof S>` / `z.input` / `z.output` continuam iguais.
- Discriminated union:
```ts
const Ev = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), body: z.string() }),
  z.object({ type: z.literal('audio'), url: z.url(), ptt: z.boolean() }),
])
```
  Em uniões não discriminadas, `z.object` remove chaves extras e pode "casar" com dois ramos; usar `z.strictObject` no ramo mais estreito para exclusividade.

#### Armadilhas de versão — zod
- `required_error`/`invalid_type_error`/`errorMap` geram erro de tipo em v4 (removidos) — código copiado de exemplos v3 quebra.
- `z.record(valor)` com um argumento não existe mais.
- `.default()` em v4 aplica ao **output** e curto-circuita (valor default não passa pelo parse); usar `.prefault()` para o comportamento v3.
- `z.coerce.boolean` para envs é armadilha — usar `z.stringbool()`.
- Libs de terceiros que ainda dependem de zod 3 (ex.: alguns SDKs) precisam de `zod ^3.25` que embarca os dois; verificar peerDeps antes de adicionar (o `@anthropic-ai/sdk` e MCP SDK aceitam zod 4 nas versões recentes — confirmar no bloco LLM).

---

### 3. pino 10.3.1

**Library ID:** `/pinojs/pino/v10.1.0` — docs da v10.1.0 (não há 10.3.x no context7; mesma major).

#### Como o ai-manager usa
`packages/core/src/logger/index.ts`: `import { pino, type Logger, type LoggerOptions, type DestinationStream } from 'pino'`. `createLogger(opts)` com `level: process.env.LOG_LEVEL || 'info'`, **redação profunda própria** via `formatters.log` e `formatters.bindings` (`redactSecrets`, lista `SENSITIVE_LOG_KEYS`: creds, keys, noiseKey, token, authorization, cookie…, comparação case/`-`/`_`-insensitive) e um wrapper em `logger.child` que também higieniza bindings de children. Destino opcional (`DestinationStream`) para testes. **Não usa transports nem pino-pretty** (JSON em stdout). O clone deve reutilizar esse `createLogger` (ou copiar) — o `redact` nativo do pino só aceita caminhos fixos, não "qualquer chave em qualquer profundidade", por isso o ai-manager fez o seu.

#### Logger / child
```ts
import { pino } from 'pino'
const logger = pino({ level: 'info', redact: ['req.headers.authorization', 'password'] })
const log = logger.child({ sessionId }, { level: 'debug', msgPrefix: '[wa] ' })
log.info({ jid }, 'mensagem enviada')
```
Child aceita `level`, `msgPrefix`, `redact` próprios; bindings aparecem em toda linha.

#### Redact
```ts
pino({ redact: { paths: ['apiKey', 'user.password', 'a[*].token'],
  censor: (v, path) => `***${String(v).slice(-4)}`, remove: false } })
```
Default de censura `'[Redacted]'`; `remove: true` apaga a chave. Nunca montar `paths` com input de usuário.

#### Transports (worker thread)
```ts
const transport = pino.transport({ targets: [
  { target: 'pino/file', level: 'info', options: { destination: 1 } },
  { target: 'pino-pretty', level: 'debug', options: { colorize: true } },
] })
const logger = pino(transport)
```
- Transports rodam em **worker thread** (thread-stream); `dedupe: true` envia só para o target de maior nível.
- pino-pretty **só em dev** (`NODE_ENV !== 'production'`); em produção JSON puro em stdout.
- Com `targets` e níveis customizados, passar `levels` em `pino.transport` (docs v10.1.0). (Não verificado no context7: restrição de `formatters.level` com multi-target — testar se for usar.)

#### Breaking 9 → 10
- Principal mudança documentada: **v10 remove suporte a Node 18** (v9 suportava 18/20/22; CI do v10 testa 20, 22, 24, 25, 26). API de logger/child/redact/transport sem mudança relevante para nosso uso.
- **pino 9.14.0 no lock**: é dependência transitiva de `@whiskeysockets/baileys@7.0.0-rc14`. Consequência: o tipo `Logger` do pino 10 e o `ILogger` que o Baileys espera vêm de pacotes diferentes; passar o logger do app para `makeWASocket({ logger })` funciona em runtime (interface `child/trace/debug/info/warn/error` compatível), mas pode exigir cast de tipo. Não há duas instâncias de transport porque o Baileys só usa o objeto que recebe.

#### Armadilhas de versão — pino
- Node ≥ 20 obrigatório (ok: vitest 5 já exige ≥ 22.12).
- Em ESM usar `import { pino } from 'pino'` (named) como o ai-manager; default import também existe.
- Transports exigem que o pacote target (`pino-pretty`) seja resolvível a partir do processo — em monorepo pnpm, instale no app que cria o logger.
- `redact` nativo não faz match por nome de chave em qualquer profundidade (wildcards só por nível): manter o redator do ai-manager para credenciais Baileys.

---

### 4. vitest 5.0.1

**Library ID:** `/vitest-dev/vitest/v5.0.3` — docs v5.0.3 (5.0.1 não listada; mesma major).

#### Como o ai-manager usa
- Um `vitest.config.ts` **por pacote** com `defineConfig` de `'vitest/config'`, e o script `"test": "vitest run --passWithNoTests"` em cada pacote; raiz roda `pnpm -r test` (sem `test.projects`).
- `packages/core/vitest.config.ts`: `test.env = { ANTIBAN_MODE: 'passthrough' }` (modo explícito, nunca por `NODE_ENV`).
- `apps/dashboard/vitest.config.ts`: `include: ['src/**/*.unit.test.{ts,tsx}']`, `environment: 'node'` (só lógica pura, sem DOM).
- `tests/acceptance/vitest.config.ts`: `alias` regex `@wsm/(core|db)` → fonte; `pool: 'forks'`, `fileParallelism: false`, timeouts de 300 s.
- Convenção de nome: `*.unit.test.ts`, `*.db.unit.test.ts` (Postgres/Redis reais), testes de aceitação por tarefa (`tests/acceptance/Txx`).
- Imports explícitos (`import { describe, it, expect, vi } from 'vitest'`), sem `globals`.

#### Config / projects (substituto do workspace)
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { projects: [
    { test: { name: 'unit', include: ['**/*.unit.test.ts'] } },
    { extends: false, test: { name: 'db', include: ['**/*.db.unit.test.ts'], fileParallelism: false } },
  ] },
})
```
- `test.workspace` / `vitest.workspace.ts` → `test.projects` (removido desde v4).
- **v5:** projetos inline **herdam a config raiz por padrão** (plugins, `setupFiles`…), `extends: true` não é mais necessário; arrays (`setupFiles`) são **concatenados**; `extends: false` volta ao comportamento v4.
- `setupFiles` resolvidos relativos a `test.root`.
- `environment: 'node' | 'jsdom' | 'happy-dom'`; `pool: 'forks' | 'threads' | 'vmThreads'`.

#### Mocking
```ts
const { mocked } = vi.hoisted(() => ({ mocked: vi.fn() }))
vi.mock('./module.js', () => ({ originalMethod: mocked }))
mocked.mockReturnValue(100)
vi.setConfig({ testTimeout: 5_000 })
```
- **v5: `clearMocks` ligado por padrão** — `vi.clearAllMocks()` roda antes de cada teste; contagens de chamadas não acumulam entre testes.

#### Breaking changes 4 → 5 (verificado no migration guide)
- Requisitos: **Node ≥ 22.12** (`^22.12 || ^24 || >=26`) e **Vite ≥ 6.4** (peer `^6.4 || ^7 || ^8`; lock tem vite 8.3.0).
- Herança de config em projects + merge de arrays (acima); `clearMocks` default.
- Entrypoints removidos: `vitest/coverage`, `vitest/reporters` → `vitest/node`; `vitest/environments`, `vitest/snapshot` → `vitest/runtime`; `vitest/runners`, `vitest/suite` → `TestRunner` de `vitest`; `vitest/mocker` removido (`@vitest/mocker`). `vitest/config` continua.
- Herdado do v4: browser context em `vitest/browser` (não `@vitest/browser/context`); providers como pacotes separados (`@vitest/browser-playwright`).

#### Browser mode (React 19)
```ts
import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
export default defineConfig({ plugins: [react()], test: { browser: {
  enabled: true, provider: playwright(), instances: [{ browser: 'chromium' }] } } })
// teste: const screen = await render(<C/>) de 'vitest-browser-react'
// await expect.element(screen.getByText('Count is 2')).toBeVisible()
```
Recomendação: manter testes de lógica do dashboard em `environment: 'node'` (padrão ai-manager) e usar browser mode só para componentes críticos (kanban, builder de fluxos); a alternativa jsdom + Testing Library é mais leve mas menos fiel para drag-and-drop.

#### Armadilhas de versão — vitest
- Node 20 não roda vitest 5 — CI/dev precisam de Node ≥ 22.12 (o `engines` do ai-manager diz `>=20`: desatualizado).
- Testes que assumiam histórico de mock acumulado entre `it`s quebram com `clearMocks` default.
- Projects inline agora herdam `setupFiles` da raiz (concatenados) — pode rodar setup duas vezes se não usar `extends: false`.
- Docs do context7 são 5.0.3 vs lock 5.0.1 (patch).
- `@vitest/browser-playwright` deve ter a mesma versão do `vitest`.

---

## Bloco B — Persistência e filas: drizzle-orm, drizzle-kit, pg, bullmq, ioredis

Versões fixadas pelo `pnpm-lock.yaml` do ai-manager:

| Pacote | Versão | Observação do lock |
|---|---|---|
| drizzle-orm | **0.45.3** | peers resolvidos: `pg@8.23.0`, `@types/pg@8.23.1`, `@opentelemetry/api@1.9.1` |
| drizzle-kit | **0.31.11** | devDependency de `packages/db` |
| pg (node-postgres) | **8.23.0** | `pg-pool@3.14.0` |
| bullmq | **6.3.8** | `peerDependencies: { ioredis: '>=5.0.0', pg: '>=8.0.0', bullmq-otel: '>=2.0.0' }`, todos **opcionais** |
| ioredis | **6.0.0** | `engines: node >=20` |

Padrões atuais do ai-manager (somente leitura, conferidos no código):
- `packages/db/src/client.ts`: `drizzle(new pg.Pool({ connectionString, max: 10 }), { schema })`, com tipo `NodePgDatabase<Schema> & { $client: pg.Pool }`. As migrations rodam no boot com `migrate()` de `drizzle-orm/node-postgres/migrator`, protegidas por `pg_advisory_lock(7345001)` porque api e worker sobem juntos.
- `packages/db/drizzle.config.ts`: `defineConfig({ dialect: 'postgresql', schema: './src/schema/index.ts', out: './drizzle', dbCredentials: { url } })`. Já existem 8 migrations (`0000_init` … `0007_session_browser`) e `meta/_journal.json`.
- Schema: `uuid().primaryKey().defaultRandom()`, `timestamp(..., { withTimezone: true })`, enums via `pgEnum` alimentados por arrays `as const`, índices em array no 3º argumento, `check()` e um tipo custom `bytea`. **Não usa `relations()` nem `db.query.*`**: tudo é feito com o query builder SQL-like.
- `packages/core/src/queue/queue.ts`: cada sessão tem uma fila BullMQ `session:<id>` (o nome da fila é o `sessionId`, com `prefix` `wsm`). Concorrência 1 é garantida com `queue.setGlobalConcurrency(1)` mais `Worker({ concurrency: 1, runRetryDelay: 1000 })`. A conexão é passada como `ConnectionOptions` (objeto, não instância), convertida a partir de `REDIS_URL`. Usa `UnrecoverableError` e `WaitingError`.
- `apps/api/src/server.ts`: um `new Redis(REDIS_URL, { maxRetriesPerRequest: 1 })` separado para uso da API (não BullMQ).

---

### 1. drizzle-orm 0.45.3 + node-postgres

**context7:** `/drizzle-team/drizzle-orm-docs` (docs oficiais). **Não há docs específicas da 0.45.** O site atual cobre a linha **v1 (beta/RC)** e marca a sintaxe 0.x como "v1/legacy". As notas abaixo separam o que vale na 0.45 do que é só da v1. O id `/drizzle-team/drizzle-orm` tem a versão `drizzle-kit_0.31.5`, usada na seção do kit.

**Init (0.45):**
```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
export const db = drizzle(pool, { schema })   // db.$client === pool
```
`schema` (tabelas + objetos `relations()`) só é necessário para usar `db.query.*`.

**Schema (pg-core):**
```ts
export const msgStatus = pgEnum('msg_status', ['queued', 'sent', 'failed'])
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),                  // DEFAULT gen_random_uuid()
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').$type<{ text: string }>().notNull(), // tipo só em compile-time
  status: msgStatus('status').notNull().default('queued'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('messages_tenant_idx').on(t.tenantId, t.createdAt),
           uniqueIndex('messages_ext_uq').on(t.tenantId, t.status).where(sql`status <> 'failed'`)])
```
- O 3º argumento retorna um **array**. A forma antiga com objeto (`(t) => ({ ... })`) está deprecada desde a 0.36.
- `$type<T>()` não valida em runtime (use zod). Também impede `.default()` incompatível com o tipo.
- FK composta: `foreignKey({ columns: [...], foreignColumns: [...], name })`. Índice parcial: `.where(sql\`...\`)`. Também existem `.concurrently()` e `.with({...})`.

**Relations: qual vale na 0.45.x?**
- **Na 0.45.x vale a API clássica (RQB v1):** `import { relations } from 'drizzle-orm'`, uma por tabela, passadas junto do `schema` em `drizzle(pool, { schema })`.
```ts
export const usersRel = relations(users, ({ many }) => ({ posts: many(posts) }))
export const postsRel = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}))
const rows = await db.query.users.findMany({ with: { posts: true }, limit: 20 })
```
- **`defineRelations()` (RQB v2) é da linha v1.0 beta/RC.** Nela, `relations` passa a vir de `drizzle-orm/_relations` (legacy), o client recebe `drizzle(url, { relations })` e a doc "v0→v1 changes" diz literalmente "RQBv1 has been removed". **Não use `defineRelations` nem exemplos `r.many.x({ from, to })` com a 0.45.3.** Se a doc do context7 mostrar `defineRelations`, ela se refere à v1.
- Recomendação: seguir o ai-manager (query builder + joins explícitos). Use `relations()` v1 apenas se `db.query.*` for realmente útil, e isole isso para facilitar a migração futura para v1.

**Transações (pg):**
```ts
const saldo = await db.transaction(async (tx) => {
  await tx.update(accounts).set({ balance: sql`${accounts.balance} - 100` }).where(eq(accounts.id, a))
  await tx.transaction(async (tx2) => { /* SAVEPOINT */ })
  if (erro) tx.rollback()          // lança exceção, faz ROLLBACK e propaga
  return 42                        // valor retornado pelo transaction()
}, { isolationLevel: 'read committed', accessMode: 'read write' })
```
- `tx.rollback()` **lança** um erro (`TransactionRollbackError`). Capture-o fora da transação se for um fluxo esperado.
- Dentro da transação, use sempre `tx`, nunca `db`: `db` pega outra conexão do pool e fica fora da transação.

**Upsert, returning e SQL bruto:**
```ts
const [row] = await db.insert(contacts).values(rows)
  .onConflictDoUpdate({
    target: [contacts.tenantId, contacts.phone],
    set: { name: sql.raw(`excluded.${contacts.name.name}`), updatedAt: sql`now()` },
    setWhere: sql`${contacts.name} is distinct from excluded.name`,
  }).returning({ id: contacts.id })
await db.execute(sql`select pg_advisory_xact_lock(${key})`)
```
- O alvo do conflito precisa casar com uma unique constraint ou índice **não parcial**. Para índice parcial, há `targetWhere`.
- `onConflictDoNothing({ target })` também existe. Nesse caso `.returning()` volta vazio para linhas ignoradas.

**Paginação:** prefira keyset/cursor em listas grandes (chats, mensagens):
```ts
db.select().from(messages)
  .where(and(eq(messages.tenantId, t), cursor ? lt(messages.createdAt, cursor) : undefined))
  .orderBy(desc(messages.createdAt), desc(messages.id)).limit(50)
```
`limit/offset` funciona, mas degrada com offsets altos. Para cursor estável com timestamps iguais, use uma tupla (`createdAt`, `id`), por exemplo `sql\`(${t.createdAt}, ${t.id}) < (${c}, ${id})\``.

**Multi-tenancy e RLS:** `pgPolicy` e `pgRole` existem em `drizzle-orm/pg-core` e entram no 3º argumento da tabela. O drizzle-kit gera `CREATE POLICY` e habilita RLS.
```ts
pgPolicy('tenant_isolation', { as: 'permissive', for: 'all', to: appRole,
  using: sql`tenant_id = current_setting('app.tenant_id')::uuid`,
  withCheck: sql`tenant_id = current_setting('app.tenant_id')::uuid` })
```
- `pgTable.withRLS('t', {...})` é sintaxe da **v1 beta**. Na 0.45, o RLS é habilitado automaticamente ao declarar uma policy, ou com `.enableRLS()` na tabela (deprecado na v1).
- RLS exige rodar `set_config('app.tenant_id', $1, true)` **dentro da mesma transação** de cada request. Com pool, isso obriga a envolver cada request em `db.transaction`. Recomendação para o MVP: coluna `tenant_id` + filtro obrigatório na camada de repositório (helper `scoped(tenantId)`), deixando o RLS como defesa em profundidade numa fase posterior. O ai-manager hoje não é multi-tenant.

**Armadilhas de versão (drizzle-orm):**
- Quase toda a doc atual no context7/site é **v1 beta/RC**. Desconfie de: `defineRelations`, `drizzle-orm/_relations`, `pgTable.withRLS`, `drizzle(url, { relations })` e `through()` em many-to-many. Nada disso existe na 0.45.3.
- `timestamp` sem `withTimezone` vira `timestamp without time zone`. Mantenha `withTimezone: true`, como no ai-manager. O `mode` padrão é `'date'` (Date). `mode: 'string'` evita a conversão de fuso.
- `bigserial` e `bigint` precisam de `{ mode: 'number' | 'bigint' }`. O ai-manager usa `bigserial`.
- O tipo de `db` com `$client` vem da 0.36+. Mantenha o padrão `NodePgDatabase<Schema> & { $client: pg.Pool }`.

---

### 2. drizzle-kit 0.31.11

**context7:** `/drizzle-team/drizzle-orm/drizzle-kit_0.31.5`, o mais próximo disponível (código-fonte do kit na 0.31.x). Também `/drizzle-team/drizzle-orm-docs`, que é a doc v1. **Não há doc exata da 0.31.11.** A 0.31.5 tem o mesmo formato de pasta e journal.

**Config:**
```ts
import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  dialect: 'postgresql', schema: './src/schema/index.ts', out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
  // opcionais: schemaFilter, tablesFilter, casing: 'snake_case', strict: true, verbose: true
})
```

**Comandos:**
- `drizzle-kit generate [--name x] [--custom]`: compara o schema TS com o último snapshot em `meta/` e gera `NNNN_nome.sql`, `meta/NNNN_snapshot.json` e uma entrada em `meta/_journal.json`. `--custom` gera um SQL **vazio** para escrever à mão (backfill, extensões, triggers, `CREATE INDEX CONCURRENTLY`), mantendo a cadeia de snapshots.
- `drizzle-kit migrate`: aplica os `.sql` pendentes e registra em `drizzle.__drizzle_migrations`.
- `drizzle-kit push`: sincroniza direto, sem arquivo. Use **só em dev/protótipo**, nunca com a pasta de migrations versionada no mesmo banco.
- `drizzle-kit check` valida a cadeia. `drizzle-kit drop` remove a última migration (o comando some na v1). Existem também `studio`, `pull` e `up`.

**Migrator programático** (padrão do ai-manager, recomendado):
```ts
import { migrate } from 'drizzle-orm/node-postgres/migrator'
const client = await pool.connect()
await client.query('select pg_advisory_lock($1)', [KEY])
try { await migrate(drizzle(client), { migrationsFolder }) }
finally { await client.query('select pg_advisory_unlock($1)', [KEY]); client.release() }
```
Opções úteis de `migrate()`: `migrationsTable`, `migrationsSchema` (default `drizzle`). Elas servem para o clone ter **sua própria tabela de migrations** quando dividir o banco com o ai-manager.

**Armadilhas (drizzle-kit):**
- **Journal e colisão de branches:** cada snapshot aponta para o `prevId` do anterior. Duas branches que geram migrations em paralelo produzem dois snapshots com o mesmo `prevId`, e o `generate` aborta com "collision". A correção é `drizzle-kit drop` (ou apagar sql + snapshot + entrada no journal) e gerar de novo. Gere migrations num único fluxo serializado.
- **Renomes:** ao renomear coluna ou tabela, o `generate` pergunta de forma interativa (create vs rename). Isso **trava em CI e em agentes não interativos**. Gere localmente num TTY, ou escreva o rename como `--custom`.
- Nunca edite à mão um `.sql` já aplicado. O migrator compara por hash e ordem do journal, e a mudança não reaplica.
- Enums: adicionar valor gera `ALTER TYPE ... ADD VALUE`. Remover ou renomear valor não é automático e precisa de migration custom.
- Extensão e plugin: se o clone compartilhar o Postgres do ai-manager, use `schemaFilter` ou um `pgSchema('leona')` dedicado, mais `migrationsSchema` próprio. Assim um kit não tenta dropar tabelas do outro.
- **Drizzle v1** muda o formato (pastas por migration, sem `_journal.json`, `drizzle-kit up` para converter). Não misture `drizzle-kit@rc` com `drizzle-orm@0.45`: o kit valida a versão do orm (`assertOrmCoreVersion`).

---

### 3. bullmq 6.3.8

**context7:** `/taskforcesh/bullmq/v6.3.11`, específico da linha 6.3 (patch levemente acima de 6.3.8). Também `/websites/bullmq_io`.

**Por que o lock lista `pg@8.23.0` como peer: o BullMQ 6 tem backend PostgreSQL.** O v6 virou datastore-agnóstico. `ioredis` deixou de ser dependência direta e passou a ser **peer opcional**, e o `pg` é peer opcional do novo **PostgreSQL backend**. Esse backend implementa queues, workers, flows, job schedulers, rate limit, prioridade, delayed, deduplicação, métricas e eventos, usando tabelas em um schema, funções SQL transacionais e `LISTEN/NOTIFY` no lugar do `BZPOPMIN`.
```ts
import { Queue, Worker, createPostgresBackend, runMigrations } from 'bullmq'
const opts = { connection: 'postgres://…' }        // string | pg.PoolConfig (+schema) | pg.Pool
const q = new Queue('x', opts, createPostgresBackend)
const w = new Worker('x', async (job) => {}, opts, createPostgresBackend)
// deploy: await runMigrations(client)  (idempotente, sem downgrade)
```
- Cada backend Postgres usa um `pg.Pool` mais **1 conexão LISTEN dedicada** fora do pool. Dimensione `max_connections` para filas, workers e QueueEvents. Com uma fila por sessão (padrão do ai-manager), isso estoura rápido.
- **Recomendação: manter Redis** (é o padrão do ai-manager, e a fronteira de extensão pressupõe as mesmas filas e o mesmo Redis). Registro apenas que o pg vira peer porque o pnpm o resolve, já que existe no workspace. O backend Postgres fica como opção futura para deploy "só Postgres".

**Breaking changes 5→6 (doc de migração v6):**
- **API de repeatable removida:** `add(..., { repeat })`, `addBulk(... repeat)`, `getRepeatableJobs`, `removeRepeatable`, `removeRepeatableByKey` e a classe `Repeat`. Use **Job Schedulers**. Migre os dados ainda no v5 antes de subir para o v6.
- `ioredis` agora é peer opcional e precisa ser instalado explicitamente.
- O parâmetro de construtor `Connection` foi substituído por um `BackendFactory` (4º argumento). Foram removidos `Queue#client`, `Queue#redisVersion`, `Queue#databaseType`, `Worker#blockingClient` e `FlowProducer#client`. Agora use `await queue.getBackend().client`. `Worker#waitUntilReady()` resolve `void`.
- `Queue.resume()` passou a ser async e precisa de `await`.
- Backends custom: `reprocessJob→retryFinishedJob`, `retryJobs→retryFinishedJobs`, `cleanJobsInSet→cleanJobsByState`, `isJobInList/isJobInZSet→isJobInState`.

**Queue, Worker e conexão:**
```ts
const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null })
const queue = new Queue('flows', { connection, prefix: 'leona' })
const worker = new Worker('flows', async (job) => run(job.data), {
  connection, concurrency: 10,
  removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 7 * 86400 },
})
worker.on('error', (e) => log.error(e))        // sem listener: unhandled
```
- **`maxRetriesPerRequest: null` é obrigatório para Workers.** O Worker força esse valor quando recebe opções, mas emite warning se você passar uma instância com outro valor. O Worker sempre duplica a conexão para os comandos bloqueantes, mesmo quando recebe uma instância reutilizada.
- `removeOnComplete` e `removeOnFail` aceitam `true`, um número ou `KeepJobs { age (s), count, limit }`. A limpeza é lazy (ocorre quando outro job termina). Sem isso o Redis cresce sem limite.
- Delayed: `queue.add(name, data, { delay: ms })`. O atraso é mínimo, não exato. Para agendar em data absoluta, use `delay = when - Date.now()`.
- Retry: `{ attempts: 3, backoff: { type: 'exponential', delay: 1000 } }`. Para não tentar de novo, lance `UnrecoverableError`.

**Rate limit e "grupos":**
- Limiter global (vale para todos os workers da fila): `new Worker(q, fn, { limiter: { max: 10, duration: 1000 } })`.
- Limite dinâmico (ex.: HTTP 429 da Meta ou do WhatsApp): `await worker.rateLimit(ms); throw Worker.RateLimitError()`. Isso exige `limiter` configurado. Jobs em rate limit ignoram a contagem de `attempts`, então verifique `job.attemptsStarted` manualmente.
- `queue.setGlobalConcurrency(n)` limita a concorrência entre processos, como já faz o ai-manager.
- **Groups (rate e concorrência por chave) são exclusivos do BullMQ Pro** (`@taskforcesh/bullmq-pro`, `WorkerPro`, `group.limit`). No OSS, o equivalente é **uma fila por chave**, como o ai-manager faz por sessão (`session:<id>`), ou um limiter manual por chave no Redis.

**Job Schedulers** (substituem os repeatables):
```ts
await queue.upsertJobScheduler('followup-tenant-42',
  { pattern: '0 0 9 * * 1-5', tz: 'America/Sao_Paulo' },   // ou { every: 60_000 }
  { name: 'followup', data: { tenantId: 42 }, opts: { attempts: 3 } })
await queue.getJobSchedulers(); await queue.removeJobScheduler('followup-tenant-42')
```
`upsert` é idempotente por id: chamar no boot não duplica. O cron usa `cron-parser` 5 (padrão de 6 campos com segundos aceito).

**FlowProducer (pai e filhos):**
```ts
const flow = new FlowProducer({ connection })
await flow.add({ name: 'campaign', queueName: 'campaigns', data: { id },
  children: contacts.map((c) => ({ name: 'send', queueName: 'session:abc', data: c,
    opts: { failParentOnFailure: false } })) })
// no worker do pai: const vals = await job.getChildrenValues()
```
O pai só roda depois que todos os filhos completam. Com `failParentOnFailure: true`, a falha propaga para cima (de forma lazy). Também existem `ignoreDependencyOnFailure` e `removeDependencyOnFailure`.

**Deduplicação** (`opts.deduplication`):
- Simple: `{ id }`. Ignora novos jobs enquanto o job original não terminar.
- Throttle: `{ id, ttl: 5000 }`. Ignora durante o TTL.
- Debounce: `{ id, ttl, extend: true, replace: true }` + `delay`. Mantém só o último job (útil para "IA responde após o contato parar de digitar").
- Evento `deduplicated` no QueueEvents. `queue.removeDeduplicationKey(id)` remove a chave. Apagar o job manualmente desliga a deduplicação. Para idempotência simples também existe `jobId` custom: jobs com id repetido são ignorados.

**QueueEvents:** `new QueueEvents('q', { connection })` usa uma conexão própria (stream de eventos). Eventos: `completed`, `failed`, `progress`, `deduplicated` etc. É útil para alimentar SSE ou realtime no dashboard.

**Graceful shutdown:**
```ts
const stop = async () => { await worker.close(); await queue.close(); await connection.quit(); process.exit(0) }
process.on('SIGTERM', stop); process.on('SIGINT', stop)
```
`worker.close()` espera os jobs ativos terminarem. Jobs que passam do grace period do orquestrador viram *stalled* e são reprocessados, então os processadores precisam ser idempotentes.

**Armadilhas de versão (bullmq):**
- Exemplos antigos com `QueueScheduler`, `repeat:` ou `queue.client` **não funcionam no v6**. A própria doc v6 ainda mostra `QueueScheduler` num snippet de rate limit (resíduo; está removido desde o v2).
- Groups e batches são do Pro. Não planeje features com eles no OSS.
- Com `ioredis@6` (RESP3 por padrão), o BullMQ 6 funciona via adapter ioredis, que normaliza as respostas. Não passe `replyMapping: 'resp3'` na conexão do BullMQ: deixe o default `legacy`.
- Redis Cluster: os nomes de fila precisam de hash tag (`{session:abc}`). Em Redis gerenciado, exija `maxmemory-policy noeviction`.
- `prefix` isola os ambientes. O clone deve usar um prefixo próprio, e para enfileirar envio na sessão do ai-manager deve usar o prefixo **dele** (`wsm`).

---

### 4. ioredis 6.0.0

**context7:** `/redis/ioredis/v6.0.0`, específico da versão.

**Breaking changes 5→6 (CHANGELOG v6.0.0):**
- **Node ≥ 20** obrigatório. Na v5 era Node ≥ 12. Redis suportado: 6.2+.
- **RESP3 é o protocolo padrão** (`protocol: 3`, envia `HELLO 3`). Faz downgrade automático para RESP2 se o servidor for menor que o Redis 6. Para o comportamento da v5, use `protocol: 2`.
- `replyMapping`: `'legacy'` (default) mantém os formatos da v5 (maps como array plano, doubles como string). `'resp3'` devolve maps como objeto e doubles como number, só vale com `protocol: 3` e lança erro com `protocol: 2`. Mantenha `legacy` para compatibilidade com BullMQ e com o código do ai-manager.
- Com `enableOfflineQueue: false`, comandos enviados antes do `ready` são rejeitados.
- Novos canais de `node:diagnostics_channel` (`tracing:ioredis:command:start|asyncEnd|error`) para tracing.
- Wiki: "Upgrading from v5 to v6".

**Conexão:**
```ts
import { Redis } from 'ioredis'                       // named export (como no ai-manager)
const redis = new Redis(process.env.REDIS_URL!, {     // rediss:// liga TLS sozinho
  maxRetriesPerRequest: 1,      // API: falhar rápido. Para Worker/QueueEvents do BullMQ: null
  lazyConnect: false, enableOfflineQueue: true,
  retryStrategy: (n) => Math.min(n * 200, 5000),
})
redis.on('error', (e) => log.warn(e))
```

**Pub/Sub e `duplicate()`:**
```ts
const sub = redis.duplicate()          // new Redis({ ...redis.options, ...override })
await sub.subscribe('leona:events')    // sub entra em subscriber mode
sub.on('message', (ch, msg) => fanoutToSSE(JSON.parse(msg)))
await redis.publish('leona:events', JSON.stringify(evt))   // publish pela conexão normal
```
Uma conexão em subscriber mode só aceita comandos de subscribe, por isso sempre use uma conexão separada. `duplicate()` herda as opções, então ajuste `maxRetriesPerRequest` com o override quando necessário.

**Uso com BullMQ:** passe opções (`{ host, port, ... }`) e deixe o BullMQ criar e duplicar as conexões, como no ai-manager. A alternativa é uma instância própria com `maxRetriesPerRequest: null`. Não compartilhe a mesma instância entre o BullMQ e o subscriber de pub/sub.

**Armadilhas de versão (ioredis):**
- Node 20+: confira o `engines` do monorepo e as imagens Docker.
- Respostas RESP3 diferem em `HGETALL` e `CONFIG GET` quando `replyMapping: 'resp3'`. O código copiado de exemplos da v5 continua valendo enquanto o mapping for `legacy`.
- `import Redis from 'ioredis'` (default) ainda funciona, mas o ai-manager usa `import { Redis } from 'ioredis'`. Padronize no named import.
- `maxRetriesPerRequest` tem default 20. Em conexão do BullMQ Worker, o valor precisa ser `null`. Na API HTTP, use um valor baixo para não pendurar requests.

---

### Recomendações resumidas para o clone
1. Copie o padrão de `packages/db` do ai-manager: drizzle 0.45 com query builder, migrator programático com advisory lock e `migrationsSchema`/`pgSchema` próprios para conviver no mesmo Postgres.
2. Não adote RQB v2 nem `defineRelations` antes do Drizzle v1 estável. Se adotar `relations()` v1, isole numa camada.
3. BullMQ 6 sobre Redis. Use Job Schedulers para cadências e follow-ups, FlowProducer para campanhas, debounce dedup para respostas de IA e uma fila por sessão para serializar envios. O envio WhatsApp deve ir para a fila `session:<id>` do ai-manager quando rodar como extensão.
4. ioredis 6 com `protocol` default e `replyMapping: 'legacy'`. Use conexões separadas para BullMQ, pub/sub (SSE) e comandos da API.

---

## Bloco C — WhatsApp: @whiskeysockets/baileys 7.0.0-rc14 + baileys-antiban 4.10.0 (+ sharp 0.35.4)

**Versões (iguais ao `pnpm-lock.yaml` do ai-manager):**

| Pacote | Versão | Pin | Observação |
|---|---|---|---|
| `@whiskeysockets/baileys` | `7.0.0-rc14` | **exato** (sem `^`) | `npm view` em 15/10/2026: `latest = 7.0.0-rc14`, `legacy = 6.7.24` |
| `baileys-antiban` | `4.10.0` | o ai-manager usa `^4.10.0`; **no clone, fixar `4.10.0`** | peer opcional `baileys >=6.0.0` |
| `sharp` | `0.35.4` | exato | peer de mídia do Baileys (thumbnails), usado também em figurinhas |

**Fontes verificadas:**
- context7: `/whiskeysockets/baileys` (README + `_autodocs`, que seguem o master) e `/websites/baileys_wiki` (guia "Migrate to v7.0.0").
- O context7 segue o master, então **toda assinatura abaixo foi conferida no tarball do rc14** (`npm pack @whiskeysockets/baileys@7.0.0-rc14`, em `lib/**/*.d.ts` e `lib/Defaults/index.js`).
- baileys-antiban não está no context7. Foi lido no tarball 4.10.0: `README.md` e `dist/antiban.d.ts`, `dist/wrapper.d.ts`.
- Referência de uso: código do ai-manager, citado como `arquivo:linha`.

---

### C.1 Pacote e runtime (rc14)

- **Só ESM:** `"type": "module"`, sem campo `exports` e `main: lib/index.js`. Faça `import makeWASocket, { ... } from '@whiskeysockets/baileys'`; um `require()` em CJS falha. O ai-manager carrega sob demanda com `await import(...)` (`packages/core/src/transport/baileys.ts:221-224` e `:192-198`).
- **Node ≥ 20:** `engines.node >=20.0.0`, e o `engine-requirements.js` chama `process.exit(1)` em Node < 20.
- **Dependências diretas:** `pino ^9.6`, `libsignal ^6.0.0`, `music-metadata` (calcula a duração dos áudios), `whatsapp-rust-bridge 0.5.4`, `p-queue`, `lru-cache`, `@cacheable/node-cache`.
- **Peers opcionais:** `sharp` (ou `jimp`) para thumbnails, `audio-decode` para a waveform do PTT e `link-preview-js` para o preview de links.
- `printQRInTerminal` está **@deprecated ("This feature has been removed")**. Para mostrar o QR, use o evento `connection.update` e renderize você mesmo; o ai-manager usa `qrcode.toDataURL`, em `apps/worker/src/sessions/qr.ts:4-6`.

### C.2 `makeWASocket`: configuração v7

**Defaults reais do rc14** (`lib/Defaults/index.js`, `DEFAULT_CONNECTION_CONFIG`):
- `browser: Browsers.macOS('Chrome')`
- `markOnlineOnConnect: true`
- `syncFullHistory: true`
- `shouldSyncHistoryMessage: ({syncType}) => syncType !== FULL`: na prática, **o histórico FULL é descartado** mesmo com `syncFullHistory: true`.
- `getMessage: async () => undefined`
- `cachedGroupMetadata: async () => undefined`
- `enableAutoSessionRecreation: true`
- `enableRecentMessageCache: true`
- `countryCode: 'US'`
- `logger: pino child {class:'baileys'}`

```ts
import makeWASocket, { Browsers, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
const sock = makeWASocket({
  auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
  browser: Browsers.macOS('Desktop'), // ou tupla [SO, navegador, versão] estável por sessão
  logger: logger.child({ mod: 'baileys' }), // pino (ILogger)
  markOnlineOnConnect: false,           // README: senão o celular para de notificar
  getMessage: async (key) => store.getProto(key), // reenvio/retry e votos de enquete
  cachedGroupMetadata: async (jid) => groupCache.get(jid),
  shouldSyncHistoryMessage: () => true, syncFullHistory: true, // só se quiser importar o histórico
})
```

**Notas da config:**
- **`Browsers`** (rc14 `BrowsersMap`): `ubuntu | macOS | baileys | windows | android | appropriate`, todos recebendo `(browser: string)`. Segundo o README, `macOS('Desktop')` emula o app desktop e recebe mais histórico. O ai-manager gera uma tupla estável por sessão a partir do hash do `sessionId` (`packages/core/src/transport/fingerprint.ts:20-23`) e a injeta em `packages/core/src/proxy/connect.ts:76`.
- **`makeCacheableSignalKeyStore(store, logger?, cache?)`** (rc14 `Utils/auth-utils.d.ts:9`) coloca um cache em memória na frente do key store do banco. **O ai-manager não usa** (o grep não encontra): cada `keys.get` vai ao Postgres. No clone, envolva o auth state do banco com ele.
- **`getMessage`**: sem ele, o retry de mensagens que falharam na decifragem do outro lado não reenvia, e os votos de enquete não são decifrados. Exige um store de mensagens no banco, que o CRM já terá.
- **`cachedGroupMetadata`**: recomendado pelo README para quem envia em grupos, para evitar `groupMetadata` a cada envio. Invalide o cache em `groups.update` e `group-participants.update`.
- **Proxy:** `agent` e `fetchAgent` (`https-proxy-agent` / `socks-proxy-agent`), como em `baileys.ts:377-381`.

**Auth state: arquivo × banco**
- `useMultiFileAuthState(dir)` é só exemplo. O próprio README diz que ele "serve de guia" e recomenda SQL/NoSQL em produção.
- O ai-manager usa `usePostgresAuthState(db, sessionId)` (`packages/core/src/auth-state/index.ts:36-157`):
  - grava uma linha por `(sessionId, keyType, keyId)`;
  - serializa com `JSON.stringify(v, BufferJSON.replacer)`;
  - cifra em AES-256-GCM com AAD `sessionId/keyType/keyId` (`:32`);
  - cria os creds com `initAuthCreds()` (`:93`);
  - faz `keys.set` em transação, com upsert e com delete para valores `null` (`:120-147`).
- **Armadilha:** a categoria `app-state-sync-key` precisa ser reidratada com `proto.Message.AppStateSyncKeyData.fromObject(v)` no `get` (`:113-115`).
- **Tipos novos no `SignalDataTypeMap` v7:** `'lid-mapping'`, `'device-list'`, `tctoken`, `'identity-key'` (rc14 `Types/Auth.d.ts:68-85`). O store precisa aceitar qualquer `keyType` como string, sem enum fixo no banco.

### C.3 Conexão: `connection.update`, QR, pairing code, reconexão

```ts
sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
  if (qr && pairingPhone && !sock.authState.creds.registered)
    emit('pairing', await sock.requestPairingCode(pairingPhone.replace(/\D/g, ''))) // só dígitos com DDI
  else if (qr) emit('qr', qr)
  if (connection === 'close') {
    const code = (lastDisconnect?.error as Boom)?.output?.statusCode
    if (code === DisconnectReason.loggedOut) await auth.clear() // exige novo QR/pairing
    else scheduleReconnect(code) // criar um NOVO socket; o antigo não é reaproveitado
  }
})
sock.ev.on('creds.update', saveCreds)
```

- **`requestPairingCode(phoneNumber, customPairingCode?)`** (rc14 `Socket/index.d.ts:245`). O ai-manager só pede o código depois do primeiro `qr` (o socket precisa estar pronto) e uma vez por socket, controlado por `pairingRequested` (`baileys.ts:399-407`).
- **`DisconnectReason`** (rc14): 428 connectionClosed, 408 connectionLost/timedOut, 440 connectionReplaced, 401 loggedOut, 500 badSession, 515 restartRequired, 411 multideviceMismatch, 403 forbidden, 503 unavailableService.
  - **515 (restartRequired) é normal logo após escanear o QR.** Reconecte na hora.
- **Mapeamento do ai-manager** (`baileys.ts:21-38`): 401 → `loggedOut`, 403 → `forbidden`, resto → `transient`.
  - O backoff é exponencial `1000*2^(n-1)` (`apps/worker/src/sessions/manager.ts:127`).
  - Em `loggedOut`, chama `auth.clear()` (`manager.ts:569-573`). Em `forbidden`, registra um evento de saúde (`:578-579`).
  - Pendente na pesquisa `docs/pesquisa-regras-antiban.md`: esperar 60 s no 503 e 5 min no 429.
- **Guard de socket obsoleto:** todo handler confere `this.sock === sock` para ignorar eventos de sockets substituídos (`baileys.ts:389-395`). Copie esse padrão.
- **Ack de `<status>`** (`baileys.ts:461-466`): o servidor envia stanzas `CB:status` e o rc14 não as confirma. Sem ack, a conexão cai com stream:error 500 a cada ~50 min. O ai-manager responde com `sock.sendNode(ackFor(node))`. **Copiar esse workaround.**

### C.4 Mudanças v7 × 6.x (precisas para o rc14)

| Tema | 6.x | 7.0.0-rc14 |
|---|---|---|
| Módulo | CJS | **Só ESM** |
| Node | ≥ 16/18 | **≥ 20** (aborta o processo) |
| Identidade | só PN (`@s.whatsapp.net`) | **PN ou LID (`@lid`)**. `WAMessageAddressingMode { PN='pn', LID='lid' }`; `GroupMetadata.addressingMode` |
| Alternativa na key | `key.senderPn`, `participantPn` (variam por versão) | **`WAMessageKey.remoteJidAlt`, `participantAlt`**, além de `remoteJidUsername`, `participantUsername` e `addressingMode` (rc14 `Types/Message.d.ts:19-24`) |
| Helpers de JID | `isJidUser` | **`isJidUser` removido → `isPnUser`**; também `isLidUser`, `isHostedPnUser`, `isHostedLidUser`, `jidNormalizedUser` (`WABinary/jid-utils.d.ts`) |
| Mapa LID↔PN | não havia | **`sock.signalRepository.lidMapping`** (`LIDMappingStore`): `storeLIDPNMappings(pairs)`, `getLIDForPN`, `getLIDsForPNs`, `getPNForLID`, `getPNsForLIDs`, todos retornando `Promise<... \| null>`. É persistido no key store como `'lid-mapping'` |
| Evento | — | **`'lid-mapping.update': { lid, pn }`**; `messaging-history.set` traz `lidPnMappings?: LIDMapping[]` |
| `Contact` | `id` = PN | `id` (LID ou PN, "preferred") + `lid?` + `phoneNumber?` + `username?` |
| Grupo | participants `{id, admin}` | `participants: GroupParticipant[]` (= `Contact & {admin, isAdmin, isSuperAdmin}`); `owner`/`ownerPn`; `group-participants.update` tem `participants: GroupParticipant[]` (**objetos, não strings**) e `authorPn?` |
| `onWhatsApp` | retornava o LID | não retorna mais o LID; use `lidMapping.getLIDForPN(s)` |
| ACKs | enviava ACK na entrega | **não envia mais ACK de entrega** (guia v7: "risco de ban") |
| QR no terminal | `printQRInTerminal` | removido (só @deprecated) |

**Exemplo de LID no CRM:**
```ts
const jid = msg.key.remoteJid!                        // pode ser 1234@lid
const pn  = msg.key.remoteJidAlt                      // 5511...@s.whatsapp.net quando o WA manda
  ?? (isLidUser(jid) ? await sock.signalRepository.lidMapping.getPNForLID(jid) : jid)
sock.ev.on('lid-mapping.update', ({ lid, pn }) => contacts.linkLidPn(lid, pn))
```
O ai-manager guarda `remoteJidAlt` como `fromAlt` (`baileys.ts:263`) e indexa as âncoras por PN e por LID (`:435-439`). A conferência de admin compara `[p.id, p.lid, p.phoneNumber]` (`:282-290`).

### C.5 Eventos (payloads do rc14, `Types/Events.d.ts`)

| Evento | Payload | Uso no CRM |
|---|---|---|
| `messages.upsert` | `{ messages: WAMessage[]; type: 'notify' \| 'append'; requestId? }` | `notify` = recebida ao vivo, entra na inbox e dispara automações. `append` = sincronizada (histórico ou enviada de outro aparelho): só gravar, **sem disparar bots**. `requestId` presente = veio do celular por indisponibilidade. Sempre iterar sobre `messages` |
| `messages.update` | `WAMessageUpdate[]` = `{ key, update: Partial<WAMessage> }` | `update.status`: 3 = DELIVERY_ACK, 4 = READ, 5 = PLAYED (`WAMessageStatus`); edições, `pollUpdates` |
| `message-receipt.update` | `{ key, receipt: IUserReceipt }[]` | recibos por participante (grupos) |
| `messages.reaction` | `{ key, reaction }[]` | `reaction.text` vazio = reação removida |
| `messages.delete` | `{ keys } \| { jid, all: true }` | apagar mensagem/conversa |
| `messaging-history.set` | `{ chats, contacts, messages, lidPnMappings?, isLatest?, progress?, syncType?, pastParticipants?, chunkOrder?, peerDataRequestSessionId? }` | importação inicial; chega em lotes, em ordem cronológica reversa |
| `messaging-history.status` | `{ syncType, status: 'complete' \| 'paused', explicit }` | `explicit:false` = fim inferido por timeout de 120 s |
| `chats.upsert` / `chats.update` / `chats.delete` | `Chat[]` / `ChatUpdate[]` / `string[]` | unread, arquivado, `ephemeralExpiration`; `Chat` tem `pnJid`/`lidJid` |
| `contacts.upsert` / `contacts.update` | `Contact[]` / `Partial<Contact>[]` | nome salvo (`name`), `notify` (pushName) |
| `groups.upsert` / `groups.update` | `GroupMetadata[]` / `Partial<GroupMetadata>[]` | invalidar o cache de grupos |
| `group-participants.update` | `{ id, author, authorPn?, participants: GroupParticipant[], action: 'add'\|'remove'\|'promote'\|'demote'\|'modify' }` | — |
| `presence.update` | `{ id, presences: { [participant]: PresenceData } }` | "digitando…" na UI (exige `presenceSubscribe`) |
| `message-capping.update` | `NewChatMessageCapInfo` | limites de envio e bans: **ligar ao score de saúde** |
| `call`, `labels.edit`, `labels.association`, `blocklist.*` | — | opcionais |

**Padrão de recibos do ai-manager** (`baileys.ts:475-490`): só olha `key.fromMe`; o status 3 vira `delivered` e os status 4 e 5 viram `read`. O recibo alimenta o antiban (`apps/worker/src/queue/attach.ts:32`, `onDelivered`).

**Primeira conexão** (README "Summary of Events"): primeiro chega `connection.update` pedindo restart (515); depois chegam os lotes de `messaging-history.set`.

### C.6 Envio

A assinatura é `sock.sendMessage(jid, content, options?)`, com `options.quoted` e `options.ephemeralExpiration`. O retorno é um `WAMessage`, e `key.id` é o id usado nos recibos (`baileys.ts:496-506`).

```ts
await sock.sendMessage(jid, { text: 'Olá' }, { quoted: msg })                  // resposta citada
await sock.sendMessage(jid, { image: { url }, caption: 'Promo', mimetype: 'image/jpeg' })
await sock.sendMessage(jid, { video: buf, caption: 'Demo', ptv: false })       // ptv:true = nota de vídeo
await sock.sendMessage(jid, { document: buf, mimetype: 'application/pdf', fileName: 'proposta.pdf' })
await sock.sendMessage(jid, { audio: oggOpusBuf, ptt: true, mimetype: 'audio/ogg; codecs=opus' })
await sock.sendMessage(jid, { sticker: webpBuf })                              // webp 512x512
await sock.sendMessage(jid, { react: { text: '👍', key: msg.key } })           // '' remove a reação
```

**Áudio PTT (nota de voz):**
- `AnyMediaMessageContent.audio` aceita `{ audio, ptt?, seconds? }` mais `mimetype?`. O mimetype default do rc14 para áudio é `'audio/ogg; codecs=opus'` (`Utils/messages.js:17`).
- **Converter para OGG/Opus mono:** `ffmpeg -i in.mp3 -c:a libopus -ac 1 -avoid_negative_ts make_zero out.ogg` (README). Os bytes de TTS (mp3/wav) devem passar por essa conversão antes do envio. O ffmpeg é binário do sistema (no Docker, `apt-get install ffmpeg`).
- **`seconds`:** se ausente, o rc14 calcula com `music-metadata` (`Utils/messages.js:134,167-168`).
- **`waveform`:** se `ptt:true` e não houver waveform, o rc14 gera com `audio-decode`, que é **peer opcional: instale, senão só aparece um debug no log e a nota fica sem forma de onda** (`:136,171-173`; `messages-media.js:199-232`).

**Mídia recebida:**
- Use `downloadMediaMessage(msg, 'buffer' | 'stream', {}, { logger, reuploadRequest: sock.updateMediaMessage })` (assinatura rc14 em `Utils/messages.d.ts:87`).
- **Passe `reuploadRequest`**: mídia antiga expira no servidor (404/410). O ai-manager não passa, e a figurinha expirada simplesmente não é salva (`baileys.ts:191-198`).
- `getContentType(msg.message)` e `normalizeMessageContent()` identificam o tipo (lidam com ephemeral/viewOnce).

**Leitura e presença:**
```ts
await sock.readMessages([msg.key])                  // marca lidas por key; não existe "ler a conversa toda"
await sock.presenceSubscribe(jid)                   // passa a receber presence.update desse jid
await sock.sendPresenceUpdate('composing', jid)     // WAPresence: available|unavailable|composing|recording|paused
await sock.sendPresenceUpdate('recording', jid)     // antes de mandar PTT
await sock.sendPresenceUpdate('paused', jid)        // a presença expira em ~10 s
```
O ai-manager simula digitação com `sendTyping`, que chama `composing` ou `paused` (`baileys.ts:540-542`).

**Conversas temporárias:** envie com `{ ephemeralExpiration }` igual ao da conversa. Sem isso, o WhatsApp avisa "Esta mensagem não desaparecerá". O ai-manager aprende o valor por `contextInfo.expiration`, `chats.update` e `messaging-history.set` (`baileys.ts:440-442,469-471,500-503`).

### C.7 Grupos (assinaturas do rc14, `Socket/index.d.ts:120-150`)

```ts
const meta = await sock.groupMetadata(gid)                         // GroupMetadata (participants: GroupParticipant[])
const g    = await sock.groupCreate('Turma VIP', [pnJid1, pnJid2])  // → GroupMetadata
const res  = await sock.groupParticipantsUpdate(gid, [jid], 'add') // [{ status, jid, content }]; status '200' = ok (string)
const code = await sock.groupInviteCode(gid)                        // string | undefined → https://chat.whatsapp.com/<code>
const all  = await sock.groupFetchAllParticipating()                // { [gid]: GroupMetadata }
```

- **`groupFetchAllParticipating` dá `rate-overlimit` se chamado com frequência.** O ai-manager mantém a lista em cache e só invalida em `groups.upsert`, `groups.update` e `group-participants.update` (`baileys.ts:154-160,473,567,599`).
- **Adição em grupo:** o `status` numérico de cada item do retorno (ex.: `'200'` = ok; códigos 4xx = recusa por privacidade, saída recente ou membro existente, não verificados um a um) vira um status de domínio via `mapParticipantStatus` (`baileys.ts:630-650`).
- **Limites anti-ban de grupo** (baileys-antiban `groupOperationGuard`, citado em `docs/pesquisa-regras-antiban.md`): 3 adições a cada 10 min, 2 criações a cada 10 min, 10 consultas de convite a cada 10 min.

### C.8 baileys-antiban 4.10.0

- **Pacote:** `"type":"module"` com build CJS em `dist/cjs`. A classe central é `AntiBan` (`dist/antiban.d.ts`).
- **Construtor:** `new AntiBan(input?: AntiBanInput, warmUpState?)`, em que `input` é um nome de preset (`'conservative'|'moderate'|'aggressive'|'high-volume'`) ou uma config plana `{ preset, maxPerMinute, maxPerHour, maxPerDay, minDelayMs, maxDelayMs, newChatDelayMs, maxIdenticalMessages, warmupDays, day1Limit, growthFactor, inactivityThresholdHours, autoPauseAt, persist, logging }`.
- **Métodos:**
  - envio: `beforeSend(recipient, content): Promise<{allowed, delayMs, reason?}>`, `afterSend(recipient, content, msgId?)`, `afterSendFailed(error?)`;
  - conexão e entrega: `onDisconnect(code)`, `onReconnect()`, `onDeliveryReceipt(msgId)`;
  - estado: `getStats()`, `exportWarmUpState()`, `exportState()`, `importState()`;
  - controle: `pause()`, `resume()`, `reset()`, `destroy()`.
- **Outras APIs:**
  - `wrapSocket(sock, config?, warmUpState?, wrapOptions?)` intercepta o `sendMessage`;
  - `getStealthSocketConfig()` e `rampPresenceAfterConnect()` conectam sem anunciar `available` e sobem a presença depois de 45 a 120 s;
  - `LidResolver` e `jidCanonicalizer` (via `wrapSocket`) cuidam da canonização LID/PN;
  - também há `PresenceChoreographer` (modelo de digitação por WPM), `GroupOperationGuard`, `TimelockGuard` (erros 463 de reachout), `ProxyRotator`, `HumanEntropyService` e `DeliveryTracker`.

**Uso manual (é o modelo que o ai-manager adota):**
```ts
const d = await ab.beforeSend(jid, fingerprint)          // fingerprint = texto ou assinatura da mídia
if (!d.allowed) throw new AntibanBlockedError(d.reason)
await sleep(d.delayMs)                                    // inclui jitter gaussiano e ~30 ms/char de "digitação"
try { const r = await sock.sendMessage(jid, content); ab.afterSend(jid, fingerprint, r.key.id) }
catch (e) { ab.afterSendFailed(String(e)); throw e }
// e no messages.update com status >= 3: ab.onDeliveryReceipt(key.id)
```

**Como o ai-manager integra:**
- **Não usa `wrapSocket`.** Usa um `AntibanAdapter` próprio (`packages/core/src/antiban/adapter.ts:33-44`) com uma instância de `AntiBan` por sessão (`:140-161`). Os modos são `real` (default) e `passthrough` (só testes, com warn), escolhidos por `ANTIBAN_MODE`/`ANTIBAN_PRESET` (default `conservative`; um valor inválido lança erro, `:67-85`).
- **Ponto único de envio:** `createDeliver` em `packages/core/src/send/deliver.ts:83-108` faz beforeSend → sleep → `transport.sendMessage` → afterSend/afterSendFailed. Um 403 no envio grava o sinal `forbidden_403` e reduz os limites pela metade (`:110-122`).
- **Fingerprint de conteúdo para detectar repetição:** texto/legenda, ou `[kind:url]caption` para mídia (`adapter.ts:88-94`).
- **O warm-up do AntiBan fica neutralizado:**
  - ele vive só em memória e voltava ao dia 1 a cada restart;
  - por isso a instância nasce `graduated` (`graduatedWarmUp`) e recebe `inactivityThresholdHours: 1e9` (`adapter.ts:128-152`);
  - o aquecimento que vale é o do ai-manager, persistido em `sessions.warmup_started_at`.
- **Recibos de entrega:** `onDeliveryReceipt` é obrigatório. Sem recibos, o AntiBan vê 0% de entrega e, a partir de 10 envios por hora, corta os limites a 25% (`adapter.ts:38-42`; ligado em `apps/worker/src/queue/attach.ts:32`).
- `logging: false` é sempre forçado (`adapter.ts:149`).
- O envio fica numa fila BullMQ com concorrência 1 por sessão. Uma marca de "em voo" no Redis evita reenvio duplicado após um crash (`apps/worker/src/boot/send-guard.ts:1-10`).
- **Divergência conhecida:** o antiban trata 428 como fatal; o Baileys define 428 = connectionClosed. A pesquisa do ai-manager diz **"não copiar"** (`docs/pesquisa-regras-antiban.md`, seção 1).

### C.9 Padrões do ai-manager para espelhar no clone

1. **Interface `WaTransport`:** a factory é injetável (`makeSocket`, `downloadMedia`), e o `FakeTransport` permite testar sem rede (`apps/worker/src/sessions/transport-factory.ts:31-42`, `WA_TRANSPORT=fake`).
2. **Um socket por sessão,** com guard de socket obsoleto e reconexão por backoff no `SessionManager`.
3. **Auth state cifrado no Postgres;** o clone deve acrescentar `makeCacheableSignalKeyStore`.
4. **Todo envio passa por `deliver`** (antiban, depois fila). Nunca chamar `sock.sendMessage` direto da API.
5. **Fingerprint (browser) estável por sessão** e proxy por sessão.

### C.10 Armadilhas de versão e operação

- **RC instável:** o rc14 é a tag `latest`, mas ainda é release candidate, e os nomes mudaram entre RCs (`senderPn`/`participantPn` → `remoteJidAlt`/`participantAlt`; `lidMapping` ganhou `getPNsForLIDs`).
  - **Fixar `7.0.0-rc14` sem `^`/`~`** e testar a troca de RC em staging.
  - Não confiar no context7/master sem conferir os `.d.ts` instalados.
- **Identidade do contato no CRM (dedupe):**
  - o mesmo contato pode chegar como `@lid` ou `@s.whatsapp.net`;
  - o contato deve ter **duas colunas** (`wa_lid` e `phone_e164`), com chave única em cada uma (parcial, quando não nula);
  - o merge deve usar `remoteJidAlt`/`participantAlt`, `lid-mapping.update`, `messaging-history.set.lidPnMappings`, `Contact.lid`/`phoneNumber` e `lidMapping.getPNForLID`;
  - **nunca usar o JID cru como chave do contato**;
  - remova o sufixo de dispositivo (`:12@`) com `jidNormalizedUser` (equivale ao `normalizeJid`, `baileys.ts:270-273`);
  - `phoneFromUserJid` devolve `undefined` para LID (`:275-279`): o telefone pode ser desconhecido.
- **Grupos LID:** `groupParticipantsUpdate`/`groupCreate` recebem `string[]`, mas `group-participants.update` entrega objetos `GroupParticipant`. Código 6.x que faz `participants.map(p => p.split('@'))` quebra.
- **`isJidUser` não existe mais** (use `isPnUser`). Libs de terceiros antigas quebram no import.
- **Sem ACK de entrega no v7:** não "consertar" enviando ACKs manualmente (risco de ban). A exceção é o ack de `<status>` (`baileys.ts:461-466`), que é ack de stanza, não de mensagem.
- **`markOnlineOnConnect` default `true`:**
  - o celular do cliente deixa de receber notificações enquanto o bot está online;
  - para um CRM em que a operadora também usa o celular, prefira `false`;
  - o ai-manager não sobrescreve e fica no default.
- **Histórico:** o default descarta o sync FULL (via `shouldSyncHistoryMessage`). Para importar conversas antigas no CRM é preciso **sobrescrever as duas opções**, gravar em lotes, tratar tudo como `append` e não disparar automações.
- **Precisa de `getMessage`:** sem ele, retries "Waiting for this message" ficam sem resposta e as enquetes não são decifradas.
- **Erros Bad MAC / No Session** (sessão Signal criada sob PN e mensagem chegando sob LID):
  - a correção de raiz está no Baileys (PR #2372, citado pelo antiban);
  - mitigação: persistir `lid-mapping` (já vai no key store) e não apagar keys `session` à toa.
- **`pino`:** o Baileys depende de `pino ^9.6`. O `logger` passado precisa ser compatível com `ILogger` (pino 9 serve). Use `child` com `level: 'warn'`, porque o nível debug do Baileys é muito verboso.
- **PTT:** sem ffmpeg/opus o áudio chega como "arquivo" ou não toca no iOS. Sem `audio-decode`, a nota de voz fica sem waveform.
- **`sharp` 0.35.x** precisa de binário nativo por plataforma (Docker alpine vs glibc). Instale na mesma imagem do worker.
- **baileys-antiban:**
  - o warm-up e o estado só ficam em memória sem `persist` ou `StateAdapter`;
  - os presets mudam entre minors, então fixe `4.10.0` exato;
  - não use `wrapSocket` e o adapter próprio ao mesmo tempo (o delay seria aplicado duas vezes).
- **ESM + vitest/tsx:** os imports dinâmicos do ai-manager (`await import('@whiskeysockets/baileys')`) evitam carregar o libsignal e o WASM (`whatsapp-rust-bridge`) nos testes unitários. Mantenha esse padrão.

---

## Bloco D — Frontend (dashboard do leonas-crm)

> Pesquisa feita em 2026-10-15. Versões "latest" conferidas em `https://registry.npmjs.org/<pkg>/latest`;
> notas de API conferidas no context7 (IDs indicados em cada seção). Snippets são ilustrativos (≤10 linhas),
> não código de app.

### 0. Ponto de partida: o dashboard do ai-manager

`ai-manager/apps/dashboard` (pacote `@wsm/dashboard`) hoje usa:

- **react / react-dom / react-is 19.3.0**, **recharts 3.10.1**, **vite 8.3.0**, **@vitejs/plugin-react 6.1.1**, vitest 5.0.1, playwright 1.63.
- **Sem framework de CSS**: `src/styles.css` escrito à mão com tokens CSS (`--bg`, `--accent`, `--state-*`…) e tema claro/escuro.
- **Roteador por hash feito à mão** (`src/lib/router.ts`, `parseHash()` → união `Route`), sem fallback de servidor.
- **Data fetching via polling** (`src/lib/hooks.ts`, `usePoll(fn, intervalMs)` com `POLL = {fast:1000, list:3000, page:5000}`).
- `vite.config.ts`: proxy de `/api`, `/metrics` e `/health` para `VITE_API_URL` (default `http://localhost:3000`) e `resolve.conditions: ['development']` para consumir o código-fonte de `@wsm/*`.

O clone precisa de inbox realtime, kanban, builder de fluxos e filtros tipados na URL. Polling e roteador por hash
não escalam para isso, então **aqui propomos trocá-los** (ver §2 e §6) e **manter** React 19.3, Vite 8 e Recharts 3.

### Tabela de versões recomendadas

| Pacote | Versão a fixar | Observação |
|---|---|---|
| react, react-dom, react-is | `19.3.0` (latest 19.3.1) | igual ao ai-manager; subir junto para 19.3.1 é seguro (patch) |
| @types/react, @types/react-dom | `^19.3.0` | |
| vite | `8.3.0` (latest 8.3.4) | baseado em Rolldown |
| @vitejs/plugin-react | `6.1.1` (latest 6.1.2) | Oxc, sem Babel por padrão |
| typescript | `6.0.3` | |
| @tanstack/react-router | `1.170.44` | **recomendado** |
| @tanstack/router-plugin | `1.168.46` | plugin Vite (rotas por arquivo + code-splitting) |
| @tanstack/react-query | `5.104.3` | **recomendado** |
| @tanstack/react-query-devtools / react-router-devtools | `5.104.3` / `1.167.2` | só dev |
| zod | `4.6.5` (lock; latest 4.6.7) | `validateSearch` aceita Zod 4 direto (Standard Schema), sem adapter |
| tailwindcss, @tailwindcss/vite | `4.3.3` | peer `vite ^5.2 \|\| ^6 \|\| ^7 \|\| ^8` ✔ |
| shadcn (CLI) | `4.21.5` | não é dependência de runtime; gera código no repo |
| @base-ui/react | `1.9.0` | primitivas padrão do shadcn desde jul/2026 |
| tw-animate-css, class-variance-authority, clsx, tailwind-merge, lucide-react | `1.4.0`, `0.7.1`, `2.1.1`, `3.7.0`, `1.57.0` | instaladas pelo `shadcn init` |
| @xyflow/react | `12.12.0` | peer react >=17 ✔ |
| @dnd-kit/react, @dnd-kit/helpers, @dnd-kit/dom | `0.5.1` (fixar exato, sem `^`) | peer react ^18 \|\| ^19 ✔ |
| papaparse, @types/papaparse | `5.7.0`, `5.5.2` | |
| recharts | `3.10.1` | igual ao ai-manager |
| hono (servidor do SSE) | `4.13.13` | referência para §6 |

---

### 1. React 19.3 + Vite 8

**context7:** `/react/react/v19.2.8` (mais próximo de 19.3 indexado), `/vitejs/vite/v8.0.10`.

#### React 19: APIs que vamos usar

- **`useActionState(action, initialState)`** → `[state, dispatch, isPending]`. A action recebe `(prevState, payload)`.
  Use em formulários (`<form action={dispatch}>`), por exemplo no login, na criação de contato e no "salvar fluxo".
  ```tsx
  const [state, dispatch, isPending] = useActionState(async (prev, fd: FormData) => {
    const r = await api.saveContact(Object.fromEntries(fd)); return r.ok ? null : r.error
  }, null)
  return <form action={dispatch}>…<button disabled={isPending}>Salvar</button></form>
  ```
- **`useOptimistic(passthrough, reducer)`** mostra a mensagem enviada como "pendente" no chat antes do ACK do Baileys.
  Só funciona **dentro de uma transition/action**. Fora de `startTransition` o valor otimista é descartado.
- **`use(promise | context)`** suspende até a promise resolver. A promise **não pode ser criada no render**, porque seria recriada a cada render e entraria em loop. Com TanStack Query use `useSuspenseQuery` e não `use()`.
- **`ref` como prop**: componentes de função recebem `ref` em `props`. `forwardRef` deixa de ser necessário, e acessar `element.ref` gera warning de deprecação em dev. Componentes novos do shadcn já seguem esse padrão.

**Armadilhas**
- O `dispatch` de `useActionState` chamado fora de transition gera um `console.error` ("called outside of a transition"), e `isPending` não atualiza. Passe sempre via `action`/`formAction` ou embrulhe em `startTransition`.
- `<form action>` reseta campos não controlados após o sucesso. Isso é desejável no composer do chat e indesejável em formulários de edição: use `defaultValue` vindo do estado.

#### React Compiler (opcional)

Desde o plugin-react 6 o compilador **não vem ligado**. Ativar é opt-in explícito via `@rolldown/plugin-babel` (`0.2.4`), `@babel/core` e `babel-plugin-react-compiler` (`1.0.0`), conforme o README do plugin:
```ts
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
export default defineConfig({ plugins: [react(), babel({ presets: [reactCompilerPreset()] })] })
```
**Recomendação:** começar **sem** o compilador, porque ele traz Babel de volta e deixa o build mais lento. Avaliar depois em `compilationMode: 'annotation'` só para telas pesadas (inbox, canvas do xyflow).

#### Vite 8 (Rolldown + Oxc)

- O bundler passou a ser o **Rolldown**, e o pré-bundle de dependências também (o esbuild saiu do caminho padrão).
- `build.rollupOptions` → **`build.rolldownOptions`**. O nome antigo é aceito via shim de compatibilidade, com warning de deprecação. O mesmo vale para `worker.rollupOptions` → `worker.rolldownOptions`.
- `optimizeDeps.esbuildOptions` está deprecado (é convertido para `optimizeDeps.rolldownOptions`). `build.commonjsOptions` virou no-op.
- `output.file` agora **lança erro**: use `dir` + `entryFileNames`.
- `resolve.alias[].customResolver` foi removido: use um plugin com `resolveId` e `enforce: 'pre'`.
- **@vitejs/plugin-react 6**: React Refresh via **Oxc**, sem Babel. Peer `vite ^8`, Node `^20.19 || >=22.12`. Opções restantes: `include`, `exclude`, `jsxImportSource`, `jsxRuntime`, `reactRefreshHost`. Plugins Babel antigos passados por `react({ babel })` **não funcionam** e precisam migrar para `@rolldown/plugin-babel`.

#### Variáveis de ambiente

Só as variáveis com prefixo `VITE_` chegam ao cliente via `import.meta.env`. Tipagem em `src/vite-env.d.ts`, **sem nenhum `import`** no arquivo (um import quebra o augmentation):
```ts
interface ViteTypeOptions { strictImportMetaEnv: unknown } // proíbe chaves desconhecidas
interface ImportMetaEnv { readonly VITE_API_URL?: string }
interface ImportMeta { readonly env: ImportMetaEnv }
```
Siga o padrão do ai-manager: em produção a SPA é servida **na mesma origem da API** (Hono serve `dist/`), e em dev o Vite faz proxy de `/api`. Assim não há CORS e o cookie de sessão funciona no SSE.
**Armadilha:** o proxy do Vite para SSE funciona, mas não aplique `compress` do Hono em `text/event-stream` (ver §6).

---

### 2. Roteamento + data fetching: **TanStack Router + TanStack Query** (recomendado)

**context7:** `/tanstack/router` (docs main, 1.170), `/tanstack/query` (v5).

#### Comparação

| Critério | TanStack Router 1.170 + Query 5.104 | react-router 8.4 (data mode) |
|---|---|---|
| SPA servida pelo Hono | nativo (rotas por arquivo via plugin Vite, sem servidor próprio) | data mode serve; framework mode quer o próprio servidor/build (RR Vite plugin) |
| Search params tipados (filtros da inbox, kanban, relatórios) | **`validateSearch` com Zod 4 direto**, `Route.useSearch()` tipado, `loaderDeps` | `useSearchParams()` retorna `URLSearchParams` sem tipo, e o parse fica por nossa conta |
| Links/params tipados | inferência ponta a ponta (`<Link to="/chats/$chatId">` checado pelo TS) | typegen só no framework mode |
| Cache e invalidação realtime | integração oficial com Query: o loader pré-carrega e o componente assina o cache | loaders sem cache compartilhado, e revalidar significa re-rodar o loader inteiro |
| Requisitos | React >=18, Node >=20.19 | **v8: React >=19.2.7, Node >=22.22, ESM-only, `react-router-dom` removido, middleware sempre ativo** |

**Justificativa:** filtros de inbox e relatórios vivem na URL (`?status=open&tag=x&page=2&from=…`). O TanStack Router valida e tipa isso com o mesmo Zod 4 do backend. O TanStack Query dá o cache normalizado por chave, onde os eventos SSE de §6 fazem `setQueryData`/`invalidateQueries`, substituindo o `usePoll` do ai-manager. O react-router 8 acabou de quebrar API (jan–set/2026) e o ganho dele aparece no framework mode/SSR, que não usamos.

#### Notas verificadas

- Plugin Vite **antes** do `react()`:
  ```ts
  import { tanstackRouter } from '@tanstack/router-plugin/vite'
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), tailwindcss(), react()]
  ```
- Search params com Zod 4 (sem `@tanstack/zod-adapter`; use `.catch()` para URL inválida não quebrar a rota):
  ```ts
  export const Route = createFileRoute('/chats')({
    validateSearch: z.object({ status: z.enum(['open','pending','closed']).catch('open'),
                               page: z.number().int().min(1).catch(1) }),
    loaderDeps: ({ search }) => search,
    loader: ({ context, deps }) => context.queryClient.query(chatsQuery(deps)),
  })
  ```
- Root com contexto tipado (padrão "parênteses duplos"):
  `createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Root })`.
- No componente, `useSuspenseQuery(chatsQuery(search))` assina o cache e recebe as atualizações do SSE.
- Realtime: `queryClient.setQueryData(key, old => …)` (imutável; retornar `undefined` não altera nada) e depois `invalidateQueries({ queryKey })` para re-sincronizar. Centralize as chaves com `queryOptions()`.

**Armadilhas**
- **Defina `defaultPreloadStaleTime: 0` no `createRouter`.** Sem isso o cache de preload do Router (30 s) passa por cima do controle de frescor do Query. A doc marca isso como CRITICAL.
- **`ensureQueryData`/`prefetchQuery` estão deprecados** no Query 5 recente, em favor de `queryClient.query(...)`. Muitos tutoriais ainda usam a forma antiga.
- O `routeTree.gen.ts` é gerado pelo plugin: versione o arquivo ou rode o plugin antes do `tsc --noEmit` no CI, senão o typecheck falha.
- Como a SPA é servida pelo Hono com history API (não hash), o Hono precisa de fallback `GET *` → `index.html` para rotas que não sejam `/api`.

---

### 3. UI: **Tailwind CSS 4.3 + shadcn/ui (CLI 4.21, Base UI)** (recomendado)

**context7:** `/websites/tailwindcss`, `/shadcn-ui/ui/shadcn_4.21.0`.

**Justificativa:** o shadcn gera componentes acessíveis (dialog, sheet, dropdown, command, table, sidebar, chart) **como código no repo**, sem lock-in de runtime. Tem `Chart` sobre Recharts e tokens CSS iguais aos do `styles.css` atual, que dá para portar para `@theme`. A alternativa (manter CSS à mão, como no ai-manager) não escala para kanban, builder e inbox. Mantine/MUI trariam runtime CSS-in-JS e tema próprio.

#### Tailwind 4 (CSS-first)
- Instalação: `tailwindcss` + `@tailwindcss/vite`, `tailwindcss()` em `plugins`, e no CSS só `@import "tailwindcss";`. **Não existe mais `tailwind.config.js`** (no `components.json`, `tailwind.config: ""`).
- Tokens via `@theme` geram utilitários:
  ```css
  @import "tailwindcss";
  @theme { --color-brand: oklch(0.62 0.19 275); --color-state-stable: #16a34a; }
  @custom-variant dark (&:where(.dark, .dark *));   /* dark mode por classe */
  ```
- Monorepo: se as classes vivem em `packages/ui`, declare `@source "../../packages/ui/src";` ou use `@import "tailwindcss" source("../src")`, porque a detecção automática parte do CWD.

#### shadcn/ui
- `pnpm dlx shadcn@4.21.5 init` (Vite + TS precisa de alias `@/*` em `tsconfig.json` **e** em `resolve.alias`/`tsconfig paths` do Vite; o CLI detecta o alias pelo `paths`).
- **Desde jul/2026 o padrão do `init` é Base UI** (`@base-ui/react`), não Radix. Para escolher explicitamente: `shadcn init --base radix` (ou `-b radix`). Projetos com `style` legado (`new-york`, `default`) continuam Radix.
- **Recomendação: Base UI** (padrão atual, mantido pela equipe do MUI/Radix, 1.x estável). A diferença que mais afeta o dia a dia é a composição:
  ```tsx
  <DialogTrigger asChild><Button>Abrir</Button></DialogTrigger>        // radix
  <DialogTrigger render={<Button />}>Abrir</DialogTrigger>             // base
  ```
  Outras: `SelectContent position="popper"` (radix) vira `alignItemWithTrigger={false}` (base).
- Animações: `@import "tw-animate-css";`, que substitui o plugin `tailwindcss-animate` (deprecado no v4).

**Armadilhas**
- Não misture snippets Radix (`asChild`) com componentes gerados em Base. Exemplos antigos da internet e blocos de terceiros quase sempre usam Radix.
- O `@xyflow/react` traz CSS próprio. Importe-o **depois** do Tailwind ou use `@layer` para o preflight não sobrescrever (§4).
- Para o kanban/inbox, `className` com `cn()` (clsx + tailwind-merge 3) é o padrão. tailwind-merge 3.x só suporta Tailwind 4.

---

### 4. Builder de fluxos: **@xyflow/react 12.12**

**context7:** `/websites/reactflow_dev`.

- Fluxo **controlado** (necessário para salvar e validar):
  ```tsx
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges)
  const onConnect = useCallback((c: Connection) => setEdges(e => addEdge(c, e)), [])
  <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
    onEdgesChange={onEdgesChange} onConnect={onConnect} isValidConnection={validate} fitView colorMode="system" />
  ```
- **Nós customizados** (Mensagem, Pergunta, Condição, Delay, Tag, Mover etapa, Agente IA…) com `Handle`. Saídas múltiplas pedem `id` no handle (ex.: `sim`/`não`), e a edge guarda `sourceHandle`:
  ```tsx
  function ConditionNode({ data }: NodeProps<ConditionNode>) {
    return <div>{data.label}
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} id="yes" style={{ top: '30%' }} />
      <Handle type="source" position={Position.Right} id="no"  style={{ top: '70%' }} /></div>
  }
  ```
- Tipagem por união discriminada: `type AppNode = Node<{text:string},'message'> | Node<{ms:number},'delay'>`.
- Editar dados de dentro do nó: `useReactFlow().updateNodeData(id, patch)`. Inputs dentro do nó precisam da classe `nodrag` (e `nowheel` em áreas com scroll).
- **Salvar/restaurar:** `rfInstance.toObject()` → `{ nodes, edges, viewport }` (`ReactFlowJsonObject`), que vai para o backend como JSON (jsonb). Para restaurar: `setNodes`, `setEdges`, `setViewport(viewport)`. **Recomendação:** persistir um formato próprio e enxuto (id, type, position, data, edges com handles), validado por Zod no backend, e não o objeto cru, porque `measured`, `selected` e `dragging` são estado de UI.

**Armadilhas (v12)**
- **`nodeTypes`/`edgeTypes` fora do componente** (ou `useMemo`). Um objeto novo a cada render remonta todos os nós e gera warning.
- **CSS obrigatório:** `import '@xyflow/react/dist/style.css'` (ou `base.css` para estilizar do zero com Tailwind). O container pai precisa de **altura explícita**, senão o canvas fica com 0 px.
- Na v12 as dimensões medidas ficam em **`node.measured.width/height`**. `node.width/height` passaram a ser dimensões *fixas* de entrada (quebra em relação à v11). O pacote se chama `@xyflow/react`, não `reactflow`.
- Use `isValidConnection` para impedir ciclos e ligações inválidas (ex.: dois "Início"). A validação final do grafo deve acontecer no servidor antes de publicar o fluxo.

---

### 5. Kanban drag-and-drop: **@dnd-kit/react 0.5.1** (recomendado, versão fixada)

**context7:** `/websites/dndkit` (docs atuais já focadas em `@dnd-kit/react`), `/clauderic/dnd-kit`.

| | `@dnd-kit/core 6.3.1` + `@dnd-kit/sortable 10.0.0` (clássico) | `@dnd-kit/react 0.5.1` + `@dnd-kit/helpers` (nova geração) |
|---|---|---|
| Última release | **dez/2024** (parado) | **15/out/2026** (ativo) |
| React 19 | funciona (peer `>=16.8`) | peer declarado `^18 \|\| ^19` |
| Multi-coluna | `SortableContext` por coluna + `onDragOver` manual, com muito código | `useSortable({ group })` + helper `move()`, com guia oficial de kanban |
| Estabilidade de API | 1.x estável | **0.x**: pode quebrar entre minors |

**Justificativa:** a doc oficial e o guia "multiple sortable lists / kanban" agora são do `@dnd-kit/react`, o pacote clássico não recebe release há quase 2 anos e a nova API reduz bastante o código do kanban (colunas ordenáveis + cards entre colunas + coluna vazia). Para conter o risco do 0.x, **fixe a versão exata** (`"@dnd-kit/react": "0.5.1"`, idem `helpers`/`dom`) e encapsule o uso num único componente `KanbanBoard`.

```tsx
<DragDropProvider
  onDragStart={() => { snapshot.current = structuredClone(cols) }}
  onDragOver={(e) => { if (e.operation.source?.type === 'column') return; setCols(c => move(c, e)) }}
  onDragEnd={(e) => { if (e.canceled) return setCols(snapshot.current); persistMove(e) }}>
  {Object.entries(cols).map(([col, ids], i) => <Column key={col} id={col} index={i}>
    {ids.map((id, j) => <Card key={id} id={id} index={j} column={col} />)}</Column>)}
</DragDropProvider>
// Card: const { ref } = useSortable({ id, index, group: column, type: 'item', accept: 'item' })
```

- Em `onDragEnd`, use o type guard `isSortable(source)` para ler `initialIndex/index/initialGroup/group` e mandar `PATCH /deals/:id { stageId, position }` ao backend (com `useMutation` + rollback do snapshot se falhar).
- **Coluna vazia** precisa de `useDroppable({ id: col })` (ou a própria coluna sortable com `type: 'column'`), senão não dá para soltar nela.
- `DragOverlay` com função filha (`{source => <CardPreview id={source.id} />}`) evita clonar o card várias vezes.
- Sensores: `sensors={(d) => [...d.filter(s => s !== PointerSensor), PointerSensor.configure({...})]}`. **Não remova o `KeyboardSensor`**, porque isso tira a acessibilidade. As mensagens do leitor de tela vão em pt-BR via `Accessibility.configure({ announcements })` (`@dnd-kit/dom`).

**Armadilhas:** é 0.x, então leia o changelog antes de qualquer bump. Não misture `@dnd-kit/core` com `@dnd-kit/react` na mesma árvore (são providers diferentes). Com updates realtime (SSE movendo um card enquanto o usuário arrasta), adie a aplicação do evento até `onDragEnd`.

---

### 6. Realtime dos chats: **SSE (Hono `streamSSE` + `EventSource`)** (recomendado)

**context7:** `/honojs/hono/v4.13.0` (helper `hono/streaming`).

**Justificativa:**
- O fluxo é quase todo **servidor → cliente** (mensagem recebida, status de ACK, digitando, card movido, sessão caiu). Envios cliente → servidor já são `POST /api/...` comuns, com validação Zod e idempotência.
- **Autenticação por cookie** funciona nativamente: `EventSource` em mesma origem envia cookies. WebSocket no navegador não aceita headers customizados e exigiria token na query string.
- **Reconexão automática** com o header `Last-Event-ID`. O servidor reenvia o que falta a partir do id (ex.: id de um Redis Stream ou um sequencial por tenant).
- Passa por proxies HTTP e CDNs comuns sem upgrade. Encaixa direto no TanStack Query: cada evento vira `setQueryData`/`invalidateQueries`.
- WebSocket só se justificaria com tráfego bidirecional de alta frequência, o que não é o caso. Áudio e chamadas não estão no escopo.

Servidor (ilustrativo):
```ts
import { streamSSE } from 'hono/streaming'
app.get('/api/events', (c) => streamSSE(c, async (s) => {
  const from = c.req.header('Last-Event-ID'); const sub = bus.subscribe(tenantId, from)
  s.onAbort(() => sub.close())
  for await (const ev of sub) await s.writeSSE({ id: ev.id, event: ev.type, data: JSON.stringify(ev.payload) })
}))
```
Cliente:
```ts
const es = new EventSource('/api/events')              // mesma origem, cookie vai junto
es.addEventListener('message.new', (e) => qc.setQueryData(['chat', id, 'messages'], add(JSON.parse(e.data))))
es.addEventListener('chat.updated', () => qc.invalidateQueries({ queryKey: ['chats'] }))
```

**Armadilhas**
- `writeSSE` lança erro se `id` ou `event` contiverem `\r`/`\n`. O `data` multilinha é quebrado automaticamente.
- **Heartbeat:** proxies (nginx, Cloudflare) derrubam conexões ociosas. Mande um comentário/ping a cada ~15–25 s (`s.write(': ping\n\n')`) e `retry: 3000` na primeira mensagem.
- **nginx:** `proxy_buffering off;` (ou header `X-Accel-Buffering: no`) e `proxy_read_timeout` alto. O ai-manager tem `nginx.conf` no dashboard, então revise.
- **Não comprima SSE:** o middleware `compress` do Hono bufferiza. Exclua `text/event-stream` via `contentTypeFilter`.
- Limite de **6 conexões HTTP/1.1 por domínio**: use uma conexão SSE por aba, multiplexada por `event`, e sirva atrás de HTTP/2.
- Múltiplas réplicas da API: o "bus" precisa ser Redis (pub/sub ou Streams, este com replay para `Last-Event-ID`), já que temos ioredis.
- Ao reconectar sem histórico disponível, mande um evento `resync` para o cliente fazer `invalidateQueries()` geral.
- `streamSSE` roda o callback e **fecha o stream no fim**: o loop precisa ficar vivo até `onAbort`.

---

### 7. CSV de contatos: **papaparse 5.7.0**

**context7:** `/mholt/papaparse`.

**Recomendação: parse no cliente** (worker + streaming) para **preview e mapeamento de colunas**, depois envio em lotes validados ao servidor. Arquivos muito grandes (>50 MB) vão por upload e são parseados no servidor (`Papa.NODE_STREAM_INPUT`) dentro de um job BullMQ.

```ts
Papa.parse<Record<string, string>>(file, {
  header: true, skipEmptyLines: 'greedy', worker: true,
  transformHeader: (h) => h.trim().toLowerCase(),
  chunkSize: 1024 * 1024,
  chunk: (res, parser) => { batch.push(...res.data); if (batch.length >= 500) flush() },
  complete: () => flush(true), error: (err) => setError(err.message),
})
```
- Preview rápido: `preview: 20` (lê só as primeiras linhas) para a tela de "mapear colunas → nome/telefone/tags".
- Servidor: `fs.createReadStream(p).pipe(Papa.parse(Papa.NODE_STREAM_INPUT, { header: true }))` emite `data` por linha. Valide cada linha com Zod e normalize o telefone para E.164/JID antes do upsert.

**Armadilhas**
- Com **`worker: true`, `parser.pause()`/`resume()` não funcionam** (só `abort()`). Se precisar de backpressure (aguardar o POST de cada lote), use `chunk` **sem** worker, ou acumule e envie depois.
- `step` (linha a linha) é lento para arquivos grandes. Prefira `chunk`.
- **`dynamicTyping: true` destrói telefones** (perde o `+` e zeros à esquerda, e números grandes viram float). Mantenha strings.
- Encoding: CSVs exportados do Excel BR costumam vir em Windows-1252 e com `;` como delimitador. Passe `encoding: 'ISO-8859-1'` quando detectar e deixe `delimiter` em auto (ou `delimitersToGuess: [',', ';', '\t']`).
- Para exportar: `Papa.unparse(rows)`, com BOM `﻿` para o Excel abrir acentos corretamente.

---

### 8. Gráficos: **recharts 3.10.1** (mantido)

**context7:** `/recharts/recharts/v3.3.0` (versão 3.x mais próxima indexada).

Mudanças da v2 para a v3 que afetam o código:
- **`accessibilityLayer` passou a vir ligado por padrão**: navegação por teclado e leitor de tela sem configurar nada. Desligue só com motivo.
- **`activeIndex` foi removido.** O `Tooltip` controla a interação. Para destacar algo programaticamente, use as props do `Tooltip` (`defaultIndex`, `active`).
- **`<Customized>` está deprecado**: componentes arbitrários podem ser renderizados direto dentro do chart (sai na 4.0).
- **Tooltip customizado** tipado com `TooltipContentProps` (na v2 era `TooltipProps`):
  ```tsx
  const Tip = ({ active, payload, label }: TooltipContentProps<number, string>) =>
    active && payload?.[0] ? <div className="rounded border bg-popover p-2">{label}: {payload[0].value}</div> : null
  <Tooltip content={Tip} />
  ```
- **Responsivo:** `ResponsiveContainer` continua existindo (`width="100%" height={300}` ou `aspect`, `debounce`). O pai **precisa de altura definida**, senão o gráfico fica com 0 px, como no xyflow. Desde a **3.3** existe a prop `responsive` direto no chart (`<LineChart responsive style={{width:'100%', aspectRatio:1.6}}>`), que usa regras CSS padrão e dispensa o wrapper. O `ChartContainer` do shadcn também resolve isso.
- O estado interno passou a usar Redux Toolkit, e a v3 exige `react-is` como peer, o que explica `react-is` nas deps do ai-manager. Mantenha a versão igual à do React.

Uso no clone: relatórios de campanha (envios, entregues, lidos, respondidos por dia), funil do kanban e métricas Meta Ads. Prefira o wrapper **`Chart` do shadcn** (`ChartContainer`/`ChartTooltipContent`), que lê as cores dos tokens CSS, e reaproveite a ideia de `chart-theme.ts` do ai-manager.

---

### Resumo das decisões

1. **React 19.3 + Vite 8.3 + plugin-react 6.1**, sem React Compiler no início. Usar `useActionState`/`useOptimistic` em formulários e no envio de mensagens.
2. **TanStack Router 1.170 + TanStack Query 5.104** (search params tipados com Zod 4 e cache invalidado por SSE), substituindo o roteador por hash e o `usePoll` do ai-manager.
3. **Tailwind 4.3 + shadcn CLI 4.21 com Base UI** (padrão desde jul/2026).
4. **@xyflow/react 12.12**: fluxo controlado, `nodeTypes` estático, persistência em formato próprio validado por Zod.
5. **@dnd-kit/react 0.5.1** (fixado exato) com `move()` do `@dnd-kit/helpers` no kanban.
6. **SSE** (Hono `streamSSE` + `EventSource` + `Last-Event-ID` + Redis), não WebSocket.
7. **papaparse 5.7** no cliente (worker + chunk, sem `dynamicTyping`) para preview, e no servidor via job para arquivos grandes.
8. **recharts 3.10.1** via `Chart` do shadcn.

---

## Bloco E — APIs externas (Meta Ads/CAPI, TTS, STT, LLM, e-mail)

> Pesquisa feita em 15/10/2026. As versões vieram de `https://registry.npmjs.org/<pkg>/latest` nessa data.
> Fontes: context7 (IDs citados), docs oficiais (URLs citadas) e o código do ai-manager (somente leitura).
> O ai-manager declara `engines.node >=20`. Os conflitos de engine aparecem marcados como **⚠ Node**.

| Item | Recomendação | Versão |
|---|---|---|
| Meta Marketing/Graph | `fetch` direto (cliente fino próprio) sobre **Graph API v26.0** | — (sem SDK) |
| Conversions API | mesmo cliente `fetch` | — |
| TTS (vozes dos agentes) | **ElevenLabs** `@elevenlabs/elevenlabs-js` | 2.73.0 |
| STT (áudios recebidos) | **Groq Whisper** `whisper-large-v3-turbo` via `groq-sdk` | 1.6.0 |
| LLM | `@anthropic-ai/sdk` | 0.135.0 (o ai-manager usa 0.128.0) |
| E-mail | `nodemailer` | 10.1.1 (o ai-manager usa 10.0.10) |

---

### 1. Meta Marketing API / Graph API

**Pacote recomendado:** nenhum. A integração é um cliente HTTP fino com `fetch` nativo + zod para validar as respostas.
**Fontes:** https://developers.facebook.com/docs/graph-api/changelog/ ·
https://developers.facebook.com/docs/marketing-api/overview/rate-limiting ·
https://developers.facebook.com/docs/marketing-api/insights/best-practices ·
https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging ·
context7 `/facebook/facebook-nodejs-business-sdk`.

#### 1.1 Versão atual e cronograma (verificado no changelog)

| Versão | Lançamento | Graph disponível até | Marketing API disponível até |
|---|---|---|---|
| **v26.0** | 29/07/2026 | a definir | a definir |
| v25.0 | 18/02/2026 | 29/07/2028 | a definir |
| v24.0 | 08/10/2025 | 18/02/2028 | **06/10/2026 (já expirou)** |

- A Graph API mantém cada versão por cerca de 2 anos. A **Marketing API mantém por bem menos**: a v24 durou cerca de 1 ano.
- O changelog anuncia um "auto-upgrade" de versões da Marketing API a partir de 29/07/2026.
- Regra do projeto: a versão fica numa constante só, `META_GRAPH_VERSION='v26.0'`, com teste/alerta de data de expiração. Revisar duas vezes por ano (fevereiro e julho, quando a Meta costuma lançar versão).
- A v25 anunciou a remoção de métricas de alcance de página/post e de impressões de vídeo/story junto com a v26. Métricas removidas dão erro **em todas as versões**. O dashboard não pode depender delas.

#### 1.2 Auth e permissões
- Use um **System User token** (Business Manager → Usuários do sistema), com escopos `ads_read` e `ads_management` (este só se formos criar ou editar campanhas). `business_management` serve para listar contas de anúncio do BM. Um token de System User sem expiração evita refresh. Guarde-o cifrado, como já fazemos com os segredos de webhook no ai-manager.
- Multi-tenant (cada cliente conecta a própria conta de anúncio): use **Facebook Login for Business** com configuration_id, que gera token de System User do cliente. Para usar escopos avançados com terceiros, o app precisa passar pelo **App Review** com `ads_read`/`ads_management` em Advanced Access.
- Envie `appsecret_proof` (HMAC-SHA256 do token com o app secret) em todas as chamadas server-side.
- **Access tier** (changelog de 04/05/2026): o antigo "Standard Access" virou "Marketing API Access Tier". A aprovação automática exige **500 chamadas em 15 dias** com taxa de erro abaixo de 15%.

#### 1.3 Objetos e endpoints
Hierarquia: `act_<AD_ACCOUNT_ID>` → `campaigns` → `adsets` → `ads` (cada ad aponta para um `adcreative`).
```http
GET /v26.0/act_123/campaigns?fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget&limit=100
GET /v26.0/act_123/adsets?fields=id,name,campaign_id,status,optimization_goal,billing_event,daily_budget,targeting
GET /v26.0/act_123/ads?fields=id,name,adset_id,status,creative{id,name,object_story_spec,thumbnail_url}
POST /v26.0/<CAMPAIGN_ID>  status=PAUSED          # escrita = 3 pontos de rate limit
```
- A paginação usa cursores (`paging.cursors.after` / `paging.next`). Siga sempre `paging.next`, sem montar a URL na mão.
- Orçamentos chegam em **centavos da moeda da conta**, como string.

#### 1.4 Insights
```http
GET /v26.0/act_123/insights?level=ad
  &fields=campaign_id,adset_id,ad_id,ad_name,spend,impressions,clicks,ctr,cpc,cpm,actions,cost_per_action_type
  &date_preset=last_7d            # ou time_range={"since":"2026-10-01","until":"2026-10-14"}
  &time_increment=1               # 1 linha por dia
  &breakdowns=age,gender          # ou publisher_platform,platform_position
  &action_attribution_windows=["7d_click","1d_view"]
```
- `level`: `account|campaign|adset|ad`. As conversões de mensagem aparecem em `actions[]` com `action_type` como `onsite_conversion.messaging_conversation_started_7d`. Mapeie por `action_type` sem fixar índice de array.
- **Relatórios assíncronos** (períodos longos, muitos ads ou breakdowns):
  1. `POST /act_123/insights` com os mesmos parâmetros → `{ report_run_id }`
  2. Fazer polling em `GET /<report_run_id>?fields=async_status,async_percent_completion` até ter `Job Completed` e 100. Outros estados: `Job Failed`/`Job Skipped`.
  3. `GET /<report_run_id>/insights` (paginado).
  O `report_run_id` **expira em 30 dias**, então não serve como chave persistente. Encaixa num job BullMQ com backoff (o "repeat" faz o polling).
- Mudanças desde 10/06/2025: `use_unified_attribution_setting` e `action_report_time` são **ignorados** e a atribuição segue a configuração do ad set. Queries com `breakdowns` e `start_date` de mais de 13 meses atrás **não retornam reach/frequency/cpp**. Para obtê-los é preciso job async, limitado a 10 por conta por dia, com o header `x-fb-ads-insights-reach-throttle`.

#### 1.5 Rate limits (BUC)
Headers a ler em **toda** resposta e gravar como métrica:
- `x-business-use-case-usage`: JSON `{ "<biz_id>": [{ type, call_count, total_cputime, total_time, estimated_time_to_regain_access }] }`. Os valores são porcentagens (0–100).
- `x-ad-account-usage`: `acc_id_util_pct`, `reset_time_duration`, `ads_api_access_tier`.
- `x-fb-ads-insights-throttle`: `app_id_util_pct`, `acc_id_util_pct`.
- Pontuação: leitura vale 1 ponto e escrita vale 3, com decaimento em 300 s. O tier **Limited** permite até 60 pontos (bloqueio de 300 s). O tier **Full** permite 9000 (bloqueio de 60 s).
- Erros: `17/2446079` e `613/1487742` (score da conta), `80000/80003/80004/80014` (BUC por conta), `613/5044001` (mutações acima de 100 QPS), `4/1504022|1504039` (insights por app).
- Implementação: um rate limiter por `ad_account_id` em Redis. Ao passar de 75% em qualquer header, adie o job em `estimated_time_to_regain_access` minutos. Os erros acima viram `DelayedError`/backoff no BullMQ e não contam como falha.

#### 1.6 Click-to-WhatsApp (CTWA) com Baileys: atribuição
No **proto do Baileys** (`WAProto.proto`, master, conferido), a primeira mensagem vinda de um anúncio CTWA traz em `message.<tipo>.contextInfo`:
```ts
const ci = msg.message?.extendedTextMessage?.contextInfo ?? msg.message?.imageMessage?.contextInfo
const ad = ci?.externalAdReply          // ExternalAdReplyInfo
ad?.sourceType   // "ad"
ad?.sourceId     // ID do anúncio (ad_id) → join com /insights level=ad
ad?.sourceUrl    // link do anúncio (fb.me/…)
ad?.ctwaClid     // click id (campo 13)
ci?.conversionSource; ci?.entryPointConversionSource; ci?.ctwaPayload /* bytes */
```
- Guarde `sourceId` + `ctwaClid` + `title/body` no **lead/conversa**, na primeira mensagem. Isso fecha o funil anúncio → conversa → venda sem precisar de API: um join de `sourceId` com `ad_id` dos insights dá custo por lead e ROAS por anúncio.
- ⚠ **Armadilha principal:** enviar a conversão de volta para a Meta (CAPI "business_messaging") exige `user_data.whatsapp_business_account_id` + `ctwa_clid` e permissões `whatsapp_business_management` + `whatsapp_business_manage_events`. Ou seja, precisa de uma **WABA (Cloud/On-Prem API)**. Como o projeto usa **só Baileys, sem WABA**, o caminho oficial de otimização por compra em CTWA **não está disponível**. Alternativa: enviar o evento para um **dataset/Pixel** com `action_source: "chat"` (ou `"system_generated"`), com `user_data` hasheado (telefone/e-mail) e `custom_data`. A Meta casa por match de usuário, mas o vínculo é fraco e não usa o `ctwa_clid`. Documente essa limitação para o usuário.
- Os campos do `contextInfo` são engenharia reversa do WhatsApp Web e podem mudar ou sumir sem aviso. Valide-os com zod `optional()` e nunca dependa deles para lógica crítica.

#### 1.7 Conversions API (Pixel/dataset)
```http
POST /v26.0/<PIXEL_OR_DATASET_ID>/events?access_token=…
{ "data": [{
  "event_name": "Purchase", "event_time": 1760500000, "event_id": "deal_8f2c…",
  "action_source": "chat",
  "user_data": { "ph": ["<sha256(5511999998888)>"], "em": ["<sha256(email)>"], "external_id": ["<sha256(leadId)>"] },
  "custom_data": { "currency": "BRL", "value": 497.00 } }],
  "test_event_code": "TEST12345" }
```
- **Hashing SHA-256** em hex minúsculo, **depois de normalizar**: e-mail com trim + lowercase; telefone **só com dígitos e DDI** (`55…`), sem `+`. Nome e cidade em lowercase sem acento. `client_ip_address`, `client_user_agent`, `fbc` e `fbp` **não** são hasheados.
- **Deduplicação:** Pixel e CAPI deduplicam por `event_name` + `event_id`. Use o mesmo `event_id` dos dois lados (por exemplo, o id do negócio ou da etapa). No caso "business_messaging", a Meta **não** deduplica, então a deduplicação fica por nossa conta (unique em `(dataset_id, event_id)`).
- `event_time` vai em segundos Unix e precisa estar nos últimos 7 dias. Lote de até 1000 eventos por request.
- `test_event_code` só existe no ambiente de teste. Nunca deixe esse campo em produção.

#### 1.8 SDK oficial × fetch. Recomendação: **fetch**
- `facebook-nodejs-business-sdk@24.0.1` é o `latest` no npm (21/11/2025) e aponta para **v24.0, que já expirou na Marketing API**. O `main` no GitHub já tem `VERSION = 'v26.0'`, mas **ainda não foi publicado**. O SDK é gerado, tem tipagem fraca (fonte Flow/JS) e o `EventRequest` chama `FacebookAdsApi.init(token)`, que é um **singleton global**. Isso é ruim para multi-tenant, porque os tokens vazam entre requests concorrentes.
- Com fetch: cerca de 150 linhas (`graphGet/graphPost`, paginação, parse dos headers BUC, `appsecret_proof`, erros tipados), versão controlada por nós e testável com `fetch` injetado, como o `FetchLike` já usado em `ai-manager/packages/core/src/alerts/channels.ts`.

---

### 2. TTS para vozes dos agentes (pt-BR). Recomendação: **ElevenLabs**

**Pacote:** `@elevenlabs/elevenlabs-js@2.73.0` · **Fontes:** context7 `/elevenlabs/elevenlabs-js` · https://elevenlabs.io/docs/overview/models · https://elevenlabs.io/pricing/api

#### 2.1 Comparativo
| Provedor | Modelo | pt-BR | Saída Opus direta | Preço (ordem de grandeza) |
|---|---|---|---|---|
| **ElevenLabs** | `eleven_flash_v2_5` (≈75 ms) / `eleven_v4` (topo) / `eleven_multilingual_v2` (pt-BR e pt-PT) | excelente, clonagem de voz (IVC/PVC) | `opus_48000_32…192` | US$0,04/1k caracteres (Flash, v4 Turbo); US$0,08/1k (v4, v3, Multilingual v2) |
| OpenAI | `gpt-4o-mini-tts` (`instructions` controla tom e emoção); vozes `marin`/`cedar` recomendadas | bom, mas vozes "otimizadas p/ inglês" (sotaque) | `response_format: "opus"` | mais barato que ElevenLabs (conferir a tabela; a página lista TTS "por 1M caracteres") |
| Google Cloud TTS | Chirp 3 HD / Neural2 pt-BR | muito bom | `audioEncoding: OGG_OPUS` | por milhão de caracteres (não verificado nesta sessão) |
| Azure Speech | Neural pt-BR (Francisca, Antonio, multilíngues) | muito bom, SSML | `Ogg48Khz16BitMonoOpus` | por milhão de caracteres (não verificado nesta sessão) |

**Justificativa:** é a melhor naturalidade em pt-BR, permite **clonar a voz** de um atendente ou da marca (diferencial de produto para "agentes com voz") e entrega Opus nativo. O `eleven_flash_v2_5` custa metade e responde em cerca de 75 ms, o que basta para áudios curtos de WhatsApp. O modelo fica configurável por agente: `flash_v2_5` como padrão e `v4` como premium. OpenAI `gpt-4o-mini-tts` fica como fallback barato atrás de uma interface `TtsProvider` (mesmo padrão de `AiProvider` injetável do ai-manager).

#### 2.2 Uso
```ts
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'
const el = new ElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY })
const stream = await el.textToSpeech.convert(voiceId, {
  text, modelId: 'eleven_flash_v2_5', outputFormat: 'opus_48000_64',
  languageCode: 'pt',                       // ignorado em multilingual_v2
})                                           // ReadableStream<Uint8Array>
// Baileys: { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }
```

#### 2.3 Armadilhas
- **SDK v2:** as opções viraram camelCase (`modelId`, `outputFormat`; antes `model_id`). Exemplos antigos na web quebram.
- `eleven_turbo_v2_5` e `eleven_turbo_v2` estão **deprecados**. Use `eleven_flash_v2_5`.
- O PTT do WhatsApp exige **Ogg/Opus mono**. Normalize sempre com ffmpeg (`-c:a libopus -ac 1 -ar 48000 -b:a 32k -f ogg`), mesmo quando o provedor já entregar Opus: o container e os canais variam entre provedores e versões. Gere também a `waveform` e `seconds` para o Baileys, senão o player aparece sem onda ou com duração 0:00.
- O `languageCode` não vale no `multilingual_v2`. Números, datas e moeda (R$) saem melhores com `applyTextNormalization: 'on'`, ou normalizando o texto antes.
- Saída mp3 a 192 kbps e PCM/WAV a 44,1 kHz exigem plano Creator/Pro.
- Política OpenAI (se usar o fallback): é obrigatório **avisar o usuário final de que a voz é gerada por IA**. Recomenda-se o mesmo para ElevenLabs.

---

### 3. STT para áudios recebidos (Ogg/Opus, pt-BR). Recomendação: **Groq `whisper-large-v3-turbo`**

**Pacote:** `groq-sdk@1.6.0` (API compatível com OpenAI) · **Fonte:** https://console.groq.com/docs/speech-to-text

#### 3.1 Comparativo
| Provedor | Modelo | Aceita `.ogg` nativo | Preço |
|---|---|---|---|
| **Groq** | `whisper-large-v3-turbo` / `whisper-large-v3` | **sim** | **US$0,04/h** (turbo) · US$0,111/h |
| OpenAI | `gpt-transcribe` (novo, recomendado), `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1` | a página atual lista mp3, mp4, mpeg, mpga, m4a, wav, webm (**sem ogg**) | US$0,006/min (gpt-4o-transcribe) ≈ US$0,36/h |
| Deepgram | Nova-3 (multilíngue, pt) | sim | US$0,0043/min (mono) · US$0,0052/min (multi); US$200 de crédito inicial |
| ElevenLabs | Scribe v2 | sim | US$0,22/h |
| AssemblyAI | Universal | sim | não verificado nesta sessão |

**Justificativa:** áudio de WhatsApp é curto e chega em volume. O Groq custa cerca de 9× menos que a OpenAI e cerca de 6× menos que o Deepgram, aceita `ogg` sem conversão e tem latência muito baixa. O Whisper large-v3 é sólido em pt-BR. Como a API é compatível com OpenAI, trocar para `gpt-transcribe` (melhor qualidade, aceita `keywords` com nomes de produtos) é só mudar a `baseURL` ou o provider, atrás de uma interface `SttProvider`.

#### 3.2 Uso
```ts
import Groq, { toFile } from 'groq-sdk'
const groq = new Groq({ apiKey: env.GROQ_API_KEY })
const r = await groq.audio.transcriptions.create({
  file: await toFile(oggBuffer, 'audio.ogg'), model: 'whisper-large-v3-turbo',
  language: 'pt', response_format: 'json', temperature: 0,
})
// r.text
```

#### 3.3 Armadilhas
- **Sempre passe `language: 'pt'`.** Sem ele, áudios curtos ("oi", "sim") são detectados como outro idioma.
- Limite de **25 MB** por arquivo no plano free (100 MB no dev). Acima disso, use o parâmetro `url`. Áudio de WhatsApp quase nunca chega perto.
- Whisper alucina em silêncio ou ruído ("Legendas pela comunidade Amara.org", "Obrigado por assistir"). Descarte transcrições com `duration` abaixo de 1 s ou que batam com uma blocklist conhecida.
- **OpenAI:** `gpt-transcribe` usa `languages` (plural), que **substitui** `language`; enviar os dois dá erro. O `ogg` não aparece na lista oficial atual, então seria preciso converter para `webm`/`mp3` com ffmpeg. ⚠ **Node:** `openai@7.34.0` exige **Node ≥22**, e o ai-manager declara `>=20`.
- A transcrição roda num **job BullMQ separado** (fila `stt`), com download da mídia via Baileys `downloadMediaMessage`. Ela não pode bloquear o `messages.upsert`.

---

### 4. LLM: `@anthropic-ai/sdk`

> Atualizado: o LLM agora é multi-provider por agente. A decisão e o contrato estão no **Bloco F**; esta seção fica como referência do SDK da Anthropic (usado pelo ai-manager e por um eventual adapter direto).

**Versão:** `0.135.0` (15/10/2026) · o ai-manager está em **0.128.0** (22/09/2026).
**Fontes:** skill `claude-api` (models cache de 06/10/2026), CHANGELOG do repo `anthropics/anthropic-sdk-typescript`.
**Peer dep:** `zod ^3.25 || ^4`, compatível com zod 4.

#### 4.1 0.128 → 0.135
Nenhuma mudança breaking no changelog. Novidades relevantes: parâmetro `speed` com `usage.speed` (fast mode), **OpenTelemetry nativo** no client, streams fechados quando descartados sem leitura e `MessageStream` tolerante a eventos desconhecidos. **Recomendação:** use `0.135.0` no clone e alinhe o ai-manager quando ele for atualizado. Uma versão só no monorepo evita tipos duplicados.

#### 4.2 Modelos atuais (confirmados)
| ID | Contexto | US$/MTok in/out | Uso sugerido |
|---|---|---|---|
| `claude-opus-5-5` | 1M | 4 / 20 | padrão para agentes de atendimento complexos |
| `claude-sonnet-5-5` | 1M | 2 / 10 | alternativa custo/latência (o usuário decide) |
| `claude-haiku-5-5` | 1M | 0,10 / 0,50 (até 100K de prompt) | classificação, roteamento, resumo de conversa |

Use os IDs exatos, sem sufixo de data. O modelo fica configurável por agente, como `AI_MODEL` no ai-manager.

#### 4.3 Padrão atual do ai-manager (`packages/core/src/ai/provider.ts`)
Interface `AiProvider` injetável (testes usam fake) + `client.messages.parse()` com `output_config: { format: zodOutputFormat(Schema) }`. Checa `stop_reason === 'refusal' | 'max_tokens'` antes de ler `parsed_output`. O texto do cliente vai delimitado em `<mensagem>…</mensagem>` com instrução anti-injection. **O clone deve espelhar esse padrão.**

#### 4.4 Tool use. Tool Runner (beta helper do SDK)
```ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod'
const moverEtapa = betaZodTool({
  name: 'mover_etapa_funil', description: 'Move o lead para outra etapa do kanban',
  inputSchema: z.object({ leadId: z.string(), etapa: z.enum(ETAPAS) }),
  run: async ({ leadId, etapa }) => JSON.stringify(await crm.moveLead(leadId, etapa)),
})
const final = await client.beta.messages.toolRunner({
  model: 'claude-opus-5-5', max_tokens: 16000, tools: [moverEtapa], messages,
})  // `for await (const m of runner)` dá hooks por turno (aprovação, log)
```
- Loop manual (alternativa): enquanto `stop_reason === 'tool_use'`, execute **todos** os `tool_use` e devolva **todos** os `tool_result` (com o mesmo `tool_use_id`) numa **única** mensagem `user`. Falha vira `is_error: true`, nunca é omitida.
- `strict: true` na definição da tool (schema com `additionalProperties: false`) garante input válido.

#### 4.5 Streaming e prompt caching
- `client.messages.stream({...})` → `.on('text', …)` para mandar ao dashboard via SSE, e `await stream.finalMessage()` para obter o resultado. Use stream sempre que `max_tokens` for alto.
- Caching: `cache_control: { type: 'ephemeral' }` no **último bloco estável** (system prompt do agente + base de conhecimento + tools). A ordem de render é `tools → system → messages`. Não ponha timestamp nem dados voláteis no system prompt. Confira `usage.cache_read_input_tokens`. TTL padrão de 5 min, com `ttl: '1h'` disponível. Máximo de 4 breakpoints.

#### 4.6 Armadilhas (modelos 5.5)
- **Opus 5.5:** não aceita `thinking: {type:'disabled'}` nem `budget_tokens` (**400**). O controle é `output_config: { effort }`, cujo default é **`medium`**. Use `low` em respostas rápidas de chat.
- **Opus/Sonnet 5.5:** `tool_choice` `any`/`tool` (forçado) dá **400**. Use `auto` + instrução + `strict: true`, ou structured outputs. Isso afeta quem tentar "forçar" a tool de classificação.
- Sem **prefill** de assistant (400). Use `output_config.format`, como o ai-manager já faz.
- Trate `stop_reason: 'refusal'` (HTTP 200) e, nos modelos 5.5, considere `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`).
- Parseie `tool_use.input` como objeto. Nunca faça match de string no JSON serializado.
- Histórico append-only: editar turnos antigos invalida thinking blocks ("preserved thinking"; contas criadas a partir de 31/08/2026 levam 400). Não reescreva mensagens antigas da conversa enviadas ao modelo.
- `maxRetries: 0` no ai-manager é proposital, porque o timeout total é controlado fora. Mantenha esse padrão.

---


### 6. E-mail: `nodemailer@10.1.1`

**Fonte:** CHANGELOG `nodemailer/nodemailer` · uso atual em `ai-manager/packages/core/src/alerts/channels.ts`.

#### 6.1 Mudanças breaking (6 → 10)
| Versão | Data | Breaking |
|---|---|---|
| 7.0.0 | 03/05/2025 | transporte SES só via **SESv2 SDK** (`@aws-sdk/client-sesv2`); removidos SES SDK v2/v3, rate limit e idling do SES |
| 8.0.0 | 04/02/2026 | código de erro `NoAuth` → **`ENOAUTH`** |
| 9.0.0 | 14/06/2026 | fetch de conteúdo remoto (attachments `href`/`path` URL, endpoint de token OAuth2, CONNECT de proxy) agora **valida TLS** (pode ser desligado por anexo/transporte com `tls.rejectUnauthorized=false`) |
| 10.0.0 | 03/09/2026 | **Node ≥20** |
| 10.1.0/10.1.1 | 10 e 14/10/2026 | sem breaking. Endurece stream, SMTP e pool. O fetch passa a remover credenciais em redirect cross-origin (**fix de segurança: use ≥10.1.1**) |

#### 6.2 Uso
O ai-manager usa a URL SMTP com timeouts curtos e fecha o transporte a cada alerta:
```ts
nodemailer.createTransport({ url: opts.url, auth, connectionTimeout: t, greetingTimeout: t, socketTimeout: t })
```
Para o volume do CRM (notificações, convites, relatórios), use **pool** e **DKIM**:
```ts
const tx = nodemailer.createTransport({
  host: env.SMTP_HOST, port: 587, secure: false, auth: { user, pass },
  pool: true, maxConnections: 5, maxMessages: 100,       // reusar conexões
  dkim: { domainName: 'cliente.com.br', keySelector: 'mail', privateKey: env.DKIM_KEY },
})
await tx.verify()   // no boot; tx.close() no shutdown
```
- Com `pool: true`, o transporte é **singleton** de vida longa. Não crie um por e-mail, como faz o fluxo de alertas do ai-manager.
- Porta 465 usa `secure: true`. Na 587, STARTTLS acontece automaticamente.
- Envio em massa sai por uma fila BullMQ `email` com limiter, nunca dentro do request HTTP.

#### 6.3 Alternativas transacionais
- **Resend** (`resend@6.33.0`, Node ≥20): API simples (`resend.emails.send({ from, to, subject, html|react })`), webhooks de entrega/bounce, combina com React Email. Bom para começar. Também expõe SMTP, então dá para usar pelo próprio nodemailer.
- **Amazon SES** (`@aws-sdk/client-sesv2@3.1152.0`): o mais barato em volume. Pode ser usado direto ou via `nodemailer` com `SES: { sesClient, SendEmailCommand }` (formato SESv2 desde o nodemailer 7). Exige sair do sandbox do SES e configurar SNS para bounces.
- **Recomendação:** manter nodemailer como camada única. O SMTP vem de config (Resend SMTP, SES SMTP ou SMTP do cliente), o que dá zero lock-in e é o mesmo padrão do ai-manager. A API nativa do Resend/SES só entra se precisarmos de webhooks de bounce/abertura no CRM.

---

### Resumo das armadilhas de versão
1. **Marketing API v24 expirou em 06/10/2026.** Use **v26.0**. O `facebook-nodejs-business-sdk@24.0.1` no npm ainda aponta para v24: não usar.
2. **CTWA → CAPI exige WABA** (`whatsapp_business_account_id` + `ctwa_clid`). Com só Baileys, a atribuição fica interna: `externalAdReply.sourceId`/`ctwaClid` × insights por `ad_id`.
3. **`openai@7` exige Node ≥22** (conflita com `>=20`). O `gpt-transcribe` usa `languages`, e a lista oficial não tem `ogg`.
4. **ElevenLabs:** SDK v2 com opções em camelCase. Modelos `turbo_*` deprecados.
5. **Anthropic 5.5:** sem `thinking.disabled`/`budget_tokens`, sem `tool_choice` forçado, sem prefill. O effort padrão do Opus 5.5 é `medium`.
6. **nodemailer:** use ≥10.1.1 (fix de credenciais em redirect). Na v8, `NoAuth` virou `ENOAUTH`. Na v9, o TLS estrito nos fetches remotos.

---

## Bloco F — LLM multi-provider (Anthropic + OpenAI + Google Gemini)

> Decisão do usuário (2026-10-15): cada agente de IA escolhe provedor e modelo; os três provedores são suportados. Pesquisa feita com versões do registry npm nessa data e com o context7: `/websites/developers_openai_api` (sem versão), `/googleapis/js-genai` (só a tag v2.0.1, conferida contra o CHANGELOG até 2.30.0) e `/websites/ai-sdk_dev` (v7). Os detalhes por SDK estão nas subseções F.4 a F.6.

### F.1 Versões

| Pacote | Versão | Engines / peers | Papel |
|---|---|---|---|
| `ai` (Vercel AI SDK) | **7.0.142** | Node ≥ 22, ESM-only; peer zod `^3.25.76 \|\| ^4.1.8` (zod 4.6.5 ok) | núcleo do adapter único |
| `@ai-sdk/anthropic` | **4.0.81** | precisa do `ai@7` (spec `LanguageModelV4`) | Anthropic |
| `@ai-sdk/openai` | **4.0.95** | idem | OpenAI (Responses API por padrão) |
| `@ai-sdk/google` | **4.0.98** | idem | Gemini (`createGoogle`) |
| `@ai-sdk/provider` | 4.0.28 | transitivo, igual nos três | define a spec |
| `@ai-sdk/otel` | 1.0.142 (opcional) | — | telemetria OpenTelemetry |
| `@anthropic-ai/sdk` | 0.128.0 (lock do ai-manager; latest 0.135.0) | — | adapter direto, só para recursos que o AI SDK não cobre (Batch, betas) |
| `openai` | 7.34.0 (só se precisar de adapter direto) | **Node ≥ 22**; zod peer opcional `^3.25 \|\| ^4` | idem |
| `@google/genai` | 2.30.0 (só se precisar de adapter direto) | Node ≥ 20 | idem; **não** usar o legado `@google/generative-ai` 0.24.1 |

Regra: fixar `ai` e os três `@ai-sdk/*` **exatos** e subir todos juntos (a major do `ai` precisa casar com a major dos providers: `ai@7` ↔ `@ai-sdk/*@4`).

### F.2 Contrato único: `LlmProvider` (porta do crm-core)

O domínio (agentes, classificação, resumo, sugestão) só conhece esta porta. Ela fica num pacote nosso (`@leona/llm-port`), no mesmo espírito do `AiProvider` do ai-manager e do `WaGateway` (ver AI-MANAGER-MAP §13).

```ts
type LlmModelRef = { provider: 'anthropic' | 'openai' | 'google'; model: string }   // ex.: { provider:'openai', model:'gpt-6.1-sol' }
type LlmMessage =
  | { role: 'user'; content: LlmPart[] }                 // texto, imagem, áudio (url/buffer + mime)
  | { role: 'assistant'; content: LlmPart[]; providerData?: unknown }   // tool calls + dado opaco (thoughtSignature, reasoning cifrado)
  | { role: 'tool'; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
interface LlmTool<I, O> { name: string; description: string; input: z.ZodType<I>; execute(input: I, ctx: ToolCtx): Promise<O> }
interface LlmUsage { inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; reasoningTokens; costMicros: number } // custo calculado por nós
interface LlmRequest<T = unknown> {
  model: LlmModelRef; instructions: string; messages: LlmMessage[]
  tools?: LlmTool<any, any>[]; maxSteps?: number                       // loop de tools controlado (default 5)
  output?: z.ZodType<T>                                                // structured output
  maxOutputTokens?: number; temperature?: number; signal?: AbortSignal
  tenantId: string; agentId: string                                    // contabilidade e limites
}
interface LlmResult<T = unknown> { text: string; object?: T; steps: LlmStep[]; usage: LlmUsage; finish: 'stop' | 'length' | 'tool-limit' | 'refusal' | 'error' }
interface LlmProvider { generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>>; countTokens?(req: LlmRequest): Promise<number> }
```

Decisões embutidas no contrato:
- **Ferramentas definidas uma vez em zod.** O adapter converte (AI SDK `tool({ inputSchema })`; nos adapters diretos, `z.toJSONSchema`).
- **Loop de tools explícito e limitado** (`maxSteps`). Sem chamada automática de função do Gemini, para os três provedores terem o mesmo comportamento.
- **`providerData` opaco** na mensagem do assistente. Precisa ser gravado no Postgres e reenviado tal como veio: o Gemini exige o turno do modelo com `thoughtSignature`, e a OpenAI com `store:false` precisa dos itens de reasoning cifrados.
- **Uso e custo normalizados.** `usage` soma todos os passos. O custo é calculado pela nossa tabela de preços (`crm.llm_prices`, por provedor e modelo, com vigência), porque nenhum SDK calcula custo e os preços mudam com data marcada (por exemplo, o `gemini-4-argon` dobra em 2026-12-01).
- **Sem retry no provider** (`maxRetries: 0`): quem tenta de novo é o job BullMQ, com backoff, como o ai-manager faz.
- **Limites por empresa** (substitui o módulo de cobrança): antes de cada chamada, o `UsageGuard` confere a cota de tokens ou custo do tenant no período (contador em Redis e consolidado em `crm.ai_usage`); depois de cada chamada, grava `LlmUsage`. Estourou a cota → `LlmQuotaExceededError`, e o agente transfere para um humano.

### F.3 Vercel AI SDK × adapters próprios — avaliação e recomendação

| Critério | AI SDK 7 atrás da porta | Adapters próprios (um por SDK oficial) |
|---|---|---|
| Custo de implementar 3 provedores | baixo: uma chamada `generateText` cobre os três | alto: 3 formatos de mensagem, 3 loops de tools, 3 formatos de usage |
| Tools e loop multi-step | nativo (`tools`, `isStepCount`), schema zod direto | cada adapter reimplementa o loop e a conversão zod→JSON Schema |
| Structured output | `output: Output.object({ schema })` igual nos três | `messages.parse` / `responses.parse` / `responseJsonSchema`, cada um com restrições próprias |
| Usage | normalizado (`inputTokenDetails.cacheReadTokens`, `outputTokenDetails.reasoningTokens`) | mapear `usage` / `usageMetadata` de cada SDK |
| Recursos novos de um provedor | atraso de dias ou semanas; alguns só via `providerOptions` | disponíveis no dia |
| Lock-in | moderado; a porta própria limita o impacto a 1 arquivo | nenhum |
| Dependências | `ai` + 3 providers (inclui gateway da Vercel, não usado) | 3 SDKs oficiais |
| Testes | `MockLanguageModelV4` (`ai/test`) e fake da nossa porta | só fake da porta |
| Churn de versão | alto: v5→v6→v7 em ~1 ano, com renames | baixo a médio |
| Encaixe com o ai-manager | não conflita: o `AiProvider` dele segue com `@anthropic-ai/sdk` | idem |

**Recomendação: AI SDK 7 atrás da porta `LlmProvider`.** Só um arquivo (`llm-aisdk/adapter.ts`) importa `ai`/`@ai-sdk/*`; regra ESLint `no-restricted-imports` no resto. Com a exigência de três provedores por agente, o AI SDK economiza os três loops de tools e a normalização de usage, e o custo de troca fica contido na porta. Se precisarmos de um recurso exclusivo (Batch API da Anthropic, beta nova da OpenAI), entra um adapter direto atrás da mesma porta, roteado por `LlmModelRef`. O `AiProvider` do ai-manager (classificação com `messages.parse`) não muda; no modo extensão os dois convivem.

Regras de uso do AI SDK no adapter:
- Sempre instância de provider criada **por empresa** (`createAnthropic({ apiKey })`, `createOpenAI({ apiKey })`, `createGoogle({ apiKey })`), com as chaves cifradas no banco como as credenciais do ai-manager. **Nunca** passar `model` como string solta: isso envia o tráfego pelo Vercel AI Gateway.
- OpenAI: `providerOptions.openai.store = false` (dados de cliente não ficam 30 dias na OpenAI); histórico reconstruído do nosso Postgres.
- `maxRetries: 0`; `abortSignal` do job; `instructions` (v7) em vez de `system`, e nada de mensagens `system` dentro de `messages` (o v7 rejeita).
- Contexto do tenant para as tools via `runtimeContext`/`toolsContext` (v7), nunca por variável global.
- Structured output conta como um passo: `isStepCount(maxSteps + 1)`.

### F.4 Armadilhas de versão — LLM

1. **AI SDK v7** (2026-06-25): `stepCountIs`→`isStepCount`, `system`→`instructions`, `onStepFinish/onFinish`→`onStepEnd/onEnd`, `experimental_output`→`output`, `generateObject` deprecado (usar `generateText({ output: Output.object() })`), `usage` já é o total (`totalUsage` deprecado), `cachedInputTokens/reasoningTokens` → `inputTokenDetails/outputTokenDetails`, `experimental_context` → `runtimeContext` + `toolsContext`, telemetria em `@ai-sdk/otel`, `createGoogleGenerativeAI`→`createGoogle`, middleware com `specificationVersion: 'v4'`. Exemplos da internet de v4–v6 **não compilam**.
2. **`openai@7`**: Node ≥ 22. Responses API com `store: true` por padrão. Chat Completions continua suportada; a Assistants API foi desligada em 2026-08-26. Em structured output, use `.nullable()` em vez de `.optional()`. Os dist-tags `next`/`beta` estão velhos: instalar `latest`.
3. **`@google/genai` 2.x**: tudo vai dentro de `config` (inclusive `systemInstruction`); papéis `user`/`model`; `functionResponse.response` precisa ser objeto e casar o `id`; reenviar o turno do modelo com `thoughtSignature`; `thoughtsTokenCount` é cobrado como saída, mas vem separado de `candidatesTokenCount`. A doc nova empurra a Interactions API (stateful); para nós vale `generateContent`.
4. **Anthropic 5.5**: sem prefill; `thinking` desligado, `budget_tokens` ou `tool_choice` forçado → 400 (ver Bloco E §4).
5. **Modelos são strings de banco, não constantes**: OpenAI `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`; Gemini `gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.5-flash-lite`; Anthropic `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`. Modelos são desligados (`gemini-3-pro-preview`, `gemini-2.0-flash` já saíram): validar o modelo no cadastro do agente.

### F.5 Defaults sugeridos por papel de agente

| Papel | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| Atendimento alto volume / classificação | `claude-haiku-5-5` | `gpt-6-luna` | `gemini-3.5-flash-lite` |
| SDR / vendas com tools | `claude-sonnet-5-5` | `gpt-6.1-sol` | `gemini-3.8-flash` |
| Tarefas complexas (raras) | `claude-opus-5-5` | `gpt-6-astra` | `gemini-4-argon` |

Preços por MTok (entrada/saída, páginas oficiais em 2026-10-15): claude-haiku-5-5 0,10/0,50 · claude-sonnet-5-5 2/10 · claude-opus-5-5 4/20 · gpt-6-luna 0,10/0,50 · gpt-6.1-sol 2/10 · gpt-6-astra 10/50 · gemini-3.5-flash-lite 0,30/2,50 · gemini-3.8-flash 0,75/3,75 · gemini-4-argon 2/10 (dobra em 2026-12-01).

> Os blocos F.6 (OpenAI + Gemini) e F.7 (Vercel AI SDK) abaixo trazem os snippets verificados. Onde eles propõem um contrato, vale o de **F.2**.

### F.6 — Provedores LLM alternativos: OpenAI e Google Gemini

> Pesquisa de 2026-10-15. Contexto: backend Node 22 LTS, ESM, TypeScript, zod 4.6.5. Cada agente de IA do CRM
> escolhe provedor (Anthropic | OpenAI | Gemini). Este arquivo cobre só OpenAI e Gemini.
>
> Fontes verificadas nesta sessão:
> - npm registry (`/latest`, `dist-tags`, `time`, `engines`, `peerDependencies`) — consultado em 2026-10-15.
> - Tarball `openai@7.34.0` (lido via stream: `src/resources/shared.ts`, `src/helpers/zod.ts`, `src/resources/responses/responses.ts`, `package.json`, `README.md`) e `CHANGELOG.md` do repo openai-node.
> - context7: `/websites/developers_openai_api` (docs oficiais OpenAI, sem versão fixa — refletem a API atual) e `/googleapis/js-genai` (repo oficial; context7 só indexa a tag `v2.0.1`, a busca default retorna `main`).
> - Páginas oficiais: developers.openai.com/api/docs/pricing e /models; ai.google.dev/gemini-api/docs/{pricing,models,models/gemini-4-argon,thinking,audio,migrate-to-interactions}; CHANGELOG do js-genai.

---

#### 1. `openai` (SDK oficial Node/TS)

| Item | Valor verificado |
|---|---|
| Versão | **`openai@7.34.0`** (publicada 2026-10-14) |
| engines | `node >=22.0.0` (desde 7.0.0, 2026-07-27: "require Node.js 22" é o único breaking change da major 7) |
| peerDependencies (todas opcionais) | `zod ^3.25 \|\| ^4.0`, `ws ^8.21.0`, `undici >=5 <9`, deps AWS/smithy (Bedrock) |
| Breaking da 6.0.0 | `function_call_output.output` agora é `string \| Array<input_text\|input_image\|input_file>` (não só string) |
| dist-tags enganosas | `next=4.0.0-beta.12`, `beta=5.0.0-beta.0` são lixo antigo — **sempre instale `latest`** |

Pin sugerido: `"openai": "7.34.0"` (exato, como o resto do monorepo).

##### 1.1 Responses API (API recomendada)

- `client.responses.create({ model, instructions, input, tools, text, stream, store, previous_response_id, reasoning, include })`.
- `instructions` = system prompt (não persiste entre turnos com `previous_response_id`; reenviar sempre).
- `input`: string **ou** array de itens (`{role:'user'|'assistant'|'system'|'developer', content}`, `function_call`, `function_call_output`, `reasoning`...).
- `response.output_text` é o atalho de texto; `response.output[]` é a lista tipada de itens.

```ts
import OpenAI from 'openai';
const client = new OpenAI(); // lê OPENAI_API_KEY
const r = await client.responses.create({
  model: 'gpt-6-luna',
  instructions: 'Você é a atendente da loja X. Responda em pt-BR.',
  input: [{ role: 'user', content: 'Qual o horário?' }],
  store: false,
});
console.log(r.output_text, r.usage);
```

**Estado: `previous_response_id` vs stateless** (context7, guia deployment-checklist + your-data):
- `store` default = `true` → resposta guardada **≥30 dias** na OpenAI; aí dá pra encadear com `previous_response_id` (ou Conversations API).
- `store: false` → stateless; você reenvia o histórico. Para modelos de raciocínio, itens `reasoning` vêm com `encrypted_content` e **devem ser devolvidos exatamente como vieram** (ou use `include: ['reasoning.encrypted_content']`). Org em ZDR força `store=false`.
- Helper oficial: `toResponseInputItems(output)` de `openai/lib/responses/ResponseInputItems` — normaliza todos os itens replayáveis. **Não filtre `output` só para mensagens**: perder itens `reasoning`/`function_call` quebra a próxima requisição (README do SDK).
- `reasoning.context: 'current_turn' | 'all_turns' | 'auto'` (GPT-6+) controla reaproveitamento de raciocínio entre turnos.

```ts
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
const history: any[] = [{ role: 'user', content: msg }];
const first = await client.responses.create({ model, store: false, input: history });
history.push(...toResponseInputItems(first.output));
history.push({ role: 'user', content: proximaMsg });
```

**Recomendação para o CRM:** a fonte da verdade do histórico é o nosso Postgres (mensagens WhatsApp). Usar `store: false` + histórico reconstruído (janela das últimas N mensagens) — independente de provedor, sem dados retidos na OpenAI, e permite trocar de modelo/provedor no meio da conversa. `previous_response_id` só se quisermos economizar banda em loops de tool calling dentro de um mesmo turno.

##### 1.2 Function calling no Responses

Formato de tool é **achatado** (diferente de Chat Completions, que usa `{type:'function', function:{...}}`):

```ts
const tools = [{
  type: 'function' as const, name: 'agendar_visita', strict: true,
  description: 'Agenda visita do lead',
  parameters: { type: 'object', properties: { data: { type: 'string' } },
                required: ['data'], additionalProperties: false },
}];
```

Loop: o modelo devolve itens `{type:'function_call', call_id, name, arguments /* string JSON */}` em `output`; você executa e devolve `{type:'function_call_output', call_id, output}` no próximo `input` (junto com os itens anteriores, ou via `previous_response_id`).

```ts
let input = [...history];
for (let i = 0; i < 8; i++) {
  const r = await client.responses.create({ model, tools, input, store: false });
  const calls = r.output.filter((o) => o.type === 'function_call');
  if (!calls.length) return r.output_text;
  input.push(...toResponseInputItems(r.output));
  for (const c of calls) input.push({ type: 'function_call_output', call_id: c.call_id,
    output: JSON.stringify(await runTool(c.name, JSON.parse(c.arguments))) });
}
```

- `strict: true` exige `additionalProperties: false` e **todos** os campos em `required` (opcional = `nullable`).
- Responder **todos** os `call_id` pendentes antes de continuar (chamadas paralelas vêm juntas; `parallel_tool_calls` default `true`).
- `output` aceita string ou array de conteúdo (`input_text`/`input_image`/`input_file`) desde 6.0.
- Itens novos em 7.x: `function_call.async`, `namespace`, `caller` — ignore por ora.
- Helpers zod: `zodResponsesFunction({ name, parameters, function })` (em `openai/helpers/zod`) e `responses-tool-runner` (runner com checkpoint/ledger, novo e ainda pouco documentado — **não usar no v1**; o loop manual acima é simples e portável entre provedores).

##### 1.3 Structured outputs + zod 4

`openai/helpers/zod` importa `zod/v3`, `zod/v4` e `zod/v4-mini` (verificado no tarball) → **compatível com zod 4.6.5** (o próprio repo bumpou para zod 4.6.5; changelog tem fixes "preserve strict schema compatibility with Zod 4.5.4"). Também há suporte a Standard Schema desde 6.49.

```ts
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
const Lead = z.object({ intencao: z.enum(['compra','duvida','suporte']), nome: z.string().nullable() });
const r = await client.responses.parse({
  model: 'gpt-6-luna', input: [{ role: 'user', content: texto }],
  text: { format: zodTextFormat(Lead, 'lead') },
});
const lead = r.output_parsed; // tipado; null se recusa
```

- Sem helper: `text: { format: { type: 'json_schema', name, schema, strict: true } }`.
- Opcionais: use `.nullable()`, **não** `.optional()` (o helper avisa/erra em optional sem nullable). Só schemas "JSON-native" (sem `z.date()`, transforms etc.).
- Checar recusa: item de conteúdo `type: 'refusal'`.

##### 1.4 Streaming

```ts
const stream = await client.responses.create({ model, input, stream: true });
for await (const ev of stream) {
  if (ev.type === 'response.output_text.delta') push(ev.delta);
  if (ev.type === 'response.completed') saveUsage(ev.response.usage);
}
```

Sequência de eventos (docs): `response.created` → `response.in_progress` → `response.output_item.added` → `response.content_part.added` → `response.output_text.delta`* → `response.output_text.done` → `response.content_part.done` → `response.output_item.done` → `response.completed` (também `response.failed`, `response.incomplete`, `response.function_call_arguments.delta/done`). Cada evento tem `sequence_number`.
Helper: `client.responses.stream(params)` (existe em `responses.ts` 7.34.0) com acumulação e `finalResponse()`.
Para WhatsApp não precisamos de streaming token a token (mensagem vai inteira); útil só para o "playground" do agente no dashboard via SSE.

##### 1.5 Usage (para billing/custos)

`response.usage` = `{ input_tokens, input_tokens_details: { cached_tokens, cache_write_tokens }, output_tokens, output_tokens_details: { reasoning_tokens }, total_tokens }`.
- `reasoning_tokens` **já estão incluídos** em `output_tokens` (cobrados como output).
- `cache_write_tokens` é campo novo (2026); `cached_tokens` é cobrado com o desconto de "cached input".
- Prompt caching é automático (prefixo ≥ ~1024 tokens) — mantenha `instructions` + tools estáveis no início para aproveitar. Opcional `prompt_cache_key` por agente.

##### 1.6 Modelos atuais (verificado em developers.openai.com/api/docs/models + `shared.ts` do SDK)

| Modelo | Uso | Contexto | Obs |
|---|---|---|---|
| `gpt-6-astra` | flagship, raciocínio/código | 1.05M | caro |
| `gpt-6.1-sol` | "quase Astra" mais barato | 1.05M | **bom default de qualidade** |
| `gpt-6-sol` | geração anterior do Sol | 1.05M | |
| `gpt-6-luna` | mais eficiente, alto volume | 1.05M | `reasoning.effort: 'none'` suportado → **default para atendimento** |
| `gpt-5.6-sol/terra/luna`, `gpt-5.5`, `gpt-5.4(-mini/-nano)` | gerações anteriores, ainda servidas | | |

Todos os GPT-6 são modelos de raciocínio (`reasoning: { effort }`). Alguns (`gpt-5.5-pro`, `*-deep-research`, `gpt-5.1-codex-max`) são **Responses-only**. O tipo `ChatModel` no SDK lista as datas de shutdown (ex.: `gpt-3.5-turbo-1106` em 2026-09-28) — modelo é `string`, então guarde o id em config/DB, não em enum.

##### 1.7 Chat Completions ainda existe?

Sim: README do SDK 7.34.0 — "The previous standard (supported indefinitely) for generating text is the Chat Completions API". Mas features novas (reasoning encrypted, tools hospedadas, compaction) são Responses-first. **Assistants API foi desligada em 2026-08-26** (não usar). Decisão: **usar só Responses API**.

##### 1.8 Armadilhas OpenAI

1. `openai@7` exige Node ≥22 — ok para nosso alvo, mas imagens Docker `node:20` quebram.
2. Formato de tools difere entre Chat Completions e Responses (achatado). Não misturar exemplos antigos.
3. `store` default é `true` (retenção 30d). Setar `store: false` explicitamente (LGPD).
4. Ao montar histórico manual, reinserir **todos** os itens de `output` (reasoning + function_call), não só mensagens.
5. `arguments` é string JSON — validar com zod antes de executar (mesmo com `strict`).
6. Structured outputs: `.optional()` → use `.nullable()`; recusa vem como `refusal`, `output_parsed` pode ser `null`.
7. Custo de raciocínio: `reasoning_tokens` contam como output; para respostas curtas de atendimento use `effort` baixo/`none`.
8. Data residency regional (7.34.0) tem +10% de preço para modelos lançados após 2026-03-05.

---

#### 2. `@google/genai` (SDK unificado Gemini/Vertex)

| Item | Valor verificado |
|---|---|
| Versão | **`@google/genai@2.30.0`** (publicada 2026-10-15 00:06Z) |
| engines | `node >=20.0.0` |
| peer opcional | `@modelcontextprotocol/sdk ^1.25.2` (só para `mcpToTool`) |
| Major 2.0.0 (2026-05-07) | breaking **só na Interactions API**; `generateContent` não mudou |
| SDK antigo | `@google/generative-ai@0.24.1` — repo renomeado `deprecated-generative-ai-js`, "legacy", só bugfix crítico. **Não usar.** (npm não marca `deprecated`, cuidado com autocomplete.) |

Pin sugerido: `"@google/genai": "2.30.0"`. context7 só tem docs da tag `v2.0.1`; as APIs de `models.*` abaixo não mudaram desde então (changelog), mas a Interactions API mudou bastante.

##### 2.1 Duas APIs no mesmo SDK — escolha

- **`ai.models.generateContent` / `generateContentStream`** — API clássica (stateless, `contents`/`parts`). Docs de migração: "While `generateContent` remains fully supported, we recommend the Interactions API for all new development."
- **`ai.interactions.create`** — API nova estilo "Responses" (`input`, `previous_interaction_id`, `store` default **true**, `response_format`, `usage.prompt_tokens/completion_tokens`). Teve breaking changes em mai/2026 e as docs oficiais (function calling, áudio) agora só mostram ela.

**Recomendação:** usar **`generateContent`** no v1 — estável há mais tempo, sem estado no servidor (mesma filosofia do `store:false` da OpenAI), mapeia 1:1 para nosso histórico. Reavaliar Interactions quando estabilizar. (Ponto de atenção: tutoriais novos do Google vão mostrar Interactions.)

##### 2.2 Init

```ts
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });            // Gemini Developer API
const vx = new GoogleGenAI({ vertexai: true, project: 'proj', location: 'us-central1' }); // Vertex (ADC)
```

Gemini API (API key, AI Studio) é o caminho simples para multi-tenant com chave por cliente. Vertex exige service account/ADC.

##### 2.3 generateContent, systemInstruction, papéis

```ts
const r = await ai.models.generateContent({
  model: 'gemini-3.5-flash-lite',
  contents: [
    { role: 'user', parts: [{ text: 'Oi' }] },
    { role: 'model', parts: [{ text: 'Olá! Como posso ajudar?' }] },
    { role: 'user', parts: [{ text: 'Qual o horário?' }] },
  ],
  config: { systemInstruction: 'Você é a atendente da loja X.', maxOutputTokens: 512 },
});
console.log(r.text, r.usageMetadata);
```

- Papéis são **`'user'` e `'model'`** (não `assistant`). System vai em `config.systemInstruction`, não em `contents`.
- Tudo que não é `model`/`contents` vai dentro de `config` (temperature, tools, toolConfig, responseMimeType, thinkingConfig, abortSignal...).
- `r.text` concatena partes de texto e ignora `thought`; `r.functionCalls` atalho para chamadas.
- Streaming: `for await (const chunk of await ai.models.generateContentStream({...})) chunk.text` — o último chunk traz `usageMetadata`.

##### 2.4 Function calling

```ts
const decl = { name: 'agendar_visita', description: 'Agenda visita do lead',
  parametersJsonSchema: z.toJSONSchema(AgendarArgs) }; // zod 4 nativo
let r = await ai.models.generateContent({ model, contents,
  config: { systemInstruction, tools: [{ functionDeclarations: [decl] }] } });
while (r.functionCalls?.length) {
  contents.push(r.candidates![0].content!); // conteúdo do modelo VERBATIM
  const parts = await Promise.all(r.functionCalls.map(async (fc) => ({ functionResponse:
    { id: fc.id, name: fc.name!, response: { result: await runTool(fc.name!, fc.args) } } })));
  contents.push({ role: 'user', parts });
  r = await ai.models.generateContent({ model, contents, config });
}
```

- `parametersJsonSchema` (JSON Schema padrão) vs `parameters` (`Schema` OpenAPI-subset com `Type.OBJECT` etc.). **Use `parametersJsonSchema`** — o README atual usa ele e casa com `z.toJSONSchema()` do zod 4. Não preencha os dois.
- `functionResponse.response` deve ser **objeto** (`Record<string, unknown>`), não string — embrulhe em `{ result }`/`{ error }`. Helper: `createPartFromFunctionResponse(id, name, response)`.
- `toolConfig.functionCallingConfig.mode`: `AUTO` (default) | `ANY` (força chamada, com `allowedFunctionNames`) | `NONE`.
- **Thought signatures:** em `generateContent` com modelos que pensam (3.x/4), partes `functionCall` podem carregar `thoughtSignature`. Reenvie o `Content` do modelo **exatamente como veio** (como no snippet). Se reconstruir a partir do nosso DB, persista `thoughtSignature` junto com a tool call ou perca continuidade de raciocínio (a doc de thinking: "You must resend all thought blocks exactly as received... also applies when switching models"). Consequência exata de omitir (erro 400 vs degradação) **não confirmada nesta sessão**.
- Automatic function calling (AFC) existe em JS via `CallableTool` (ex.: `mcpToTool`) e `config.automaticFunctionCalling`; o loop fica dentro do SDK e retorna `automaticFunctionCallingHistory`. **Não usar**: precisamos de controle (logs, rate limit, aprovações, idempotência via BullMQ) — mesmo loop manual nos 3 provedores.

##### 2.5 Structured output

```ts
const r = await ai.models.generateContent({ model, contents,
  config: { responseMimeType: 'application/json', responseJsonSchema: z.toJSONSchema(Lead) } });
const lead = Lead.parse(JSON.parse(r.text!));
```

- `responseJsonSchema` (JSON Schema) é o preferido; `responseSchema` é o formato antigo `Schema`. Objeto vazio (`Type.OBJECT` sem `properties`) é rejeitado.
- Sem helper zod oficial no SDK → `z.toJSONSchema()` + `Schema.parse()` na saída (validação é nossa).
- Dá para combinar com tools em modelos 3.x, mas mantenha simples: classificação estruturada em chamada separada.

##### 2.6 Usage, countTokens, thinking

- `r.usageMetadata`: `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `cachedContentTokenCount`, `toolUsePromptTokenCount`, `totalTokenCount`, `promptTokensDetails[]` (por modalidade — áudio é cobrado diferente em alguns modelos).
- **Custo de output = `candidatesTokenCount + thoughtsTokenCount`** (pricing: "Output (including thinking)"). Diferente da OpenAI, onde reasoning já está dentro de `output_tokens`.
- `await ai.models.countTokens({ model, contents })` → `{ totalTokens }` (útil para cortar histórico antes de chamar).
- Thinking (modelos 3.x/4): `config.thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: false }`. Níveis por modelo (docs/thinking): `gemini-4-argon` e `gemini-3.8-flash` = low/medium/high (default medium); `gemini-3.6-flash` minimal..high (default medium); `gemini-3.5-flash-lite` minimal..high (default **minimal**); `gemini-3.1-pro-preview` low/medium/high (default high). A doc lista níveis em snake_case da Interactions API; no SDK `generateContent` o campo é `thinkingLevel` com valores `'LOW'`/`'HIGH'` etc. (exemplo do codegen_instructions do js-genai). `thinkingBudget` (estilo 2.5) não aparece mais na doc de thinking — evite para 3.x+.
- Caching implícito automático; caching explícito (`ai.caches.create`) tem **custo de armazenamento por hora** — não usar no v1.

##### 2.7 Modelos atuais (ai.google.dev/gemini-api/docs/models, 2026-10-15)

| Modelo | Status | Uso sugerido |
|---|---|---|
| `gemini-4-argon` | estável, 1M ctx, entrada texto/imagem/vídeo/**áudio**/PDF | qualidade máxima |
| `gemini-3.8-flash` | estável (novo) | **default qualidade/custo** |
| `gemini-3.6-flash` | estável | |
| `gemini-3.5-flash-lite` | estável | **default barato/alto volume** |
| `gemini-3.1-flash-lite` | estável | |
| `gemini-3.1-pro-preview`, `gemini-3-flash-preview` | preview | evitar em produção |
| `gemini-2.5-pro/flash/flash-lite` | servidos só para quem já usava | não usar em projeto novo |
| `gemini-3-pro-preview`, `gemini-2.0-flash(-lite)`, `gemini-3.1-flash-lite-preview` | **desligados** | — |
| `gemini-3.5-transcribe` | estável, STT dedicado | ver 2.8 |
| `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts` | estável, TTS | candidato no doc de TTS |

Alias `gemini-flash-latest` aponta para o Flash mais novo (troca com aviso de 2 semanas) — **não usar em produção**, fixe o id.

##### 2.8 Áudio de entrada (STT) — nota

Sim, Gemini transcreve: áudio como `inlineData` (base64, request total ≤ **20 MB**) ou Files API (maior/reuso); MIME suportados incluem `audio/ogg` e `audio/opus` (formato do PTT do WhatsApp) — não precisa transcodificar. 32 tokens/s de áudio, até 9,5 h por prompt. Há ainda o modelo dedicado `gemini-3.5-transcribe` ($0.003/min entrada + ~$0.002/min texto). Comparar com OpenAI `gpt-transcribe` ($0.0045/min) / `gpt-4o-mini-transcribe` ($0.003/min) no doc de STT. Vantagem do Gemini multimodal: pode-se mandar o áudio direto para o agente (sem passo de STT) — porém perdemos o texto transcrito para histórico/busca; recomendação continua sendo STT explícito.

##### 2.9 Armadilhas Gemini

1. Pacote errado: `@google/generative-ai` (legado) vs `@google/genai` (atual). APIs diferentes (`getGenerativeModel` é do legado).
2. Papel `'model'`, não `'assistant'`; `systemInstruction` em `config`.
3. Parâmetros dentro de `config` — `tools`/`responseMimeType` no nível raiz são ignorados/erro de tipo.
4. `functionResponse.response` precisa ser objeto; `id` deve casar com `functionCall.id`.
5. Preservar `thoughtSignature` ao reenviar histórico com tool calls (3.x/4).
6. `thoughtsTokenCount` é cobrado à parte do `candidatesTokenCount` — somar nos custos.
7. Preços de vários 3.x **dobram em 2027-01-01** e `gemini-4-argon` dobra em **2026-12-01** — guardar preço por modelo em tabela configurável, não hardcode.
8. Interactions API tem `store: true` por padrão (estado no servidor Google) — se adotada no futuro, setar `store: false`.
9. Preview models são desligados sem muito aviso (ex.: `gemini-3-pro-preview` já desligado).
10. context7 indexa só `v2.0.1` do js-genai; para features de 2.x recente, conferir CHANGELOG.

---

#### 3. Preços (USD por 1M tokens, tier Standard/pago, texto)

Verificado nas páginas oficiais em 2026-10-15. Sujeito a mudança — manter tabela `llm_model_prices` no DB.

##### OpenAI (developers.openai.com/api/docs/pricing; contexto curto ≤272K)

| Modelo | Input | Cached input | Output |
|---|---|---|---|
| gpt-6-astra | 10.00 | 1.00 | 50.00 |
| gpt-6.1-sol | 2.00 | 0.10 | 10.00 |
| gpt-6-sol | 2.00 | 0.20 | 10.00 |
| gpt-6-luna | 0.10 | 0.01 | 0.50 |
| gpt-5.6-sol | 4.00 | 0.40 | 20.00 |
| gpt-5.6-terra | 2.00 | 0.20 | 12.00 |
| gpt-5.6-luna | 0.20 | 0.02 | 1.20 |
| gpt-5.5 | 5.00 | 0.50 | 30.00 |
| gpt-5.4 | 2.50 | 0.25 | 15.00 |
| gpt-5.4-mini | 0.75 | 0.075 | 4.50 |
| gpt-5.4-nano | 0.20 | 0.02 | 1.25 |

Acima de 272K de input há tarifa long-context (mais cara, não listada aqui). Batch/Flex mais baratos; regional +10%.

##### Gemini (ai.google.dev/gemini-api/docs/pricing; "Output" inclui thinking)

| Modelo | Input | Cached | Output | Obs |
|---|---|---|---|---|
| gemini-4-argon | 2.00 → **4.00 a partir de 2026-12-01** | 0.10 → 0.20 | 10.00 → 20.00 | só cache implícito |
| gemini-3.8-flash | 0.75 (1.50 em 2027) | 0.075 | 3.75 (7.50 em 2027) | |
| gemini-3.6-flash | 0.75 (1.50 em 2027) | 0.075 | 3.75 (7.50 em 2027) | |
| gemini-3.5-flash-lite | 0.30 (qualquer modalidade) | 0.03 | 2.50 | |
| gemini-3.1-flash-lite | 0.25 (áudio 0.50) | 0.025 | 1.50 | |
| gemini-3.1-pro-preview | 2.00 (>200k: 4.00) | 0.20 | 12.00 (>200k: 18.00) | preview |
| gemini-2.5-pro | 1.25 (>200k: 2.50) | 0.125 | 10.00 (>200k: 15.00) | legado |
| gemini-2.5-flash | 0.30 (áudio 1.00) | 0.03 | 2.50 | legado |
| gemini-2.5-flash-lite | 0.10 (áudio 0.30) | 0.01 | 0.40 | legado |

##### Defaults sugeridos por papel de agente (custo × qualidade)

| Papel | OpenAI | Gemini |
|---|---|---|
| Atendimento alto volume / classificação | `gpt-6-luna` (effort none/low) | `gemini-3.5-flash-lite` (thinking minimal) |
| SDR/vendas com tools | `gpt-6.1-sol` | `gemini-3.8-flash` |
| Raciocínio pesado (raro) | `gpt-6-astra` | `gemini-4-argon` |

---

#### 4. Implicação para a camada `LlmProvider` do CRM (não é código, é contrato)

Normalizar os 3 provedores para um formato interno único:
- Mensagens: `{ role: 'user'|'assistant', parts: (text | image | audio | toolCall{id,name,args,providerMeta} | toolResult{id,name,result}) }` + `system` separado. `providerMeta` guarda itens opacos (OpenAI `reasoning.encrypted_content`, Gemini `thoughtSignature`) para replay fiel.
- Tools: definir uma vez em zod 4 → OpenAI `parameters` (strict, nullable em vez de optional), Gemini `parametersJsonSchema` via `z.toJSONSchema`, Anthropic `input_schema`.
- Usage normalizado: `{ inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, reasoningTokens }` com regra de custo por provedor (OpenAI: reasoning ⊂ output; Gemini: output = candidates + thoughts).
- Sem estado no provedor: OpenAI `store:false`, Gemini `generateContent`; histórico vem do nosso Postgres.
- Loop de tools manual, limite de iterações (ex.: 8), idempotência por `call_id`.

### F.7 — Camada de LLM: Vercel AI SDK vs. adapters próprios

> Pesquisa de 2026-10-15. Versões confirmadas em `https://registry.npmjs.org/<pkg>/latest`.
> Docs consultadas no context7 (`/websites/ai-sdk_dev`, que reflete o AI SDK 7) e na página
> oficial `ai-sdk.dev/docs/migration-guides/migration-guide-7-0`.
> Contexto: backend Node 22 + TypeScript (Hono, workers BullMQ, zod 4.6.5). Cada agente de IA é
> configurado por empresa com provedor (Anthropic / OpenAI / Google) e modelo, usa tools de CRM,
> às vezes saída estruturada (classificação), precisa de contabilidade de tokens/custo por
> empresa e limites, e roda em jobs de background (quase nada de streaming para UI).

---

#### 1. Versões (npm `latest` em 2026-10-15)

| Pacote | Versão | Peer / engines | Observação |
|---|---|---|---|
| `ai` | **7.0.142** | peer `zod ^3.25.76 \|\| ^4.1.8`; `node >=22`; **ESM-only** (`"type":"module"`) | dist-tags: `ai-v6` = 6.0.308, `ai-v5` = 5.0.277. A v7.0.0 saiu em 2026-06-25 |
| `@ai-sdk/anthropic` | **4.0.81** | mesmo peer zod; `node >=22` | depende de `@ai-sdk/provider 4.0.28` |
| `@ai-sdk/openai` | **4.0.95** | idem | idem |
| `@ai-sdk/google` | **4.0.98** | idem | idem |
| `@ai-sdk/provider` | 4.0.28 | — | especificação `LanguageModelV4` |
| `@ai-sdk/provider-utils` | 5.0.61 | zod peer | puxa `undici ^7`, `eventsource-parser`, `@standard-schema/spec` |
| `@ai-sdk/gateway` | 4.0.115 | — | **dependência direta de `ai`** (Vercel AI Gateway) |
| `@ai-sdk/otel` | 1.0.142 | depende de `ai 7.0.142` exato | telemetria OpenTelemetry (movida para pacote próprio na v7) |
| `@anthropic-ai/sdk` | 0.135.0 (ai-manager usa **0.128.0**) | peer `zod ^3.25 \|\| ^4` | SDK oficial |
| `openai` | 7.34.0 | peer `zod ^3.25 \|\| ^4`, `ws`, `undici`; `node >=22` | SDK oficial |
| `@google/genai` | 2.30.0 | `node >=20` | SDK oficial Gemini |

**Compatibilidade zod 4.6.5:** OK em todos (`^4.1.8` no AI SDK; `^4.0.0` nos SDKs oficiais).
**Node 22:** obrigatório para `ai@7`, providers `@ai-sdk/*@4` e `openai@7` — bate com o nosso alvo.

Regra de ouro de versão: **`ai@7.x` só com `@ai-sdk/*@4.x`** (todos dependem de
`@ai-sdk/provider 4.0.28` / `LanguageModelV4`). Misturar `@ai-sdk/anthropic@3` (v6, `LanguageModelV3`)
com `ai@7` ou vice-versa dá erro de tipo/“unsupported specification version”. Fixe tudo pelo lockfile
e atualize em bloco.

---

#### 2. Interface de referência no ai-manager (`packages/core/src/ai/provider.ts`, somente leitura)

Resumo do que existe hoje (usa `@anthropic-ai/sdk` 0.128.0 direto):

- `AiGenerateRequest { model: string; maxTokens: number; text: string; signal?: AbortSignal }`
- `interface AiProvider { generate(req): Promise<Classification> }` — **um único caso de uso**:
  classificar a mensagem recebida (`intent` ∈ `AI_INTENTS`, `confidence` 0..1) e sugerir `text`
  para um humano revisar.
- `AnthropicProvider` usa `client.messages.parse({ ..., output_config: { format: zodOutputFormat(Schema) } }, { signal })`
  (helper `@anthropic-ai/sdk/helpers/zod`); trata `stop_reason === 'refusal'` e `'max_tokens'` como erro;
  `maxRetries` default **0** (o timeout do `AiAssistant` é o limite total).
- Prompt de sistema fixo, mensagem do cliente envelopada em `<mensagem>…</mensagem>` (mitigação de
  prompt injection).
- `createAiProvider(apiKey)` → `undefined` sem chave (cai no fallback por regras).
- Testes nunca chamam a API: injetam um `AiProvider` fake.

Consequência: a interface do ai-manager é **estreita e orientada a caso de uso**, não um wrapper
genérico de LLM. Não há tools, multi-step, nem contabilidade de tokens. O clone precisa de bem mais
(tools de CRM, multi-provedor, usage/custo por empresa) — mas deve **manter a mesma ideia**: uma porta
injetável no core, com implementações trocáveis e fakes nos testes.

---

#### 3. AI SDK 7 — APIs que usaríamos (snippets verificados)

##### 3.1 Tools + multi-step (`tool`, `inputSchema`, `stopWhen: isStepCount`)

```ts
import { generateText, tool, isStepCount } from 'ai'
const r = await generateText({
  model, instructions: systemPrompt, messages,           // v7: `instructions` (antes `system`)
  tools: { moverLead: tool({ description: 'Move o lead de etapa',
    inputSchema: z.object({ leadId: z.string(), etapaId: z.string() }),
    execute: async ({ leadId, etapaId }, { context }) => crm.mover(context.empresaId, leadId, etapaId) }) },
  stopWhen: isStepCount(5),                               // v7: renomeado de stepCountIs
})
```
- Default de `stopWhen` é `isStepCount(1)`: sem configurar, o modelo chama a tool e **para** sem
  responder com o resultado.
- v7: contexto por tool tipado com `contextSchema` + `toolsContext: { moverLead: { empresaId } }`;
  contexto geral em `runtimeContext` (substitui `experimental_context`). Ótimo para multi-tenant.
- Callbacks: `onStart`, `onStepStart`, `onStepEnd` (antes `onStepFinish`), `onEnd` (antes `onFinish`),
  `onToolExecutionStart/End`. `prepareStep` (não é mais experimental) permite trocar modelo/tools/mensagens
  a cada passo.
- Aprovação humana de tool: `toolApproval` na chamada/agente (`needsApproval` no `tool()` está deprecated).
- Também existe `ToolLoopAgent` (classe de agente com o mesmo loop).

##### 3.2 Saída estruturada — `generateObject` está **deprecated**

```ts
import { generateText, Output, NoObjectGeneratedError } from 'ai'
const { output } = await generateText({
  model, instructions,
  output: Output.object({ schema: z.object({ intent: z.enum(INTENTS), confidence: z.number() }) }),
  prompt: `<mensagem>\n${texto}\n</mensagem>`,
})
```
- Docs da v7: “`generateObject` and `streamObject` are deprecated. Use `generateText` and `streamText`
  with the `output` property instead.” (ainda existem, mas não usar em código novo).
- v6 tinha `experimental_output`/`result.experimental_output` → **removidos** na v7 (`output`).
- Saída estruturada **conta como um step**: com tools, use `isStepCount(n + 1)`.
- Falha de parse/validação → `NoObjectGeneratedError` (tem `.text`, `.cause`, `.usage`).

##### 3.3 Usage (contabilidade de tokens) — mudou na v7

```ts
const { usage, finalStep } = await generateText({ ... })
usage.inputTokens; usage.outputTokens; usage.totalTokens            // SOMA de todos os steps (v7)
usage.inputTokenDetails.cacheReadTokens; usage.inputTokenDetails.cacheWriteTokens; usage.inputTokenDetails.noCacheTokens
usage.outputTokenDetails.reasoningTokens; usage.outputTokenDetails.textTokens
finalStep.usage                                                      // só o último step
```
- v7: `usage` agora = total de todos os steps (o que era `totalUsage`); `totalUsage` deprecated.
- v7: **removidos** `usage.cachedInputTokens` e `usage.reasoningTokens` (v5/v6) → usar
  `inputTokenDetails.cacheReadTokens` / `outputTokenDetails.reasoningTokens`.
- Anthropic: `providerMetadata.anthropic.cacheCreationInputTokens` removido → `inputTokenDetails.cacheWriteTokens`;
  payload cru em `finalStep.providerMetadata.anthropic.usage`. Também há `usage.raw`.
- Todos os campos podem ser `undefined` (provedor não informa) — o cálculo de custo deve tratar.
- Custo em R$/US$ **não** vem do SDK: precisamos de tabela própria de preço por modelo (input,
  output, cache read, cache write) de qualquer jeito.
- `onStepEnd(step)` dá `step.usage` e `step.performance` (latência, tokens/s) — bom para gravar por step.

##### 3.4 providerOptions / reasoning

```ts
// Anthropic: cache control por parte de mensagem (ttl opcional '1h')
{ type: 'text', text: promptLongo, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
// OpenAI: openai(model) usa a Responses API por padrão (desde v5); openai.chat(model) = Chat Completions
providerOptions: { openai: { store: false, parallelToolCalls: false, user: empresaId } }
// Reasoning portável (v7): opção top-level
reasoning: 'low'   // providerOptions de reasoning (openai.reasoningEffort, google.thinkingConfig.thinkingLevel) VENCEM e não fazem merge
providerOptions: { google: { thinkingConfig: { includeThoughts: true } } }
```
- Responses API: `store` default `true` — para dados de clientes de WhatsApp, setar `store: false`.
- v7 OpenAI: `reasoningSummary` passa a `'detailed'` quando reasoning está ligado (setar `null` para desligar).
- Modelos GPT-6+ ignoram `temperature`/`topP` (o provider remove e emite warning).
- Google v7: `createGoogleGenerativeAI` → `createGoogle` (nome antigo vira alias deprecated).

##### 3.5 Registry de provedores (string `'anthropic:claude-sonnet-5-5'`)

```ts
import { createProviderRegistry, customProvider } from 'ai'
const registry = createProviderRegistry({
  anthropic: createAnthropic({ apiKey }), openai: createOpenAI({ apiKey }), google: createGoogle({ apiKey }),
})                                                // separador default ':' (configurável)
const model = registry.languageModel(`${agente.provider}:${agente.model}`)
```
- `customProvider` (v7; `experimental_customProvider` removido) cria aliases (`'rapido'`, `'barato'`)
  com `fallbackProvider`.
- **Armadilha:** chaves de API **por empresa** (BYOK) não cabem num registry global — teria de criar
  provider por requisição (`createAnthropic({ apiKey })` é barato) ou cachear por empresa.
- **Armadilha grave:** passar `model` como **string pura** (`model: 'anthropic/claude-sonnet-5.5'`)
  roteia pelo **Vercel AI Gateway** (`@ai-sdk/gateway`, dependência direta de `ai`), exigindo chave do
  Gateway e mandando tráfego à Vercel. Sempre passe a instância do provider ou `registry.languageModel()`.

##### 3.6 Middleware (`wrapLanguageModel`) — logging/limites

```ts
import type { LanguageModelV4Middleware } from '@ai-sdk/provider'
const limites: LanguageModelV4Middleware = {
  specificationVersion: 'v4',
  wrapGenerate: async ({ doGenerate, params, model }) => {
    await cota.verificar(/* empresa via providerOptions/headers */); const r = await doGenerate()
    await cota.debitar(r.usage); return r },
}
const m = wrapLanguageModel({ model: base, middleware: [limites, log] })
```
- `specificationVersion` **deve** ser `'v4'` no `ai@7` (era `'v2'` na v5, `'v3'` na v6). Middleware de
  versão anterior quebra.
- No middleware, `r.usage` está no formato **do spec** (`inputTokens: { total, noCache, cacheRead, cacheWrite }`,
  `outputTokens: { total, text, reasoning }`), diferente do `usage` achatado do resultado de `generateText`.
- O middleware não recebe o `runtimeContext`; para saber a empresa, prefira debitar no `onStepEnd`/`onEnd`
  (que têm `runtimeContext`) e usar o middleware só para logging/guard.

##### 3.7 Erros, retries, abort, timeout

```ts
await generateText({ model, prompt, maxRetries: 0, timeout: 30_000, abortSignal: job.signal })
} catch (e) { if (APICallError.isInstance(e)) e.statusCode, e.isRetryable
             if (RetryError.isInstance(e)) e.lastError /* esgotou retries */ }
```
- `maxRetries` default **2** (retenta 429/529/5xx com backoff). Em worker BullMQ, recomendo
  `maxRetries: 0` e deixar o BullMQ fazer retry com backoff (mesma filosofia do ai-manager).
- Erros úteis: `APICallError` (status, headers, `isRetryable`), `RetryError`, `NoObjectGeneratedError`,
  `NoSuchModelError` (registry), `StreamProviderError` (stream).
- v7: corpos de request/response **não** vêm no resultado por padrão (`include.requestBody/responseBody`).

##### 3.8 Telemetria

- v7 moveu OpenTelemetry para `@ai-sdk/otel`: `registerTelemetry(new OpenTelemetry())`; depois disso a
  telemetria liga sozinha. `experimental_telemetry` → `telemetry` (alias mantido); `isEnabled` desnecessário.
- Para nós (pino, sem OTel no ai-manager): basta `onStepEnd`/`onEnd` + logger. OTel é opcional.

##### 3.9 Testes (vitest)

```ts
import { MockLanguageModelV4 } from 'ai/test'
const model = new MockLanguageModelV4({ doGenerate: [
  { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'moverLead', input: '{"leadId":"1","etapaId":"2"}' }],
    finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [] },
  { content: [{ type: 'text', text: 'Feito' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] } ] })
expect(model.doGenerateCalls).toHaveLength(2)
```
- Nome é versionado (`MockLanguageModelV2` na v5, `V3` na v6, `V4` na v7) — muda a cada major.
- `usage` do mock no formato spec: `{ inputTokens: { total, noCache, cacheRead, cacheWrite }, outputTokens: { total, text, reasoning } }`.
- `finishReason` no spec V4 é objeto `{ unified, raw }`, não string.

---

#### 4. Armadilhas de versão (resumo)

| De → Para | O que quebra |
|---|---|
| v4 → v5 | `parameters` → `inputSchema`; `maxSteps` → `stopWhen: stepCountIs(n)`; `maxTokens` → `maxOutputTokens`; `CoreMessage` → `ModelMessage`; `promptTokens/completionTokens` → `inputTokens/outputTokens`; OpenAI default vira Responses API; spec `LanguageModelV2` |
| v5 → v6 | spec `LanguageModelV3` (providers `@ai-sdk/*@3`); `generateObject` começa a ser substituído por `Output` em `generateText`; `ToolLoopAgent`; middleware `'v3'` |
| v6 → v7 | **Node 22+ e ESM-only**; spec `LanguageModelV4` (providers `@ai-sdk/*@4`, middleware `'v4'`, `MockLanguageModelV4`); `stepCountIs` → `isStepCount`; `system` → `instructions`; mensagens `system` dentro de `messages` **rejeitadas** por padrão (`allowSystemInMessages: true`); `usage` = total de steps, `totalUsage` deprecated; `cachedInputTokens`/`reasoningTokens` removidos; `content/toolCalls/toolResults` agora de todos os steps (`finalStep.*` para o último); `step.response.messages` por step (use `result.responseMessages`); `experimental_output`/`experimental_customProvider`/`experimental_prepareStep`/`experimental_activeTools` removidos; `onFinish`/`onStepFinish` → `onEnd`/`onStepEnd` (aliases); telemetria em `@ai-sdk/otel`; `experimental_context` → `runtimeContext` + `toolsContext`; reasoning top-level `reasoning`; `createGoogleGenerativeAI` → `createGoogle` |

Outras:
- Muito conteúdo na web (e no conhecimento dos modelos) ainda é v4/v5: `maxSteps`, `parameters`,
  `stepCountIs`, `system`, `totalUsage`. Código gerado por IA vai errar — revisar contra docs v7.
- Releases muito frequentes (7.0.0 → 7.0.142 em ~4 meses; v5→v6→v7 em ~11 meses). Planejar upgrade de major
  ~2x/ano, com codemod/skill `migrate-ai-sdk-v6-to-v7`.
- ESM-only: o pacote do backend precisa de `"type": "module"` (ai-manager já é ESM? conferir ao integrar).
- `ai` tem ~8,2 MB desempacotado + `@ai-sdk/gateway`, `@vercel/oidc`, `undici 7`, `@workflow/serde` (via provider-utils).
  Irrelevante para backend, mas é superfície de dependências.

---

#### 5. AI SDK vs. adapters próprios (porta `LlmProvider` fina sobre cada SDK oficial)

| Critério | Vercel AI SDK 7 | Adapters próprios (`@anthropic-ai/sdk`, `openai`, `@google/genai`) |
|---|---|---|
| Multi-provedor (Anthropic/OpenAI/Gemini) | Pronto: mesma API, registry, troca por string | Escrever 3 adapters: mapeamento de mensagens, tools, tool results, stop reasons, usage (≈300–600 linhas + testes) |
| Loop de tools multi-step | Pronto (`stopWhen`, `prepareStep`, `toolsContext`, aprovação) | Escrever o loop (Anthropic tem `toolRunner` beta; OpenAI/Gemini à mão) |
| Saída estruturada | `Output.object` uniforme (zod 4) | Cada SDK tem o seu (`messages.parse`+`zodOutputFormat`, `responses.parse`+`zodTextFormat`, `responseSchema`) |
| Recursos novos específicos do provedor | **Lag** de dias/semanas; alguns só via `providerOptions` ou nunca (ex.: Batch API, Files, Admin/usage API, recursos beta da Anthropic, server tools novas) | Disponível no dia do lançamento |
| Lock-in | Moderado: tipos (`ModelMessage`, `tool()`, `Output`) espalham pelo código se não houver porta própria; majors frequentes com breaking changes | Baixo para o formato de cada provedor; o lock-in é na nossa porta |
| Estabilidade de API | 3 majors em ~15 meses (v5 jul/25, v6 dez/25, v7 jun/26) | SDKs oficiais versionam em 0.x/7.x mas mudam menos a superfície básica |
| Dependências | `ai` + gateway + provider-utils + 3 providers; Node 22+, ESM | 3 SDKs oficiais (o `openai@7` traz peers opcionais de AWS/ws) |
| Testes | `MockLanguageModelV4` em `ai/test`, sequência de respostas, `doGenerateCalls` | Fake da nossa porta (como o ai-manager já faz) — simples, mas o adapter real precisa de testes com HTTP mockado |
| Contabilidade de tokens/custo | Usage normalizado (input/output/cacheRead/cacheWrite/reasoning) e somado por step; custo ainda é nosso | Normalização à mão por provedor (cada um nomeia diferente); custo é nosso igual |
| Limites por empresa | `onStepEnd`/`onEnd` + `runtimeContext`, ou middleware | Na nossa porta, antes/depois de cada chamada |
| Encaixe no ai-manager (usa `@anthropic-ai/sdk` 0.128 direto) | Duas pilhas de LLM no mesmo processo quando plugado; a classificação do ai-manager continuaria no SDK da Anthropic | Mesma pilha; dá até para reaproveitar o `AnthropicProvider` existente atrás da nova porta |
| Streaming para UI | Excelente (não é nosso caso principal) | Manual |

---

#### 6. Recomendação

**Usar o Vercel AI SDK 7 (`ai@7.0.142` + `@ai-sdk/anthropic@4.0.81`, `@ai-sdk/openai@4.0.95`,
`@ai-sdk/google@4.0.98`), mas SEMPRE atrás de uma porta própria no core** — o mesmo padrão do
`AiProvider` do ai-manager, ampliado:

```ts
// esboço de contrato (não é código de app)
interface LlmPort {
  run(req: { empresaId; agenteId; provider: 'anthropic'|'openai'|'google'; model; instructions; messages;
             tools?; output?; maxSteps?; signal? }): Promise<{ text; output?; toolCalls; usage: UsoNormalizado; finishReason }>
}
```

Justificativa:
1. O requisito central — **agente configurável por empresa entre 3 provedores, com tools e saída
   estruturada** — é exatamente o que o AI SDK resolve; escrever 3 adapters + loop de tools é o maior
   custo evitável do módulo de IA.
2. `usage` normalizado (incluindo cache read/write e reasoning, somado por step) simplifica a
   contabilidade por empresa; `runtimeContext`/`toolsContext` encaixam multi-tenant nas tools.
3. Testes: `MockLanguageModelV4` cobre o loop de tools sem rede; acima da porta, os testes de domínio usam
   um fake da porta (como no ai-manager), isolando a churn de majors do AI SDK.
4. A porta própria limita o lock-in: só `packages/core/src/ai/adapters/ai-sdk.ts` importa `ai`. Se uma
   feature exclusiva da Anthropic for necessária (Batch API, betas, server tools), um adapter específico
   com `@anthropic-ai/sdk` implementa a mesma porta.
5. Plug no ai-manager: a extensão usa a própria porta; o `AiProvider` de classificação do ai-manager
   continua intacto. Se quisermos uma pilha só, a porta pode ganhar um adapter `@anthropic-ai/sdk` e o
   ai-manager poderia adotá-la depois — não há conflito de sessões nem de estado.

Regras de uso:
- Fixar versões exatas e atualizar `ai` + `@ai-sdk/*` juntos (mesmo `@ai-sdk/provider`).
- Nunca passar `model` como string solta (vai para o Vercel AI Gateway); usar instâncias
  `createAnthropic/createOpenAI/createGoogle({ apiKey })` por empresa (BYOK) ou registry global.
- `maxRetries: 0` + `timeout`/`abortSignal` no job; retry/backoff fica no BullMQ.
- `providerOptions.openai.store = false` (dados de clientes).
- Saída estruturada via `generateText({ output: Output.object(...) })`; não usar `generateObject`.
- Tabela própria de preços por modelo (input, output, cacheRead, cacheWrite) para custo; gravar
  `usage` por step em `onStepEnd` com `runtimeContext.empresaId`.
- Mensagens do cliente sempre em `messages` com role `user` (v7 rejeita `system` dentro de messages,
  o que ajuda contra injection) e envelopadas como no ai-manager.

Alternativa aceitável: se o produto ficar **só com Anthropic** no início, um adapter direto com
`@anthropic-ai/sdk` (alinhado ao ai-manager: 0.128.0, ou 0.135.0 se o ai-manager subir) atrás da mesma
porta é mais simples e tem zero lag de features; o AI SDK entra quando OpenAI/Gemini forem obrigatórios.
Como o requisito diz que o agente escolhe o provedor por empresa, a recomendação continua sendo o AI SDK.
