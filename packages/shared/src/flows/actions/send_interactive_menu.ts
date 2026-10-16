import { z } from 'zod'
import { checkMenu, menuConfigShape } from './menu-options'

export const sendInteractiveMenuConfig = z.object(menuConfigShape).superRefine(checkMenu)
