// Processo filho do harness (T17): migra e semeia o banco descartável, sobe a API com E2E=1 e o worker
// in-process (consumidor do stream com um handler espião que alimenta `/__e2e/wa/deliveries`).
// Encerra limpo ao receber "q" ou EOF no stdin (no Windows o SIGTERM externo não roda handlers).
// Rodado pelo serve.mjs: node --import tsx --conditions=development scripts/e2e/api.ts
import { serve } from '../../apps/api/src/e2e/node'
import { createApp } from '../../apps/api/src/app'
import { loadApiConfig } from '../../apps/api/src/config'
import type { HandledEvent } from '../../apps/api/src/e2e/index'
import { stopRealtimeHub } from '../../apps/api/src/routes/events/index'
import { configureAiKnowledge, configureExports, configureInboundWebhooks, createRegistry, registry as processRegistry, startWorker } from '../../apps/worker/src/index'
import { configureInboundSales } from '../../apps/worker/src/index'
import { RealtimePublisher } from '../../packages/core/src/index'
import { createDb, resetAndSeed, runMigrations } from '../../packages/db/src/index'
import { createLogger, initCredentialsCrypto, redisConnection } from '../../packages/node-kit/src/index'
import { WA_EVENT_TYPES } from '../../packages/wa-port/src/index'
import type { AiKeyProbe } from '../../packages/core/src/ai-keys/http'
import { configureMassDispatch } from '../../apps/worker/src/jobs/mass-dispatch/index'
import { FakeWaGateway } from '../../packages/wa-port/src/testing/index'
import { FakeStt } from '../../packages/ai/src/testing/index'
import { FakeElevenLabsVoices } from '../../packages/core/src/ai-voices/testing/fake-elevenlabs'
import { configureMetaAds } from '../../apps/worker/src/index'
import { META_GRAPH_VERSION, MetaProfilesService, type MetaConfig } from '../../packages/core/src/index'
import { FakeMetaGraph, type FakeInsightLevel } from '../../packages/core/src/meta-ads/client/testing/fake-graph'

// T59: o "Testar" das chaves de IA nunca chama o provedor real no harness. Segredo terminando em `fail` → falha
// `HTTP 401` (~5 ms); qualquer outro → ok (~87 ms; a latência medida pelo serviço fica ≥ esse valor).
import { FakeNotasy, FakeUtmify, FakeXPag } from '../../packages/core/src/index'
const e2eAiKeyProbe: AiKeyProbe = async ({ secret }) => {
  const fail = secret.trim().endsWith('fail')
  await new Promise((r) => setTimeout(r, fail ? 5 : 87))
  if (fail) throw new Error('HTTP 401')
}
// Listagens de modelos/vozes da chave (OpenRouter/ElevenLabs) também ficam locais: listas vazias, sem rede.
const e2eAiKeysFetch: typeof globalThis.fetch = async () =>
  new Response(JSON.stringify({ data: [], voices: [] }), { status: 200, headers: { 'content-type': 'application/json' } })

// T92: texto devolvido pelo FakeStt no ditado (`POST /api/ai-agents/transcriptions`); E2E_STT_TEXT troca.
const E2E_STT_TEXT = 'Texto ditado pelo teste de voz.'

/** T92: toda chamada de vozes (clonagem, exclusão, TTS da prévia) vai para o FakeElevenLabsVoices local. */
function toFakeVoices(fakeUrl: string): typeof globalThis.fetch {
  return (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const u = new URL(raw)
    const target = new URL(`${u.pathname}${u.search}`, fakeUrl)
    return globalThis.fetch(input instanceof Request ? new Request(target, input) : target, init)
  }
}

// T106: a Meta do harness é o FakeMetaGraph (nunca a Graph real). O processo da API não sabe a porta da web, então
// o diálogo OAuth e a volta do callback usam uma origem marcadora que o wrapper `e2eMetaFetch` troca por caminhos
// relativos (o navegador resolve na origem da web, que faz proxy de `/api` e `/__e2e` para cá).
const E2E_META_ORIGIN = 'http://e2e-web.invalid'

function e2eMetaConfig(fake: FakeMetaGraph): MetaConfig {
  return {
    appId: fake.appId,
    appSecret: fake.appSecret,
    graphUrl: fake.url,
    version: META_GRAPH_VERSION,
    dialogUrl: `${E2E_META_ORIGIN}/__e2e/meta`,
    redirectUri: `${E2E_META_ORIGIN}/api/meta/oauth/callback`,
    webUrl: E2E_META_ORIGIN,
    scopes: ['ads_read', 'ads_management'],
  }
}

