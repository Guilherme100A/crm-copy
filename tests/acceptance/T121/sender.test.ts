// AC-T121-03: MESSAGE_SENDER_TYPES contém `flow`; recordOutbound grava sender_type `flow` e isso tipa sem cast.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureConnection } from '../helpers/connections'
import { exec, tail } from '../helpers/exec'

let tmp: any
let db: any
const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows

beforeAll(async () => {
  const { createDb }: any = await import('@crm/db')
  const { createTempDatabase }: any = await import('@crm/db/testing')
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url)
}, 120_000)

afterAll(async () => {
  await db?.$client?.end?.().catch(() => {})
  await tmp?.drop?.().catch(() => {})
})

describe('T121 — remetente flow (AC-T121-03)', () => {
  it('AC-T121-03 MESSAGE_SENDER_TYPES contém flow', async () => {
    const { MESSAGE_SENDER_TYPES }: any = await import('@crm/db')
    expect(Array.isArray(MESSAGE_SENDER_TYPES) || Object.isFrozen(MESSAGE_SENDER_TYPES)).toBe(true)
    expect([...MESSAGE_SENDER_TYPES]).toContain('flow')
    expect([...MESSAGE_SENDER_TYPES]).toContain('system')
  })

  it('AC-T121-03 recordOutbound grava a mensagem com sender_type flow (sem reenviar)', async () => {
    const core: any = await import('@crm/core')
    const { FakeWaGateway }: any = await import('@crm/wa-port/testing')
    const [co] = await q(`INSERT INTO crm.companies (name, slug) VALUES ('Empresa T121', $1) RETURNING id`, [`t121-${randomUUID().slice(0, 8)}`])
    const [ct] = await q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, 'Contato T121', '+5511999990121') RETURNING id`, [co.id])
    const connectionId = await ensureConnection(q, co.id)
    const [ch] = await q(`INSERT INTO crm.chats (company_id, connection_id, contact_id) VALUES ($1, $2, $3) RETURNING id`, [co.id, connectionId, ct.id])
    const gateway = new FakeWaGateway()
    const svc = new core.ChatSendService({ db, waGateway: gateway, resolveSession: async () => 'sess-t121', media: {}, pttConverter: {} })
    const now = new Date().toISOString()
    const view = {
      id: randomUUID(),
      sessionId: 'sess-t121',
      contactId: null,
      phone: '+5511999990121',
      content: { text: 'mensagem do fluxo T121' },
      status: 'sent',
      attempts: 1,
      lastError: null,
      transportMessageId: 'WA-T121',
      sentAt: now,
      deliveredAt: null,
      readAt: null,
      createdAt: now,
      updatedAt: now,
    }
    const dto = await svc.recordOutbound({ companyId: co.id, chatId: ch.id, senderType: 'flow', actor: 'flow:run-t121', content: { text: 'mensagem do fluxo T121' }, view })
    expect(dto.sender_type ?? dto.senderType).toBe('flow')
    const rows = await q(`SELECT sender_type, body FROM crm.messages WHERE chat_id = $1`, [ch.id])
    expect(rows).toEqual([{ sender_type: 'flow', body: 'mensagem do fluxo T121' }])
    expect(gateway.sent, 'recordOutbound não pode reenviar pelo gateway').toHaveLength(0)
  })

  it('AC-T121-03 gravar sender_type flow por recordOutbound tipa sem cast (tsc), e remetente inválido não compila', () => {
    const ok = exec('pnpm exec tsc -p tests/acceptance/T121/fixtures/tsconfig.json', { timeoutMs: 240_000 })
    expect(ok.code, tail(ok)).toBe(0)
    const bad = exec('pnpm exec tsc -p tests/acceptance/T121/fixtures/tsconfig.negative.json', { timeoutMs: 240_000 })
    expect(bad.code, 'o controle negativo deveria falhar na tipagem').not.toBe(0)
    expect(bad.output).toContain('robo-inexistente')
  })
})
