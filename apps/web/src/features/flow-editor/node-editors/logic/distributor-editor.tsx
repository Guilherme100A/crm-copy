// Editor do Distribuidor (AC-T57-02; 06 §3.6 `distribute_contacts`): ≥ 2 saídas com nome e quantidade (peso do
// round-robin do motor; 0 = nunca), a fatia em % de cada uma, "sempre a próxima" e "evitar repetição". O id de cada
// saída é gerado uma vez (`outputId`) e vira o handle `output:<id>`: renomear, reordenar ou remover outra saída não
// desliga as arestas.
import type { FlowAction } from '@crm/shared/flows'
import { Plus, Trash2 } from 'lucide-react'
import { useCallback } from 'react'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { Check, DraftStatus, ErrorText, iconButton, inputClass, NS, NumberInput, OutputsSummary, smallButton, useActionsDraft } from './kit'
import { addDistOutput, defaultDistributor, distOutputs, distShares, patchDistOutput, removeDistOutput } from './logic-rules'
import { bool, ensureAction, findAction, intOf, setField } from './rules'

const TYPE = 'distribute_contacts'

export function DistributorEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const normalize = useCallback((items: FlowAction[]) => ensureAction(items, [TYPE], () => defaultDistributor((n) => t('dist.outputName', { n }))), [t])
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, [TYPE])
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const outputs = distOutputs(c)
  const shares = distShares(outputs)
  const names = new Map(outputs.map((o) => [`output:${o.id}`, o.name || o.id]))

  return (
    <div data-testid="ne-distributor" className="flex flex-col gap-2">
      <p className="text-[11px] text-muted-foreground">{t('dist.hint')}</p>
      <ul data-testid="ne-dist-outputs" className="flex flex-col gap-1.5">
        {outputs.map((o, i) => (
          <li key={o.id} data-testid={`ne-dist-row-${o.id}`} className="flex min-w-0 flex-col gap-1 rounded-md border p-1.5">
            <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_auto] items-center gap-1.5">
              <input
                data-testid={`ne-dist-output-${o.id}`}
                aria-label={t('dist.name')}
                className={inputClass}
                value={o.name ?? ''}
                maxLength={60}
                disabled={readOnly}
                onChange={(e) => patchConfig(action.id, (cfg) => patchDistOutput(cfg, o.id, { name: e.target.value }))}
              />
              <NumberInput
                testId={`ne-dist-qty-${o.id}`}
                min={0}
                value={o.quantity === undefined ? '' : String(o.quantity)}
                invalid={!!errs?.[`outputs.${i}.quantity`]}
                disabled={readOnly}
                onChange={(raw) => patchConfig(action.id, (cfg) => patchDistOutput(cfg, o.id, { quantity: intOf(raw) }))}
              />
              <button
                type="button"
                data-testid={`ne-dist-remove-${o.id}`}
                aria-label={t('dist.remove')}
                disabled={readOnly || outputs.length <= 2}
                onClick={() => patchConfig(action.id, (cfg) => removeDistOutput(cfg, o.id))}
                className={iconButton}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                <div className="h-full bg-primary" style={{ width: `${shares[o.id] ?? 0}%` }} />
              </div>
              <span data-testid={`ne-dist-share-${o.id}`} className="w-12 text-right text-[11px] text-muted-foreground tabular-nums">
                {`${shares[o.id] ?? 0}%`}
              </span>
            </div>
            <ErrorText path={`outputs.${i}.quantity`} error={errs?.[`outputs.${i}.quantity`]} />
          </li>
        ))}
      </ul>
      <ErrorText path="outputs" error={errs?.outputs} />
      <button
        type="button"
        data-testid="ne-dist-add"
        disabled={readOnly}
        onClick={() => patchConfig(action.id, (cfg) => addDistOutput(cfg, t('dist.outputName', { n: outputs.length + 1 })))}
        className={smallButton}
      >
        <Plus className="size-3.5" aria-hidden /> {t('dist.add')}
      </button>
      <Check
        label={t('dist.alwaysNext')}
        testId="ne-dist-always-next"
        checked={bool(c, 'distribute_always_next')}
        disabled={readOnly}
        onChange={(v) => patchConfig(action.id, (cfg) => setField(cfg, 'distribute_always_next', v))}
      />
      <Check
        label={t('dist.preventRepetition')}
        testId="ne-dist-prevent-repetition"
        checked={bool(c, 'prevent_repetition')}
        disabled={readOnly}
        onChange={(v) => patchConfig(action.id, (cfg) => setField(cfg, 'prevent_repetition', v))}
      />
      <OutputsSummary type="distributor" actions={draft} label={(h) => names.get(h) ?? h} />
      <DraftStatus blocked={blocked} />
    </div>
  )
}
