// Postgres real: envio barrado pelo limite do chip (ai-manager RATE_LIMIT) espera e refaz o mesmo nó sem reenviar.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companies, contacts, createDb, flowRuns, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import type { FlowDefinition } from '@crm/shared'
import { SendRejectedError, type SendRequest } from '@crm/wa-port'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq } from 'drizzle-orm'
import { FlowStore } from '../store/store'
import { FlowControl } from './control'
import { createNodeRegistry } from './registry'
import { FlowEngine, MAX_SEND_RETRIES, SEND_RETRY_VAR, sendRetryWindow, type FlowStepJobData } from './runner'
import type { FlowTimerJobData, TimerScheduler } from './timers'

let tmp: TempDatabase
let db: Database
let n = 0
beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 10 })
})
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

const node = (id: string, type: string) => ({ id, type, name: id, position: { x: 0, y: 0 }, actions: [] })
const edge = (from: string, handle: string, to: string) => ({ id: `${from}-${handle}-${to}`, from, handle, to })
const runOf = async (id: string) => (await db.select().from(flowRuns).where(eq(flowRuns.id, id)))[0]!

/** Gateway que rejeita os envios cujo texto estiver em `reject` (uma vez por item da fila). */
class LimitedGateway extends FakeWaGateway {
  readonly texts: string[] = []
  constructor(readonly reject: Array<{ text: string; err: Error }>) {
    super()
  }
  override async send(req: SendRequest) {
    const text = (req.content as { text?: string }).text ?? ''
    const i = this.reject.findIndex((r) => r.text === text)
    if (i >= 0) throw this.reject.splice(i, 1)[0]!.err
    this.texts.push(text)
    return { id: `m${this.texts.length}`, sessionId: req.sessionId, phone: req.phone, status: 'queued' } as unknown as Awaited<ReturnType<FakeWaGateway['send']>>
  }
}

/** start → m (manda "um" e "dois") → f (manda "fim"); `m` tem saída de falha para `x` quando `withFailure`. */
async function setup(gateway: LimitedGateway, withFailure = false) {
  n += 1
  const [c] = await db.insert(companies).values({ name: `C${n}`, slug: `c-retry-${n}-${Date.now()}` }).returning()
  const [contact] = await db.insert(contacts).values({ companyId: c!.id, name: 'Ana', phoneE164: `+55119777${String(n).padStart(5, '0')}` }).returning()
  const ctx = { companyId: c!.id }
  const store = new FlowStore(db)
  const flow = await store.createFlow(ctx, { name: `F${n}` })
  const def: FlowDefinition = {
    schema: 'crm.flow/v1',
    entry: 'start',
    nodes: [node('start', 'start'), node('m', 'message'), node('f', 'message'), node('x', 'message')],
    edges: [edge('start', 'source', 'm'), edge('m', 'source', 'f'), ...(withFailure ? [edge('m', 'failure', 'x')] : [])],
    variables: [],
    refs: {},
  }
  await store.fromDefinition(ctx, flow.id, def)
  await store.publish(ctx, flow.id)
  const scheduled: Array<{ data: FlowTimerJobData; delayMs: number }> = []
  const timers: TimerScheduler = { schedule: async (data, delayMs) => void scheduled.push({ data, delayMs }), cancel: async () => undefined }
  const steps: FlowStepJobData[] = []
  const now = () => new Date()
  const control = new FlowControl({ db, timers, now, shortDelayMs: 0, enqueueStep: async (j) => void steps.push(j) })
  const send = (ctx: Parameters<Parameters<ReturnType<typeof createNodeRegistry>['register']>[1]['execute']>[0], actionId: string, text: string) =>
    ctx.wa.send({ sessionId: 's1', phone: '+5511900000000', actor: 'crm:flow', content: { text } }, { actionId })
  const registry = createNodeRegistry().register('message', {
    execute: async (ctx) => {
      if (ctx.node.id === 'm') {
        await send(ctx, 'a1', 'um')
        await send(ctx, 'a2', 'dois')
      } else await send(ctx, 'a1', ctx.node.id === 'f' ? 'fim' : 'falha')
      return { next: 'source' }
    },
  })
  const engine = new FlowEngine({ db, wa: gateway, registry, hooks: control.engineHooks(), now })
  const { runId } = await engine.startRun(ctx, { flowId: flow.id, contactId: contact!.id })
  await engine.step(runId, 0)
  return { runId, control, engine, scheduled, steps }
}

const rateLimit = (window: string) => new SendRejectedError('RATE_LIMIT', `rate limit reached: 5/5 per ${window}`, { window, limit: 5, sent: 5 })

describe('limite de envio do chip no fluxo', () => {
  it('RATE_LIMIT por minuto: espera 30 s e refaz o nó sem reenviar o que já saiu; o run termina', async () => {
    const wa = new LimitedGateway([{ text: 'dois', err: rateLimit('minute') }])
    const s = await setup(wa, true)
    let run = await runOf(s.runId)
    expect([run.status, run.error]).toEqual(['waiting', null])
    expect(run.currentNodeKey).toBe('m')
    expect(run.vars).toMatchObject({ [SEND_RETRY_VAR]: { node: 'm', attempts: 1 } })
    expect(s.scheduled).toHaveLength(1)
    expect(s.scheduled[0]!.delayMs).toBe(30_000)
    expect(wa.texts).toEqual(['um'])

    expect(await s.control.fireTimer(s.scheduled[0]!.data)).toMatchObject({ advanced: true, status: 'running' })
    await s.engine.step(s.runId, s.steps.at(-1)!.expectedSeq)
    run = await runOf(s.runId)
    expect(run.status).toBe('completed')
    // "um" não saiu de novo; "dois" saiu na nova tentativa; não passou pela saída de falha.
    expect(wa.texts).toEqual(['um', 'dois', 'fim'])
    expect(run.vars).not.toHaveProperty(SEND_RETRY_VAR)
  })

  it('limite por dia não espera: segue a falha como antes', async () => {
    const wa = new LimitedGateway([{ text: 'dois', err: rateLimit('day') }])
    const s = await setup(wa, true)
    expect((await runOf(s.runId)).status).toBe('completed')
    expect(wa.texts).toEqual(['um', 'falha'])
    expect(s.scheduled).toHaveLength(0)
  })

  it('janela do limite: SendRejectedError (também via RPC sem protótipo) e mensagem; outros erros não', () => {
    expect(sendRetryWindow(rateLimit('minute'))).toBe('minute')
    expect(sendRetryWindow(rateLimit('hour'))).toBe('hour')
    expect(sendRetryWindow(rateLimit('day'))).toBeNull()
    expect(sendRetryWindow({ name: 'SendRejectedError', code: 'RATE_LIMIT', status: 429, details: { window: 'minute' } })).toBe('minute')
    expect(sendRetryWindow(new SendRejectedError('WARMUP_LIMIT', 'warm-up daily limit reached'))).toBeNull()
    expect(sendRetryWindow(new Error('rate limit reached: 5/5 per minute'))).toBe('minute')
    expect(sendRetryWindow(new Error('timeout'))).toBeNull()
    expect(MAX_SEND_RETRIES).toBeGreaterThan(10)
  })
})
