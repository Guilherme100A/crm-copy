import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeCompany, configureHttp } from '@/lib/http'
import { companiesApi, COMPANIES_PAGE_SIZE, switchCompany } from './switch'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => configureHttp({ companyId: null }))

describe('companiesApi', () => {
  it('lista paginada de 20 com busca aparada; busca vazia não vai na URL', async () => {
    const fetch = vi.fn(async () => json({ items: [], page: { page: 1, limit: 20, total_count: 0, total_pages: 0, has_more: false } }))
    configureHttp({ fetch, companyId: 'co-a' })
    await companiesApi.list(2, '  loja ')
    await companiesApi.list(1, '   ')
    expect(COMPANIES_PAGE_SIZE).toBe(20)
    expect(fetch.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(['/api/companies?page=2&limit=20&search=loja', '/api/companies?page=1&limit=20'])
  })
})

describe('switchCompany (AC-T36-04)', () => {
  it('troca no servidor, depois o X-Company-Id, zera o cache e reroda a guarda', async () => {
    const order: string[] = []
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      order.push(`${init.method} ${url} ${(init.headers as Record<string, string>)['X-Company-Id'] ?? '-'}`)
      return json({ company: { id: 'co-b' } })
    })
    configureHttp({ fetch: fetch as never, companyId: 'co-a' })
    const queryClient = new QueryClient()
    queryClient.setQueryData(['contacts', 'list'], { items: ['da empresa A'] })
    const reset = vi.spyOn(queryClient, 'resetQueries')
    const router = { invalidate: vi.fn(async () => order.push('router.invalidate')) }

    await switchCompany(queryClient, router, 'co-b')

    expect(order).toEqual(['POST /api/companies/co-b/switch co-a', 'router.invalidate'])
    expect(activeCompany()).toBe('co-b')
    expect(reset).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(['contacts', 'list'])).toBeUndefined()
  })

  it('falha no servidor não troca a empresa local', async () => {
    configureHttp({ fetch: async () => new Response('{"error":{"code":"NOT_FOUND","message":"x"}}', { status: 404 }), companyId: 'co-a' })
    const router = { invalidate: vi.fn(async () => undefined) }
    await expect(switchCompany(new QueryClient(), router, 'co-x')).rejects.toMatchObject({ status: 404 })
    expect(activeCompany()).toBe('co-a')
    expect(router.invalidate).not.toHaveBeenCalled()
  })
})
