// Aba Usuários (20 §3.1; AC-T100-02): lista paginada (20) com busca por nome/e-mail (debounce 450 ms), criar/editar
// no modal (e-mail imutável depois de criado, senha ≥ 6 e confirmação) e "Ver empresas" do usuário.
import { Dialog } from '@base-ui/react/dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DataList,
  Field,
  FormDialog,
  inputClass,
  isFieldError,
  Pager,
  SearchBox,
  serverMessage,
  TabHeader,
  useDebounced,
} from '@/features/settings-quick-replies/kit'
import { useI18n, useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { ADMIN_KEY, adminApi, adminUserCompaniesQuery, adminUsersQuery, type AdminUserDto } from './api'
import {
  ADMIN_SEARCH_DEBOUNCE_MS,
  DEFAULT_USER_ROLE,
  USER_ROLES,
  userPayload,
  validateUserDraft,
  type UserDraft,
  type UserDraftErrors,
} from './rules'
import { fmtDate, NS } from './ui'

const P = 'admin-users'
const blank = (): UserDraft => ({ name: '', email: '', personal_whatsapp: '', role: DEFAULT_USER_ROLE, password: '', password_confirmation: '' })

export function UsersTab() {
  const t = useT(NS)
  const { locale } = useI18n()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const applied = useDebounced(search.trim(), ADMIN_SEARCH_DEBOUNCE_MS)
  useEffect(() => setPage(1), [applied])
  const q = useQuery(adminUsersQuery(page, applied))
  const [editing, setEditing] = useState<AdminUserDto | 'new' | null>(null)
  const [companiesOf, setCompaniesOf] = useState<AdminUserDto | null>(null)

  return (
    <div data-testid="admin-panel-users" className="flex flex-col gap-4">
      <TabHeader prefix={P} title={t('tabs.users')} subtitle={t('users.subtitle')} canCreate newLabel={t('users.new')} onNew={() => setEditing('new')} />
      <SearchBox prefix={P} value={search} onChange={setSearch} placeholder={t('users.search')} />
      <DataList
        prefix={P}
        rows={q.data?.items ?? []}
        rowId={(u) => u.id}
        status={q.status}
        empty={applied ? t('common.noResults') : t('users.empty')}
        title={(u) => u.name}
        canEdit={() => true}
        canDelete={() => false}
        onEdit={(u) => setEditing(u)}
        columns={[
          { id: 'name', header: t('users.name'), cell: (u) => <span data-testid={`${P}-item-name-${u.id}`}>{u.name}</span> },
          { id: 'email', header: t('users.email'), cell: (u) => <span data-testid={`${P}-item-email-${u.id}`}>{u.email}</span> },
          { id: 'whatsapp', header: t('users.whatsapp'), cell: (u) => u.personal_whatsapp || t('users.notInformed') },
          { id: 'role', header: t('users.role'), cell: (u) => <span data-testid={`${P}-item-role-${u.id}`}>{t(`roles.${u.role}`)}</span> },
          { id: 'created', header: t('common.createdAt'), cell: (u) => fmtDate(u.created_at, locale) },
          {
            id: 'companies',
            header: t('users.companies'),
            cell: (u) => (
              <Button variant="ghost" size="sm" data-testid={`${P}-item-companies-${u.id}`} onClick={() => setCompaniesOf(u)}>
                <Building2 aria-hidden /> {u.companies_count}
              </Button>
            ),
          },
        ]}
      />
      <Pager prefix={P} meta={q.data?.page} onPage={setPage} />
      {editing ? <UserDialog user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <UserCompaniesDialog user={companiesOf} onClose={() => setCompaniesOf(null)} />
    </div>
  )
}

function UserDialog({ user, onClose }: { user: AdminUserDto | null; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const mode = user ? 'edit' : 'create'
  const [d, setD] = useState<UserDraft>(() =>
    user
      ? { name: user.name, email: user.email, personal_whatsapp: user.personal_whatsapp ?? '', role: user.role, password: '', password_confirmation: '' }
      : blank(),
  )
  const [errors, setErrors] = useState<UserDraftErrors>({})
  const set = <K extends keyof UserDraft>(k: K, v: UserDraft[K]) => setD((x) => ({ ...x, [k]: v }))
  const save = useMutation({
    mutationFn: () => (user ? adminApi.updateUser(user.id, userPayload(d, 'edit')) : adminApi.createUser(userPayload(d, 'create'))),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [...ADMIN_KEY, 'users'] })
      notify('admin-user-saved', t(user ? 'users.updated' : 'users.created'))
      onClose()
    },
  })
  const fieldErr = (k: keyof UserDraftErrors) =>
    errors[k] ? t(`users.errors.${errors[k]}`) : isFieldError(save.error, k) ? serverMessage(save.error, k) : null
  const general = save.error && !(['name', 'email', 'password', 'password_confirmation'] as const).some((k) => isFieldError(save.error, k))
    ? serverMessage(save.error) ?? t('common.saveFailed')
    : null

  return (
    <FormDialog
      prefix="admin-user"
      open
      title={t(user ? 'users.edit' : 'users.new')}
      onClose={onClose}
      pending={save.isPending}
      error={general}
      onSubmit={() => {
        const e = validateUserDraft(d, mode)
        setErrors(e)
        if (Object.keys(e).length === 0) save.mutate()
      }}
    >
      <Field label={t('users.name')} htmlFor="admin-user-name" error={fieldErr('name')} errorTestId="admin-user-name-error">
        <input id="admin-user-name" data-testid="admin-user-name" className={inputClass} value={d.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field
        label={t('users.email')}
        htmlFor="admin-user-email"
        error={fieldErr('email')}
        errorTestId="admin-user-email-error"
        hint={user ? t('users.emailLocked') : undefined}
      >
        <input
          id="admin-user-email"
          data-testid="admin-user-email"
          type="email"
          className={inputClass}
          value={d.email}
          disabled={!!user}
          onChange={(e) => set('email', e.target.value)}
        />
      </Field>
      <Field label={t('users.whatsapp')} htmlFor="admin-user-whatsapp">
        <input
          id="admin-user-whatsapp"
          data-testid="admin-user-whatsapp"
          className={inputClass}
          value={d.personal_whatsapp}
          onChange={(e) => set('personal_whatsapp', e.target.value)}
        />
      </Field>
      <Field label={t('users.role')} htmlFor="admin-user-role">
        <select
          id="admin-user-role"
          data-testid="admin-user-role"
          className={inputClass}
          value={d.role}
          onChange={(e) => set('role', e.target.value as UserDraft['role'])}
        >
          {USER_ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`roles.${r}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label={t('users.password')}
        htmlFor="admin-user-password"
        error={fieldErr('password')}
        errorTestId="admin-user-password-error"
        hint={user ? t('users.passwordKeep') : t('users.passwordHint')}
      >
        <input
          id="admin-user-password"
          data-testid="admin-user-password"
          type="password"
          autoComplete="new-password"
          className={inputClass}
          value={d.password}
          onChange={(e) => set('password', e.target.value)}
        />
      </Field>
      <Field
        label={t('users.passwordConfirmation')}
        htmlFor="admin-user-password-confirmation"
        error={fieldErr('password_confirmation')}
        errorTestId="admin-user-password-confirmation-error"
      >
        <input
          id="admin-user-password-confirmation"
          data-testid="admin-user-password-confirmation"
          type="password"
          autoComplete="new-password"
          className={inputClass}
          value={d.password_confirmation}
          onChange={(e) => set('password_confirmation', e.target.value)}
        />
      </Field>
    </FormDialog>
  )
}

function UserCompaniesDialog({ user, onClose }: { user: AdminUserDto | null; onClose: () => void }) {
  const t = useT(NS)
  const q = useQuery({ ...adminUserCompaniesQuery(user?.id ?? ''), enabled: !!user })
  return (
    <Dialog.Root open={!!user} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid="admin-user-companies"
          className="fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{t('users.companiesOf', { name: user?.name ?? '' })}</Dialog.Title>
          {q.isPending ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : q.isError ? (
            <p className="text-sm text-destructive">{t('common.error')}</p>
          ) : q.data.length === 0 ? (
            <p data-testid="admin-user-companies-empty" className="text-sm text-muted-foreground">
              {t('users.noCompanies')}
            </p>
          ) : (
            <ul className="flex flex-col divide-y rounded-md border">
              {q.data.map((c) => (
                <li key={c.account_id} data-testid={`admin-user-companies-item-${c.account_id}`} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">{c.account_name}</span>
                  <span className="text-muted-foreground">{c.role_label}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button variant="outline" data-testid="admin-user-companies-close" onClick={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
