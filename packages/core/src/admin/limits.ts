// Limites de quantidade por empresa (SPEC 3.3, 10.1 nº 7): `companies.settings.limits.<chave>` (inteiro ≥ 0);
// ausente/`null` = ilimitado (o padrão). Lidos por conexões (T40), agentes (T39), convites, fluxos e webhooks (T95).
// `settings.inbox_limits` só é gravado/exposto pelo admin: nenhum módulo aplica ainda.
import { companies, type Database } from '@crm/db'
import { eq } from 'drizzle-orm'

export const COMPANY_LIMIT_KEYS = ['connections', 'ai_agents', 'members', 'flows', 'webhooks'] as const
export type CompanyLimitKey = (typeof COMPANY_LIMIT_KEYS)[number]
export type CompanyLimits = Record<CompanyLimitKey, number | null>

export const INBOX_LIMIT_KEYS = ['waiting', 'attending', 'resolved'] as const
export type InboxLimits = Record<(typeof INBOX_LIMIT_KEYS)[number], number>

type Exec = Pick<Database, 'select'>
type Settings = Record<string, unknown> | null | undefined

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

const objectAt = (settings: Settings, key: string): Record<string, unknown> => {
  const v = settings?.[key]
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Limites gravados; valor que não seja inteiro ≥ 0 conta como ilimitado. */
export function readCompanyLimits(settings: Settings): CompanyLimits {
  const raw = objectAt(settings, 'limits')
  return Object.fromEntries(COMPANY_LIMIT_KEYS.map((k) => [k, isCount(raw[k]) ? raw[k] : null])) as CompanyLimits
}

export function readInboxLimits(settings: Settings): InboxLimits | null {
  const raw = objectAt(settings, 'inbox_limits')
  return INBOX_LIMIT_KEYS.every((k) => isCount(raw[k]))
    ? (Object.fromEntries(INBOX_LIMIT_KEYS.map((k) => [k, raw[k]])) as InboxLimits)
    : null
}

/**
 * Novo `settings` com os limites mesclados (`null` remove a chave = ilimitado) e, se informado, `inbox_limits`
 * (`null` remove). Preserva as demais chaves (`description`, `connection_status_emails_enabled`…).
 */
export function mergeCompanyLimits(
  settings: Settings,
  patch: { limits?: Partial<CompanyLimits>; inboxLimits?: InboxLimits | null },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(settings ?? {}) }
  if (patch.limits) {
    const limits = { ...objectAt(settings, 'limits') }
    for (const [k, v] of Object.entries(patch.limits)) {
      if (v === undefined) continue
      if (v === null) delete limits[k]
      else limits[k] = v
    }
    if (Object.keys(limits).length) next.limits = limits
    else delete next.limits
  }
  if (patch.inboxLimits !== undefined) {
    if (patch.inboxLimits === null) delete next.inbox_limits
    else next.inbox_limits = { ...patch.inboxLimits }
  }
  return next
}

/** Limite da empresa para a chave; `null` = ilimitado (ou empresa inexistente). */
export async function companyLimit(db: Exec, companyId: string, key: CompanyLimitKey): Promise<number | null> {
  const [row] = await db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
  return readCompanyLimits(row?.settings)[key]
}
