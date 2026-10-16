// Uma mensagem da conversa (T75; spec 03 F25–F30, F43–F47): conteúdo por tipo, remetente (contato, atendente, IA,
// fluxo, sistema), ticks de status, "Tentar novamente", reações, citação e o menu de ações.
import { Menu } from '@base-ui/react/menu'
import { AlertTriangle, Bot, Check, CheckCheck, Clock, Contact, Copy, Download, Eye, FileText, Forward, ImageOff, MapPin, MoreVertical, Reply, SmilePlus, Trash2, Workflow, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useI18n, useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { mediaUrl, type MessageDto } from './api'
import { formatWhatsApp, groupReactions, hasMedia, isPtt, isViewOnce, mediaFileName, tickOf, type TickKind } from './timeline'

export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '👏', '🔥'] as const

export function FormattedText({ text }: { text: string }) {
  return (
    <>
      {formatWhatsApp(text).map((t, i) => (
        <span key={i} className={cn(t.bold && 'font-semibold', t.italic && 'italic', t.strike && 'line-through', t.mono && 'rounded bg-black/5 px-1 font-mono text-[0.9em] dark:bg-white/10')}>
          {t.text}
        </span>
      ))}
    </>
  )
}

function Tick({ id, kind }: { id: string; kind: TickKind }) {
  const t = useT('chat-thread')
  if (kind === 'none') return null
  const Icon = kind === 'pending' ? Clock : kind === 'sent' ? Check : kind === 'delivered' || kind === 'read' ? CheckCheck : kind === 'failed' ? AlertTriangle : X
  return (
    <span data-testid={`chat-message-status-${id}`} data-status={kind} title={t(`status.${kind}`)} aria-label={t(`status.${kind}`)} className="inline-flex">
      <Icon className={cn('size-3.5', kind === 'read' && 'text-sky-500', kind === 'failed' && 'text-destructive')} aria-hidden />
    </span>
  )
}

/** Imagem com fallback (mídia indisponível ou corrompida): o `<img>` continua no DOM, escondido. */
function ImageWithFallback({ testId, src, alt, className, label }: { testId: string; src: string; alt: string; className: string; label: string }) {
  const [broken, setBroken] = useState(false)
  return (
    <>
      <img data-testid={testId} src={src} alt={alt} loading="lazy" onError={() => setBroken(true)} className={cn(className, broken && 'hidden')} />
      {broken ? (
        <span data-testid={`${testId}-unavailable`} className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs opacity-80">
          <ImageOff className="size-4" aria-hidden /> {label}
        </span>
      ) : null}
    </>
  )
}

function MediaContent({ m, chatId }: { m: MessageDto; chatId: string }) {
  const t = useT('chat-thread')
  const src = mediaUrl(chatId, m.id)
  switch (m.type) {
    case 'image':
      return (
        <a href={src} target="_blank" rel="noreferrer" className="block">
          <ImageWithFallback testId={`chat-message-image-${m.id}`} src={src} alt={m.body || t('types.image')} className="max-h-72 w-auto max-w-full rounded-md object-contain" label={t('mediaUnavailable')} />
        </a>
      )
    case 'sticker':
      return <ImageWithFallback testId={`chat-message-sticker-${m.id}`} src={src} alt={t('types.sticker')} className="size-32 object-contain" label={t('mediaUnavailable')} />
    case 'video':
      return <video data-testid={`chat-message-video-${m.id}`} src={src} controls preload="metadata" className="max-h-72 w-full max-w-sm rounded-md bg-black" />
    case 'audio':
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <audio data-testid={`chat-message-audio-${m.id}`} src={src} controls preload="none" className="w-64 max-w-full" />
          {isPtt(m) ? <span className="text-[11px] opacity-70">{t('types.voice')}</span> : null}
        </div>
      )
    case 'document': {
      const name = mediaFileName(m) ?? t('types.document')
      return (
        <a data-testid={`chat-message-document-${m.id}`} href={mediaUrl(chatId, m.id, true)} download={name} className="flex min-w-0 items-center gap-2 rounded-md border bg-background/60 px-3 py-2 text-sm hover:bg-background">
          <FileText className="size-5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <Download className="size-4 shrink-0 opacity-70" aria-hidden />
        </a>
      )
    }
    default:
      return null
  }
}

