// AC-T72-01..04: recepção pública de webhooks de entrada (404/inativo, truncamento e rate limit, 202 + fila, retenção).
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { uuid } from '../helpers/factories'
import {
  RATE_LIMIT_SMALL,
  findRequest,
  listRequests,
  newMember,
  newOwner,
  newWebhook,
  postHook,
  randomToken,
  startEnv,
  type Env,
} from './setup'

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

const LIMIT = 262_144 // 256 KB
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const countRequests = async (webhookId: string) =>
  Number((await env.q(`SELECT count(*)::int AS n FROM crm.inbound_webhook_requests WHERE webhook_id = $1`, [webhookId]))[0].n)

describe('AC-T72-01 token inexistente e webhook inativo', () => {
  it('AC-T72-01 token inexistente → 404 NOT_FOUND, sem sessão nem CSRF', async () => {
    const res = await postHook(env.app, randomToken())
    expect(res.status, res.text).toBe(404)
    expect(res.body?.error?.code).toBe('NOT_FOUND')
    const lixo = await postHook(env.app, 'nao-existe')
    expect(lixo.status, lixo.text).toBe(404)
  })

  it('AC-T72-01 webhook inativo → 202 e request gravado como skipped (webhook_inactive), sem enfileirar', async () => {
    const owner = await newOwner(env)
    const wh = await newWebhook(owner, { active: false })
    expect(wh.active).toBe(false)
    const before = env.enqueued.length
    const res = await postHook(env.app, wh.public_token, JSON.stringify({ nome: 'Ana' }))
    expect(res.status, res.text).toBe(202)
    expect(res.body).toMatchObject({ ok: true, status: 'skipped' })
    expect(typeof res.body.request_id).toBe('string')
    const r = await findRequest(owner, wh.id, res.body.request_id)
    expect(r).toMatchObject({ webhook_id: wh.id, processing_status: 'skipped', error: 'webhook_inactive' })
    expect(r.raw_body).toBe(JSON.stringify({ nome: 'Ana' }))
    expect(env.enqueued.slice(before).some((j) => j.requestId === res.body.request_id)).toBe(false)

    // reativado: o mesmo token volta a aceitar como pending
    const patch = await owner.c.patch(`/api/inbound-webhooks/${wh.id}`, { active: true })
    expect(patch.status, patch.text).toBe(200)
    const ok = await postHook(env.app, wh.public_token)
    expect(ok.status, ok.text).toBe(202)
    expect(ok.body.status).toBe('pending')
  })

  it('AC-T72-01 webhook excluído → token passa a responder 404', async () => {
    const owner = await newOwner(env)
    const wh = await newWebhook(owner)
    expect((await postHook(env.app, wh.public_token)).status).toBe(202)
    const del = await owner.c.delete(`/api/inbound-webhooks/${wh.id}`)
    expect(del.status, del.text).toBe(200)
    expect((await postHook(env.app, wh.public_token)).status).toBe(404)
    expectApiError(await owner.c.get(`/api/inbound-webhooks/${wh.id}`), 'NOT_FOUND', 404)
  })

  it('AC-T72-01 CRUD: token público ≥ 32 bytes e URL pública; permissões; outra empresa → 404', async () => {
    const owner = await newOwner(env)
    const wh = await newWebhook(owner)
    expect(wh.active).toBe(true)
    expect(Buffer.from(wh.public_token, 'base64url').length).toBeGreaterThanOrEqual(32)
    expect(wh.public_receive_url).toMatch(new RegExp(`/api/hooks/in/${wh.public_token}$`))
    const other = await newWebhook(owner)
    expect(other.public_token).not.toBe(wh.public_token)

    const list = await owner.c.get('/api/inbound-webhooks')
    expect(list.status, list.text).toBe(200)
    expect(list.body.items.map((w: { id: string }) => w.id)).toEqual(expect.arrayContaining([wh.id, other.id]))

    expectApiError(await owner.c.post('/api/inbound-webhooks', { name: '   ' }), 'VALIDATION_ERROR', 422)

    const viewer = await newMember(env, owner.companyId, ['webhooks.view'])
    expect((await viewer.c.get(`/api/inbound-webhooks/${wh.id}`)).status).toBe(200)
    expectApiError(await viewer.c.post('/api/inbound-webhooks', { name: 'X' }), 'FORBIDDEN', 403)
    expectApiError(await viewer.c.patch(`/api/inbound-webhooks/${wh.id}`, { name: 'Y' }), 'FORBIDDEN', 403)
    expectApiError(await viewer.c.delete(`/api/inbound-webhooks/${wh.id}`), 'FORBIDDEN', 403)
    const nobody = await newMember(env, owner.companyId, [])
    expectApiError(await nobody.c.get('/api/inbound-webhooks'), 'FORBIDDEN', 403)

    const stranger = await newOwner(env)
    expectApiError(await stranger.c.get(`/api/inbound-webhooks/${wh.id}`), 'NOT_FOUND', 404)
    expectApiError(await stranger.c.patch(`/api/inbound-webhooks/${wh.id}`, { name: 'Z' }), 'NOT_FOUND', 404)
    expectApiError(await stranger.c.delete(`/api/inbound-webhooks/${wh.id}`), 'NOT_FOUND', 404)
    expectApiError(await stranger.c.get(`/api/inbound-webhooks/${wh.id}/requests`), 'NOT_FOUND', 404)
    expectApiError(await owner.c.get(`/api/inbound-webhooks/${uuid()}`), 'NOT_FOUND', 404)
    // a resposta não expõe o token de outra empresa
    expect((await stranger.c.get('/api/inbound-webhooks')).text).not.toContain(wh.public_token)
  })
})

