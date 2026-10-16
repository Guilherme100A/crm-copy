// Aba `/settings?tab=mcp_credentials` (T94; 09 §2, §5 item 9): URL do servidor MCP, instruções do header Bearer e
// credenciais com criar (o token aparece uma única vez, com copiar), revogar com confirmação e estado vazio.
// Lista em linhas no desktop e em cartões no mobile (mesmos testids).
import { Dialog } from '@base-ui/react/dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useI18n, useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { EXPIRATION_OPTIONS, MCP_KEY, mcpApi, mcpCredentialsQuery, type ExpirationOption, type McpCredentialDto } from './api'

const inputCls = 'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'
const popupCls =
  'fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none'

function usePerms() {
  const profile = useQuery(profileQuery()).data
  const s = profile ? sessionFrom(profile) : null
  return { canEdit: !!s && hasAny(s, ['settings.mcp.edit']), canDelete: !!s && hasAny(s, ['settings.mcp.delete']) }
}

function useCopy(): [string | null, (key: string, text: string) => Promise<void>] {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000)
    } catch {
      setCopied(null)
    }
  }
  return [copied, copy]
}

export default function McpCredentialsTab() {
  const t = useT('settings-mcp')
  const { locale } = useI18n()
  const q = useQuery(mcpCredentialsQuery())
  const { canEdit, canDelete } = usePerms()
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<McpCredentialDto | null>(null)
  const [copied, copy] = useCopy()
  const items = q.data?.mcp_credentials ?? []
  const url = q.data?.mcp_endpoint_url ?? ''
  const fmt = (iso: string, time = false) => {
    const d = new Date(iso)
    return time ? d.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : d.toLocaleDateString(locale)
  }

  return (
    <section data-testid="mcp-credentials" className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {canEdit ? (
          <Button data-testid="mcp-create" onClick={() => setCreating(true)}>
            <Plus aria-hidden /> {t('create')}
          </Button>
        ) : null}
      </header>

      <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
        <span className="text-sm font-medium">{t('server.title')}</span>
        <div className="flex min-w-0 items-center gap-2">
          <code data-testid="mcp-endpoint-url" className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 text-xs">
            {url}
          </code>
          <Button variant="outline" size="icon" aria-label={t('server.copy')} disabled={!url} onClick={() => void copy('url', url)}>
            {copied === 'url' ? <Check aria-hidden /> : <Copy aria-hidden />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('server.auth')} <code className="rounded bg-muted px-1">Authorization: Bearer &lt;token&gt;</code>
        </p>
        <p className="text-xs text-muted-foreground">{t('server.tips')}</p>
      </div>

      {q.isPending ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : q.isError ? (
        <p className="text-sm text-destructive">{t('error')}</p>
      ) : items.length === 0 ? (
        <div data-testid="mcp-empty" className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
          <KeyRound className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">{t('empty.title')}</p>
          <p className="text-xs text-muted-foreground">{t('empty.body')}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2 sm:gap-0 sm:divide-y sm:rounded-xl sm:border sm:bg-card">
          <li aria-hidden className="hidden gap-4 px-3 py-2 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1fr)_6rem_8rem_10rem_2rem]">
            <span>{t('columns.name')}</span>
            <span>{t('columns.status')}</span>
            <span>{t('columns.expires')}</span>
            <span>{t('columns.lastUsed')}</span>
            <span />
          </li>
          {items.map((c) => (
            <li
              key={c.id}
              data-testid="mcp-credential-row"
              data-id={c.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-xl border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_6rem_8rem_10rem_2rem] sm:items-center sm:gap-4 sm:rounded-none sm:border-0 sm:bg-transparent"
            >
              <span className="truncate font-medium">{c.name}</span>
              <span
                data-testid="mcp-status"
                data-status={c.status}
                className={cn(
                  'justify-self-end rounded-full px-2 py-0.5 text-xs font-medium sm:justify-self-start',
                  c.status === 'active' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground',
                )}
              >
                {t(`status.${c.status}`)}
              </span>
              <span className="text-xs text-muted-foreground sm:text-sm sm:text-foreground">
                <span className="sm:hidden">{t('columns.expires')}: </span>
                {c.expires_at ? fmt(c.expires_at) : t('never')}
              </span>
              <span className="col-start-1 text-xs text-muted-foreground sm:col-start-auto sm:text-sm sm:text-foreground">
                <span className="sm:hidden">{t('columns.lastUsed')}: </span>
                {c.last_used_at ? fmt(c.last_used_at, true) : t('neverUsed')}
              </span>
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="col-start-2 row-span-2 row-start-2 size-8 justify-self-end text-destructive sm:col-start-auto sm:row-span-1 sm:row-start-auto"
                  data-testid="mcp-revoke"
                  aria-label={t('revoke.action')}
                  onClick={() => setRevoking(c)}
                >
                  <Trash2 aria-hidden />
                </Button>
              ) : (
                <span className="hidden sm:block" />
              )}
            </li>
          ))}
        </ul>
      )}

      <CreateDialog open={creating} onClose={() => setCreating(false)} />
      <RevokeDialog credential={revoking} onClose={() => setRevoking(null)} />
    </section>
  )
}

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT('settings-mcp')
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [days, setDays] = useState<ExpirationOption>(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [copied, copy] = useCopy()

  const close = () => {
    // O token some ao fechar: não fica em estado, cache nem storage.
    setToken(null)
    setName('')
    setDays(0)
    setError(null)
    onClose()
  }
  const submit = async () => {
    if (!name.trim()) return setError(t('form.nameRequired'))
    setPending(true)
    setError(null)
    try {
      const r = await mcpApi.create(name, days)
      setToken(r.token)
      await qc.invalidateQueries({ queryKey: MCP_KEY })
    } catch (err) {
      setError(err instanceof HttpError && err.status === 422 ? t('form.invalid') : t('error'))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup data-testid="mcp-create-dialog" className={popupCls}>
          <Dialog.Title className="text-lg font-semibold">{token ? t('created.title') : t('form.title')}</Dialog.Title>
          {token ? (
            <>
              <p className="rounded-md bg-amber-500/15 p-3 text-sm text-amber-800 dark:text-amber-300">{t('created.warning')}</p>
              <code data-testid="mcp-token" className="rounded-md bg-muted px-3 py-2 text-xs break-all select-all">
                {token}
              </code>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" data-testid="mcp-token-copy" onClick={() => void copy('token', token)}>
                  {copied === 'token' ? <Check aria-hidden /> : <Copy aria-hidden />}
                  {copied === 'token' ? t('created.copied') : t('created.copy')}
                </Button>
                <Button data-testid="mcp-token-close" onClick={close}>
                  {t('created.close')}
                </Button>
              </div>
            </>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              <label className="flex flex-col gap-1 text-sm">
                {t('form.name')}
                <input data-testid="mcp-name" className={inputCls} value={name} maxLength={100} placeholder={t('form.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t('form.expiration')}
                <select data-testid="mcp-expiration" className={inputCls} value={days} onChange={(e) => setDays(Number(e.target.value) as ExpirationOption)}>
                  {EXPIRATION_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {t(`expiration.${d}`)}
                    </option>
                  ))}
                </select>
              </label>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={close}>
                  {t('cancel')}
                </Button>
                <Button type="submit" data-testid="mcp-create-submit" disabled={pending}>
                  {t('form.submit')}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function RevokeDialog({ credential, onClose }: { credential: McpCredentialDto | null; onClose: () => void }) {
  const t = useT('settings-mcp')
  const qc = useQueryClient()
  const [pending, setPending] = useState(false)
  return (
    <Dialog.Root open={!!credential} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup data-testid="mcp-revoke-dialog" className={popupCls}>
          <Dialog.Title className="text-lg font-semibold">{t('revoke.title')}</Dialog.Title>
          <p className="text-sm text-muted-foreground">{credential ? t('revoke.body', { name: credential.name }) : ''}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              data-testid="mcp-revoke-confirm"
              disabled={pending}
              onClick={async () => {
                if (!credential) return
                setPending(true)
                try {
                  await mcpApi.revoke(credential.id)
                  await qc.invalidateQueries({ queryKey: MCP_KEY })
                  onClose()
                } catch {
                  notify('mcp-error', t('error'))
                } finally {
                  setPending(false)
                }
              }}
            >
              {t('revoke.confirm')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
