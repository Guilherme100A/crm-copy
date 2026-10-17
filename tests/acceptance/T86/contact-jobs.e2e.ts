// AC-T86-03/04 — jobs de contatos em /customers: "Importar CSV" (modelo para baixar, progresso por SSE `job.progress`
// com consulta de reserva a cada 2 s, relatório final com erros agrupados por mensagem e linhas), painel "Exportações
// recentes" com download e exclusão em massa com progresso até o fim (T77, reaproveitada).
// A importação roda no worker in-process do harness; SSE e polling são isolados com page.route.
import { readFile } from 'node:fs/promises'
import { expect, test, type Page, type Route } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { newPhone, XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const HEADER = 'nome;telefone;email;etiquetas;estado;cidade;cep;opt_out'

async function api(page: Page, method: 'get' | 'post', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request.post(path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

const isImportStatus = (u: URL) => /^\/api\/contacts\/imports\/[^/]+$/.test(u.pathname)

async function openContacts(page: Page) {
  await page.goto('/customers')
  await expect(page.getByTestId('page-contacts')).toBeVisible()
}

/** Abre "Importar CSV", escolhe o arquivo e envia; devolve o id do job criado. */
async function startImport(page: Page, csv: string, name = 'contatos.csv') {
  await page.getByTestId('contacts-import-csv').click()
  await expect(page.getByTestId('contact-import-dialog')).toBeVisible()
  await page.getByTestId('contact-import-file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') })
  await expect(page.getByTestId('contact-import-file-name')).toContainText(name)
  const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/contacts/imports')
  await page.getByTestId('contact-import-submit').click()
  const res = await post
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()).job as { id: string }).id
}

/** CSV de 2 válidos + 2 com telefone inválido (linhas 3 e 4), com uma etiqueta nova. */
function mixedCsv(prefix: string, labelName: string) {
  return [
    HEADER,
    `${prefix} Ana;+${newPhone()};ana@exemplo.com;${labelName};SP;São Paulo;01310100;`,
    `${prefix} Ruim1;123;;;;;;`,
    `${prefix} Ruim2;abc;;;;;;`,
    `${prefix} Bia;+${newPhone()};;${labelName};;;;`,
  ].join('\n')
}

