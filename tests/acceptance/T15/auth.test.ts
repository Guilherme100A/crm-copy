// AC-T15-01..06 — login, cadastro, logout, reset de senha, perfil e avatar (caixa-preta via HTTP).
import { PASSWORD_MIN_LENGTH } from '@crm/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { fakeEmail } from '../helpers/factories'
import {
  APP_NAME_T15,
  client,
  type Env,
  fakeImage,
  fakeIp,
  loggedIn,
  mailsTo,
  newPassword,
  registerUser,
  registration,
  resetTokenFrom,
  startEnv,
  uploadAvatar,
  WEB_URL_T15,
} from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

describe('T15 — login', () => {
  it('AC-T15-01 login correto → 200, cookie crm_session httpOnly e { user, companies[] }', async () => {
    const user = await registerUser(env)
    const c = client(env)
    const res = await c.post('/api/auth/login', { email: user.email, password: user.password })
    expect(res.status, res.text).toBe(200)
    const setCookie = res.headers.getSetCookie().find((s) => s.startsWith('crm_session='))
    expect(setCookie, 'Set-Cookie crm_session ausente').toBeTruthy()
    expect(setCookie).toMatch(/;\s*HttpOnly/i)
    expect(setCookie).toMatch(/;\s*SameSite=Lax/i)
    expect(res.body.user.email.toLowerCase()).toBe(user.email.toLowerCase())
    expect(Array.isArray(res.body.companies)).toBe(true)
    expect(res.body.companies.length).toBeGreaterThanOrEqual(1)
    expect(res.text).not.toContain(user.password)
    expect(res.text).not.toMatch(/password_hash|scrypt\$/)
  })

  it('AC-T15-01 o cookie do login autentica as rotas /api/*', async () => {
    const { c, user } = await loggedIn(env)
    const res = await c.get('/api/auth/profile')
    expect(res.status, res.text).toBe(200)
    expect(res.body.user.email.toLowerCase()).toBe(user.email.toLowerCase())
  })

  it('AC-T15-01 e-mail em outra caixa também loga', async () => {
    const user = await registerUser(env)
    const res = await client(env).post('/api/auth/login', { email: user.email.toUpperCase(), password: user.password })
    expect(res.status, res.text).toBe(200)
  })

  it('AC-T15-01 senha errada e e-mail inexistente → 401 com a mesma mensagem', async () => {
    const user = await registerUser(env)
    const wrong = await client(env).post('/api/auth/login', { email: user.email, password: 'senha-errada-123' })
    const missing = await client(env).post('/api/auth/login', { email: fakeEmail('nao-existe'), password: 'senha-errada-123' })
    expectApiError(wrong, 'UNAUTHORIZED', 401)
    expectApiError(missing, 'UNAUTHORIZED', 401)
    expect(wrong.body.error.message).toBe(missing.body.error.message)
    expect(wrong.headers.getSetCookie().some((s) => /^crm_session=[^;]+/.test(s) && !/max-age=0/i.test(s))).toBe(false)
  })

  it('AC-T15-01 10 falhas em 15 min (mesmo IP+e-mail) → a seguinte é 429 RATE_LIMIT', async () => {
    const user = await registerUser(env)
    const c = client(env, fakeIp())
    for (let i = 1; i <= 10; i++) {
      const r = await c.post('/api/auth/login', { email: user.email, password: `errada-${i}` })
      expect(r.status, `tentativa ${i}: ${r.text}`).toBe(401)
    }
    expectApiError(await c.post('/api/auth/login', { email: user.email, password: 'errada-11' }), 'RATE_LIMIT', 429)
    // bloqueio vale também para a senha certa enquanto a janela não expira
    expect((await c.post('/api/auth/login', { email: user.email, password: user.password })).status).toBe(429)
  })

  it('AC-T15-01 o bloqueio é por IP+e-mail: outro IP ainda consegue logar', async () => {
    const user = await registerUser(env)
    const blocked = client(env, fakeIp())
    for (let i = 1; i <= 11; i++) await blocked.post('/api/auth/login', { email: user.email, password: `errada-${i}` })
    const res = await client(env, fakeIp()).post('/api/auth/login', { email: user.email, password: user.password })
    expect(res.status, res.text).toBe(200)
  })
})

