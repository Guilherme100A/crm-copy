// AC-T96-01 pela API: CRUD de avisos e banners no admin; o cliente (/api/announcements, /api/banners e bootstrap)
// recebe só ativos e não expirados, por prioridade decrescente. Avisos/banners são globais: cada teste usa um marcador
// próprio no título e filtra por ele.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uniqueId } from '../helpers/factories'
import { owner, platformAdmin, startEnv, type Env, type User } from './setup'

let env: Env
let admin: User

beforeAll(async () => {
  env = await startEnv()
  admin = await platformAdmin(env)
}, 120_000)

afterAll(async () => {
  await env?.close()
})

const IMG = 'https://cdn.example.test/banner.png'
const tagged = (items: Array<{ title: string | null }>, tag: string) => items.filter((i) => (i.title ?? '').includes(tag))

async function createAnnouncement(body: Record<string, unknown>) {
  const r = await admin.c.post('/api/admin/announcements', body)
  expect(r.status, r.text).toBe(201)
  return r.body.announcement
}

async function createBanner(body: Record<string, unknown>) {
  const r = await admin.c.post('/api/admin/banners', body)
  expect(r.status, r.text).toBe(201)
  return r.body.banner
}

describe('T96 — avisos no admin (AC-T96-01)', () => {
  it('AC-T96-01 cria aviso com defaults (info, prioridade 0, ativo, sem expiração) e grava auditoria global', async () => {
    const tag = uniqueId('av')
    const a = await createAnnouncement({ title: `Aviso ${tag}`, message: 'Olá a todos' })
    expect(a).toMatchObject({ title: `Aviso ${tag}`, message: 'Olá a todos', announcement_type: 'info', priority: 0, active: true, expires_at: null, image_url: null, url: null })
    expect(typeof a.id).toBe('string')

    const rows = await env.q(`SELECT company_id, actor_user_id, action, target_id, detail FROM crm.audit_logs WHERE action = 'admin.announcement.create' AND target_id = $1`, [a.id])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ company_id: null, actor_user_id: admin.userId })
    expect(rows[0].detail).toMatchObject({ admin: true, global: true })
  })

  it('AC-T96-01 aceita os quatro tipos, prioridade, expiração, imagem/link e o fio legado { announcement }', async () => {
    const tag = uniqueId('tipos')
    for (const t of ['info', 'warning', 'error', 'success']) {
      const a = await createAnnouncement({ title: `${t} ${tag}`, message: 'm', announcement_type: t, priority: 7, expires_at: '2030-01-01T00:00:00.000Z', image_url: 'https://img.example.test/a.png', url: 'https://example.test/x', active: false })
      expect(a).toMatchObject({ announcement_type: t, priority: 7, active: false, image_url: 'https://img.example.test/a.png', url: 'https://example.test/x' })
      expect(new Date(a.expires_at).toISOString()).toBe('2030-01-01T00:00:00.000Z')
    }
    const legacy = await createAnnouncement({ announcement: { title: `legado ${tag}`, message: 'm', announcement_type: 'warning' } })
    expect(legacy).toMatchObject({ title: `legado ${tag}`, announcement_type: 'warning' })
  })

  it('AC-T96-01 validação → 422 (tipo inválido, sem título/mensagem, expiração inválida, prioridade não inteira, URL não http)', async () => {
    const bad: Record<string, unknown>[] = [
      { title: 'x', message: 'm', announcement_type: 'danger' },
      { message: 'm' },
      { title: 'x' },
      { title: '   ', message: 'm' },
      { title: 'x', message: 'm', expires_at: 'amanhã' },
      { title: 'x', message: 'm', priority: 1.5 },
      { title: 'x', message: 'm', priority: '3' },
      { title: 'x', message: 'm', active: 'sim' },
      { title: 'x', message: 'm', url: 'javascript:alert(1)' },
    ]
    for (const body of bad) {
      const r = await admin.c.post('/api/admin/announcements', body)
      expect(r.status, JSON.stringify(body)).toBe(422)
      expect(r.body.error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('AC-T96-01 lê, edita (PATCH e PUT), lista com busca/paginação e exclui; id inexistente → 404', async () => {
    const tag = uniqueId('crud')
    const a = await createAnnouncement({ title: `Original ${tag}`, message: 'm' })

    const got = await admin.c.get(`/api/admin/announcements/${a.id}`)
    expect(got.status).toBe(200)
    expect(got.body.announcement).toMatchObject({ id: a.id, title: `Original ${tag}` })

    const p = await admin.c.patch(`/api/admin/announcements/${a.id}`, { priority: 5, announcement_type: 'error' })
    expect(p.status, p.text).toBe(200)
    expect(p.body.announcement).toMatchObject({ title: `Original ${tag}`, priority: 5, announcement_type: 'error' })

    const put = await admin.c.put(`/api/admin/announcements/${a.id}`, { announcement: { title: `Editado ${tag}`, active: false } })
    expect(put.status, put.text).toBe(200)
    expect(put.body.announcement).toMatchObject({ title: `Editado ${tag}`, active: false, priority: 5 })

    expect((await admin.c.patch(`/api/admin/announcements/${a.id}`, { announcement_type: 'nope' })).status).toBe(422)

    for (let i = 0; i < 3; i++) await createAnnouncement({ title: `Lista ${tag} ${i}`, message: 'm' })
    const page1 = await admin.c.get(`/api/admin/announcements?search=${encodeURIComponent(`Lista ${tag}`)}&page=1&limit=2`)
    expect(page1.status, page1.text).toBe(200)
    expect(page1.body.items).toHaveLength(2)
    expect(page1.body.page).toBeTruthy()
    const page2 = await admin.c.get(`/api/admin/announcements?search=${encodeURIComponent(`Lista ${tag}`)}&page=2&limit=2`)
    expect(page2.body.items).toHaveLength(1)
    const ids = [...page1.body.items, ...page2.body.items].map((x: { id: string }) => x.id)
    expect(new Set(ids).size).toBe(3)

    const del = await admin.c.delete(`/api/admin/announcements/${a.id}`)
    expect(del.status).toBe(204)
    expect((await admin.c.get(`/api/admin/announcements/${a.id}`)).status).toBe(404)
    expect((await admin.c.delete(`/api/admin/announcements/${a.id}`)).status).toBe(404)
    expect((await admin.c.get('/api/admin/announcements/nao-e-uuid')).status).toBe(404)

    const actions = (await env.q(`SELECT action FROM crm.audit_logs WHERE target_id = $1 ORDER BY created_at`, [a.id])).map((r) => r.action)
    expect(actions).toEqual(expect.arrayContaining(['admin.announcement.create', 'admin.announcement.update', 'admin.announcement.delete']))
  })
})

describe('T96 — banners no admin (AC-T96-01)', () => {
  it('AC-T96-01 banner exige imagem (http/https) → 422; com imagem → 201 com defaults', async () => {
    for (const body of [{ title: 'sem imagem' }, { title: 'vazia', image_url: '' }, { title: 'ftp', image_url: 'ftp://x.test/a.png' }, { title: 'rel', image_url: '/img/a.png' }]) {
      const r = await admin.c.post('/api/admin/banners', body)
      expect(r.status, JSON.stringify(body)).toBe(422)
      expect(r.body.error.code).toBe('VALIDATION_ERROR')
    }
    const tag = uniqueId('bn')
    const b = await createBanner({ title: `Banner ${tag}`, image_url: IMG })
    expect(b).toMatchObject({ title: `Banner ${tag}`, image_url: IMG, priority: 0, active: true, expires_at: null, url: null })
    const legacy = await createBanner({ banner: { title: `Legado ${tag}`, image_url: IMG, url: 'https://example.test/promo', priority: 3 } })
    expect(legacy).toMatchObject({ url: 'https://example.test/promo', priority: 3 })
  })

  it('AC-T96-01 edita, não deixa remover a imagem, lista e exclui banner (auditoria admin.banner.*)', async () => {
    const tag = uniqueId('bcrud')
    const b = await createBanner({ title: `B ${tag}`, image_url: IMG })
    const p = await admin.c.patch(`/api/admin/banners/${b.id}`, { priority: 9, active: false })
    expect(p.status, p.text).toBe(200)
    expect(p.body.banner).toMatchObject({ priority: 9, active: false, image_url: IMG })
    for (const image_url of [null, '', 'nao-url']) {
      expect((await admin.c.patch(`/api/admin/banners/${b.id}`, { image_url })).status, String(image_url)).toBe(422)
    }
    const list = await admin.c.get(`/api/admin/banners?search=${encodeURIComponent(tag)}`)
    expect(list.status).toBe(200)
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([b.id])

    expect((await admin.c.delete(`/api/admin/banners/${b.id}`)).status).toBe(204)
    expect((await admin.c.get(`/api/admin/banners/${b.id}`)).status).toBe(404)
    const rows = await env.q(`SELECT action, company_id FROM crm.audit_logs WHERE target_id = $1`, [b.id])
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['admin.banner.create', 'admin.banner.update', 'admin.banner.delete']))
    expect(rows.every((r) => r.company_id === null)).toBe(true)
  })
})

