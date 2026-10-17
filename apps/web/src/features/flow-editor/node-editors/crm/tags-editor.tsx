// Editor do nó Etiquetas (AC-T57-03; 06 §3.6 `add_tags`/`remove_tags`): adicionar ou remover, com as etiquetas reais
// da empresa (`GET /api/labels`) e a opção de digitar um nome novo (no adicionar o motor cria a etiqueta). Grava NOMES.
import type { FlowAction } from '@crm/shared/flows'
import { useQuery } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { labelsQuery } from '../logic/api'
import { DraftStatus, ErrorText, Field, inputClass, ListNotice, NS, Select, smallButton, useActionsDraft } from '../logic/kit'
import { ensureAction, findAction, setField, strings, switchAction } from '../logic/rules'
import { addTag, isNewTag, removeTag, TAG_ACTIONS, tagConfig, type TagAction } from './crm-rules'

const normalize = (items: FlowAction[]) => ensureAction(items, TAG_ACTIONS, () => tagConfig('add_tags'))

export function TagsEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const q = useQuery(labelsQuery())
  const [typed, setTyped] = useState('')
  const newId = useId()
  const { draft, errors, blocked, update, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, TAG_ACTIONS)
  if (!action) return null
  const mode = action.type as TagAction
  const errs = errors[action.id]
  const tags = strings(action.config.tags)
  const labels = q.data?.items ?? []
  const color = new Map(labels.map((l) => [l.name.trim().toLowerCase(), l.color]))
  const setTags = (next: string[]) => patchConfig(action.id, (cfg) => setField(cfg, 'tags', next))
  const addTyped = () => {
    if (!typed.trim()) return
    setTags(addTag(tags, typed))
    setTyped('')
  }

  return (
    <div data-testid="ne-tags" className="flex flex-col gap-2">
      <Field label={t('tags.mode')} path="action" errors={errs}>
        {({ id }) => (
          <Select
            id={id}
            testId="ne-tags-mode"
            value={mode}
            options={TAG_ACTIONS.map((v) => ({ value: v, label: t(`tags.modes.${v}`) }))}
            disabled={readOnly}
            onChange={(v) => update(switchAction(draft, action.id, v, tagConfig(v as TagAction, tags)))}
          />
        )}
      </Field>
      <Field label={t('tags.pick')} path="tags.pick" errors={undefined}>
        {({ id }) => (
          <Select
            id={id}
            testId="ne-tags-select"
            value=""
            placeholder={t('tags.pickPlaceholder')}
            options={labels.map((l) => ({ value: l.name, label: l.name, testId: `ne-tags-option-${l.id}`, disabled: tags.some((x) => x.toLowerCase() === l.name.toLowerCase()) }))}
            disabled={readOnly || labels.length === 0}
            onChange={(v) => v && setTags(addTag(tags, v))}
          />
        )}
      </Field>
      <ListNotice name="labels" loading={q.isPending} denied={!!q.data?.denied} empty={!!q.data && !q.data.denied && labels.length === 0} />
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={newId} className="text-xs font-medium">
          {t(mode === 'add_tags' ? 'tags.newAdd' : 'tags.newRemove')}
        </label>
        <div className="flex gap-1.5">
          <input
            id={newId}
            data-testid="ne-tags-new"
            className={inputClass}
            value={typed}
            maxLength={60}
            disabled={readOnly}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTyped()
              }
            }}
          />
          <button type="button" data-testid="ne-tags-new-add" disabled={readOnly || !typed.trim()} onClick={addTyped} className={smallButton}>
            <Plus className="size-3.5" aria-hidden /> {t('common.add')}
          </button>
        </div>
      </div>
      <ul data-testid="ne-tags-chosen" className="flex flex-wrap gap-1">
        {tags.map((name) => (
          <li key={name} data-testid={`ne-tags-chip-${name}`} className="inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
            <span className="size-2 shrink-0 rounded-full" style={{ background: color.get(name.toLowerCase()) ?? 'var(--muted-foreground)' }} aria-hidden />
            <span className="truncate">{name}</span>
            {isNewTag(name, labels) && !q.data?.denied ? (
              <span data-testid={`ne-tags-chip-${name}-new`} className="text-[10px] text-muted-foreground">
                {t(mode === 'add_tags' ? 'tags.willCreate' : 'tags.unknown')}
              </span>
            ) : null}
            <button type="button" data-testid={`ne-tags-remove-${name}`} aria-label={t('tags.unpick', { name })} disabled={readOnly} onClick={() => setTags(removeTag(tags, name))} className="text-muted-foreground hover:text-destructive">
              <X className="size-3" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <ErrorText path="tags" error={errs?.tags} />
      <DraftStatus blocked={blocked} />
    </div>
  )
}
