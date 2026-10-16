// Gateway XPag (T109). Documentação pública: https://xpag.global/docs (ver cabeçalho de ./gateway.ts e docs/integrations/xpag.md).
import { registerPaymentGateway } from '../port'
import { createXPagGateway } from './gateway'

export * from './gateway'
export * from './fake'

registerPaymentGateway('xpag', (creds, ctx) =>
  createXPagGateway({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret ?? '',
    webhookSecret: creds.webhookSecret,
    webhookUrl: creds.webhookUrl,
    ...(ctx.env.XPAG_API_URL?.trim() ? { apiUrl: ctx.env.XPAG_API_URL.trim() } : {}),
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  }),
)
