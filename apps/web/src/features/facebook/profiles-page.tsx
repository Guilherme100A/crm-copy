// Perfis e contas (11 §2.3, §5.1; AC-T106-05): cartões expansíveis por perfil Meta (1 perfil já abre expandido),
// inclusão de conta no dashboard otimista com rollback, ações de gestão (só owner/admin) e o toast do retorno do OAuth
// (`?meta_oauth=success|error&meta_message=`), removendo os params da URL em seguida.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Plus, RefreshCw, Trash2, Link2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, serverMessage } from '@/features/settings-quick-replies/kit'
import { useI18n, useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { useIsDesktop } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { bundleKeyPrefix, deleteProfile, fetchProfiles, profilesKey, refreshAdAccounts, setAccountIncluded, startOAuth, type MetaProfile } from './api'
import { NS, useFacebookSession } from './layout'
import { applyAccountToggle, canManageProfiles, initials, oauthResult } from './rules'

export interface ProfilesSearch {
  meta_oauth?: string
  meta_message?: string
}

/** Recarga extra depois do OAuth (11 §2.3: "de novo após 2,5 s"). */
export const OAUTH_RELOAD_MS = 2500

export function ProfilesPage({ search, onClearSearch }: { search: ProfilesSearch; onClearSearch: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const session = useFacebookSession()
  const companyId = session?.company?.id
  const manager = canManageProfiles(session)
  const key = profilesKey(companyId)
  const list = useQuery({ queryKey: key, queryFn: fetchProfiles })
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [removing, setRemoving] = useState<MetaProfile | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const handled = useRef(false)

  // Retorno do OAuth: toast, recarrega (agora e após 2,5 s) e limpa a URL.
  useEffect(() => {
    const r = oauthResult(search as Record<string, unknown>)
    if (!r) {
      handled.current = false
      return
    }
    if (handled.current) return
    handled.current = true
    if (r.status === 'success') {
      notify('facebook-oauth-success', t('profiles.oauth.success'), t('profiles.oauth.chooseLater'))
      void qc.invalidateQueries({ queryKey: key })
      void qc.removeQueries({ queryKey: bundleKeyPrefix })
      setTimeout(() => void qc.invalidateQueries({ queryKey: key }), OAUTH_RELOAD_MS)
    } else notify('facebook-oauth-error', t('profiles.oauth.error'), r.message ?? undefined)
    onClearSearch()
  }, [search, qc, key, onClearSearch, t])

  // Toggle otimista em estado local (re-render síncrono no clique; o cache do Query notifica num tick depois). Cada
  // conta sai daqui no erro (rollback) ou depois que a lista relida já traz o valor novo.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({})
  const dropOptimistic = (id: string) =>
    setOptimistic((o) => {
      const next = { ...o }
      delete next[id]
      return next
    })
  const toggle = useMutation({
    mutationFn: ({ id, included }: { id: string; included: boolean }) => setAccountIncluded(id, included),
    onError: (err, { id }) => {
      dropOptimistic(id)
      notify('facebook-account-toggle-error', t('profiles.toggleError'), serverMessage(err) ?? undefined)
    },
    onSuccess: async (account, { id }) => {
      // A inclusão muda o conjunto de contas do Gerenciador: o cache dele é descartado.
      qc.removeQueries({ queryKey: bundleKeyPrefix })
      qc.setQueryData<MetaProfile[]>(key, (old) => (old ? applyAccountToggle(old, id, account.included_in_dashboard) : old))
      await qc.invalidateQueries({ queryKey: key })
      dropOptimistic(id)
    },
  })

  const connect = async (profileId?: string) => {
    setBusy(profileId ? `reconnect-${profileId}` : 'connect')
    try {
      window.location.assign(await startOAuth(profileId))
    } catch (err) {
      notify('facebook-oauth-start-error', t('profiles.oauth.startError'), serverMessage(err) ?? undefined)
      setBusy(null)
    }
  }

  const refresh = async (p: MetaProfile) => {
    setBusy(`refresh-${p.id}`)
    try {
      const profile = await refreshAdAccounts(p.id)
      qc.setQueryData<MetaProfile[]>(key, (old) => (old ?? []).map((x) => (x.id === p.id ? profile : x)))
      qc.removeQueries({ queryKey: bundleKeyPrefix })
      notify('facebook-profile-refreshed', t('profiles.refreshed'))
    } catch (err) {
      notify('facebook-profile-refresh-error', t('profiles.refreshError'), serverMessage(err) ?? undefined)
    } finally {
      setBusy(null)
    }
  }

  const profiles = Object.entries(optimistic).reduce((ps, [id, included]) => applyAccountToggle(ps, id, included), list.data ?? [])
  const isOpen = (p: MetaProfile) => expanded[p.id] ?? profiles.length === 1

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold">{t('profiles.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('profiles.subtitle')}</p>
        </div>
        {manager ? (
          <Button data-testid="facebook-profiles-connect" disabled={busy === 'connect'} onClick={() => void connect()}>
            <Plus aria-hidden /> {t('profiles.connect')}
          </Button>
        ) : null}
      </header>
      {!manager ? (
        <p data-testid="facebook-profiles-readonly" className="text-sm text-muted-foreground">
          {t('profiles.readonly')}
        </p>
      ) : null}
      {list.status === 'pending' ? (
        <div data-testid="facebook-profiles-loading" className="flex flex-col gap-2" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : list.status === 'error' ? (
        <div data-testid="facebook-profiles-error" className="flex flex-col items-start gap-2 rounded-lg border border-destructive/40 p-4 text-sm">
          <p className="text-destructive">{t('common.loadError')}</p>
          <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : profiles.length === 0 ? (
        <div data-testid="facebook-profiles-empty" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          <p className="font-medium text-foreground">{t('profiles.empty')}</p>
          <p>{t('profiles.emptyHint')}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {profiles.map((p) => (
            <ProfileCard
              key={p.id}
              profile={p}
              open={isOpen(p)}
              manager={manager}
              busy={busy}
              onToggleOpen={() => setExpanded((e) => ({ ...e, [p.id]: !isOpen(p) }))}
              onRefresh={() => void refresh(p)}
              onReconnect={() => void connect(p.id)}
              onRemove={() => setRemoving(p)}
              onToggleAccount={(id, included) => {
                setOptimistic((o) => ({ ...o, [id]: included }))
                toggle.mutate({ id, included })
              }}
            />
          ))}
        </ul>
      )}
      <ConfirmDialog
        prefix="facebook-profile"
        open={!!removing}
        title={t('profiles.removeTitle')}
        body={t('profiles.removeBody', { name: removing?.fb_user_name ?? removing?.fb_user_id ?? '' })}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return
          try {
            await deleteProfile(removing.id)
            notify('facebook-profile-removed', t('profiles.removed'))
            setRemoving(null)
            qc.removeQueries({ queryKey: bundleKeyPrefix })
            await qc.invalidateQueries({ queryKey: key })
          } catch (err) {
            notify('facebook-profile-remove-error', t('common.error'), serverMessage(err) ?? undefined)
          }
        }}
      />
    </div>
  )
}

function ProfileCard({
  profile: p,
  open,
  manager,
  busy,
  onToggleOpen,
  onRefresh,
  onReconnect,
  onRemove,
  onToggleAccount,
}: {
  profile: MetaProfile
  open: boolean
  manager: boolean
  busy: string | null
  onToggleOpen: () => void
  onRefresh: () => void
  onReconnect: () => void
  onRemove: () => void
  onToggleAccount: (id: string, included: boolean) => void
}) {
  const t = useT(NS)
  const { locale } = useI18n()
  const desktop = useIsDesktop()
  const [imgFailed, setImgFailed] = useState(false)
  const name = p.fb_user_name || p.fb_user_id
  const expires = p.token_expires_at ? new Date(p.token_expires_at) : null
  return (
    <li data-testid={`facebook-profile-${p.id}`} data-expanded={open ? 'true' : 'false'} className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-3 p-3">
        {p.picture_url && !imgFailed ? (
          <img src={p.picture_url} alt="" className="size-10 shrink-0 rounded-full object-cover" onError={() => setImgFailed(true)} />
        ) : (
          <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {initials(p.fb_user_name, p.fb_user_id)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid={`facebook-profile-name-${p.id}`} className="truncate font-medium">
              {name}
            </span>
            <span
              data-testid={`facebook-profile-status-${p.id}`}
              className={cn('rounded-full px-2 py-0.5 text-xs', p.active ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground')}
            >
              {t(p.active ? 'profiles.active' : 'profiles.inactive')}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            <span data-testid={`facebook-profile-count-${p.id}`}>
              {t('profiles.count', { included: p.ad_accounts_included_count, total: p.ad_accounts_count })}
            </span>
            {desktop && expires && !Number.isNaN(expires.getTime()) ? (
              <span data-testid={`facebook-profile-expires-${p.id}`}> · {t('profiles.expires', { date: expires.toLocaleDateString(locale) })}</span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" data-testid={`facebook-profile-toggle-${p.id}`} aria-expanded={open} onClick={onToggleOpen}>
            {t('profiles.accounts')}
            <ChevronDown className={cn('transition-transform', open && 'rotate-180')} aria-hidden />
          </Button>
          {manager ? (
            <>
              <Button variant="ghost" size="sm" data-testid={`facebook-profile-refresh-${p.id}`} disabled={busy !== null} onClick={onRefresh}>
                <RefreshCw className={cn(busy === `refresh-${p.id}` && 'animate-spin')} aria-hidden /> {t('profiles.refresh')}
              </Button>
              <Button variant="ghost" size="sm" data-testid={`facebook-profile-reconnect-${p.id}`} disabled={busy !== null} onClick={onReconnect}>
                <Link2 aria-hidden /> {t('profiles.reconnect')}
              </Button>
              <Button variant="ghost" size="sm" className="text-destructive" data-testid={`facebook-profile-remove-${p.id}`} disabled={busy !== null} onClick={onRemove}>
                <Trash2 aria-hidden /> {t('profiles.remove')}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {open ? (
        <div data-testid={`facebook-profile-accounts-${p.id}`} className="border-t p-3">
          {p.ad_accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('profiles.noAccounts')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {p.ad_accounts.map((a) => (
                <li key={a.id} data-testid={`facebook-account-${a.id}`} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40">
                  <input
                    type="checkbox"
                    id={`facebook-account-toggle-${a.id}`}
                    data-testid={`facebook-account-toggle-${a.id}`}
                    checked={a.included_in_dashboard}
                    disabled={!manager}
                    aria-label={t('profiles.includeAccount', { name: a.name || a.fb_account_id })}
                    onChange={(e) => onToggleAccount(a.id, e.target.checked)}
                    className="size-4"
                  />
                  <label htmlFor={`facebook-account-toggle-${a.id}`} className="min-w-0 flex-1 text-sm">
                    <span className="block truncate font-medium">{a.name || a.fb_account_id}</span>
                    <span className="block truncate text-xs text-muted-foreground">{a.fb_account_id}</span>
                  </label>
                  {a.included_in_dashboard ? (
                    <Check data-testid={`facebook-account-included-${a.id}`} className="size-4 text-emerald-600" aria-label={t('profiles.included')} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  )
}