function Content({ m, chatId }: { m: MessageDto; chatId: string }) {
  const t = useT('chat-thread')
  if (m.deleted_at)
    return (
      <p data-testid={`chat-message-deleted-${m.id}`} className="text-sm italic opacity-70">
        {t('deleted')}
      </p>
    )
  const caption = m.body?.trim()
  const parts: ReactNode[] = []
  if (isViewOnce(m))
    parts.push(
      <span key="vo" data-testid={`chat-message-view-once-${m.id}`} className="inline-flex items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-[11px] font-medium dark:bg-white/10">
        <Eye className="size-3" aria-hidden /> {t('viewOnce')}
      </span>,
    )
  if (hasMedia(m)) parts.push(<MediaContent key="media" m={m} chatId={chatId} />)
  if (m.type === 'location') {
    const loc = m.media?.location as { latitude?: number; longitude?: number } | undefined
    const href = typeof loc?.latitude === 'number' && typeof loc.longitude === 'number' ? `https://maps.google.com/?q=${loc.latitude},${loc.longitude}` : null
    parts.push(
      <div key="loc" data-testid={`chat-message-location-${m.id}`} className="flex items-start gap-2 text-sm">
        <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">
          {caption || t('types.location')}
          {href ? (
            <a href={href} target="_blank" rel="noreferrer" className="ml-1 underline">
              {t('openMap')}
            </a>
          ) : null}
        </span>
      </div>,
    )
  } else if (m.type === 'contact') {
    const c = m.media?.contact as { name?: string; phone?: string } | undefined
    parts.push(
      <div key="ct" data-testid={`chat-message-contact-${m.id}`} className="flex items-center gap-2 text-sm">
        <Contact className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">
          {c?.name || caption || t('types.contact')}
          {c?.phone ? <span className="block text-xs opacity-70">{c.phone}</span> : null}
        </span>
      </div>,
    )
  } else if (caption) {
    parts.push(
      <p key="text" data-testid={`chat-message-text-${m.id}`} className="text-sm break-words whitespace-pre-wrap">
        <FormattedText text={caption} />
      </p>,
    )
  } else if (m.type === 'unknown' || (!hasMedia(m) && !parts.length)) {
    parts.push(
      <p key="unk" className="text-sm italic opacity-70">
        {t('types.unknown')}
      </p>,
    )
  }
  return <div className="flex min-w-0 flex-col gap-1.5">{parts}</div>
}

export interface MessageActions {
  onReply(m: MessageDto): void
  onForward(m: MessageDto): void
  onReact(m: MessageDto, emoji: string): void
  onCopy(m: MessageDto): void
  onDelete(m: MessageDto): void
  onRetry(m: MessageDto): void
}

function SenderBadge({ m }: { m: MessageDto }) {
  const t = useT('chat-thread')
  if (m.sender_type === 'ai')
    return (
      <span data-testid={`chat-message-sender-${m.id}`} className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-700 dark:text-violet-300">
        <Bot className="size-3" aria-hidden /> {t('sender.ai')}
      </span>
    )
  if (m.sender_type === 'flow')
    return (
      <span data-testid={`chat-message-sender-${m.id}`} className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-700 dark:text-teal-300">
        <Workflow className="size-3" aria-hidden /> {t('sender.flow')}
      </span>
    )
  return null
}

