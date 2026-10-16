// AC-T47-01..05: projeção dos eventos de sessão do WhatsApp em crm.connections, eventos SSE, pausa de runs de fluxo
// e e-mail de desconexão. Caixa-preta: WaEvent no stream do consumidor (XADD) → banco, RealtimePublisher e MemoryMailer.
// Ambiente e contrato em ./support.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ALERT_WINDOW_MS,
  APP_NAME,
  closeConnection,
  mailsAbout,
  openConnection,
  rand,
  recipients,
  seedRun,
  sleep,
  startEnv,
  waitFor,
  type Company,
  type Env,
} from './support'

let env: Env
let company: Company

beforeAll(async () => {
  env = await startEnv()
  company = await env.newCompany()
}, 180_000)

afterAll(async () => {
  await env?.close()
})

/** Cada teste num instante bem distante do anterior (o dedupe é por janela de 5 s no relógio injetado). */
const nextHour = () => env.advance(60 * 60_000)

describe('AC-T47-01 queda transitória', () => {
  it('AC-T47-01 close transient → connection.disconnected com disconnected_at = at do evento e colunas projetadas', async () => {
    nextHour()
    const conn = await env.newConnection(company.id)
    await openConnection(env, conn, company.id)
    env.advance(1_000)
    const at = env.iso()
    await closeConnection(env, conn, company.id, { reason: 'transient', status_code: 428 })

    const [ev] = await env.events(company.id, 'connection.disconnected', conn.id)
    expect(ev!.data).toMatchObject({ connection_id: conn.id, session_id: conn.sessionId, name: conn.name, reason: 'transient', status_code: 428 })
    expect(new Date(ev!.data.disconnected_at).toISOString()).toBe(at)
    expect(ev!.company_id).toBe(company.id)

    const row = await env.row(conn.id)
    expect(row.connection_state).toBe('close')
    expect(row.last_disconnect_reason).toBe('transient')
    expect(row.last_status_code).toBe(428)
    expect(new Date(row.disconnected_at).toISOString()).toBe(at)
  })

  it('AC-T47-01 connection.disconnected_alert sai uma vez em 5 s (mesmo com closes repetidos) e volta a sair depois da janela', async () => {
    nextHour()
    const conn = await env.newConnection(company.id)
    await openConnection(env, conn, company.id)
    const alerts = () => env.events(company.id, 'connection.disconnected_alert', conn.id)

    env.advance(1_000)
    await closeConnection(env, conn, company.id)
    await waitFor(async () => (await alerts()).length === 1, 'primeiro disconnected_alert')
    expect((await alerts())[0]!.data).toMatchObject({ connection_id: conn.id, session_id: conn.sessionId, reason: 'transient' })

    // dentro da janela: dois closes (1 s e 4,9 s depois do primeiro) → nenhum alerta novo
    env.advance(1_000)
    await closeConnection(env, conn, company.id)
    env.advance(ALERT_WINDOW_MS - 1_100)
    await closeConnection(env, conn, company.id)
    await sleep(500)
    expect(await alerts()).toHaveLength(1)
    expect(await env.events(company.id, 'connection.disconnected', conn.id)).toHaveLength(3)

    // fora da janela (> 5 s desde o primeiro alerta) → novo alerta
    env.advance(1_000)
    await closeConnection(env, conn, company.id)
    await waitFor(async () => (await alerts()).length === 2, 'segundo disconnected_alert após a janela')
  })

  it('AC-T47-01 o dedupe do alerta é por conexão: quedas simultâneas de duas conexões geram um alerta cada', async () => {
    nextHour()
    const a = await env.newConnection(company.id)
    const b = await env.newConnection(company.id)
    await openConnection(env, a, company.id)
    await openConnection(env, b, company.id)
    env.advance(1_000)
    await closeConnection(env, a, company.id)
    await closeConnection(env, b, company.id)
    await waitFor(async () => (await env.events(company.id, 'connection.disconnected_alert', a.id)).length === 1, 'alerta de A')
    await waitFor(async () => (await env.events(company.id, 'connection.disconnected_alert', b.id)).length === 1, 'alerta de B')
  })
})

