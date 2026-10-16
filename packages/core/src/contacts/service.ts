// Contatos por empresa (SPEC T26; feature 05). Identidade WhatsApp por `phone_e164` e/ou `wa_lid` (SPEC 3.8),
// nunca pelo JID cru. Todo contato criado recebe consentimento com a origem, repassado ao WaGateway (SPEC 1.4 nº 3);
// opt-out sempre bloqueia o envio e só é revertido manualmente.
import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm'
import { contactLabels, contacts, labels, type ContactConsentSource, type ContactOrigin, type Database } from '@crm/db'
import { buildPageMeta, type PageMeta } from '@crm/shared'
import type { WaGateway } from '@crm/wa-port'
import { CustomFieldsService, normalizeFieldKey } from '../custom-fields/service'
import { LabelsService } from '../labels/service'
import { ContactsError, invalid, notFound, uniqueViolation } from './errors'
import { emptyToNull, normalizeContactEmail, normalizeContactLid, normalizeContactPhone, normalizeContactState, normalizeContactZip } from './normalize'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type Executor = Database | Tx
type Row = typeof contacts.$inferSelect

export interface ContactLabelDto {
  id: string
  name: string
  color: string
}

export interface ContactDto {
  id: string
  name: string
  phone_e164: string | null
  wa_lid: string | null
  email: string | null
  state: string | null
  city: string | null
  zip: string | null
  custom_fields: Record<string, unknown>
  labels: ContactLabelDto[]
  consent: boolean
  consent_source: ContactConsentSource | null
  opt_out: boolean
  origin: ContactOrigin
  ctwa_clid: string | null
  source_id: string | null
  source_url: string | null
  ad_media_url: string | null
  created_at: string
  updated_at: string
}

/** Entrada do contato (já em camelCase); `undefined` = não mexe, `null` = limpa. */
export interface ContactInput {
  name?: string | null
  phone?: string | null
  waLid?: string | null
  email?: string | null
  state?: string | null
  city?: string | null
  zip?: string | null
  customFields?: Record<string, unknown> | null
  labelIds?: string[] | null
  optOut?: boolean
  ctwaClid?: string | null
  sourceId?: string | null
  sourceUrl?: string | null
  adMediaUrl?: string | null
}

export interface ListContactsQuery {
  page: number
  limit: number
  skipTotal?: boolean
  search?: string
  labelIds?: string[]
  customFieldKey?: string
  customFieldValue?: string
  createdAtFrom?: Date
  createdAtTo?: Date
}

export interface WhatsAppContactInput {
  phone?: string | null
  lid?: string | null
  name?: string | null
  pushName?: string | null
  ad?: { ctwaClid?: string | null; sourceId?: string | null; sourceUrl?: string | null; mediaUrl?: string | null } | null
}

/** Chamado dentro da transação do merge, para módulos que referenciam contatos (chats, cards…) reapontarem. */
export type ContactMergeHook = (tx: Tx, e: { companyId: string; fromId: string; intoId: string }) => Promise<void>

export interface ContactsServiceOptions {
  db: Database
  /** Fronteira WhatsApp: consentimento e opt-out. Ausente: as chamadas são puladas. */
  waGateway?: Pick<WaGateway, 'recordConsent' | 'optOut'>
  mergeHooks?: ContactMergeHook[]
}

