// Grupo "externos" da T57 (T42/T104): Integração HTTP, Bloco de IA e Pixel. O bloco Pagamento (`payment`) é da T114.
// Carregado pelo glob de `node-editors/registry.ts` (só o tipo vem de lá).
import type { NodeEditor } from '../registry'
import { AiEditor } from './ai-editor'
import { HttpEditor } from './http-editor'
import { PixelEditor } from './pixel-editor'

export const nodeEditors: Record<string, NodeEditor> = {
  integration: HttpEditor,
  ai: AiEditor,
  pixel: PixelEditor,
}
