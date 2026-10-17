import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, configureHttp, HttpError, isSupportAccessExpired, activeCompany } from '@/lib/http'
import { dispatchRealtime, registeredTypes, type RealtimeEnvelope } from '@/lib/realtime'
import { companyGrantsKey, pendingRequestsKey, type SupportAccessRequestDto } from './api'
import { applySupportEvent, canReviewSupport, removeRequest, SUPPORT_EVENT_TYPES, upsertPending, visibleQueue } from './queue'
import './realtime'
import { accountsOf, requestErrorKey, resolveTarget } from './support'

const req = (id: string, status: SupportAccessRequestDto['status'] = 'pending'): SupportAccessRequestDto => ({
  id,
  status,
  support_user_id: 's1',
  support_name: 'Sofia',
  support_email: 'support@demo.test',
  company_id: 'c1',
  company_name: 'Empresa',
  decided_at: null,
  resent_at: null,
  created_at: '2026-10-16T12:00:00.000Z',
  updated_at: '2026-10-16T12:00:00.000Z',
})
const ev = (type: string, data: unknown): RealtimeEnvelope => ({ id: '1', type, company_id: 'c1', at: '', data })

describe('fila do modal de aprovação (AC-T54-05)', () => {
  it('pedido novo entra no fim; repetido atualiza; decidido sai', () => {
    let q = upsertPending([], req('a'))
    q = upsertPending(q, req('b'))
    q = upsertPending(q, { ...req('a'), resent_at: 'x' })
    expect(q.map((r) => r.id)).toEqual(['a', 'b'])
    expect(q[0]!.resent_at).toBe('x')
    expect(upsertPending(q, req('a', 'approved')).map((r) => r.id)).toEqual(['b'])
    expect(removeRequest(q, 'b').map((r) => r.id)).toEqual(['a'])
    expect(visibleQueue(q, new Set(['a'])).map((r) => r.id)).toEqual(['b'])
  })

  it('SSE: requested acrescenta; cancelled/granted/rejected tiram; granted/revoked recarregam concessões', () => {
    const qc = new QueryClient()
    const key = pendingRequestsKey('c1')
    qc.setQueryData(key, [req('a')])
    applySupportEvent(ev('support_access.requested', { request: req('b') }), qc)
    expect(qc.getQueryData<SupportAccessRequestDto[]>(key)!.map((r) => r.id)).toEqual(['a', 'b'])
    applySupportEvent(ev('support_access.cancelled', { request: req('a', 'cancelled') }), qc)
    expect(qc.getQueryData<SupportAccessRequestDto[]>(key)!.map((r) => r.id)).toEqual(['b'])
    const inv = vi.spyOn(qc, 'invalidateQueries')
    applySupportEvent(ev('support_access.granted', { request: req('b', 'approved'), grant: { id: 'g' } }), qc)
    expect(qc.getQueryData<SupportAccessRequestDto[]>(key)).toEqual([])
    expect(inv).toHaveBeenCalledWith({ queryKey: companyGrantsKey('c1') })
  })

  it('lista ainda não carregada: o pedido novo dispara a busca', () => {
    const qc = new QueryClient()
    const inv = vi.spyOn(qc, 'invalidateQueries')
    applySupportEvent(ev('support_access.requested', { request: req('a') }), qc)
    expect(inv).toHaveBeenCalledWith({ queryKey: pendingRequestsKey('c1') })
  })

  it('handlers registrados ao importar o módulo (antes do SSE abrir) e despachados', () => {
    for (const t of SUPPORT_EVENT_TYPES) expect(registeredTypes()).toContain(t)
    const qc = new QueryClient()
    qc.setQueryData(pendingRequestsKey('c1'), [])
    dispatchRealtime(ev('support_access.requested', { request: req('z') }), qc)
    expect(qc.getQueryData<SupportAccessRequestDto[]>(pendingRequestsKey('c1'))!.map((r) => r.id)).toEqual(['z'])
  })

  it('só owner/admin da empresa ativa revisam; o suporte nunca', () => {
    const c = { id: 'c1' } as never
    expect(canReviewSupport({ company: c, role: 'owner', isSupport: false })).toBe(true)
    expect(canReviewSupport({ company: c, role: 'admin', isSupport: false })).toBe(true)
    expect(canReviewSupport({ company: c, role: 'member', isSupport: false })).toBe(false)
    expect(canReviewSupport({ company: c, role: 'member', isSupport: true })).toBe(false)
    expect(canReviewSupport({ company: null, role: null, isSupport: false })).toBe(false)
  })
})

describe('tela do suporte', () => {
  it('lookup: nenhuma empresa, uma (pede direto) ou várias (escolher)', () => {
    expect(resolveTarget([])).toEqual({ kind: 'none' })
    expect(resolveTarget([{ id: 'c1', name: 'A' }])).toEqual({ kind: 'one', companyId: 'c1' })
    expect(resolveTarget([{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }])).toEqual({ kind: 'choose' })
  })

  it('erros do pedido viram mensagens conhecidas', () => {
    expect(requestErrorKey(new HttpError(409, 'CONFLICT', 'x', { error_code: 'request_pending' }))).toBe('request_pending')
    expect(requestErrorKey(new HttpError(409, 'CONFLICT', 'x', { error_code: 'grant_active' }))).toBe('grant_active')
    expect(requestErrorKey(new HttpError(422, 'VALIDATION', 'x', { error_code: 'account_not_found' }))).toBe('account_not_found')
    expect(requestErrorKey(new HttpError(500, 'INTERNAL', 'x'))).toBe('generic')
    const accounts = [{ id: 'c1', name: 'A' }]
    expect(accountsOf(new HttpError(422, 'VALIDATION', 'x', { error_code: 'account_required', accounts }))).toEqual(accounts)
    expect(accountsOf(new Error('x'))).toBeNull()
  })
})

describe('403 support_access_expired (decisão da T32)', () => {
  afterEach(() => configureHttp({ fetch: (i, init) => fetch(i, init), companyId: null, onSupportAccessExpired: () => undefined }))
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('zera a empresa ativa e leva o suporte à tela dele (uma vez por rodada)', async () => {
    const go = vi.fn()
    const body = { error: { code: 'FORBIDDEN', message: 'expirado', details: { error_code: 'support_access_expired' } } }
    configureHttp({ companyId: 'c1', fetch: async () => json(403, body), onSupportAccessExpired: go })
    const results = await Promise.allSettled([api.get('/api/flows'), api.get('/api/auth/profile'), api.post('/api/x')])
    for (const r of results) {
      expect(r.status).toBe('rejected')
      expect(isSupportAccessExpired((r as PromiseRejectedResult).reason)).toBe(true)
    }
    expect(activeCompany()).toBeNull()
    expect(go).toHaveBeenCalledTimes(1)
  })

  it('outros 403 não mexem na empresa ativa', async () => {
    const go = vi.fn()
    configureHttp({ companyId: 'c1', fetch: async () => json(403, { error: { code: 'FORBIDDEN', message: 'x', details: { error_code: 'owner_admin_only' } } }), onSupportAccessExpired: go })
    await expect(api.get('/api/support-access/requests')).rejects.toBeInstanceOf(HttpError)
    expect(activeCompany()).toBe('c1')
    expect(go).not.toHaveBeenCalled()
  })
})
