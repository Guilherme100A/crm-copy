// Cookie de sessão `crm_session` (SPEC 3.4): httpOnly, SameSite=Lax, Secure em produção.
import type { Context } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { SESSION_COOKIE } from '@crm/core'

export interface SessionCookieOptions {
  secure: boolean
}

export function setSessionCookie(c: Context, token: string, expiresAt: Date, opts: SessionCookieOptions): void {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: opts.secure, path: '/', maxAge })
}

export function clearSessionCookie(c: Context, opts: SessionCookieOptions): void {
  deleteCookie(c, SESSION_COOKIE, { httpOnly: true, sameSite: 'Lax', secure: opts.secure, path: '/' })
}
