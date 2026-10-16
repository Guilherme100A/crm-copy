// Editor do agente (`/agentes/novo` e `/agentes/:id`; 07 §2): cabeçalho com nome editável, selo de status, Salvar e
// Publicar/Pausar, e as abas Foto, Instruções, Habilidades, Conhecimento, Coleta de dados e Configurações (aba na
// URL). Erros de validação do servidor (`details.fields[].path`) aparecem no campo e levam à aba do 1º campo.
// No modo criação, salvar faz POST e abre `/agentes/:id`; o que exige id (foto enviada, conhecimento) fica bloqueado.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Loader2, Pause, Rocket, Save } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { AGENTS_KEY, agentKey, agentQuery, agentsApi, type AgentDto } from './api'
import {
  draftOf,
  EDITOR_TABS,
  fieldErrorsOf,
  newDraft,
  nextAction,
  payloadOf,
  sameDraft,
  tabOfField,
  type AgentDraft,
  type EditorTab,
  type FieldErrors,
} from './form'
import { KnowledgeTab } from './knowledge-tab'
import { useAgentPerms } from './list-page'
import { SkillsTab } from './skills-tab'
import { CollectionTab, InstructionsTab, PhotoTab, SettingsTab } from './tabs'
import { FieldError, ModalShell, StatusBadge } from './ui'

export const editorSearchSchema = z.object({ tab: z.enum(EDITOR_TABS).optional().catch(undefined) })
export type EditorSearch = z.infer<typeof editorSearchSchema>

export interface TabProps {
  draft: AgentDraft
  set: (fn: (d: AgentDraft) => AgentDraft) => void
  errors: FieldErrors
  agent: AgentDto | null
  canEdit: boolean
  /** Salva o rascunho (se mudou) antes de uma ação que lê o agente salvo (ex.: gerar prompt). */
  saveFirst: () => Promise<AgentDto | null>
}

export function AgentEditorPage({
  agentId,
  search,
  onSearch,
}: {
  agentId: string | null
  search: EditorSearch
  onSearch: (s: EditorSearch) => void
}) {
  const t = useT('agents')
  const q = useQuery({ ...agentQuery(agentId ?? ''), enabled: !!agentId })
  if (agentId && q.isPending)
    return (
      <section data-testid="agent-editor-loading" className="mx-auto flex w-full max-w-5xl flex-col gap-3" aria-busy>
        <div className="h-10 w-64 animate-pulse rounded bg-muted/50" />
        <div className="h-80 animate-pulse rounded-xl border bg-muted/40" />
      </section>
    )
  if (agentId && q.isError)
    return (
      <section data-testid="agent-editor-error" className="mx-auto flex w-full max-w-5xl flex-col gap-3">
        <p className="text-sm">
          {q.error instanceof HttpError && q.error.status === 404 ? t('editor.notFound') : t('common.error')}
        </p>
        <div className="flex gap-2">
          <Link to="/agentes" className="text-sm underline">
            {t('editor.back')}
          </Link>
          <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      </section>
    )
  return <Editor key={agentId ?? 'new'} agent={q.data ?? null} search={search} onSearch={onSearch} />
}

