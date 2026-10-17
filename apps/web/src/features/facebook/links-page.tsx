// Links rastreáveis (revisão 3; docs/integrations/meta-capi.md) — recurso OPCIONAL para anúncios com destino site/link.
// Anúncio de clique para WhatsApp não passa por link nenhum: o rastreamento ali é o cartão do anúncio (ctwa_clid), que
// não depende disto. O link `/api/w/<slug>` redireciona na hora (302) para o wa.me com a mensagem pronta; o código no
// fim é configurável (visível, discreto/invisível ou desligado). Sem código, a ligação ao contato só acontece se a
// opção "provável" estiver ligada (desligada por padrão) e fica marcada como provável, nunca como certa.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Info } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog, DataList, Field, FormDialog, inputClass, serverMessage, TabHeader, textareaClass, type Column } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { createTrackedLink, deleteTrackedLink, fetchConnectionOptions, fetchTrackedLinks, trackedLinksKey, updateTrackedLink, type TrackedLink, type TrackedLinkCodeMode } from './api'
import { NS, selectClass, useFacebookSession } from './layout'
import { onlyDigits, suggestSlug, trackedLinkUrl, validateTrackedLink } from './rules'

const P = 'facebook-links'
const CODE_MODES: TrackedLinkCodeMode[] = ['visible', 'discreet', 'off']

export function LinksPage() {
  const t = useT(NS)
  const qc = useQueryClient()
  const companyId = useFacebookSession()?.company?.id
  const list = useQuery({ queryKey: trackedLinksKey(companyId), queryFn: fetchTrackedLinks })
  const [editing, setEditing] = useState<TrackedLink | 'new' | null>(null)
  const [removing, setRemoving] = useState<TrackedLink | null>(null)
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  const columns: Column<TrackedLink>[] = [
    {
      id: 'name',
      header: t('links.columns.name'),
      cell: (l) => (
        <span className="font-medium">
          {l.name}
          {!l.active ? <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t('links.inactive')}</span> : null}
        </span>
      ),
    },
    {
      id: 'url',
      header: t('links.columns.url'),
      cell: (l) => (
        <span className="flex min-w-0 items-center gap-1">
          <code data-testid={`${P}-item-url-${l.id}`} className="truncate font-mono text-xs">
            {trackedLinkUrl(origin, l.path)}
          </code>
          <button
            type="button"
            data-testid={`${P}-item-copy-${l.id}`}
            aria-label={t('links.copy')}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            onClick={() => {
              void navigator.clipboard?.writeText(trackedLinkUrl(origin, l.path)).catch(() => undefined)
              notify(`${P}-copied`, t('links.copied'))
            }}
          >
            <Copy className="size-3.5" aria-hidden />
          </button>
        </span>
      ),
    },
    { id: 'destination', header: t('links.columns.destination'), cell: (l) => <span className="text-xs">{l.connection_name ?? l.phone ?? '—'}</span> },
    { id: 'code', header: t('links.columns.code'), cell: (l) => <span className="text-xs">{t(`links.codeModes.${l.code_mode}`)}</span> },
    {
      id: 'stats',
      header: t('links.columns.stats'),
      cell: (l) => (
        <span data-testid={`${P}-item-stats-${l.id}`} className="flex flex-col text-xs tabular-nums">
          <span>{t('links.stats.clicks', { n: l.stats.clicks })}</span>
          <span>{t('links.stats.conversations', { n: l.stats.conversations - l.stats.probable })}</span>
          {l.stats.probable ? <span className="text-amber-700 dark:text-amber-300">{t('links.stats.probable', { n: l.stats.probable })}</span> : null}
          <span>{t('links.stats.sales', { n: l.stats.sales })}</span>
        </span>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <TabHeader prefix={P} title={t('links.title')} subtitle={t('links.subtitle')} canCreate newLabel={t('links.new')} onNew={() => setEditing('new')} />
      <div data-testid={`${P}-notice`} className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex flex-col gap-1">
          <p>{t('links.notice.optional')}</p>
          <p className="text-muted-foreground">{t('links.notice.ctwa')}</p>
        </div>
      </div>
      <DataList
        prefix={P}
        rows={list.data ?? []}
        rowId={(l) => l.id}
        columns={columns}
        title={(l) => l.name}
        canEdit={() => true}
        canDelete={() => true}
        onEdit={(l) => setEditing(l)}
        onDelete={(l) => setRemoving(l)}
        status={list.status}
        empty={t('links.empty')}
      />
      {editing ? <LinkDialog link={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void qc.invalidateQueries({ queryKey: trackedLinksKey(companyId) })} /> : null}
      <ConfirmDialog
        prefix={P}
        open={!!removing}
        title={t('links.deleteTitle')}
        body={t('links.deleteBody', { name: removing?.name ?? '' })}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return
          try {
            await deleteTrackedLink(removing.id)
            notify(`${P}-deleted`, t('links.deleted'))
            setRemoving(null)
            await qc.invalidateQueries({ queryKey: trackedLinksKey(companyId) })
          } catch (err) {
            notify(`${P}-delete-error`, serverMessage(err) ?? t('common.error'))
          }
        }}
      />
    </div>
  )
}

