// Postgres real (SPEC 3.10): banco descartável migrado; FakeWaGateway registra consentimento e opt-out.
import { randomBytes } from 'node:crypto'
import { companies, contactLabels, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CustomFieldsService } from '../custom-fields/service'
import { LabelsService } from '../labels/service'
import { ContactsError } from './errors'
import { ContactsService } from './service'

let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

async function company(): Promise<string> {
  const slug = `c-${randomBytes(4).toString('hex')}`
  const [row] = await db.insert(companies).values({ name: slug, slug }).returning({ id: companies.id })
  return row!.id
}

function setup() {
  const gw = new FakeWaGateway()
  return { gw, contacts: new ContactsService({ db, waGateway: gw }), labels: new LabelsService(db), fields: new CustomFieldsService(db) }
}

const codeOf = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof ContactsError ? e.code : 'other'))

describe('ContactsService', () => {
  it('cria com consentimento manual; telefone duplicado → conflict com id; outra empresa aceita', async () => {
    const { gw, contacts } = setup()
    const [a, b] = [await company(), await company()]
    const c = await contacts.create(a, { name: 'Ana', phone: '(11) 99999-8888' })
    expect(c).toMatchObject({ phone_e164: '+5511999998888', consent: true, consent_source: 'manual', opt_out: false, origin: 'manual' })
    expect(gw.consents).toEqual([expect.objectContaining({ phone: '+5511999998888', source: 'manual' })])
    const dup = await contacts.create(a, { name: 'Outra', phone: '11999998888' }).catch((e) => e)
    expect(dup).toMatchObject({ code: 'conflict', details: { id: c.id, field: 'phone_e164' } })
    expect((await contacts.create(b, { name: 'Ana B', phone: '+5511999998888' })).id).not.toBe(c.id)
    expect(await codeOf(contacts.create(a, { name: 'Sem id' }))).toBe('validation')
  })

  it('opt-out bloqueia e só a reversão manual libera', async () => {
    const { gw, contacts } = setup()
    const a = await company()
    const c = await contacts.create(a, { name: 'Bia', phone: '+5511988887777' })
    await contacts.update(a, c.id, { optOut: true })
    expect(gw.isOptedOut('+5511988887777')).toBe(true)
    await contacts.update(a, c.id, { city: 'Santos' })
    expect(gw.isOptedOut('+5511988887777')).toBe(true)
    const back = await contacts.update(a, c.id, { optOut: false })
    expect(back).toMatchObject({ opt_out: false, consent: true, consent_source: 'manual' })
    expect(gw.isOptedOut('+5511988887777')).toBe(false)
  })

  it('contato só com LID; mergeIdentity preserva o mais antigo, etiquetas e campos', async () => {
    const { contacts, labels } = setup()
    const a = await company()
    const vip = await labels.create(a, { name: 'VIP', color: '#FF0000' })
    const lead = await labels.create(a, { name: 'Lead', color: '#00FF00' })
    const old = await contacts.create(a, { name: '', waLid: '123456789012345@lid', customFields: { plano: 'ouro', cor: 'azul' }, labelIds: [vip.id] })
    const pn = await contacts.create(a, { name: 'Carlos', phone: '+5511977776666', customFields: { plano: 'prata', cidade: 'SP' }, labelIds: [lead.id] })
    const merged = await contacts.mergeIdentity(a, '123456789012345@lid', '5511977776666@s.whatsapp.net')
    expect(merged).toMatchObject({ id: old.id, wa_lid: '123456789012345@lid', phone_e164: '+5511977776666', name: 'Carlos' })
    expect(merged!.custom_fields).toEqual({ plano: 'ouro', cor: 'azul', cidade: 'SP' })
    expect(merged!.labels.map((l) => l.name).sort()).toEqual(['Lead', 'VIP'])
    expect(await codeOf(contacts.get(a, pn.id))).toBe('not_found')
    expect(await contacts.mergeIdentity(a, '999999999999999@lid', '+5511900000000')).toBeNull()
  })

  it('upsertFromWhatsApp cria com consentimento inbound e depois só completa', async () => {
    const { gw, contacts } = setup()
    const a = await company()
    const first = await contacts.upsertFromWhatsApp(a, { lid: '777777777777777@lid', pushName: 'Duda', ad: { ctwaClid: 'clid-1', sourceId: '42' } })
    expect(first.created).toBe(true)
    expect(first.contact).toMatchObject({ origin: 'whatsapp', consent_source: 'inbound', name: 'Duda', ctwa_clid: 'clid-1', source_id: '42' })
    expect(gw.consents).toHaveLength(0) // sem telefone não há o que registrar
    const again = await contacts.upsertFromWhatsApp(a, { lid: '777777777777777@lid', phone: '+5511966665555', name: 'Outro' })
    expect(again).toMatchObject({ created: false, contact: { id: first.contact.id, phone_e164: '+5511966665555', name: 'Duda' } })
  })

  it('campos personalizados entram no catálogo; sistema é somente leitura', async () => {
    const { contacts, fields } = setup()
    const a = await company()
    await contacts.create(a, { name: 'Eva', phone: '+5511955554444', customFields: { 'Plano Pago': 'sim' } })
    const list = await fields.list(a)
    expect(list.find((f) => f.key === 'plano pago')).toMatchObject({ example_value: 'sim', system: false })
    expect(list.filter((f) => f.system).map((f) => f.key)).toContain('full_name')
    expect((await fields.updateDescription(a, 'plano pago', 'Se pagou')).description).toBe('Se pagou')
    expect(await codeOf(fields.updateDescription(a, 'full_name', 'x'))).toBe('validation')
    expect(await codeOf(fields.updateDescription(a, 'nao_existe', 'x'))).toBe('not_found')
    expect(await codeOf(contacts.create(a, { name: 'F', phone: '+5511944443333', customFields: { x: 1 } }))).toBe('validation')
  })

  it('etiquetas: validação, contagem e exclusão remove vínculos', async () => {
    const { contacts, labels } = setup()
    const a = await company()
    expect(await codeOf(labels.create(a, { name: 'a', color: '#FFFFFF' }))).toBe('validation')
    expect(await codeOf(labels.create(a, { name: 'Boa', color: '#FFF' }))).toBe('validation')
    const l = await labels.create(a, { name: 'Quente', color: '#ff8800' })
    expect(l.color).toBe('#FF8800')
    expect(await codeOf(labels.create(a, { name: 'quente', color: '#000000' }))).toBe('conflict')
    await contacts.create(a, { name: 'G', phone: '+5511933332222', labelIds: [l.id] })
    expect((await labels.list(a))[0]).toMatchObject({ id: l.id, contacts_count: 1 })
    expect(await codeOf(contacts.create(a, { name: 'H', phone: '+5511922221111', labelIds: [(await labels.create(await company(), { name: 'Alheia', color: '#000000' })).id] }))).toBe('validation')
    await labels.delete(a, l.id)
    expect(await db.select().from(contactLabels).where(eq(contactLabels.labelId, l.id))).toEqual([])
  })

  it('lista com busca, etiqueta e campo personalizado; isolamento por empresa', async () => {
    const { contacts, labels } = setup()
    const [a, b] = [await company(), await company()]
    const l = await labels.create(a, { name: 'Filtro', color: '#123456' })
    await contacts.create(a, { name: 'Joana Lima', phone: '+5511911110000', email: 'joana@x.com', labelIds: [l.id], customFields: { plano: 'ouro' } })
    await contacts.create(a, { name: 'Pedro', phone: '+5511911110001' })
    const other = await contacts.create(b, { name: 'Joana Outra', phone: '+5511911110002' })
    const page = { page: 1, limit: 20 }
    expect((await contacts.list(a, { ...page, search: 'joana' })).items.map((c) => c.name)).toEqual(['Joana Lima'])
    expect((await contacts.list(a, { ...page, search: '0001' })).items.map((c) => c.name)).toEqual(['Pedro'])
    expect((await contacts.list(a, { ...page, search: '11' })).page.total_count).toBe(2) // número curto é ignorado
    expect((await contacts.list(a, { ...page, labelIds: [l.id] })).items).toHaveLength(1)
    expect((await contacts.list(a, { ...page, customFieldKey: 'plano', customFieldValue: 'our' })).items).toHaveLength(1)
    const skip = await contacts.list(a, { page: 1, limit: 1, skipTotal: true })
    expect(skip.page).toMatchObject({ total_count: null, has_more: true })
    expect(await codeOf(contacts.get(a, other.id))).toBe('not_found')
    expect(await codeOf(contacts.delete(a, other.id))).toBe('not_found')
  })
})
