// Grupo "Vendas" da T114: editor do bloco Venda aprovada (`register_approved_sale`; a T57 não registra `approved_sale`).
// Carregado pelo glob de `node-editors/registry.ts` (só o tipo vem de lá — lição do TDZ, T56).
import type { NodeEditor } from '../registry'
import { ApprovedSaleEditor } from './approved-sale-editor'

export const nodeEditors: Record<string, NodeEditor> = {
  approved_sale: ApprovedSaleEditor,
}