describe('AC-T47-02 banimento e logout', () => {
  it('AC-T47-02 close forbidden → status banned + connection.banned_alert (sem disconnected_alert)', async () => {
    nextHour()
    const conn = await env.newConnection(company.id)
    await openConnection(env, conn, company.id)
    env.advance(1_000)
    await closeConnection(env, conn, company.id, { reason: 'forbidden', status_code: 403 })

    const [disc] = await env.events(company.id, 'connection.disconnected', conn.id)
    expect(disc!.data).toMatchObject({ connection_id: conn.id, reason: 'forbidden', status_code: 403, status: 'banned' })
    const banned = await waitFor(async () => (await env.events(company.id, 'connection.banned_alert', conn.id))[0], 'connection.banned_alert')
    expect(banned.data).toMatchObject({ connection_id: conn.id, session_id: conn.sessionId, reason: 'forbidden', status: 'banned' })
    await sleep(300)
    expect(await env.events(company.id, 'connection.disconnected_alert', conn.id)).toEqual([])

    // o status de UI publicado também é banned
    const changes = await env.events(company.id, 'connection.status_changed', conn.id)
    expect(changes.at(-1)?.data).toMatchObject({ connection_id: conn.id, status: 'banned' })

    const row = await env.row(conn.id)
    expect(row.connection_state).toBe('close')
    expect(row.last_disconnect_reason).toBe('forbidden')
    expect(row.last_status_code).toBe(403)
  })

  it('AC-T47-02 close loggedOut → status disconnected + disconnected_alert (não é banimento)', async () => {
    nextHour()
    const conn = await env.newConnection(company.id)
    await openConnection(env, conn, company.id)
    env.advance(1_000)
    await closeConnection(env, conn, company.id, { reason: 'loggedOut', status_code: 401 })

    const [disc] = await env.events(company.id, 'connection.disconnected', conn.id)
    expect(disc!.data).toMatchObject({ connection_id: conn.id, reason: 'loggedOut', status: 'disconnected' })
    await waitFor(async () => (await env.events(company.id, 'connection.disconnected_alert', conn.id)).length === 1, 'disconnected_alert do loggedOut')
    await sleep(300)
    expect(await env.events(company.id, 'connection.banned_alert', conn.id)).toEqual([])
    const changes = await env.events(company.id, 'connection.status_changed', conn.id)
    expect(changes.at(-1)?.data).toMatchObject({ connection_id: conn.id, status: 'disconnected' })
    expect((await env.row(conn.id)).last_disconnect_reason).toBe('loggedOut')
  })
})

