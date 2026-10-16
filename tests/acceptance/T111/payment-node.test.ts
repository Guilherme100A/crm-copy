// AC-T111-01..05: bloco Pagamento num fluxo real (FakeXPag), espera da confirmação, webhook público
// (token/assinatura, idempotência, TTL) e valor (vírgula/ponto, variáveis, chave sem valor).
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CLIENT_SECRET,
  MIN,
  chargesOf,
  deliver,
  newIntegration,
  newOwner,
  paymentFlow,
  pixConfig,
  processJobs,
  runFlow,
  runRow,
  startEnv,
  type Env,
  type Owner,
} from './setup'

let env: Env
let owner: Owner
let integration: { id: string; webhook_url: string }
beforeAll(async () => {
  env = await startEnv()
  owner = await newOwner(env)
  integration = await newIntegration(owner)
})
afterAll(async () => {
  await env?.close()
})

const lastCashin = () => env.fake.cashins[env.fake.cashins.length - 1]
const nodesOf = (sent: Array<{ node: string }>) => sent.map((s) => s.node)

/** Fluxo PIX BRL com a cobrança já criada (1 cashin novo no fake). */
async function pendingPix(extra: Record<string, unknown> = {}, opts: { vars?: Record<string, unknown>; branch?: 'wait' | 'end' | 'none' } = {}) {
  const before = env.fake.cashins.length
  const run = await runFlow(env, owner.companyId, paymentFlow(pixConfig(integration.id, extra), { branch: opts.branch }), opts.vars ?? {})
  expect(env.fake.cashins.length, 'o nó deveria criar exatamente 1 cobrança no fake').toBe(before + 1)
  return { run, tx: lastCashin().transaction_id as string }
}

/** Confere listener_until ≈ agora (relógio da suíte) + 1 h. */
function expectListenerOneHour(listenerUntil: unknown) {
  expect(listenerUntil).not.toBeNull()
  const ttlMs = new Date(listenerUntil as string).getTime() - env.clock.now().getTime()
  expect(ttlMs).toBeGreaterThan(55 * MIN)
  expect(ttlMs).toBeLessThanOrEqual(60 * MIN + 5_000)
}

