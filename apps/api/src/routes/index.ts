// Registro das rotas (SPEC 2.4, compartilhado aditivo): cada módulo acrescenta `app.route('/', <módulo>Routes(deps))`.
import type { Hono } from 'hono'
import type { AppEnv, ResolvedDeps } from '../lib/types'
import { authRoutes } from './auth/index'
import { healthRoutes } from './health/index'
import { eventsRoutes } from './events/index'
import { contactsRoutes } from './contacts/index'
import { labelsRoutes } from './labels/index'
import { customFieldsRoutes } from './custom-fields/index'
import { companiesRoutes, companyActiveGuard } from './companies/index'
import { teamRoutes } from './team/index'
import { invitationsRoutes } from './invitations/index'

export function registerRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  // Antes de qualquer rota: empresa ativa desativada → 403 company_inactive (T22).
  app.use('/api/*', companyActiveGuard(deps))
  app.route('/', healthRoutes(deps))
  app.route('/', authRoutes(deps))
  app.route('/', eventsRoutes(deps))
  app.route('/', contactsRoutes(deps))
  app.route('/', labelsRoutes(deps))
  app.route('/', customFieldsRoutes(deps))
  app.route('/', companiesRoutes(deps))
  app.route('/', teamRoutes(deps))
  app.route('/', invitationsRoutes(deps))
}
