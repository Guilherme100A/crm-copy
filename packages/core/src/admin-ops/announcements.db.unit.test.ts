// Avisos e banners do admin (T96, AC-T96-01) com Postgres real: CRUD, validação 422, visibilidade do cliente
// (ativos, não expirados, prioridade decrescente) com relógio injetável, e o bootstrap do dashboard.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { announcements, banners, companies, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { dashboardBootstrap } from '../dashboard/bootstrap/index'
import { activeAnnouncements, activeBanners, AnnouncementsService } from './announcements'
import { AdminOpsError } from './errors'

let temp: TempDatabase
let db: Database
const T0 = Date.parse('2026-05-01T12:00:00Z')
let clock = T0
const svc = () => new AnnouncementsService({ db, now: () => new Date(clock) })
const caught = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as AdminOpsError,
  )
const paths = (e: AdminOpsError | null) => ((e?.details?.fields as { path: string }[]) ?? []).map((f) => f.path).sort()

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

beforeEach(async () => {
  clock = T0
  await db.delete(announcements)
  await db.delete(banners)
})

describe('avisos: CRUD e validação', () => {
  it('cria com defaults (info, prioridade 0, ativo), aceita o fio legado { announcement } e devolve snake_case', async () => {
    const a = await svc().createAnnouncement({ announcement: { title: ' Manutenção ', message: 'Hoje às 22h' } })
    expect(a).toMatchObject({
      title: 'Manutenção',
      message: 'Hoje às 22h',
      announcement_type: 'info',
      priority: 0,
      active: true,
      expires_at: null,
      image_url: null,
      url: null,
    })
    expect(a.created_at).toBe(new Date(T0).toISOString())
    const b = await svc().createAnnouncement({
      title: 'B',
      message: 'm',
      announcement_type: 'warning',
      priority: 5,
      expires_at: '2026-06-01T00:00:00-03:00',
      image_url: 'https://cdn.example.com/a.png',
      url: 'https://example.com',
      active: false,
    })
    expect(b).toMatchObject({
      announcement_type: 'warning',
      priority: 5,
      active: false,
      expires_at: '2026-06-01T03:00:00.000Z',
      image_url: 'https://cdn.example.com/a.png',
    })
  })

  it('422 em tipo inválido, título/mensagem vazios, expiração inválida, prioridade não inteira e URL não http', async () => {
    expect(paths(await caught(svc().createAnnouncement({ title: '', message: '  ' })))).toEqual(['message', 'title'])
    expect(
      paths(await caught(svc().createAnnouncement({ title: 't', message: 'm', announcement_type: 'danger' }))),
    ).toEqual(['announcement_type'])
    expect(paths(await caught(svc().createAnnouncement({ title: 't', message: 'm', expires_at: 'amanhã' })))).toEqual([
      'expires_at',
    ])
    expect(paths(await caught(svc().createAnnouncement({ title: 't', message: 'm', priority: 1.5 })))).toEqual([
      'priority',
    ])
    expect(
      paths(await caught(svc().createAnnouncement({ title: 't', message: 'm', url: 'javascript:alert(1)' }))),
    ).toEqual(['url'])
    const e = await caught(svc().createAnnouncement({ title: 't', message: 'm', announcement_type: 'danger' }))
    expect(e).toBeInstanceOf(AdminOpsError)
    expect(e!.code).toBe('validation')
  })

  it('atualiza só os campos enviados (null limpa a expiração), lista paginada com busca e exclui', async () => {
    const a = await svc().createAnnouncement({ title: 'Alpha', message: 'm', expires_at: '2026-06-01T00:00:00Z' })
    clock += 60_000
    const r = await svc().updateAnnouncement(a.id, { priority: 9, expires_at: null })
    expect(r.fields.sort()).toEqual(['expires_at', 'priority'])
    expect(r.announcement).toMatchObject({
      title: 'Alpha',
      priority: 9,
      expires_at: null,
      updated_at: new Date(T0 + 60_000).toISOString(),
    })
    for (let i = 0; i < 3; i++) await svc().createAnnouncement({ title: `Beta ${i}`, message: '100% off' })
    const page1 = await svc().listAnnouncements({ limit: '2' })
    expect(page1.items.map((x) => x.title)[0]).toBe('Alpha')
    expect(page1.page).toEqual({ page: 1, limit: 2, total_count: 4, total_pages: 2, has_more: true })
    expect((await svc().listAnnouncements({ search: 'beta' })).items).toHaveLength(3)
    // `%` da busca é literal.
    expect((await svc().listAnnouncements({ search: '100%' })).items).toHaveLength(3)
    expect((await svc().listAnnouncements({ search: '%' })).items).toHaveLength(3)
    expect((await svc().listAnnouncements({ page: '2', limit: '3', skip_total: '1' })).page).toEqual({
      page: 2,
      limit: 3,
      total_count: null,
      total_pages: null,
      has_more: false,
    })
    await svc().deleteAnnouncement(a.id)
    expect((await caught(svc().getAnnouncement(a.id)))?.code).toBe('not_found')
    expect((await caught(svc().getAnnouncement('nao-e-uuid')))?.code).toBe('not_found')
    expect((await caught(svc().updateAnnouncement('00000000-0000-4000-8000-000000000000', { title: 'x' })))?.code).toBe(
      'not_found',
    )
  })
})