/** Zera o fake (usuários, tokens, estrutura, falhas…) junto com o `POST /__e2e/reset`. */
function resetFakeMeta(fake: FakeMetaGraph): void {
  const f = fake as unknown as Record<string, unknown>
  for (const k of ['users', 'codes', 'tokens', 'structures', 'insightsByAccount', 'accountFailures', 'usageByAccount', 'pixels'])
    (f[k] as Map<unknown, unknown>).clear()
  f.failures = []
  for (const k of ['requests', 'mutations', 'capiEvents']) (f[k] as unknown[]).length = 0
}

/**
 * Rotas `/__e2e/meta/*` do harness (T106; só E2E=1) para semear e simular a Meta, e o diálogo OAuth fake:
 * `GET /__e2e/meta/<versão>/dialog/oauth?state=` loga como o usuário escolhido e volta para o callback.
 */
function e2eMetaFetch(fake: FakeMetaGraph, inner: (req: Request) => Response | Promise<Response>) {
  let oauthUser: string | null = null
  let oauthError: string | null = null
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const relative = (url: string) => (url.startsWith(E2E_META_ORIGIN) ? url.slice(E2E_META_ORIGIN.length) || '/' : url)
  const accounts = (list: unknown) =>
    (Array.isArray(list) ? (list as Record<string, unknown>[]) : []).map((a) => ({
      id: String(a.id),
      ...(a.account_id !== undefined ? { account_id: String(a.account_id) } : {}),
      ...(a.name !== undefined ? { name: String(a.name) } : {}),
      ...(a.currency !== undefined ? { currency: String(a.currency) } : {}),
      ...(a.account_status !== undefined ? { account_status: Number(a.account_status) } : {}),
    }))

  async function control(req: Request, path: string): Promise<Response> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (req.method === 'GET' || req.method === 'DELETE' ? {} : await req.json().catch(() => ({}))) as Record<string, any>
    const dialog = /^\/v[\d.]+\/dialog\/oauth$/.exec(path)
    if (dialog && req.method === 'GET') {
      const q = new URL(req.url).searchParams
      const back = new URLSearchParams({ state: q.get('state') ?? '' })
      if (oauthError || !oauthUser) {
        back.set('error', 'access_denied')
        back.set('error_description', oauthError ?? 'Nenhum usuário Meta fake (POST /__e2e/meta/users)')
      } else back.set('code', fake.issueCode(oauthUser))
      return new Response(null, { status: 302, headers: { location: `/api/meta/oauth/callback?${back}` } })
    }
    if (path === '' && req.method === 'GET') return json({ graph_url: fake.url, oauth_user: oauthUser, oauth_error: oauthError, requests: fake.requests.length })
    if (path === '/reset' && req.method === 'POST') {
      resetFakeMeta(fake)
      oauthUser = oauthError = null
      return json({ ok: true })
    }
    if (path === '/users' && req.method === 'POST') {
      fake.addUser({ id: String(body.id), name: String(body.name ?? body.id), pictureUrl: body.picture_url ?? null, adAccounts: accounts(body.ad_accounts) })
      oauthUser = String(body.id)
      oauthError = null
      return json({ ok: true, oauth_user: oauthUser }, 201)
    }
    const userAccounts = /^\/users\/([^/]+)\/ad-accounts$/.exec(path)
    if (userAccounts && req.method === 'PUT') {
      fake.setAdAccounts(decodeURIComponent(userAccounts[1]!), accounts(body.ad_accounts))
      return json({ ok: true })
    }
    if (path === '/oauth' && req.method === 'POST') {
      if (body.user_id !== undefined) oauthUser = body.user_id === null ? null : String(body.user_id)
      oauthError = body.error ? String(body.error) : null
      return json({ ok: true, oauth_user: oauthUser, oauth_error: oauthError })
    }
    if (path === '/structure' && req.method === 'POST') {
      fake.setStructure(String(body.account), { campaigns: body.campaigns ?? [], adsets: body.adsets ?? [], ads: body.ads ?? [] })
      return json({ ok: true })
    }
    if (path === '/insights' && req.method === 'POST') {
      fake.setInsights(String(body.account), (body.level ?? 'campaign') as FakeInsightLevel, body.rows ?? [])
      return json({ ok: true })
    }
    if (path === '/fail-account' && req.method === 'POST') {
      fake.failAccount(String(body.account), Number(body.status ?? 400), body.error ?? { message: 'Falha simulada', type: 'OAuthException', code: 100 })
      return json({ ok: true })
    }
    const clearFail = /^\/fail-account\/([^/]+)$/.exec(path)
    if (clearFail && req.method === 'DELETE') {
      fake.clearAccountFailure(decodeURIComponent(clearFail[1]!))
      return json({ ok: true })
    }
    if (path === '/usage' && req.method === 'POST') {
      fake.setUsage(String(body.account ?? '*'), body.usage ?? null, Number(body.regain_minutes ?? 0))
      return json({ ok: true })
    }
    if (path === '/fail-next' && req.method === 'POST') {
      fake.failNext(Number(body.status ?? 500), body.error ?? { message: 'Falha simulada', type: 'OAuthException', code: 2 })
      return json({ ok: true })
    }
    if (path === '/requests' && req.method === 'GET') return json({ items: fake.requests })
    if (path === '/mutations' && req.method === 'GET') return json({ items: fake.mutations })
    return json({ error: { code: 'NOT_FOUND', message: `rota e2e meta inexistente: ${req.method} ${path}` } }, 404)
  }

  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url)
    if (pathname === '/__e2e/meta' || pathname.startsWith('/__e2e/meta/')) return control(req, pathname.slice('/__e2e/meta'.length))
    const res = await inner(req)
    if (pathname === '/__e2e/reset' && req.method === 'POST' && res.ok) {
      resetFakeMeta(fake)
      oauthUser = oauthError = null
    }
    // Callback OAuth: `Location` na origem marcadora → caminho relativo (volta para a web que fez o proxy).
    const location = res.headers.get('location')
    if (location?.startsWith(E2E_META_ORIGIN)) {
      const headers = new Headers(res.headers)
      headers.set('location', relative(location))
      return new Response(res.body, { status: res.status, headers })
    }
    // `oauth_url` do start: caminho relativo para o diálogo fake (mesma origem da web).
    if (pathname === '/api/meta/oauth/start' && res.ok) {
      const data = (await res.json()) as { oauth_url?: string }
      if (data.oauth_url) data.oauth_url = relative(data.oauth_url)
      return json(data, res.status)
    }
    return res
  }
}

