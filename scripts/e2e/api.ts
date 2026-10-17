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

// T59: o "Testar" das chaves de IA nunca chama o provedor real no harness. Segredo terminando em `fail` → falha
// `HTTP 401` (~5 ms); qualquer outro → ok (~87 ms; a latência medida pelo serviço fica ≥ esse valor).
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
  // T92: vozes da conta contra o FakeElevenLabsVoices (qualquer `xi-api-key`), nunca a ElevenLabs real.
  const fakeVoices = new FakeElevenLabsVoices()
  await fakeVoices.start()
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

  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.PORT }, (info) => {
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
