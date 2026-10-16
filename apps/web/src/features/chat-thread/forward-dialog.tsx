// Encaminhar mensagem (spec 03 F42): escolhe o chat de destino (busca por nome/telefone, só no escopo do atendente).
import { Dialog } from '@base-ui/react/dialog'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { api } from '@/lib/http'
import { cn } from '@/lib/utils'

interface ChatOption {
  id: string
  contact: { name: string; phone_e164: string | null }
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

export function ForwardDialog({ open, onOpenChange, currentChatId, onForward }: { open: boolean; onOpenChange: (o: boolean) => void; currentChatId: string; onForward: (chatId: string) => Promise<void> }) {
  const t = useT('chat-thread')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const term = useDebounced(search.trim(), 300)
  const q = useQuery({
    queryKey: ['chat-thread', 'forward-targets', term],
    queryFn: () => api.get<{ items: ChatOption[] }>('/api/chats', { query: { search: term || undefined, limit: 20 } }),
    enabled: open,
    staleTime: 10_000,
  })
  const items = (q.data?.items ?? []).filter((c) => c.id !== currentChatId)

  useEffect(() => {
    if (open) {
      setSearch('')
      setSelected(null)
      setError(null)
    }
  }, [open])

  const submit = async () => {
    if (!selected || pending) return
    setPending(true)
    setError(null)
    try {
      await onForward(selected)
      onOpenChange(false)
    } catch {
      setError(t('errors.forward'))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Popup
          data-testid="chat-forward-modal"
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[min(90dvh,36rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{t('forward.title')}</Dialog.Title>
          <input
            type="search"
            data-testid="chat-forward-search"
            aria-label={t('forward.search')}
            placeholder={t('forward.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          />
          <div className="min-h-24 flex-1 overflow-y-auto" role="listbox" aria-label={t('forward.title')}>
            {q.isPending ? (
              <div className="flex flex-col gap-1" aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">{t('forward.empty')}</p>
            ) : (
              items.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={selected === c.id}
                  data-testid={`chat-forward-chat-${c.id}`}
                  onClick={() => setSelected(c.id)}
                  className={cn('flex w-full flex-col rounded-md px-3 py-2 text-left text-sm hover:bg-accent', selected === c.id && 'bg-accent ring-1 ring-primary')}
                >
                  <span className="truncate font-medium">{c.contact.name || c.contact.phone_e164}</span>
                  {c.contact.name && c.contact.phone_e164 ? <span className="truncate text-xs text-muted-foreground">{c.contact.phone_e164}</span> : null}
                </button>
              ))
            )}
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button data-testid="chat-forward-submit" disabled={!selected || pending} onClick={() => void submit()}>
              {t('forward.submit')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