describe('T111 bloco Pagamento', () => {
  it('AC-T111-01 cria a cobrança no fake e segue charge_created com {gateway.*} preenchidas; o listener fica em payment_charges', async () => {
    const { run, tx } = await pendingPix()
    const cashin = lastCashin()
    expect(cashin.body).toMatchObject({ currency: 'BRL', amount: 50 })
    // webhook_url do cashin aponta para a rota pública desta integração
    expect(String(cashin.webhook_url)).toContain(`/api/hooks/payments/xpag/${integration.id}`)

    // ramo charge_created com as variáveis expostas
    expect(nodesOf(run.sent)).toEqual(['C'])
    const text = run.sent[0]!.text
    expect(text).toContain(`tx=${tx}|`)
    expect(text).toContain(`|code=00020126PIX${tx}6304ABCD|`)
    expect(text).not.toMatch(/\{gateway\./)

    // cobrança registrada, ligada ao run, com o listener até o fim do TTL
    const [charge] = await chargesOf(env, run.runId)
    expect(charge).toMatchObject({ gateway: 'xpag', transaction_id: tx, status: 'created', currency: 'BRL', contact_id: run.contactId })
    expect(Number(charge.amount_cents)).toBe(5000)
    expectListenerOneHour(charge.listener_until)

    // o run fica onde o ramo terminou (a espera própria do ramo), sem seguir payment_approved nem failure
    const row = await runRow(env, run.runId)
    expect(row.status).toBe('waiting')
    expect(row.current_node_key).toBe('W')
    expect(row.wait?.kind).not.toBe('payment')
    expect(nodesOf(run.sent)).not.toContain('A')
    expect(nodesOf(run.sent)).not.toContain('E')
  })

  it('AC-T111-01 sem aresta charge_created o run espera a confirmação no próprio nó (wait payment até o TTL)', async () => {
    const { run, tx } = await pendingPix({}, { branch: 'none' })
    expect(run.sent).toEqual([])
    const row = await runRow(env, run.runId)
    expect(row.status).toBe('waiting')
    expect(row.current_node_key).toBe('P')
    expect(row.wait).toMatchObject({ kind: 'payment', transaction_id: tx })
    const [charge] = await chargesOf(env, run.runId)
    expect(charge).toMatchObject({ transaction_id: tx, status: 'created' })
    expectListenerOneHour(charge.listener_until)
    expect(new Date(row.wait.deadline_at).getTime()).toBe(new Date(charge.listener_until).getTime())

    // mensagem do lead não retoma a espera de pagamento
    await run.control.resolveReply(run.runId, { text: 'já paguei', type: 'text', message_id: randomUUID() }).catch(() => {})
    await run.drain()
    expect(run.sent).toEqual([])
    expect((await runRow(env, run.runId)).wait?.kind).toBe('payment')
  })

  it('AC-T111-02 webhook aprovado dentro do TTL interrompe o run e o leva ao payment_approved com {gateway.value}', async () => {
    const { run, tx } = await pendingPix()
    const hook = env.fake.webhookFor(tx, { status: 'confirmed' })
    const res = await deliver(env, hook)
    expect(res.status, res.text).toBe(202)
    expect(JSON.parse(res.text)).toMatchObject({ accepted: 1 })
    expect(env.jobs.length).toBe(1)
    await processJobs(env, run)

    expect(nodesOf(run.sent)).toEqual(['C', 'A'])
    expect(run.sent[1]!.text).toBe('pago 50.00')
    const [charge] = await chargesOf(env, run.runId)
    expect(charge.status).toBe('approved')
    expect(charge.paid_at).not.toBeNull()
    expect((await runRow(env, run.runId)).status).toBe('completed')

    // a espera antiga do ramo (W) não volta: o timer dela não leva ao timeout
    await run.fireTimers()
    expect(nodesOf(run.sent)).toEqual(['C', 'A'])
  })

  it('AC-T111-02 webhook aprovado retoma também o run já completed (ramo sem espera) e o que esperava no nó (sem ramo)', async () => {
    const ended = await pendingPix({}, { branch: 'end' })
    expect((await runRow(env, ended.run.runId)).status).toBe('completed')
    expect((await deliver(env, env.fake.webhookFor(ended.tx))).status).toBe(202)
    await processJobs(env, ended.run)
    expect(nodesOf(ended.run.sent)).toEqual(['C', 'A'])
    expect(ended.run.sent[1]!.text).toBe('pago 50.00')

    const waiting = await pendingPix({}, { branch: 'none' })
    expect((await deliver(env, env.fake.webhookFor(waiting.tx))).status).toBe(202)
    await processJobs(env, waiting.run)
    expect(nodesOf(waiting.run.sent)).toEqual(['A'])
    expect(waiting.run.sent[0]!.text).toBe('pago 50.00')
    const row = await runRow(env, waiting.run.runId)
    expect(row.wait?.kind ?? null).not.toBe('payment')
    expect(row.status).toBe('completed')
  })

  it('AC-T111-02 o mesmo webhook entregue duas vezes retoma o run uma vez só', async () => {
    const { run, tx } = await pendingPix()
    const hook = env.fake.webhookFor(tx, { status: 'confirmed' })
    const first = await deliver(env, hook)
    const second = await deliver(env, hook)
    expect([first.status, second.status]).toEqual([202, 202])
    // as duas entregas geram o mesmo jobId (a fila deduplica): <gateway>-<transaction_id>-<tipo>
    const ids = env.jobs.map((j) => j.opts?.jobId)
    expect(ids).toEqual([`xpag-${tx}-payment.approved`.replace(/[^A-Za-z0-9_.-]/g, '_'), ids[0]])
    // processa tudo o que foi enfileirado (mesmo se a fila não deduplicar), depois uma 3ª entrega tardia
    await processJobs(env, run)
    expect((await deliver(env, hook)).status).toBe(202)
    await processJobs(env, run)

    expect(nodesOf(run.sent).filter((n) => n === 'A')).toHaveLength(1)
    const charges = await env.q(`SELECT status FROM crm.payment_charges WHERE gateway = 'xpag' AND transaction_id = $1`, [tx])
    expect(charges).toEqual([{ status: 'approved' }])
  })

  it('AC-T111-03 webhook depois do TTL só atualiza payment_charges e não retoma o run', async () => {
    const { run, tx } = await pendingPix()
    const before = await runRow(env, run.runId)
    env.clock.advance(61 * MIN)
    const res = await deliver(env, env.fake.webhookFor(tx, { status: 'confirmed' }))
    expect(res.status, res.text).toBe(202)
    await processJobs(env, run)

    expect(nodesOf(run.sent)).toEqual(['C'])
    const [charge] = await chargesOf(env, run.runId)
    expect(charge.status).toBe('approved')
    const after = await runRow(env, run.runId)
    expect(after.current_node_key).toBe(before.current_node_key)
    expect(after.vars?.gateway?.value ?? null).toBe(before.vars?.gateway?.value ?? null)
  })

  it('AC-T111-03 sem ramo: no fim do TTL a espera de pagamento vence e o webhook tardio não retoma', async () => {
    const { run, tx } = await pendingPix({}, { branch: 'none' })
    env.clock.advance(61 * MIN)
    await run.fireTimers()
    const expired = await runRow(env, run.runId)
    expect(expired.wait?.kind ?? null).not.toBe('payment')
    expect(expired.status).toBe('completed')

    expect((await deliver(env, env.fake.webhookFor(tx, { status: 'confirmed' }))).status).toBe(202)
    await processJobs(env, run)
    expect(run.sent).toEqual([])
    expect((await chargesOf(env, run.runId))[0].status).toBe('approved')
  })

  it('AC-T111-03 erro do gateway na criação segue failure com {gateway.error}', async () => {
    env.fake.failNext(500)
    const run = await runFlow(env, owner.companyId, paymentFlow(pixConfig(integration.id)))
    expect(nodesOf(run.sent)).toEqual(['E'])
    const text = run.sent[0]!.text
    expect(text).toMatch(/^erro \S/)
    expect(text).not.toMatch(/\{gateway\./)
    expect(text).not.toContain(CLIENT_SECRET)
    expect(await chargesOf(env, run.runId)).toEqual([])
    expect((await runRow(env, run.runId)).wait?.kind ?? null).not.toBe('payment')
  })

  it('AC-T111-03 erro de validação do gateway (OXXO fora da faixa) também segue failure com {gateway.error}', async () => {
    const before = env.fake.cashins.length
    const run = await runFlow(env, owner.companyId, paymentFlow(pixConfig(integration.id, { currency: 'MXN', method: 'OXXO', amount: 5 })))
    expect(env.fake.cashins.length).toBe(before)
    expect(nodesOf(run.sent)).toEqual(['E'])
    expect(run.sent[0]!.text).toMatch(/^erro \S/)
    expect(await chargesOf(env, run.runId)).toEqual([])
  })

  it('AC-T111-04 gateway/integração inexistentes no endpoint público → 404 e nada é processado', async () => {
    const { run, tx } = await pendingPix()
    const hook = env.fake.webhookFor(tx, { status: 'confirmed' })
    const token = new URL(hook.url).searchParams.get('token')
    const jobsBefore = env.jobs.length
    for (const path of [
      `/api/hooks/payments/xpag/${randomUUID()}?token=${token}`, // integração inexistente
      `/api/hooks/payments/zenith/${integration.id}?token=${token}`, // gateway errado para a integração
      `/api/hooks/payments/nao-existe/${integration.id}?token=${token}`, // gateway inexistente
    ]) {
      const res = await deliver(env, hook, `http://x${path}`)
      expect(res.status, `${path} → ${res.text}`).toBe(404)
    }
    expect(env.jobs.length).toBe(jobsBefore)
    await processJobs(env, run)
    expect(nodesOf(run.sent)).not.toContain('A')
    expect((await chargesOf(env, run.runId))[0].status).toBe('created')
  })

  it('AC-T111-04 assinatura inválida (token errado ou ausente) → 401 e nada é processado; o token não vai para o log', async () => {
    const { run, tx } = await pendingPix()
    const hook = env.fake.webhookFor(tx, { status: 'confirmed' })
    const good = new URL(hook.url)
    const token = good.searchParams.get('token')!
    expect(token).toBeTruthy()
    const onlyJson = { ...hook, headers: { 'content-type': 'application/json' } }
    const jobsBefore = env.jobs.length
    const logsBefore = env.logs.length
    for (const search of [`?token=${token.slice(0, -2)}xx`, '']) {
      const res = await deliver(env, onlyJson, `${good.origin}${good.pathname}${search}`)
      expect(res.status, `token ${search || '(ausente)'} → ${res.text}`).toBe(401)
    }
    expect(env.jobs.length).toBe(jobsBefore)
    await processJobs(env, run)
    expect(nodesOf(run.sent)).not.toContain('A')
    expect((await chargesOf(env, run.runId))[0].status).toBe('created')

    // a entrega válida continua funcionando depois, e nenhuma linha de log (inclusive o de acesso) traz o token
    expect((await deliver(env, hook)).status).toBe(202)
    await processJobs(env, run)
    expect(nodesOf(run.sent)).toContain('A')
    const newLogs = env.logs.slice(logsBefore)
    expect(newLogs.length, 'a API deveria registrar as requisições no log').toBeGreaterThan(0)
    expect(newLogs.filter((l) => l.includes(token))).toEqual([])
  })

  it('AC-T111-05 valor com vírgula, com ponto e por variável ({preco})', async () => {
    for (const [amount, vars, expected] of [
      ['49,90', {}, 49.9],
      ['49.90', {}, 49.9],
      ['{preco}', { preco: '19,90' }, 19.9],
      ['{preco}', { preco: '27.5' }, 27.5],
    ] as Array<[string, Record<string, unknown>, number]>) {
      const { run } = await pendingPix({ amount }, { vars })
      expect(lastCashin().body.amount, `amount ${amount} ${JSON.stringify(vars)}`).toBe(expected)
      const [charge] = await chargesOf(env, run.runId)
      expect(Number(charge.amount_cents)).toBe(Math.round(expected * 100))
    }
  })

  it('AC-T111-05 "chave sem valor" cria cobrança sem valor fixo e usa o valor pago do webhook', async () => {
    const { run, tx } = await pendingPix({ amount: undefined, open_amount: true })
    expect(lastCashin().body).not.toHaveProperty('amount')
    const [created] = await chargesOf(env, run.runId)
    expect(created.amount_cents).toBeNull()

    const res = await deliver(env, env.fake.webhookFor(tx, { status: 'confirmed', amount: 77.7 }))
    expect(res.status, res.text).toBe(202)
    await processJobs(env, run)
    expect(nodesOf(run.sent)).toEqual(['C', 'A'])
    expect(run.sent[1]!.text).toBe('pago 77.70')
    const [paid] = await chargesOf(env, run.runId)
    expect(paid.status).toBe('approved')
  })
})