describe('T96 — permissões (AC-T96-01)', () => {
  it('AC-T96-01 dono de empresa recebe 403 no CRUD admin; sem sessão → 401; nada é criado', async () => {
    const o = await owner(env)
    const tag = uniqueId('proibido')
    const calls: Array<[string, string, unknown?]> = [
      ['get', '/api/admin/announcements'],
      ['post', '/api/admin/announcements', { title: tag, message: 'm' }],
      ['get', '/api/admin/banners'],
      ['post', '/api/admin/banners', { title: tag, image_url: IMG }],
    ]
    for (const [m, path, body] of calls) {
      expect((await (o.c as unknown as Record<string, (p: string, b?: unknown) => Promise<{ status: number }>>)[m]!(path, body)).status, `${m} ${path}`).toBe(403)
      expect((await env.app.request(path, { method: m.toUpperCase() })).status, `anon ${m} ${path}`).toBe(401)
    }
    expect(await env.q(`SELECT 1 FROM crm.announcements WHERE title = $1 UNION ALL SELECT 1 FROM crm.banners WHERE title = $1`, [tag])).toEqual([])
  })

  it('AC-T96-01 rotas do cliente: qualquer membro com empresa lê (200), sem sessão → 401', async () => {
    const o = await owner(env)
    expect((await o.c.get('/api/announcements')).status).toBe(200)
    expect((await o.c.get('/api/banners')).status).toBe(200)
    expect((await env.app.request('/api/announcements')).status).toBe(401)
    expect((await env.app.request('/api/banners')).status).toBe(401)
  })
})

