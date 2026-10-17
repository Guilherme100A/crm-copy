import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchRealtime, registeredTypes, type RealtimeEnvelope } from '@/lib/realtime'
import type { Session } from '@/lib/session'
import {
  canSeeDisconnectAlert,
  disconnectAlertKey,
  disconnectAlertQuery,
  isAlertActive,
  type DisconnectAlertDto,
} from './api'
import { DROP_EVENTS, REFETCH_EVENTS } from './realtime'
import './indicator'

type S = Pick<Session, 'company' | 'isSupport' | 'isOwner' | 'perms'>
const company = { id: 'c1', name: 'Demo', role: 'member' } as unknown as Session['company']
const session = (over: Partial<S> = {}): S =>
  ({ company, isSupport: false, isOwner: false, perms: new Set(), ...over }) as S
const ev = (type: string, data: unknown = {}, company_id = 'c1'): RealtimeEnvelope => ({
  id: type,
  type,
  company_id,
  at: '2026-10-17T12:00:00.000Z',
  data,
})

const clients: QueryClient[] = []
/** Query ativa (como a do indicador montado) com contador de consultas no lugar do `GET`. */
function mounted(
  companyId: string,
  first: DisconnectAlertDto = { has_recent_disconnected: false, last_disconnected_at: null },
) {
  const qc = new QueryClient()
  clients.push(qc)
  const fetch = vi.fn(async () => first)
  const obs = new QueryObserver(qc, { ...disconnectAlertQuery(companyId), queryFn: fetch })
  const unsubscribe = obs.subscribe(() => undefined)
  return { qc, fetch, unsubscribe, data: () => qc.getQueryData<DisconnectAlertDto>(disconnectAlertKey(companyId)) }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  for (const qc of clients.splice(0)) qc.clear()
})

describe('AC-T107-01 consulta e estado do indicador', () => {
  it('chave por empresa e GET em /api/connections/disconnect-alert', () => {
    expect(disconnectAlertQuery('c1').queryKey).toEqual(['shell-disconnect', 'c1'])
    expect(disconnectAlertKey(null)).toEqual(['shell-disconnect', ''])
  })

  it('aceso só com has_recent_disconnected e dentro da janela de 24 h', () => {
    const now = Date.parse('2026-10-17T12:00:00.000Z')
    expect(isAlertActive(undefined, now)).toBe(false)
    expect(isAlertActive({ has_recent_disconnected: false, last_disconnected_at: null }, now)).toBe(false)
    expect(isAlertActive({ has_recent_disconnected: true, last_disconnected_at: null }, now)).toBe(true)
    expect(
      isAlertActive({ has_recent_disconnected: true, last_disconnected_at: '2026-10-16T12:00:01.000Z' }, now),
    ).toBe(true)
    expect(
      isAlertActive({ has_recent_disconnected: true, last_disconnected_at: '2026-10-16T12:00:00.000Z' }, now),
    ).toBe(false)
  })
})

describe('AC-T107-02 realtime', () => {
  it('handlers registrados (o shell importa o módulo de forma estática)', () => {
    for (const t of [...DROP_EVENTS, ...REFETCH_EVENTS]) expect(registeredTypes()).toContain(t)
    // updated/status_changed não religam nem reconsultam (chegam antes do disconnected numa queda).
    expect(DROP_EVENTS).not.toContain('connection.updated')
    expect(REFETCH_EVENTS).not.toContain('connection.status_changed')
  })

  it('connection.disconnected liga o indicador sem nova consulta; connection.connected reconsulta', async () => {
    const m = mounted('c1')
    await settle()
    expect(m.fetch).toHaveBeenCalledTimes(1)
    dispatchRealtime(ev('connection.updated'), m.qc)
    dispatchRealtime(ev('connection.status_changed'), m.qc)
    dispatchRealtime(ev('connection.disconnected', { disconnected_at: '2026-10-17T11:59:00.000Z' }), m.qc)
    await settle()
    expect(m.fetch).toHaveBeenCalledTimes(1)
    expect(m.data()).toEqual({ has_recent_disconnected: true, last_disconnected_at: '2026-10-17T11:59:00.000Z' })

    dispatchRealtime(ev('connection.connected'), m.qc)
    await settle()
    expect(m.fetch).toHaveBeenCalledTimes(2)
    dispatchRealtime(ev('connection.deleted'), m.qc)
    await settle()
    expect(m.fetch).toHaveBeenCalledTimes(3)
    m.unsubscribe()
  })

  it('alertas, banimento e pausa de fluxo também ligam sem consulta; mantém a queda mais recente; outra empresa intacta', async () => {
    const m = mounted('c1')
    await settle()
    dispatchRealtime(ev('connection.banned_alert', { disconnected_at: '2026-10-17T11:00:00.000Z' }), m.qc)
    dispatchRealtime(ev('connection.disconnected_alert', { disconnected_at: '2026-10-17T10:00:00.000Z' }), m.qc)
    expect(m.data()!.last_disconnected_at).toBe('2026-10-17T11:00:00.000Z')
    dispatchRealtime(ev('flow.auto_paused', { run_ids: [] }), m.qc)
    expect(m.data()).toEqual({ has_recent_disconnected: true, last_disconnected_at: '2026-10-17T12:00:00.000Z' })
    dispatchRealtime(ev('connection.disconnected', {}, 'c2'), m.qc)
    await settle()
    expect(m.fetch).toHaveBeenCalledTimes(1)
    expect(m.qc.getQueryData(disconnectAlertKey('c2'))).toMatchObject({ has_recent_disconnected: true })
    m.unsubscribe()
  })
})

describe('AC-T107-03 quem vê', () => {
  it('owner sempre; com connections.view sim; sem a chave não; support nunca; sem empresa não', () => {
    expect(canSeeDisconnectAlert(session({ isOwner: true }))).toBe(true)
    expect(canSeeDisconnectAlert(session({ perms: new Set(['connections.view']) as unknown as S['perms'] }))).toBe(true)
    expect(canSeeDisconnectAlert(session({ perms: new Set(['chats.view']) as unknown as S['perms'] }))).toBe(false)
    expect(
      canSeeDisconnectAlert(
        session({ isSupport: true, perms: new Set(['connections.view']) as unknown as S['perms'] }),
      ),
    ).toBe(false)
    expect(canSeeDisconnectAlert(session({ isSupport: true, isOwner: true }))).toBe(false)
    expect(canSeeDisconnectAlert(session({ isOwner: true, company: null }))).toBe(false)
  })
})

describe('AC-T107-04 troca de empresa', () => {
  it('o resetQueries da troca refaz a consulta; a nova empresa tem chave própria', async () => {
    const m = mounted('c1', { has_recent_disconnected: true, last_disconnected_at: null })
    await settle()
    expect(m.fetch).toHaveBeenCalledTimes(1)
    await m.qc.resetQueries()
    expect(m.fetch).toHaveBeenCalledTimes(2)
    expect(disconnectAlertKey('c2')).not.toEqual(disconnectAlertKey('c1'))
    m.unsubscribe()
  })
})