test.describe('T86 — importação CSV', () => {
  test('AC-T86-03 o modelo CSV pode ser baixado', async ({ page }) => {
    await loginAs(page, 'owner')
    await openContacts(page)
    await page.getByTestId('contacts-import-csv').click()
    const link = page.getByTestId('contact-import-template')
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', /\/api\/contacts\/import-template\.csv$/)
    const dl = page.waitForEvent('download')
    await link.click()
    const download = await dl
    expect(download.suggestedFilename()).toBe('modelo_importacao_contatos.csv')
    const text = (await readFile((await download.path())!, 'utf8')).replace(/^﻿/, '')
    expect(text.split(/\r?\n/)[0]).toBe(HEADER)
  })

  test('AC-T86-03 no fim mostra o relatório com contadores, etiquetas criadas e erros agrupados com as linhas', async ({ page }) => {
    await loginAs(page, 'owner')
    await openContacts(page)
    const prefix = `Imp${uniq()}`
    const labelName = `Clientes ${uniq()}`
    await startImport(page, mixedCsv(prefix, labelName))

    await expect(page.getByTestId('contact-import-progress')).toHaveAttribute('data-status', 'completed', { timeout: 30_000 })
    await expect(page.getByTestId('contact-import-progress')).toHaveAttribute('data-phase', 'completed')
    const report = page.getByTestId('contact-import-report')
    await expect(report).toBeVisible()
    await expect(page.getByTestId('contact-import-count-created')).toHaveText('2')
    await expect(page.getByTestId('contact-import-count-errors')).toHaveText('2')
    await expect(page.getByTestId('contact-import-count-updated')).toHaveText('0')
    await expect(page.getByTestId('contact-import-labels-created')).toContainText(labelName)
    // erros agrupados: uma só linha "telefone inválido" com 2 ocorrências nas linhas 3 e 4
    await expect(page.locator('[data-testid^="contact-import-error-group-"][data-testid$="-message"]')).toHaveCount(1)
    await expect(page.getByTestId('contact-import-error-group-0-message')).toHaveText(/telefone inválido/i)
    await expect(page.getByTestId('contact-import-error-group-0-count')).toContainText('2')
    await expect(page.getByTestId('contact-import-error-group-0-lines')).toContainText(/3\D+4/)

    // os contatos válidos existem e a lista atualiza ao fechar
    await page.getByTestId('contact-import-close').click()
    await expect(page.getByTestId('contact-import-dialog')).toBeHidden()
    const body = await api(page, 'get', `/api/contacts?search=${encodeURIComponent(prefix)}&limit=10`)
    expect((body.items as Any[]).map((c) => c.name).sort()).toEqual([`${prefix} Ana`, `${prefix} Bia`])
  })

  test('AC-T86-03 progresso chega pelo SSE job.progress (sem respostas da consulta de status)', async ({ page }) => {
    await loginAs(page, 'owner')
    // segura toda consulta GET /api/contacts/imports/:id: só o SSE pode levar o job ao fim
    const held: Route[] = []
    await page.route(
      (u) => isImportStatus(u),
      (route) => {
        if (route.request().method() !== 'GET') return route.fallback()
        held.push(route)
      },
    )
    await openContacts(page)
    const prefix = `Sse${uniq()}`
    const run = String(Date.now()).slice(-4)
    const lines = [HEADER]
    for (let i = 0; i < 1500; i++) lines.push(`${prefix} ${i};+55119${run}${String(i).padStart(4, '0')};;;;;;`)
    await startImport(page, lines.join('\n'))

    const progress = page.getByTestId('contact-import-progress')
    await expect(progress).toBeVisible()
    await expect(progress).toHaveAttribute('data-status', 'completed', { timeout: 60_000 })
    await expect(page.getByTestId('contact-import-processed')).toContainText('1500')
    // nenhuma consulta de status foi respondida: o fim veio do SSE
    for (const r of held) await r.abort().catch(() => {})
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('AC-T86-03 sem SSE, a consulta de reserva a cada 2 s mostra o progresso e o relatório', async ({ page }) => {
    await loginAs(page, 'owner')
    // SSE fora do ar
    await page.route((u) => u.pathname === '/api/events', (route) => route.abort())
    // as 2 primeiras consultas veem o job ainda "importing" (1 de 4); depois passa a resposta real
    const polls: number[] = []
    await page.route(
      (u) => isImportStatus(u),
      async (route) => {
        if (route.request().method() !== 'GET') return route.fallback()
        polls.push(Date.now())
        const res = await route.fetch()
        const body = await res.json()
        if (polls.length <= 2) {
          body.job = { ...body.job, status: 'processing', counters: {}, finished_at: null, download_url: null,
            progress: { ...(body.job.progress ?? {}), phase: 'importing', processed: 1, total: 4, percent: 25,
              counters: { created: 1, updated: 0, skipped: 0, errors: 0 } } }
        }
        await route.fulfill({ response: res, json: body })
      },
    )
    await openContacts(page)
    const prefix = `Poll${uniq()}`
    await startImport(page, mixedCsv(prefix, `Poll ${uniq()}`))

    const progress = page.getByTestId('contact-import-progress')
    await expect(progress).toHaveAttribute('data-status', 'processing')
    await expect(progress).toHaveAttribute('data-phase', 'importing')
    await expect(page.getByTestId('contact-import-processed')).toContainText(/1\D+4/)
    await expect(page.getByTestId('contact-import-report')).toHaveCount(0)

    await expect(progress).toHaveAttribute('data-status', 'completed', { timeout: 30_000 })
    await expect(page.getByTestId('contact-import-count-created')).toHaveText('2')
    await expect(page.getByTestId('contact-import-error-group-0-lines')).toContainText(/3\D+4/)
    expect(polls.length).toBeGreaterThanOrEqual(3)
    // intervalo da reserva ≈ 2 s
    const gap = polls[2]! - polls[1]!
    expect(gap).toBeGreaterThanOrEqual(1_500)
    expect(gap).toBeLessThan(6_000)
  })
})

test.describe('T86 — exportações recentes e exclusão em massa', () => {
  test('AC-T86-04 painel de exportações recentes lista a exportação concluída e baixa o arquivo', async ({ page }) => {
    await loginAs(page, 'owner')
    const name = `Exp${uniq()}`
    await api(page, 'post', '/api/contacts', { name, phone: `+${newPhone()}` })
    const created = await api(page, 'post', '/api/contacts/exports', { mode: 'filtered' })
    const jobId: string = (created.job ?? created.export).id
    let job: Any
    await expect
      .poll(async () => {
        const b = await api(page, 'get', `/api/contacts/exports/${jobId}`)
        job = b.job ?? b.export
        return job.status
      }, { timeout: 30_000 })
      .toBe('completed')

    await openContacts(page)
    await page.getByTestId('contacts-exports-recent').click()
    await expect(page.getByTestId('contact-exports-panel')).toBeVisible()
    const item = page.getByTestId(`contact-exports-item-${jobId}`)
    await expect(item).toBeVisible()
    await expect(item).toHaveAttribute('data-status', 'completed')
    if (job.file_name) await expect(item).toContainText(job.file_name)

    const dl = page.waitForEvent('download')
    await page.getByTestId(`contact-exports-download-${jobId}`).click()
    const download = await dl
    if (job.file_name) expect(download.suggestedFilename()).toBe(job.file_name)
    const text = await readFile((await download.path())!, 'utf8')
    expect(text).toContain(name)

    await page.getByTestId('contact-exports-close').click()
    await expect(page.getByTestId('contact-exports-panel')).toBeHidden()
  })

  test('AC-T86-04 exportação feita na tela aparece no painel e fica disponível para download', async ({ page }) => {
    await loginAs(page, 'owner')
    await api(page, 'post', '/api/contacts', { name: `Tela${uniq()}`, phone: `+${newPhone()}` })
    await openContacts(page)
    await page.getByTestId('contacts-exports-recent').click()
    await expect(page.getByTestId('contact-exports-empty')).toBeVisible()
    await page.getByTestId('contact-exports-close').click()

    await page.getByTestId('contacts-export-csv').filter({ visible: true }).first().click()
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/contacts/exports')
    await page.getByTestId('contacts-export-confirm').click()
    const body = await (await post).json()
    const jobId: string = (body.job ?? body.export).id
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('contacts-export-dialog')).toBeHidden()

    await page.getByTestId('contacts-exports-recent').click()
    const item = page.getByTestId(`contact-exports-item-${jobId}`)
    await expect(item).toBeVisible()
    await expect(item).toHaveAttribute('data-status', 'completed', { timeout: 30_000 })
    const href = await page.getByTestId(`contact-exports-download-${jobId}`).getAttribute('href')
    expect(href).toBeTruthy()
    const res = await page.request.get(href!)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-disposition']).toMatch(/attachment/)
  })

  test('AC-T86-04 exclusão em massa mostra o progresso até o fim', async ({ page }) => {
    await loginAs(page, 'owner')
    const prefix = `Del${uniq()}`
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await api(page, 'post', '/api/contacts', { name: `${prefix} ${i}`, phone: `+${newPhone()}` })).contact.id)
    await openContacts(page)
    const req = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/contacts' && new URL(r.url()).searchParams.get('search') === prefix)
    await page.getByTestId('contacts-search').fill(prefix)
    await req
    for (const id of ids.slice(0, 2)) await page.getByTestId(`contacts-select-${id}`).filter({ visible: true }).click()
    await page.getByTestId('contacts-bulk-delete').click()
    await expect(page.getByTestId('contacts-bulk-delete-dialog')).toBeVisible()
    await page.getByTestId('contacts-bulk-delete-confirm').click()
    await expect(page.getByTestId('contacts-bulk-delete-progress').or(page.getByTestId('contacts-bulk-delete-done')).first()).toBeVisible()
    await expect(page.getByTestId('contacts-bulk-delete-done')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('contacts-bulk-delete-failed')).toHaveCount(0)
    await page.getByTestId('contacts-bulk-delete-close').click()
    for (const id of ids.slice(0, 2)) expect((await page.request.get(`/api/contacts/${id}`)).status()).toBe(404)
    expect((await page.request.get(`/api/contacts/${ids[2]}`)).status()).toBe(200)
  })
})

test.describe('T86 — permissões', () => {
  test('AC-T86-04 member vê as exportações recentes, mas não "Novo contato" nem "Importar CSV"', async ({ page }) => {
    await loginAs(page, 'member')
    await openContacts(page)
    await expect(page.getByTestId('contacts-exports-recent')).toBeVisible()
    await expect(page.getByTestId('contacts-new')).toHaveCount(0)
    await expect(page.getByTestId('contacts-import-csv')).toHaveCount(0)
  })
})
