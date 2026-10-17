// Editor do Bloco de IA (AC-T57-04; 06 §3.6 `ai_call`): provedor (gpt/gemini/openrouter/créditos da plataforma) com a
// disponibilidade real da empresa (`GET /api/ai-agents/model-options`; sem chave → desabilitado), modelo do catálogo,
// origem da chave (empresa/plataforma ou chave BYOK de `GET /api/ai-keys`), prompts, variável da resposta, mídia
// entendida, comprovante e as saídas condicionais (até 10, `output_key` estável + saída padrão).
import type { FlowAction } from '@crm/shared/flows'
import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { aiKeysQuery, modelOptionsQuery } from '../logic/api'
import { Check, DraftStatus, ErrorText, Field, iconButton, inputClass, ListNotice, Notice, NS, NumberInput, OutputsSummary, Section, Select, smallButton, textareaClass, useActionsDraft, VarText } from '../logic/kit'
import { bool, ensureAction, findAction, intOf, num, setField, str, strings } from '../logic/rules'
import {
  addOutputCondition,
  AI_CALL_PROVIDERS,
  conditionsOf,
  DEFAULT_MODEL,
  defaultAiCall,
  hasSavedKey,
  keySourceOf,
  KEY_SOURCES,
  linesOf,
  llmKeys,
  MAX_AI_OUTPUT_CONDITIONS,
  modelsFor,
  patchOutputPrompt,
  providerAvailability,
  removeOutputCondition,
  withIntegration,
  withKeySource,
  withProvider,
  type AiProvider,
  type KeySource,
} from './external-rules'

const TYPE = 'ai_call'
const normalize = (items: FlowAction[]) => ensureAction(items, [TYPE], defaultAiCall)

