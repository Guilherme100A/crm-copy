import { describe, expect, it } from 'vitest'
import { COMPANY_ID, envelope, envelopeSchema, USER_ID } from './contract'

// Payloads plausíveis para os tipos-base (o schema pode validar `data` por tipo).
const BASE: Record<string, Record<string, unknown>> = {
  'company.updated': { company_id: COMPANY_ID, id: COMPANY_ID, name: 'Empresa Teste' },
  'member.permissions_changed': { company_id: COMPANY_ID, user_id: USER_ID, permission_keys: ['chat.view'] },
}

describe('T02 — envelope realtime (SPEC 3.7)', () => {
  it('AC-T02-05 o envelope aceita os tipos-base company.updated e member.permissions_changed', () => {
    const schema = envelopeSchema()
    for (const [type, data] of Object.entries(BASE)) {
      const r = schema.safeParse(envelope(type, data))
      expect(r.success, `${type}: ${JSON.stringify((r as any).error?.issues ?? r)}`).toBe(true)
    }
  })

  it('AC-T02-05 o envelope rejeita type fora do catálogo', () => {
    const schema = envelopeSchema()
    for (const type of ['company.exploded', 'nao.existe', 'chat', '', 'COMPANY.UPDATED']) {
      const r = schema.safeParse(envelope(type, BASE['company.updated']))
      expect(r.success, `type "${type}" deveria ser rejeitado`).toBe(false)
    }
  })

  it('AC-T02-05 o envelope exige os campos id, type, company_id, at e data', () => {
    const schema = envelopeSchema()
    const ok = envelope('company.updated', BASE['company.updated'])
    for (const field of ['id', 'type', 'company_id', 'at', 'data'] as const) {
      const { [field]: _omit, ...rest } = ok
      expect(schema.safeParse(rest).success, `sem ${field} deveria ser rejeitado`).toBe(false)
    }
  })
})