/** Ator das chamadas ao gateway (auditoria do lado do engine). */
export interface Actor {
  userId?: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UNIQUE_FIELD: Record<string, 'phone_e164' | 'wa_lid'> = { contacts_company_phone_uq: 'phone_e164', contacts_company_lid_uq: 'wa_lid' }

const iso = (d: Date) => d.toISOString()

function toDto(r: Row, rowLabels: ContactLabelDto[]): ContactDto {
  return {
    id: r.id,
    name: r.name,
    phone_e164: r.phoneE164,
    wa_lid: r.waLid,
    email: r.email,
    state: r.state,
    city: r.city,
    zip: r.zip,
    custom_fields: r.customFields,
    labels: rowLabels,
    consent: r.consent,
    consent_source: r.consentSource ?? null,
    opt_out: r.optOut,
    origin: r.origin,
    ctwa_clid: r.ctwaClid,
    source_id: r.sourceId,
    source_url: r.sourceUrl,
    ad_media_url: r.adMediaUrl,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  }
}

/** Campos personalizados: chaves normalizadas; valor null/'' remove a chave; linhas sem nome são descartadas. */
function normalizeCustomFields(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [rawKey, value] of Object.entries(raw)) {
    if (!rawKey.trim()) continue
    const key = normalizeFieldKey(rawKey, `custom_fields.${rawKey}`)
    if (value === null || value === undefined || value === '') continue
    out[key] = typeof value === 'string' ? value.trim() : value
  }
  return out
}

type ContactValues = Partial<typeof contacts.$inferInsert>

/** Converte a entrada em colunas (só o que veio). */
function toValues(input: ContactInput): ContactValues {
  const v: ContactValues = {}
  if (input.name !== undefined) v.name = input.name?.trim() ?? ''
  if (input.phone !== undefined) v.phoneE164 = emptyToNull(input.phone) ? normalizeContactPhone(input.phone!) : null
  if (input.waLid !== undefined) v.waLid = emptyToNull(input.waLid) ? normalizeContactLid(input.waLid!) : null
  if (input.email !== undefined) v.email = emptyToNull(input.email) ? normalizeContactEmail(input.email!) : null
  if (input.state !== undefined) v.state = emptyToNull(input.state) ? normalizeContactState(input.state!) : null
  if (input.city !== undefined) v.city = emptyToNull(input.city)
  if (input.zip !== undefined) v.zip = emptyToNull(input.zip) ? normalizeContactZip(input.zip!) : null
  if (input.customFields !== undefined) v.customFields = normalizeCustomFields(input.customFields ?? {})
  if (input.optOut !== undefined) v.optOut = input.optOut
  if (input.ctwaClid !== undefined) v.ctwaClid = emptyToNull(input.ctwaClid)
  if (input.sourceId !== undefined) v.sourceId = emptyToNull(input.sourceId)
  if (input.sourceUrl !== undefined) v.sourceUrl = emptyToNull(input.sourceUrl)
  if (input.adMediaUrl !== undefined) v.adMediaUrl = emptyToNull(input.adMediaUrl)
  return v
}

/** Termos só numéricos com menos de 4 dígitos são ignorados na busca (05 §3.3). */
function searchCondition(raw: string): SQL | undefined {
  const term = raw.trim()
  if (!term) return undefined
  const digits = term.replace(/\D/g, '')
  const numeric = /^[\d\s()+\-.]+$/.test(term)
  if (numeric && digits.length < 4) return undefined
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const parts: SQL[] = [ilike(contacts.name, like), ilike(contacts.email, like)]
  if (digits.length >= 4) parts.push(sql`${contacts.phoneE164} like ${`%${digits}%`}`)
  return or(...parts)
}

export class ContactsService {
  private readonly db: Database
  private readonly fields: CustomFieldsService
  private readonly labelsSvc: LabelsService

  constructor(private readonly opts: ContactsServiceOptions) {
    this.db = opts.db
    this.fields = new CustomFieldsService(opts.db)
    this.labelsSvc = new LabelsService(opts.db)
  }

  // ---- leitura --------------------------------------------------------------------

  async get(companyId: string, id: string): Promise<ContactDto> {
    const row = await this.findRow(this.db, companyId, id)
    if (!row) throw notFound('Contato')
    return (await this.hydrate(this.db, [row]))[0]!
  }

