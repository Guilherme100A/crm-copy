// Aba Conhecimento (07 §3.4): fontes do agente com o estado de cada uma (lendo → pronto | falhou), atualizado pelo
// SSE `ai_knowledge_source.updated` (AC-T88-04); adicionar site, texto, FAQ, arquivo (PDF/TXT/MD/CSV ≤ 8 MB) ou
// fluxo, respeitando os limites por slot; ler de novo e excluir. Exige o agente salvo.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Globe,
  ListChecks,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Workflow,
} from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { cn } from '@/lib/utils'
import {
  agentsApi,
  flowNamesQuery,
  KNOWLEDGE_SLOT_LIMITS,
  knowledgeKey,
  knowledgeQuery,
  type KnowledgeSource,
} from './api'
import type { TabProps } from './editor-page'
import { inputClass, Section, textareaClass } from './ui'

const FILE_MAX = 8 * 1024 * 1024

/** Códigos de falha da ingestão (07 §3.4) com texto próprio; o resto vira "generic". */
export const KNOWLEDGE_ERROR_CODES = [
  'too_large',
  'unsupported_file',
  'file_missing',
  'empty',
  'empty_pdf',
  'encrypted_pdf',
  'unreadable_pdf',
  'not_pdf',
  'site_unreachable',
  'empty_site',
  'flow_missing',
] as const
export const knowledgeErrorCode = (code: string | null) =>
  (KNOWLEDGE_ERROR_CODES as readonly string[]).includes(code ?? '') ? code! : 'generic'
type Form = 'text' | 'site' | 'faq' | 'flow' | null

export function KnowledgeTab({ agent, canEdit }: TabProps) {
  const t = useT('agents')
  if (!agent)
    return (
      <Section title={t('knowledge.title')}>
        <p data-testid="agent-knowledge-locked" className="text-sm text-muted-foreground">
          {t('editor.saveFirst')}
        </p>
      </Section>
    )
  return <Knowledge agentId={agent.id} canEdit={canEdit} />
}

