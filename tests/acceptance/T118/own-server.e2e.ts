// AC-T118-02 — o Playwright deste worktree fala com o harness deste worktree (porta derivada + e2e-server.json + banco).
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { dbUrl, lit, sql } from '../helpers/pg'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

test('AC-T118-02 o Playwright fala com o próprio servidor: porta derivada do worktree, e2e-server.json deste checkout e o mesmo banco', async ({ page, baseURL }) => {
  const mod: any = await import(pathToFileURL(`${ROOT}scripts/e2e/ports.mjs`).href)
  const ports = mod.e2ePorts(ROOT)
  expect(Number(new URL(baseURL!).port)).toBe(ports.web)

  const info = mod.readServerInfo(ROOT)
  expect(info, 'test-results/e2e-server.json ausente').toBeTruthy()
  expect(info.root).toBe(mod.normalizeRoot(ROOT))
  expect(info.web_port).toBe(ports.web)
  expect(info.api_port).toBe(ports.api)
  expect(mod.isOwnServerRunning(ROOT)).toBe(true)

  // um cadastro feito pelo navegador cai no banco registrado por este harness
  const email = `t118-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`
  const res = await page.request.post('/api/auth/register', {
    data: { name: 'Usuária T118 E2E', email, password: 'Senha-t118-123', password_confirmation: 'Senha-t118-123' },
    headers: { 'x-requested-with': 'crm' },
  })
  expect(res.status(), await res.text()).toBeLessThan(300)
  const r = sql(dbUrl(info.database), `SELECT count(*) FROM crm.users WHERE email = ${lit(email)};`)
  expect(r.code, r.stderr).toBe(0)
  expect(r.rows[0]?.[0]).toBe('1')

  await page.goto('/login')
  await expect(page).toHaveTitle(/CRM/)
})