  async list(companyId: string, q: ListContactsQuery): Promise<{ items: ContactDto[]; page: PageMeta }> {
    const conds: SQL[] = [eq(contacts.companyId, companyId)]
    const search = q.search ? searchCondition(q.search) : undefined
    if (search) conds.push(search)
    if (q.labelIds?.length) {
      conds.push(
        sql`exists (select 1 from ${contactLabels} where ${contactLabels.contactId} = ${contacts.id} and ${inArray(contactLabels.labelId, q.labelIds)})`,
      )
    }
    if (q.customFieldKey) {
      const key = q.customFieldKey.trim().toLowerCase()
      if (q.customFieldValue) conds.push(sql`${contacts.customFields} ->> ${key} ilike ${`%${q.customFieldValue}%`}`)
      else conds.push(sql`${contacts.customFields} ? ${key}`)
    }
    if (q.createdAtFrom) conds.push(gte(contacts.createdAt, q.createdAtFrom))
    if (q.createdAtTo) conds.push(lt(contacts.createdAt, q.createdAtTo))
    const where = and(...conds)

    const rows = await this.db
      .select()
      .from(contacts)
      .where(where)
      .orderBy(desc(contacts.createdAt), asc(contacts.id))
      .limit(q.skipTotal ? q.limit + 1 : q.limit)
      .offset((q.page - 1) * q.limit)
    const page = q.skipTotal
      ? buildPageMeta(q, { fetchedCount: rows.length })
      : buildPageMeta(q, { total: (await this.db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(where))[0]!.n })
    return { items: await this.hydrate(this.db, rows.slice(0, q.limit)), page }
  }