describe('T15 — cadastro', () => {
  it("AC-T15-02 cadastro cria usuário system_role=user, empresa e membership owner", async () => {
    const data = registration()
    const res = await client(env).post('/api/auth/register', data)
    expect(res.status, res.text).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
    expect(res.text).not.toContain(data.password)
    const [u] = await env.q(`SELECT id, system_role, password_hash FROM crm.users WHERE lower(email) = lower($1)`, [data.email])
    expect(u, 'usuário não gravado').toBeTruthy()
    expect(u.system_role).toBe('user')
    expect(u.password_hash).not.toContain(data.password)
    const members = await env.q(`SELECT m.role, c.name, c.active FROM crm.company_members m JOIN crm.companies c ON c.id = m.company_id WHERE m.user_id = $1`, [u.id])
    expect(members).toHaveLength(1)
    expect(members[0].role).toBe('owner')
    expect(members[0].name).toBe('Minha empresa')
    // o login seguinte devolve essa empresa
    const login = await client(env).post('/api/auth/login', { email: data.email, password: data.password })
    expect(login.status, login.text).toBe(200)
    expect(login.body.companies).toHaveLength(1)
  })

  it('AC-T15-02 senha menor que PASSWORD_MIN_LENGTH (8) → 422 e nada é criado', async () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8)
    const short = 'a'.repeat(PASSWORD_MIN_LENGTH - 1)
    const data = registration({ password: short, password_confirmation: short })
    expectApiError(await client(env).post('/api/auth/register', data), 'VALIDATION_ERROR', 422)
    expect(await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [data.email])).toHaveLength(0)
  })

  it('AC-T15-02 senha com exatamente PASSWORD_MIN_LENGTH caracteres é aceita', async () => {
    const exact = 'b'.repeat(PASSWORD_MIN_LENGTH)
    const data = registration({ password: exact, password_confirmation: exact })
    const res = await client(env).post('/api/auth/register', data)
    expect(res.status, res.text).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
    expect((await client(env).post('/api/auth/login', { email: data.email, password: exact })).status).toBe(200)
  })

  it('AC-T15-02 confirmação diferente da senha → 422 e nada é criado', async () => {
    const data = registration({ password_confirmation: 'outra-senha-123' })
    expectApiError(await client(env).post('/api/auth/register', data), 'VALIDATION_ERROR', 422)
    expect(await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [data.email])).toHaveLength(0)
  })

  it('AC-T15-02 e-mail repetido (qualquer caixa) → 409', async () => {
    const first = await registerUser(env)
    const again = registration({ email: first.email.toUpperCase() })
    expectApiError(await client(env).post('/api/auth/register', again), 'CONFLICT', 409)
    const sameCase = registration({ email: first.email })
    expectApiError(await client(env).post('/api/auth/register', sameCase), 'CONFLICT', 409)
    expect(await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [first.email])).toHaveLength(1)
  })

  const referredBy = async (userId: string) =>
    (await env.q(`SELECT referred_by_code FROM crm.user_profiles WHERE user_id = $1`, [userId]))[0]?.referred_by_code ?? null
  const ownReferral = async (userId: string) =>
    (await env.q(`SELECT referral_code FROM crm.users WHERE id = $1`, [userId]))[0]?.referral_code ?? null

  it('AC-T15-02 referral_code válido (^[A-Za-z0-9_-]{1,64}$) fica em user_profiles.referred_by_code; users.referral_code intocado', async () => {
    for (const code of ['Parceiro_01', 'a', 'X-'.padEnd(64, 'z')]) {
      const user = await registerUser(env, { referral_code: code })
      expect(await referredBy(user.userId), `código ${code}`).toBe(code)
      expect(await ownReferral(user.userId), 'users.referral_code não pode ser tocado').toBeNull()
    }
  })

  it('AC-T15-02 o mesmo referral_code pode indicar vários usuários (sem unique)', async () => {
    const a = await registerUser(env, { referral_code: 'Afiliado-Compartilhado' })
    const b = await registerUser(env, { referral_code: 'Afiliado-Compartilhado' })
    expect(await referredBy(a.userId)).toBe('Afiliado-Compartilhado')
    expect(await referredBy(b.userId)).toBe('Afiliado-Compartilhado')
  })

  it('AC-T15-02 referral_code inválido é ignorado (cadastro ok, nada gravado)', async () => {
    for (const code of ['com espaço', 'ç-acentuado', 'x'.repeat(65), '<script>', '']) {
      const user = await registerUser(env, { referral_code: code })
      expect(await referredBy(user.userId), `código ${JSON.stringify(code)}`).toBeNull()
      expect(await ownReferral(user.userId), `código ${JSON.stringify(code)}`).toBeNull()
    }
  })
})

