// Grupo "interativos" da T56 (T62): menus, carrossel e Aguardar resposta. Carregado pelo glob de `node-editors/registry.ts`.
import type { NodeEditor } from '../registry'
import { CarouselEditor } from './carousel-editor'
import { MenuEditor } from './menu-editor'
import { WaitResponseEditor } from './wait-response-editor'

export const nodeEditors: Record<string, NodeEditor> = {
  interactive_menu: MenuEditor,
  menu: MenuEditor,
  carousel: CarouselEditor,
  wait_response: WaitResponseEditor,
}
