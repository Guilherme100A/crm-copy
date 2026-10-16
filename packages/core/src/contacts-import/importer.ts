// Upsert de contatos importados (T67), CSV e WhatsApp. Chave: `phone_e164` ou `wa_lid` (normalização da T26).
// Consentimento automático de importação (SPEC 1.4 nº 3): contato novo nasce com `consent_source = 'import'`,
// repassado ao `WaGateway.recordConsent`; opt-out do CSV entra como opt-out (e `WaGateway.optOut`) e um opt-out
// existente nunca é revertido pela importação.
import { and, eq, or, sql, type SQL } from 'drizzle-orm'
import { contactLabels, contacts, labels, type Database } from '@crm/db'
import type { WaContactSummary, WaGateway } from '@crm/wa-port'
import { ContactsService } from '../contacts/service'
import { ContactsError } from '../contacts/errors'
import { emptyToNull, normalizeContactEmail, normalizeContactLid, normalizeContactPhone, normalizeContactState, normalizeContactZip } from '../contacts/normalize'
import { LABEL_NAME_MAX, LABEL_NAME_MIN } from '../labels/service'
import { parseOptOut, splitLabels, type CsvRecord } from './csv'
import type { ImportReport } from './report'

type Row = typeof contacts.$inferSelect
type Gateway = Pick<WaGateway, 'recordConsent' | 'optOut'>

/** Cor das etiquetas criadas pela importação. */
export const IMPORTED_LABEL_COLOR = '#3B82F6'

export interface ImporterOptions {
  db: Database
  companyId: string
  /** `crm:<userId>` nas chamadas ao gateway. */
  actor?: string | null
  waGateway?: Gateway
}

export interface ImportRowOptions {
  createMissingLabels: boolean
  /** Etiquetas aplicadas a linhas sem etiqueta (ids da empresa). */
  defaultLabelIds: string[]
}

export class ContactImporter {
  private readonly db: Database
  private readonly labelIds = new Map<string, string | null>()

  constructor(private readonly opts: ImporterOptions) {
    this.db = opts.db
  }

  /** Uma linha do CSV. Telefone inválido/ausente → erro da linha; demais campos inválidos → aviso e campo ignorado. */
  async csvRow(line: number, rec: CsvRecord, o: ImportRowOptions, report: ImportReport): Promise<void> {
    const ident = identity(rec.phone)
    if (!ident) {
      report.error(line, 'telefone inválido')
      return
    }
    const fields: Partial<typeof contacts.$inferInsert> = {}
    const name = emptyToNull(rec.name)
    if (name) fields.name = name
    optional(rec.email, normalizeContactEmail, 'e-mail inválido', report, (v) => (fields.email = v))
    optional(rec.state, normalizeContactState, 'estado inválido', report, (v) => (fields.state = v))
    optional(rec.zip, normalizeContactZip, 'CEP inválido', report, (v) => (fields.zip = v))
    const city = emptyToNull(rec.city)
    if (city) fields.city = city
    let optOut = false
    if (rec.opt_out !== undefined) {
      const parsed = parseOptOut(rec.opt_out)
      if (parsed === null) report.warn(`opt-out inválido: ${rec.opt_out}`)
      else optOut = parsed
    }
    const names = splitLabels(rec.labels)
    const labelIds = names.length ? await this.resolveLabels(names, o.createMissingLabels, report) : o.defaultLabelIds

    const { row, created, becameOptOut } = await this.upsert(ident, fields, optOut, labelIds)
    if (created) report.created++
    else report.updated++
    await this.syncGateway(row, { optOutNow: becameOptOut, consent: !row.optOut })
  }

  /** Contato do WhatsApp (`listContacts`): cria com consentimento de importação ou completa o existente. */
  async whatsappContact(c: WaContactSummary, contactsSvc: ContactsService, report: ImportReport): Promise<void> {
    let phone: string | null
    let lid: string | null
    try {
      phone = c.phone ? normalizeContactPhone(c.phone) : null
    } catch {
      phone = null
    }
    try {
      lid = c.lid ? normalizeContactLid(c.lid) : /@lid$/.test(c.jid) ? normalizeContactLid(c.jid) : null
    } catch {
      lid = null
    }
    if (!phone && !lid) {
      report.skipped++
      return
    }
    // Com os dois identificadores, junta os contatos que já existam (merge da T26) antes do upsert.
    if (phone && lid) await contactsSvc.mergeIdentity(this.opts.companyId, lid, phone)
    const name = c.name?.trim() || c.pushName?.trim() || null
    const { row, created } = await this.upsert({ phone, lid }, name ? { name } : {}, false, [], { fillOnly: true })
    if (created) report.created++
    else report.updated++
    await this.syncGateway(row, { optOutNow: false, consent: !row.optOut })
  }

  /** Etiquetas por nome (sem diferença de maiúsculas); faltando, cria (opção ligada) ou avisa. */
  private async resolveLabels(names: string[], create: boolean, report: ImportReport): Promise<string[]> {
    const ids: string[] = []
    for (const raw of names) {
      const key = raw.toLowerCase()
      if (!this.labelIds.has(key)) this.labelIds.set(key, await this.findOrCreateLabel(raw, create, report))
      const id = this.labelIds.get(key)
      if (id) ids.push(id)
    }
    return ids
  }

