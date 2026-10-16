import { z } from 'zod'
import { checkMenu, menuConfigShape } from './menu-options'

// Menu legado (nó `menu`): mesma estrutura do interativo; `migrate` converte para `send_interactive_menu`.
export const sendOptionListConfig = z.object(menuConfigShape).superRefine(checkMenu)