export function AiEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const options = useQuery(modelOptionsQuery())
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, [TYPE])
  const source = action ? keySourceOf(action.config) : 'platform'
  const keys = useQuery({ ...aiKeysQuery(), enabled: source === 'integration' })
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const patch = (fn: (cfg: typeof c) => typeof c) => patchConfig(action.id, fn)
  const set = (key: string, value: unknown) => patch((cfg) => setField(cfg, key, value))
  const provider = (str(c, 'provider') || 'gpt') as AiProvider
  const available = providerAvailability(options.data?.providers ?? [])
  const models = modelsFor(provider, options.data?.models ?? [], str(c, 'model') || undefined)
  const keyItems = llmKeys(keys.data?.items ?? [])
  const conditions = conditionsOf(c)
  const fallback = str(c, 'fallback_output_key')
  const outputLabel = (h: string) => {
    if (!h.startsWith('output:')) return t(`outputs.handles.${h}`)
    const key = h.slice('output:'.length)
    if (key === fallback) return t('ai.fallbackLabel', { key })
    const i = conditions.findIndex((o) => o.output_key === key)
    return i >= 0 ? `${i + 1}. ${conditions[i]!.prompt.slice(0, 24) || key}` : key
  }

  return (
    <div data-testid="ne-ai" className="flex flex-col gap-2">
      <Section title={t('ai.engine')} testId="ne-ai-engine">
        <Field label={t('ai.keySource')} path="api_key_source" errors={errs}>
          {({ id }) => (
            <Select
              id={id}
              testId="ne-ai-key-source"
              value={source}
              options={[...KEY_SOURCES, ...(source === 'manual' ? (['manual'] as const) : [])].map((v) => ({ value: v, label: t(`ai.keySources.${v}`) }))}
              disabled={readOnly}
              onChange={(v) => patch((cfg) => withKeySource(cfg, v as KeySource))}
            />
          )}
        </Field>
        {source === 'integration' ? (
          <>
            <Field label={t('ai.key')} path="ai_integration_id" errors={errs}>
              {({ id, invalid }) => (
                <Select
                  id={id}
                  testId="ne-ai-key"
                  value={str(c, 'ai_integration_id')}
                  invalid={invalid}
                  placeholder={t('common.choose')}
                  options={keyItems.map((k) => ({ value: k.id, label: `${k.name} · ${t(`ai.keyProviders.${k.provider}`)} ${k.hint}`.trim(), testId: `ne-ai-key-option-${k.id}` }))}
                  disabled={readOnly}
                  onChange={(v) => patch((cfg) => withIntegration(cfg, keyItems.find((k) => k.id === v)))}
                />
              )}
            </Field>
            <ListNotice name="aiKeys" loading={keys.isPending} denied={!!keys.data?.denied} empty={!!keys.data && !keys.data.denied && keyItems.length === 0} />
          </>
        ) : null}
        {source === 'manual' ? <ManualKey saved={hasSavedKey(c)} readOnly={readOnly} onChange={(v) => set('api_key', v)} /> : null}
        <Field label={t('ai.provider')} path="provider" errors={errs} hint={source === 'integration' ? t('ai.providerFromKey') : undefined}>
          {({ id }) => (
            <Select
              id={id}
              testId="ne-ai-provider"
              value={provider}
              options={AI_CALL_PROVIDERS.map((p) => ({
                value: p,
                label: available[p] || source === 'integration' ? t(`ai.providers.${p}`) : `${t(`ai.providers.${p}`)} (${t('ai.noKey')})`,
                disabled: source !== 'integration' && !available[p] && p !== provider,
                testId: `ne-ai-provider-${p}`,
              }))}
              disabled={readOnly || source === 'integration'}
              onChange={(v) => patch((cfg) => withProvider(cfg, v as AiProvider))}
            />
          )}
        </Field>
        {source !== 'integration' && !available[provider] && options.data ? (
          <Notice testId="ne-ai-provider-unavailable" tone="warn">
            {options.data.denied ? t('lists.denied', { list: t('lists.names.models') }) : t('ai.providerUnavailable')}
          </Notice>
        ) : null}
        <Field label={t('ai.model')} path="model" errors={errs}>
          {({ id }) => (
            <Select
              id={id}
              testId="ne-ai-model"
              value={str(c, 'model')}
              placeholder={t('ai.defaultModel', { model: DEFAULT_MODEL[provider] })}
              options={models.map((m) => ({ value: m, label: m, testId: `ne-ai-model-${m}` }))}
              disabled={readOnly}
              onChange={(v) => set('model', v || undefined)}
            />
          )}
        </Field>
      </Section>

      <Section title={t('ai.prompts')} testId="ne-ai-prompts">
        <VarText
          label={t('ai.systemPrompt')}
          path="system_prompt"
          errors={errs}
          testId="ne-ai-system-prompt"
          value={str(c, 'system_prompt')}
          disabled={readOnly}
          multiline
          onChange={(v) => set('system_prompt', v)}
        />
        <VarText
          label={t('ai.userMessage')}
          path="user_message"
          errors={errs}
          testId="ne-ai-user-message"
          value={str(c, 'user_message')}
          disabled={readOnly}
          hint={t('ai.userMessageHint')}
          onChange={(v) => set('user_message', v || undefined)}
        />
        <Field label={t('ai.responseVariable')} path="response_variable" errors={errs} hint={t('ai.responseVariableHint')}>
          {({ id, invalid }) => (
            <input id={id} data-testid="ne-ai-response-var" className={inputClass} aria-invalid={invalid} value={str(c, 'response_variable')} disabled={readOnly} onChange={(e) => set('response_variable', e.target.value || undefined)} />
          )}
        </Field>
        <Check label={t('ai.autoSend')} testId="ne-ai-auto-send" checked={bool(c, 'auto_send_response')} disabled={readOnly} onChange={(v) => set('auto_send_response', v || undefined)} />
        <Check label={t('ai.maintainContext')} testId="ne-ai-context" checked={bool(c, 'maintain_context')} disabled={readOnly} onChange={(v) => set('maintain_context', v || undefined)} />
        {bool(c, 'maintain_context') ? (
          <Field label={t('ai.contextInteractions')} path="context_interactions" errors={errs}>
            {({ id, invalid }) => <NumberInput id={id} testId="ne-ai-context-n" min={1} max={20} value={num(c, 'context_interactions')} invalid={invalid} disabled={readOnly} onChange={(raw) => set('context_interactions', intOf(raw))} />}
          </Field>
        ) : null}
      </Section>

      <Section title={t('ai.understand')} testId="ne-ai-understand">
        {(['audio', 'image', 'pdf', 'receipt'] as const).map((k) => (
          <Check key={k} label={t(`ai.understandItems.${k}`)} testId={`ne-ai-understand-${k}`} checked={bool(c, `understand_${k}`)} disabled={readOnly} onChange={(v) => set(`understand_${k}`, v || undefined)} />
        ))}
        {bool(c, 'understand_receipt') ? (
          <>
            <Check label={t('ai.validatePix')} testId="ne-ai-validate-pix" checked={bool(c, 'validate_receipt_pix_key')} disabled={readOnly} onChange={(v) => set('validate_receipt_pix_key', v || undefined)} />
            {bool(c, 'validate_receipt_pix_key') ? (
              <LinesField label={t('ai.expectedPix')} path="expected_pix_keys" testId="ne-ai-expected-pix" value={strings(c.expected_pix_keys)} error={errs?.expected_pix_keys} readOnly={readOnly} onChange={(v) => set('expected_pix_keys', v)} />
            ) : null}
            <Check
              label={t('ai.validateRecipient')}
              testId="ne-ai-validate-recipient"
              checked={bool(c, 'validate_receipt_recipient')}
              disabled={readOnly}
              onChange={(v) => set('validate_receipt_recipient', v || undefined)}
            />
            {bool(c, 'validate_receipt_recipient') ? (
              <LinesField
                label={t('ai.expectedRecipients')}
                path="expected_recipient_names"
                testId="ne-ai-expected-recipients"
                value={strings(c.expected_recipient_names)}
                error={errs?.expected_recipient_names}
                readOnly={readOnly}
                onChange={(v) => set('expected_recipient_names', v)}
              />
            ) : null}
          </>
        ) : null}
      </Section>

      <Section
        title={t('ai.outputs')}
        testId="ne-ai-outputs"
        actions={
          <button type="button" data-testid="ne-ai-output-add" disabled={readOnly || conditions.length >= MAX_AI_OUTPUT_CONDITIONS} onClick={() => patch((cfg) => addOutputCondition(cfg))} className={smallButton}>
            <Plus className="size-3.5" aria-hidden /> {t('common.add')}
          </button>
        }
      >
        <p className="text-[11px] text-muted-foreground">{t('ai.outputsHint', { max: MAX_AI_OUTPUT_CONDITIONS })}</p>
        {conditions.map((o, i) => (
          <div key={o.output_key} data-testid={`ne-ai-output-${o.output_key}`} className="flex flex-col gap-0.5">
            <div className="flex items-start gap-1">
              <span className="mt-1.5 w-5 shrink-0 text-[11px] text-muted-foreground">{i + 1}.</span>
              <textarea
                data-testid={`ne-ai-output-${o.output_key}-prompt`}
                aria-label={t('ai.outputPrompt', { n: i + 1 })}
                placeholder={t('ai.outputPlaceholder')}
                className={`${textareaClass} min-h-14`}
                maxLength={200}
                aria-invalid={!!errs?.[`output_conditions.${i}.prompt`]}
                value={o.prompt}
                disabled={readOnly}
                onChange={(e) => patch((cfg) => patchOutputPrompt(cfg, o.output_key, e.target.value))}
              />
              <button type="button" data-testid={`ne-ai-output-${o.output_key}-remove`} aria-label={t('common.remove')} disabled={readOnly} onClick={() => patch((cfg) => removeOutputCondition(cfg, o.output_key))} className={iconButton}>
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
            <ErrorText path={`output_conditions.${i}.prompt`} error={errs?.[`output_conditions.${i}.prompt`]} />
          </div>
        ))}
        {conditions.length ? (
          <p data-testid="ne-ai-fallback" className="text-[11px] text-muted-foreground">
            {t('ai.fallback', { key: fallback })}
          </p>
        ) : null}
        <ErrorText path="output_conditions" error={errs?.output_conditions} />
        <ErrorText path="fallback_output_key" error={errs?.fallback_output_key} />
      </Section>
      <OutputsSummary type="ai" actions={draft} label={outputLabel} />
      <DraftStatus blocked={blocked} />
    </div>
  )
}

