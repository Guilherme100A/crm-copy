// Modais da tela de conexões (08 §2 "Modais de ação"; AC-T71-02/03/04): Nova/Renomear, Conectar (QR | Código no
// telefone), Proxy personalizado, Configurações da instância, Parar todos os fluxos e Fluxos pausados na queda.
// Testids `connections-<modal>-<coisa>` (contrato com o Tester).
import { Dialog } from '@base-ui/react/dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Field, FormDialog, inputClass, isFieldError, serverMessage } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  CONNECTIONS_KEY,
  connectionsApi,
  EPHEMERAL_DURATIONS,
  pairingKey,
  pausedFlowsQuery,
  PROXY_PROTOCOLS,
  qrKey,
  qrQuery,
  type ConnectionDto,
  type EphemeralDuration,
  type PausedFlowsCounts,
} from './api'
import { nameIssue, phoneDigits, phoneValid, proxyDraftOf, proxyInputOf, proxyIssues, type ProxyDraft } from './logic'
import { useConnectionsUi } from './realtime'

const NS = 'connections'

const refreshList = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ queryKey: [...CONNECTIONS_KEY, 'list'] })

/** Casca de modal com título, corpo e rodapé (os que não são formulário simples). */
function Modal({
  testId,
  open,
  title,
  onClose,
  footer,
  children,
}: {
  testId: string
  open: boolean
  title: string
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid={testId}
          className="fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-background shadow-xl outline-none"
        >
          <Dialog.Title className="border-b px-5 py-4 text-lg font-semibold">{title}</Dialog.Title>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">{footer}</div> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ------------------------------------------------------------------ Nova / Renomear

export function NameDialog({ editing, onClose }: { editing: ConnectionDto | 'new' | null; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    setName(editing && editing !== 'new' ? editing.name : '')
    setTouched(false)
  }, [editing])
  const save = useMutation({
    mutationFn: () =>
      editing === 'new'
        ? connectionsApi.create(name.trim())
        : connectionsApi.rename((editing as ConnectionDto).id, name.trim()),
    onSuccess: async () => {
      notify('connections-saved', t(editing === 'new' ? 'toast.created' : 'toast.renamed'))
      await refreshList(qc)
      onClose()
    },
    onError: (err) => {
      if (err instanceof HttpError && err.code === 'LIMIT_REACHED') void refreshList(qc)
    },
  })
  const issue = nameIssue(name)
  const err =
    save.error instanceof HttpError && save.error.code === 'LIMIT_REACHED'
      ? t('limit.reachedShort')
      : serverMessage(save.error, 'name')
  return (
    <FormDialog
      prefix="connections-name"
      open={editing !== null}
      title={t(editing === 'new' ? 'create.title' : 'create.renameTitle')}
      onClose={onClose}
      pending={save.isPending}
      error={err}
      onSubmit={() => {
        setTouched(true)
        if (!issue) save.mutate()
      }}
    >
      <Field
        label={t('create.name')}
        htmlFor="connections-name-input"
        error={touched && issue ? t(`create.errors.${issue}`, { min: 2, max: 100 }) : null}
        errorTestId="connections-name-input-error"
        hint={editing === 'new' ? t('create.hint') : undefined}
      >
        <input
          id="connections-name-input"
          data-testid="connections-name-input"
          className={inputClass}
          value={name}
          maxLength={100}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </FormDialog>
  )
}

// ------------------------------------------------------------------ Conectar (QR | Código no telefone)

export function ConnectDialog({ connection, onClose }: { connection: ConnectionDto | null; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const open = connection !== null
  const id = connection?.id ?? ''
  const [tab, setTab] = useState<'qr' | 'phone'>('qr')
  const [phone, setPhone] = useState('')
  const [phoneTouched, setPhoneTouched] = useState(false)
  const openedAt = useRef(0)
  const ui = useConnectionsUi()

  const start = useMutation({
    mutationFn: (cid: string) => connectionsApi.connect(cid),
    onSettled: () => void refreshList(qc),
  })
  useEffect(() => {
    if (!connection) return
    openedAt.current = Date.now()
    setTab('qr')
    setPhone('')
    setPhoneTouched(false)
    qc.removeQueries({ queryKey: pairingKey(connection.id) })
    start.mutate(connection.id, { onSuccess: () => void qc.invalidateQueries({ queryKey: qrKey(connection.id) }) })
  }, [connection?.id])

  const qr = useQuery(qrQuery(id, open && tab === 'qr' && start.isSuccess))
  const code = useQuery({
    queryKey: pairingKey(id),
    queryFn: () => null as string | null,
    enabled: false,
    staleTime: Infinity,
  })
  const pair = useMutation({
    mutationFn: () => connectionsApi.pairingCode(id, phoneDigits(phone)),
    onSuccess: (r) => qc.setQueryData(pairingKey(id), r.code),
  })

  // AC-T71-02: `connection.connected` (via SSE) fecha o modal; o status já mudou no cache.
  const connectedAt = id ? ui.connected[id] : undefined
  useEffect(() => {
    if (open && connectedAt && connectedAt >= openedAt.current) {
      notify('connections-connected', t('connect.connected', { name: connection?.name ?? '' }))
      onClose()
    }
  }, [connectedAt, open])

  const qrValue = qr.data?.qr_code ?? null
  const phoneOk = phoneValid(phone)
  return (
    <Modal
      testId="connections-connect"
      open={open}
      title={t('connect.title', { name: connection?.name ?? '' })}
      onClose={onClose}
      footer={
        <Button variant="outline" data-testid="connections-connect-close" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div role="tablist" className="flex gap-1 border-b">
        {(['qr', 'phone'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            data-testid={`connections-connect-tab-${k}`}
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              tab === k ? 'border-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`connect.tabs.${k}`)}
          </button>
        ))}
      </div>
      {start.isError ? (
        <p data-testid="connections-connect-error" role="alert" className="text-sm text-destructive">
          {serverMessage(start.error) ?? t('common.error')}
        </p>
      ) : null}
      {tab === 'qr' ? (
        <div data-testid="connections-connect-qr-panel" className="flex flex-col items-center gap-3">
          <ol className="list-decimal self-stretch pl-5 text-sm text-muted-foreground">
            <li>{t('connect.qrSteps.1')}</li>
            <li>{t('connect.qrSteps.2')}</li>
            <li>{t('connect.qrSteps.3')}</li>
          </ol>
          {qrValue ? (
            <img
              data-testid="connections-qr-image"
              data-qr={qrValue}
              src={qrValue}
              alt={t('connect.qrAlt')}
              className="size-56 rounded-lg border bg-white p-2"
            />
          ) : (
            <div
              data-testid="connections-qr-loading"
              className="flex size-56 items-center justify-center rounded-lg border text-sm text-muted-foreground"
              aria-busy
            >
              {t('connect.qrLoading')}
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            data-testid="connections-qr-refresh"
            disabled={start.isPending}
            onClick={() => start.mutate(id, { onSuccess: () => void qc.invalidateQueries({ queryKey: qrKey(id) }) })}
          >
            <RefreshCw aria-hidden /> {t('connect.qrRefresh')}
          </Button>
        </div>
      ) : (
        <form
          data-testid="connections-connect-phone-panel"
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            setPhoneTouched(true)
            if (phoneOk) pair.mutate()
          }}
        >
          <Field
            label={t('connect.phone')}
            htmlFor="connections-pairing-phone"
            hint={t('connect.phoneHint')}
            error={phoneTouched && !phoneOk ? t('connect.phoneInvalid') : serverMessage(pair.error, 'phone')}
            errorTestId="connections-pairing-phone-error"
          >
            <input
              id="connections-pairing-phone"
              data-testid="connections-pairing-phone"
              inputMode="tel"
              autoComplete="tel"
              placeholder="5511999999999"
              className={inputClass}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
          <Button type="submit" data-testid="connections-pairing-submit" disabled={pair.isPending}>
            {t('connect.getCode')}
          </Button>
          {code.data ? (
            <div className="flex flex-col items-center gap-1 rounded-lg border bg-muted/40 p-4">
              <span className="text-xs text-muted-foreground">{t('connect.codeLabel')}</span>
              <span
                data-testid="connections-pairing-code"
                data-code={code.data}
                className="font-mono text-2xl font-semibold tracking-widest"
              >
                {code.data}
              </span>
              <span className="text-center text-xs text-muted-foreground">{t('connect.codeHint')}</span>
            </div>
          ) : null}
        </form>
      )}
    </Modal>
  )
}

// ------------------------------------------------------------------ Proxy personalizado

export function ProxyDialog({ connection, onClose }: { connection: ConnectionDto | null; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [d, setD] = useState<ProxyDraft>(() => proxyDraftOf({ proxy: null }))
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (connection) setD(proxyDraftOf(connection))
    setTouched(false)
  }, [connection])
  const done = async (key: string) => {
    notify('connections-proxy-saved', t(key))
    await refreshList(qc)
    onClose()
  }
  const save = useMutation({
    mutationFn: () => connectionsApi.setProxy(connection!.id, proxyInputOf(d)),
    onSuccess: () => done('toast.proxySaved'),
  })
  const remove = useMutation({
    mutationFn: () => connectionsApi.removeProxy(connection!.id),
    onSuccess: () => done('toast.proxyRemoved'),
  })
  const issues = proxyIssues(d)
  const fieldErr = (k: 'protocol' | 'host' | 'port') =>
    touched && issues[k]
      ? t(`proxy.errors.${k}.${issues[k]}`)
      : isFieldError(save.error, k)
        ? serverMessage(save.error, k)
        : null
  const has = !!connection?.proxy
  return (
    <FormDialog
      prefix="connections-proxy"
      open={connection !== null}
      title={t('proxy.title')}
      onClose={onClose}
      pending={save.isPending || remove.isPending}
      error={save.isError || remove.isError ? serverMessage(save.error ?? remove.error) : null}
      onSubmit={() => {
        setTouched(true)
        if (!Object.keys(issues).length) save.mutate()
      }}
    >
      <p
        data-testid="connections-proxy-restart-warning"
        className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
        {t('proxy.restartWarning')}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_minmax(0,1fr)_6rem]">
        <Field label={t('proxy.protocol')} htmlFor="connections-proxy-protocol" error={fieldErr('protocol')}>
          <select
            id="connections-proxy-protocol"
            data-testid="connections-proxy-protocol"
            className={inputClass}
            value={d.protocol}
            onChange={(e) => setD({ ...d, protocol: e.target.value as ProxyDraft['protocol'] })}
          >
            {PROXY_PROTOCOLS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={t('proxy.host')}
          htmlFor="connections-proxy-host"
          error={fieldErr('host')}
          errorTestId="connections-proxy-host-error"
        >
          <input
            id="connections-proxy-host"
            data-testid="connections-proxy-host"
            className={inputClass}
            value={d.host}
            onChange={(e) => setD({ ...d, host: e.target.value })}
          />
        </Field>
        <Field
          label={t('proxy.port')}
          htmlFor="connections-proxy-port"
          error={fieldErr('port')}
          errorTestId="connections-proxy-port-error"
        >
          <input
            id="connections-proxy-port"
            data-testid="connections-proxy-port"
            inputMode="numeric"
            className={inputClass}
            value={d.port}
            onChange={(e) => setD({ ...d, port: e.target.value.replace(/\D+/g, '') })}
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('proxy.username')} htmlFor="connections-proxy-username">
          <input
            id="connections-proxy-username"
            data-testid="connections-proxy-username"
            autoComplete="off"
            className={inputClass}
            value={d.username}
            onChange={(e) => setD({ ...d, username: e.target.value })}
          />
        </Field>
        <Field
          label={t('proxy.password')}
          htmlFor="connections-proxy-password"
          hint={connection?.proxy?.has_password ? t('proxy.passwordSaved') : undefined}
        >
          <input
            id="connections-proxy-password"
            data-testid="connections-proxy-password"
            type="password"
            autoComplete="new-password"
            placeholder={connection?.proxy?.has_password && !d.removePassword ? '••••••••' : ''}
            className={inputClass}
            value={d.password}
            onChange={(e) => setD({ ...d, password: e.target.value, removePassword: false })}
          />
        </Field>
      </div>
      {connection?.proxy?.has_password ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="connections-proxy-remove-password"
            className="size-4"
            checked={d.removePassword}
            disabled={!!d.password}
            onChange={(e) => setD({ ...d, removePassword: e.target.checked })}
          />
          {t('proxy.removePassword')}
        </label>
      ) : null}
      {has ? (
        <Button
          variant="outline"
          className="self-start text-destructive"
          data-testid="connections-proxy-remove"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          {t('proxy.remove')}
        </Button>
      ) : null}
    </FormDialog>
  )
}

