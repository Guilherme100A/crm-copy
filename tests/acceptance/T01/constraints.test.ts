// AC-T01-03: users.email único sem diferenciar maiúsculas; no máximo um owner por empresa
// (índice parcial) e um vínculo por (empresa, usuário) em company_members.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTempDb, dropTempDb, fakeEmail, lit, sql, sqlState, type TempDb } from '../helpers'
import { insertOk, loadDb, migrate, randomText, role, tryInsert } from './support'

let db: TempDb

beforeAll(async () => {
  db = createTempDb('crm_acc_t01')
  await migrate(await loadDb(), db.url, 'crm')
})

afterAll(() => dropTempDb(db))

const newUser = (email = fakeEmail()) => insertOk(db.url, 'users', { email: lit(email), name: lit(randomText('u')) })
const newCompany = () => insertOk(db.url, 'companies', { name: lit(randomText('c')), slug: lit(randomText('slug')) })
const link = (companyId: string, userId: string, r: 'owner' | 'admin' | 'member') =>
  tryInsert(db.url, 'company_members', { company_id: lit(companyId), user_id: lit(userId), role: role(r) })

describe('crm.users.email', () => {
  it('AC-T01-03 e-mail repetido com caixa diferente é rejeitado (unique_violation)', () => {
    const base = randomText('Fulano')
    newUser(`${base}@Example.test`)
    const dup = tryInsert(db.url, 'users', { email: lit(`${base.toUpperCase()}@EXAMPLE.TEST`), name: lit('Outro') })
    expect(dup.code, 'e-mail com outra caixa foi aceito').not.toBe(0)
    expect(sqlState(dup), dup.stderr).toBe('23505')
  })

  it('AC-T01-03 e-mail idêntico é rejeitado e e-mails distintos são aceitos', () => {
    const email = fakeEmail()
    newUser(email)
    const dup = tryInsert(db.url, 'users', { email: lit(email), name: lit('Outro') })
    expect(sqlState(dup), dup.stderr).toBe('23505')
    expect(() => newUser(fakeEmail())).not.toThrow()
  })
})

describe('crm.company_members', () => {
  it('AC-T01-03 segundo owner na mesma empresa é rejeitado', () => {
    const c = newCompany()
    expect(link(c, newUser(), 'owner').code).toBe(0)
    const second = link(c, newUser(), 'owner')
    expect(second.code, 'segundo owner aceito').not.toBe(0)
    expect(sqlState(second), second.stderr).toBe('23505')
  })

  it('AC-T01-03 o índice de owner é parcial: vários admins/members convivem com o owner', () => {
    const c = newCompany()
    expect(link(c, newUser(), 'owner').code).toBe(0)
    for (const r of ['admin', 'admin', 'member', 'member'] as const) {
      const res = link(c, newUser(), r)
      expect(res.code, `${r} rejeitado: ${res.stderr}`).toBe(0)
    }
  })

  it('AC-T01-03 cada empresa tem seu owner (o limite é por empresa)', () => {
    const owner = newUser()
    for (let i = 0; i < 3; i++) {
      const res = link(newCompany(), i === 0 ? owner : newUser(), 'owner')
      expect(res.code, res.stderr).toBe(0)
    }
    // o mesmo usuário pode ser owner de outra empresa
    expect(link(newCompany(), owner, 'owner').code).toBe(0)
  })

  it('AC-T01-03 após rebaixar o owner, outro usuário pode virar owner', () => {
    const c = newCompany()
    const a = newUser()
    expect(link(c, a, 'owner').code).toBe(0)
    const upd = sql(db.url, `UPDATE crm.company_members SET role = ${role('admin')} WHERE company_id = ${lit(c)} AND user_id = ${lit(a)};`)
    expect(upd.code, upd.stderr).toBe(0)
    expect(link(c, newUser(), 'owner').code).toBe(0)
  })

  it('AC-T01-03 um único vínculo por (empresa, usuário)', () => {
    const c = newCompany()
    const u = newUser()
    expect(link(c, u, 'member').code).toBe(0)
    for (const r of ['member', 'admin'] as const) {
      const dup = link(c, u, r)
      expect(dup.code, `vínculo duplicado (${r}) aceito`).not.toBe(0)
      expect(sqlState(dup), dup.stderr).toBe('23505')
    }
    // o mesmo usuário em outra empresa é permitido
    expect(link(newCompany(), u, 'member').code).toBe(0)
  })
})
