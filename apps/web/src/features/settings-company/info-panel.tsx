// Dados Corporativos (16 §3.1, §5 "Empresa"): nome, descrição, slug, fuso, e-mails de status das conexões,
// badge Ativa/Inativa, desativar (diálogo crítico com os efeitos) e reativar. Owner desativa/reativa; o fuso só
// owner/admin; editar exige `settings.accounts.edit` (o servidor revalida tudo).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Power, PowerOff } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { fieldMessage } from '@/features/auth/api'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { companyApi, companyQuery, refreshCompany, type CompanyDto } from './api'
import {
  canEditTimeZone,
  COMPANY_TIME_ZONES,
  companyFormErrors,
  companyPayload,
  formFromCompany,
  type CompanyForm,
} from './company'
import { can, ConfirmDialog, inputClass, LoadError, Loading, Switch, useSession } from './ui'

const DEACTIVATE_EFFECTS = ['access', 'connections', 'automations', 'reactivate'] as const

export function InfoPanel({ companyId }: { companyId: string }) {
  const q = useQuery(companyQuery(companyId))
  if (q.isPending) return <Loading />
  if (q.isError) return <LoadError testId="company-error" onRetry={() => void q.refetch()} />
  return <CompanyFormView key={`${q.data.id}:${q.data.updated_at}`} company={q.data} />
}

