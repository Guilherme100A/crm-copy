// Chamadas das telas de autenticação (T36; spec 01 §3.3, §5). As rotas públicas usam `publicRequest`, e não o
// cliente do shell: um 401 aqui é "credencial errada", não "sessão expirada" (o cliente do shell sondaria o perfil e
// navegaria de novo para o login, perdendo o e-mail digitado e o `?redirect=`).
import { apiUrl } from '@/lib/base'
import { CSRF_HEADER, CSRF_VALUE, HttpError, type ApiErrorBody } from '@/lib/http'
import type { CompanySummary, Profile } from '@/lib/session'

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'

/** `fetch` same-origin com o header CSRF; erro HTTP vira `HttpError` (SPEC 3.5) sem efeitos colaterais. */
export async function publicRequest<T>(method: Method, path: string, body?: unknown, fetchFn: typeof fetch = (...a) => globalThis.fetch(...a)): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', [CSRF_HEADER]: CSRF_VALUE }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetchFn(apiUrl(path), { method, headers, credentials: 'same-origin', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  if (res.ok) {
    if (res.status === 204) return undefined as T
    return ((res.headers.get('content-type') ?? '').includes('application/json') ? await res.json() : undefined) as T
  }
  let err: ApiErrorBody | null = null
  try {
    err = (await res.json()) as ApiErrorBody
  } catch {
    // corpo não-JSON
  }
  const code = err?.error?.code ?? (res.status >= 500 ? 'INTERNAL' : 'HTTP_ERROR')
  throw new HttpError(res.status, code, err?.error?.message ?? code, err?.error?.details)
}

export interface RegisterInput {
  name: string
  email: string
  personal_whatsapp?: string | null
  password: string
  password_confirmation: string
  referral_code?: string
}

export type ResetTokenStatus = { valid: true } | { valid: false; reason?: 'invalid' | 'used' | 'expired' | (string & {}) }

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired'

export interface PublicInvitation {
  kind: 'member' | 'platform'
  email: string
  role: 'owner' | 'admin' | 'member'
  status: InvitationStatus
  expires_at: string
  company: { name: string; slug: string }
  invited_by: { name: string } | null
  /** O e-mail já tem conta (aceitar exige login) ou não (aceitar cria a conta). */
  user_exists: boolean
}

export interface AcceptResult {
  company: CompanySummary
  role: CompanySummary['role']
}

const enc = encodeURIComponent

export const authApi = {
  login: (email: string, password: string) => publicRequest<Profile>('POST', '/api/auth/login', { email, password }),
  /** SSO do painel do ai-manager: troca o token (JWT de uso único) pela sessão normal do CRM (cookie). */
  sso: (token: string) => publicRequest<Profile>('POST', '/api/auth/sso', { token }),
  register: (input: RegisterInput) => publicRequest<{ message?: string }>('POST', '/api/auth/register', input),
  requestReset: (email: string) => publicRequest<{ ok: true }>('POST', '/api/auth/password-resets', { email }),
  checkReset: (token: string) => publicRequest<ResetTokenStatus>('GET', `/api/auth/password-resets/${enc(token)}`),
  completeReset: (token: string, password: string, password_confirmation: string) =>
    publicRequest<{ ok: true }>('PATCH', `/api/auth/password-resets/${enc(token)}`, { password, password_confirmation }),
  invitation: (token: string) => publicRequest<{ invitation: PublicInvitation }>('GET', `/api/invitations/${enc(token)}`),
  /** Com sessão, aceita como o usuário logado; sem sessão, `signup` cria a conta e já entra. */
  acceptInvitation: (token: string, signup?: { name: string; password: string; password_confirmation: string }) =>
    publicRequest<AcceptResult>('POST', `/api/invitations/${enc(token)}/accept`, signup),
  declineInvitation: (token: string) => publicRequest<unknown>('POST', `/api/invitations/${enc(token)}/decline`),
}

/** Primeira mensagem de campo de um 422 (`details.fields`), se houver. */
export function fieldMessage(err: unknown, path?: string): string | null {
  if (!(err instanceof HttpError) || err.code !== 'VALIDATION_ERROR') return null
  const fields = (err.details as { fields?: { path: string; message: string }[] } | undefined)?.fields ?? []
  const f = path ? fields.find((x) => x.path === path) : fields[0]
  return f?.message ?? null
}
