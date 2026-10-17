// Editor da Conexão de Fluxo (06 §3.6 `execute_flow`): escolhe o fluxo de destino da empresa (`GET /api/flows/names`);
// este fluxo termina e o destino começa. O próprio fluxo não é oferecido (seria um laço sem espera).
import type { FlowAction } from '@crm/shared/flows'
import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { flowNamesQuery } from './api'
import { DraftStatus, Field, ListNotice, Notice, NS, Select, useActionsDraft } from './kit'
import { ensureAction, findAction, setFields, str } from './rules'

const TYPE = 'execute_flow'
const normalize = (items: FlowAction[]) => ensureAction(items, [TYPE], () => ({ target_flow_id: '' }))

export function ConnectionFlowEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const { flowId } = useParams({ strict: false }) as { flowId?: string }
  const q = useQuery(flowNamesQuery())
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, [TYPE])
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const flows = (q.data?.items ?? []).filter((f) => f.id !== flowId)

  return (
    <div data-testid="ne-connection-flow" className="flex flex-col gap-2">
      <Field label={t('flow.target')} path="target_flow_id" errors={errs}>
        {({ id, invalid }) => (
          <Select
            id={id}
            testId="ne-flow-select"
            value={str(c, 'target_flow_id')}
            invalid={invalid}
            placeholder={t('common.choose')}
            options={flows.map((f) => ({ value: f.id, label: f.name, testId: `ne-flow-option-${f.id}` }))}
            disabled={readOnly}
            onChange={(v) => patchConfig(action.id, (cfg) => setFields(cfg, { target_flow_id: v, target_flow_name: flows.find((f) => f.id === v)?.name }))}
          />
        )}
      </Field>
      <ListNotice name="flows" loading={q.isPending} denied={!!q.data?.denied} empty={!!q.data && !q.data.denied && flows.length === 0} />
      <Notice testId="ne-flow-notice">{t('flow.notice')}</Notice>
      <DraftStatus blocked={blocked} />
    </div>
  )
}
