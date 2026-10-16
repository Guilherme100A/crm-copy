// Abas Foto, Instruções, Coleta de dados e Configurações do editor (07 §3.1, §3.2, §3.5).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Plus, Sparkles, Trash2, Undo2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  AGENT_GOALS,
  AGENT_PERSONALITIES,
  agentKey,
  agentsApi,
  AI_ENGINES,
  AVATAR_KEYS,
  flowNamesQuery,
  NO_BALANCE_ACTIONS,
  voicesQuery,
  type AgentSettings,
} from './api'
import type { TabProps } from './editor-page'
import { keyFromLabel } from './form'
import { ModelSelect } from './model-select'
import { AgentAvatar, Field, FieldError, inputClass, ModalShell, Section, textareaClass, Toggle } from './ui'

const AVATAR_ACCEPT = 'image/jpeg,image/png,image/webp'
const AVATAR_MAX = 5 * 1024 * 1024

export function PhotoTab({ draft, set, errors, agent, canEdit }: TabProps) {
  const t = useT('agents')
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Section title={t('photo.title')} hint={t('photo.hint')}>
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <AgentAvatar name={draft.name} avatarKey={draft.avatar_key} avatarUrl={agent?.avatar_url} size="lg" />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="agent-avatar-upload"
              disabled={!agent || !canEdit || uploading}
              title={!agent ? t('editor.saveFirst') : undefined}
              onClick={() => input.current?.click()}
            >
              <Upload aria-hidden /> {t('photo.upload')}
            </Button>
            {agent?.avatar_url && canEdit ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="agent-avatar-remove"
                onClick={async () => {
                  try {
                    qc.setQueryData(agentKey(agent.id), await agentsApi.removeAvatar(agent.id))
                  } catch {
                    notify('agents-error', t('common.error'))
                  }
                }}
              >
                <Trash2 aria-hidden /> {t('photo.remove')}
              </Button>
            ) : null}
            <input
              ref={input}
              type="file"
              accept={AVATAR_ACCEPT}
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file || !agent) return
                if (file.size > AVATAR_MAX) return notify('agents-error', t('photo.tooLarge'))
                setUploading(true)
                try {
                  qc.setQueryData(agentKey(agent.id), await agentsApi.uploadAvatar(agent.id, file))
                } catch {
                  notify('agents-error', t('photo.error'))
                } finally {
                  setUploading(false)
                }
              }}
            />
          </div>
        </div>
        {!agent ? <p className="text-xs text-muted-foreground">{t('editor.saveFirst')}</p> : null}
        <div role="radiogroup" aria-label={t('photo.presets')} className="flex flex-wrap gap-2">
          {AVATAR_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={draft.avatar_key === k}
              aria-label={k}
              data-testid={`agent-avatar-${k}`}
              disabled={!canEdit}
              onClick={() => set((d) => ({ ...d, avatar_key: k }))}
              className={cn(
                'rounded-full p-0.5 ring-offset-2 ring-offset-background',
                draft.avatar_key === k ? 'ring-2 ring-primary' : 'opacity-80 hover:opacity-100',
              )}
            >
              <AgentAvatar name={draft.name} avatarKey={k} size="sm" />
            </button>
          ))}
        </div>
        {errors.avatar_key !== undefined ? <FieldError path="avatar_key" message={errors.avatar_key} /> : null}
      </Section>
      <Section title={t('photo.identity')}>
        <Field label={t('fields.role')} hint={t('fields.roleHint')} path="role" error={errors.role}>
          {(p) => (
            <input
              {...p}
              data-testid="agent-role"
              className={inputClass}
              maxLength={200}
              disabled={!canEdit}
              value={draft.role}
              onChange={(e) => set((d) => ({ ...d, role: e.target.value }))}
            />
          )}
        </Field>
      </Section>
    </div>
  )
}

type TextKey = 'purpose' | 'audience' | 'example_messages' | 'business_rules' | 'never_talk_about'