  private async findOrCreateLabel(name: string, create: boolean, report: ImportReport): Promise<string | null> {
    const find = async () =>
      (await this.db.select({ id: labels.id }).from(labels).where(and(eq(labels.companyId, this.opts.companyId), sql`lower(${labels.name}) = ${name.toLowerCase()}`)))[0]?.id ?? null
    const existing = await find()
    if (existing) return existing
    if (!create) {
      report.warn(`etiqueta não encontrada: ${name}`)
      return null
    }
    if (name.length < LABEL_NAME_MIN || name.length > LABEL_NAME_MAX) {
      report.warn(`etiqueta inválida: ${name}`)
      return null
    }
    const [row] = await this.db
      .insert(labels)
      .values({ companyId: this.opts.companyId, name, color: IMPORTED_LABEL_COLOR })
      .onConflictDoNothing()
      .returning({ id: labels.id })
    if (row) {
      report.labelsCreated.push(name)
      return row.id
    }
    return find()
  }

  private async upsert(
    ident: { phone: string | null; lid: string | null },
    fields: Partial<typeof contacts.$inferInsert>,
    optOut: boolean,
    labelIds: string[],
    mode: { fillOnly?: boolean } = {},
  ): Promise<{ row: Row; created: boolean; becameOptOut: boolean; gainedConsent: boolean }> {
    const { companyId } = this.opts
    const attempt = () =>
      this.db.transaction(async (tx) => {
        const parts: SQL[] = []
        if (ident.phone) parts.push(eq(contacts.phoneE164, ident.phone))
        if (ident.lid) parts.push(eq(contacts.waLid, ident.lid))
        const [existing] = await tx
          .select()
          .from(contacts)
          .where(and(eq(contacts.companyId, companyId), or(...parts)))
          .orderBy(contacts.createdAt)
          .limit(1)
          .for('update')
        let row: Row
        let created = false
        let becameOptOut = false
        let gainedConsent = false
        if (!existing) {
          ;[row] = (await tx
            .insert(contacts)
            .values({
              companyId,
              name: fields.name ?? '',
              ...fields,
              phoneE164: ident.phone,
              waLid: ident.lid,
              origin: 'import',
              consent: !optOut,
              consentSource: 'import',
              optOut,
            })
            .returning()) as [Row]
          created = true
          becameOptOut = optOut
        } else {
          const set: Partial<typeof contacts.$inferInsert> = {}
          for (const [k, v] of Object.entries(fields) as [keyof typeof fields, unknown][]) {
            if (v === undefined || v === null) continue
            if (mode.fillOnly && existing[k as keyof Row]) continue
            ;(set as Record<string, unknown>)[k] = v
          }
          if (ident.phone && !existing.phoneE164) set.phoneE164 = ident.phone
          if (ident.lid && !existing.waLid) set.waLid = ident.lid
          if (optOut && !existing.optOut) {
            set.optOut = true
            becameOptOut = true
          }
          if (!existing.optOut && !optOut && !existing.consent) {
            Object.assign(set, { consent: true, consentSource: 'import' })
            gainedConsent = true
          }
          row = Object.keys(set).length
            ? ((await tx.update(contacts).set({ ...set, updatedAt: new Date() }).where(eq(contacts.id, existing.id)).returning())[0] as Row)
            : existing
        }
        const ids = [...new Set(labelIds)]
        if (ids.length) await tx.insert(contactLabels).values(ids.map((labelId) => ({ companyId, contactId: row.id, labelId }))).onConflictDoNothing()
        return { row, created, becameOptOut, gainedConsent }
      })
    try {
      return await attempt()
    } catch (err) {
      // Corrida com outro escritor criando o mesmo telefone/LID: a 2ª tentativa encontra o contato.
      if ((err as { code?: string; cause?: { code?: string } }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505') return attempt()
      throw err
    }
  }

  /** Opt-out novo → `optOut`; senão, sem opt-out → `recordConsent('import')` (idempotente no engine). */
  private async syncGateway(row: Row, change: { optOutNow: boolean; consent: boolean }): Promise<void> {
    const gw = this.opts.waGateway
    if (!gw || !row.phoneE164) return
    const actor = this.opts.actor ? { actor: this.opts.actor } : {}
    if (row.optOut) {
      if (change.optOutNow) await gw.optOut({ phone: row.phoneE164, reason: 'import', ...actor })
      return
    }
    if (change.consent) await gw.recordConsent({ phone: row.phoneE164, source: 'import', name: row.name || null, ...actor })
  }
}

/** Telefone da célula → E.164, ou `<n>@lid` → LID; inválido → `null`. */
export function identity(raw: string | undefined): { phone: string | null; lid: string | null } | null {
  const v = raw?.trim()
  if (!v) return null
  try {
    if (/@lid$/i.test(v)) return { phone: null, lid: normalizeContactLid(v.toLowerCase()) }
    return { phone: normalizeContactPhone(v), lid: null }
  } catch (err) {
    if (err instanceof ContactsError) return null
    throw err
  }
}

function optional(raw: string | undefined, normalize: (v: string) => string, message: string, report: ImportReport, set: (v: string) => void) {
  const v = emptyToNull(raw)
  if (!v) return
  try {
    set(normalize(v))
  } catch (err) {
    if (!(err instanceof ContactsError)) throw err
    report.warn(message)
  }
}
