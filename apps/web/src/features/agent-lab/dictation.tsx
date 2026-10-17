// Ditado por voz (07 §5 item 4; AC-T92-04): grava no microfone (ou recebe um arquivo de áudio), envia para
// `POST /api/ai-agents/transcriptions` (STT medido) e entrega o texto para o campo inserir.
// Testids: `<testId>` (gravar/parar), `<testId>-file` (input de arquivo), `<testId>-busy` (transcrevendo).
import { Loader2, Mic, Paperclip, Square } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { labApi } from './api'
import { labErrorKey, recordingFilename } from './lab'
import { canRecord, useAudioRecorder } from './recorder'

export function DictationButton({
  testId,
  onText,
  disabled,
}: {
  testId: string
  onText: (text: string) => void
  disabled?: boolean
}) {
  const t = useT('agent-lab')
  const { recording, start, stop } = useAudioRecorder()
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const transcribe = async (audio: Blob, name: string) => {
    setBusy(true)
    try {
      const text = await labApi.transcribe(audio, name)
      if (text.trim()) onText(text)
      else notify('agent-lab-dictation-empty', t('dictation.empty'))
    } catch (err) {
      notify('agent-lab-dictation-error', t(`errors.${labErrorKey(err)}`))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async () => {
    if (recording) {
      const audio = await stop()
      if (audio) await transcribe(audio, recordingFilename(audio.type))
      return
    }
    try {
      await start()
    } catch {
      notify('agent-lab-dictation-error', t('dictation.micDenied'))
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      {canRecord() ? (
        <Button
          type="button"
          variant={recording ? 'destructive' : 'ghost'}
          size="sm"
          data-testid={testId}
          data-recording={recording || undefined}
          disabled={disabled || busy}
          aria-label={recording ? t('dictation.stop') : t('dictation.start')}
          title={recording ? t('dictation.stop') : t('dictation.start')}
          onClick={() => void toggle()}
        >
          {recording ? <Square aria-hidden /> : <Mic aria-hidden />}
          <span className="max-sm:sr-only">{recording ? t('dictation.stop') : t('dictation.start')}</span>
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid={`${testId}-upload`}
        disabled={disabled || busy || recording}
        aria-label={t('dictation.upload')}
        title={t('dictation.upload')}
        onClick={() => file.current?.click()}
      >
        <Paperclip aria-hidden />
      </Button>
      <input
        ref={file}
        type="file"
        accept="audio/*"
        className="hidden"
        data-testid={`${testId}-file`}
        disabled={disabled || busy}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void transcribe(f, f.name || 'ditado.webm')
        }}
      />
      {busy ? (
        <span data-testid={`${testId}-busy`} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden /> {t('dictation.transcribing')}
        </span>
      ) : null}
    </span>
  )
}
