// AC-T26-01..06 — contatos, etiquetas, campos personalizados, consentimento e permissões (caixa-preta via HTTP).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { addMember, brLandline, brMobile, type Env, fakeLid, owner, type Owner, startEnv, uniq } from './setup'

let env: Env
let a: Owner

beforeAll(async () => {
  env = await startEnv()
  a = await owner(env)
})
afterAll(async () => {
  await env?.close()
})

const create = (o: Owner, body: Record<string, unknown>) => o.c.post('/api/contacts', { name: `Contato ${uniq('')}`, ...body })

async function created(o: Owner, body: Record<string, unknown>) {
  const res = await create(o, body)
  expect(res.status, res.text).toBe(201)
  return res.body.contact
}

describe('T26 — telefone e duplicados', () => {
  it('AC-T26-01 telefone BR com 10–11 dígitos é normalizado para E.164', async () => {
    const mobile = brMobile()
    expect((await created(a, { phone: mobile.raw })).phone_e164).toBe(mobile.e164)
    const land = brLandline()
    expect((await created(a, { phone: land.raw })).phone_e164).toBe(land.e164)
    const withDdi = brMobile()
    expect((await created(a, { phone: `+55 ${withDdi.raw}` })).phone_e164).toBe(withDdi.e164)
  })

  it('AC-T26-01 telefones internacionais de 8–15 dígitos são normalizados para E.164', async () => {
    const n = String(Math.floor(Math.random() * 1e4)).padStart(4, '0')
    expect((await created(a, { phone: `+1 415 555 ${n}` })).phone_e164).toBe(`+1415555${n}`)
    const pt = String(Math.floor(Math.random() * 1e6)).padStart(6, '0')
    expect((await created(a, { phone: `+351 91 2${pt.slice(0, 2)} ${pt.slice(2)}` })).phone_e164).toBe(`+351912${pt}`)
  })

  it('AC-T26-01 telefone inválido → 422 com o campo phone', async () => {
    for (const phone of ['123', '+55 99999-8888', 'abc']) {
      const res = await create(a, { phone })
      expectApiError(res, 'VALIDATION_ERROR', 422)
      expect(JSON.stringify(res.body.error.details?.fields ?? []), phone).toContain('phone')
    }
  })

  it('AC-T26-01 telefone duplicado na mesma empresa → 409 com o id existente (mesmo em outro formato)', async () => {
    const p = brMobile()
    const first = await created(a, { phone: p.raw })
    const dup = await create(a, { phone: p.e164 })
    expectApiError(dup, 'CONFLICT', 409)
    expect(dup.body.error.details?.id).toBe(first.id)
    const list = await a.c.get(`/api/contacts?search=${encodeURIComponent(p.e164.slice(1))}`)
    expect(list.status, list.text).toBe(200)
  })

  it('AC-T26-01 o mesmo telefone em outra empresa é aceito', async () => {
    const p = brMobile()
    await created(a, { phone: p.raw })
    const b = await owner(env)
    const other = await created(b, { phone: p.raw })
    expect(other.phone_e164).toBe(p.e164)
  })
})

describe('T26 — identidade LID/PN', () => {
  it('AC-T26-02 contato só com wa_lid (sem telefone) é aceito', async () => {
    const lid = fakeLid()
    const c = await created(a, { wa_lid: lid })
    expect(c.wa_lid).toBe(lid)
    expect(c.phone_e164 ?? null).toBeNull()
    const dup = await create(a, { wa_lid: lid })
    expectApiError(dup, 'CONFLICT', 409)
    expect(dup.body.error.details?.id).toBe(c.id)
  })

  it('AC-T26-02 contato sem telefone e sem wa_lid → 422', async () => {
    expectApiError(await create(a, {}), 'VALIDATION_ERROR', 422)
  })

  async function label(name = uniq('Et ')) {
    const res = await a.c.post('/api/labels', { name, color: '#12AB9F' })
    expect(res.status, res.text).toBe(201)
    return res.body.label
  }

  it('AC-T26-02 mergeIdentity funde o contato LID no PN, preservando etiquetas, campos e o id do mais antigo (LID mais antigo)', async () => {
    const [l1, l2] = [await label(), await label()]
    const lid = fakeLid()
    const p = brMobile()
    const lidContact = await created(a, { wa_lid: lid, label_ids: [l1.id], custom_fields: { cor_favorita: 'azul' } })
    await new Promise((r) => setTimeout(r, 20))
    const pnContact = await created(a, { phone: p.raw, label_ids: [l2.id], custom_fields: { plano: 'anual' } })

    const res = await a.c.post('/api/contacts/merge-identity', { lid, pn: p.e164 })
    expect(res.status, res.text).toBe(200)
    const s = res.body.contact
    expect(s.id).toBe(lidContact.id)
    expect(s.phone_e164).toBe(p.e164)
    expect(s.wa_lid).toBe(lid)
    expect(s.labels.map((l: any) => l.id).sort()).toEqual([l1.id, l2.id].sort())
    expect(s.custom_fields).toMatchObject({ cor_favorita: 'azul', plano: 'anual' })

    expect((await a.c.get(`/api/contacts/${pnContact.id}`)).status).toBe(404)
    const got = await a.c.get(`/api/contacts/${lidContact.id}`)
    expect(got.status, got.text).toBe(200)
    expect(got.body.contact.phone_e164).toBe(p.e164)
  })

  it('AC-T26-02 mergeIdentity mantém o id do mais antigo quando o PN é o mais antigo', async () => {
    const l1 = await label()
    const p = brMobile()
    const lid = fakeLid()
    const pnContact = await created(a, { phone: p.raw, custom_fields: { origem_lead: 'site' } })
    await new Promise((r) => setTimeout(r, 20))
    const lidContact = await created(a, { wa_lid: lid, label_ids: [l1.id] })

    const res = await a.c.post('/api/contacts/merge-identity', { lid, pn: p.e164 })
    expect(res.status, res.text).toBe(200)
    expect(res.body.contact.id).toBe(pnContact.id)
    expect(res.body.contact.wa_lid).toBe(lid)
    expect(res.body.contact.labels.map((l: any) => l.id)).toContain(l1.id)
    expect(res.body.contact.custom_fields).toMatchObject({ origem_lead: 'site' })
    expect((await a.c.get(`/api/contacts/${lidContact.id}`)).status).toBe(404)
  })
})

