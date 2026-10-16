// AC-T124-01 / AC-T124-03 pelo Playwright: o harness deste worktree serializa resets simultâneos e registra o timeout.
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { dbUrl, sqlOk } from '../helpers/pg'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

test('AC-T124-03 o e2e-server.json deste worktree registra reset_timeout_ms (padrão ≥ 60000)', async () => {
  const mod: any = await import(pathToFileURL(`${ROOT}scripts/e2e/ports.mjs`).href)
  const info = mod.readServerInfo(ROOT)
  expect(info, 'test-results/e2e-server.json ausente').toBeTruthy()
  expect(info.reset_timeout_ms).toBeGreaterThanOrEqual(60_000)
  expect(info.orphans).toBeTruthy()
})

test('AC-T124-01 dois POST /__e2e/reset simultâneos terminam com 200 e o seed fica íntegro', async ({ request }) => {
  const mod: any = await import(pathToFileURL(`${ROOT}scripts/e2e/ports.mjs`).href)
  const info = mod.readServerInfo(ROOT)
  const timeout = Number(info.reset_timeout_ms ?? 60_000) + 10_000
  const post = () => request.post('/__e2e/reset', { headers: { 'x-requested-with': 'crm' }, data: {}, timeout })
  const first = await post()
  expect(first.status(), await first.text()).toBe(200)
  const counts = () => sqlOk(dbUrl(info.database), `SELECT (SELECT count(*) FROM crm.users), (SELECT count(*) FROM crm.companies);`)[0]!.join('/')
  const baseline = counts()
  const [a, b] = await Promise.all([post(), post()])
  expect(a.status(), await a.text()).toBe(200)
  expect(b.status(), await b.text()).toBe(200)
  const waits = [(await a.json()).waited_ms, (await b.json()).waited_ms]
  expect(Math.max(...waits)).toBeGreaterThan(0)
  expect(counts()).toBe(baseline)
})
