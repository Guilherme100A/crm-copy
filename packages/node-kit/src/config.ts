// Configuração validada por zod sobre `process.env` (SPEC T05, AC-T05-05).
import type { z } from 'zod'

export interface ConfigIssue {
  /** Nome da variável (ex.: `DATABASE_URL`). */
  name: string
  message: string
  missing: boolean
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[]
  constructor(issues: ConfigIssue[]) {
    const list = issues.map((i) => (i.missing ? `${i.name} (obrigatória, ausente)` : `${i.name}: ${i.message}`))
    super(`Configuração inválida: ${list.join('; ')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }

  /** Nomes das variáveis com problema. */
  get names(): string[] {
    return this.issues.map((i) => i.name)
  }
}

export type Env = Record<string, string | undefined>

/**
 * Valida `env` (default `process.env`) com o `schema` e devolve a saída tipada.
 * Variável vazia (`FOO=`) conta como ausente, para que `.optional()`/`.default()` se apliquem.
 * Falha → `ConfigError` cuja mensagem lista o nome de cada variável inválida/ausente. Nunca inclui valores.
 */
export function loadConfig<S extends z.ZodType>(schema: S, env: Env = process.env): z.output<S> {
  const input: Env = {}
  for (const [k, v] of Object.entries(env)) input[k] = v === '' ? undefined : v
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const byName = new Map<string, ConfigIssue>()
  for (const issue of result.error.issues) {
    const name = issue.path.length ? String(issue.path[0]) : '(raiz)'
    if (byName.has(name)) continue
    const missing = issue.path.length > 0 && input[name] === undefined
    byName.set(name, { name, message: issue.message, missing })
  }
  throw new ConfigError([...byName.values()])
}
