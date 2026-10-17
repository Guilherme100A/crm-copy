// Estado da central (T84): itens e preferências no localStorage (14#10; sem servidor), mais o sinal de som para o
// E2E (contagem e volume da última reprodução). Store de módulo (o handler realtime roda fora do React).
import { useSyncExternalStore } from 'react'
import {
  addItem,
  DEFAULT_SETTINGS,
  ITEMS_KEY,
  mergeSettings,
  parseItems,
  parseSettings,
  pruneExpired,
  SETTINGS_KEY,
  shouldPlaySound,
  type NotificationItem,
  type NotificationSettings,
} from './model'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Efeitos colaterais de uma notificação nova (toast, som, navegador); `effects.ts` implementa no navegador. */
export interface NotificationEffects {
  toast(item: NotificationItem): void
  sound(volume: number): void
  browser(item: NotificationItem): void
  /** Gravação de áudio em curso no compositor (14#8). */
  muted(): boolean
}

export interface SoundSignal {
  count: number
  lastAt: number | null
  lastVolume: number | null
}

export interface NotificationState {
  items: NotificationItem[]
  settings: NotificationSettings
  sound: SoundSignal
}

const noopEffects: NotificationEffects = { toast() {}, sound() {}, browser() {}, muted: () => false }

const browserStorage = (): StorageLike | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export class NotificationStore {
  private state: NotificationState
  private readonly listeners = new Set<() => void>()
  effects: NotificationEffects

  constructor(
    private readonly storage: () => StorageLike | null = browserStorage,
    effects: NotificationEffects = noopEffects,
    private readonly now: () => number = Date.now,
  ) {
    this.effects = effects
    this.state = {
      items: pruneExpired(parseItems(this.read(ITEMS_KEY)), this.now()),
      settings: parseSettings(this.read(SETTINGS_KEY)),
      sound: { count: 0, lastAt: null, lastVolume: null },
    }
  }

  private read(key: string): string | null {
    try {
      return this.storage()?.getItem(key) ?? null
    } catch {
      return null
    }
  }

  private write(key: string, value: unknown): void {
    try {
      this.storage()?.setItem(key, JSON.stringify(value))
    } catch {
      // sem storage: vale só nesta página
    }
  }

  private set(patch: Partial<NotificationState>): void {
    this.state = { ...this.state, ...patch }
    if (patch.items) this.write(ITEMS_KEY, patch.items)
    if (patch.settings) this.write(SETTINGS_KEY, patch.settings)
    for (const l of this.listeners) l()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): NotificationState => this.state

  /** Notificação nova: entra na central e dispara toast/som/navegador conforme as preferências (AC-T84-01/04/05). */
  ingest(item: NotificationItem): boolean {
    const { settings } = this.state
    if (!settings.enabled) return false
    const items = addItem(this.state.items, item, this.now())
    if (!items) return false
    let sound = this.state.sound
    if (shouldPlaySound(settings, this.effects.muted())) {
      sound = { count: sound.count + 1, lastAt: this.now(), lastVolume: settings.volume }
      this.effects.sound(settings.volume)
    }
    this.set({ items, sound })
    if (settings.toastNotifications) this.effects.toast(item)
    if (settings.browserNotifications) this.effects.browser(item)
    return true
  }

  /** Limpeza periódica (14#5: a cada 10 min). */
  prune(): void {
    const items = pruneExpired(this.state.items, this.now())
    if (items.length !== this.state.items.length) this.set({ items })
  }

  markRead(companyId: string | null | undefined, id?: string): void {
    if (!this.state.items.some((i) => i.company_id === companyId && !i.read && (id === undefined || i.id === id)))
      return
    this.set({
      items: this.state.items.map((i) =>
        i.company_id === companyId && (id === undefined || i.id === id) ? { ...i, read: true } : i,
      ),
    })
  }

  clear(companyId: string | null | undefined): void {
    this.set({ items: this.state.items.filter((i) => i.company_id !== companyId) })
  }

  updateSettings(patch: Partial<NotificationSettings>): void {
    this.set({ settings: mergeSettings(this.state.settings, patch) })
  }

  /** "Restaurar padrão" (14#11). */
  resetSettings(): void {
    this.set({ settings: { ...DEFAULT_SETTINGS } })
  }
}

export const notificationStore = new NotificationStore()

export function useNotificationState(): NotificationState {
  return useSyncExternalStore(notificationStore.subscribe, notificationStore.getState, notificationStore.getState)
}
