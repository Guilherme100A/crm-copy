// Aba Vozes (07 §3.7; AC-T92-03): enviar 1–3 amostras (anexadas ou gravadas no navegador) com nome e idioma, ouvir a
// prévia (consome saldo), manter a voz pendente ou excluí-la. Excluir avisa que a voz sai dos agentes que a usam e,
// depois, lista os agentes afetados. Montado na aba Vozes de `/agentes` (lista da T88).
import { useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, Mic, Paperclip, Play, Plus, Square, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAudioRecorder, canRecord } from '@/features/agent-lab/recorder'
import type { VoiceDto } from '@/features/agents/api'
import { inputClass, ModalShell } from '@/features/agents/ui'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { VOICE_ACCEPT, VOICE_LANGS, VOICE_MAX_SAMPLES, VOICES_KEY, voicesApi, type VoiceLang } from './api'
import { addSamples, formatBytes, voiceErrorKey, voiceFormError } from './form'

export function VoiceCreate() {
  const t = useT('agent-lab')
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [language, setLanguage] = useState<VoiceLang>('pt')
  const [files, setFiles] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const recorder = useAudioRecorder()

  const add = (incoming: File[]) => {
    const next = addSamples(files, incoming)
    setFiles(next.files)
    setError(next.overflow ? t('voices.errors.count') : null)
  }

  const reset = () => {
    setName('')
    setLanguage('pt')
    setFiles([])
    setError(null)
    setOpen(false)
  }

  const toggleRecord = async () => {
    if (recorder.recording) {
      const blob = await recorder.stop()
      if (blob) {
        const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'
        add([new File([blob], `${t('voices.recordingName')}-${files.length + 1}.${ext}`, { type: blob.type.split(';')[0] })])
      }
      return
    }
    try {
      await recorder.start()
    } catch {
      setError(t('voices.micDenied'))
    }
  }

  const submit = async () => {
    const invalid = voiceFormError(name, files)
    if (invalid) return setError(t(`voices.errors.${invalid}`))
    setSaving(true)
    setError(null)
    try {
      await voicesApi.create({ name: name.trim(), language, audios: files })
      await qc.invalidateQueries({ queryKey: VOICES_KEY })
      notify('agent-voices-created', t('voices.created'))
      reset()
    } catch (err) {
      setError(t(`voices.errors.${voiceErrorKey(err)}`))
    } finally {
      setSaving(false)
    }
  }

  if (!open)
    return (
      <div>
        <Button data-testid="agent-voices-new" onClick={() => setOpen(true)}>
          <Plus aria-hidden /> {t('voices.new')}
        </Button>
      </div>
    )

  return (
    <form
      data-testid="agent-voices-form"
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <h3 className="font-semibold">{t('voices.new')}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem]">
        <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
          {t('voices.name')}
          <input
            data-testid="agent-voices-name"
            className={inputClass}
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
          {t('voices.language')}
          <select
            data-testid="agent-voices-language"
            className={inputClass}
            value={language}
            onChange={(e) => setLanguage(e.target.value as VoiceLang)}
          >
            {VOICE_LANGS.map((l) => (
              <option key={l} value={l}>
                {t(`voices.languages.${l}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t('voices.samples', { max: VOICE_MAX_SAMPLES })}</p>
        <p className="text-xs text-muted-foreground">{t('voices.samplesHint')}</p>
        {files.length ? (
          <ul data-testid="agent-voices-samples" className="flex flex-col gap-1">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                data-testid={`agent-voices-sample-${i}`}
                className="flex min-w-0 items-center gap-2 rounded-md border px-2 py-1 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-xs text-muted-foreground">{formatBytes(f.size)}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid={`agent-voices-sample-remove-${i}`}
                  aria-label={t('voices.removeSample')}
                  onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                >
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="agent-voices-attach"
            disabled={files.length >= VOICE_MAX_SAMPLES || recorder.recording}
            onClick={() => input.current?.click()}
          >
            <Paperclip aria-hidden /> {t('voices.attach')}
          </Button>
          {canRecord() ? (
            <Button
              variant={recorder.recording ? 'destructive' : 'outline'}
              size="sm"
              data-testid="agent-voices-record"
              disabled={!recorder.recording && files.length >= VOICE_MAX_SAMPLES}
              onClick={() => void toggleRecord()}
            >
              {recorder.recording ? <Square aria-hidden /> : <Mic aria-hidden />}{' '}
              {recorder.recording ? t('voices.stopRecording') : t('voices.record')}
            </Button>
          ) : null}
          <input
            ref={input}
            type="file"
            multiple
            accept={VOICE_ACCEPT}
            className="hidden"
            data-testid="agent-voices-files"
            onChange={(e) => {
              const list = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (list.length) add(list)
            }}
          />
        </div>
      </div>
      {error ? (
        <p data-testid="agent-voices-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" data-testid="agent-voices-cancel" disabled={saving} onClick={reset}>
          {t('voices.cancel')}
        </Button>
        <Button type="submit" data-testid="agent-voices-submit" disabled={saving || recorder.recording}>
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : null} {t('voices.submit')}
        </Button>
      </div>
    </form>
  )
}

/** Ações de uma voz da lista: prévia, manter (pendente) e excluir (com aviso dos agentes afetados). */
export function VoiceActions({ voice }: { voice: VoiceDto }) {
  const t = useT('agent-lab')
  const qc = useQueryClient()
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState<'preview' | 'keep' | 'delete' | null>(null)
  const [confirm, setConfirm] = useState(false)
  const audio = useRef<HTMLAudioElement>(null)

  useEffect(() => () => void (audioUrl && URL.revokeObjectURL(audioUrl)), [audioUrl])

  const preview = async () => {
    setBusy('preview')
    try {
      const blob = await voicesApi.preview(voice.id)
      setAudioUrl(URL.createObjectURL(blob))
      // Toca assim que o elemento recebe a fonte (autoplay pode ser bloqueado: os controles ficam visíveis).
      requestAnimationFrame(() => void audio.current?.play().catch(() => undefined))
    } catch (err) {
      notify('agent-voices-error', t(`voices.errors.${voiceErrorKey(err)}`))
    } finally {
      setBusy(null)
    }
  }

  const keep = async () => {
    setBusy('keep')
    try {
      await voicesApi.keep(voice.id)
      await qc.invalidateQueries({ queryKey: VOICES_KEY })
      notify('agent-voices-kept', t('voices.keptToast'))
    } catch (err) {
      notify('agent-voices-error', t(`voices.errors.${voiceErrorKey(err)}`))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setBusy('delete')
    try {
      const res = await voicesApi.remove(voice.id)
      setConfirm(false)
      await qc.invalidateQueries({ queryKey: VOICES_KEY })
      const names = res.removed_from_agents.map((a) => a.name)
      if (names.length)
        notify('agent-voices-removed-from-agents', t('voices.removedFromAgents', { n: names.length }), names.join(', '))
      else notify('agent-voices-deleted', t('voices.deleted'))
    } catch (err) {
      notify('agent-voices-error', t(`voices.errors.${voiceErrorKey(err)}`))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
      {audioUrl ? (
        <audio
          ref={audio}
          data-testid={`agent-voices-audio-${voice.id}`}
          src={audioUrl}
          controls
          className="h-8 max-w-48"
        />
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        data-testid={`agent-voices-preview-${voice.id}`}
        disabled={busy !== null}
        onClick={() => void preview()}
      >
        {busy === 'preview' ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
        <span className="max-sm:sr-only">{t('voices.preview')}</span>
      </Button>
      {voice.status !== 'kept' ? (
        <Button
          variant="ghost"
          size="sm"
          data-testid={`agent-voices-keep-${voice.id}`}
          disabled={busy !== null}
          onClick={() => void keep()}
        >
          {busy === 'keep' ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
          <span className="max-sm:sr-only">{t('voices.keep')}</span>
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive"
        data-testid={`agent-voices-delete-${voice.id}`}
        disabled={busy !== null}
        onClick={() => setConfirm(true)}
      >
        <Trash2 aria-hidden />
        <span className="max-sm:sr-only">{voice.status === 'kept' ? t('voices.delete') : t('voices.discard')}</span>
      </Button>
      <ModalShell
        open={confirm}
        onClose={() => busy !== 'delete' && setConfirm(false)}
        testId="agent-voices-delete-dialog"
        title={t('voices.deleteTitle', { name: voice.name })}
      >
        <p data-testid="agent-voices-delete-warning" className="text-sm text-muted-foreground">
          {t('voices.deleteWarning')}
        </p>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            data-testid="agent-voices-delete-cancel"
            disabled={busy === 'delete'}
            onClick={() => setConfirm(false)}
          >
            {t('voices.cancel')}
          </Button>
          <Button
            variant="destructive"
            data-testid="agent-voices-delete-confirm"
            disabled={busy === 'delete'}
            onClick={() => void remove()}
          >
            {busy === 'delete' ? <Loader2 className="animate-spin" aria-hidden /> : null} {t('voices.delete')}
          </Button>
        </div>
      </ModalShell>
    </div>
  )
}
