// Pontos de entrada do formulário na página de contatos (T77 só importa): botão "Novo contato" (`contacts.edit`) e as
// ações por linha "Abrir chat" (`chat.view`) e "Editar" (`contacts.edit`), com os diálogos montados uma vez.
import { useQuery } from '@tanstack/react-query'
import { MessageCircle, Pencil, UserPlus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { ContactDto } from '@/features/contacts/api'
import { useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { ContactDialog, type ContactDialogTarget } from './contact-dialog'
import { useOpenChat } from './open-chat'

export function useContactActions(): {
  newButton: ReactNode
  rowActions: ((c: ContactDto) => ReactNode) | undefined
  dialogs: ReactNode
} {
  const t = useT('contact-form')
  const profile = useQuery(profileQuery()).data
  const session = profile ? sessionFrom(profile) : null
  const canEdit = !!session && hasAny(session, ['contacts.edit'])
  const canChat = !!session && hasAny(session, ['chat.view'])
  const [target, setTarget] = useState<ContactDialogTarget>(null)
  const chat = useOpenChat()

  const newButton = canEdit ? (
    <Button size="sm" data-testid="contacts-new" onClick={() => setTarget({ kind: 'new' })}>
      <UserPlus aria-hidden /> {t('entry.new')}
    </Button>
  ) : null

  const rowActions =
    canEdit || canChat
      ? (c: ContactDto) => (
          <span className="flex items-center justify-end gap-1">
            {canChat ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                data-testid={`contacts-row-open-chat-${c.id}`}
                aria-label={t('entry.openChat', { name: c.name })}
                title={t('entry.openChatShort')}
                disabled={chat.pending}
                onClick={() => void chat.open(c.id)}
              >
                <MessageCircle aria-hidden />
              </Button>
            ) : null}
            {canEdit ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                data-testid={`contacts-row-edit-${c.id}`}
                aria-label={t('entry.edit', { name: c.name })}
                title={t('entry.editShort')}
                onClick={() => setTarget({ kind: 'edit', id: c.id })}
              >
                <Pencil aria-hidden />
              </Button>
            ) : null}
          </span>
        )
      : undefined

  const key = target ? (target.kind === 'new' ? 'new' : `edit:${target.id}`) : 'closed'
  const dialogs = (
    <>
      {target ? (
        <ContactDialog key={key} target={target} onClose={() => setTarget(null)} onOpenChat={chat.open} />
      ) : null}
      {chat.dialog}
    </>
  )

  return { newButton, rowActions, dialogs }
}
