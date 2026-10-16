// Compositor do chat (T85; spec 03 F31–F42, F48–F49): texto com formatação WhatsApp (Enter envia, Shift+Enter quebra
// linha), envio otimista confirmado pelo SSE, anexos com limite por tipo, figurinhas, emojis, Pix como texto, áudio
// gravado (PTT), respostas rápidas com "/", assinatura persistida, banner de conexão desconectada e "tentar de novo".
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bold, Italic, Loader2, Mic, Paperclip, PenLine, QrCode, RotateCcw, Send, Square, Strikethrough, Trash2, WifiOff, X, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import type { ChatSlotProps } from '@/features/chat/slots'
import { FormattedText } from '@/features/chat-thread/message-bubble'
import { clearReplyTarget, useReplyTarget } from '@/features/chat-thread/reply-store'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { profileQuery } from '@/lib/session'
import { readStorage, writeStorage } from '@/lib/storage'
import { cn } from '@/lib/utils'
import { composerApi, confirmTemp, connectionStatusQuery, dropTemp, isBlockedStatus, quickRepliesQuery, showTemp, tempMessage, type SendPayload } from './api'
import { PixDialog, pixPreview } from './pix-dialog'
import { EmojiPicker, StickerPicker } from './pickers'
import { useRecorder } from './recorder'
import { ACCEPT_ATTRIBUTE, checkFile, formatMb, hasFormatting, insertAt, replaceSlash, signatureKey, slashQuery, wrapSelection, type FormatKind, type MediaKind } from './rules'

const MAX_TEXT = 4096
const iconBtn = 'rounded-md p-1.5 sm:p-2 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

interface Attachment {
  file: File
  kind: MediaKind
}

/** Um envio que falhou antes de virar mensagem no servidor (rede, 5xx): o compositor oferece reenviar. */
interface Failure {
  payload: SendPayload
  attachment: Attachment | null
  message: string
}

