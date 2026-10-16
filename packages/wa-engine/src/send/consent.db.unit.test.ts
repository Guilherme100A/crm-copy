// Postgres real: ConsentService sobre public.contacts e o gate contactAllowed do pipeline (AC-T20-02).
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, sessions, type Database } from '../db'
import type { EnqueueMessageInput } from '../queue/store'
import { canMessage, ConsentError, ConsentService } from './consent'
import { SendPipeline, SendRejectedError } from './pipeline'

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, set: 'wa' })
  db = createDb(tmp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

let seq = 0
const phone = () => `+55119${String(10_000_000 + ++seq).slice(-8)}`

describe('canMessage', () => {
  it('inexistente, opt-out e sem consentimento não podem; com consentimento pode', () => {
    expect(canMessage(undefined)).toEqual({ ok: false, reason: 'contact_not_found' })
    expect(canMessage({ consent: true, optOut: true })).toEqual({ ok: false, reason: 'opt_out' })
    expect(canMessage({ consent: false, optOut: false })).toEqual({ ok: false, reason: 'no_consent' })
    expect(canMessage({ consent: true, optOut: false })).toEqual({ ok: true })
  })
})

describe('ConsentService', () => {
  const svc = () => new ConsentService(db)

  it('recordConsent cria ou atualiza o contato com origem e data', async () => {
    const p = phone()
    const at = new Date('2026-10-15T12:00:00.000Z')
    const c = await svc().recordConsent(p, 'import', { name: 'Ana', at })
    expect(c).toMatchObject({ phone: p, name: 'Ana', consent: true, consentSource: 'import', optOut: false })
    expect(c.consentAt?.toISOString()).toBe(at.toISOString())
    const again = await svc().recordConsent(p, 'inbound')
    expect(again).toMatchObject({ id: c.id, consentSource: 'inbound', name: 'Ana' })
    expect(await svc().canMessage(p)).toEqual({ ok: true })
  })

  it('opt-out sempre bloqueia; só um consentimento manual o reverte', async () => {
    const p = phone()
    await svc().recordConsent(p, 'inbound')
    await svc().optOut(p)
    expect(await svc().canMessage(p)).toEqual({ ok: false, reason: 'opt_out' })
    await svc().recordConsent(p, 'import')
    expect(await svc().canMessage(p)).toEqual({ ok: false, reason: 'opt_out' })
    await svc().recordConsent(p, 'manual')
    expect(await svc().canMessage(p)).toEqual({ ok: true })
  })

  it('opt-out de contato desconhecido cria o contato bloqueado; telefone inválido é recusado', async () => {
    const p = phone()
    expect(await svc().optOut(p)).toMatchObject({ phone: p, optOut: true, consent: false })
    await expect(svc().recordConsent('11999', 'manual')).rejects.toBeInstanceOf(ConsentError)
    await expect(svc().recordConsent(phone(), 'bogus' as never)).rejects.toBeInstanceOf(ConsentError)
  })
})

describe('SendPipeline + ConsentService (AC-T20-02)', () => {
  it('sem consentimento ou com opt-out → CONTACT_NOT_ALLOWED 403; após recordConsent(inbound) o envio é aceito', async () => {
    const [s] = await db.insert(sessions).values({ name: 's', status: 'STABLE' }).returning()
    const enqueued: EnqueueMessageInput[] = []
    const pipeline = new SendPipeline({
      db,
      queue: {
        enqueue: async (input) => {
          enqueued.push(input)
          return { id: 'm1', sessionId: input.sessionId, phone: input.phone, status: 'queued' } as never
        },
      },
    })
    const p = phone()
    const req = { sessionId: s!.id, phone: p, content: { text: 'oi' }, actor: 'crm:u1' }
    const err = await pipeline.send(req).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SendRejectedError)
    expect(err).toMatchObject({ code: 'CONTACT_NOT_ALLOWED', status: 403, gate: 'contactAllowed', details: { reason: 'contact_not_found' } })
    await pipeline.consent.recordConsent(p, 'inbound')
    await expect(pipeline.send(req)).resolves.toMatchObject({ status: 'queued' })
    expect(enqueued).toHaveLength(1)
    await pipeline.consent.optOut(p)
    await expect(pipeline.send(req)).rejects.toMatchObject({ code: 'CONTACT_NOT_ALLOWED', details: { reason: 'opt_out' } })
  })
})
