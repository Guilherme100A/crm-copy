// Registro das rotas (SPEC 2.4, compartilhado aditivo): cada módulo acrescenta `app.route('/', <módulo>Routes(deps))`.
import type { Hono } from 'hono'
import type { AppEnv, ResolvedDeps } from '../lib/types'
import { healthRoutes } from './health/index'

export function registerRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  app.route('/', healthRoutes(deps))
}