export function InstructionsTab({ draft, set, errors, agent, canEdit, saveFirst }: TabProps) {
  const t = useT('agents')
  const qc = useQueryClient()
  const [generating, setGenerating] = useState(false)
  const [confirm, setConfirm] = useState(false)

  const generate = async () => {
    setConfirm(false)
    setGenerating(true)
    try {
      const saved = await saveFirst()
      if (!saved) return
      const next = await agentsApi.generatePrompt(saved.id)
      qc.setQueryData(agentKey(next.id), next)
      set((d) => ({ ...d, generated_prompt: next.generated_prompt, prompt_edited: false }))
    } catch {
      notify('agents-error', t('instructions.generateError'))
    } finally {
      setGenerating(false)
    }
  }

  const text = (key: TextKey, rows = 3) => (
    <Field label={t(`fields.${key}`)} path={key} error={errors[key]}>
      {(p) => (
        <textarea
          {...p}
          data-testid={`agent-${key.replace(/_/g, '-')}`}
          rows={rows}
          className={textareaClass}
          disabled={!canEdit}
          value={draft[key]}
          onChange={(e) => set((d) => ({ ...d, [key]: e.target.value }))}
        />
      )}
    </Field>
  )

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Section title={t('instructions.form')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('fields.primary_goal')} path="primary_goal" error={errors.primary_goal}>
            {(p) => (
              <select
                {...p}
                data-testid="agent-primary-goal"
                className={inputClass}
                disabled={!canEdit}
                value={draft.primary_goal}
                onChange={(e) => set((d) => ({ ...d, primary_goal: e.target.value }))}
              >
                {AGENT_GOALS.map((g) => (
                  <option key={g} value={g}>
                    {t(`goals.${g}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('fields.personality')} path="personality" error={errors.personality}>
            {(p) => (
              <select
                {...p}
                data-testid="agent-personality"
                className={inputClass}
                disabled={!canEdit}
                value={draft.personality}
                onChange={(e) => set((d) => ({ ...d, personality: e.target.value }))}
              >
                {AGENT_PERSONALITIES.map((g) => (
                  <option key={g} value={g}>
                    {t(`personalities.${g}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {text('purpose')}
        {text('audience')}
        {text('example_messages', 4)}
        {text('business_rules', 4)}
        {text('never_talk_about')}
        <Toggle
          checked={draft.use_emojis}
          disabled={!canEdit}
          onChange={(v) => set((d) => ({ ...d, use_emojis: v }))}
          label={t('fields.use_emojis')}
          hint={t('fields.use_emojisHint')}
          testId="agent-use-emojis"
        />
      </Section>

      <Section title={t('instructions.prompt')} hint={t('instructions.promptHint')}>
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="agent-prompt-origin" className="rounded-full bg-muted px-2 py-0.5 text-xs">
            {draft.prompt_edited ? t('instructions.edited') : t('instructions.generated')}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            {draft.prompt_edited && agent?.last_generated_prompt && canEdit ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="agent-prompt-undo"
                onClick={() =>
                  set((d) => ({ ...d, generated_prompt: agent.last_generated_prompt, prompt_edited: false }))
                }
              >
                <Undo2 aria-hidden /> {t('instructions.undo')}
              </Button>
            ) : null}
            {canEdit ? (
              <Button
                variant="outline"
                size="sm"
                data-testid="agent-generate-prompt"
                disabled={generating}
                onClick={() =>
                  draft.prompt_edited && draft.generated_prompt.trim() ? setConfirm(true) : void generate()
                }
              >
                <Sparkles aria-hidden /> {generating ? t('instructions.generating') : t('instructions.generate')}
              </Button>
            ) : null}
          </div>
        </div>
        {agent?.locked_blocks.length ? (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="size-3" aria-hidden /> {t('instructions.locked', { n: agent.locked_blocks.length })}
          </p>
        ) : null}
        <Field label={t('fields.generated_prompt')} path="generated_prompt" error={errors.generated_prompt}>
          {(p) => (
            <textarea
              {...p}
              data-testid="agent-generated-prompt"
              rows={10}
              className={cn(textareaClass, 'font-mono text-xs')}
              disabled={!canEdit}
              value={draft.generated_prompt}
              onChange={(e) => set((d) => ({ ...d, generated_prompt: e.target.value, prompt_edited: true }))}
            />
          )}
        </Field>
      </Section>

      <ModalShell
        open={confirm}
        onClose={() => setConfirm(false)}
        testId="agent-generate-confirm"
        title={t('instructions.overwriteTitle')}
      >
        <p className="text-sm text-muted-foreground">{t('instructions.overwriteBody')}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirm(false)}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="agent-generate-confirm-ok" onClick={() => void generate()}>
            {t('instructions.generate')}
          </Button>
        </div>
      </ModalShell>
    </div>
  )
}

export function CollectionTab({ draft, set, errors, canEdit }: TabProps) {
  const t = useT('agents')
  const [label, setLabel] = useState('')
  const key = keyFromLabel(label)
  const exists = draft.collection_fields.some((f) => f.key === key)
  const update = (i: number, patch: Partial<TabProps['draft']['collection_fields'][number]>) =>
    set((d) => ({ ...d, collection_fields: d.collection_fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }))
  return (
    <Section title={t('collection.title')} hint={t('collection.hint')}>
      <ul className="flex flex-col gap-2">
        {draft.collection_fields.map((f, i) => (
          <li
            key={`${f.key}-${i}`}
            data-testid={`agent-collection-${f.key}`}
            className="flex min-w-0 flex-col gap-1 rounded-lg border p-3"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <input
                type="checkbox"
                role="switch"
                aria-label={t('collection.enabled', { name: f.label })}
                className="size-4 accent-primary"
                disabled={!canEdit}
                checked={f.enabled}
                onChange={(e) => update(i, { enabled: e.target.checked })}
              />
              <input
                aria-label={t('collection.label')}
                aria-invalid={errors[`collection_fields.${i}.label`] !== undefined ? true : undefined}
                className={cn(inputClass, 'h-8 max-w-56 flex-1')}
                disabled={!canEdit}
                value={f.label}
                onChange={(e) => update(i, { label: e.target.value })}
              />
              <code className="min-w-0 truncate text-xs text-muted-foreground">
                {t('collection.saves', { variable: `{${f.key}}` })}
              </code>
              {canEdit ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-8"
                  aria-label={t('common.remove')}
                  onClick={() =>
                    set((d) => ({ ...d, collection_fields: d.collection_fields.filter((_, j) => j !== i) }))
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </div>
            {(['key', 'label'] as const).map((k) =>
              errors[`collection_fields.${i}.${k}`] !== undefined ? (
                <FieldError
                  key={k}
                  path={`collection_fields.${i}.${k}`}
                  message={errors[`collection_fields.${i}.${k}`]!}
                />
              ) : null,
            )}
          </li>
        ))}
      </ul>
      {errors.collection_fields !== undefined ? (
        <FieldError path="collection_fields" message={errors.collection_fields} />
      ) : null}
      {canEdit ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!key || exists) return
            set((d) => ({
              ...d,
              collection_fields: [...d.collection_fields, { key, label: label.trim(), enabled: true }],
            }))
            setLabel('')
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">{t('collection.new')}</span>
            <input
              data-testid="agent-collection-new"
              className={inputClass}
              maxLength={60}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('collection.newPlaceholder')}
            />
          </label>
          <Button type="submit" variant="outline" data-testid="agent-collection-add" disabled={!key || exists}>
            <Plus aria-hidden /> {t('collection.add')}
          </Button>
          {exists ? <p className="w-full text-xs text-destructive">{t('collection.exists')}</p> : null}
        </form>
      ) : null}
    </Section>
  )
}

export function SettingsTab({ draft, set, errors, canEdit }: TabProps) {
  const t = useT('agents')
  const voices = useQuery(voicesQuery()).data ?? []
  const flows = useQuery(flowNamesQuery()).data ?? []
  const s = draft.settings
  const put = <K extends keyof AgentSettings>(k: K, v: AgentSettings[K]) =>
    set((d) => ({ ...d, settings: { ...d.settings, [k]: v } }))
  const err = (k: string) => errors[`settings.${k}`]
  const toggle = (k: keyof AgentSettings, extra?: { hint?: boolean }) => (
    <Toggle
      checked={s[k] === true}
      disabled={!canEdit}
      onChange={(v) => put(k, v as never)}
      label={t(`settings.${String(k)}`)}
      hint={extra?.hint ? t(`settings.${String(k)}Hint`) : undefined}
      testId={`agent-setting-${String(k).replace(/_/g, '-')}`}
    />
  )
  const num = (k: keyof AgentSettings, min: number, max: number) => (
    <Field label={t(`settings.${String(k)}`)} path={`settings.${String(k)}`} error={err(String(k))}>
      {(p) => (
        <input
          {...p}
          type="number"
          min={min}
          max={max}
          data-testid={`agent-setting-${String(k).replace(/_/g, '-')}`}
          className={cn(inputClass, 'max-w-32')}
          disabled={!canEdit}
          value={String(s[k] ?? '')}
          onChange={(e) => put(k, (e.target.value === '' ? '' : Number(e.target.value)) as never)}
        />
      )}
    </Field>
  )
  const text = (k: keyof AgentSettings, area = false) => (
    <Field label={t(`settings.${String(k)}`)} path={`settings.${String(k)}`} error={err(String(k))}>
      {(p) =>
        area ? (
          <textarea
            {...p}
            rows={3}
            className={textareaClass}
            disabled={!canEdit}
            value={String(s[k] ?? '')}
            onChange={(e) => put(k, e.target.value as never)}
          />
        ) : (
          <input
            {...p}
            className={inputClass}
            disabled={!canEdit}
            value={String(s[k] ?? '')}
            onChange={(e) => put(k, e.target.value as never)}
          />
        )
      }
    </Field>
  )

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Section title={t('settings.engineTitle')} hint={t('settings.engineHint')}>
        <ModelSelect
          value={draft.model}
          disabled={!canEdit}
          error={errors.model ?? errors['model.provider'] ?? errors['model.model']}
          onChange={(model) => set((d) => ({ ...d, model }))}
        />
        <Field label={t('settings.engine')} path="settings.engine" error={err('engine')}>
          {(p) => (
            <select
              {...p}
              data-testid="agent-setting-engine"
              className={cn(inputClass, 'max-w-xs')}
              disabled={!canEdit}
              value={s.engine}
              onChange={(e) => put('engine', e.target.value as AgentSettings['engine'])}
            >
              {AI_ENGINES.map((e) => (
                <option key={e} value={e}>
                  {t(`engines.${e}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </Section>

      <Section title={t('settings.messagesTitle')}>
        {toggle('buffer_enabled', { hint: true })}
        {s.buffer_enabled ? num('buffer_seconds', 1, 60) : null}
        {toggle('split_messages', { hint: true })}
        {toggle('sign_name')}
        {toggle('business_hours_only', { hint: true })}
      </Section>

      <Section title={t('settings.audioTitle')} hint={t('settings.audioHint')}>
        {toggle('audio_choice_enabled')}
        {s.audio_choice_enabled ? (
          <>
            <Field label={t('settings.audio_voice')} path="settings.audio_voice" error={err('audio_voice')}>
              {(p) => (
                <select
                  {...p}
                  data-testid="agent-setting-audio-voice"
                  className={cn(inputClass, 'max-w-xs')}
                  disabled={!canEdit}
                  value={s.audio_voice}
                  onChange={(e) => put('audio_voice', e.target.value)}
                >
                  <option value="">{t('settings.defaultVoice')}</option>
                  {voices
                    .filter((v) => v.status === 'kept' || v.id === s.audio_voice)
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                </select>
              )}
            </Field>
            {text('audio_guidance', true)}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {num('audio_min_words', 1, 1000)}
              {num('audio_max_per_conversation', 0, 100)}
            </div>
          </>
        ) : null}
      </Section>

      <Section title={t('settings.understandTitle')}>
        {toggle('understand_audio')}
        {toggle('understand_image')}
        {toggle('understand_receipt')}
        {s.understand_receipt ? (
          <>
            {toggle('validate_receipt_pix_key')}
            {s.validate_receipt_pix_key ? text('expected_pix_key') : null}
            {toggle('validate_receipt_recipient')}
            {s.validate_receipt_recipient ? text('expected_recipient_name') : null}
          </>
        ) : null}
      </Section>

      <Section title={t('settings.handoffTitle')}>
        {toggle('pause_on_human', { hint: true })}
        {toggle('stall_limit_enabled', { hint: true })}
        {s.stall_limit_enabled ? num('stall_limit', 1, 200) : null}
      </Section>

      <Section title={t('settings.noBalanceTitle')} hint={t('settings.noBalanceHint')}>
        <Field
          label={t('settings.no_balance_action')}
          path="settings.no_balance_action"
          error={err('no_balance_action')}
        >
          {(p) => (
            <select
              {...p}
              data-testid="agent-setting-no-balance-action"
              className={cn(inputClass, 'max-w-xs')}
              disabled={!canEdit}
              value={s.no_balance_action}
              onChange={(e) => put('no_balance_action', e.target.value as AgentSettings['no_balance_action'])}
            >
              {NO_BALANCE_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {t(`noBalance.${a}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {s.no_balance_action === 'flow' ? (
          <Field
            label={t('settings.no_balance_flow_id')}
            path="settings.no_balance_flow_id"
            error={err('no_balance_flow_id')}
          >
            {(p) => (
              <select
                {...p}
                className={cn(inputClass, 'max-w-xs')}
                disabled={!canEdit}
                value={s.no_balance_flow_id ?? ''}
                onChange={(e) => put('no_balance_flow_id', e.target.value || null)}
              >
                <option value="">{t('common.choose')}</option>
                {flows.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        {s.no_balance_action === 'notify' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {text('no_balance_notify_name')}
            <div className="grid grid-cols-[5rem_1fr] gap-2">
              {text('no_balance_notify_country_code')}
              {text('no_balance_notify_phone')}
            </div>
            <div className="sm:col-span-2">{text('no_balance_notify_message', true)}</div>
          </div>
        ) : null}
      </Section>
    </div>
  )
}
