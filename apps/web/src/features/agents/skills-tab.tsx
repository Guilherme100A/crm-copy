// Aba Habilidades (07 §3.3): "Quando" (aviso se vago), ação (disparar fluxo, transferir, etiquetar, preencher campo,
// encerrar, compor mensagem) com os parâmetros de cada tipo e o agendamento (agora, na data dita, se não responder).
import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  flowNamesQuery,
  labelsQuery,
  SKILL_ACTION_TYPES,
  SKILL_SCHEDULE_MODES,
  SKILL_SILENCE_UNITS,
  type AgentSkill,
  type SkillActionType,
} from './api'
import type { TabProps } from './editor-page'
import { newSkill, paramsFor, vagueWhen } from './form'
import { Field, FieldError, inputClass, Section, textareaClass } from './ui'

export function SkillsTab({ draft, set, errors, canEdit }: TabProps) {
  const t = useT('agents')
  const flows = useQuery(flowNamesQuery()).data ?? []
  const labels = useQuery(labelsQuery()).data ?? []
  const update = (i: number, fn: (s: AgentSkill) => AgentSkill) =>
    set((d) => ({ ...d, skills: d.skills.map((s, j) => (j === i ? fn(s) : s)) }))
  const err = (i: number, k: string) => errors[`skills.${i}.${k}`]

  return (
    <Section title={t('skills.title')} hint={t('skills.hint')}>
      {draft.skills.length === 0 ? (
        <p
          data-testid="agent-skills-empty"
          className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground"
        >
          {t('skills.empty')}
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {draft.skills.map((s, i) => (
            <li
              key={i}
              data-testid={`agent-skill-${i}`}
              className={cn('flex min-w-0 flex-col gap-3 rounded-lg border p-3', !s.enabled && 'opacity-70')}
            >
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    role="switch"
                    className="size-4 accent-primary"
                    disabled={!canEdit}
                    checked={s.enabled}
                    onChange={(e) => update(i, (x) => ({ ...x, enabled: e.target.checked }))}
                  />
                  {t('skills.n', { n: i + 1 })}
                </label>
                {canEdit ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto size-8"
                    data-testid={`agent-skill-remove-${i}`}
                    aria-label={t('common.remove')}
                    onClick={() => set((d) => ({ ...d, skills: d.skills.filter((_, j) => j !== i) }))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                ) : null}
              </div>
              <Field
                label={t('skills.when')}
                path={`skills.${i}.when_text`}
                error={err(i, 'when_text')}
                hint={vagueWhen(s.when_text) ? t('skills.vague') : undefined}
              >
                {(p) => (
                  <textarea
                    {...p}
                    rows={2}
                    data-testid={`agent-skill-when-${i}`}
                    className={textareaClass}
                    disabled={!canEdit}
                    value={s.when_text}
                    placeholder={t('skills.whenPlaceholder')}
                    onChange={(e) => update(i, (x) => ({ ...x, when_text: e.target.value }))}
                  />
                )}
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t('skills.action')} path={`skills.${i}.action_type`} error={err(i, 'action_type')}>
                  {(p) => (
                    <select
                      {...p}
                      data-testid={`agent-skill-action-${i}`}
                      className={inputClass}
                      disabled={!canEdit}
                      value={s.action_type}
                      onChange={(e) => {
                        const type = e.target.value as SkillActionType
                        update(i, (x) => ({ ...x, action_type: type, action_params: paramsFor(type, {}) }))
                      }}
                    >
                      {SKILL_ACTION_TYPES.map((a) => (
                        <option key={a} value={a}>
                          {t(`actions.${a}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {s.action_type === 'trigger_flow' ? (
                  <Field
                    label={t('skills.flow')}
                    path={`skills.${i}.action_params.flow_id`}
                    error={err(i, 'action_params.flow_id') ?? err(i, 'action_params')}
                  >
                    {(p) => (
                      <select
                        {...p}
                        className={inputClass}
                        disabled={!canEdit}
                        value={String(s.action_params.flow_id ?? '')}
                        onChange={(e) =>
                          update(i, (x) => ({ ...x, action_params: { ...x.action_params, flow_id: e.target.value } }))
                        }
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
                {s.action_type === 'apply_label' ? (
                  <div className="grid grid-cols-[7rem_1fr] gap-2">
                    <Field label={t('skills.labelMode')} path={`skills.${i}.action_params.mode`}>
                      {(p) => (
                        <select
                          {...p}
                          className={inputClass}
                          disabled={!canEdit}
                          value={String(s.action_params.mode ?? 'add')}
                          onChange={(e) =>
                            update(i, (x) => ({ ...x, action_params: { ...x.action_params, mode: e.target.value } }))
                          }
                        >
                          <option value="add">{t('skills.add')}</option>
                          <option value="remove">{t('skills.remove')}</option>
                        </select>
                      )}
                    </Field>
                    <Field
                      label={t('skills.label')}
                      path={`skills.${i}.action_params.label_id`}
                      error={err(i, 'action_params.label_id')}
                    >
                      {(p) => (
                        <select
                          {...p}
                          className={inputClass}
                          disabled={!canEdit}
                          value={String(s.action_params.label_id ?? '')}
                          onChange={(e) =>
                            update(i, (x) => ({
                              ...x,
                              action_params: { ...x.action_params, label_id: e.target.value || null },
                            }))
                          }
                        >
                          <option value="">{t('common.choose')}</option>
                          {labels.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  </div>
                ) : null}
              </div>
              {s.action_type === 'trigger_flow' ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    disabled={!canEdit}
                    checked={s.action_params.return_to_agent === true}
                    onChange={(e) =>
                      update(i, (x) => ({
                        ...x,
                        action_params: { ...x.action_params, return_to_agent: e.target.checked },
                      }))
                    }
                  />
                  {t('skills.returnToAgent')}
                </label>
              ) : null}
              {s.action_type === 'compose_message' ? (
                <p className="text-xs text-muted-foreground">{t('skills.composeHint')}</p>
              ) : null}
              <div className="flex flex-wrap items-end gap-2">
                <Field label={t('skills.schedule')} path={`skills.${i}.schedule_mode`} error={err(i, 'schedule_mode')}>
                  {(p) => (
                    <select
                      {...p}
                      className={cn(inputClass, 'w-56')}
                      disabled={!canEdit}
                      value={s.schedule_mode}
                      onChange={(e) =>
                        update(i, (x) => ({ ...x, schedule_mode: e.target.value as AgentSkill['schedule_mode'] }))
                      }
                    >
                      {SKILL_SCHEDULE_MODES.map((m) => (
                        <option key={m} value={m}>
                          {t(`schedule.${m}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {s.schedule_mode === 'if_silent' ? (
                  <>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      aria-label={t('skills.silenceAmount')}
                      className={cn(inputClass, 'w-20')}
                      disabled={!canEdit}
                      value={s.silence_amount}
                      onChange={(e) => update(i, (x) => ({ ...x, silence_amount: Number(e.target.value) }))}
                    />
                    <select
                      aria-label={t('skills.silenceUnit')}
                      className={cn(inputClass, 'w-28')}
                      disabled={!canEdit}
                      value={s.silence_unit}
                      onChange={(e) =>
                        update(i, (x) => ({ ...x, silence_unit: e.target.value as AgentSkill['silence_unit'] }))
                      }
                    >
                      {SKILL_SILENCE_UNITS.map((u) => (
                        <option key={u} value={u}>
                          {t(`units.${u}`)}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}
              </div>
              {err(i, 'silence_amount') !== undefined ? (
                <FieldError path={`skills.${i}.silence_amount`} message={err(i, 'silence_amount')!} />
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {errors.skills !== undefined ? <FieldError path="skills" message={errors.skills} /> : null}
      {canEdit ? (
        <Button
          variant="outline"
          data-testid="agent-skill-add"
          className="self-start"
          onClick={() => set((d) => ({ ...d, skills: [...d.skills, newSkill()] }))}
        >
          <Plus aria-hidden /> {t('skills.addSkill')}
        </Button>
      ) : null}
    </Section>
  )
}
