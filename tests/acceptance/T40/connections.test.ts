// AC-T40-01..05 pela API HTTP (app.request) com FakeWaGateway, mais os extras combinados com o Cinzel
// (resolver por sessão, desativação da empresa pausando as sessões, FK chats.connection_id).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, member, owner, setLimit, startEnv, type Env, type User } from './setup'

let env: Env
let A: User
let B: User

beforeAll(async () => {
  env = await startEnv()
  A = await owner(env)
  B = await owner(env)
}, 120_000)

afterAll(async () => {
  await env?.close()
})

const sessionState = async (sessionId: string) => (await env.gateway.sessions.get(sessionId)).status

describe('T40 — criação e limite (AC-T40-01)', () => {
  it('AC-T40-01 criar conexão cria a sessão no gateway e o vínculo crm.connections', async () => {
    const r = await A.c.post('/api/connections', { name: 'Vendas' })
    expect(r.status, r.text).toBe(201)
    const conn = r.body.connection
    expect(conn).toMatchObject({ name: 'Vendas' })
    expect(typeof conn.id).toBe('string')
    expect(typeof conn.session_id).toBe('string')
    const s = await env.gateway.sessions.get(conn.session_id)
    expect(s?.id).toBe(conn.session_id)
    const [row] = await env.q(`SELECT company_id, session_id FROM crm.connections WHERE id = $1`, [conn.id])
    expect(row).toEqual({ company_id: A.companyId, session_id: conn.session_id })
  })

  it('AC-T40-01 sem limite definido não há teto', async () => {
    const owner2 = await owner(env)
    for (let i = 0; i < 6; i++) expect((await owner2.c.post('/api/connections', { name: `Livre ${i}` })).status).toBe(201)
  })

  it('AC-T40-01 com limite definido pelo admin e atingido → 409 LIMIT_REACHED (sem criar sessão)', async () => {
    const o = await owner(env)
    await createConnection(o, 'Primeira')
    await createConnection(o, 'Segunda')
    await setLimit(env, o.companyId, 2)
    const before = (await env.gateway.sessions.list()).length
    const r = await o.c.post('/api/connections', { name: 'Terceira' })
    expect(r.status, r.text).toBe(409)
    expect(r.body.error.code).toBe('LIMIT_REACHED')
    expect(r.body.error.details).toMatchObject({ limit: 2, used: 2 })
    expect((await env.gateway.sessions.list()).length).toBe(before)
    // limite maior libera; null volta a ilimitado
    await setLimit(env, o.companyId, 3)
    expect((await o.c.post('/api/connections', { name: 'Terceira' })).status).toBe(201)
    await setLimit(env, o.companyId, null)
    expect((await o.c.post('/api/connections', { name: 'Quarta' })).status).toBe(201)
  })

  it('AC-T40-01 nome fora de 2–100 caracteres → 422', async () => {
    for (const name of ['a', 'x'.repeat(101), '']) {
      const r = await A.c.post('/api/connections', { name })
      expect(r.status, `name ${name.length}`).toBe(422)
      expect(r.body.error.code).toBe('VALIDATION_ERROR')
    }
  })
})

