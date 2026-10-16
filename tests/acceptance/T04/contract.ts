// Contratos de T04 (STACK F.2 + contrato combinado com o Operário) usados pelos testes.
// Os testes falam só com as portas públicas `@crm/ai` e `@crm/ai/testing`.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ai from '@crm/ai'
import * as testing from '@crm/ai/testing'
import { rootPath } from '../helpers/exec'

export const port = ai as unknown as Record<string, any>
export const fakes = testing as unknown as Record<string, any>

/** Exige que o módulo exporte `name`. */
export function exp(m: Record<string, any>, name: string, where: string): any {
  const v = m[name]
  if (v === undefined) throw new Error(`${where} não exporta ${name} (exports: ${Object.keys(m).join(', ') || '—'})`)
  return v
}

/**
 * zod resolvido a partir do próprio `@crm/ai` (a raiz não depende de zod). Assim as tools e o
 * `output` dos testes usam a mesma instância que a porta.
 */
export async function loadZod(): Promise<typeof import('zod')> {
  const req = createRequire(rootPath('packages', 'ai', 'package.json'))
  const pkgPath = req.resolve('zod/package.json')
  const pkg = req(pkgPath)
  const dot = pkg.exports?.['.']
  const imp = typeof dot === 'string' ? dot : typeof dot?.import === 'string' ? dot.import : (dot?.import?.default ?? dot?.default)
  const file = imp ? join(dirname(pkgPath), imp) : req.resolve('zod')
  const mod = await import(pathToFileURL(file).href)
  return (mod.z ? mod : mod.default) as typeof import('zod')
}

/** Nº de chamadas que chegaram ao fake (`callCount` ou `calls` array/número). */
export function callCount(f: any): number {
  if (typeof f.callCount === 'number') return f.callCount
  if (Array.isArray(f.calls)) return f.calls.length
  if (typeof f.calls === 'number') return f.calls
  throw new Error('fake não expõe callCount/calls')
}

export const MODEL = { provider: 'openai', model: 'gpt-test' } as const

export function request(extra: Record<string, unknown> = {}) {
  return {
    model: MODEL,
    instructions: 'Você é um agente de teste.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'mova o card' }] }],
    tenantId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    agentId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    ...extra,
  }
}

export const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costMicros'] as const

export function sumUsage(steps: Array<{ usage: Record<string, number> }>) {
  const out: Record<string, number> = {}
  for (const k of USAGE_KEYS) out[k] = steps.reduce((s, st) => s + (st.usage?.[k] ?? 0), 0)
  return out
}

export const toBytes = (a: any): Uint8Array => (a instanceof Uint8Array ? a : new Uint8Array(a))
