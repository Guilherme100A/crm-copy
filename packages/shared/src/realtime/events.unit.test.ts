import { describe, expect, it } from 'vitest'
import { REALTIME_EVENT_TYPES, isRealtimeEventType, parseRealtimeEnvelope, realtimeEnvelopeSchema } from './events'

const COMPANY = '0f8fad5b-d9cb-469f-a165-70867728950e'
const env = (type: string, data: unknown = {}) => ({ id: '1760486400000-0', type, company_id: COMPANY, at: '2026-10-15T00:00:00.000Z', data })

describe('realtime envelope', () => {
  it('aceita os tipos-base', () => {
    expect(REALTIME_EVENT_TYPES).toEqual(expect.arrayContaining(['company.updated', 'member.permissions_changed']))
    expect(realtimeEnvelopeSchema.safeParse(env('company.updated')).success).toBe(true)
    expect(realtimeEnvelopeSchema.safeParse(env('member.permissions_changed', { user_id: COMPANY, permission_keys: null })).success).toBe(true)
  })

  it('rejeita type fora do catálogo', () => {
    expect(realtimeEnvelopeSchema.safeParse(env('chat.nope')).success).toBe(false)
    expect(isRealtimeEventType('constructor')).toBe(false)
  })

  it('valida o data pelo schema do tipo e envelope incompleto', () => {
    const bad = realtimeEnvelopeSchema.safeParse(env('member.permissions_changed', { user_id: 'x' }))
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.path).toEqual(['data', 'user_id'])
    expect(realtimeEnvelopeSchema.safeParse({ ...env('company.updated'), company_id: 'x' }).success).toBe(false)
    expect(parseRealtimeEnvelope(env('company.updated', { fields: ['name'] })).data).toEqual({ fields: ['name'] })
  })
})