describe('AC-T72-02 limite de corpo e rate limit', () => {
  it('AC-T72-02 corpo acima de 256 KB é truncado com a flag e o request ainda é registrado (202)', async () => {
    const owner = await newOwner(env)
    const wh = await newWebhook(owner)
    const big = `{"dados":"${'a'.repeat(300 * 1024)}"}`
    const res = await postHook(env.app, wh.public_token, big)
    expect(res.status, res.text.slice(0, 300)).toBe(202)
    const r = await findRequest(owner, wh.id, res.body.request_id)
    expect(r).toBeTruthy()
    expect(r.raw_body_truncated).toBe(true)
    expect(Buffer.byteLength(r.raw_body, 'utf8')).toBeLessThanOrEqual(LIMIT)
    expect(r.raw_body.length).toBeGreaterThan(0)
    expect(big.startsWith(r.raw_body)).toBe(true)
    expect(r.body_size).toBe(Buffer.byteLength(big))
    expect(r.body_hash).toBe(sha256(big))
    // lista e detalhe também sinalizam o truncamento no último request
    const got = await owner.c.get(`/api/inbound-webhooks/${wh.id}`)
    expect(got.body.webhook.last_inbound_webhook_request).toMatchObject({ id: r.id, raw_body_truncated: true })
  })

  it('AC-T72-02 corpo dentro do limite (inclusive exatamente 256 KB) é guardado inteiro, sem flag', async () => {
    const owner = await newOwner(env)
    const wh = await newWebhook(owner)
    const small = JSON.stringify({ cliente: { nome: 'Bia', telefone: '11999990000' } })
    const a = await postHook(env.app, wh.public_token, small)
    expect(a.status, a.text).toBe(202)
    const ra = await findRequest(owner, wh.id, a.body.request_id)
    expect(ra).toMatchObject({ raw_body: small, raw_body_truncated: false, body_hash: sha256(small) })

    const exact = `"${'b'.repeat(LIMIT - 2)}"`
    expect(Buffer.byteLength(exact)).toBe(LIMIT)
    const b = await postHook(env.app, wh.public_token, exact)
    expect(b.status, b.text.slice(0, 300)).toBe(202)
    const rb = await findRequest(owner, wh.id, b.body.request_id)
    expect(rb.raw_body_truncated).toBe(false)
    expect(rb.raw_body).toBe(exact)
  })

  it('AC-T72-02 corpo não-JSON é aceito e registrado como recebido', async () => {
    const owner = await newOwner(env)
    const wh = await newWebhook(owner)
    const res = await postHook(env.app, wh.public_token, 'nome=Ana&tel=11999990000', 'application/x-www-form-urlencoded')
    expect(res.status, res.text).toBe(202)
    const r = await findRequest(owner, wh.id, res.body.request_id)
    expect(r).toMatchObject({ raw_body: 'nome=Ana&tel=11999990000', raw_body_truncated: false })
  })

  it('AC-T72-02 acima do rate limit por token → 429 RATE_LIMIT e nada é gravado; outro token não é afetado', async () => {
    const owner = await newOwner(env)
    const wh = await newWebhook(owner)
    const other = await newWebhook(owner)
    for (let i = 0; i < RATE_LIMIT_SMALL; i++) {
      const ok = await postHook(env.appRl, wh.public_token, JSON.stringify({ i }))
      expect(ok.status, ok.text).toBe(202)
    }
    const over = await postHook(env.appRl, wh.public_token, JSON.stringify({ i: 'excedente' }))
    expect(over.status, over.text).toBe(429)
    expect(over.body?.error?.code).toBe('RATE_LIMIT')
    expect(await countRequests(wh.id)).toBe(RATE_LIMIT_SMALL)
    expect((await listRequests(owner, wh.id)).some((r) => r.raw_body?.includes('excedente'))).toBe(false)
    // por token, não por IP nem global
    expect((await postHook(env.appRl, other.public_token)).status).toBe(202)
  })

  it('AC-T72-02 rate limit padrão por token também barra rajadas (429 após o limite)', async () => {
    const owner = await newOwner(env)
    const wh = await newWebhook(owner)
    let first429 = -1
    for (let i = 0; i < 1_000 && first429 < 0; i++) {
      const r = await postHook(env.app, wh.public_token, JSON.stringify({ i }))
      if (r.status === 429) first429 = i
      else expect(r.status, r.text).toBe(202)
    }
    expect(first429, 'nenhum 429 em 1000 requisições seguidas').toBeGreaterThan(0)
    expect(await countRequests(wh.id)).toBe(first429)
  })
})

