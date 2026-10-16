// `/settings/inbound-webhooks/$webhookId/edit` (09 §2): abas Configuração e Histórico (aba na URL).
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { webhookQuery } from './api'
import { ConfigTab } from './config-tab'
import { HistoryTab } from './history-tab'

export const editSearchSchema = z.object({ tab: z.enum(['config', 'history']).optional().catch(undefined) })
export type EditSearch = z.infer<typeof editSearchSchema>

export function WebhookEditPage({ webhookId, search, onSearch }: { webhookId: string; search: EditSearch; onSearch: (s: EditSearch) => void }) {
  const t = useT('settings-webhooks')
  const q = useQuery(webhookQuery(webhookId))
  const tab = search.tab ?? 'config'
  return (
    <section data-testid="page-inbound-webhooks-edit" className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4">
      <header className="flex min-w-0 items-center gap-2">
        <h1 className="min-w-0 truncate text-2xl font-semibold">{q.data?.name ?? t('form.editTitle')}</h1>
      </header>
      <div role="tablist" className="flex gap-1 border-b">
        {(['config', 'history'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-testid={`webhook-tab-${id}`}
            aria-selected={tab === id}
            onClick={() => onSearch({ tab: id === 'config' ? undefined : id })}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === id ? 'border-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t(`tabs.${id}`)}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : q.isError ? (
        <p data-testid="webhook-load-error" className="text-sm text-destructive">
          {t('common.error')}
        </p>
      ) : tab === 'config' ? (
        <ConfigTab key={q.data.id} webhook={q.data} />
      ) : (
        <HistoryTab webhook={q.data} />
      )}
    </section>
  )
}
