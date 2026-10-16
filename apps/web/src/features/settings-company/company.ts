// Regras puras da aba Empresa (16 §2.2, §3.1): sub-abas, fusos, formulário de Dados Corporativos.
import type { CompanyRole } from '@crm/shared'
import type { CompanyDto, CompanyInput } from './api'

export type CompanyTab = 'info' | 'departments' | 'hours'

export const COMPANY_TABS: readonly { id: CompanyTab; labelKey: string; permissions: readonly string[] }[] = [
  { id: 'info', labelKey: 'tabs.info', permissions: ['settings.accounts.view'] },
  { id: 'departments', labelKey: 'tabs.departments', permissions: ['settings.departments.view'] },
  { id: 'hours', labelKey: 'tabs.hours', permissions: ['settings.business_hours.view'] },
]

/** Sub-aba ativa: a pedida se permitida, senão a primeira permitida. */
export function resolveCompanyTab(requested: string | undefined, allowed: readonly CompanyTab[]): CompanyTab | null {
  return allowed.find((t) => t === requested) ?? allowed[0] ?? null
}

/** Os 12 fusos aceitos pelo servidor (`COMPANY_TIME_ZONES` em `@crm/core`, que a web não importa). */
export const COMPANY_TIME_ZONES = [
  'America/Sao_Paulo',
  'America/Fortaleza',
  'America/Manaus',
  'America/Belem',
  'America/Noronha',
  'America/Argentina/Buenos_Aires',
  'America/Santiago',
  'America/Bogota',
  'America/Lima',
  'America/Mexico_City',
  'America/New_York',
  'UTC',
] as const

/** Fuso editável só por owner/admin (ou admin da plataforma), como no serviço. */
export const canEditTimeZone = (role: CompanyRole | null, isPlatformAdmin: boolean) =>
  isPlatformAdmin || role === 'owner' || role === 'admin'

/** Mesmo formato do `companySlugSchema` do shared. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface CompanyForm {
  name: string
  description: string
  slug: string
  time_zone: string
  connection_status_emails_enabled: boolean
}

export const formFromCompany = (c: CompanyDto): CompanyForm => ({
  name: c.name,
  description: c.description ?? '',
  slug: c.slug,
  time_zone: c.time_zone,
  connection_status_emails_enabled: c.connection_status_emails_enabled,
})

export type CompanyFormErrors = Partial<Record<'name' | 'slug', 'required' | 'slug'>>

export function companyFormErrors(f: CompanyForm): CompanyFormErrors {
  const errors: CompanyFormErrors = {}
  if (!f.name.trim()) errors.name = 'required'
  const slug = f.slug.trim()
  if (slug && (slug.length < 2 || slug.length > 63 || !SLUG_RE.test(slug))) errors.slug = 'slug'
  return errors
}

/** Corpo do `PUT`: só o que mudou; o fuso só vai quando o papel pode alterá-lo. */
export function companyPayload(original: CompanyDto, f: CompanyForm, tzEditable: boolean): CompanyInput {
  const out: CompanyInput = {}
  const name = f.name.trim()
  if (name !== original.name) out.name = name
  const description = f.description.trim()
  if (description !== (original.description ?? '')) out.description = description || null
  const slug = f.slug.trim()
  if (slug && slug !== original.slug) out.slug = slug
  if (tzEditable && f.time_zone !== original.time_zone) out.time_zone = f.time_zone
  if (f.connection_status_emails_enabled !== original.connection_status_emails_enabled)
    out.connection_status_emails_enabled = f.connection_status_emails_enabled
  return out
}
