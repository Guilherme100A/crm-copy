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
import { chatMessagesRoutes } from './chat-messages/index'
import { mediaRoutes } from './media/index'
import { flowsRoutes } from './flows/index'
import { aiAgentsRoutes } from './ai-agents/index'
import { departmentsRoutes } from './departments/index'
import { businessHoursRoutes } from './business-hours/index'
import { chatsRoutes } from './chats/index'
import { flowRunsRoutes } from './flow-runs/index'
import { flowShareRoutes } from './flow-share/index'
import { kanbanRoutes } from './kanban/index'
import { productsRoutes } from './products/index'
import { salesRoutes } from './sales/index'
import { connectionsRoutes } from './connections/index'
import { contentRoutes } from './content/index'
import { e2eRoutes, isE2eEnabled } from '../e2e/index'
export function registerRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  // T17: com E2E=1, primeiro de todos (põe os fakes nas deps antes das outras rotas lerem mailer/waGateway).
  if (isE2eEnabled()) app.route('/', e2eRoutes(deps))
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
  app.route('/', chatMessagesRoutes(deps))
  app.route('/', mediaRoutes(deps))
  app.route('/', flowsRoutes(deps))
  app.route('/', aiAgentsRoutes(deps))
  app.route('/', departmentsRoutes(deps))
  app.route('/', businessHoursRoutes(deps))
  app.route('/', chatsRoutes(deps))
  app.route('/', flowRunsRoutes(deps))
  app.route('/', flowShareRoutes(deps))
  app.route('/', kanbanRoutes(deps))
  app.route('/', productsRoutes(deps))
  app.route('/', salesRoutes(deps))
  app.route('/', connectionsRoutes(deps))
  app.route('/', contentRoutes(deps))
}
