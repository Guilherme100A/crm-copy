// Modais da lista de fluxos (06 §2.3): pasta (nome e cor), renomear, mover para pasta, excluir fluxo com o impacto,
// excluir pasta, compartilhar (código copiável) e importar (vários códigos). Erros do servidor viram texto no modal;
// sucessos viram toast. Toda mutação invalida `flowsQuery`.
import { Dialog } from '@base-ui/react/dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Field, FormDialog, inputClass, serverMessage, textareaClass } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  FOLDER_COLORS,
  flowsApi,
  flowsQueryKey,
  referencedConfigs,
  type FlowDto,
  type FlowReference,
  type FolderColor,
  type FolderDto,
  type ImportResult,
} from './api'
import { MAX_IMPORT_CODES, parseCodes } from './model'
import { folderColorClass } from './view'

const NS = 'flows'

function useInvalidate() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: flowsQueryKey })
}

/** Moldura dos modais sem formulário (excluir, compartilhar, importar). */
function Modal({
  testid,
  open,
  title,
  onClose,
  footer,
  children,
}: {
  testid: string
  open: boolean
  title: string
  onClose: () => void
  footer: ReactNode
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid={testid}
          className="fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-background shadow-xl outline-none"
        >
          <Dialog.Title className="border-b px-5 py-4 text-lg font-semibold">{title}</Dialog.Title>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4 text-sm">{children}</div>
          <div className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">{footer}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ---------------------------------------------------------------- pasta

export function FolderDialog({
  open,
  folder,
  parentId,
  onClose,
}: {
  open: boolean
  folder: FolderDto | null
  parentId: string | null
  onClose: () => void
}) {
  const t = useT(NS)
  const invalidate = useInvalidate()
  const [name, setName] = useState('')
  const [color, setColor] = useState<FolderColor>('blue')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (!open) return
    setName(folder?.name ?? '')
    setColor(folder?.color ?? 'blue')
    setError(null)
  }, [open, folder])

  const submit = async () => {
    if (!name.trim()) return setError(t('folder.nameRequired'))
    setPending(true)
    try {
      if (folder) await flowsApi.updateFolder(folder.id, { name: name.trim(), color })
      else await flowsApi.createFolder({ name: name.trim(), color, parent_id: parentId })
      await invalidate()
      notify('success', t(folder ? 'folder.updated' : 'folder.created'))
      onClose()
    } catch (err) {
      setError(serverMessage(err) ?? t('errors.generic'))
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      prefix="flows-folder"
      open={open}
      title={t(folder ? 'folder.editTitle' : 'folder.newTitle')}
      onClose={onClose}
      onSubmit={submit}
      pending={pending}
      error={error}
    >
      <Field label={t('folder.name')} htmlFor="flows-folder-name">
        <input
          id="flows-folder-name"
          data-testid="flows-folder-name"
          className={inputClass}
          value={name}
          maxLength={120}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">{t('folder.color')}</legend>
        <div role="radiogroup" className="flex flex-wrap gap-2">
          {FOLDER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={t(`colors.${c}`)}
              title={t(`colors.${c}`)}
              data-testid={`flows-folder-color-${c}`}
              onClick={() => setColor(c)}
              className={cn(
                'flex size-8 items-center justify-center rounded-full ring-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                folderColorClass(c),
                color === c && 'ring-2 ring-foreground',
              )}
            >
              {color === c ? <Check className="size-4 text-white" aria-hidden /> : null}
            </button>
          ))}
        </div>
      </fieldset>
    </FormDialog>
  )
}

export function DeleteFolderDialog({ folder, onClose }: { folder: FolderDto | null; onClose: () => void }) {
  const t = useT(NS)
  const invalidate = useInvalidate()
  const [pending, setPending] = useState(false)
  return (
    <Modal
      testid="flows-folder-delete"
      open={!!folder}
      title={t('folder.deleteTitle')}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" data-testid="flows-folder-delete-cancel" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="destructive"
            data-testid="flows-folder-delete-confirm"
            disabled={pending}
            onClick={async () => {
              if (!folder) return
              setPending(true)
              try {
                await flowsApi.removeFolder(folder.id)
                await invalidate()
                notify('success', t('folder.deleted'))
                onClose()
              } catch (err) {
                notify('error', serverMessage(err) ?? t('errors.generic'))
              } finally {
                setPending(false)
              }
            }}
          >
            {t('actions.delete')}
          </Button>
        </>
      }
    >
      <p>{t('folder.deleteBody', { name: folder?.name ?? '' })}</p>
    </Modal>
  )
}

// ---------------------------------------------------------------- fluxo: renomear e mover