describe('T26 — campos personalizados', () => {
  const catalog = async () => {
    const res = await a.c.get('/api/custom-fields')
    expect(res.status, res.text).toBe(200)
    return res.body.items as any[]
  }

  it('AC-T26-03 chave nova gravada num contato aparece no catálogo', async () => {
    const key = uniq('campo_')
    await created(a, { phone: brMobile().raw, custom_fields: { [key]: 'valor' } })
    expect((await catalog()).map((f) => f.key)).toContain(key)

    const key2 = uniq('outro_')
    const c = await created(a, { phone: brMobile().raw })
    const patch = await a.c.patch(`/api/contacts/${c.id}`, { custom_fields: { [key2]: 'x' } })
    expect(patch.status, patch.text).toBe(200)
    expect((await catalog()).map((f) => f.key)).toContain(key2)
  })

  it('AC-T26-03 PATCH /api/custom-fields/:key só muda a descrição', async () => {
    const key = uniq('desc_')
    const post = await a.c.post('/api/custom-fields', { key, description: 'antes' })
    expect(post.status, post.text).toBe(201)

    const ok = await a.c.patch(`/api/custom-fields/${key}`, { description: 'depois' })
    expect(ok.status, ok.text).toBe(200)
    expect((await catalog()).find((f) => f.key === key)?.description).toBe('depois')

    const rename = await a.c.patch(`/api/custom-fields/${key}`, { key: `${key}_novo`, description: 'x' })
    expect(rename.status).toBe(422)
    const keys = (await catalog()).map((f) => f.key)
    expect(keys).toContain(key)
    expect(keys).not.toContain(`${key}_novo`)
  })

  it('AC-T26-03 chave com menos de 2 caracteres → 422 (catálogo e contato)', async () => {
    expectApiError(await a.c.post('/api/custom-fields', { key: 'x', description: 'curta' }), 'VALIDATION_ERROR', 422)
    expectApiError(await create(a, { phone: brMobile().raw, custom_fields: { y: '1' } }), 'VALIDATION_ERROR', 422)
  })

  it('AC-T26-03 campos de sistema existem no catálogo e não são editáveis', async () => {
    const sys = (await catalog()).filter((f) => f.system === true)
    expect(sys.map((f) => f.key)).toEqual(expect.arrayContaining(['full_name', 'first_name', 'phone_number']))
    for (const key of ['full_name', 'phone_number']) {
      const res = await a.c.patch(`/api/custom-fields/${key}`, { description: 'hack' })
      expect(res.status, `${key}: ${res.text}`).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      expect((await catalog()).find((f) => f.key === key)?.description).not.toBe('hack')
    }
    expect((await create(a, { phone: brMobile().raw, custom_fields: { full_name: 'x' } })).status).toBe(422)
  })
})

