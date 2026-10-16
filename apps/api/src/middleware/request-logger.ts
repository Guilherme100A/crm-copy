// Logger por requisição com `request_id` (roda depois do `requestId()` do Hono). Só o caminho, nunca a query.
// T81: os webhooks públicos (`/api/hooks/**`) levam o token no caminho (`/api/hooks/in/<token>`); no log ele sai
// mascarado (`/api/hooks/in/***`).
import type { MiddlewareHandler } from 'hono'
import type { Logger } from '@crm/node-kit'
import type { AppEnv } from '../lib/types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Caminho para o log: em `/api/hooks/in/<token>` o token vira `***`; nos demais `/api/hooks/**`, qualquer segmento
 * com cara de segredo (≥ 20 caracteres e não-UUID) também. Fora de `/api/hooks/` não muda nada.
 */
export function logPath(path: string): string {
  if (!path.startsWith('/api/hooks/')) return path
  const parts = path.split('/')
  // ['', 'api', 'hooks', <tipo>, ...]
  return parts
    .map((seg, i) => {
      if (i < 4 || !seg) return seg
      if (parts[3] === 'in') return '***'
      return seg.length >= 20 && !UUID_RE.test(seg) ? '***' : seg
    })
    .join('/')
}

export function requestLogger(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = performance.now()
    const log = logger.child({ request_id: c.get('requestId') })
    c.set('logger', log)
    try {
      await next()
    } finally {
      log.info(
        {
          method: c.req.method,
          path: logPath(c.req.path),
          status: c.res.status,
          duration_ms: Math.round((performance.now() - start) * 100) / 100,
        },
        'request completed',
      )
    }
  }
}