describe('T40 — QR e pareamento (AC-T40-02)', () => {
  it('AC-T40-02 GET /:id/qr devolve o QR mais recente do gateway (null antes de conectar)', async () => {
    const conn = await createConnection(A)
    const before = await A.c.get(`/api/connections/${conn.id}/qr`)
    expect(before.status, before.text).toBe(200)
    expect(before.body.qr_code ?? null).toBeNull()
    expect((await A.c.post(`/api/connections/${conn.id}/connect`)).status).toBe(200)
    const fromGateway = await env.gateway.sessions.getQr(conn.session_id)
    const r = await A.c.get(`/api/connections/${conn.id}/qr`)
    expect(r.status).toBe(200)
    expect(r.body.qr_code).toBe(fromGateway.qr)
    expect(r.body.qr_code).toBeTruthy()
  })

  it('AC-T40-02 pairing-code com número inválido → 422; válido → código', async () => {
    const conn = await createConnection(A)
    // (o '+' inicial é tolerado; a regra ^[1-9]\d{6,14}$ vale para os dígitos)
    for (const phone of ['0123456789', '12345', '+0123456789', '55 11 99999-0000', 'abc', '1234567890123456', '']) {
      const r = await A.c.post(`/api/connections/${conn.id}/pairing-code`, { phone })
      expect(r.status, `phone ${JSON.stringify(phone)}`).toBe(422)
      expect(r.body.error.code).toBe('VALIDATION_ERROR')
    }
    const ok = await A.c.post(`/api/connections/${conn.id}/pairing-code`, { phone: '5511999990000' })
    expect(ok.status, ok.text).toBe(200)
    expect(typeof ok.body.code).toBe('string')
    expect(ok.body.code.length).toBeGreaterThan(0)
  })
})

describe('T40 — status de UI (AC-T40-03)', () => {
  /** Leva a sessão ao estado do gateway e as colunas projetadas da conexão ao caso pedido. */
  async function arrange(state: string, connectionState: string | null, reason: string | null) {
    const conn = await createConnection(A)
    if (state !== 'NEW') await env.gateway.setSessionState(conn.session_id, state)
    await env.q(`UPDATE crm.connections SET connection_state = $2, last_disconnect_reason = $3 WHERE id = $1`, [conn.id, connectionState, reason])
    const r = await A.c.get(`/api/connections/${conn.id}`)
    expect(r.status, r.text).toBe(200)
    return r.body.connection
  }

  const CASES: Array<[string, string, string | null, string | null, string, string[]]> = [
    ['STABLE + aberto → connected', 'STABLE', 'open', null, 'connected', []],
    ['WARMING + aberto → connected com badge warming', 'WARMING', 'open', null, 'connected', ['warming']],
    ['DEGRADED + aberto → connected com badge degraded', 'DEGRADED', 'open', null, 'connected', ['degraded']],
    ['STABLE + queda transitória → connecting', 'STABLE', 'close', 'transient', 'connecting', []],
    ['PAUSED → paused', 'PAUSED', 'open', null, 'paused', []],
    ['DISCONNECTED + loggedOut → disconnected', 'DISCONNECTED', 'close', 'loggedOut', 'disconnected', []],
    ['DISCONNECTED + forbidden → banned', 'DISCONNECTED', 'close', 'forbidden', 'banned', []],
    ['PAUSED + forbidden → banned', 'PAUSED', 'close', 'forbidden', 'banned', []],
    ['NEW sem pedir QR → pending', 'NEW', null, null, 'pending', []],
  ]

  for (const [name, state, cstate, reason, status, badges] of CASES) {
    it(`AC-T40-03 ${name}`, async () => {
      const conn = await arrange(state, cstate, reason)
      expect(conn.status).toBe(status)
      expect(conn.session_state).toBe(state)
      for (const b of badges) expect(conn.badges).toContain(b)
      if (status === 'connected' && !badges.includes('warming')) expect(conn.badges ?? []).not.toContain('warming')
    })
  }

  it('AC-T40-03 NEW depois de pedir QR → connecting', async () => {
    const conn = await createConnection(A)
    expect((await A.c.get(`/api/connections/${conn.id}`)).body.connection.status).toBe('pending')
    await A.c.post(`/api/connections/${conn.id}/connect`)
    await env.gateway.setSessionState(conn.session_id, 'NEW').catch(() => undefined)
    const after = (await A.c.get(`/api/connections/${conn.id}`)).body.connection
    expect(['connecting', 'connected']).toContain(after.status)
    if (after.session_state === 'NEW') expect(after.status).toBe('connecting')
  })

  it('AC-T40-03 deriveConnectionStatus (função pura) segue o mesmo mapeamento', async () => {
    const core: any = await import('@crm/core')
    const d = core.deriveConnectionStatus
    expect(typeof d).toBe('function')
    const s = (x: unknown) => (typeof x === 'string' ? x : (x as any)?.status)
    expect(s(d({ sessionState: 'STABLE', connectionState: 'open', lastDisconnectReason: null }))).toBe('connected')
    expect(s(d({ sessionState: 'STABLE', connectionState: null, lastDisconnectReason: null }))).toBe('connected')
    expect(s(d({ sessionState: 'PAUSED', connectionState: 'open', lastDisconnectReason: null }))).toBe('paused')
    expect(s(d({ sessionState: 'DISCONNECTED', connectionState: 'close', lastDisconnectReason: 'loggedOut' }))).toBe('disconnected')
    expect(s(d({ sessionState: 'DISCONNECTED', connectionState: 'close', lastDisconnectReason: 'forbidden' }))).toBe('banned')
  })

  it('AC-T40-03 a lista traz status_counts coerentes com os itens e filtra por status', async () => {
    const o = await owner(env)
    const c1 = await createConnection(o)
    const c2 = await createConnection(o)
    await env.gateway.setSessionState(c2.session_id, 'PAUSED')
    void c1
    const r = await o.c.get('/api/connections')
    expect(r.status).toBe(200)
    const counts = r.body.status_counts
    for (const k of ['pending', 'connecting', 'connected', 'paused', 'disconnected', 'banned']) expect(typeof counts[k]).toBe('number')
    expect(counts.paused).toBe(1)
    expect(counts.pending).toBe(1)
    const paused = await o.c.get('/api/connections?status=paused')
    expect(paused.body.items.map((i: any) => i.id)).toEqual([c2.id])
  })
})