function MessageMenu({ m, actions, canDelete }: { m: MessageDto; actions: MessageActions; canDelete: boolean }) {
  const t = useT('chat-thread')
  const itemClass = 'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent'
  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid={`chat-message-menu-${m.id}`}
        aria-label={t('menu.open')}
        className="rounded-md p-1 opacity-60 outline-none hover:bg-black/5 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/10"
      >
        <MoreVertical className="size-4" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup className="min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
            <div data-testid="chat-react-picker" className="flex flex-wrap items-center gap-0.5 px-1 pb-1" role="group" aria-label={t('menu.react')}>
              <SmilePlus className="mr-1 size-4 opacity-60" aria-hidden />
              {REACTION_EMOJIS.map((e) => (
                <Menu.Item key={e} data-testid="chat-react-option" data-emoji={e} aria-label={e} onClick={() => actions.onReact(m, e)} className="rounded-md p-1 text-lg leading-none outline-none data-[highlighted]:bg-accent">
                  {e}
                </Menu.Item>
              ))}
            </div>
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.Item data-testid="chat-message-action-reply" onClick={() => actions.onReply(m)} className={itemClass}>
              <Reply className="size-4" aria-hidden /> {t('menu.reply')}
            </Menu.Item>
            <Menu.Item data-testid="chat-message-action-forward" onClick={() => actions.onForward(m)} className={itemClass}>
              <Forward className="size-4" aria-hidden /> {t('menu.forward')}
            </Menu.Item>
            {m.body?.trim() ? (
              <Menu.Item data-testid="chat-message-action-copy" onClick={() => actions.onCopy(m)} className={itemClass}>
                <Copy className="size-4" aria-hidden /> {t('menu.copy')}
              </Menu.Item>
            ) : null}
            {hasMedia(m) ? (
              <Menu.Item data-testid="chat-message-action-download" render={<a href={mediaUrl(m.chat_id, m.id, true)} download />} className={itemClass}>
                <Download className="size-4" aria-hidden /> {t('menu.download')}
              </Menu.Item>
            ) : null}
            {canDelete ? (
              <Menu.Item data-testid="chat-message-action-delete" onClick={() => actions.onDelete(m)} className={cn(itemClass, 'text-destructive')}>
                <Trash2 className="size-4" aria-hidden /> {t('menu.delete')}
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

export function MessageBubble({ m, chatId, quoted, actions }: { m: MessageDto; chatId: string; quoted: MessageDto | null; actions: MessageActions }) {
  const t = useT('chat-thread')
  const { locale } = useI18n()
  const outbound = m.direction === 'outbound'
  const system = m.sender_type === 'system'
  const kind = tickOf(m)
  const reactions = groupReactions(m.reactions)
  const time = new Date(m.wa_timestamp ?? m.created_at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const common = {
    'data-testid': `chat-message-${m.id}`,
    'data-type': m.type,
    'data-direction': m.direction,
    'data-status': m.status,
    'data-sender': m.sender_type,
    ...(m.deleted_at ? { 'data-deleted': 'true' } : {}),
    ...(isViewOnce(m) ? { 'data-view-once': 'true' } : {}),
  }

  if (system)
    return (
      <div {...common} className="my-1 flex justify-center px-2">
        <div className="max-w-[85%] rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground">
          {m.body ? <FormattedText text={m.body} /> : t('types.system')}
        </div>
      </div>
    )

  const tone =
    m.sender_type === 'ai'
      ? 'bg-violet-50 border-violet-200 dark:bg-violet-950/40 dark:border-violet-900'
      : m.sender_type === 'flow'
        ? 'bg-teal-50 border-teal-200 dark:bg-teal-950/40 dark:border-teal-900'
        : outbound
          ? 'bg-primary/10 border-primary/20'
          : 'bg-card'

  return (
    <div {...common} className={cn('group flex px-2', outbound ? 'justify-end' : 'justify-start')}>
      <div className={cn('flex max-w-[85%] min-w-0 items-start gap-1 sm:max-w-[70%]', outbound && 'flex-row-reverse')}>
        <div className={cn('relative min-w-0 rounded-xl border px-3 py-2 shadow-sm', tone, outbound ? 'rounded-tr-sm' : 'rounded-tl-sm')}>
          <SenderBadge m={m} />
          {m.quoted_wa_message_id ? (
            <div data-testid={`chat-message-quote-${m.id}`} className="mb-1 border-l-2 border-primary/60 bg-black/5 py-1 pr-2 pl-2 text-xs dark:bg-white/5">
              <span className="line-clamp-2 break-words opacity-80">{quoted ? quoted.body?.trim() || t(`types.${quoted.type}`) : t('quotedUnavailable')}</span>
            </div>
          ) : null}
          <Content m={m} chatId={chatId} />
          <div className="mt-1 flex items-center justify-end gap-1 text-[11px] opacity-70">
            <time dateTime={m.created_at}>{time}</time>
            <Tick id={m.id} kind={kind} />
          </div>
          {reactions.length ? (
            <div data-testid={`chat-message-reactions-${m.id}`} className={cn('absolute -bottom-3 flex gap-0.5 rounded-full border bg-background px-1.5 py-0.5 text-xs shadow-sm', outbound ? 'right-2' : 'left-2')}>
              {reactions.map((r) => (
                <span key={r.emoji} data-emoji={r.emoji}>
                  {r.emoji}
                  {r.count > 1 ? <span className="ml-0.5 text-[10px]">{r.count}</span> : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {!m.deleted_at ? <MessageMenu m={m} actions={actions} canDelete={outbound && !!m.wa_message_id} /> : null}
      </div>
      {kind === 'failed' ? (
        <div className={cn('flex items-center', outbound ? 'order-first mr-1' : 'ml-1')}>
          <button
            type="button"
            data-testid={`chat-message-retry-${m.id}`}
            onClick={() => actions.onRetry(m)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
            title={m.error ?? undefined}
          >
            <AlertTriangle className="size-3.5" aria-hidden /> {t('retry')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function NoteBubble({ id, body, author, at }: { id: string; body: string; author: string | null; at: string }) {
  const t = useT('chat-thread')
  const { locale } = useI18n()
  return (
    <div data-testid={`chat-note-${id}`} data-note="true" className="flex justify-center px-2">
      <div className="w-full max-w-[85%] rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-amber-950 sm:max-w-[70%] dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
        <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-wide opacity-80">
          <span>{t('note.label')}</span>
          <span className="normal-case">
            {author ? `${author} · ` : ''}
            {new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <p className="text-sm break-words whitespace-pre-wrap">
          <FormattedText text={body} />
        </p>
      </div>
    </div>
  )
}