function Knowledge({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const t = useT('agents')
  const qc = useQueryClient()
  const q = useQuery(knowledgeQuery(agentId))
  const [form, setForm] = useState<Form>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const sources = q.data ?? []
  const used = (slot: keyof typeof KNOWLEDGE_SLOT_LIMITS) => sources.filter((s) => s.slot === slot).length
  const full = (slot: keyof typeof KNOWLEDGE_SLOT_LIMITS) => used(slot) >= KNOWLEDGE_SLOT_LIMITS[slot]

  const upsert = (src: KnowledgeSource) =>
    qc.setQueryData<KnowledgeSource[]>(knowledgeKey(agentId), (old) => {
      const list = old ?? []
      return list.some((s) => s.id === src.id) ? list.map((s) => (s.id === src.id ? src : s)) : [...list, src]
    })

  const add = async (body: Record<string, unknown> | FormData) => {
    setError(null)
    setPending(true)
    try {
      upsert(await agentsApi.addKnowledge(agentId, body))
      setForm(null)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPending(false)
    }
  }

  const errorText = (err: unknown) => {
    if (!(err instanceof HttpError)) return t('common.error')
    if (err.code === 'LIMIT_REACHED') return t('knowledge.limit')
    if (err.status === 413) return t('knowledge.tooLarge')
    const fields = (err.details as { fields?: { message?: string }[] } | undefined)?.fields
    return fields?.[0]?.message ?? err.message
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Section title={t('knowledge.title')} hint={t('knowledge.hint')}>
        {q.isPending ? (
          <div className="h-16 animate-pulse rounded-lg border bg-muted/40" aria-busy />
        ) : q.isError ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="flex-1">{t('common.error')}</span>
            <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : sources.length === 0 ? (
          <p
            data-testid="agent-knowledge-empty"
            className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground"
          >
            {t('knowledge.empty')}
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {sources.map((s) => (
              <SourceRow key={s.id} source={s} canEdit={canEdit} agentId={agentId} onChanged={upsert} />
            ))}
          </ul>
        )}
      </Section>

      {canEdit ? (
        <Section title={t('knowledge.add')}>
          <div className="flex flex-wrap gap-2">
            <AddButton
              testId="agent-knowledge-add-text"
              icon={<FileText />}
              disabled={full('text')}
              onClick={() => setForm('text')}
              label={t('knowledge.kinds.text')}
              count={`${used('text')}/${KNOWLEDGE_SLOT_LIMITS.text}`}
            />
            <AddButton
              testId="agent-knowledge-add-site"
              icon={<Globe />}
              disabled={full('site')}
              onClick={() => setForm('site')}
              label={t('knowledge.kinds.site')}
              count={`${used('site')}/${KNOWLEDGE_SLOT_LIMITS.site}`}
            />
            <AddButton
              testId="agent-knowledge-add-faq"
              icon={<ListChecks />}
              disabled={full('faq')}
              onClick={() => setForm('faq')}
              label={t('knowledge.kinds.faq')}
              count={`${used('faq')}/${KNOWLEDGE_SLOT_LIMITS.faq}`}
            />
            <AddButton
              testId="agent-knowledge-add-flow"
              icon={<Workflow />}
              disabled={full('flow')}
              onClick={() => setForm('flow')}
              label={t('knowledge.kinds.flow')}
              count={`${used('flow')}/${KNOWLEDGE_SLOT_LIMITS.flow}`}
            />
            <AddButton
              testId="agent-knowledge-add-file"
              icon={<Upload />}
              disabled={pending}
              onClick={() => file.current?.click()}
              label={t('knowledge.kinds.file')}
              count={`${used('pdf')}/${KNOWLEDGE_SLOT_LIMITS.pdf}`}
            />
            <input
              ref={file}
              type="file"
              accept=".pdf,.txt,.md,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (!f) return
                if (f.size > FILE_MAX) return setError(t('knowledge.tooLarge'))
                const body = new FormData()
                body.append('kind', 'file')
                body.append('file', f)
                body.append('title', f.name)
                void add(body)
              }}
            />
          </div>
          {form === 'text' ? (
            <TextForm
              pending={pending}
              onCancel={() => setForm(null)}
              onSave={(title, body) => void add({ kind: 'text', title, body })}
            />
          ) : null}
          {form === 'site' ? (
            <SiteForm
              pending={pending}
              onCancel={() => setForm(null)}
              onSave={(url) => void add({ kind: 'site', url })}
            />
          ) : null}
          {form === 'faq' ? (
            <FaqForm
              pending={pending}
              onCancel={() => setForm(null)}
              onSave={(title, items) => void add({ kind: 'faq', title, items })}
            />
          ) : null}
          {form === 'flow' ? (
            <FlowForm
              pending={pending}
              onCancel={() => setForm(null)}
              onSave={(flowId) => void add({ kind: 'flow', flow_id: flowId })}
            />
          ) : null}
          {error ? (
            <p data-testid="agent-knowledge-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </Section>
      ) : null}
    </div>
  )
}

function AddButton({
  testId,
  icon,
  label,
  count,
  disabled,
  onClick,
}: {
  testId: string
  icon: ReactNode
  label: string
  count: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button variant="outline" size="sm" data-testid={testId} disabled={disabled} onClick={onClick}>
      {icon} {label} <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
    </Button>
  )
}

function SourceRow({
  source: s,
  canEdit,
  agentId,
  onChanged,
}: {
  source: KnowledgeSource
  canEdit: boolean
  agentId: string
  onChanged: (s: KnowledgeSource) => void
}) {
  const t = useT('agents')
  const qc = useQueryClient()
  const label = s.title || s.url || s.filename || t(`knowledge.kinds.${s.kind === 'file' ? 'file' : s.kind}`)
  const detail =
    s.status === 'ready'
      ? s.questions_count !== null
        ? t('knowledge.questions', { n: s.questions_count })
        : s.pages_count !== null && (s.slot === 'pdf' || s.slot === 'site')
          ? t(s.pages_count === 1 ? 'knowledge.pagesOne' : 'knowledge.pages', { n: s.pages_count })
          : t('knowledge.status.ready')
      : s.status === 'failed'
        ? t(`knowledgeErrors.${knowledgeErrorCode(s.error_message)}`)
        : t('knowledge.status.pending')
  return (
    <li
      data-testid={`agent-knowledge-source-${s.id}`}
      data-status={s.status}
      className="flex min-w-0 items-center gap-3 p-3"
    >
      <span
        className={cn(
          'shrink-0',
          s.status === 'ready' && 'text-emerald-600',
          s.status === 'failed' && 'text-destructive',
          s.status === 'pending' && 'text-muted-foreground',
        )}
        aria-hidden
      >
        {s.status === 'ready' ? (
          <CheckCircle2 className="size-4" />
        ) : s.status === 'failed' ? (
          <AlertCircle className="size-4" />
        ) : (
          <Loader2 className="size-4 animate-spin" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span
          data-testid={`agent-knowledge-status-${s.id}`}
          className={cn('block truncate text-xs', s.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}
        >
          {t(`knowledge.kinds.${s.slot}`)} · {detail}
        </span>
      </span>
      {canEdit ? (
        <span className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t('knowledge.reindex')}
            data-testid={`agent-knowledge-reindex-${s.id}`}
            disabled={s.status === 'pending'}
            onClick={async () => {
              try {
                onChanged(await agentsApi.reindexKnowledge(agentId, s.id))
              } catch {
                void qc.invalidateQueries({ queryKey: knowledgeKey(agentId) })
              }
            }}
          >
            <RefreshCw aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-destructive"
            aria-label={t('common.remove')}
            data-testid={`agent-knowledge-delete-${s.id}`}
            onClick={async () => {
              try {
                await agentsApi.removeKnowledge(agentId, s.id)
              } finally {
                qc.setQueryData<KnowledgeSource[]>(knowledgeKey(agentId), (old) =>
                  (old ?? []).filter((x) => x.id !== s.id),
                )
              }
            }}
          >
            <Trash2 aria-hidden />
          </Button>
        </span>
      ) : null}
    </li>
  )
}

function FormActions({
  pending,
  onCancel,
  saveTestId,
  disabled,
}: {
  pending: boolean
  onCancel: () => void
  saveTestId: string
  disabled?: boolean
}) {
  const t = useT('agents')
  return (
    <div className="flex justify-end gap-2">
      <Button variant="outline" size="sm" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      <Button type="submit" size="sm" data-testid={saveTestId} disabled={pending || disabled}>
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />} {t('knowledge.save')}
      </Button>
    </div>
  )
}

function TextForm({
  pending,
  onCancel,
  onSave,
}: {
  pending: boolean
  onCancel: () => void
  onSave: (title: string, body: string) => void
}) {
  const t = useT('agents')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border p-3"
      onSubmit={(e) => (e.preventDefault(), onSave(title.trim(), body))}
    >
      <input
        data-testid="agent-knowledge-text-title"
        className={inputClass}
        placeholder={t('knowledge.titlePlaceholder')}
        aria-label={t('knowledge.titlePlaceholder')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        data-testid="agent-knowledge-text-body"
        rows={6}
        className={textareaClass}
        placeholder={t('knowledge.bodyPlaceholder')}
        aria-label={t('knowledge.bodyPlaceholder')}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <FormActions
        pending={pending}
        onCancel={onCancel}
        saveTestId="agent-knowledge-text-save"
        disabled={!body.trim()}
      />
    </form>
  )
}

function SiteForm({
  pending,
  onCancel,
  onSave,
}: {
  pending: boolean
  onCancel: () => void
  onSave: (url: string) => void
}) {
  const t = useT('agents')
  const [url, setUrl] = useState('')
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border p-3"
      onSubmit={(e) => (e.preventDefault(), onSave(url.trim()))}
    >
      <input
        data-testid="agent-knowledge-site-url"
        type="url"
        className={inputClass}
        placeholder="https://"
        aria-label={t('knowledge.kinds.site')}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <FormActions
        pending={pending}
        onCancel={onCancel}
        saveTestId="agent-knowledge-site-save"
        disabled={!url.trim()}
      />
    </form>
  )
}

function FaqForm({
  pending,
  onCancel,
  onSave,
}: {
  pending: boolean
  onCancel: () => void
  onSave: (title: string, items: { q: string; a: string }[]) => void
}) {
  const t = useT('agents')
  const [title, setTitle] = useState('')
  const [items, setItems] = useState([{ q: '', a: '' }])
  const valid = items.filter((i) => i.q.trim() && i.a.trim())
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border p-3"
      onSubmit={(e) => (e.preventDefault(), onSave(title.trim(), valid))}
    >
      <input
        className={inputClass}
        placeholder={t('knowledge.titlePlaceholder')}
        aria-label={t('knowledge.titlePlaceholder')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      {items.map((it, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input
            className={inputClass}
            placeholder={t('knowledge.question')}
            aria-label={t('knowledge.question')}
            value={it.q}
            onChange={(e) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))}
          />
          <input
            className={inputClass}
            placeholder={t('knowledge.answer')}
            aria-label={t('knowledge.answer')}
            value={it.a}
            onChange={(e) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))}
          />
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => setItems((xs) => [...xs, { q: '', a: '' }])}
      >
        <Plus aria-hidden /> {t('knowledge.addQuestion')}
      </Button>
      <FormActions
        pending={pending}
        onCancel={onCancel}
        saveTestId="agent-knowledge-faq-save"
        disabled={valid.length === 0}
      />
    </form>
  )
}

function FlowForm({
  pending,
  onCancel,
  onSave,
}: {
  pending: boolean
  onCancel: () => void
  onSave: (flowId: string) => void
}) {
  const t = useT('agents')
  const flows = useQuery(flowNamesQuery()).data ?? []
  const [flowId, setFlowId] = useState('')
  return (
    <form className="flex flex-col gap-2 rounded-lg border p-3" onSubmit={(e) => (e.preventDefault(), onSave(flowId))}>
      <select
        className={inputClass}
        aria-label={t('knowledge.kinds.flow')}
        value={flowId}
        onChange={(e) => setFlowId(e.target.value)}
      >
        <option value="">{t('common.choose')}</option>
        {flows.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <FormActions pending={pending} onCancel={onCancel} saveTestId="agent-knowledge-flow-save" disabled={!flowId} />
    </form>
  )
}