/** Chave manual (legado): nunca mostra a salva; digitar troca, deixar vazio mantém. */
function ManualKey({ saved, readOnly, onChange }: { saved: boolean; readOnly: boolean; onChange: (v: string) => void }) {
  const t = useT(NS)
  const id = useId()
  const [typed, setTyped] = useState('')
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {t('ai.manualKey')}
      </label>
      <input
        id={id}
        type="password"
        autoComplete="off"
        data-testid="ne-ai-manual-key"
        className={inputClass}
        placeholder={saved ? t('ai.manualKeySaved') : ''}
        value={typed}
        disabled={readOnly}
        onChange={(e) => {
          setTyped(e.target.value)
          if (e.target.value.trim()) onChange(e.target.value.trim())
        }}
      />
      <p className="text-[11px] text-muted-foreground">{t('ai.manualKeyHint')}</p>
    </div>
  )
}

function LinesField({ label, path, testId, value, error, readOnly, onChange }: { label: string; path: string; testId: string; value: string[]; error?: { key: string } | undefined; readOnly: boolean; onChange: (v: string[] | undefined) => void }) {
  const id = useId()
  const [text, setText] = useState(value.join('\n'))
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <textarea
        id={id}
        data-testid={testId}
        className={`${textareaClass} min-h-14`}
        aria-invalid={!!error}
        value={text}
        disabled={readOnly}
        onChange={(e) => {
          setText(e.target.value)
          const lines = linesOf(e.target.value)
          onChange(lines.length ? lines : undefined)
        }}
      />
      <ErrorText path={path} error={error} />
    </div>
  )
}