describe('T96 — o cliente recebe só ativos e não expirados por prioridade (AC-T96-01)', () => {
  it('AC-T96-01 GET /api/announcements: filtra inativo e expirado (relógio injetado) e ordena por prioridade decrescente', async () => {
    const tag = uniqueId('cli')
    env.clock.set('2026-10-16T12:00:00.000Z')
    const low = await createAnnouncement({ title: `low ${tag}`, message: 'm', priority: 1 })
    const high = await createAnnouncement({ title: `high ${tag}`, message: 'm', priority: 10, announcement_type: 'warning', expires_at: '2026-10-20T00:00:00.000Z' })
    const mid = await createAnnouncement({ title: `mid ${tag}`, message: 'm', priority: 5, announcement_type: 'success' })
    await createAnnouncement({ title: `inactive ${tag}`, message: 'm', priority: 100, active: false })
    await createAnnouncement({ title: `expired ${tag}`, message: 'm', priority: 50, expires_at: '2026-10-16T11:59:59.000Z' })

    const o = await owner(env)
    const r = await o.c.get('/api/announcements')
    expect(r.status).toBe(200)
    expect(tagged(r.body.items, tag).map((x: { id: string }) => x.id)).toEqual([high.id, mid.id, low.id])
    expect(tagged(r.body.items, tag)[0]).toMatchObject({ title: `high ${tag}`, message: 'm', announcement_type: 'warning', priority: 10 })

    // o tempo passa: o de prioridade 10 expira
    env.clock.set('2026-10-20T00:00:00.000Z')
    const r2 = await o.c.get('/api/announcements')
    expect(tagged(r2.body.items, tag).map((x: { id: string }) => x.id)).toEqual([mid.id, low.id])

    // desativar pelo admin tira do cliente; reativar devolve
    expect((await admin.c.patch(`/api/admin/announcements/${mid.id}`, { active: false })).status).toBe(200)
    expect(tagged((await o.c.get('/api/announcements')).body.items, tag).map((x: { id: string }) => x.id)).toEqual([low.id])
    expect((await admin.c.patch(`/api/admin/announcements/${mid.id}`, { active: true, priority: 0 })).status).toBe(200)
    expect(tagged((await o.c.get('/api/announcements')).body.items, tag).map((x: { id: string }) => x.id)).toEqual([low.id, mid.id])
    env.clock.set('2026-10-16T12:00:00.000Z')
  })

  it('AC-T96-01 GET /api/banners: filtra inativo e expirado e ordena por prioridade decrescente', async () => {
    const tag = uniqueId('bcli')
    env.clock.set('2026-10-16T12:00:00.000Z')
    const b1 = await createBanner({ title: `b1 ${tag}`, image_url: IMG, priority: 2 })
    const b3 = await createBanner({ title: `b3 ${tag}`, image_url: IMG, priority: 30, url: 'https://example.test/p' })
    const b2 = await createBanner({ title: `b2 ${tag}`, image_url: IMG, priority: 20, expires_at: '2026-10-17T00:00:00.000Z' })
    await createBanner({ title: `off ${tag}`, image_url: IMG, priority: 99, active: false })
    await createBanner({ title: `old ${tag}`, image_url: IMG, priority: 98, expires_at: '2026-10-01T00:00:00.000Z' })

    const o = await owner(env)
    const r = await o.c.get('/api/banners')
    expect(r.status).toBe(200)
    expect(tagged(r.body.items, tag).map((x: { id: string }) => x.id)).toEqual([b3.id, b2.id, b1.id])
    expect(tagged(r.body.items, tag)[0]).toMatchObject({ image_url: IMG, url: 'https://example.test/p', priority: 30 })

    env.clock.set('2026-10-17T00:00:01.000Z')
    expect(tagged((await o.c.get('/api/banners')).body.items, tag).map((x: { id: string }) => x.id)).toEqual([b3.id, b1.id])
    env.clock.set('2026-10-16T12:00:00.000Z')
  })

  it('AC-T96-01 bootstrap do dashboard traz os mesmos avisos e banners ativos e não expirados, por prioridade', async () => {
    // a rota do bootstrap usa o relógio real: datas relativas a agora
    const tag = uniqueId('boot')
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const past = new Date(Date.now() - 86_400_000).toISOString()
    const a1 = await createAnnouncement({ title: `a1 ${tag}`, message: 'm', priority: 1 })
    const a2 = await createAnnouncement({ title: `a2 ${tag}`, message: 'm', priority: 9, expires_at: future })
    await createAnnouncement({ title: `ax ${tag}`, message: 'm', priority: 50, expires_at: past })
    await createAnnouncement({ title: `ay ${tag}`, message: 'm', priority: 60, active: false })
    const bA = await createBanner({ title: `bA ${tag}`, image_url: IMG, priority: 4 })
    const bB = await createBanner({ title: `bB ${tag}`, image_url: IMG, priority: 8 })
    await createBanner({ title: `bX ${tag}`, image_url: IMG, priority: 80, expires_at: past })
    await createBanner({ title: `bY ${tag}`, image_url: IMG, priority: 90, active: false })

    const o = await owner(env)
    const r = await o.c.get('/api/dashboard/bootstrap')
    expect(r.status, r.text).toBe(200)
    expect(tagged(r.body.announcements, tag).map((x: { id: string }) => x.id)).toEqual([a2.id, a1.id])
    expect(tagged(r.body.banners, tag).map((x: { id: string }) => x.id)).toEqual([bB.id, bA.id])
    expect(tagged(r.body.announcements, tag)[0]).toMatchObject({ title: `a2 ${tag}`, announcement_type: 'info', priority: 9 })
  })
})
