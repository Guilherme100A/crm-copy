// AC-T20-01 (ordem e curto-circuito dos gates) e AC-T20-02 (consentimento/opt-out) no SendPipeline.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lit, sqlOk } from '../helpers/pg'
import { REDIS_URL, migratedWaDb, newSession, phone, queueMod, rand, safetyMod, sendMod, textReq, type WaDb } from './support'

const ORDER = ['auth', 'sessionExists', 'connected', 'contactAllowed', 'warmupLimit', 'rateLimit', 'enqueue']
const TABLE: Record<string, [string, number]> = {
  auth: ['UNAUTHORIZED', 401],
  sessionExists: ['SESSION_NOT_FOUND', 404],
  connected: ['SESSION_NOT_CONNECTED', 409],
  contactAllowed: ['CONTACT_NOT_ALLOWED', 403],
  warmupLimit: ['WARMUP_LIMIT', 429],
  rateLimit: ['RATE_LIMIT', 429],
}

let pg: WaDb
let S: any
let queue: any
let consent: any

beforeAll(async () => {
  S = await sendMod()
  const { MessageQueue } = await queueMod()
  pg = await migratedWaDb()
  // só produz (consume: false): o gate enqueue grava a mensagem `queued` sem enviar
  queue = new MessageQueue({ db: pg.db, connection: { url: REDIS_URL }, prefix: `t20${rand()}`, consume: false })
  queue.on?.('error', () => {})
  consent = new S.ConsentService(pg.db)
})

afterAll(async () => {
  await queue?.close().catch(() => {})
  await pg?.close()
})

const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: any) => e)

describe('T20 — ordem e curto-circuito dos gates (AC-T20-01)', () => {
  it('AC-T20-01 GATE_ORDER é auth → sessionExists → connected → contactAllowed → warmupLimit → rateLimit → enqueue', () => {
    expect([...S.GATE_ORDER]).toEqual(ORDER)
  })

  it('AC-T20-01 gates espiões são chamados exatamente nessa ordem quando todos passam', async () => {
    const calls: string[] = []
    const gates = Object.fromEntries(ORDER.map((g) => [g, async () => void calls.push(g)]))
    const p = new S.SendPipeline({ db: pg.db, gates })
    await p.send(textReq('qualquer', '+5511900000000'))
    expect(calls).toEqual(ORDER)
  })

  for (const [i, failing] of ORDER.slice(0, 6).entries()) {
    it(`AC-T20-01 falha em ${failing} interrompe a cadeia com ${TABLE[failing]![0]} (${TABLE[failing]![1]})`, async () => {
      const calls: string[] = []
      const [code] = TABLE[failing]!
      const gates = Object.fromEntries(
        ORDER.map((g) => [
          g,
          async () => {
            calls.push(g)
            if (g === failing) throw new S.SendRejectedError(code, `falha em ${g}`)
          },
        ]),
      )
      const p = new S.SendPipeline({ db: pg.db, gates })
      const err = await caught(p.send(textReq('qualquer', '+5511900000000')))
      expect(err).toBeInstanceOf(S.SendRejectedError)
      expect(err.code).toBe(TABLE[failing]![0])
      expect(err.status).toBe(TABLE[failing]![1])
      expect(err.gate).toBe(failing)
      expect(calls).toEqual(ORDER.slice(0, i + 1))
    })
  }

  describe('gates padrão devolvem o código e o HTTP da tabela', () => {
    const allow = async (to: string) => consent.recordConsent(to, 'manual')

    it('AC-T20-01 sem actor → UNAUTHORIZED 401', async () => {
      const p = new S.SendPipeline({ db: pg.db, queue })
      const err = await caught(p.send(textReq(newSession(pg.tmp.url), phone(), { actor: '' })))
      expect([err?.code, err?.status, err?.gate]).toEqual(['UNAUTHORIZED', 401, 'auth'])
    })

    it('AC-T20-01 sessão inexistente → SESSION_NOT_FOUND 404', async () => {
      const p = new S.SendPipeline({ db: pg.db, queue })
      const err = await caught(p.send(textReq('00000000-0000-4000-8000-000000000000', phone())))
      expect([err?.code, err?.status]).toEqual(['SESSION_NOT_FOUND', 404])
    })

    it('AC-T20-01 sessão PAUSED → SESSION_NOT_CONNECTED 409', async () => {
      const to = phone()
      await allow(to)
      const p = new S.SendPipeline({ db: pg.db, queue })
      const err = await caught(p.send(textReq(newSession(pg.tmp.url, { status: 'PAUSED' }), to)))
      expect([err?.code, err?.status, err?.gate]).toEqual(['SESSION_NOT_CONNECTED', 409, 'connected'])
    })

    it('AC-T20-01 limite de warm-up do dia atingido → WARMUP_LIMIT 429', async () => {
      const sid = newSession(pg.tmp.url, { status: 'WARMING', warmupDaysAgo: 0.1 })
      const p = new S.SendPipeline({ db: pg.db, queue, schedule: { day1Limit: 1 } })
      const to = phone()
      await allow(to)
      expect((await p.send(textReq(sid, to))).status).toBe('queued')
      const err = await caught(p.send(textReq(sid, to)))
      expect([err?.code, err?.status, err?.gate]).toEqual(['WARMUP_LIMIT', 429, 'warmupLimit'])
    })

    it('AC-T20-01 limite por minuto atingido → RATE_LIMIT 429', async () => {
      const { SessionLimitsService } = await safetyMod()
      const sid = newSession(pg.tmp.url)
      await new SessionLimitsService(pg.db).set(sid, { perMinute: 1 })
      const p = new S.SendPipeline({ db: pg.db, queue })
      const to = phone()
      await allow(to)
      expect((await p.send(textReq(sid, to))).status).toBe('queued')
      const err = await caught(p.send(textReq(sid, to)))
      expect([err?.code, err?.status, err?.gate]).toEqual(['RATE_LIMIT', 429, 'rateLimit'])
    })

    it('AC-T20-01 rejeição antes do enqueue não grava mensagem', async () => {
      const sid = newSession(pg.tmp.url, { status: 'PAUSED' })
      const p = new S.SendPipeline({ db: pg.db, queue })
      await caught(p.send(textReq(sid, phone())))
      expect(sqlOk(pg.tmp.url, `SELECT count(*) FROM public.messages WHERE session_id = ${lit(sid)};`)[0]![0]).toBe('0')
    })
  })
})