describe('T40 — proxy (AC-T40-04)', () => {
  const SECRET = 'S3nh@-Do-Proxy-T40'

  it('AC-T40-04 a resposta mostra só host, porta, usuário e has_password; alterar marca requer reinício', async () => {
    const conn = await createConnection(A)
    expect(conn.requires_restart ?? false).toBe(false)
    const r = await A.c.post(`/api/connections/${conn.id}/proxy`, { protocol: 'http', host: 'proxy.t40.test', port: 3128, username: 'usuario', password: SECRET })
    expect(r.status, r.text).toBe(200)
    expect(r.text).not.toContain(SECRET)
    const c = r.body.connection
    expect(c.proxy).toEqual({ protocol: 'http', host: 'proxy.t40.test', port: 3128, username: 'usuario', has_password: true })
    expect(c.requires_restart).toBe(true)
    expect(c.badges).toContain('requires_restart')

    for (const path of [`/api/connections/${conn.id}`, '/api/connections']) {
      const g = await A.c.get(path)
      expect(g.text, path).not.toContain(SECRET)
    }
    const [row] = await env.q(`SELECT t::text AS dump FROM crm.connections t WHERE id = $1`, [conn.id])
    expect(row.dump, 'senha do proxy em texto puro no banco').not.toContain(SECRET)
  })

  it('AC-T40-04 proxy sem senha → has_password false; DELETE remove e também marca requer reinício', async () => {
    const conn = await createConnection(A)
    const r = await A.c.post(`/api/connections/${conn.id}/proxy`, { protocol: 'socks5', host: '10.0.0.9', port: 1080 })
    expect(r.status, r.text).toBe(200)
    expect(r.body.connection.proxy).toMatchObject({ protocol: 'socks5', host: '10.0.0.9', port: 1080, has_password: false })
    await env.q(`UPDATE crm.connections SET requires_restart = false WHERE id = $1`, [conn.id]).catch(() => undefined)
    const d = await A.c.delete(`/api/connections/${conn.id}/proxy`)
    expect(d.status, d.text).toBe(200)
    expect(d.body.connection.proxy).toBeNull()
    expect(d.body.connection.requires_restart).toBe(true)
  })
})