function CompanyFormView({ company }: { company: CompanyDto }) {
  const t = useT('settings-company')
  const qc = useQueryClient()
  const session = useSession()
  const canEdit = can(session, 'settings.accounts.edit')
  const tzEditable = canEdit && canEditTimeZone(session?.role ?? company.role, !!session?.isPlatformAdmin)
  const isOwner = (session?.role ?? company.role) === 'owner'
  const [form, setForm] = useState<CompanyForm>(() => formFromCompany(company))
  const [serverErrors, setServerErrors] = useState<Partial<Record<keyof CompanyForm, string>>>({})
  const [saving, setSaving] = useState(false)
  const [dialog, setDialog] = useState<'deactivate' | 'reactivate' | null>(null)

  const errors = useMemo(() => companyFormErrors(form), [form])
  const set = <K extends keyof CompanyForm>(k: K, v: CompanyForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    setServerErrors((e) => ({ ...e, [k]: undefined }))
  }
  const errorText = (k: 'name' | 'slug') =>
    serverErrors[k] ?? (errors[k] ? t(errors[k] === 'required' ? 'info.nameRequired' : 'info.slugInvalid') : null)

  async function save() {
    if (Object.keys(errors).length) return
    setSaving(true)
    try {
      const updated = await companyApi.update(company.id, companyPayload(company, form, tzEditable))
      await refreshCompany(qc, updated)
      notify('company-saved', t('info.saved'))
    } catch (err) {
      const fields = {
        name: fieldMessage(err, 'name'),
        slug: fieldMessage(err, 'slug'),
        time_zone: fieldMessage(err, 'time_zone'),
      }
      setServerErrors({
        ...(fields.name ? { name: fields.name } : {}),
        ...(fields.slug ? { slug: fields.slug } : {}),
        ...(fields.time_zone ? { time_zone: fields.time_zone } : {}),
      })
      if (err instanceof HttpError && err.status === 409) setServerErrors((e) => ({ ...e, slug: t('info.slugTaken') }))
      notify(
        'company-error',
        err instanceof HttpError && err.status === 403 ? t('common.forbidden') : t('common.saveError'),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-testid="company-info" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{company.name}</p>
          <p className="text-xs text-muted-foreground">{t('info.statusHint')}</p>
        </div>
        <span
          data-testid="company-status"
          data-active={company.active ? 'true' : 'false'}
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            company.active
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
              : 'bg-destructive/15 text-destructive',
          )}
        >
          {company.active ? t('status.active') : t('status.inactive')}
        </span>
        {isOwner ? (
          company.active ? (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              data-testid="company-deactivate"
              onClick={() => setDialog('deactivate')}
            >
              <PowerOff aria-hidden /> {t('deactivate.button')}
            </Button>
          ) : (
            <Button size="sm" data-testid="company-reactivate" onClick={() => setDialog('reactivate')}>
              <Power aria-hidden /> {t('reactivate.button')}
            </Button>
          )
        ) : null}
      </div>
      {!company.active ? (
        <p
          data-testid="company-inactive-banner"
          role="status"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {t('info.inactiveBanner')}
        </p>
      ) : null}

      <form
        className="flex flex-col gap-4 rounded-xl border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <h2 className="text-base font-semibold">{t('info.title')}</h2>
        <Field label={t('info.name')} required error={errorText('name')} htmlFor="company-name">
          <input
            id="company-name"
            data-testid="company-name"
            className={inputClass}
            value={form.name}
            maxLength={120}
            disabled={!canEdit}
            onChange={(e) => set('name', e.target.value)}
          />
        </Field>
        <Field label={t('info.description')} hint={t('info.optional')} htmlFor="company-description">
          <textarea
            id="company-description"
            data-testid="company-description"
            className={cn(inputClass, 'h-auto min-h-20 py-2')}
            value={form.description}
            maxLength={2000}
            disabled={!canEdit}
            onChange={(e) => set('description', e.target.value)}
          />
        </Field>
        <Field label={t('info.slug')} hint={t('info.slugHint')} error={errorText('slug')} htmlFor="company-slug">
          <input
            id="company-slug"
            data-testid="company-slug"
            className={inputClass}
            value={form.slug}
            maxLength={63}
            disabled={!canEdit}
            onChange={(e) => set('slug', e.target.value.toLowerCase())}
          />
        </Field>
        <Field
          label={t('info.timeZone')}
          hint={tzEditable ? undefined : t('info.timeZoneLocked')}
          error={serverErrors.time_zone ?? null}
          htmlFor="company-time-zone"
        >
          <select
            id="company-time-zone"
            data-testid="company-time-zone"
            className={inputClass}
            value={form.time_zone}
            disabled={!tzEditable}
            onChange={(e) => set('time_zone', e.target.value)}
          >
            {(COMPANY_TIME_ZONES as readonly string[]).includes(form.time_zone) ? null : (
              <option value={form.time_zone}>{form.time_zone}</option>
            )}
            {COMPANY_TIME_ZONES.map((tz) => (
              <option key={tz} value={tz}>
                {t(`timeZones.${tz.replaceAll('/', '_')}`)} ({tz})
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{t('info.statusEmails')}</p>
            <p className="text-xs text-muted-foreground">{t('info.statusEmailsHint')}</p>
          </div>
          <Switch
            testId="company-status-emails"
            label={t('info.statusEmails')}
            checked={form.connection_status_emails_enabled}
            disabled={!canEdit}
            onChange={(v) => set('connection_status_emails_enabled', v)}
          />
        </div>
        {canEdit ? (
          <div className="flex justify-end">
            <Button type="submit" data-testid="company-save" disabled={saving || Object.keys(errors).length > 0}>
              {t('info.save')}
            </Button>
          </div>
        ) : (
          <p data-testid="company-readonly" className="text-xs text-muted-foreground">
            {t('info.readOnly')}
          </p>
        )}
      </form>

      <ConfirmDialog
        open={dialog === 'deactivate'}
        testId="company-deactivate-dialog"
        title={t('deactivate.title')}
        body={t('deactivate.body', { name: company.name })}
        confirmLabel={t('deactivate.confirm')}
        onCancel={() => setDialog(null)}
        onConfirm={async () => {
          try {
            await refreshCompany(qc, await companyApi.deactivate(company.id))
            notify('company-deactivated', t('deactivate.done'))
            setDialog(null)
          } catch {
            notify('company-error', t('common.saveError'))
          }
        }}
      >
        <ul data-testid="company-deactivate-effects" className="list-disc space-y-1 pl-5 text-sm">
          {DEACTIVATE_EFFECTS.map((e) => (
            <li key={e}>{t(`deactivate.effects.${e}`)}</li>
          ))}
        </ul>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'reactivate'}
        testId="company-reactivate-dialog"
        tone="default"
        title={t('reactivate.title')}
        body={t('reactivate.body', { name: company.name })}
        confirmLabel={t('reactivate.confirm')}
        onCancel={() => setDialog(null)}
        onConfirm={async () => {
          try {
            await refreshCompany(qc, await companyApi.reactivate(company.id))
            notify('company-reactivated', t('reactivate.done'))
            setDialog(null)
          } catch {
            notify('company-error', t('common.saveError'))
          }
        }}
      />
    </div>
  )
}

function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
}: {
  label: string
  hint?: string | undefined
  error?: string | null
  required?: boolean
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </label>
      {children}
      {error ? (
        <p data-testid={`${htmlFor}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p data-testid={`${htmlFor}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
