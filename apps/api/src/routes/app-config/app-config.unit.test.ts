import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../../lib/types'
import { isPublicApiRoute } from '../../middleware/public-routes'
import { appConfigRoutes } from './index'

describe('GET /api/app-config (AC-T97-03)', () => {
  it('devolve affiliate_portal_url do env, relido a cada request', async () => {
    const env: Record<string, string | undefined> = {}
    const app = new Hono<AppEnv>().route('/', appConfigRoutes({ appConfigEnv: env }))
    let res = await app.request('/api/app-config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ affiliate_portal_url: null })

    env.AFFILIATE_PORTAL_URL = 'https://parceiros.example.com/register'
    res = await app.request('/api/app-config')
    expect(await res.json()).toEqual({ affiliate_portal_url: 'https://parceiros.example.com/register' })

    env.AFFILIATE_PORTAL_URL = 'javascript:alert(1)'
    res = await app.request('/api/app-config')
    expect(await res.json()).toEqual({ affiliate_portal_url: null })
  })

  it('é autenticada (não é rota pública)', () => {
    expect(isPublicApiRoute('GET', '/api/app-config')).toBe(false)
  })
})