describe('T40 — isolamento e permissões (AC-T40-05)', () => {
  it('AC-T40-05 conexão de outra empresa → 404 em leitura e ações', async () => {
    const conn = await createConnection(A)
    for (const [method, path] of [
      ['get', `/api/connections/${conn.id}`],
      ['put', `/api/connections/${conn.id}`],
      ['post', `/api/connections/${conn.id}/connect`],
      ['post', `/api/connections/${conn.id}/restart`],
      ['get', `/api/connections/${conn.id}/qr`],
      ['post', `/api/connections/${conn.id}/proxy`],
    ] as const) {
      const r = await (B.c as any)[method](path, method === 'get' ? undefined : { name: 'x', protocol: 'http', host: 'h', port: 1 })
      expect(r.status, `${method} ${path}`).toBe(404)
      expect(r.body.error.code).toBe('NOT_FOUND')
    }
    expect((await B.c.get('/api/connections')).body.items.map((i: any) => i.id)).not.toContain(conn.id)
  })

  it('AC-T40-05 membro sem connections.edit → 403 em connect e restart (vê com connections.view)', async () => {
    const conn = await createConnection(A)
    const viewer = await member(env, A.companyId, ['connections.view'])
    expect((await viewer.c.get(`/api/connections/${conn.id}`)).status).toBe(200)
    for (const action of ['connect', 'restart']) {
      const r = await viewer.c.post(`/api/connections/${conn.id}/${action}`)
      expect(r.status, action).toBe(403)
      expect(r.body.error.code).toBe('FORBIDDEN')
    }
    const editor = await member(env, A.companyId, ['connections.view', 'connections.edit'])
    expect((await editor.c.post(`/api/connections/${conn.id}/connect`)).status).toBe(200)
    expect((await editor.c.post(`/api/connections/${conn.id}/restart`)).status).toBe(200)
  })

  it('AC-T40-05 membro sem connections.view não lista conexões (403)', async () => {
    const nobody = await member(env, A.companyId, ['contacts.view'])
    expect((await nobody.c.get('/api/connections')).status).toBe(403)
  })
})

describe('T40 — extras combinados (resolver, desativação, FK)', () => {
  it('T40 connectionBySession(db, sessionId) acha a conexão e a empresa pela sessão', async () => {
    const conn = await createConnection(A)
    const core: any = await import('@crm/core')
    expect(typeof core.connectionBySession).toBe('function')
    const r = await core.connectionBySession(env.db, conn.session_id)
    expect(JSON.stringify(r)).toContain(conn.id)
    expect(JSON.stringify(r)).toContain(A.companyId)
    expect(await core.connectionBySession(env.db, 'sessao-que-nao-existe')).toBeFalsy()
  })

  it('T40 FK chats.connection_id → crm.connections com ON DELETE RESTRICT', async () => {
    const rows = await env.q(
      `SELECT confdeltype, confrelid::regclass::text AS ref FROM pg_constraint
        WHERE conrelid = 'crm.chats'::regclass AND contype = 'f'
          AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'crm.chats'::regclass AND attname = 'connection_id')]`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].ref).toBe('crm.connections')
    expect(rows[0].confdeltype).toBe('r')
  })

  it('T40 desativar a empresa pausa as sessões das conexões dela no gateway', async () => {
    const o = await owner(env)
    const c1 = await createConnection(o)
    const c2 = await createConnection(o)
    const other = await createConnection(A)
    await env.gateway.setSessionState(c1.session_id, 'STABLE')
    await env.gateway.setSessionState(c2.session_id, 'WARMING')
    await env.gateway.setSessionState(other.session_id, 'STABLE')
    const r = await o.c.delete(`/api/companies/${o.companyId}`)
    expect(r.status, r.text).toBeLessThan(300)
    expect([...(r.body.paused_session_ids ?? [])].sort()).toEqual([c1.session_id, c2.session_id].sort())
    expect(await sessionState(c1.session_id)).toBe('PAUSED')
    expect(await sessionState(c2.session_id)).toBe('PAUSED')
    expect(await sessionState(other.session_id)).toBe('STABLE')
  })
})
