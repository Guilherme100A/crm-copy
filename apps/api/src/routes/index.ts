// Registro das rotas (SPEC 2.4, compartilhado aditivo): cada módulo acrescenta `app.route('/', <módulo>Routes(deps))`.
import type { Hono } from 'hono'
import type { AppEnv, ResolvedDeps } from '../lib/types'
import { authRoutes } from './auth/index'
import { healthRoutes } from './health/index'
import { eventsRoutes } from './events/index'
import { contactsImportRoutes } from './contacts-import/index'
import { contactsBulkRoutes } from './contacts-bulk/index'
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
import { aiVoicesRoutes } from './ai-voices/index'
import { aiKnowledgeRoutes } from './ai-knowledge/index'
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
import { massDispatchRoutes } from './mass-dispatch/index'
import { exportsRoutes } from './exports/index'
import { aiKeysDefaults, aiKeysRoutes } from './ai-keys/index'
import { connectionFlowConfigsRoutes } from './connection-flow-configs/index'
import { schedulesRoutes } from './schedules/index'
import { aiUsageRoutes } from './ai-usage/index'
import { platformAiRoutes } from './platform-ai/index'
import { metaOAuthRoutes } from './meta-oauth/index'
import { metaProfilesRoutes } from './meta-profiles/index'
import { metaStructureRoutes } from './meta-structure/index'
import { metaPixelsRoutes } from './meta-pixels/index'
import { metaEntitiesRoutes } from './meta-entities/index'
import { paymentIntegrationsRoutes } from './payment-integrations/index'
import { inboundWebhooksRoutes } from './inbound-webhooks/index'
import { hooksRoutes } from './hooks/index'
import { dashboardRoutes } from './dashboard/index'
import { e2eRoutes, isE2eEnabled } from '../e2e/index'
export function registerRoutes(app: Hono<AppEnv>, deps: ResolvedDeps): void {
  // T17: com E2E=1, primeiro de todos (põe os fakes nas deps antes das outras rotas lerem mailer/waGateway).
  if (isE2eEnabled()) app.route('/', e2eRoutes(deps))
  // Antes de qualquer rota: empresa ativa desativada → 403 company_inactive (T22).
  app.use('/api/*', companyActiveGuard(deps))
  app.route('/', healthRoutes(deps))
  app.route('/', authRoutes(deps))
  app.route('/', eventsRoutes(deps))
  app.route('/', contactsImportRoutes(deps)) // antes de /api/contacts/:id (T67)
  app.route('/', contactsBulkRoutes(deps)) // antes de /api/contacts/:id (T66)
  app.route('/', contactsRoutes(deps))
  app.route('/', labelsRoutes(deps))
  app.route('/', customFieldsRoutes(deps))
  app.route('/', companiesRoutes(deps))
  app.route('/', teamRoutes(deps))
  app.route('/', invitationsRoutes(deps))
  app.route('/', chatMessagesRoutes(deps))
  app.route('/', mediaRoutes(deps))
  app.route('/', flowsRoutes(deps))
  // T38: antes dos agentes, que leem deps.aiProviderKeys (passa a ser BYOK: empresa + plataforma).
  aiKeysDefaults(deps)
  app.route('/', aiAgentsRoutes(deps))
  app.route('/', aiVoicesRoutes(deps))
  app.route('/', aiKnowledgeRoutes(deps))
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
  app.route('/', massDispatchRoutes(deps))
  app.route('/', exportsRoutes(deps))
  app.route('/', aiKeysRoutes(deps))
  app.route('/', connectionFlowConfigsRoutes(deps))
  app.route('/', schedulesRoutes(deps))
  app.route('/', aiUsageRoutes(deps))
  app.route('/', platformAiRoutes(deps))
  app.route('/', metaOAuthRoutes(deps))
  app.route('/', metaProfilesRoutes(deps))
  app.route('/', metaStructureRoutes(deps))
  app.route('/', metaPixelsRoutes(deps))
  app.route('/', metaEntitiesRoutes(deps))
  app.route('/', paymentIntegrationsRoutes(deps))
  app.route('/', inboundWebhooksRoutes(deps))
  app.route('/', hooksRoutes(deps))
  app.route('/', dashboardRoutes(deps))
}
