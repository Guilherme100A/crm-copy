import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../../..')
const web = resolve(root, 'apps/web')
const { build } = await import(pathToFileURL(resolve(web, 'node_modules/vite/dist/node/index.js')))
const { chromium } = await import(pathToFileURL(resolve(root, 'node_modules/@playwright/test/index.mjs')))
process.env.VITE_BASE_PATH = '/crm/'
process.env.VITE_API_BASE = '/crm/api'
const evidence = resolve(root, 'test-results/T004-D01')
await mkdir(evidence, { recursive: true })
const result = await build({ root: web, configLoader: 'native', cacheDir: resolve(evidence, 'vite-cache'), build: { write: false, sourcemap: false }, logLevel: 'warn' })
const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output)
const assets = new Map(outputs.map(o => ['/crm/' + o.fileName, o.type === 'chunk' ? o.code : o.source]))
const flowsChunk = outputs.find(o => o.type === 'chunk' && Object.keys(o.modules).some(m => m.endsWith('/routes/flows/index.tsx?tsr-split=component'))).fileName
console.log('Bundle in memory:', outputs.length, 'files;', [...assets.values()].reduce((n, v) => n + Buffer.byteLength(v), 0), 'bytes')
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const body = assets.get(path) ?? (path.startsWith('/crm/assets/') ? null : assets.get('/crm/index.html'))
  res.writeHead(body === null ? 404 : 200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' })
  res.end(body ?? 'missing')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const logs = { console: [], pageerror: [], network: [], captures: [], documents: [] }
page.on('request', r => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) logs.documents.push(r.url()) })
page.on('console', m => logs.console.push({ type: m.type(), text: m.text() }))
page.on('pageerror', e => logs.pageerror.push(e.stack))
page.on('response', r => logs.network.push({ url: r.url(), status: r.status(), type: r.headers()['content-type'] }))
page.on('requestfailed', r => logs.network.push({ url: r.url(), failure: r.failure() }))
const company = { id: '11111111-1111-4111-8111-111111111111', name: 'Fixture D01', slug: 'fixture-d01', role: 'member', effective_permissions: ['flows.view', 'dashboard.sales', 'profile.view'] }
const profile = { user: { id: '22222222-2222-4222-8222-222222222222', name: 'Fixture D01', email: 'fixture@example.invalid', locale: 'pt-BR', system_role: 'user', last_company_id: company.id }, companies: [company] }
await page.route('**/crm/api/**', async route => {
  const path = new URL(route.request().url()).pathname.replace('/crm/api', '')
  let body
  if (path === '/auth/profile') body = profile
  else if (path === '/flows') body = { items: [], folders: [] }
  else if (path === '/dashboard/bootstrap') body = { products: [], connections: [], filter_groups: [], leads_count: 0 }
  else if (path === '/dashboard') body = { range: { start_date: '2026-11-21', end_date: '2026-11-21', time_zone: 'America/Sao_Paulo', granularity: 'day' }, previous_range: { start_date: '2026-11-20', end_date: '2026-11-20' }, cached: false, computed_at: '2026-11-21T12:00:00Z' }
  else if (path === '/companies/' + company.id) body = { company: { ...company, time_zone: 'America/Sao_Paulo' } }
  else if (path === '/app-config') body = { support_widget: { provider: 'none' } }
  else if (path.includes('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' })
  else body = { items: [], page: { page: 1, limit: 20, has_more: false }, total: 0, unread_count: 0, announcements: [] }
  await route.fulfill({ json: body })
})
async function capture(name, selector) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  await page.screenshot({ path: resolve(evidence, name + '.png') })
  const paint = await page.evaluate(selector => {
    const el = document.querySelector(selector)
    if (!el) return { found: false, body: document.body.innerText.slice(0, 800) }
    const b = el.getBoundingClientRect(), s = getComputedStyle(el)
    const x = Math.min(innerWidth - 1, b.x + b.width / 2), y = Math.min(innerHeight - 1, b.y + b.height / 2)
    const hit = document.elementFromPoint(x, y)
    return { found: true, rect: b.toJSON(), display: s.display, visibility: s.visibility, opacity: s.opacity, color: s.color, background: s.backgroundColor, hit: hit?.outerHTML.slice(0, 300), uncovered: !!hit && (hit === el || el.contains(hit)), shell: !!document.querySelector('[data-testid="shell-sidebar"]') }
  }, selector)
  logs.captures.push({ name, url: page.url(), paint, pageerrors: logs.pageerror.length })
  const current = logs.captures.at(-1)
  console.log(name, JSON.stringify(current))
  assert.equal(paint.found, true, `${name}: missing element`)
  assert.equal(paint.uncovered, true, `${name}: elementFromPoint must hit the painted content`)
  assert.equal(paint.shell, true, `${name}: shell must remain mounted`)
  assert.ok(paint.rect.width > 0 && paint.rect.height > 0)
  assert.equal(paint.visibility, 'visible')
  assert.notEqual(paint.display, 'none')
  assert.notEqual(paint.opacity, '0')
}
try {
  await page.goto(origin + '/crm/welcome')
  await page.getByTestId('page-welcome').waitFor()
  await capture('welcome', '[data-testid="page-welcome"]')
  await page.locator('a[href="/crm/flows"]').first().click()
  await page.getByTestId('page-flows').waitFor()
  await capture('welcome-to-flows', '[data-testid="page-flows"]')
  await page.goto(origin + '/crm/flows')
  await page.getByTestId('page-flows').waitFor()
  await capture('direct-flows', '[data-testid="page-flows"]')
  assert.deepEqual(logs.pageerror, [], 'healthy navigation must not emit pageerror')
  assert.equal(logs.network.filter(r => r.failure || r.status >= 400).length, 0)

  // Serve HTML in place of a production lazy chunk, reproducing a stale deploy.
  const chunkPattern = '**/crm/' + flowsChunk
  await page.route(chunkPattern, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Missing chunk fixture</html>' }))
  const beforeFailure = logs.documents.length
  await page.goto(origin + '/crm/flows')
  await page.getByTestId('route-error').waitFor()
  await capture('chunk-error', '[data-testid="route-error"]')
  assert.equal(logs.documents.length - beforeFailure, 2, 'one requested navigation plus exactly one automatic reload')
  assert.equal(await page.getByTestId('route-error').getAttribute('role'), 'alert')
  assert.ok(await page.getByRole('button', { name: 'Tentar novamente', exact: true }).isVisible())
  assert.ok(await page.getByRole('button', { name: 'Recarregar', exact: true }).isVisible())
  assert.ok(logs.network.some(r => r.url.endsWith(flowsChunk) && r.type.includes('text/html')), 'must exercise the real built lazy chunk')
  assert.ok(logs.console.some(r => r.type === 'error' && /MIME type/.test(r.text)), 'must observe the chunk MIME failure')

  // More failures, including a different chunk, must not replenish the tab budget.
  const documents = logs.documents.length
  await page.evaluate(() => {
    for (const message of ['another chunk', 'third chunk']) {
      const event = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: new Error(message) })
      window.dispatchEvent(event)
      if (event.defaultPrevented) throw new Error('preload failure was swallowed')
    }
  })
  await capture('budget-exhausted', '[data-testid="route-error"]')
  assert.equal(logs.documents.length, documents)
  assert.equal(await page.evaluate(() => sessionStorage.getItem('crm:preload-reload:v1')), '1')
  await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click()
  await page.getByTestId('route-error').waitFor()
  assert.equal(logs.documents.length, documents, 'retry must not reload the document')

  // After restoring the asset, explicit reload must recover the route in the same tab.
  await page.unroute(chunkPattern)
  await page.getByRole('button', { name: 'Recarregar', exact: true }).click()
  await page.getByTestId('page-flows').waitFor()
  await capture('recovered', '[data-testid="page-flows"]')
  assert.equal(logs.documents.length, documents + 1)
  console.log('T004-D01 acceptance passed')
} finally {
  await writeFile(resolve(evidence, 'observations.json'), JSON.stringify(logs, null, 2))
  await browser.close()
  server.close()
}
