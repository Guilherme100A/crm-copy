// Gravação de áudio no navegador (T85; spec 03 F33; AC-T85-03): MediaRecorder sobre o microfone; enquanto grava, as
// notificações sonoras ficam mudas. O áudio vai como nota de voz (o servidor converte para Ogg/Opus).
import { useCallback, useEffect, useRef, useState } from 'react'
import { setNotificationsMuted } from './rules'

const PREFERRED = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']

export function pickRecorderMime(isSupported: (m: string) => boolean): string | undefined {
  return PREFERRED.find((m) => {
    try {
      return isSupported(m)
    } catch {
      return false
    }
  })
}

export type RecorderState = 'idle' | 'recording'

export interface Recording {
  blob: Blob
  mime: string
  seconds: number
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>('idle')
  const [seconds, setSeconds] = useState(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const stream = useRef<MediaStream | null>(null)
  const started = useRef(0)
  const resolveStop = useRef<((r: Recording | null) => void) | null>(null)
  const cancelled = useRef(false)

  const cleanup = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    recorder.current = null
    setNotificationsMuted(false)
    setState('idle')
  }, [])

  useEffect(() => {
    if (state !== 'recording') return
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started.current) / 1000)), 250)
    return () => clearInterval(id)
  }, [state])

  // Desmontar no meio da gravação libera o microfone.
  useEffect(
    () => () => {
      cancelled.current = true
      if (recorder.current?.state === 'recording') recorder.current.stop()
      cleanup()
    },
    [cleanup],
  )

  /** Pede o microfone e começa. Lança se a permissão for negada ou não houver suporte. */
  const start = useCallback(async () => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new Error('unsupported')
    const media = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mime = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m))
    const rec = new MediaRecorder(media, mime ? { mimeType: mime } : undefined)
    chunks.current = []
    cancelled.current = false
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data)
    }
    rec.onstop = () => {
      const type = rec.mimeType || mime || 'audio/webm'
      const result = cancelled.current || !chunks.current.length ? null : { blob: new Blob(chunks.current, { type }), mime: type, seconds: Math.max(1, Math.round((Date.now() - started.current) / 1000)) }
      resolveStop.current?.(result)
      resolveStop.current = null
      cleanup()
    }
    stream.current = media
    recorder.current = rec
    started.current = Date.now()
    setSeconds(0)
    setNotificationsMuted(true)
    rec.start(250)
    setState('recording')
  }, [cleanup])

  /** Para e devolve o áudio (`null` se cancelado ou vazio). */
  const stop = useCallback(
    (cancel = false) =>
      new Promise<Recording | null>((resolve) => {
        const rec = recorder.current
        if (!rec || rec.state === 'inactive') {
          cleanup()
          return resolve(null)
        }
        cancelled.current = cancel
        resolveStop.current = resolve
        rec.stop()
      }),
    [cleanup],
  )

  return { state, seconds, start, stop }
}
