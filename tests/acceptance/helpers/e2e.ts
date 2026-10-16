// Helpers de E2E (Playwright) sobre o harness da T17: seed-base, reset e login por papel.
// O preview da web faz proxy de /api e /__e2e para a API, então tudo usa o baseURL da web.
import { expect, type APIRequestContext, type Page } from '@playwright/test'

export const SEED_PASSWORD = 'Senha-e2e-123'
export const SEED_USERS = {
  platformAdmin: 'platform@demo.test',
  owner: 'owner@demo.test',
  admin: 'admin@demo.test',
  member: 'member@demo.test',
} as const
export type SeedRole = keyof typeof SEED_USERS

/** Restaura o seed-base (POST /__e2e/reset, só com E2E=1). */
export async function resetSeed(request: APIRequestContext) {
  const res = await request.post('/__e2e/reset', { headers: { 'x-requested-with': 'crm' } })
  expect(res.status(), await res.text()).toBe(200)
}

/** Login pela API (cookie crm_session fica no contexto do navegador). */
export async function loginAs(page: Page, role: SeedRole) {
  const res = await page.request.post('/api/auth/login', {
    data: { email: SEED_USERS[role], password: SEED_PASSWORD },
    headers: { 'x-requested-with': 'crm' },
  })
  expect(res.status(), await res.text()).toBe(200)
  return res.json()
}

/** Viewport de celular (projeto `mobile`, 390 px). */
export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1366) <= 480

/** Página sem rolagem horizontal. */
export async function expectNoHorizontalScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(scroll, `rolagem horizontal: scrollWidth ${scroll} > clientWidth ${client}`).toBeLessThanOrEqual(client)
}