describe('T26 — etiquetas', () => {
  it('AC-T26-04 nome 2–50 e cor #RRGGBB; fora disso 422', async () => {
    expect((await a.c.post('/api/labels', { name: uniq('Ok '), color: '#A1B2C3' })).status).toBe(201)
    expect((await a.c.post('/api/labels', { name: 'ab', color: '#000000' })).status).toBe(201)
    expect((await a.c.post('/api/labels', { name: 'x'.repeat(50), color: '#ffffff' })).status).toBe(201)
    for (const body of [
      { name: 'a', color: '#000000' },
      { name: 'x'.repeat(51), color: '#000000' },
      { name: uniq('Cor '), color: 'red' },
      { name: uniq('Cor '), color: '#FFF' },
      { name: uniq('Cor '), color: '#GG0000' },
      { name: uniq('Cor '), color: '123456' },
    ])
      expectApiError(await a.c.post('/api/labels', body), 'VALIDATION_ERROR', 422)
  })

  it('AC-T26-04 listagem traz contacts_count e excluir remove os vínculos', async () => {
    const lab = (await a.c.post('/api/labels', { name: uniq('Vip '), color: '#FF0000' })).body.label
    const c1 = await created(a, { phone: brMobile().raw, label_ids: [lab.id] })
    const c2 = await created(a, { phone: brMobile().raw, label_ids: [lab.id] })

    const list = await a.c.get('/api/labels')
    expect(list.status, list.text).toBe(200)
    expect(list.body.items.find((l: any) => l.id === lab.id)?.contacts_count).toBe(2)

    const del = await a.c.delete(`/api/labels/${lab.id}`)
    expect(del.status, del.text).toBe(204)
    expect((await a.c.get('/api/labels')).body.items.some((l: any) => l.id === lab.id)).toBe(false)
    for (const c of [c1, c2]) {
      const got = await a.c.get(`/api/contacts/${c.id}`)
      expect(got.body.contact.labels.map((l: any) => l.id)).not.toContain(lab.id)
    }
    const links = await env.q(`SELECT count(*)::int AS n FROM crm.contact_labels WHERE label_id = $1`, [lab.id])
    expect(links[0].n).toBe(0)
  })
})

describe('T26 — consentimento e opt-out', () => {
  it("AC-T26-05 contato criado manualmente recebe consent = true, consent_source = 'manual' e o FakeWaGateway registra recordConsent", async () => {
    const p = brMobile()
    const c = await created(a, { phone: p.raw })
    expect(c.consent).toBe(true)
    expect(c.consent_source).toBe('manual')
    expect(env.gateway.consents).toEqual(expect.arrayContaining([expect.objectContaining({ phone: p.e164, source: 'manual' })]))
    expect(env.gateway.hasConsent(p.e164)).toBe(true)
  })

  it('AC-T26-05 marcar opt_out chama optOut e bloqueia envios até ser revertido manualmente', async () => {
    const p = brMobile()
    const c = await created(a, { phone: p.raw })
    const session = env.gateway.addSession({ state: 'STABLE' })
    const send = () => env.gateway.send({ sessionId: session.id, phone: p.e164, content: { text: 'oi' }, actor: `crm:${a.userId}` })
    await expect(send()).resolves.toBeDefined()

    const out = await a.c.patch(`/api/contacts/${c.id}`, { opt_out: true })
    expect(out.status, out.text).toBe(200)
    expect(out.body.contact.opt_out).toBe(true)
    expect(env.gateway.optOuts).toEqual(expect.arrayContaining([expect.objectContaining({ phone: p.e164 })]))
    expect(env.gateway.isOptedOut(p.e164)).toBe(true)
    await expect(send()).rejects.toMatchObject({ code: 'CONTACT_NOT_ALLOWED' })

    // atualizar outro campo não reverte o opt-out
    const other = await a.c.patch(`/api/contacts/${c.id}`, { city: 'São Paulo' })
    expect(other.status, other.text).toBe(200)
    expect(other.body.contact.opt_out).toBe(true)
    expect(env.gateway.isOptedOut(p.e164)).toBe(true)

    const back = await a.c.patch(`/api/contacts/${c.id}`, { opt_out: false })
    expect(back.status, back.text).toBe(200)
    expect(back.body.contact.opt_out).toBe(false)
    expect(env.gateway.isOptedOut(p.e164)).toBe(false)
    await expect(send()).resolves.toBeDefined()
  })
})

describe('T26 — permissões e isolamento', () => {
  it('AC-T26-06 membro sem contacts.view recebe 403 em GET /api/contacts', async () => {
    const m = await owner(env)
    await addMember(env, a.companyId, m.userId, ['chat.view'])
    m.c.setCompany(a.companyId)
    expectApiError(await m.c.get('/api/contacts'), 'FORBIDDEN', 403)

    const v = await owner(env)
    await addMember(env, a.companyId, v.userId, ['contacts.view'])
    v.c.setCompany(a.companyId)
    expect((await v.c.get('/api/contacts')).status).toBe(200)
  })

  it('AC-T26-06 contato de outra empresa → 404', async () => {
    const c = await created(a, { phone: brMobile().raw })
    const b = await owner(env)
    expectApiError(await b.c.get(`/api/contacts/${c.id}`), 'NOT_FOUND', 404)
    expectApiError(await b.c.patch(`/api/contacts/${c.id}`, { city: 'X' }), 'NOT_FOUND', 404)
    expectApiError(await b.c.delete(`/api/contacts/${c.id}`), 'NOT_FOUND', 404)
    expect((await b.c.get('/api/contacts')).body.items.some((x: any) => x.id === c.id)).toBe(false)
    expect((await a.c.get(`/api/contacts/${c.id}`)).status).toBe(200)
  })
})
