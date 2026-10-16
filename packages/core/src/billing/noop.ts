// Provedor padrão: nenhuma cobrança configurada. Toda operação falha com `BillingNotConfiguredError`.
import {
  BillingNotConfiguredError,
  type BillingEvent,
  type BillingProvider,
  type BillingWebhook,
  type CheckoutRequest,
  type CheckoutSession,
} from './port'

export class NoopBillingProvider implements BillingProvider {
  readonly id = 'noop'

  async createCheckout(_request: CheckoutRequest): Promise<CheckoutSession> {
    throw new BillingNotConfiguredError()
  }

  async parseWebhook(_webhook: BillingWebhook): Promise<BillingEvent | null> {
    throw new BillingNotConfiguredError()
  }
}
