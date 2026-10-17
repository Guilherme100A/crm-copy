// Grupo "mensagem" da T56 (T51): Mensagem, Pix e Notificação. Carregado pelo glob de `node-editors/registry.ts`.
import type { NodeEditor } from '../registry'
import { MessageEditor } from './message-editor'
import { NotificationEditor } from './notification-editor'
import { PixEditor } from './pix-editor'

export const nodeEditors: Record<string, NodeEditor> = {
  message: MessageEditor,
  pix: PixEditor,
  notification: NotificationEditor,
}