const randomId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`)

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

export function ChatComposer({ chatId, chat }: ChatSlotProps) {
  const t = useT('chat-composer')
  const qc = useQueryClient()
  const profile = useQuery(profileQuery()).data
  const me = profile?.user ?? null
  const reply = useReplyTarget(chatId)
  const connection = useQuery(connectionStatusQuery(chat?.connection_id))
  const recorder = useRecorder()

  const [text, setText] = useState('')
  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [sessionDown, setSessionDown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pixOpen, setPixOpen] = useState(false)
  const [signature, setSignature] = useState(false)
  const [slash, setSlash] = useState<{ start: number; query: string } | null>(null)
  const [quickIndex, setQuickIndex] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Assinatura por usuário, persistida no navegador (AC-T85-04).
  useEffect(() => {
    if (me) setSignature(readStorage(signatureKey(me.id)) === '1')
  }, [me])
  const toggleSignature = () => {
    setSignature((on) => {
      writeStorage(signatureKey(me?.id), on ? '0' : '1')
      return !on
    })
  }

  const blocked = sessionDown || isBlockedStatus(connection.data)
  // A conexão voltou: tira o bloqueio causado por um envio recusado.
  useEffect(() => {
    if (connection.data && !isBlockedStatus(connection.data)) setSessionDown(false)
  }, [connection.data])

  // Auto-altura do campo (até ~6 linhas).
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  const quickTerm = useDebounced(slash?.query ?? '', 200)
  const quick = useQuery({ ...quickRepliesQuery(quickTerm), enabled: !!slash })
  const quickItems = useMemo(() => (Array.isArray(quick.data) ? quick.data : []), [quick.data])

  const updateText = (value: string, cursor: number) => {
    setText(value)
    setError(null)
    const s = slashQuery(value, cursor)
    setSlash(s)
    setQuickIndex(0)
  }

  const focusAt = (pos: number) =>
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
    })

  const applyFormat = (kind: FormatKind) => {
    const el = inputRef.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? text.length
    const r = wrapSelection(text, start, end, kind)
    setText(r.text)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(r.start, r.end)
    })
  }

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current
    const r = insertAt(text, el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length, emoji)
    setText(r.text)
    focusAt(r.cursor)
  }

  const pickQuickReply = async (id: string) => {
    if (!slash) return
    const cursor = inputRef.current?.selectionStart ?? text.length
    try {
      const rendered = await composerApi.renderQuickReply(id, chat?.contact_id ?? null)
      const r = replaceSlash(text, cursor, slash.start, rendered.text)
      setText(r.text)
      setSlash(null)
      focusAt(r.cursor)
    } catch {
      setError(t('errors.quickReply'))
    }
  }

  /** Envia com mensagem otimista; o SSE (message.created/status) confirma e atualiza os ticks. */
  const send = async (payload: SendPayload, att: Attachment | null, preview: { type: string; body: string | null }) => {
    if (blocked) return
    const clientId = randomId()
    const temp = tempMessage({ chatId, clientId, type: preview.type, body: preview.body, userId: me?.id ?? null })
    showTemp(qc, temp)
    setFailure(null)
    try {
      let final = payload
      if (att) {
        const media = await composerApi.upload(att.file, att.file.name || `arquivo.${att.kind}`)
        final = { ...payload, media_id: media.id }
      }
      const r = await composerApi.send(chatId, final, clientId)
      confirmTemp(qc, chatId, temp.id, r.message)
    } catch (err) {
      dropTemp(qc, chatId, temp.id)
      if (err instanceof HttpError && err.code === 'SESSION_NOT_CONNECTED') {
        setSessionDown(true)
        restore(payload, att)
        return
      }
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.code !== 'RATE_LIMIT') {
        // Recusado de vez (validação, permissão): devolve o conteúdo para corrigir.
        restore(payload, att)
        setError(err.message || t('errors.send'))
        return
      }
      setFailure({ payload, attachment: att, message: err instanceof HttpError && err.message ? err.message : t('errors.send') })
    }
  }

  const restore = (payload: SendPayload, att: Attachment | null) => {
    if (att) setAttachment(att)
    const back = payload.type === 'text' ? payload.text : payload.caption
    if (back) setText(back)
  }

  const displayBody = (body: string | null) => (body && signature && me ? `*${me.name}*:\n${body}` : body)

  const submit = async () => {
    if (busy || blocked) return
    const body = text.trim()
    if (!body && !attachment) return
    const quoted = reply?.id && !reply.id.startsWith('tmp-') ? reply.id : null
    setBusy(true)
    try {
      if (attachment) {
        const att = attachment
        setAttachment(null)
        setText('')
        clearReplyTarget(chatId)
        await send({ type: att.kind, ...(body ? { caption: text } : {}), quoted_id: quoted, signature }, att, { type: att.kind, body: displayBody(body ? text : null) })
      } else {
        const value = text
        setText('')
        setSlash(null)
        clearReplyTarget(chatId)
        await send({ type: 'text', text: value, quoted_id: quoted, signature }, null, { type: 'text', body: displayBody(value) })
      }
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && quickItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        return setQuickIndex((i) => (i + 1) % quickItems.length)
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        return setQuickIndex((i) => (i - 1 + quickItems.length) % quickItems.length)
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        return void pickQuickReply(quickItems[quickIndex]!.id)
      }
    }
    if (slash && e.key === 'Escape') {
      e.preventDefault()
      return setSlash(null)
    }
    // Enter envia; Shift+Enter quebra linha (AC-T85-01). Composição de IME não envia.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const check = checkFile(file)
    if (!check.ok) {
      setAttachment(null)
      setError(check.reason === 'unsupported' ? t('errors.unsupported') : t('errors.tooLarge', { limit: formatMb(check.limit!), kind: t(`kinds.${check.kind}`) }))
      return
    }
    setError(null)
    setAttachment({ file, kind: check.kind })
  }

  const sendSticker = (s: { media_id: string }) => void send({ type: 'sticker', media_id: s.media_id, quoted_id: null }, null, { type: 'sticker', body: null })

  const sendPix = (p: { key: string; name: string | null; amount_cents: number | null }) =>
    void send({ type: 'pix', pix: { key: p.key, name: p.name, amount_cents: p.amount_cents }, quoted_id: null }, null, { type: 'text', body: pixPreview(p) })

  const startRecording = async () => {
    setError(null)
    try {
      await recorder.start()
    } catch {
      setError(t('errors.microphone'))
    }
  }

  const finishRecording = async (cancel: boolean) => {
    const rec = await recorder.stop(cancel)
    if (!rec) return
    const ext = rec.mime.includes('ogg') ? 'ogg' : rec.mime.includes('mp4') ? 'm4a' : 'webm'
    const file = new File([rec.blob], `voz.${ext}`, { type: rec.mime.split(';')[0] })
    await send({ type: 'audio', ptt: true, quoted_id: null }, { file, kind: 'audio' }, { type: 'audio', body: null })
  }

  const retryFailure = () => {
    const f = failure
    if (!f) return
    setFailure(null)
    const body = f.payload.type === 'text' ? (f.payload.text ?? null) : (f.payload.caption ?? null)
    void send(f.payload, f.attachment, { type: f.payload.type === 'pix' ? 'text' : f.payload.type, body })
  }

  const recording = recorder.state === 'recording'
  const canSend = !blocked && !busy && (!!text.trim() || !!attachment)

  return (
    <div data-testid="chat-composer" className="relative flex flex-col gap-2 p-2">
      {blocked ? (
        <div data-testid="chat-composer-disconnected" role="alert" className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <WifiOff className="size-4 shrink-0" aria-hidden />
          <span>{t('disconnected')}</span>
        </div>
      ) : null}

      {failure ? (
        <div data-testid="chat-composer-failure" role="alert" className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="min-w-0 flex-1 truncate">{failure.message}</span>
          <button type="button" data-testid="chat-composer-retry" onClick={retryFailure} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-destructive/10">
            <RotateCcw className="size-3.5" aria-hidden /> {t('retry')}
          </button>
          <button type="button" aria-label={t('dismiss')} onClick={() => setFailure(null)} className="rounded p-1 hover:bg-destructive/10">
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      {error ? (
        <p data-testid="chat-composer-error" role="alert" className="px-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {attachment ? (
        <div data-testid="chat-composer-attachment" data-kind={attachment.kind} className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-1.5 text-sm">
          <Paperclip className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{attachment.file.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{t(`kinds.${attachment.kind}`)}</span>
          <button type="button" data-testid="chat-composer-attachment-remove" aria-label={t('attachment.remove')} onClick={() => setAttachment(null)} className="rounded p-1 hover:bg-accent">
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ) : null}

      {text && hasFormatting(text) ? (
        <div data-testid="chat-composer-preview" className="max-h-24 overflow-y-auto rounded-md bg-muted/50 px-3 py-1.5 text-sm break-words whitespace-pre-wrap">
          <span className="mr-1 text-[11px] uppercase text-muted-foreground">{t('preview')}</span>
          <FormattedText text={text} />
        </div>
      ) : null}

      {slash ? (
        <div data-testid="chat-composer-quick-replies" role="listbox" aria-label={t('quick.title')} className="absolute right-2 bottom-full left-2 z-20 mb-1 max-h-60 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg">
          {quick.isPending ? (
            <p className="p-2 text-sm text-muted-foreground">{t('quick.loading')}</p>
          ) : quick.data === 'forbidden' ? (
            <p className="p-2 text-sm text-muted-foreground">{t('quick.forbidden')}</p>
          ) : quickItems.length === 0 ? (
            <p data-testid="chat-composer-quick-replies-empty" className="p-2 text-sm text-muted-foreground">
              {t('quick.empty')}
            </p>
          ) : (
            quickItems.map((q, i) => (
              <button
                key={q.id}
                type="button"
                role="option"
                aria-selected={i === quickIndex}
                data-testid={`chat-composer-quick-reply-${q.id}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void pickQuickReply(q.id)}
                className={cn('flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent', i === quickIndex && 'bg-accent')}
              >
                <span className="font-medium">/{q.shortcut}</span>
                <span className="line-clamp-1 text-xs text-muted-foreground">{q.preview}</span>
              </button>
            ))
          )}
        </div>
      ) : null}

      {recording ? (
        <div data-testid="chat-composer-recording" className="flex items-center gap-3 rounded-md border px-3 py-2">
          <span className="size-2.5 animate-pulse rounded-full bg-destructive" aria-hidden />
          <span className="flex-1 text-sm tabular-nums">
            {t('recording')} {Math.floor(recorder.seconds / 60)}:{String(recorder.seconds % 60).padStart(2, '0')}
          </span>
          <button type="button" data-testid="chat-composer-record-cancel" onClick={() => void finishRecording(true)} aria-label={t('record.cancel')} className={iconBtn}>
            <Trash2 className="size-5" aria-hidden />
          </button>
          <button
            type="button"
            data-testid="chat-composer-record-stop"
            onClick={() => void finishRecording(false)}
            aria-label={t('record.stop')}
            className="rounded-full bg-primary p-2 text-primary-foreground hover:bg-primary/90"
          >
            <Square className="size-4" aria-hidden />
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-1 sm:flex-nowrap">
          <div className="order-last flex w-full shrink-0 items-center sm:order-none sm:w-auto">
            <button type="button" data-testid="chat-composer-attach" aria-label={t('attach')} disabled={blocked} onClick={() => fileRef.current?.click()} className={iconBtn}>
              <Paperclip className="size-5" aria-hidden />
            </button>
            <input ref={fileRef} type="file" data-testid="chat-composer-file" accept={ACCEPT_ATTRIBUTE} onChange={onFile} className="hidden" />
            <EmojiPicker onPick={insertEmoji} disabled={blocked} />
            <StickerPicker onPick={sendSticker} disabled={blocked} />
            <button type="button" data-testid="chat-composer-pix" aria-label={t('pix.open')} disabled={blocked} onClick={() => setPixOpen(true)} className={iconBtn}>
              <QrCode className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              data-testid="chat-composer-quick"
              aria-label={t('quick.open')}
              disabled={blocked}
              onClick={() => updateText(text && !text.endsWith(' ') ? `${text} /` : `${text}/`, (text && !text.endsWith(' ') ? text.length + 2 : text.length + 1))}
              className={iconBtn}
            >
              <Zap className="size-5" aria-hidden />
            </button>
          </div>
          <div className="flex min-w-0 flex-1 flex-col rounded-lg border bg-background focus-within:ring-2 focus-within:ring-ring">
            <textarea
              ref={inputRef}
              data-testid="chat-composer-input"
              aria-label={t('input')}
              placeholder={blocked ? t('blockedPlaceholder') : t('placeholder')}
              rows={1}
              maxLength={MAX_TEXT}
              value={text}
              disabled={blocked}
              onChange={(e) => updateText(e.target.value, e.target.selectionStart ?? e.target.value.length)}
              onKeyDown={onKeyDown}
              onBlur={() => setTimeout(() => setSlash(null), 150)}
              className="max-h-40 min-h-10 w-full resize-none bg-transparent px-3 py-2 text-sm outline-none"
            />
            <div className="flex items-center gap-0.5 border-t px-1 py-0.5">
              <button type="button" data-testid="chat-composer-format-bold" aria-label={t('format.bold')} onClick={() => applyFormat('bold')} className="rounded p-1 text-muted-foreground hover:bg-accent">
                <Bold className="size-4" aria-hidden />
              </button>
              <button type="button" data-testid="chat-composer-format-italic" aria-label={t('format.italic')} onClick={() => applyFormat('italic')} className="rounded p-1 text-muted-foreground hover:bg-accent">
                <Italic className="size-4" aria-hidden />
              </button>
              <button type="button" data-testid="chat-composer-format-strike" aria-label={t('format.strike')} onClick={() => applyFormat('strike')} className="rounded p-1 text-muted-foreground hover:bg-accent">
                <Strikethrough className="size-4" aria-hidden />
              </button>
              <button
                type="button"
                data-testid="chat-composer-signature"
                aria-pressed={signature}
                aria-label={t('signature')}
                title={t('signature')}
                onClick={toggleSignature}
                className={cn('ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-xs', signature ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent')}
              >
                <PenLine className="size-3.5" aria-hidden /> <span className="hidden sm:inline">{t('signature')}</span>
              </button>
            </div>
          </div>
          {canSend ? (
            <button type="button" data-testid="chat-composer-send" aria-label={t('send')} onClick={() => void submit()} className="shrink-0 rounded-full bg-primary p-2.5 text-primary-foreground hover:bg-primary/90">
              {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Send className="size-5" aria-hidden />}
            </button>
          ) : text.trim() || attachment ? (
            <button type="button" data-testid="chat-composer-send" aria-label={t('send')} disabled className="shrink-0 rounded-full bg-primary p-2.5 text-primary-foreground opacity-50">
              <Send className="size-5" aria-hidden />
            </button>
          ) : (
            <button type="button" data-testid="chat-composer-record" aria-label={t('record.start')} disabled={blocked} onClick={() => void startRecording()} className="shrink-0 rounded-full bg-primary p-2.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              <Mic className="size-5" aria-hidden />
            </button>
          )}
        </div>
      )}

      <PixDialog open={pixOpen} onOpenChange={setPixOpen} onSend={sendPix} />
    </div>
  )
}
