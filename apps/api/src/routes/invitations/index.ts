// Convites por token (públicos, T22): `GET /api/invitations/:token`, `POST /api/invitations/:token/accept|decline`.
// Rotas públicas não passam pelo `sessionAuth`: o aceite confere o cookie de sessão aqui. Sem sessão, o corpo
// `{ name, password, password_confirmation }` cria a conta (se o e-mail ainda não existe) e devolve o cookie.
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import { SESSION_COOKIE } from '@crm/core'
import { passwordSchema } from '@crm/shared'
import { clientIp } from '../../lib/context'
import { setSessionCookie } from '../../lib/cookies'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { run, teamServices } from '../team/support'

const signupSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    password: passwordSchema,
    password_confirmation: z.string(),
  })
  .refine((d) => d.password === d.password_confirmation, { message: 'As senhas não coincidem', path: ['password_confirmation'] })

/** Corpo opcional: vazio/ausente = sem cadastro. Aceita `{ user: {…} }`. */
async function readSignup(raw: string): Promise<z.infer<typeof signupSchema> | null> {
  if (!raw.trim()) return null
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'Corpo da requisição malformado')
  }
  if (body && typeof body === 'object' && 'user' in body && typeof (body as { user: unknown }).user === 'object') body = (body as { user: unknown }).user
  if (!body || typeof body !== 'object' || Object.keys(body).length === 0) return null
  return signupSchema.parse(body)
}

export function invitationsRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()
  const svc = () => teamServices(deps).invitations
  const cookieSecure = deps.cookieSecure ?? process.env.NODE_ENV === 'production'

  app.get('/api/invitations/:token', async (c) => c.json({ invitation: await run(() => svc().getByToken(c.req.param('token'))) }))

  app.post('/api/invitations/:token/accept', async (c) => {
    const token = c.req.param('token')
    const session = await deps.sessions.verify(getCookie(c, SESSION_COOKIE))
    const signup = session ? null : await readSignup(await c.req.text())
    const meta = { userAgent: c.req.header('user-agent') ?? null, ip: clientIp(c, deps.trustProxy) }
    const r = await run(() =>
      svc().accept(token, session ? { user: session.user } : signup ? { signup: { name: signup.name, password: signup.password } } : null, meta),
    )
    if (r.session) setSessionCookie(c, r.session.token, r.session.expiresAt, { secure: cookieSecure })
    return c.json({ company: r.company, role: r.role, user: r.user })
  })

  app.post('/api/invitations/:token/decline', async (c) => c.json({ invitation: await run(() => svc().decline(c.req.param('token'))) }))

  return app
}
