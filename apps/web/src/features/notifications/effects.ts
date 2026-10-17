// Efeitos no navegador (14#6–#8): toast in-app de 3 s, som por oscilador WebAudio (sem arquivo) e notificação do
// navegador (Notification API) que fecha em 5 s. A permissão do navegador só é pedida por gesto do usuário.
import { isNotificationMuted } from '@/features/chat-composer/rules'
import { initialLocale, translate } from '@/i18n'
import { toastManager } from '@/lib/toast'
import {
  BROWSER_NOTIFICATION_TIMEOUT_MS,
  gainForVolume,
  itemTexts,
  TOAST_TIMEOUT_MS,
  type NotificationItem,
} from './model'
import type { NotificationEffects } from './store'

export const TOAST_TYPE = 'notifications-toast'

const tr = (key: string) => translate(initialLocale(), key, undefined, 'notifications')

let audioCtx: AudioContext | null = null

/** Dois bipes curtos (senoide 880 → 660 Hz). Falha silenciosa sem WebAudio ou sem gesto prévio do usuário. */
export function playTone(volume: number): void {
  try {
    const Ctx =
      globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    audioCtx ??= new Ctx()
    const ctx = audioCtx
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    const peak = gainForVolume(volume)
    const start = ctx.currentTime
    for (const [i, freq] of [880, 660].entries()) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const t0 = start + i * 0.14
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, t0)
      gain.gain.setValueAtTime(0.0001, t0)
      gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t0)
      osc.stop(t0 + 0.13)
    }
  } catch {
    // sem áudio: o sinal do sino já registrou a decisão
  }
}

export const browserNotificationsSupported = () => typeof globalThis.Notification !== 'undefined'

/** Pede permissão (chamar só a partir de clique/toque). */
export async function requestBrowserPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!browserNotificationsSupported()) return 'unsupported'
  if (Notification.permission !== 'default') return Notification.permission
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

/** Abre o destino do item ao clicar na notificação do navegador. */
let openTarget: (item: NotificationItem) => void = () => undefined
export const setOpenTarget = (fn: (item: NotificationItem) => void) => {
  openTarget = fn
}

function showBrowser(item: NotificationItem): void {
  // Só com a aba em segundo plano: em primeiro plano o toast já avisa.
  if (!browserNotificationsSupported() || Notification.permission !== 'granted') return
  if (globalThis.document?.visibilityState === 'visible') return
  try {
    const { title, body } = itemTexts(item, tr)
    const n = new Notification(title, { body, tag: item.id })
    n.onclick = () => {
      globalThis.focus?.()
      openTarget(item)
      n.close()
    }
    setTimeout(() => n.close(), BROWSER_NOTIFICATION_TIMEOUT_MS)
  } catch {
    // alguns navegadores móveis só aceitam via service worker
  }
}

export const browserEffects: NotificationEffects = {
  toast(item) {
    const { title, body } = itemTexts(item, tr)
    toastManager.add({ type: TOAST_TYPE, title, ...(body ? { description: body } : {}), timeout: TOAST_TIMEOUT_MS })
  },
  sound: playTone,
  browser: showBrowser,
  muted: () => isNotificationMuted(),
}
