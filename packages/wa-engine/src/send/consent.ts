// Consentimento e opt-out sobre `public.contacts` (tabela do ai-manager), usados pelo gate `contactAllowed`.
// Regra (SPEC 1.4 nº 3): opt-out SEMPRE bloqueia; só um novo consentimento manual o reverte (T33-07).
// O CRM registra consentimento automaticamente na criação do contato (inbound/manual/import/webhook/sale).
import { eq, sql } from 'drizzle-orm'
import { contacts, E164_REGEX, type Database } from '../db'

export type ConsentContact = typeof contacts.$inferSelect

export const CONSENT_SOURCES = ['inbound', 'manual', 'import', 'webhook', 'sale'] as const
export type ConsentSource = (typeof CONSENT_SOURCES)[number]

export type CannotMessageReason = 'contact_not_found' | 'opt_out' | 'no_consent'
export type CanMessageResult = { ok: true } | { ok: false; reason: CannotMessageReason }

/** Campos mínimos de um contato para decidir se ele pode receber mensagens. */
export interface ConsentFields {
  consent: boolean
  optOut: boolean
}

/** Só contatos existentes, com consentimento e sem opt-out podem receber mensagens (ai-manager contacts/policy). */
export function canMessage(contact: ConsentFields | null | undefined): CanMessageResult {
  if (!contact) return { ok: false, reason: 'contact_not_found' }
  if (contact.optOut) return { ok: false, reason: 'opt_out' }
  if (!contact.consent) return { ok: false, reason: 'no_consent' }
  return { ok: true }
}

export class ConsentError extends Error {
  readonly code = 'VALIDATION_ERROR'
  constructor(message: string) {
    super(message)
    this.name = 'ConsentError'
  }
}

function assertPhone(phone: string): void {
  if (!E164_REGEX.test(phone)) throw new ConsentError('phone must be E.164 (e.g. +5511999999999)')
}

export interface RecordConsentOptions {
  name?: string | null
  /** Momento do consentimento (default: agora). */
  at?: Date
}

export class ConsentService {
  constructor(private readonly db: Database) {}

  async find(phone: string): Promise<ConsentContact | undefined> {
    const [row] = await this.db.select().from(contacts).where(eq(contacts.phone, phone)).limit(1)
    return row
  }

  async canMessage(phone: string): Promise<CanMessageResult> {
    return canMessage(await this.find(phone))
  }

  /**
   * Registra consentimento (cria o contato se não existir). Não reverte opt-out, exceto com `source: 'manual'`
   * (ação explícita de um usuário do CRM).
   */
  async recordConsent(phone: string, source: ConsentSource, opts: RecordConsentOptions = {}): Promise<ConsentContact> {
    assertPhone(phone)
    if (!(CONSENT_SOURCES as readonly string[]).includes(source)) throw new ConsentError(`invalid consent source: ${source}`)
    const at = opts.at ?? new Date()
    const set: Record<string, unknown> = { consent: true, consentAt: at, consentSource: source, updatedAt: sql`now()` }
    if (source === 'manual') set.optOut = false
    if (opts.name) set.name = sql`coalesce(${contacts.name}, ${opts.name})`
    const [row] = await this.db
      .insert(contacts)
      .values({ phone, name: opts.name ?? null, consent: true, consentAt: at, consentSource: source })
      .onConflictDoUpdate({ target: contacts.phone, set })
      .returning()
    return row!
  }

  /** Opt-out: bloqueia todo envio para o telefone. Contato desconhecido é criado já com opt-out. */
  async optOut(phone: string): Promise<ConsentContact> {
    assertPhone(phone)
    const [row] = await this.db
      .insert(contacts)
      .values({ phone, optOut: true, consent: false })
      .onConflictDoUpdate({ target: contacts.phone, set: { optOut: true, updatedAt: sql`now()` } })
      .returning()
    return row!
  }
}
