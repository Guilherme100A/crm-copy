// Emojis e figurinhas do compositor (spec 03 F37; AC-T85-02).
import { Popover } from '@base-ui/react/popover'
import { useQuery } from '@tanstack/react-query'
import { Smile, Sticker } from 'lucide-react'
import { useState } from 'react'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { stickersQuery, type StickerDto } from './api'

export const EMOJIS = [
  '😀', '😂', '😊', '😍', '😘', '😉', '😎', '🤩', '🙂', '🤔', '😅', '😢', '😭', '😡', '🙏', '👍',
  '👎', '👏', '🙌', '💪', '👋', '🤝', '✌️', '👌', '❤️', '💙', '💚', '🔥', '✨', '🎉', '✅', '❌',
  '⭐', '💯', '📦', '🛒', '💰', '📍', '📞', '⏰',
] as const

const triggerClass = 'rounded-md p-1.5 sm:p-2 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

export function EmojiPicker({ onPick, disabled }: { onPick: (emoji: string) => void; disabled?: boolean }) {
  const t = useT('chat-composer')
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger data-testid="chat-composer-emoji" aria-label={t('emoji')} disabled={disabled} className={triggerClass}>
        <Smile className="size-5" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={8} className="z-50">
          <Popover.Popup data-testid="chat-composer-emoji-picker" className="grid w-[min(18rem,calc(100vw-2rem))] grid-cols-8 gap-0.5 rounded-lg border bg-popover p-2 shadow-lg outline-none">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                data-testid="chat-composer-emoji-option"
                data-emoji={e}
                aria-label={e}
                onClick={() => {
                  onPick(e)
                  setOpen(false)
                }}
                className="rounded-md p-1 text-xl leading-none hover:bg-accent"
              >
                {e}
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function StickerPicker({ onPick, disabled }: { onPick: (s: StickerDto) => void; disabled?: boolean }) {
  const t = useT('chat-composer')
  const [open, setOpen] = useState(false)
  const q = useQuery({ ...stickersQuery(), enabled: open })
  const items = q.data ?? []
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger data-testid="chat-composer-sticker" aria-label={t('sticker.open')} disabled={disabled} className={triggerClass}>
        <Sticker className="size-5" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={8} className="z-50">
          <Popover.Popup data-testid="chat-composer-sticker-picker" className="w-[min(20rem,calc(100vw-2rem))] rounded-lg border bg-popover p-2 shadow-lg outline-none">
            {q.isPending ? (
              <div className="grid grid-cols-4 gap-2" aria-busy="true">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="aspect-square animate-pulse rounded-md bg-muted" />
                ))}
              </div>
            ) : q.isError ? (
              <p className="p-2 text-sm text-destructive">{t('sticker.error')}</p>
            ) : items.length === 0 ? (
              <p data-testid="chat-composer-sticker-empty" className="p-2 text-sm text-muted-foreground">
                {t('sticker.empty')}
              </p>
            ) : (
              <div className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto">
                {[...items].sort((a, b) => Number(b.favorite) - Number(a.favorite)).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    data-testid={`chat-composer-sticker-${s.id}`}
                    aria-label={s.name || t('sticker.item')}
                    onClick={() => {
                      onPick(s)
                      setOpen(false)
                    }}
                    className={cn('aspect-square rounded-md p-1 hover:bg-accent', s.favorite && 'ring-1 ring-amber-400')}
                  >
                    <img src={s.url} alt="" loading="lazy" className="size-full object-contain" />
                  </button>
                ))}
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
