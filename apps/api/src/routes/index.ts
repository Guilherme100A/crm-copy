// Registro das rotas (SPEC 2.4, compartilhado aditivo): cada módulo acrescenta `app.route('/', <módulo>Routes(deps))`.
import type { Hono } from 'hono'
import type { AppEnv, ResolvedDeps } from '../lib/types'
import { authRoutes } from './auth/index'
import { healthRoutes } from './health/index'
import { eventsRoutes } from './events/index'

export function registerRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  app.route('/', healthRoutes(deps))
  app.route('/', authRoutes(deps))
  app.route('/', eventsRoutes(deps))
}