export function RenameDialog({ flow, onClose }: { flow: FlowDto | null; onClose: () => void }) {
  const t = useT(NS)
  const invalidate = useInvalidate()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    setName(flow?.name ?? '')
    setError(null)
  }, [flow])
  return (
    <FormDialog
      prefix="flows-rename"
      open={!!flow}
      title={t('rename.title')}
      onClose={onClose}
      pending={pending}
      error={error}
      onSubmit={async () => {
        if (!flow) return
        if (!name.trim()) return setError(t('rename.required'))
        setPending(true)
        try {
          await flowsApi.rename(flow.id, name.trim())
          await invalidate()
          notify('success', t('rename.done'))
          onClose()
        } catch (err) {
          setError(serverMessage(err) ?? t('errors.generic'))
        } finally {
          setPending(false)
        }
      }}
    >
      <Field label={t('rename.label')} htmlFor="flows-rename-input">
        <input
          id="flows-rename-input"
          data-testid="flows-rename-input"
          className={inputClass}
          value={name}
          maxLength={120}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </FormDialog>
  )
}

/** "Mover para…": alternativa ao arrasto (principal no mobile). */
export function MoveDialog({
  flow,
  folders,
  onClose,
}: {
  flow: FlowDto | null
  folders: { id: string; label: string }[]
  onClose: () => void
}) {
  const t = useT(NS)
  const invalidate = useInvalidate()
  const [target, setTarget] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    setTarget(flow?.folder_id ?? '')
    setError(null)
  }, [flow])
  return (
    <FormDialog
      prefix="flows-move"
      open={!!flow}
      title={t('move.title')}
      onClose={onClose}
      pending={pending}
      error={error}
      onSubmit={async () => {
        if (!flow) return
        setPending(true)
        try {
          await flowsApi.move(flow.id, target || null)
          await invalidate()
          notify('success', t('move.done'))
          onClose()
        } catch (err) {
          setError(serverMessage(err) ?? t('errors.generic'))
        } finally {
          setPending(false)
        }
      }}
    >
      <Field label={t('move.label')} htmlFor="flows-move-select">
        <select
          id="flows-move-select"
          data-testid="flows-move-select"
          className={inputClass}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">{t('tree.root')}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </Field>
    </FormDialog>
  )
}

// ---------------------------------------------------------------- excluir fluxo (impacto)