describe('AC-T47-03 runs de fluxo na queda e na volta', () => {
  it('AC-T47-03 a queda pausa só os runs waiting da conexão (flow.auto_paused) e a volta publica reconnected_with_paused_flows com a contagem', async () => {
    nextHour()
    const conn = await env.newConnection(company.id)
    const other = await env.newConnection(company.id)
    await openConnection(env, conn, company.id)
    await openConnection(env, other, company.id)

    const w1 = await seedRun(env, company.id, conn.id, 'waiting')
    const w2 = await seedRun(env, company.id, conn.id, 'waiting', w1.flowId)
    const running = await seedRun(env, company.id, conn.id, 'running', w1.flowId)
    const elsewhere = await seedRun(env, company.id, other.id, 'waiting', w1.flowId)

    env.advance(1_000)
    await closeConnection(env, conn, company.id)
    const paused = await waitFor(async () => (await env.events(company.id, 'flow.auto_paused', conn.id))[0], 'flow.auto_paused')
    expect(paused.data).toMatchObject({ connection_id: conn.id, session_id: conn.sessionId, paused_count: 2 })
    expect([...paused.data.run_ids].sort()).toEqual([w1.runId, w2.runId].sort())

    const status = async (id: string) => (await env.q(`SELECT status FROM crm.flow_runs WHERE id = $1`, [id]))[0].status
    expect(await status(w1.runId)).toBe('paused')
    expect(await status(w2.runId)).toBe('paused')
    expect(await status(running.runId)).toBe('running')
    expect(await status(elsewhere.runId)).toBe('waiting')

    // reconexão (session.state WARMING chega alguns ms antes do session.connection open)
    env.advance(60_000)
    await openConnection(env, conn, company.id)
    const back = await waitFor(
      async () => (await env.events(company.id, 'connection.reconnected_with_paused_flows', conn.id))[0],
      'connection.reconnected_with_paused_flows',
    )
    expect(back.data).toMatchObject({ connection_id: conn.id, session_id: conn.sessionId, paused_count: 2, total_leads: 2 })
  })

  it('AC-T47-03 queda sem runs waiting não publica flow.auto_paused e a volta não publica reconnected_with_paused_flows', async () => {
    nextHour()
    const conn = await env.newConnection(company.id)
    await openConnection(env, conn, company.id)
    await seedRun(env, company.id, conn.id, 'running')
    env.advance(1_000)
    await closeConnection(env, conn, company.id)
    env.advance(60_000)
    await openConnection(env, conn, company.id)
    await sleep(500)
    expect(await env.events(company.id, 'flow.auto_paused', conn.id)).toEqual([])
    expect(await env.events(company.id, 'connection.reconnected_with_paused_flows', conn.id)).toEqual([])
  })
})

describe('AC-T47-04 e-mail de desconexão', () => {
  const expectMail = (m: Record<string, unknown>, conn: { name: string }) => {
    const all = [m.subject, m.text, m.html].filter((s): s is string => typeof s === 'string').join('\n')
    expect(String(m.subject)).toContain(APP_NAME)
    expect(all).toContain(conn.name)
    expect(all).not.toMatch(/api\s+oficial/i)
  }

  it('AC-T47-04 uma queda → um e-mail para owner e admin (não member), com APP_NAME e sem "API Oficial"; close repetido não reenvia', async () => {
    nextHour()
    const conn = await env.newConnection(company.id, { name: `Vendas ${rand(3)}` })
    await openConnection(env, conn, company.id)
    env.advance(1_000)
    await closeConnection(env, conn, company.id)
    const mails = await waitFor(async () => {
      const m = mailsAbout(env.mailer, conn.name)
      return m.length ? m : undefined
    }, 'e-mail de desconexão')
    await sleep(500)

    const sent = mailsAbout(env.mailer, conn.name)
    const to = sent.flatMap(recipients)
    // cada destinatário recebe exatamente uma vez nesta queda
    expect([...to].sort()).toEqual([company.owner, company.admin].map((e) => e.toLowerCase()).sort())
    expect(to).not.toContain(company.member.toLowerCase())
    for (const m of mails) expectMail(m, conn)

    // mais closes da mesma queda (inclusive fora da janela de 5 s) → nenhum e-mail novo
    env.advance(1_000)
    await closeConnection(env, conn, company.id)
    env.advance(ALERT_WINDOW_MS * 3)
    await closeConnection(env, conn, company.id)
    await sleep(500)
    expect(mailsAbout(env.mailer, conn.name)).toHaveLength(sent.length)
  })

  it('AC-T47-04 abrir e cair de novo é outra queda: novo e-mail', async () => {
    nextHour()
    const conn = await env.newConnection(company.id, { name: `Suporte ${rand(3)}` })
    await openConnection(env, conn, company.id)
    env.advance(1_000)
    await closeConnection(env, conn, company.id)
    const first = await waitFor(async () => mailsAbout(env.mailer, conn.name).length || undefined, 'e-mail da 1ª queda')
    await sleep(300)
    const firstCount = mailsAbout(env.mailer, conn.name).length
    expect(firstCount).toBe(first)

    env.advance(60_000)
    await openConnection(env, conn, company.id)
    env.advance(1_000)
    await closeConnection(env, conn, company.id)
    await waitFor(async () => mailsAbout(env.mailer, conn.name).length > firstCount || undefined, 'e-mail da 2ª queda')
    await sleep(300)
    expect(mailsAbout(env.mailer, conn.name)).toHaveLength(firstCount * 2)
  })

  it('AC-T47-04 empresa com connection_status_emails_enabled = false não recebe e-mail (os eventos continuam)', async () => {
    nextHour()
    const quiet = await env.newCompany({ connection_status_emails_enabled: false })
    const conn = await env.newConnection(quiet.id, { name: `Silenciosa ${rand(3)}` })
    await openConnection(env, conn, quiet.id)
    env.advance(1_000)
    await closeConnection(env, conn, quiet.id)
    await waitFor(async () => (await env.events(quiet.id, 'connection.disconnected_alert', conn.id)).length === 1, 'alerta da empresa silenciosa')
    await sleep(800)
    expect(mailsAbout(env.mailer, conn.name)).toEqual([])
    const quietTo = (env.mailer.messages as unknown[]).flatMap(recipients)
    expect(quietTo).not.toContain(quiet.owner.toLowerCase())
    expect(quietTo).not.toContain(quiet.admin.toLowerCase())
  })
})

