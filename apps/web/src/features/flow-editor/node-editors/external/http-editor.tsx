// Editor da Integração HTTP (AC-T57-04; 06 §3.6 `make_http_request`): método, URL com variáveis, headers (linhas
// nome/valor), corpo (POST/PUT; texto ou JSON com variáveis) e mapeamento da resposta (variável ← caminho com ponto).
// Saídas `success`/`failure`. Não há "testar requisição": o editor nunca chama a URL configurada.
import type { FlowAction } from '@crm/shared/flows'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import type { NodeEditorProps } from '../registry'
import { DraftStatus, ErrorText, Field, iconButton, inputClass, Notice, NS, OutputsSummary, Section, Select, smallButton, useActionsDraft, VarText } from '../logic/kit'
import { ensureAction, findAction, setField, str, type FieldErrors } from '../logic/rules'
import { bodyLooksBroken, HTTP_METHODS, isClean, mappingErrors, recordOf, rowsErrors, rowsOf, withMethod, type Row } from './external-rules'

const TYPE = 'make_http_request'
const normalize = (items: FlowAction[]) => ensureAction(items, [TYPE], () => ({ request_method: 'POST', request_url: '' }))

export function HttpEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, [TYPE])
  const config = action?.config ?? {}
  const headers = useRows(config.request_headers, nodeId, rowsErrors)
  const mapping = useRows(config.response_mapping, nodeId, mappingErrors)
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const method = (str(c, 'request_method') || 'POST') as (typeof HTTP_METHODS)[number]
  const body = typeof c.request_body === 'string' ? c.request_body : c.request_body && typeof c.request_body === 'object' ? JSON.stringify(c.request_body, null, 2) : ''
  const set = (key: string, value: unknown) => patchConfig(action.id, (cfg) => setField(cfg, key, value))
  const commitRows = (key: 'request_headers' | 'response_mapping', rows: Row[], check: (r: readonly Row[]) => FieldErrors) => {
    if (isClean(check(rows))) set(key, recordOf(rows))
  }

  return (
    <div data-testid="ne-http" className="flex flex-col gap-2">
      <Field label={t('http.method')} path="request_method" errors={errs}>
        {({ id }) => (
          <Select
            id={id}
            testId="ne-http-method"
            value={method}
            options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
            disabled={readOnly}
            onChange={(v) => patchConfig(action.id, (cfg) => withMethod(cfg, v as (typeof HTTP_METHODS)[number]))}
          />
        )}
      </Field>
      <VarText
        label={t('http.url')}
        path="request_url"
        errors={errs}
        testId="ne-http-url"
        value={str(c, 'request_url')}
        disabled={readOnly}
        placeholder="https://api.exemplo.com/leads?tel={phone_number}"
        hint={t('http.urlHint')}
        mono
        onChange={(v) => set('request_url', v)}
      />

      <RowsSection
        title={t('http.headers')}
        prefix="ne-http-header"
        rows={headers.rows}
        errors={headers.errors}
        keyLabel={t('http.headerName')}
        valueLabel={t('http.headerValue')}
        keyPlaceholder="Authorization"
        valuePlaceholder="Bearer {g_token}"
        readOnly={readOnly}
        onChange={(rows) => {
          headers.setRows(rows)
          commitRows('request_headers', rows, rowsErrors)
        }}
      />

      {method === 'GET' ? null : (
        <>
          <VarText
            label={t('http.body')}
            path="request_body"
            errors={errs}
            testId="ne-http-body"
            value={body}
            disabled={readOnly}
            multiline
            mono
            placeholder={'{"telefone": "{phone_number}"}'}
            hint={t('http.bodyHint')}
            onChange={(v) => set('request_body', v.trim() ? v : undefined)}
          />
          {bodyLooksBroken(body) ? (
            <Notice testId="ne-http-body-warning" tone="warn">
              {t('http.bodyWarning')}
            </Notice>
          ) : null}
        </>
      )}

      <RowsSection
        title={t('http.mapping')}
        hint={t('http.mappingHint')}
        prefix="ne-http-map"
        rows={mapping.rows}
        errors={mapping.errors}
        keyLabel={t('http.mapVariable')}
        valueLabel={t('http.mapPath')}
        keyPlaceholder="status_pedido"
        valuePlaceholder="data.status"
        readOnly={readOnly}
        onChange={(rows) => {
          mapping.setRows(rows)
          commitRows('response_mapping', rows, mappingErrors)
        }}
      />
      <OutputsSummary type="integration" actions={draft} label={(h) => t(`outputs.handles.${h}`)} />
      <DraftStatus blocked={blocked || !isClean(headers.errors) || !isClean(mapping.errors)} />
    </div>
  )
}

