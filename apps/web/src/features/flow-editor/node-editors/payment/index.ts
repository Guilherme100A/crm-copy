// Grupo "Pagamento" da T114: editor do bloco Pagamento (`create_payment_charge`, gateway XPag). Carregado pelo glob de
// `node-editors/registry.ts` (só o tipo vem de lá — lição do TDZ, T56).
import type { NodeEditor } from '../registry'
import { PaymentEditor } from './payment-editor'

export const nodeEditors: Record<string, NodeEditor> = {
  payment: PaymentEditor,
}
