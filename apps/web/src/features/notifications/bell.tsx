// Sino + central de notificações do shell (T84; spec 14 §Features 1–11): badge de não lidas ("9+"), popover com os
// itens da última hora, clique abre o chat (`/chats/<id>`) e preferências (14#10) com "Restaurar padrão".
// O shell importa este módulo de forma ESTÁTICA: `./realtime` registra `message.created`/`notification.created`
// antes de o SSE abrir. Sinal de som para o E2E: `data-sound-count`/`data-last-sound-volume` no botão do sino.
import { Popover } from '@base-ui/react/popover'
import { useNavigate } from '@tanstack/react-router'
import { Bell, ChevronDown, ChevronRight, MessageCircle, Megaphone } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useI18n, useT } from '@/i18n'
import type { Session } from '@/lib/session'
import { cn } from '@/lib/utils'
import { browserNotificationsSupported, requestBrowserPermission, setOpenTarget } from './effects'
import {
  badgeLabel,
  CLEANUP_INTERVAL_MS,
  itemTarget,
  itemTexts,
  ITEM_TTL_MS,
  unreadCount,
  type NotificationItem,
} from './model'
import './realtime'
import { notificationStore, useNotificationState } from './store'

function useOpenItem(onDone?: () => void) {
  const navigate = useNavigate()
  return useCallback(
    (item: NotificationItem) => {
      notificationStore.markRead(item.company_id, item.id)
      const target = itemTarget(item)
      if (target && 'internal' in target) void navigate({ to: target.internal as never })
      else if (target) globalThis.open?.(target.external, '_blank', 'noopener,noreferrer')
      onDone?.()
    },
    [navigate, onDone],
  )
}

function Toggle({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label
      htmlFor={`notifications-prefs-${id}`}
      className={cn('flex items-center justify-between gap-3 text-sm', disabled && 'opacity-60')}
    >
      <span>{label}</span>
      <input
        id={`notifications-prefs-${id}`}
        data-testid={`notifications-prefs-${id}`}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-primary"
      />
    </label>
  )
}