describe('AC-T72-03 202 rápido e job enfileirado', () => {
  it('AC-T72-03 request válido → 202 em ≤ 200 ms, status pending, job com o id do request', async () => {
    const owner = await newOwner(env)
    const wh = await newWebhook(owner, {
      config: { field_paths: { full_name: [{ kind: 'path', value: 'nome' }], phone: [{ kind: 'path', value: 'tel' }] } },
    })
    await postHook(env.app, wh.public_token) // aquecimento (primeira carga de módulos/rotas)
    for (let i = 0; i < 5; i++) {
      const body = JSON.stringify({ nome: `Lead ${i}`, tel: `+551199999${String(1000 + i)}` })
      const res = await postHook(env.app, wh.public_token, body)
      expect(res.status, res.text).toBe(202)
      expect(res.ms, `latência ${res.ms.toFixed(1)} ms`).toBeLessThanOrEqual(200)
      expect(res.body).toMatchObject({ ok: true, status: 'pending' })
      const job = env.enqueued.find((j) => j.requestId === res.body.request_id)
      expect(job, 'job não enfileirado com o id do request').toBeTruthy()
      expect(job).toMatchObject({ requestId: res.body.request_id, webhookId: wh.id, companyId: owner.companyId })
      // não processou inline: continua pending, sem etapas e sem contato criado
      const r = await findRequest(owner, wh.id, res.body.request_id)
      expect(r).toMatchObject({ processing_status: 'pending', raw_body: body })
      expect(r.steps ?? []).toEqual([])
    }
    const contacts = await env.q(`SELECT count(*)::int AS n FROM crm.contacts WHERE company_id = $1`, [owner.companyId])
    expect(Number(contacts[0].n)).toBe(0)
  })

  it('AC-T72-03 sem enqueue injetado o job vai para a fila BullMQ inbound-webhooks com o id do request', async () => {
    const owner = await newOwner(env)
    const wh = await newWebhook(owner)
    const res = await postHook(env.appBull, wh.public_token, JSON.stringify({ x: 1 }))
    expect(res.status, res.text).toBe(202)
    const requestId = res.body.request_id
    const queue = env.core.defineQueue('inbound-webhooks')
    try {
      expect(queue.opts.prefix).toBe(process.env.CRM_QUEUE_PREFIX || 'crm')
      const job = await queue.getJob(`iwr-${requestId}`)
      expect(job, 'job iwr-<requestId> ausente da fila').toBeTruthy()
      expect(job.data).toMatchObject({ requestId, webhookId: wh.id, companyId: owner.companyId })
      await job.remove().catch(() => {})
    } finally {
      await queue.close()
    }
  })

  it('AC-T72-03 aceito conta no mês: month_count e request_stats refletem o request', async () => {
    const owner = await newOwner(env)
    const wh = await newWebhook(owner)
    expect(wh.month_count).toBe(0)
    for (let i = 0; i < 2; i++) expect((await postHook(env.app, wh.public_token, JSON.stringify({ i }))).status).toBe(202)
    const got = await owner.c.get(`/api/inbound-webhooks/${wh.id}`)
    expect(got.status, got.text).toBe(200)
    expect(got.body.webhook.month_count).toBe(2)
    expect(got.body.webhook.request_stats).toMatchObject({ total: 2, pending: 2, retention_max: 1000 })
    const list = await owner.c.get('/api/inbound-webhooks')
    expect(list.body.usage.used).toBeGreaterThanOrEqual(2)
  })
})