function Editor({
  agent,
  search,
  onSearch,
}: {
  agent: AgentDto | null
  search: EditorSearch
  onSearch: (s: EditorSearch) => void
}) {
  const t = useT('agents')
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { canEdit } = useAgentPerms()
  const [base, setBaseState] = useState<AgentDraft>(() => (agent ? draftOf(agent) : newDraft()))
  const baseRef = useRef(base)
  const setBase = (next: AgentDraft) => {
    baseRef.current = next
    setBaseState(next)
  }
  const [draft, setDraft] = useState<AgentDraft>(base)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [general, setGeneral] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'status' | null>(null)
  const [limitOpen, setLimitOpen] = useState(false)
  const tab: EditorTab = search.tab ?? 'photo'
  const dirty = !agent || !sameDraft(draft, base)

  // O agente mudou no servidor (publicar/pausar, gerar prompt): o que não foi editado acompanha.
  useEffect(() => {
    if (!agent) return
    const next = draftOf(agent)
    const prev = baseRef.current
    setDraft((cur) => (sameDraft(cur, prev) ? next : cur))
    baseRef.current = next
    setBaseState(next)
  }, [agent])

  const set = (fn: (d: AgentDraft) => AgentDraft) => setDraft((d) => fn(d))

  const showErrors = (err: unknown): boolean => {
    if (err instanceof HttpError && err.code === 'LIMIT_REACHED') {
      setLimitOpen(true)
      return true
    }
    if (err instanceof HttpError && (err.code === 'VALIDATION_ERROR' || err.status === 422)) {
      const fe = fieldErrorsOf(err.details)
      setErrors(fe)
      const first = Object.keys(fe)[0]
      if (first) onSearch({ tab: tabOfField(first) === 'photo' ? undefined : tabOfField(first) })
      setGeneral(first ? null : err.message)
      return true
    }
    if (err instanceof HttpError) {
      setGeneral(err.message)
      return true
    }
    return false
  }

  const persist = async (): Promise<AgentDto | null> => {
    setErrors({})
    setGeneral(null)
    try {
      if (!agent) {
        const created = await agentsApi.create(payloadOf(draft))
        qc.setQueryData(agentKey(created.id), created)
        void qc.invalidateQueries({ queryKey: [...AGENTS_KEY, 'list'] })
        notify('agents-saved', t('editor.saved'))
        void navigate({
          to: '/agentes/$agentId',
          params: { agentId: created.id },
          search: search.tab ? { tab: search.tab } : {},
          replace: true,
        })
        return created
      }
      const saved = await agentsApi.update(agent.id, payloadOf(draft))
      const next = draftOf(saved)
      setBase(next)
      setDraft(next)
      qc.setQueryData(agentKey(saved.id), saved)
      void qc.invalidateQueries({ queryKey: [...AGENTS_KEY, 'list'] })
      return saved
    } catch (err) {
      if (!showErrors(err)) notify('agents-error', t('common.error'))
      return null
    }
  }

  const save = async () => {
    setBusy('save')
    const saved = await persist()
    setBusy(null)
    if (saved && agent) notify('agents-saved', t('editor.saved'))
  }

  const saveFirst = async () => (agent && !dirty ? agent : persist())

  const toggleStatus = async () => {
    if (!agent) return
    setBusy('status')
    try {
      if (dirty && !(await persist())) return
      const action = nextAction(agent.status)
      const next = action === 'publish' ? await agentsApi.publish(agent.id) : await agentsApi.pause(agent.id)
      qc.setQueryData(agentKey(next.id), next)
      void qc.invalidateQueries({ queryKey: [...AGENTS_KEY, 'list'] })
      notify('agents-status', t(action === 'publish' ? 'editor.published' : 'editor.paused'))
    } catch (err) {
      if (!showErrors(err)) notify('agents-error', t('common.error'))
    } finally {
      setBusy(null)
    }
  }

  const props: TabProps = { draft, set, errors, agent, canEdit, saveFirst }
  const errorTabs = new Set(Object.keys(errors).map(tabOfField))

  return (
    <section data-testid="agent-editor" className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-wrap items-center gap-3">
        <Link
          to="/agentes"
          aria-label={t('editor.back')}
          className="flex size-9 shrink-0 items-center justify-center rounded-md border hover:bg-accent"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </Link>
        <div className="flex min-w-0 flex-1 basis-[calc(100%-3rem)] flex-col sm:basis-auto">
          <input
            data-testid="agent-name"
            aria-label={t('fields.name')}
            aria-invalid={errors.name !== undefined ? true : undefined}
            value={draft.name}
            disabled={!canEdit}
            maxLength={80}
            onChange={(e) => set((d) => ({ ...d, name: e.target.value }))}
            className="h-10 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 text-xl font-semibold outline-none hover:border-border focus-visible:border-border focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
          />
          {errors.name !== undefined ? <FieldError path="name" message={errors.name} /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {agent ? (
            <StatusBadge status={agent.status} testId="agent-status" />
          ) : (
            <StatusBadge status="draft" testId="agent-status" />
          )}
          {canEdit ? (
            <>
              {agent && agent.status === 'active' ? (
                <Button
                  variant="outline"
                  data-testid="agent-pause"
                  disabled={busy !== null}
                  onClick={() => void toggleStatus()}
                >
                  {busy === 'status' ? <Loader2 className="animate-spin" aria-hidden /> : <Pause aria-hidden />}{' '}
                  {t('editor.pause')}
                </Button>
              ) : agent ? (
                <Button
                  variant="outline"
                  data-testid="agent-publish"
                  disabled={busy !== null}
                  onClick={() => void toggleStatus()}
                >
                  {busy === 'status' ? <Loader2 className="animate-spin" aria-hidden /> : <Rocket aria-hidden />}{' '}
                  {t('editor.publish')}
                </Button>
              ) : null}
              <Button
                data-testid="agent-save"
                disabled={busy !== null || (!!agent && !dirty)}
                onClick={() => void save()}
              >
                {busy === 'save' ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}{' '}
                {t('editor.save')}
              </Button>
            </>
          ) : null}
        </div>
      </header>

      {general ? (
        <p
          data-testid="agent-save-error"
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {general}
        </p>
      ) : null}
      {!agent ? <p className="text-xs text-muted-foreground">{t('editor.unsavedHint')}</p> : null}

      <div role="tablist" className="-mx-4 flex gap-1 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0">
        {EDITOR_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-testid={`agent-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`agent-panel-${id}`}
            onClick={() => onSearch({ tab: id === 'photo' ? undefined : id })}
            className={cn(
              '-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap',
              tab === id ? 'border-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
              errorTabs.has(id) && 'text-destructive',
            )}
          >
            {t(`tabs.${id}`)}
            {errorTabs.has(id) ? (
              <span className="ml-1 inline-block size-1.5 rounded-full bg-destructive align-middle" aria-hidden />
            ) : null}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`agent-panel-${tab}`} data-testid={`agent-panel-${tab}`} className="min-w-0">
        {tab === 'photo' ? <PhotoTab {...props} /> : null}
        {tab === 'instructions' ? <InstructionsTab {...props} /> : null}
        {tab === 'skills' ? <SkillsTab {...props} /> : null}
        {tab === 'knowledge' ? <KnowledgeTab {...props} /> : null}
        {tab === 'collection' ? <CollectionTab {...props} /> : null}
        {tab === 'settings' ? <SettingsTab {...props} /> : null}
      </div>

      <ModalShell
        open={limitOpen}
        onClose={() => setLimitOpen(false)}
        testId="agents-limit-modal"
        title={t('limit.title')}
      >
        <p className="text-sm text-muted-foreground">{t('limit.bodyGeneric')}</p>
        <div className="flex justify-end">
          <Button data-testid="agents-limit-close" onClick={() => setLimitOpen(false)}>
            {t('common.ok')}
          </Button>
        </div>
      </ModalShell>
    </section>
  )
}