interface FormValues {
  name: string
  slug: string
  connection_id: string
  phone: string
  message: string
  utm_source: string
  utm_medium: string
  utm_campaign: string
  utm_content: string
  utm_term: string
  active: boolean
  code_mode: TrackedLinkCodeMode
  probable_match: boolean
  match_window_minutes: string
}

function LinkDialog({ link, onClose, onSaved }: { link: TrackedLink | null; onClose: () => void; onSaved: () => void }) {
  const t = useT(NS)
  const conns = useQuery({ queryKey: ['facebook', 'connection-options'], queryFn: fetchConnectionOptions })
  const [form, setForm] = useState<FormValues | null>(null)
  const [touched, setTouched] = useState(false)
  const values: FormValues = form ?? {
    name: link?.name ?? '',
    slug: link?.slug ?? '',
    connection_id: link?.connection_id ?? '',
    phone: link?.phone ?? '',
    message: link?.message ?? '',
    utm_source: link?.utm_source ?? '',
    utm_medium: link?.utm_medium ?? '',
    utm_campaign: link?.utm_campaign ?? '',
    utm_content: link?.utm_content ?? '',
    utm_term: link?.utm_term ?? '',
    active: link?.active ?? true,
    code_mode: link?.code_mode ?? 'visible',
    probable_match: link?.probable_match ?? false,
    match_window_minutes: String(link?.match_window_minutes ?? 10),
  }
  const set = (patch: Partial<FormValues>) => setForm({ ...values, ...patch })
  const errors = validateTrackedLink(values)
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: values.name.trim(),
        slug: values.slug.trim() || null,
        connection_id: values.connection_id || null,
        phone: onlyDigits(values.phone) || null,
        message: values.message.trim(),
        utm_source: values.utm_source.trim() || null,
        utm_medium: values.utm_medium.trim() || null,
        utm_campaign: values.utm_campaign.trim() || null,
        utm_content: values.utm_content.trim() || null,
        utm_term: values.utm_term.trim() || null,
        active: values.active,
        code_mode: values.code_mode,
        probable_match: values.code_mode === 'off' ? values.probable_match : false,
        match_window_minutes: Number(values.match_window_minutes),
      }
      return link ? updateTrackedLink(link.id, body) : createTrackedLink(body)
    },
    onSuccess: () => {
      notify(`${P}-saved`, t(link ? 'links.updated' : 'links.created'))
      onSaved()
      onClose()
    },
  })
  const err = (k: keyof typeof errors) => (touched && errors[k] ? t(`links.errors.${errors[k]}`) : null)
  return (
    <FormDialog
      prefix={P}
      open
      wide
      title={t(link ? 'links.editTitle' : 'links.newTitle')}
      onClose={onClose}
      pending={save.isPending}
      error={save.isError ? (serverMessage(save.error) ?? t('common.error')) : null}
      onSubmit={() => {
        setTouched(true)
        if (Object.keys(errors).length === 0) save.mutate()
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('links.fields.name')} htmlFor={`${P}-name`} error={err('name')} errorTestId={`${P}-name-error`}>
          <input id={`${P}-name`} data-testid={`${P}-name`} className={inputClass} maxLength={120} value={values.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={t('links.fields.slug')} htmlFor={`${P}-slug`} error={err('slug')} hint={t('links.help.slug', { example: suggestSlug(values.name) || 'promo' })}>
          <input id={`${P}-slug`} data-testid={`${P}-slug`} className={inputClass} maxLength={63} value={values.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase() })} />
        </Field>
        <Field label={t('links.fields.connection')} htmlFor={`${P}-connection`} error={err('destination')} errorTestId={`${P}-destination-error`}>
          <select id={`${P}-connection`} data-testid={`${P}-connection`} className={selectClass} value={values.connection_id} onChange={(e) => set({ connection_id: e.target.value })}>
            <option value="">{t('links.fields.noConnection')}</option>
            {(conns.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('links.fields.phone')} htmlFor={`${P}-phone`} error={err('phone')} hint={t('links.help.phone')}>
          <input id={`${P}-phone`} data-testid={`${P}-phone`} className={inputClass} inputMode="numeric" value={values.phone} onChange={(e) => set({ phone: onlyDigits(e.target.value) })} />
        </Field>
      </div>
      <Field label={t('links.fields.message')} htmlFor={`${P}-message`} error={err('message')} hint={t('links.help.message')}>
        <textarea id={`${P}-message`} data-testid={`${P}-message`} className={textareaClass} maxLength={500} value={values.message} onChange={(e) => set({ message: e.target.value })} />
      </Field>
      <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-semibold">{t('links.sections.code')}</legend>
        <div className="flex flex-col gap-2">
          {CODE_MODES.map((m) => (
            <label key={m} className="flex items-start gap-2 text-sm">
              <input type="radio" name={`${P}-code-mode`} className="mt-1" data-testid={`${P}-code-${m}`} checked={values.code_mode === m} onChange={() => set({ code_mode: m })} />
              <span>
                {t(`links.codeModes.${m}`)}
                <span className="block text-xs text-muted-foreground">{t(`links.help.code_${m}`)}</span>
              </span>
            </label>
          ))}
        </div>
        {values.code_mode === 'off' ? (
          <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" data-testid={`${P}-probable`} checked={values.probable_match} onChange={(e) => set({ probable_match: e.target.checked })} />
              <span>
                {t('links.fields.probable')}
                <span className="block text-xs text-muted-foreground">{t('links.help.probable')}</span>
              </span>
            </label>
            {values.probable_match ? (
              <Field label={t('links.fields.window')} htmlFor={`${P}-window`} error={err('match_window_minutes')}>
                <input id={`${P}-window`} data-testid={`${P}-window`} type="number" min={1} max={1440} className={inputClass} value={values.match_window_minutes} onChange={(e) => set({ match_window_minutes: e.target.value })} />
              </Field>
            ) : null}
          </div>
        ) : null}
      </fieldset>
      <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-semibold">{t('links.sections.utm')}</legend>
        <p className="text-xs text-muted-foreground">{t('links.help.utm')}</p>
        <div className="grid gap-3 md:grid-cols-3">
          {(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const).map((k) => (
            <Field key={k} label={k} htmlFor={`${P}-${k}`}>
              <input id={`${P}-${k}`} data-testid={`${P}-${k}`} className={inputClass} maxLength={255} value={values[k]} onChange={(e) => set({ [k]: e.target.value } as Partial<FormValues>)} />
            </Field>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" data-testid={`${P}-active`} checked={values.active} onChange={(e) => set({ active: e.target.checked })} />
        {t('links.fields.active')}
      </label>
    </FormDialog>
  )
}