describe('AC-T72-04 retenção de 1 000 requests por webhook', () => {
  it('AC-T72-04 o 1 001º request remove o mais antigo do webhook (e só dele)', async () => {
    const owner = await newOwner(env)
    const wh = await newWebhook(owner)
    const neighbor = await newWebhook(owner)
    // 1000 requests antigos do webhook (o mais antigo é old-1) e 3 do vizinho
    await env.q(
      `INSERT INTO crm.inbound_webhook_requests (company_id, webhook_id, processing_status, raw_body, raw_body_truncated, body_size, body_hash, steps, created_at)
       SELECT $1, $2, 'processed', 'old-' || g, false, 5, md5(g::text), '[]'::jsonb, now() - (interval '1 second' * (2000 - g))
       FROM generate_series(1, 1000) AS g ORDER BY g`,
      [owner.companyId, wh.id],
    )
    await env.q(
      `INSERT INTO crm.inbound_webhook_requests (company_id, webhook_id, processing_status, raw_body, raw_body_truncated, body_size, body_hash, steps, created_at)
       SELECT $1, $2, 'processed', 'viz-' || g, false, 5, md5(g::text), '[]'::jsonb, now() - interval '1 day'
       FROM generate_series(1, 3) AS g ORDER BY g`,
      [owner.companyId, neighbor.id],
    )
    expect(await countRequests(wh.id)).toBe(1000)

    const res = await postHook(env.app, wh.public_token, JSON.stringify({ novo: true }))
    expect(res.status, res.text).toBe(202)
    expect(await countRequests(wh.id)).toBe(1000)
    const bodies = (await listRequests(owner, wh.id)).map((r) => r.raw_body)
    expect(bodies).toHaveLength(1000)
    expect(bodies[0]).toBe(JSON.stringify({ novo: true })) // mais recentes primeiro
    expect(bodies).not.toContain('old-1')
    expect(bodies).toContain('old-2')
    expect(bodies).toContain('old-1000')

    // o seguinte remove o próximo mais antigo
    expect((await postHook(env.app, wh.public_token, JSON.stringify({ novo: 2 }))).status).toBe(202)
    const after = (await listRequests(owner, wh.id)).map((r) => r.raw_body)
    expect(after).toHaveLength(1000)
    expect(after).not.toContain('old-2')
    expect(after).toContain('old-3')

    expect(await countRequests(neighbor.id)).toBe(3)
    const got = await owner.c.get(`/api/inbound-webhooks/${wh.id}`)
    expect(got.body.webhook.request_stats).toMatchObject({ total: 1000, retention_max: 1000 })
  })

  it('AC-T72-04 retenção vale também para requests ignorados (webhook inativo)', async () => {
    const owner = await newOwner(env)
    const wh = await newWebhook(owner, { active: false })
    await env.q(
      `INSERT INTO crm.inbound_webhook_requests (company_id, webhook_id, processing_status, raw_body, raw_body_truncated, body_size, body_hash, steps, created_at)
       SELECT $1, $2, 'skipped', 'old-' || g, false, 5, md5(g::text), '[]'::jsonb, now() - (interval '1 second' * (2000 - g))
       FROM generate_series(1, 1000) AS g ORDER BY g`,
      [owner.companyId, wh.id],
    )
    const res = await postHook(env.app, wh.public_token)
    expect(res.status, res.text).toBe(202)
    expect(res.body.status).toBe('skipped')
    expect(await countRequests(wh.id)).toBe(1000)
    expect((await listRequests(owner, wh.id)).map((r) => r.raw_body)).not.toContain('old-1')
  })
})
