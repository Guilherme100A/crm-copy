import { describe, expect, it } from 'vitest'
import { fileExists, readText } from '../helpers/exec'
import { BRAND_RE, ENV_VARS, SECRET_VARS } from './contract'

function parseEnv(text: string): Map<string, string> {
  const vars = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]!.trim()
    const q = value[0]
    if ((q === '"' || q === "'") && value.lastIndexOf(q) > 0) value = value.slice(1, value.lastIndexOf(q))
    else value = value.replace(/\s+#.*$/, '')
    vars.set(m[1]!, value)
  }
  return vars
}

const PLACEHOLDER = /change|replace|example|placeholder|your[-_]?|xxx|<[^>]*>|\$\{[^}]*\}|dummy|fake|sample|todo|fill|insert|generate|gere|troque|preencha|sua[-_]|seu[-_]|secret[-_]?here/i

// Padrões de segredos reais conhecidos (nunca devem aparecer em .env.example).
const REAL_SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['Groq key', /\bgsk_[A-Za-z0-9]{20,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['Meta access token', /\bEAA[A-Za-z0-9]{30,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]

function entropy(s: string): number {
  const freq = new Map<string, number>()
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length)
  return h
}

/** "Segredo real" = valor longo e de alta entropia que não é placeholder (ex.: chave base64 gerada). */
function looksLikeRealSecret(value: string): boolean {
  if (!value || PLACEHOLDER.test(value)) return false
  if (/^(.)\1*=*$/.test(value)) return false // AAAA…= ou xxxxxx
  return value.length >= 16 && entropy(value) > 3.5
}

describe('T00 — .env.example', () => {
  it('AC-T00-05 .env.example contém todas as variáveis da seção 3.12', () => {
    expect(fileExists('.env.example'), '.env.example não existe').toBe(true)
    const vars = parseEnv(readText('.env.example'))
    const missing = ENV_VARS.filter((v) => !vars.has(v))
    expect(missing, `variáveis ausentes: ${missing.join(', ')}`).toEqual([])
  })

  it('AC-T00-05 variáveis de segredo estão vazias ou com placeholder (sem segredo real)', () => {
    const vars = parseEnv(readText('.env.example'))
    for (const name of SECRET_VARS) {
      const value = vars.get(name) ?? ''
      expect(looksLikeRealSecret(value), `${name} parece conter um segredo real: "${value}"`).toBe(false)
    }
    for (const [name, value] of vars) {
      if (/(TOKEN|SECRET|KEY|PASSWORD)$/.test(name)) {
        expect(looksLikeRealSecret(value), `${name} parece conter um segredo real: "${value}"`).toBe(false)
      }
    }
  })

  it('AC-T00-05 .env.example não contém padrões de credenciais reais nem senha forte em URL', () => {
    const text = readText('.env.example')
    for (const [label, re] of REAL_SECRET_PATTERNS) expect(re.test(text), `encontrado ${label}`).toBe(false)
    for (const [name, value] of parseEnv(text)) {
      const m = /^[a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:([^@\s]+)@/i.exec(value)
      if (m) expect(looksLikeRealSecret(decodeURIComponent(m[1]!)), `${name}: senha na URL parece real`).toBe(false)
    }
  })

  it('AC-T00-05 APP_NAME tem valor neutro (não vazio, sem a marca proibida)', () => {
    const value = parseEnv(readText('.env.example')).get('APP_NAME') ?? ''
    expect(value.trim().length, 'APP_NAME vazio').toBeGreaterThan(0)
    expect(BRAND_RE.test(value), `APP_NAME = "${value}" usa a marca proibida`).toBe(false)
  })
})