describe('T20 — consentimento e opt-out (AC-T20-02)', () => {
  it('AC-T20-02 contato inexistente ou sem consentimento → CONTACT_NOT_ALLOWED 403', async () => {
    const sid = newSession(pg.tmp.url)
    const p = new S.SendPipeline({ db: pg.db, queue })
    const unknown = await caught(p.send(textReq(sid, phone())))
    expect([unknown?.code, unknown?.status, unknown?.gate]).toEqual(['CONTACT_NOT_ALLOWED', 403, 'contactAllowed'])

    const to = phone()
    sqlOk(pg.tmp.url, `INSERT INTO public.contacts (name, phone) VALUES ('Sem consentimento', ${lit(to)});`)
    const noConsent = await caught(p.send(textReq(sid, to)))
    expect([noConsent?.code, noConsent?.status]).toEqual(['CONTACT_NOT_ALLOWED', 403])
  })

  it("AC-T20-02 após recordConsent(phone, 'inbound') o envio é aceito", async () => {
    const sid = newSession(pg.tmp.url)
    const to = phone()
    const p = new S.SendPipeline({ db: pg.db, queue })
    expect((await caught(p.send(textReq(sid, to))))?.code).toBe('CONTACT_NOT_ALLOWED')
    await consent.recordConsent(to, 'inbound')
    const row = sqlOk(pg.tmp.url, `SELECT consent::text, consent_source, opt_out::text FROM public.contacts WHERE phone = ${lit(to)};`)[0]!
    expect(row).toEqual(['true', 'inbound', 'false'])
    const view = await p.send(textReq(sid, to))
    expect(view.status).toBe('queued')
  })

  it('AC-T20-02 contato com opt_out = true → CONTACT_NOT_ALLOWED, mesmo com consentimento', async () => {
    const sid = newSession(pg.tmp.url)
    const to = phone()
    const p = new S.SendPipeline({ db: pg.db, queue })
    await consent.recordConsent(to, 'inbound')
    expect((await p.send(textReq(sid, to))).status).toBe('queued')
    await consent.optOut(to)
    expect(sqlOk(pg.tmp.url, `SELECT opt_out::text FROM public.contacts WHERE phone = ${lit(to)};`)[0]![0]).toBe('true')
    const blocked = await caught(p.send(textReq(sid, to)))
    expect([blocked?.code, blocked?.status]).toEqual(['CONTACT_NOT_ALLOWED', 403])
    // nova mensagem recebida (consentimento inbound) não desfaz o opt-out: o opt-out sempre bloqueia
    await consent.recordConsent(to, 'inbound')
    expect((await caught(p.send(textReq(sid, to))))?.code).toBe('CONTACT_NOT_ALLOWED')
  })

  it('AC-T20-02 opt_out gravado direto no banco também bloqueia', async () => {
    const sid = newSession(pg.tmp.url)
    const to = phone()
    sqlOk(pg.tmp.url, `INSERT INTO public.contacts (name, phone, consent, consent_source, opt_out) VALUES ('Saiu', ${lit(to)}, true, 'manual', true);`)
    const p = new S.SendPipeline({ db: pg.db, queue })
    expect((await caught(p.send(textReq(sid, to))))?.code).toBe('CONTACT_NOT_ALLOWED')
  })
})
