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
    expect(await res.json()).toMatchObject({ affiliate_portal_url: null })

    env.AFFILIATE_PORTAL_URL = 'https://parceiros.example.com/register'
    res = await app.request('/api/app-config')
    expect(await res.json()).toMatchObject({ affiliate_portal_url: 'https://parceiros.example.com/register' })

    env.AFFILIATE_PORTAL_URL = 'javascript:alert(1)'
    res = await app.request('/api/app-config')
    expect(await res.json()).toMatchObject({ affiliate_portal_url: null })
  })

  it('AC-T108-01/02/03: tutorials_url e support do env, relidos a cada request', async () => {
    const env: Record<string, string | undefined> = {}
    const app = new Hono<AppEnv>().route('/', appConfigRoutes({ appConfigEnv: env }))
    const get = async () => (await app.request('/api/app-config')).json()
    expect(await get()).toMatchObject({ tutorials_url: null, support: { provider: 'none', script_url: null, phone: null } })

    env.TUTORIALS_URL = 'https://videos.example.com/'
    env.SUPPORT_PROVIDER = 'script'
    env.SUPPORT_SCRIPT_URL = 'https://chat.example.com/widget.js'
    expect(await get()).toMatchObject({
      tutorials_url: 'https://videos.example.com/',
      support: { provider: 'script', script_url: 'https://chat.example.com/widget.js', phone: null },
    })

    env.SUPPORT_PROVIDER = 'whatsapp-link'
    env.SUPPORT_PHONE = '+55 11 99999-8888'
    expect(await get()).toMatchObject({ support: { provider: 'whatsapp-link', script_url: null, phone: '5511999998888' } })
  })

  it('é autenticada (não é rota pública)', () => {
    expect(isPublicApiRoute('GET', '/api/app-config')).toBe(false)
  })
})