function Preferences() {
  const t = useT('notifications')
  const { settings } = useNotificationState()
  const [advanced, setAdvanced] = useState(false)
  const [permission, setPermission] = useState(() =>
    browserNotificationsSupported() ? Notification.permission : 'unsupported',
  )
  const off = !settings.enabled

  const setBrowser = async (on: boolean) => {
    notificationStore.updateSettings({ browserNotifications: on })
    // Gesto do usuário: único momento em que a permissão do navegador é pedida (14#6).
    if (on) setPermission(await requestBrowserPermission())
  }

  return (
    <div data-testid="notifications-prefs" className="flex flex-col gap-3 border-t pt-3">
      <Toggle
        id="browser"
        label={t('prefs.browser')}
        checked={settings.browserNotifications}
        disabled={off}
        onChange={(v) => void setBrowser(v)}
      />
      {settings.browserNotifications && permission === 'denied' ? (
        <p data-testid="notifications-prefs-browser-denied" className="text-xs text-muted-foreground">
          {t('prefs.browserDenied')}
        </p>
      ) : null}
      <label htmlFor="notifications-prefs-volume" className={cn('flex flex-col gap-1 text-sm', off && 'opacity-60')}>
        <span className="flex items-center justify-between">
          <span>{t('prefs.volume')}</span>
          <span data-testid="notifications-prefs-volume-value" className="tabular-nums text-muted-foreground">
            {settings.volume}%
          </span>
        </span>
        <input
          id="notifications-prefs-volume"
          data-testid="notifications-prefs-volume"
          type="range"
          min={0}
          max={100}
          step={1}
          value={settings.volume}
          disabled={off}
          onChange={(e) => notificationStore.updateSettings({ volume: Number(e.target.value) })}
          className="w-full accent-primary"
        />
      </label>
      <button
        type="button"
        data-testid="notifications-prefs-advanced"
        aria-expanded={advanced}
        onClick={() => setAdvanced((a) => !a)}
        className="flex items-center gap-1 self-start text-xs font-medium text-primary hover:underline"
      >
        {advanced ? (
          <ChevronDown className="size-3.5" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden />
        )}
        {t('prefs.advanced')}
      </button>
      {advanced ? (
        <div data-testid="notifications-prefs-advanced-panel" className="flex flex-col gap-3">
          <Toggle
            id="enabled"
            label={t('prefs.enabled')}
            checked={settings.enabled}
            onChange={(v) => notificationStore.updateSettings({ enabled: v })}
          />
          <Toggle
            id="toast"
            label={t('prefs.toast')}
            checked={settings.toastNotifications}
            disabled={off}
            onChange={(v) => notificationStore.updateSettings({ toastNotifications: v })}
          />
          <Toggle
            id="sounds"
            label={t('prefs.sounds')}
            checked={settings.sounds}
            disabled={off}
            onChange={(v) => notificationStore.updateSettings({ sounds: v })}
          />
          <Button
            variant="outline"
            size="sm"
            data-testid="notifications-prefs-reset"
            onClick={() => notificationStore.resetSettings()}
            className="self-start"
          >
            {t('prefs.reset')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function ItemRow({ item, onOpen }: { item: NotificationItem; onOpen: (item: NotificationItem) => void }) {
  const t = useT('notifications')
  const { locale } = useI18n()
  const { title, body } = itemTexts(item, t)
  const Icon = item.kind === 'message' ? MessageCircle : Megaphone
  return (
    <button
      type="button"
      data-testid={`notifications-item-${item.id}`}
      data-kind={item.kind}
      data-chat-id={item.chat_id ?? undefined}
      data-read={item.read ? 'true' : 'false'}
      onClick={() => onOpen(item)}
      className={cn(
        'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent',
        !item.read && 'bg-primary/5',
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span data-testid={`notifications-item-title-${item.id}`} className="truncate font-medium">
            {title}
          </span>
          <time
            dateTime={new Date(item.at).toISOString()}
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
          >
            {new Date(item.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
          </time>
        </span>
        <span data-testid={`notifications-item-body-${item.id}`} className="line-clamp-2 text-muted-foreground">
          {body}
        </span>
      </span>
      {item.read ? null : <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden />}
    </button>
  )
}

export function NotificationBell({ session, collapsed = false }: { session: Session; collapsed?: boolean }) {
  const t = useT('notifications')
  const { items, sound } = useNotificationState()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const companyId = session.company?.id ?? null
  const close = useCallback(() => setOpen(false), [])
  const openItem = useOpenItem(close)

  // Limpeza a cada 10 min (14#5); `now` também re-renderiza a lista para esconder o que expirou.
  useEffect(() => {
    const id = setInterval(() => {
      notificationStore.prune()
      setNow(Date.now())
    }, CLEANUP_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])
  useEffect(() => setOpenTarget(openItem), [openItem])

  if (!companyId) return null
  const visible = items.filter((i) => i.company_id === companyId && now - i.at <= ITEM_TTL_MS)
  const count = unreadCount(items, companyId, now)
  const badge = badgeLabel(count)

  const onOpenChange = (next: boolean) => {
    if (next) {
      notificationStore.prune()
      setNow(Date.now())
    } else {
      // Ao fechar a central, o que foi visto conta como lido.
      notificationStore.markRead(companyId)
    }
    setOpen(next)
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        data-testid="notifications-bell"
        data-sound-count={sound.count}
        data-last-sound-volume={sound.lastVolume ?? undefined}
        data-last-sound-at={sound.lastAt ?? undefined}
        aria-label={count ? t('bell.labelUnread', { count }) : t('bell.label')}
        title={collapsed ? t('bell.label') : undefined}
        className={cn(
          'relative flex items-center gap-2 rounded-md text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          collapsed ? 'size-10 justify-center self-center' : 'p-2',
        )}
      >
        <Bell className="size-5" aria-hidden />
        {badge ? (
          <span
            data-testid="notifications-badge"
            data-count={count}
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-white tabular-nums"
          >
            {badge}
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" collisionPadding={8} className="z-[60]">
          <Popover.Popup
            data-testid="notifications-panel"
            className="flex max-h-[min(36rem,calc(100dvh-4rem))] w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg outline-none"
          >
            <div className="flex items-center justify-between gap-2">
              <Popover.Title className="text-sm font-semibold">{t('title')}</Popover.Title>
              {visible.length ? (
                <button
                  type="button"
                  data-testid="notifications-clear"
                  onClick={() => notificationStore.clear(companyId)}
                  className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t('clear')}
                </button>
              ) : null}
            </div>
            <div data-testid="notifications-list" className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
              {visible.length === 0 ? (
                <p data-testid="notifications-empty" className="py-6 text-center text-sm text-muted-foreground">
                  {t('empty')}
                </p>
              ) : (
                visible.map((item) => <ItemRow key={item.id} item={item} onOpen={openItem} />)
              )}
            </div>
            <Preferences />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