describe('AC-T47-05 sessão sem conexão do CRM', () => {
  it('AC-T47-05 eventos de sessão sem crm.connections correspondente são ignorados: nada gravado e nenhuma empresa recebe evento', async () => {
    nextHour()
    const orphan = `t47-orfa-${rand(6)}`
    const keysBefore = (await env.rtKeys()).filter((k) => !k.endsWith(':channel')).sort()
    const lenBefore = new Map<string, number>()
    for (const k of keysBefore) lenBefore.set(k, Number(await env.redis.xlen(k)))
    const rowsBefore = await env.q(`SELECT id, connection_state, disconnected_at, connected_at, qr_requested_at, updated_at FROM crm.connections ORDER BY id`)

    await env.emit({ type: 'session.state', session_id: orphan, from: 'STABLE', to: 'DEGRADED' })
    await env.emit({ type: 'session.qr', session_id: orphan, qr: 'data:image/png;base64,AAAA' })
    await env.emit({ type: 'session.pairing_code', session_id: orphan, code: 'ABCD1234' })
    await env.connectionEvent(orphan, 'open')
    env.advance(1_000)
    await env.connectionEvent(orphan, 'close', { reason: 'forbidden', status_code: 403 })

    // sentinela: um evento válido emitido DEPOIS; quando o efeito dele aparece, os órfãos já passaram pelo consumidor
    const sentinel = await env.newConnection(company.id)
    await openConnection(env, sentinel, company.id)

    const keysAfter = (await env.rtKeys()).filter((k) => !k.endsWith(':channel')).sort()
    expect(keysAfter.filter((k) => !keysBefore.includes(k) && k !== `${env.rtPrefix}:${company.id}`)).toEqual([])
    for (const k of keysAfter) {
      const entries: Array<[string, string[]]> = await env.redis.xrange(k, '-', '+')
      const leaked = entries.filter(([, flat]) => flat.join('\u0000').includes(orphan))
      expect(leaked, `evento da sessão órfã publicado em ${k}`).toEqual([])
    }
    // nenhuma empresa além da do sentinela recebeu algo novo
    for (const k of keysBefore.filter((k) => k !== `${env.rtPrefix}:${company.id}`)) expect(Number(await env.redis.xlen(k))).toBe(lenBefore.get(k))

    expect(await env.q(`SELECT 1 FROM crm.connections WHERE session_id = $1`, [orphan])).toEqual([])
    const rowsAfter = await env.q(
      `SELECT id, connection_state, disconnected_at, connected_at, qr_requested_at, updated_at FROM crm.connections WHERE id <> $1 ORDER BY id`,
      [sentinel.id],
    )
    expect(rowsAfter).toEqual(rowsBefore)
    expect((env.mailer.messages as unknown[]).filter((m) => JSON.stringify(m).includes(orphan))).toEqual([])
  })
})