/** Linhas locais de um `record` da config: ficam no editor enquanto têm erro; sem erro, viram o `record` salvo. */
function useRows(record: unknown, nodeId: string, check: (rows: readonly Row[]) => FieldErrors) {
  const [rows, setRows] = useState<Row[]>(() => rowsOf(record))
  const saved = JSON.stringify(recordOf(rowsOf(record)) ?? null)
  // Outro nó, desfazer ou realtime: a config mudou por fora → as linhas voltam a ser a config.
  useEffect(() => {
    setRows((cur) => (JSON.stringify(recordOf(cur) ?? null) === saved && isClean(check(cur)) ? cur : rowsOf(JSON.parse(saved))))
  }, [saved, nodeId, check])
  return { rows, setRows, errors: check(rows) }
}

function RowsSection({
  title,
  hint,
  prefix,
  rows,
  errors,
  keyLabel,
  valueLabel,
  keyPlaceholder,
  valuePlaceholder,
  readOnly,
  onChange,
}: {
  title: string
  hint?: string
  prefix: string
  rows: Row[]
  errors: FieldErrors
  keyLabel: string
  valueLabel: string
  keyPlaceholder: string
  valuePlaceholder: string
  readOnly: boolean
  onChange: (rows: Row[]) => void
}) {
  const t = useT(NS)
  const patch = (i: number, p: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)))
  return (
    <Section
      title={title}
      testId={`${prefix}s`}
      actions={
        <button type="button" data-testid={`${prefix}-add`} disabled={readOnly} onClick={() => onChange([...rows, { key: '', value: '' }])} className={smallButton}>
          <Plus className="size-3.5" aria-hidden /> {t('common.add')}
        </button>
      }
    >
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      {rows.length === 0 ? <p className="text-[11px] text-muted-foreground">{t('http.none')}</p> : null}
      {rows.map((r, i) => (
        <div key={i} data-testid={`${prefix}-${i}`} className="flex flex-col gap-0.5">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-1">
            <input
              data-testid={`${prefix}-${i}-key`}
              aria-label={keyLabel}
              placeholder={keyPlaceholder}
              className={cn(inputClass, 'font-mono text-xs')}
              aria-invalid={!!errors[`${i}.key`]}
              value={r.key}
              disabled={readOnly}
              onChange={(e) => patch(i, { key: e.target.value })}
            />
            <input
              data-testid={`${prefix}-${i}-value`}
              aria-label={valueLabel}
              placeholder={valuePlaceholder}
              className={cn(inputClass, 'font-mono text-xs')}
              aria-invalid={!!errors[`${i}.value`]}
              value={r.value}
              disabled={readOnly}
              onChange={(e) => patch(i, { value: e.target.value })}
            />
            <button type="button" data-testid={`${prefix}-${i}-remove`} aria-label={t('common.remove')} disabled={readOnly} onClick={() => onChange(rows.filter((_, j) => j !== i))} className={iconButton}>
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </div>
          <ErrorText path={`${prefix.replace('ne-', '')}-${i}-key`} error={errors[`${i}.key`]} />
          <ErrorText path={`${prefix.replace('ne-', '')}-${i}-value`} error={errors[`${i}.value`]} />
        </div>
      ))}
    </Section>
  )
}