describe('banners: imagem obrigatória', () => {
  it('sem image_url ou com URL não http → 422; com imagem cria (title opcional = nome interno)', async () => {
    expect(paths(await caught(svc().createBanner({ title: 'Black Friday' })))).toEqual(['image_url'])
    expect(paths(await caught(svc().createBanner({ image_url: '' })))).toEqual(['image_url'])
    expect(paths(await caught(svc().createBanner({ image_url: 'ftp://x/y.png' })))).toEqual(['image_url'])
    const b = await svc().createBanner({
      banner: { image_url: 'https://cdn.example.com/b.png', url: 'https://example.com/promo', priority: 3 },
    })
    expect(b).toMatchObject({
      title: null,
      image_url: 'https://cdn.example.com/b.png',
      url: 'https://example.com/promo',
      priority: 3,
      active: true,
    })
    expect(paths(await caught(svc().updateBanner(b.id, { image_url: null })))).toEqual(['image_url'])
    const u = await svc().updateBanner(b.id, { title: 'Promo', url: '' })
    expect(u.banner).toMatchObject({ title: 'Promo', url: null, image_url: 'https://cdn.example.com/b.png' })
    expect((await svc().listBanners({ search: 'promo' })).items.map((x) => x.id)).toEqual([b.id])
  })
})

describe('cliente: só ativos e não expirados, por prioridade decrescente', () => {
  it('filtra inativos e expirados (expiração exata em now já expirou) e ordena por prioridade, depois o mais novo', async () => {
    const s = svc()
    const low = await s.createAnnouncement({ title: 'low', message: 'm', priority: 1 })
    clock += 1000
    const high = await s.createAnnouncement({
      title: 'high',
      message: 'm',
      priority: 10,
      expires_at: new Date(T0 + 3_600_000).toISOString(),
    })
    clock += 1000
    const lowNewer = await s.createAnnouncement({ title: 'low-newer', message: 'm', priority: 1 })
    await s.createAnnouncement({ title: 'inactive', message: 'm', priority: 99, active: false })
    await s.createAnnouncement({
      title: 'expired',
      message: 'm',
      priority: 50,
      expires_at: new Date(T0 - 1).toISOString(),
    })
    const at = new Date(T0 + 10_000)
    expect((await activeAnnouncements(db, at)).map((a) => a.id)).toEqual([high.id, lowNewer.id, low.id])
    // Uma hora depois o de prioridade 10 expira.
    expect((await activeAnnouncements(db, new Date(T0 + 3_600_000))).map((a) => a.id)).toEqual([lowNewer.id, low.id])

    const b1 = await s.createBanner({ image_url: 'https://x.test/1.png', priority: 2 })
    const b2 = await s.createBanner({ image_url: 'https://x.test/2.png', priority: 7 })
    await s.createBanner({ image_url: 'https://x.test/3.png', priority: 9, active: false })
    await s.createBanner({
      image_url: 'https://x.test/4.png',
      priority: 9,
      expires_at: new Date(T0 - 1000).toISOString(),
    })
    expect((await activeBanners(db, at)).map((b) => b.id)).toEqual([b2.id, b1.id])
    // Desativar some na hora.
    await s.updateBanner(b2.id, { active: false })
    expect((await activeBanners(db, at)).map((b) => b.id)).toEqual([b1.id])
  })

  it('bootstrap do dashboard devolve os mesmos avisos e banners (o resto do bootstrap segue igual)', async () => {
    const [co] = await db
      .insert(companies)
      .values({ name: 'C', slug: `c-${randomBytes(4).toString('hex')}` })
      .returning({ id: companies.id })
    const s = svc()
    const a = await s.createAnnouncement({ title: 'a', message: 'm', priority: 1 })
    const b = await s.createAnnouncement({ title: 'b', message: 'm', priority: 2 })
    await s.createAnnouncement({ title: 'velho', message: 'm', expires_at: new Date(T0 - 1).toISOString() })
    const banner = await s.createBanner({ image_url: 'https://x.test/b.png' })
    const boot = await dashboardBootstrap(db, co!.id, { includeSales: false, now: new Date(T0 + 1000) })
    expect(boot.announcements.map((x) => x.id)).toEqual([b.id, a.id])
    expect(boot.banners.map((x) => x.id)).toEqual([banner.id])
    expect(boot).toMatchObject({ products: [], connections: [], filter_groups: [], leads_count: 0 })
    expect(boot.lifetime_revenue).toBeUndefined()
  })
})
