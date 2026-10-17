// T102 (pendências da T53): 403 `company_inactive` tratado no cliente HTTP e `company.updated` registrado no boot do SSE.
import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeCompany, api, configureHttp, HttpError, isCompanyInactive } from '@/lib/http'
import { dispatchRealtime, registeredTypes } from '@/lib/realtime'
import { profileQueryKey } from '@/lib/session'
import { companyKey } from './api'
import './realtime'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const inactive = { error: { code: 'FORBIDDEN', message: 'Empresa desativada', details: { error_code: 'company_inactive' } } }

describe('403 company_inactive', () => {
  afterEach(() => configureHttp({ fetch: (i, init) => fetch(i, init), companyId: null, onCompanyInactive: () => undefined }))

  it('várias chamadas falhando juntas geram um aviso só; a empresa ativa continua a mesma', async () => {
    const warn = vi.fn()
    configureHttp({ companyId: 'c1', fetch: async () => json(403, inactive), onCompanyInactive: warn })
    const results = await Promise.allSettled([api.get('/api/chats'), api.get('/api/contacts'), api.post('/api/x')])
    for (const r of results) {
      expect(r.status).toBe('rejected')
      expect(isCompanyInactive((r as PromiseRejectedResult).reason)).toBe(true)
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(activeCompany()).toBe('c1')
  })

  it('outros 403 não avisam', async () => {
    const warn = vi.fn()
    configureHttp({ companyId: 'c1', fetch: async () => json(403, { error: { code: 'FORBIDDEN', message: 'x' } }), onCompanyInactive: warn })
    await expect(api.get('/api/team')).rejects.toBeInstanceOf(HttpError)
    expect(warn).not.toHaveBeenCalled()
    expect(isCompanyInactive(new HttpError(422, 'VALIDATION_ERROR', 'x', { error_code: 'company_inactive' }))).toBe(false)
  })
})

describe('company.updated no SSE', () => {
  it('fica registrado sem abrir o hub e invalida a empresa, o perfil e a lista de contas', () => {
    expect(registeredTypes()).toContain('company.updated')
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    dispatchRealtime({ id: '1-0', type: 'company.updated', company_id: 'c1', at: '2026-10-17T00:00:00.000Z', data: { id: 'c1', fields: ['active'] } }, qc)
    const keys = spy.mock.calls.map(([f]) => f?.queryKey)
    expect(keys).toEqual(expect.arrayContaining([companyKey('c1'), profileQueryKey, ['company-switcher']]))
  })
})