  /** Possíveis duplicados (05 §5 item 10): mesmo telefone, e-mail ou nome. */
  async findDuplicates(companyId: string, q: { name?: string; phone?: string; email?: string }): Promise<ContactDto[]> {
    const parts: SQL[] = []
    if (q.phone?.trim()) {
      try {
        parts.push(eq(contacts.phoneE164, normalizeContactPhone(q.phone)))
      } catch {
        // telefone incompleto na digitação: só não entra no critério
      }
    }
    if (q.email?.trim()) parts.push(sql`lower(${contacts.email}) = ${q.email.trim().toLowerCase()}`)
    if (q.name?.trim()) parts.push(sql`lower(${contacts.name}) = ${q.name.trim().toLowerCase()}`)
    if (!parts.length) return []
    const rows = await this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.companyId, companyId), or(...parts)))
      .orderBy(asc(contacts.createdAt))
      .limit(20)
    return this.hydrate(this.db, rows)
  }

  // ---- escrita --------------------------------------------------------------------

  /** Cadastro manual/API: consentimento automático `manual` (ou opt-out, se pedido). Exige telefone ou LID. */
  async create(companyId: string, input: ContactInput, actor: Actor = {}, origin: ContactOrigin = 'manual'): Promise<ContactDto> {
    const values = toValues(input)
    if (!values.phoneE164 && !values.waLid) throw invalid('phone', 'Informe o telefone ou o LID do WhatsApp')
    const optOut = values.optOut === true
    const row = await this.write(companyId, values, async (tx) => {
      if (input.labelIds?.length) await this.labelsSvc.assertOwned(tx, companyId, input.labelIds)
      const [created] = await tx
        .insert(contacts)
        .values({ ...values, companyId, origin, consent: !optOut, consentSource: 'manual', optOut })
        .returning()
      await this.afterWrite(tx, companyId, created!, input)
      return created!
    })
    await this.syncConsent(row, { optOutChanged: optOut, consentChanged: !optOut, actor })
    return this.get(companyId, row.id)
  }

  /** Atualização parcial. `custom_fields` e `label_ids`, quando enviados, substituem os atuais. */
  async update(companyId: string, id: string, input: ContactInput, actor: Actor = {}): Promise<ContactDto> {
    const values = toValues(input)
    let before: Row | undefined
    const row = await this.write(companyId, values, async (tx) => {
      before = await this.findRow(tx, companyId, id, true)
      if (!before) throw notFound('Contato')
      const phone = values.phoneE164 !== undefined ? values.phoneE164 : before.phoneE164
      const lid = values.waLid !== undefined ? values.waLid : before.waLid
      if (!phone && !lid) throw invalid('phone', 'O contato precisa de telefone ou LID do WhatsApp')
      if (input.labelIds?.length) await this.labelsSvc.assertOwned(tx, companyId, input.labelIds)
      // Reverter o opt-out é sempre manual: volta o consentimento `manual`.
      if (values.optOut === false && before.optOut) Object.assign(values, { consent: true, consentSource: 'manual' })
      const [updated] = await tx
        .update(contacts)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(contacts.companyId, companyId), eq(contacts.id, id)))
        .returning()
      await this.afterWrite(tx, companyId, updated!, input)
      return updated!
    })
    const optOutChanged = values.optOut !== undefined && values.optOut !== before!.optOut
    const phoneChanged = !!row.phoneE164 && row.phoneE164 !== before!.phoneE164
    await this.syncConsent(row, { optOutChanged, consentChanged: (optOutChanged && !row.optOut) || (phoneChanged && !row.optOut), actor })
    return this.get(companyId, id)
  }

  async delete(companyId: string, id: string): Promise<void> {
    if (!UUID_RE.test(id)) throw notFound('Contato')
    const deleted = await this.db
      .delete(contacts)
      .where(and(eq(contacts.companyId, companyId), eq(contacts.id, id)))
      .returning({ id: contacts.id })
    if (!deleted.length) throw notFound('Contato')
  }

  /**
   * Funde a identidade LID no contato do telefone (evento `contact.lid_mapping`). Com dois contatos, sobrevive o
   * mais antigo (id preservado), que fica com os dois identificadores; etiquetas e campos dos dois são unidos
   * (em conflito vale o do sobrevivente) e o opt-out de qualquer um prevalece. Sem contato algum → `null`.
   */
  async mergeIdentity(companyId: string, rawLid: string, rawPn: string): Promise<ContactDto | null> {
    const lid = normalizeContactLid(rawLid, 'lid')
    const pn = normalizeContactPhone(rawPn, 'pn')
    const id = await this.db.transaction(async (tx) => {
      const [byLid] = await tx.select().from(contacts).where(and(eq(contacts.companyId, companyId), eq(contacts.waLid, lid))).for('update')
      const [byPn] = await tx.select().from(contacts).where(and(eq(contacts.companyId, companyId), eq(contacts.phoneE164, pn))).for('update')
      if (!byLid && !byPn) return null
      if (byLid && byPn && byLid.id !== byPn.id) return this.mergeRows(tx, companyId, byLid, byPn, lid, pn)
      const target = (byLid ?? byPn)!
      if (target.waLid === lid && target.phoneE164 === pn) return target.id
      await tx
        .update(contacts)
        .set({ waLid: lid, phoneE164: pn, updatedAt: new Date() })
        .where(eq(contacts.id, target.id))
      return target.id
    })
    return id ? this.get(companyId, id) : null
  }

  /**
   * Contato visto pelo WhatsApp (ingest de `message.inbound`/`contact.upsert`). Cria com origem `whatsapp` e
   * consentimento `inbound`; existente só ganha o que falta (identificador, nome, atribuição). Nunca mexe no opt-out.
   */
  async upsertFromWhatsApp(companyId: string, input: WhatsAppContactInput): Promise<{ contact: ContactDto; created: boolean }> {
    const phone = emptyToNull(input.phone) ? normalizeContactPhone(input.phone!, 'phone') : null
    const lid = emptyToNull(input.lid) ? normalizeContactLid(input.lid!, 'lid') : null
    if (!phone && !lid) throw invalid('phone', 'Contato do WhatsApp sem telefone nem LID')
    if (phone && lid) {
      const merged = await this.mergeIdentity(companyId, lid, phone)
      if (merged) return { contact: await this.fillFromWhatsApp(companyId, merged.id, input), created: false }
    }
    const existing = await this.findByIdentity(this.db, companyId, phone, lid)
    if (existing) return { contact: await this.fillFromWhatsApp(companyId, existing.id, input), created: false }

    const name = input.name?.trim() || input.pushName?.trim() || ''
    try {
      const [row] = await this.db
        .insert(contacts)
        .values({
          companyId,
          name,
          phoneE164: phone,
          waLid: lid,
          origin: 'whatsapp',
          consent: true,
          consentSource: 'inbound',
          ctwaClid: emptyToNull(input.ad?.ctwaClid),
          sourceId: emptyToNull(input.ad?.sourceId),
          sourceUrl: emptyToNull(input.ad?.sourceUrl),
          adMediaUrl: emptyToNull(input.ad?.mediaUrl),
        })
        .returning()
      if (row!.phoneE164) await this.opts.waGateway?.recordConsent({ phone: row!.phoneE164, source: 'inbound', name: row!.name || null })
      return { contact: await this.get(companyId, row!.id), created: true }
    } catch (err) {
      // Corrida com outro ingest: o contato já existe.
      if (!uniqueViolation(err)) throw err
      const again = await this.findByIdentity(this.db, companyId, phone, lid)
      if (!again) throw err
      return { contact: await this.fillFromWhatsApp(companyId, again.id, input), created: false }
    }
  }

  // ---- internos -------------------------------------------------------------------

  private async findRow(db: Executor, companyId: string, id: string, lock = false): Promise<Row | undefined> {
    if (!UUID_RE.test(id)) return undefined
    const q = db.select().from(contacts).where(and(eq(contacts.companyId, companyId), eq(contacts.id, id)))
    const [row] = lock ? await q.for('update') : await q
    return row
  }

  private async findByIdentity(db: Executor, companyId: string, phone: string | null, lid: string | null): Promise<Row | undefined> {
    const parts: SQL[] = []
    if (phone) parts.push(eq(contacts.phoneE164, phone))
    if (lid) parts.push(eq(contacts.waLid, lid))
    const [row] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.companyId, companyId), or(...parts)))
      .orderBy(asc(contacts.createdAt))
      .limit(1)
    return row
  }

  /**
   * Executa a escrita traduzindo violação de unicidade de telefone/LID em 409 com o id do contato existente
   * (procurado pelo valor que se tentou gravar).
   */
  private async write(companyId: string, values: ContactValues, fn: (tx: Tx) => Promise<Row>): Promise<Row> {
    try {
      return await this.db.transaction(fn)
    } catch (err) {
      const unique = uniqueViolation(err)
      const field = unique?.constraint ? UNIQUE_FIELD[unique.constraint] : undefined
      if (!field) throw err
      const value = field === 'phone_e164' ? values.phoneE164 : values.waLid
      const col = field === 'phone_e164' ? contacts.phoneE164 : contacts.waLid
      const [row] = value ? await this.db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.companyId, companyId), eq(col, value))) : []
      const message = field === 'phone_e164' ? 'Já existe um contato com esse telefone' : 'Já existe um contato com esse LID'
      throw new ContactsError('conflict', message, { id: row?.id ?? null, field })
    }
  }

  private async afterWrite(tx: Tx, companyId: string, row: Row, input: ContactInput): Promise<void> {
    if (input.customFields !== undefined) await this.fields.register(tx, companyId, row.customFields)
    if (input.labelIds !== undefined) {
      await tx.delete(contactLabels).where(eq(contactLabels.contactId, row.id))
      const ids = [...new Set(input.labelIds ?? [])]
      if (ids.length) await tx.insert(contactLabels).values(ids.map((labelId) => ({ companyId, contactId: row.id, labelId })))
    }
  }

  /** Repassa ao WaGateway o que mudou: opt-out → `optOut`; consentimento manual → `recordConsent`. */
  private async syncConsent(row: Row, change: { optOutChanged: boolean; consentChanged: boolean; actor: Actor }): Promise<void> {
    const gw = this.opts.waGateway
    if (!gw || !row.phoneE164) return
    const actor = change.actor.userId ?? undefined
    if (row.optOut) {
      if (change.optOutChanged) await gw.optOut({ phone: row.phoneE164, ...(actor ? { actor } : {}) })
      return
    }
    if (change.consentChanged) await gw.recordConsent({ phone: row.phoneE164, source: 'manual', name: row.name || null, ...(actor ? { actor } : {}) })
  }

  private async fillFromWhatsApp(companyId: string, id: string, input: WhatsAppContactInput): Promise<ContactDto> {
    const row = await this.findRow(this.db, companyId, id)
    if (!row) throw notFound('Contato')
    const set: ContactValues = {}
    const name = input.name?.trim() || input.pushName?.trim()
    if (!row.name && name) set.name = name
    if (!row.ctwaClid && input.ad?.ctwaClid) set.ctwaClid = input.ad.ctwaClid
    if (!row.sourceId && input.ad?.sourceId) set.sourceId = input.ad.sourceId
    if (!row.sourceUrl && input.ad?.sourceUrl) set.sourceUrl = input.ad.sourceUrl
    if (!row.adMediaUrl && input.ad?.mediaUrl) set.adMediaUrl = input.ad.mediaUrl
    if (Object.keys(set).length) await this.db.update(contacts).set({ ...set, updatedAt: new Date() }).where(eq(contacts.id, id))
    return this.get(companyId, id)
  }

  private async mergeRows(tx: Tx, companyId: string, a: Row, b: Row, lid: string, pn: string): Promise<string> {
    const [into, from] = a.createdAt <= b.createdAt ? [a, b] : [b, a]
    const fill = <K extends keyof Row>(k: K) => (into[k] ?? from[k]) as Row[K]
    // Etiquetas: une as do contato absorvido no sobrevivente.
    await tx.execute(sql`
      insert into ${contactLabels} (company_id, contact_id, label_id)
      select company_id, ${into.id}, label_id from ${contactLabels} where contact_id = ${from.id}
      on conflict do nothing`)
    for (const hook of this.opts.mergeHooks ?? []) await hook(tx, { companyId, fromId: from.id, intoId: into.id })
    // Apaga antes de gravar os identificadores no sobrevivente (unicidade parcial por empresa).
    await tx.delete(contacts).where(eq(contacts.id, from.id))
    await tx
      .update(contacts)
      .set({
        waLid: lid,
        phoneE164: pn,
        name: into.name || from.name,
        email: fill('email'),
        state: fill('state'),
        city: fill('city'),
        zip: fill('zip'),
        customFields: { ...from.customFields, ...into.customFields },
        consent: into.consent || from.consent,
        consentSource: fill('consentSource'),
        optOut: into.optOut || from.optOut,
        ctwaClid: fill('ctwaClid'),
        sourceId: fill('sourceId'),
        sourceUrl: fill('sourceUrl'),
        adMediaUrl: fill('adMediaUrl'),
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, into.id))
    return into.id
  }

  /** Carrega as etiquetas dos contatos (uma consulta). */
  private async hydrate(db: Executor, rows: Row[]): Promise<ContactDto[]> {
    if (!rows.length) return []
    const links = await db
      .select({ contactId: contactLabels.contactId, id: labels.id, name: labels.name, color: labels.color })
      .from(contactLabels)
      .innerJoin(labels, eq(labels.id, contactLabels.labelId))
      .where(inArray(contactLabels.contactId, rows.map((r) => r.id)))
      .orderBy(asc(labels.name))
    const byContact = new Map<string, ContactLabelDto[]>()
    for (const l of links) byContact.set(l.contactId, [...(byContact.get(l.contactId) ?? []), { id: l.id, name: l.name, color: l.color }])
    return rows.map((r) => toDto(r, byContact.get(r.id) ?? []))
  }
}
