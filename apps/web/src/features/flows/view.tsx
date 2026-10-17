// Search params de `/flows` (contrato com o Tester) e peças visuais pequenas da lista: badge de status e cor de pasta.
import { z } from 'zod'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import type { FlowStatus, FolderColor } from './api'
import { ROOT, STATUS_FILTERS } from './model'

/**
 * `?folder=<uuid>|root` (ausente = raiz "Sem pasta"), `?flow_status=all|active|paused|draft|archived|folders` (não `status`: o
 * tipo do search param é unido entre as rotas e `/chats` já usa `status` com outros valores),
 * `?q=` (busca em todas as pastas) e `?view=cards|table` (o mobile sempre mostra cartões). Valor inválido é ignorado.
 */
export const flowsSearchSchema = z.object({
  folder: z
    .union([z.uuid(), z.literal(ROOT)])
    .optional()
    .catch(undefined),
  flow_status: z.enum(STATUS_FILTERS).optional().catch(undefined),
  q: z.string().max(200).optional().catch(undefined),
  view: z.enum(['cards', 'table']).optional().catch(undefined),
})
export type FlowsSearch = z.infer<typeof flowsSearchSchema>

const STATUS_CLASS: Record<FlowStatus, string> = {
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  draft: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  archived: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400',
}

export function StatusBadge({ id, status }: { id: string; status: FlowStatus }) {
  const t = useT('flows')
  return (
    <span
      data-testid={`flows-item-status-${id}`}
      data-status={status}
      className={cn(
        'inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase',
        STATUS_CLASS[status],
      )}
    >
      {t(`status.${status}`)}
    </span>
  )
}

const FOLDER_CLASS: Record<FolderColor, string> = {
  blue: 'bg-blue-500',
  green: 'bg-emerald-500',
  purple: 'bg-violet-500',
  orange: 'bg-orange-500',
  red: 'bg-red-500',
  yellow: 'bg-yellow-500',
  gray: 'bg-zinc-500',
}

export const folderColorClass = (c: FolderColor) => FOLDER_CLASS[c] ?? FOLDER_CLASS.gray
