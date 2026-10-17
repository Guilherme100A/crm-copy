// Editores de uma escolha do grupo CRM (AC-T57-03; 06 §3.6): Controlador de chat (`change_chat_status`),
// Departamento (`set_department`, lista real de `GET /api/departments/all`) e Agente de IA (`control_ai_agent`,
// lista real de `GET /api/ai-agents`).
import type { FlowAction } from '@crm/shared/flows'
import { useQuery } from '@tanstack/react-query'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { agentsQuery, departmentsQuery } from '../logic/api'
import { DraftStatus, Field, ListNotice, Notice, NS, Select, useActionsDraft } from '../logic/kit'
import { ensureAction, findAction, setField, setFields, str } from '../logic/rules'
import { AGENT_MODES, CHAT_STATUS_VALUES, withAgentMode } from './crm-rules'

// ---------------------------------------------------------------- Controlador de chat

const CHAT = 'change_chat_status'
const normalizeChat = (items: FlowAction[]) => ensureAction(items, [CHAT], () => ({ chat_status: 'Atendimento' }))

export function ChatControllerEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize: normalizeChat })
  const action = findAction(draft, [CHAT])
  if (!action) return null
  return (
    <div data-testid="ne-chat-controller" className="flex flex-col gap-2">
      <Field label={t('chat.status')} path="chat_status" errors={errors[action.id]}>
        {({ id, invalid }) => (
          <Select
            id={id}
            testId="ne-chat-status"
            value={str(action.config, 'chat_status')}
            invalid={invalid}
            options={CHAT_STATUS_VALUES.map((v) => ({ value: v, label: t(`chat.statuses.${v}`) }))}
            disabled={readOnly}
            onChange={(v) => patchConfig(action.id, (cfg) => setField(cfg, 'chat_status', v))}
          />
        )}
      </Field>
      <DraftStatus blocked={blocked} />
    </div>
  )
}

// ---------------------------------------------------------------- Departamento

const DEPT = 'set_department'
const normalizeDept = (items: FlowAction[]) => ensureAction(items, [DEPT], () => ({ department_id: '' }))

export function DepartmentEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const q = useQuery(departmentsQuery())
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize: normalizeDept })
  const action = findAction(draft, [DEPT])
  if (!action) return null
  const items = q.data?.items ?? []
  const current = str(action.config, 'department_id')
  return (
    <div data-testid="ne-department" className="flex flex-col gap-2">
      <Field label={t('dept.label')} path="department_id" errors={errors[action.id]}>
        {({ id, invalid }) => (
          <Select
            id={id}
            testId="ne-dept-select"
            value={current}
            invalid={invalid}
            placeholder={t('common.choose')}
            options={items.map((d) => ({ value: d.id, label: d.name, testId: `ne-dept-option-${d.id}` }))}
            disabled={readOnly}
            onChange={(v) => {
              const d = items.find((x) => x.id === v)
              patchConfig(action.id, (cfg) => setFields(cfg, { department_id: v, department_name: d?.name, department_color: d?.color ?? undefined }))
            }}
          />
        )}
      </Field>
      <ListNotice name="departments" loading={q.isPending} denied={!!q.data?.denied} empty={!!q.data && !q.data.denied && items.length === 0} />
      <DraftStatus blocked={blocked} />
    </div>
  )
}

// ---------------------------------------------------------------- Agente de IA

const AGENT = 'control_ai_agent'
const normalizeAgent = (items: FlowAction[]) => ensureAction(items, [AGENT], () => ({ mode: 'activate', agent_id: '' }))

export function AiAgentEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const q = useQuery(agentsQuery())
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize: normalizeAgent })
  const action = findAction(draft, [AGENT])
  if (!action) return null
  const errs = errors[action.id]
  const mode = (str(action.config, 'mode') || 'activate') as (typeof AGENT_MODES)[number]
  const agents = q.data?.items ?? []
  return (
    <div data-testid="ne-ai-agent" className="flex flex-col gap-2">
      <Field label={t('agent.mode')} path="mode" errors={errs}>
        {({ id }) => (
          <Select
            id={id}
            testId="ne-agent-mode"
            value={mode}
            options={AGENT_MODES.map((v) => ({ value: v, label: t(`agent.modes.${v}`) }))}
            disabled={readOnly}
            onChange={(v) => patchConfig(action.id, (cfg) => withAgentMode(cfg, v as (typeof AGENT_MODES)[number]))}
          />
        )}
      </Field>
      {mode === 'activate' ? (
        <>
          <Field label={t('agent.label')} path="agent_id" errors={errs}>
            {({ id, invalid }) => (
              <Select
                id={id}
                testId="ne-agent-select"
                value={str(action.config, 'agent_id')}
                invalid={invalid}
                placeholder={t('common.choose')}
                options={agents.map((a) => ({ value: a.id, label: a.status === 'active' ? a.name : `${a.name} (${t(`agent.statuses.${a.status}`)})`, testId: `ne-agent-option-${a.id}` }))}
                disabled={readOnly}
                onChange={(v) => patchConfig(action.id, (cfg) => setField(cfg, 'agent_id', v))}
              />
            )}
          </Field>
          <ListNotice name="agents" loading={q.isPending} denied={!!q.data?.denied} empty={!!q.data && !q.data.denied && agents.length === 0} />
        </>
      ) : (
        <Notice testId="ne-agent-deactivate-notice">{t('agent.deactivateNotice')}</Notice>
      )}
      <DraftStatus blocked={blocked} />
    </div>
  )
}