describe('T15 — logout', () => {
  it('AC-T15-03 logout revoga a sessão: o mesmo cookie depois → 401', async () => {
    const { c } = await loggedIn(env)
    const cookie = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    expect((await c.get('/api/auth/profile')).status).toBe(200)
    const out = await c.post('/api/auth/logout')
    expect(out.status, out.text).toBeGreaterThanOrEqual(200)
    expect(out.status).toBeLessThan(300)
    // reenvia exatamente o cookie antigo (o cliente pode ter apagado o seu)
    const res = await env.app.request('/api/auth/profile', { headers: { cookie } })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('UNAUTHORIZED')
  })

  it('AC-T15-03 logout de uma sessão não derruba outra sessão do mesmo usuário', async () => {
    const { c, user } = await loggedIn(env)
    const other = client(env)
    expect((await other.post('/api/auth/login', { email: user.email, password: user.password })).status).toBe(200)
    await c.post('/api/auth/logout')
    expect((await other.get('/api/auth/profile')).status).toBe(200)
  })
})

describe('T15 — reset de senha', () => {
  it('AC-T15-04 e-mail inexistente → 200 neutro, igual ao de e-mail existente, sem e-mail enviado', async () => {
    const user = await registerUser(env)
    const ghost = fakeEmail('fantasma')
    const before = env.mailer.messages.length
    const a = await client(env).post('/api/auth/password-resets', { email: ghost })
    expect(a.status, a.text).toBe(200)
    expect(mailsTo(env, ghost)).toHaveLength(0)
    const b = await client(env).post('/api/auth/password-resets', { email: user.email })
    expect(b.status, b.text).toBe(200)
    expect(a.text).toBe(b.text)
    expect(env.mailer.messages.length).toBe(before + 1)
  })

  it('AC-T15-04 e-mail existente recebe mensagem (MemoryMailer) com link do token; token vale uma vez', async () => {
    const user = await registerUser(env)
    expect((await client(env).post('/api/auth/password-resets', { email: user.email })).status).toBe(200)
    const mails = mailsTo(env, user.email)
    expect(mails).toHaveLength(1)
    const mail = mails[0]
    expect(typeof mail.subject).toBe('string')
    const content = `${mail.subject} ${mail.text ?? ''} ${mail.html ?? ''}`
    expect(content).not.toMatch(/leona/i)
    expect(content, 'e-mail deve citar APP_NAME').toContain(APP_NAME_T15)
    expect(content, 'link deve apontar para o web').toContain(WEB_URL_T15)
    const token = resetTokenFrom(mail)

    const check = await client(env).get(`/api/auth/password-resets/${encodeURIComponent(token)}`)
    expect(check.status, check.text).toBe(200)
    expect(check.body.valid).toBe(true)

    const pwd = newPassword()
    const used = await client(env).patch(`/api/auth/password-resets/${encodeURIComponent(token)}`, { password: pwd, password_confirmation: pwd })
    expect(used.status, used.text).toBeGreaterThanOrEqual(200)
    expect(used.status).toBeLessThan(300)

    // nova senha vale, a antiga não
    expect((await client(env).post('/api/auth/login', { email: user.email, password: pwd })).status).toBe(200)
    expect((await client(env).post('/api/auth/login', { email: user.email, password: user.password })).status).toBe(401)

    // segundo uso falha e o GET informa inválido com motivo
    const pwd2 = newPassword()
    const again = await client(env).patch(`/api/auth/password-resets/${encodeURIComponent(token)}`, { password: pwd2, password_confirmation: pwd2 })
    expectApiError(again, 'GONE', 410)
    expect((await client(env).post('/api/auth/login', { email: user.email, password: pwd2 })).status).toBe(401)
    const after = await client(env).get(`/api/auth/password-resets/${encodeURIComponent(token)}`)
    expect(after.body.valid).toBe(false)
    expect(typeof after.body.reason).toBe('string')
    expect(after.body.reason.length).toBeGreaterThan(0)
  })

  it('AC-T15-04 token expirado → GET { valid: false, reason } e PATCH falha', async () => {
    const user = await registerUser(env)
    await client(env).post('/api/auth/password-resets', { email: user.email })
    const token = resetTokenFrom(mailsTo(env, user.email).at(-1))
    await env.q(`UPDATE crm.password_resets SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [user.userId])
    const res = await client(env).get(`/api/auth/password-resets/${encodeURIComponent(token)}`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.valid).toBe(false)
    expect(typeof res.body.reason).toBe('string')
    const pwd = newPassword()
    const patch = await client(env).patch(`/api/auth/password-resets/${encodeURIComponent(token)}`, { password: pwd, password_confirmation: pwd })
    expectApiError(patch, 'GONE', 410)
    expect((await client(env).post('/api/auth/login', { email: user.email, password: user.password })).status).toBe(200)
  })

  it('AC-T15-04 token desconhecido → GET { valid: false, reason }', async () => {
    const res = await client(env).get('/api/auth/password-resets/token-que-nao-existe-1234567890')
    expect(res.body?.valid, res.text).toBe(false)
    expect(typeof res.body.reason).toBe('string')
  })
})

describe('T15 — perfil', () => {
  it('AC-T15-05 trocar e-mail sem current_password → 422 current_password_invalid', async () => {
    const { c, user } = await loggedIn(env)
    const res = await c.put('/api/auth/profile', { email: fakeEmail('novo') })
    expect(res.status, res.text).toBe(422)
    expect(res.text).toContain('current_password_invalid')
    const [row] = await env.q(`SELECT email FROM crm.users WHERE id = $1`, [user.userId])
    expect(row.email.toLowerCase()).toBe(user.email.toLowerCase())
  })

  it('AC-T15-05 trocar e-mail com current_password errado → 422 current_password_invalid', async () => {
    const { c, user } = await loggedIn(env)
    const res = await c.put('/api/auth/profile', { email: fakeEmail('novo'), current_password: 'nao-e-a-senha' })
    expect(res.status, res.text).toBe(422)
    expect(res.text).toContain('current_password_invalid')
    const [row] = await env.q(`SELECT email FROM crm.users WHERE id = $1`, [user.userId])
    expect(row.email.toLowerCase()).toBe(user.email.toLowerCase())
  })

  it('AC-T15-05 trocar e-mail com current_password correto → 200 e e-mail atualizado', async () => {
    const { c, user } = await loggedIn(env)
    const novo = fakeEmail('novo')
    const res = await c.put('/api/auth/profile', { email: novo, current_password: user.password })
    expect(res.status, res.text).toBe(200)
    expect(res.body.user.email.toLowerCase()).toBe(novo.toLowerCase())
  })

  it('AC-T15-05 locale válido (en, es, pt-BR) é gravado como veio no fio e no banco', async () => {
    const { c, user } = await loggedIn(env)
    for (const loc of ['en', 'es', 'pt-BR']) {
      const res = await c.put('/api/auth/profile', { locale: loc })
      expect(res.status, res.text).toBe(200)
      expect(res.body.user.locale).toBe(loc)
      const [row] = await env.q(`SELECT locale FROM crm.users WHERE id = $1`, [user.userId])
      expect(row.locale).toBe(loc)
    }
  })

  it('AC-T15-05 entrada pt_BR é aceita como sinônimo e vira pt-BR', async () => {
    const { c, user } = await loggedIn(env)
    expect((await c.put('/api/auth/profile', { locale: 'en' })).status).toBe(200)
    const res = await c.put('/api/auth/profile', { locale: 'pt_BR' })
    expect(res.status, res.text).toBe(200)
    expect(res.body.user.locale).toBe('pt-BR')
    const [row] = await env.q(`SELECT locale FROM crm.users WHERE id = $1`, [user.userId])
    expect(row.locale).toBe('pt-BR')
  })

  it('AC-T15-05 locale inválido é normalizado para pt-BR', async () => {
    const { c, user } = await loggedIn(env)
    expect((await c.put('/api/auth/profile', { locale: 'en' })).body?.user?.locale).toBe('en')
    const res = await c.put('/api/auth/profile', { locale: 'xx_INVALIDO' })
    expect(res.status, res.text).toBe(200)
    expect(res.body.user.locale).toBe('pt-BR')
    expect((await c.get('/api/auth/profile')).body.user.locale).toBe('pt-BR')
    const [row] = await env.q(`SELECT locale FROM crm.users WHERE id = $1`, [user.userId])
    expect(row.locale).toBe('pt-BR')
  })
})

describe('T15 — avatar', () => {
  it.each([
    ['png', 'avatar.png'],
    ['jpeg', 'avatar.jpg'],
    ['webp', 'avatar.webp'],
  ] as const)('AC-T15-06 %s aceito → avatar_url preenchido', async (kind, name) => {
    const { c } = await loggedIn(env)
    const res = await uploadAvatar(env, c, fakeImage(kind, 4096), name)
    expect(res.status, res.text).toBe(200)
    expect(res.body.user.avatar_url).toBeTruthy()
    expect((await c.get('/api/auth/profile')).body.user.avatar_url).toBeTruthy()
  })

  it('AC-T15-06 imagem de exatamente 5 MB é aceita', async () => {
    const { c } = await loggedIn(env)
    const res = await uploadAvatar(env, c, fakeImage('png', 5 * 1024 * 1024), 'grande.png')
    expect(res.status, res.text.slice(0, 300)).toBe(200)
  })

  it('AC-T15-06 6 MB → 413 PAYLOAD_TOO_LARGE', async () => {
    const { c } = await loggedIn(env)
    const res = await uploadAvatar(env, c, fakeImage('png', 6 * 1024 * 1024), 'enorme.png')
    expect(res.status, res.text.slice(0, 300)).toBe(413)
    expect(res.body?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect((await c.get('/api/auth/profile')).body.user.avatar_url ?? null).toBeNull()
  })

  it('AC-T15-06 gif → 415 UNSUPPORTED_MEDIA', async () => {
    const { c } = await loggedIn(env)
    const res = await uploadAvatar(env, c, fakeImage('gif', 2048), 'anim.gif')
    expect(res.status, res.text).toBe(415)
    expect(res.body?.error?.code).toBe('UNSUPPORTED_MEDIA')
    expect((await c.get('/api/auth/profile')).body.user.avatar_url ?? null).toBeNull()
  })

  it('AC-T15-06 DELETE zera o avatar', async () => {
    const { c } = await loggedIn(env)
    expect((await uploadAvatar(env, c, fakeImage('png'), 'a.png')).status).toBe(200)
    const del = await c.delete('/api/auth/profile/avatar')
    expect(del.status, del.text).toBe(200)
    expect(del.body?.user?.avatar_url ?? null).toBeNull()
    expect((await c.get('/api/auth/profile')).body.user.avatar_url ?? null).toBeNull()
  })
})
