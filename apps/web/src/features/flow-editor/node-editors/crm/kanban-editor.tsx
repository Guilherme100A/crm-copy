// Editor do nó Kanban (AC-T57-03; 06 §3.6 `create_kanban_card`/`remove_kanban_card`): criar o card num quadro/coluna
// reais (`GET /api/crms`, `GET /api/crms/:id/columns`) — com valor só quando a coluna é meta de conversão — ou remover
// o card do quadro (em qualquer etapa).
import type { FlowAction } from '@crm/shared/flows'
import { useQuery } from '@tanstack/react-query'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { boardsQuery, columnsQuery } from '../logic/api'
import { DraftStatus, Field, ListNotice, Notice, NS, Select, useActionsDraft, VarText } from '../logic/kit'
import { ensureAction, findAction, numberOrTemplate, setField, str, switchAction } from '../logic/rules'
import { KANBAN_ACTIONS, kanbanConfig, withBoard, withColumn, type KanbanAction } from './crm-rules'

const normalize = (items: FlowAction[]) => ensureAction(items, KANBAN_ACTIONS, () => kanbanConfig('create_kanban_card', {}))

export function KanbanEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const { draft, errors, blocked, update, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, KANBAN_ACTIONS)
  const crmId = action ? str(action.config, 'crm_id') : ''
  const boards = useQuery(boardsQuery())
  const columns = useQuery(columnsQuery(crmId))
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const mode = action.type as KanbanAction
  const creating = mode === 'create_kanban_card'
  const boardItems = boards.data?.items ?? []
  const columnItems = columns.data?.items ?? []
  const goal = c.crm_column_conversion_goal === true

  return (
    <div data-testid="ne-kanban" className="flex flex-col gap-2">
      <Field label={t('kanban.mode')} path="mode" errors={undefined}>
        {({ id }) => (
          <Select
            id={id}
            testId="ne-kanban-mode"
            value={mode}
            options={KANBAN_ACTIONS.map((v) => ({ value: v, label: t(`kanban.modes.${v}`) }))}
            disabled={readOnly}
            onChange={(v) => update(switchAction(draft, action.id, v, kanbanConfig(v as KanbanAction, c)))}
          />
        )}
      </Field>
      <Field label={t('kanban.board')} path="crm_id" errors={errs}>
        {({ id, invalid }) => (
          <Select
            id={id}
            testId="ne-kanban-board"
            value={crmId}
            invalid={invalid}
            placeholder={t('common.choose')}
            options={boardItems.map((b) => ({ value: b.id, label: b.name, testId: `ne-kanban-board-option-${b.id}` }))}
            disabled={readOnly}
            onChange={(v) => patchConfig(action.id, (cfg) => withBoard(cfg, { id: v, name: boardItems.find((b) => b.id === v)?.name }, creating))}
          />
        )}
      </Field>
      <ListNotice name="boards" loading={boards.isPending} denied={!!boards.data?.denied} empty={!!boards.data && !boards.data.denied && boardItems.length === 0} />
      {creating ? (
        <>
          <Field label={t('kanban.column')} path="crm_column_id" errors={errs}>
            {({ id, invalid }) => (
              <Select
                id={id}
                testId="ne-kanban-column"
                value={str(c, 'crm_column_id')}
                invalid={invalid}
                placeholder={crmId ? t('common.choose') : t('kanban.boardFirst')}
                options={columnItems.map((col) => ({
                  value: col.id,
                  label: col.conversion_goal ? `${col.name} · ${t('kanban.goal')}` : col.name,
                  testId: `ne-kanban-column-option-${col.id}`,
                }))}
                disabled={readOnly || !crmId}
                onChange={(v) => {
                  const col = columnItems.find((x) => x.id === v)
                  patchConfig(action.id, (cfg) => withColumn(cfg, { id: v, name: col?.name, conversion_goal: col?.conversion_goal }))
                }}
              />
            )}
          </Field>
          {crmId ? (
            <ListNotice name="columns" loading={columns.isPending} denied={!!columns.data?.denied} empty={!!columns.data && !columns.data.denied && columnItems.length === 0} />
          ) : null}
          {goal ? (
            <VarText
              label={t('kanban.value')}
              path="value"
              errors={errs}
              testId="ne-kanban-value"
              value={str(c, 'value')}
              disabled={readOnly}
              placeholder="199,90"
              hint={t('kanban.valueHint')}
              onChange={(v) => patchConfig(action.id, (cfg) => setField(cfg, 'value', numberOrTemplate(v)))}
            />
          ) : null}
        </>
      ) : (
        <Notice testId="ne-kanban-remove-notice">{t('kanban.removeNotice')}</Notice>
      )}
      <DraftStatus blocked={blocked} />
    </div>
  )
}