// ------------------------------------------------------------------ Configurações da instância

export function InstanceDialog({ connection, onClose }: { connection: ConnectionDto | null; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [ephemeral, setEphemeral] = useState<EphemeralDuration>('off')
  const [saveContacts, setSaveContacts] = useState(false)
  const [notifyMine, setNotifyMine] = useState(false)
  useEffect(() => {
    if (!connection) return
    setEphemeral(connection.ephemeral_duration)
    setSaveContacts(connection.save_contacts_enabled)
    setNotifyMine(connection.notify_sent_by_me)
  }, [connection])
  const save = useMutation({
    mutationFn: () =>
      connectionsApi.instanceSettings(connection!.id, {
        ephemeral_duration: ephemeral,
        save_contacts_enabled: saveContacts,
        notify_sent_by_me: notifyMine,
      }),
    onSuccess: async () => {
      notify('connections-instance-saved', t('toast.instanceSaved'))
      await refreshList(qc)
      onClose()
    },
  })
  const check = (testId: string, label: string, hint: string, value: boolean, onChange: (v: boolean) => void) => (
    <label className="flex items-start gap-3 text-sm">
      <input
        type="checkbox"
        data-testid={testId}
        className="mt-0.5 size-4"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
  return (
    <FormDialog
      prefix="connections-instance"
      open={connection !== null}
      title={t('instance.title')}
      onClose={onClose}
      pending={save.isPending}
      error={save.isError ? serverMessage(save.error) : null}
      onSubmit={() => save.mutate()}
    >
      <Field
        label={t('instance.ephemeral')}
        htmlFor="connections-instance-ephemeral"
        hint={t('instance.ephemeralHint')}
      >
        <select
          id="connections-instance-ephemeral"
          data-testid="connections-instance-ephemeral"
          className={inputClass}
          value={ephemeral}
          onChange={(e) => setEphemeral(e.target.value as EphemeralDuration)}
        >
          {EPHEMERAL_DURATIONS.map((v) => (
            <option key={v} value={v}>
              {t(`instance.durations.${v}`)}
            </option>
          ))}
        </select>
      </Field>
      {check(
        'connections-instance-save-contacts',
        t('instance.saveContacts'),
        t('instance.saveContactsHint'),
        saveContacts,
        setSaveContacts,
      )}
      {check(
        'connections-instance-notify-mine',
        t('instance.notifyMine'),
        t('instance.notifyMineHint'),
        notifyMine,
        setNotifyMine,
      )}
    </FormDialog>
  )
}

// ------------------------------------------------------------------ Parar todos os fluxos

export function StopFlowsDialog({ connection, onClose }: { connection: ConnectionDto | null; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [typed, setTyped] = useState('')
  useEffect(() => setTyped(''), [connection])
  const stop = useMutation({
    mutationFn: () => connectionsApi.cancelAllFlowRuns(connection!.id, typed),
    onSuccess: async (r) => {
      notify('connections-flows-stopped', t('toast.flowsStopped', { n: r.cancelled }))
      await refreshList(qc)
      onClose()
    },
  })
  const matches = !!connection && typed === connection.name
  return (
    <Modal
      testId="connections-stop-flows"
      open={connection !== null}
      title={t('stopFlows.title')}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" data-testid="connections-stop-flows-cancel" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            data-testid="connections-stop-flows-confirm"
            disabled={!matches || stop.isPending}
            onClick={() => stop.mutate()}
          >
            {t('stopFlows.confirm')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{t('stopFlows.body')}</p>
      <Field
        label={t('stopFlows.typeName', { name: connection?.name ?? '' })}
        htmlFor="connections-stop-flows-name"
        error={stop.isError ? serverMessage(stop.error, 'confirmation_name') : null}
        errorTestId="connections-stop-flows-error"
      >
        <input
          id="connections-stop-flows-name"
          data-testid="connections-stop-flows-name"
          autoComplete="off"
          className={inputClass}
          value={typed}
          placeholder={connection?.name ?? ''}
          onChange={(e) => setTyped(e.target.value)}
        />
      </Field>
    </Modal>
  )
}

// ------------------------------------------------------------------ Fluxos pausados na queda (Retomar/Cancelar)

const COUNT_KEYS = ['paused_count', 'waiting_count', 'failed_count', 'received_count', 'total_leads'] as const

export function PausedFlowsDialog({
  target,
  canRunFlows,
  onClose,
}: {
  /** Conexão e as contagens do evento (ou só a conexão, vindo do menu: as contagens vêm da API). */
  target: { connection_id: string; name: string; counts?: PausedFlowsCounts } | null
  canRunFlows: boolean
  onClose: () => void
}) {
  const t = useT(NS)
  const qc = useQueryClient()
  const id = target?.connection_id ?? ''
  const fetched = useQuery(pausedFlowsQuery(id, !!target && !target.counts))
  const counts: PausedFlowsCounts | undefined = target?.counts ?? fetched.data
  const after = async (key: string, n: number) => {
    notify('connections-paused-flows-done', t(key, { n }))
    await Promise.all([refreshList(qc), qc.invalidateQueries({ queryKey: [...CONNECTIONS_KEY, 'paused', id] })])
    onClose()
  }
  const resume = useMutation({
    mutationFn: () => connectionsApi.resumePausedFlows(id),
    onSuccess: (r) => after('toast.flowsResumed', r.resumed),
  })
  const cancel = useMutation({
    mutationFn: () => connectionsApi.cancelPausedFlows(id),
    onSuccess: (r) => after('toast.flowsCancelled', r.cancelled),
  })
  const busy = resume.isPending || cancel.isPending
  return (
    <Modal
      testId="connections-paused-flows"
      open={target !== null}
      title={t('pausedFlows.title', { name: target?.name ?? '' })}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" data-testid="connections-paused-flows-later" onClick={onClose}>
            {t('pausedFlows.later')}
          </Button>
          {canRunFlows ? (
            <>
              <Button
                variant="destructive"
                data-testid="connections-paused-flows-cancel"
                disabled={busy}
                onClick={() => cancel.mutate()}
              >
                {t('pausedFlows.cancel')}
              </Button>
              <Button data-testid="connections-paused-flows-resume" disabled={busy} onClick={() => resume.mutate()}>
                {t('pausedFlows.resume')}
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{t('pausedFlows.body')}</p>
      {counts ? (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {COUNT_KEYS.filter((k) => counts[k] !== undefined).map((k) => (
            <div
              key={k}
              data-testid={`connections-paused-flows-${k.replace('_', '-')}`}
              data-count={counts[k]}
              className="rounded-lg border p-3"
            >
              <dt className="text-xs text-muted-foreground">{t(`pausedFlows.counts.${k}`)}</dt>
              <dd className="text-xl font-semibold tabular-nums">{counts[k]}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      )}
      {resume.isError || cancel.isError ? (
        <p role="alert" data-testid="connections-paused-flows-error" className="text-sm text-destructive">
          {serverMessage(resume.error ?? cancel.error) ?? t('common.error')}
        </p>
      ) : null}
    </Modal>
  )
}
