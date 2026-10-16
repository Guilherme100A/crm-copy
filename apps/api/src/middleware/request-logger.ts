// Logger por requisição com `request_id` (roda depois do `requestId()` do Hono). Só o caminho, nunca a query.
import type { MiddlewareHandler } from 'hono'
import type { Logger } from '@crm/node-kit'
import type { AppEnv } from '../lib/types'

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
          path: c.req.path,
          status: c.res.status,
          duration_ms: Math.round((performance.now() - start) * 100) / 100,
        },
        'request completed',
      )
    }
  }
}
