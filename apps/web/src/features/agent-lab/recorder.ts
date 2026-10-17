// Gravação do ditado no navegador: MediaRecorder sobre o microfone. `stop()` devolve o áudio (ou `null` se vazio).
import { useCallback, useEffect, useRef, useState } from 'react'

const PREFERRED = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']

export function pickMime(isSupported: (m: string) => boolean): string | undefined {
  return PREFERRED.find((m) => {
    try {
      return isSupported(m)
    } catch {
      return false
    }
  })
}

export const canRecord = () =>
  typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

export function useAudioRecorder() {
  const [recording, setRecording] = useState(false)
  const rec = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const done = useRef<((b: Blob | null) => void) | null>(null)

  const release = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    rec.current = null
    setRecording(false)
  }, [])

  // Desmontar no meio da gravação libera o microfone.
  useEffect(
    () => () => {
      done.current = null
      if (rec.current?.state === 'recording') rec.current.stop()
      release()
    },
    [release],
  )

  /** Pede o microfone e começa. Lança se não houver suporte ou a permissão for negada. */
  const start = useCallback(async () => {
    if (!canRecord()) throw new Error('unsupported')
    const media = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mime = pickMime((m) => MediaRecorder.isTypeSupported(m))
    const r = new MediaRecorder(media, mime ? { mimeType: mime } : undefined)
    chunks.current = []
    r.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data)
    }
    r.onstop = () => {
      const type = r.mimeType || mime || 'audio/webm'
      done.current?.(chunks.current.length ? new Blob(chunks.current, { type }) : null)
      done.current = null
      release()
    }
    stream.current = media
    rec.current = r
    r.start(250)
    setRecording(true)
  }, [release])

  const stop = useCallback(
    () =>
      new Promise<Blob | null>((resolve) => {
        const r = rec.current
        if (!r || r.state === 'inactive') {
          release()
          return resolve(null)
        }
        done.current = resolve
        r.stop()
      }),
    [release],
  )

  return { recording, start, stop }
}
