// Logger pino com redação profunda de segredos (SPEC T05, AC-T05-02; SPEC 1.4 #1 e #8).
// Mesmo desenho do ai-manager (packages/core/src/logger): o `redact` nativo do pino só aceita caminhos fixos,
// então a redação é feita em `formatters.log`/`formatters.bindings` e nos bindings de child loggers.
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino'

export type { Logger }

export const REDACTED = '[Redacted]'

/** Chaves cujo valor nunca vai para o log, em qualquer profundidade (comparação sem caixa, ignorando `-`/`_`). */
export const SENSITIVE_LOG_KEYS = [
  // exigidas pela SPEC T05
  'password',
  'token',
  'secret',
  'apiKey',
  'creds',
  'keys',
  'noiseKey',
  'signedIdentityKey',
  'authorization',
  'cookie',
  // auth state do Baileys e cifragem (ai-manager)
  'signedPreKey',
  'identityKey',
  'advSecretKey',
  'pairingEphemeralKeyPair',
  'privKey',
  'privateKey',
  'authState',
  'credentials',
  'credentialsKey',
  'ciphertext',
  'authTag',
  // variações comuns
  'passwordHash',
  'accessToken',
  'refreshToken',
  'apiToken',
  'clientSecret',
  'appSecret',
  'setCookie',
] as const

const normalizeKey = (k: string) => k.replace(/[-_]/g, '').toLowerCase()
const SENSITIVE = new Set<string>(SENSITIVE_LOG_KEYS.map(normalizeKey))

export function isSensitiveLogKey(key: string): boolean {
  return SENSITIVE.has(normalizeKey(key))
}

const MAX_DEPTH = 10

/** Cópia profunda do valor com as chaves sensíveis substituídas por `[Redacted]`. Não altera o original. */
export function redactSecrets<T>(value: T): T {
  return redact(value, 0, new WeakSet()) as T
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value
  // Erros seguem para o serializer `err` do pino; Buffers não têm chaves.
  if (value instanceof Error || Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof Date)
    return value
  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_DEPTH) return '[Truncated]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen))
    if (value instanceof Map) return redact(Object.fromEntries(value), depth, seen)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = isSensitiveLogKey(k) ? REDACTED : redact(v, depth + 1, seen)
    return out
  } finally {
    seen.delete(value)
  }
}

export interface CreateLoggerOptions extends LoggerOptions {
  /** Destino alternativo (default: stdout). */
  destination?: DestinationStream
}

/** Cria um logger pino com redação profunda no objeto do log, nos bindings base e nos de child loggers. */
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const { destination, formatters, ...rest } = opts
  const options: LoggerOptions = {
    level: process.env.LOG_LEVEL || 'info',
    ...rest,
    formatters: {
      ...formatters,
      log: (obj) => redactSecrets(formatters?.log ? formatters.log(obj) : obj),
      bindings: (bindings) => redactSecrets(formatters?.bindings ? formatters.bindings(bindings) : bindings),
    },
  }
  return withRedactedChildren(destination ? pino(options, destination) : pino(options))
}

/**
 * Bindings de child loggers (e `setBindings`) não passam por `formatters`: são higienizados aqui.
 * Children do pino herdam do pai por protótipo, então basta sobrescrever no raiz com funções que usam `this`
 * (nunca `bind`, senão netos e `child.setBindings` iriam para o raiz).
 */
function withRedactedChildren(logger: Logger): Logger {
  type ChildFn = (this: Logger, bindings: object, options?: object) => Logger
  type SetBindingsFn = (this: Logger, bindings: object) => void
  const target = logger as unknown as { child: ChildFn; setBindings: SetBindingsFn }
  const child = target.child
  const setBindings = target.setBindings
  target.child = function (bindings, options) {
    return child.call(this, redactSecrets(bindings), options)
  }
  target.setBindings = function (bindings) {
    setBindings.call(this, redactSecrets(bindings))
  }
  return logger
}