export function DeleteFlowDialog({ flow, onClose }: { flow: FlowDto | null; onClose: () => void }) {
  const t = useT(NS)
  const invalidate = useInvalidate()
  const impact = useQuery({
    queryKey: ['flows', 'impact', flow?.id],
    queryFn: () => flowsApi.impact(flow!.id),
    enabled: !!flow,
    staleTime: 0,
    gcTime: 0,
  })
  // Configs que surgiram entre o impacto e a exclusão (409 `flow_referenced`): mostradas e confirmadas com `force`.
  const [late, setLate] = useState<FlowReference[] | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => setLate(null), [flow])

  const data = impact.data
  const configs = late ?? (data ? [...data.connection_flow_configs, ...data.business_hour_configs] : [])
  const force = configs.length > 0

  const confirm = async () => {
    if (!flow) return
    setPending(true)
    try {
      await flowsApi.remove(flow.id, force)
      await invalidate()
      notify('success', t('delete.done'))
      onClose()
    } catch (err) {
      const refs = referencedConfigs(err)
      if (refs) setLate(refs)
      else notify('error', serverMessage(err) ?? t('errors.generic'))
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal
      testid="flows-delete"
      open={!!flow}
      title={t('delete.title')}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" data-testid="flows-delete-cancel" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="destructive"
            data-testid="flows-delete-confirm"
            data-force={force ? 'true' : 'false'}
            disabled={pending || !data}
            onClick={confirm}
          >
            {t(force ? 'delete.confirmForce' : 'actions.delete')}
          </Button>
        </>
      }
    >
      <p>{t('delete.question', { name: flow?.name ?? '' })}</p>
      {impact.isPending ? (
        <p className="text-muted-foreground">{t('delete.loading')}</p>
      ) : impact.isError ? (
        <p role="alert" className="text-destructive">
          {serverMessage(impact.error) ?? t('errors.generic')}
        </p>
      ) : data ? (
        <div data-testid="flows-delete-impact" className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
          <p className="font-medium">{t('delete.impact')}</p>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            <li data-testid="flows-delete-impact-active-runs" data-count={data.active_runs}>
              {t('delete.activeRuns', { n: data.active_runs })}
            </li>
            <li data-testid="flows-delete-impact-total-runs" data-count={data.total_runs}>
              {t('delete.totalRuns', { n: data.total_runs })}
            </li>
            <li data-testid="flows-delete-impact-configs" data-count={configs.length}>
              {t('delete.configs', { n: configs.length })}
              {configs.length ? (
                <ul className="mt-1 flex list-[circle] flex-col gap-0.5 pl-5">
                  {configs.map((c) => (
                    <li key={`${c.kind}:${c.id}`} data-testid={`flows-delete-impact-config-${c.id}`} data-kind={c.kind}>
                      {t(
                        c.kind === 'connection_flow_config' ? 'delete.connectionConfig' : 'delete.businessHourConfig',
                        { name: c.name || c.id },
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
            <li data-testid="flows-delete-impact-refs" data-count={data.referenced_by_flows.length}>
              {t('delete.references', { n: data.referenced_by_flows.length })}
              {data.referenced_by_flows.length ? (
                <ul className="mt-1 flex list-[circle] flex-col gap-0.5 pl-5">
                  {data.referenced_by_flows.map((r) => (
                    <li key={r.id} data-testid={`flows-delete-impact-ref-${r.id}`}>
                      {t('delete.referenceItem', { name: r.name, nodes: r.node_ids.join(', ') })}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          </ul>
          {force ? (
            <p data-testid="flows-delete-force-warning" role="alert" className="text-amber-700 dark:text-amber-400">
              {t('delete.forceWarning')}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t('delete.mediaNote')}</p>
        </div>
      ) : null}
    </Modal>
  )
}

// ---------------------------------------------------------------- compartilhar e importar

export function ShareDialog({ flow, onClose }: { flow: FlowDto | null; onClose: () => void }) {
  const t = useT(NS)
  const code = useQuery({
    queryKey: ['flows', 'share-code', flow?.id],
    queryFn: () => flowsApi.shareCode(flow!.id),
    enabled: !!flow,
  })
  const [copied, setCopied] = useState(false)
  useEffect(() => setCopied(false), [flow])
  const copy = async () => {
    if (!code.data) return
    try {
      await navigator.clipboard.writeText(code.data)
    } catch {
      // Sem permissão de área de transferência: o código continua selecionável na tela.
    }
    setCopied(true)
    notify('success', t('share.copied'))
  }
  return (
    <Modal
      testid="flows-share"
      open={!!flow}
      title={t('share.title')}
      onClose={onClose}
      footer={
        <Button variant="outline" data-testid="flows-share-close" onClick={onClose}>
          {t('actions.close')}
        </Button>
      }
    >
      <p>{t('share.body', { name: flow?.name ?? '' })}</p>
      {code.isError ? (
        <p role="alert" className="text-destructive">
          {serverMessage(code.error) ?? t('errors.generic')}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <code
            data-testid="flows-share-code"
            className="min-w-0 flex-1 rounded-md border bg-muted/40 px-3 py-2 font-mono text-lg tracking-widest select-all"
          >
            {code.data ?? '…'}
          </code>
          <Button
            data-testid="flows-share-copy"
            variant="outline"
            disabled={!code.data}
            onClick={copy}
            aria-label={t('share.copy')}
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {t(copied ? 'share.copiedShort' : 'share.copy')}
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('share.note')}</p>
    </Modal>
  )
}

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT(NS)
  const invalidate = useInvalidate()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (!open) return
    setText('')
    setError(null)
    setResult(null)
  }, [open])
  const codes = parseCodes(text)

  const submit = async () => {
    if (!codes.length) return setError(t('import.required'))
    if (codes.length > MAX_IMPORT_CODES) return setError(t('import.tooMany', { max: MAX_IMPORT_CODES }))
    setPending(true)
    setError(null)
    try {
      const res = await flowsApi.importCodes(codes)
      setResult(res)
      await invalidate()
      if (res.items.length) notify('success', t('import.done', { n: res.items.length }))
    } catch (err) {
      setError(serverMessage(err) ?? t('errors.generic'))
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal
      testid="flows-import-dialog"
      open={open}
      title={t('import.title')}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" data-testid="flows-import-cancel" onClick={onClose}>
            {t(result ? 'actions.close' : 'actions.cancel')}
          </Button>
          <Button data-testid="flows-import-submit" disabled={pending} onClick={submit}>
            {t('import.submit')}
          </Button>
        </>
      }
    >
      <Field
        label={t('import.label')}
        htmlFor="flows-import-codes"
        hint={t('import.hint')}
        error={error}
        errorTestId="flows-import-error"
      >
        <textarea
          id="flows-import-codes"
          data-testid="flows-import-codes"
          className={cn(textareaClass, 'font-mono uppercase')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <p data-testid="flows-import-count" className="text-xs text-muted-foreground">
        {t('import.count', { n: codes.length })}
      </p>
      {result ? (
        <ul data-testid="flows-import-result" className="flex flex-col gap-1">
          {result.items.map((i) => (
            <li
              key={i.code}
              data-testid={`flows-import-ok-${i.code.toUpperCase()}`}
              className="text-emerald-700 dark:text-emerald-400"
            >
              {t('import.ok', { code: i.code.toUpperCase(), name: i.flow.name })}
            </li>
          ))}
          {result.errors.map((e) => (
            <li key={e.code} data-testid={`flows-import-fail-${e.code.toUpperCase()}`} className="text-destructive">
              {t('import.invalid', { code: e.code.toUpperCase() })}
            </li>
          ))}
        </ul>
      ) : null}
    </Modal>
  )
}
