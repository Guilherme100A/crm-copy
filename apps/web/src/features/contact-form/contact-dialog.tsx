// Fluxo "Novo contato" (05 §2, `KTt`) e edição: passo 1 busca contatos existentes (≥ 2 caracteres, debounce 450 ms,
// 15 resultados) → editar o existente ou "Criar novo contato"; passo 2 o formulário. Na criação pelo fluxo há
// "Salvar contato" e "Salvar e abrir conversa" (leva ao chat). A edição direta (linha da lista) abre no passo 2.
import { Dialog } from '@base-ui/react/dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Loader2, Pencil, Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CONTACTS_KEY } from '@/features/contacts/api'
import { Avatar } from '@/features/contacts/contact-list'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { contactDetailQuery, contactSearchQuery } from './api'
import { ContactForm } from './contact-form'
import {
  DUPLICATE_SEARCH_DEBOUNCE_MS,
  duplicateSearchTerm,
  formFromContact,
  formFromTerm,
  type ContactDetail,
  type ContactFormValues,
} from './form'

const popupClass =
  'fixed top-1/2 left-1/2 z-[70] flex max-h-[90dvh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none'

export type ContactDialogTarget = { kind: 'new' } | { kind: 'edit'; id: string } | null

type Step =
  | { kind: 'search' }
  | { kind: 'create'; initial: ContactFormValues }
  | { kind: 'edit'; id: string; fromSearch: boolean }

/** Texto digitado → termo efetivo depois do debounce. */
function useDebounced(text: string, ms: number): string {
  const [value, setValue] = useState(text)
  useEffect(() => {
    const timer = setTimeout(() => setValue(text), ms)
    return () => clearTimeout(timer)
  }, [text, ms])
  return value
}

export function ContactDialog({
  target,
  onClose,
  onOpenChat,
}: {
  target: ContactDialogTarget
  onClose: () => void
  onOpenChat: (contactId: string) => Promise<unknown>
}) {
  const t = useT('contact-form')
  const qc = useQueryClient()
  // O pai monta o diálogo com `key` por alvo: cada abertura começa do passo certo (novo → busca; editar → formulário).
  const [step, setStep] = useState<Step>(() =>
    target?.kind === 'edit' ? { kind: 'edit', id: target.id, fromSearch: false } : { kind: 'search' },
  )
  const [text, setText] = useState('')

  const saved = async (contact: ContactDetail, openChat: boolean) => {
    void qc.invalidateQueries({ queryKey: [...CONTACTS_KEY, 'list'] })
    void qc.invalidateQueries({ queryKey: [...CONTACTS_KEY, 'form-search'] })
    qc.setQueryData(contactDetailQuery(contact.id).queryKey, contact)
    notify('contact-form-saved', step.kind === 'edit' ? t('form.updated') : t('form.created'))
    onClose()
    if (openChat) await onOpenChat(contact.id)
  }

  const title =
    step.kind === 'search' ? t('search.title') : step.kind === 'create' ? t('form.createTitle') : t('form.editTitle')

  return (
    <Dialog.Root open={!!target} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup data-testid="contact-dialog" data-step={step.kind} className={popupClass}>
          <div className="flex items-center gap-2">
            {step.kind !== 'search' && target?.kind === 'new' ? (
              <Button
                variant="ghost"
                size="icon"
                className="-ml-2 size-8"
                data-testid="contact-dialog-back"
                aria-label={t('common.back')}
                onClick={() => setStep({ kind: 'search' })}
              >
                <ArrowLeft aria-hidden />
              </Button>
            ) : null}
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          </div>
          {step.kind === 'search' ? (
            <SearchStep
              text={text}
              onText={setText}
              onEdit={(id) => setStep({ kind: 'edit', id, fromSearch: true })}
              onCreate={() => setStep({ kind: 'create', initial: formFromTerm(text) })}
              onCancel={onClose}
            />
          ) : step.kind === 'create' ? (
            <ContactForm
              key="create"
              initial={step.initial}
              mode="create"
              dual
              onSaved={saved}
              onCancel={onClose}
              onEditExisting={(id) => setStep({ kind: 'edit', id, fromSearch: true })}
            />
          ) : (
            <EditStep id={step.id} onSaved={saved} onCancel={onClose} />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function EditStep({
  id,
  onSaved,
  onCancel,
}: {
  id: string
  onSaved: (c: ContactDetail, openChat: boolean) => Promise<void>
  onCancel: () => void
}) {
  const t = useT('contact-form')
  const q = useQuery(contactDetailQuery(id))
  if (q.isPending)
    return (
      <div data-testid="contact-form-loading" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> {t('form.loading')}
      </div>
    )
  if (q.isError)
    return (
      <div data-testid="contact-form-load-error" className="flex flex-wrap items-center gap-3 text-sm">
        <span className="flex-1">{t('form.loadError')}</span>
        <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    )
  return (
    <ContactForm
      key={id}
      initial={formFromContact(q.data)}
      mode="edit"
      contactId={id}
      dual={false}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  )
}

function SearchStep({
  text,
  onText,
  onEdit,
  onCreate,
  onCancel,
}: {
  text: string
  onText: (s: string) => void
  onEdit: (id: string) => void
  onCreate: () => void
  onCancel: () => void
}) {
  const t = useT('contact-form')
  const term = duplicateSearchTerm(useDebounced(text, DUPLICATE_SEARCH_DEBOUNCE_MS))
  const typed = duplicateSearchTerm(text)
  const q = useQuery(contactSearchQuery(term))
  const waiting = !!typed && (typed !== term || q.isFetching)
  const items = term && typed === term ? (q.data ?? []) : []

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <label className="relative block">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          data-testid="contact-search"
          type="text"
          autoFocus
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          className="h-9 w-full rounded-md border bg-background pr-9 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {waiting ? (
          <Loader2
            data-testid="contact-search-loading"
            className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden
          />
        ) : null}
      </label>
      <div
        data-testid="contact-search-results"
        data-state={!typed ? 'hint' : waiting ? 'loading' : q.isError ? 'error' : items.length ? 'results' : 'empty'}
        className="min-h-24"
      >
        {!typed ? (
          <p className="text-sm text-muted-foreground">{t('search.hint')}</p>
        ) : waiting && !items.length ? (
          <p className="text-sm text-muted-foreground">{t('search.loading')}</p>
        ) : q.isError ? (
          <p data-testid="contact-search-error" className="text-sm text-destructive">
            {t('search.error')}
          </p>
        ) : items.length === 0 ? (
          <p data-testid="contact-search-empty" className="text-sm text-muted-foreground">
            {t('search.empty')}
          </p>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted-foreground">{t('search.found', { n: items.length })}</p>
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {items.map((c) => (
                <li
                  key={c.id}
                  data-testid={`contact-search-item-${c.id}`}
                  className="flex min-w-0 items-center gap-3 rounded-lg border p-2"
                >
                  <Avatar name={c.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.name}</span>
                    <span className="block truncate text-xs text-muted-foreground tabular-nums">
                      {[c.phone_e164 ?? c.wa_lid, c.email].filter(Boolean).join(' · ') || t('search.noPhone')}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid={`contact-search-edit-${c.id}`}
                    onClick={() => onEdit(c.id)}
                  >
                    <Pencil aria-hidden /> <span className="max-sm:sr-only">{t('search.edit')}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" data-testid="contact-search-cancel" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button data-testid="contact-search-create" onClick={onCreate}>
          <Plus aria-hidden /> {t('search.create')}
        </Button>
      </div>
    </div>
  )
}