async function main() {
  if (process.env.E2E !== '1') throw new Error('scripts/e2e/api.ts exige E2E=1')
  const config = loadApiConfig()
  const logger = createLogger({ level: config.LOG_LEVEL, base: { service: 'e2e-api' } })
  initCredentialsCrypto({ key: config.CREDENTIALS_KEY })

  const db = createDb(config.DATABASE_URL)
  await runMigrations(db)
  await resetAndSeed(db)
  const redis = redisConnection({ url: config.REDIS_URL })
  const stream = process.env.WA_EVENTS_STREAM || 'wsm:events'

  const deliveries: HandledEvent[] = []
  // T54: intervalo mínimo entre reenvios de convite (produção: 60 s). Padrão 0 no E2E, para chegar ao
  // "Limite de 3 reenvios por dia" sem esperar; E2E_RESEND_COOLDOWN_MS=<ms> testa o "Aguarde…".
  const resendCooldownMs = Math.max(0, Number(process.env.E2E_RESEND_COOLDOWN_MS ?? 0) || 0)
  // T83: o mesmo FakeWaGateway na API e na preparação dos disparos em massa (sessão levada a open pela rota da T71).
  const waGateway = new FakeWaGateway()
  // T114: pagamentos, NF e UTMify nunca saem para a rede no harness: XPAG/NOTASY/UTMIFY_API_URL apontam para fakes locais
  // (lidos a cada chamada). XPag aceita só Client ID `xpag-e2e` + Client Secret `xpag-e2e-secret` (outra credencial: o
  // "Testar conexão" falha com 401); Notasy aceita o token `notasy-e2e`; UTMify, `utmify-e2e`.
  process.env.XPAG_API_URL = await new FakeXPag({ clientId: 'xpag-e2e', clientSecret: 'xpag-e2e-secret' }).start()
  process.env.NOTASY_API_URL = await new FakeNotasy(['notasy-e2e']).start()
  process.env.UTMIFY_API_URL = await new FakeUtmify(['utmify-e2e']).start()
  // T92: vozes da conta contra o FakeElevenLabsVoices (qualquer `xi-api-key`), nunca a ElevenLabs real.
  const fakeVoices = new FakeElevenLabsVoices()
  await fakeVoices.start()
  // T106: Graph fake local (OAuth, contas, estrutura, insights, mutações); semeado por `/__e2e/meta/*`.
  const fakeMeta = new FakeMetaGraph()
  await fakeMeta.start()
  const metaConfig = e2eMetaConfig(fakeMeta)
  const app = createApp({
    db, redis, logger, sessionTtlDays: config.AUTH_SESSION_TTL_DAYS, cookieSecure: false, e2e: { deliveries }, invitations: { resendCooldownMs }, aiKeyProbe: e2eAiKeyProbe, aiKeysFetch: e2eAiKeysFetch,
    // T92: laboratório dos agentes. O LLM é o FakeLlm do harness (`/__e2e/llm/script`, lido a cada chamada); a criação
    // assistida roda no próprio processo; o ditado usa o FakeStt; a leitura do site não sai para a rede (DNS recusado →
    // aviso `site_unread`).
    aiAgentLabInline: true,
    // Sem preset `balanced` (empresa/plataforma), a montagem usa este modelo do seed de preços (o LLM é o FakeLlm).
    aiLabComposeModel: { provider: 'openai', model: 'gpt-6-luna' },
    aiLabStt: new FakeStt({ text: () => process.env.E2E_STT_TEXT || E2E_STT_TEXT }),
    aiLabSiteHttp: { lookup: async (host: string) => { throw new Error(`rede desligada no harness (${host})`) }, timeoutMs: 2_000 },
    aiVoicesFetch: toFakeVoices(fakeVoices.url),
    waGateway,
    metaConfig,
  })

  // Mesmo registry do worker real + espião em todos os tipos.
  const reg = createRegistry()
  reg.queues.push(...processRegistry.queues)
  reg.workers.push(...processRegistry.workers)
  reg.handlers.push(...processRegistry.handlers)
  for (const type of WA_EVENT_TYPES)
    reg.on(type, (event, ctx) => {
      deliveries.push({ stream_id: ctx.streamId, type: event.type, event_key: ctx.eventKey, at: new Date().toISOString() })
    })
  // Exports/imports (T27) no worker in-process, como no boot de produção.
  configureExports({ db, redis, logger })
  // Webhooks de entrada (T81) no worker in-process: processa os requests e publica webhook.sample_received.
  configureInboundWebhooks({ db, redis, publisher: new RealtimePublisher({ redis }), logger })
  // Base de conhecimento dos agentes (T52) no worker in-process (a fila entra pelo registry do processo): ingere as
  // fontes e publica ai_knowledge_source.updated.
  configureAiKnowledge({ db, redis })
  // Fontes de venda (T73/T90) no worker in-process, como no boot de produção: processa os eventos de
  // `POST /api/hooks/sales/:token` (processed/failed) e o replay. Sem `capiEnqueue`: nada sai para a Meta no harness.
  configureInboundSales({ db, publisher: new RealtimePublisher({ redis }), logger })
  // Disparos em massa (T74/T83) no worker in-process: a preparação roda e publica mass_dispatch.updated (fases).
  configureMassDispatch({ db, wa: waGateway, redis })
  // Gerenciador Meta (T101/T106) no worker in-process: o job `meta-sync` monta o bundle `async=1` contra o fake.
  configureMetaAds({ db, redis, publisher: new RealtimePublisher({ redis }), profiles: new MetaProfilesService({ db, config: metaConfig }), logger })
  const worker = await startWorker({
    registry: reg,
    db,
    redisUrl: config.REDIS_URL,
    consumer: { stream, blockMs: 200 },
    forceConsumer: true,
    handleSignals: false,
    exitProcess: false,
    logger,
  })

  const server = serve({ fetch: e2eMetaFetch(fakeMeta, (req) => app.fetch(req)), hostname: '127.0.0.1', port: config.PORT }, (info) => {
    process.stdout.write(`E2E_CHILD_READY ${info.port}\n`)
  })
  const sockets = server as unknown as { closeAllConnections?: () => void }

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    setTimeout(() => process.exit(1), 8_000).unref()
    await stopRealtimeHub(redis).catch(() => undefined)
    await worker.stop().catch(() => undefined)
    await fakeVoices.close().catch(() => undefined)
    await fakeMeta.close().catch(() => undefined)
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      sockets.closeAllConnections?.()
    })
    await Promise.allSettled([db.$client.end(), redis.quit()])
    process.exit(0)
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    if (chunk.trim() === 'q') void shutdown()
  })
  process.stdin.on('end', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch((err: unknown) => {
  createLogger().fatal({ err }, 'e2e api failed to start')
  process.exit(1)
})
