import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Junta classes do Tailwind resolvendo conflitos (padrão do shadcn). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Nome exibido do produto (SPEC 1.4 nº 9). */
export const APP_NAME: string = typeof __APP_NAME__ === 'string' ? __APP_NAME__ : 'CRM'
