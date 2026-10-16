// Factories de dados de teste. Nada aqui representa pessoa, empresa ou número real.
import { randomBytes, randomUUID } from 'node:crypto'

let seq = 0

export const uniqueId = (prefix = 'test') => `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}-${randomBytes(3).toString('hex')}`

export const uuid = () => randomUUID()

/** Telefone fictício E.164 (faixa +5599900xxxxxx, só para testes). */
export const fakePhone = () => `+55999${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`

/** JID fictício do WhatsApp a partir de um telefone. */
export const fakeJid = (phone = fakePhone()) => `${phone.replace(/^\+/, '')}@s.whatsapp.net`

/** Chave de 32 bytes em base64 (formato de CREDENTIALS_KEY, SPEC 3.12). */
export const credentialsKey = () => randomBytes(32).toString('base64')

/** E-mail único em domínio reservado para testes (RFC 2606). */
export const fakeEmail = (prefix = 'user') => `${uniqueId(prefix)}@example.test`

export const buildUser = (overrides: Record<string, unknown> = {}) => ({
  name: `Usuário ${uniqueId('u')}`,
  email: fakeEmail(),
  password: `Senha-${randomBytes(6).toString('hex')}`,
  ...overrides,
})

export const buildCompany = (overrides: Record<string, unknown> = {}) => ({
  name: `Empresa ${uniqueId('c')}`,
  time_zone: 'America/Sao_Paulo',
  ...overrides,
})

export const buildContact = (overrides: Record<string, unknown> = {}) => ({
  name: `Contato ${uniqueId('ct')}`,
  phone_e164: fakePhone(),
  ...overrides,
})
