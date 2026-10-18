// Pixel (11 §2.2, §3.3, §5.4; AC-T106-05): tabela com Pixel ID e token mascarados, "Novo Pixel", edição (carrega o
// token com `include_access_token=true`) e exclusão com diálogo de confirmação (nunca `window.confirm`).
// Revisão 3 (docs/integrations/meta-capi.md): campos opcionais Página do Facebook e WABA id (modo "mensagem de
// anúncio", business_messaging, com ajuda equivalente à do Leona), código de teste por pixel (aviso visível de que os
// eventos vão para "Testar eventos"), país padrão, Lead automático de anúncio e o último resultado do modo
// business_messaging. "Eventos enviados" abre o diagnóstico do pixel.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FlaskConical } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog, DataList, Field, FormDialog, inputClass, serverMessage, TabHeader, type Column } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { createPixel, deletePixel, fetchPixel, fetchPixels, pixelsKey, updatePixel, type PixelConfig } from './api'
import { NS, selectClass, useFacebookSession } from './layout'
import { onlyDigits, PIXEL_COUNTRIES, pixelHasAdMessaging, validatePixel, validatePixelExtras } from './rules'

const P = 'facebook-pixel'

export function PixelPage() {
  const t = useT(NS)
  const qc = useQueryClient()
  const companyId = useFacebookSession()?.company?.id
  const list = useQuery({ queryKey: pixelsKey(companyId), queryFn: fetchPixels })
  const [editing, setEditing] = useState<PixelConfig | 'new' | null>(null)
  const [removing, setRemoving] = useState<PixelConfig | null>(null)
  const testing = (list.data ?? []).filter((p) => p.test_event_code)

  const columns: Column<PixelConfig>[] = [
    {
      id: 'name',
      header: t('pixel.columns.name'),
      cell: (p) => (
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {p.name}
          {p.test_event_code ? (
            <span data-testid={`${P}-item-test-${p.id}`} className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
              <FlaskConical className="size-3" aria-hidden /> {t('pixel.testBadge')}
            </span>
          ) : null}
        </span>
      ),
    },
    { id: 'platform', header: t('pixel.columns.platform'), cell: (p) => t(`pixel.platforms.${p.platform}`) },
    {
      id: 'mode',
      header: t('pixel.columns.mode'),
      cell: (p) => (
        <span data-testid={`${P}-item-mode-${p.id}`} className="text-xs">
          {pixelHasAdMessaging(p) ? (
            <>
              {t('pixel.mode.adMessaging')}
              {p.business_messaging ? <span className="block text-muted-foreground">{t(`pixel.mode.bm_${p.business_messaging.status}`)}</span> : null}
            </>
          ) : (
            t('pixel.mode.chat')
          )}
        </span>
      ),
    },
    {
      id: 'pixel_id',
      header: t('pixel.columns.pixelId'),
      cell: (p) => (
        <code data-testid={`${P}-item-pixel-id-${p.id}`} className="font-mono text-xs">
          {p.masked_pixel_id}
        </code>
      ),
    },
    {
      id: 'token',
      header: t('pixel.columns.token'),
      cell: (p) => (
        <code data-testid={`${P}-item-token-${p.id}`} className="font-mono text-xs">
          {p.masked_access_token || '***'}
        </code>
      ),
    },
    {
      id: 'events',
      header: t('pixel.columns.events'),
      cell: (p) => (
        <Link to={'/facebook/events' as never} search={{ ev_pixel: p.id } as never} data-testid={`${P}-item-events-${p.id}`} className="text-sm text-primary underline-offset-2 hover:underline">
          {t('pixel.viewEvents')}
        </Link>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <TabHeader prefix={P} title={t('pixel.title')} subtitle={t('pixel.subtitle')} canCreate newLabel={t('pixel.new')} onNew={() => setEditing('new')} />
      {testing.length ? (
        <div data-testid={`${P}-test-warning`} role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <FlaskConical className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <p>{t('pixel.testWarning', { names: testing.map((p) => p.name).join(', ') })}</p>
        </div>
      ) : null}
      {list.status === 'error' ? (
        <div data-testid={`${P}-error-state`} className="flex flex-col items-start gap-2 rounded-lg border border-destructive/40 p-4 text-sm">
          <p className="text-destructive">{t('common.loadError')}</p>
          <button type="button" className="underline" onClick={() => void list.refetch()}>
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <DataList
          prefix={P}
          rows={list.data ?? []}
          rowId={(p) => p.id}
          columns={columns}
          title={(p) => p.name}
          canEdit={() => true}
          canDelete={() => true}
          onEdit={(p) => setEditing(p)}
          onDelete={(p) => setRemoving(p)}
          status={list.status}
          empty={t('pixel.empty')}
        />
      )}
      {editing ? <PixelDialog pixel={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void qc.invalidateQueries({ queryKey: pixelsKey(companyId) })} /> : null}
      <ConfirmDialog
        prefix={P}
        open={!!removing}
        title={t('pixel.deleteTitle')}
        body={t('pixel.deleteBody', { name: removing?.name ?? '' })}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return
          try {
            await deletePixel(removing.id)
            notify(`${P}-deleted`, t('pixel.deleted'))
            setRemoving(null)
            await qc.invalidateQueries({ queryKey: pixelsKey(companyId) })
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
  pixel_id: string
  access_token: string
  platform: string
  auto_send_sales: boolean
  page_id: string
  whatsapp_business_account_id: string
  test_event_code: string
  default_country: string
  auto_lead_on_ad: boolean
}

function PixelDialog({ pixel, onClose, onSaved }: { pixel: PixelConfig | null; onClose: () => void; onSaved: () => void }) {
  const t = useT(NS)
  const editing = !!pixel
  // Edição: o registro com o token (só o GET individual traz).
  const full = useQuery({ queryKey: ['facebook', 'pixel', pixel?.id ?? ''], queryFn: () => fetchPixel(pixel!.id), enabled: editing, staleTime: 0, gcTime: 0 })
  const loaded = !editing || full.isSuccess
  const [form, setForm] = useState<FormValues | null>(null)
  const [touched, setTouched] = useState(false)
  const src = full.data ?? pixel
  const values: FormValues = form ?? {
    name: pixel?.name ?? '',
    pixel_id: full.data?.pixel_id ?? '',
    access_token: full.data?.access_token ?? '',
    platform: pixel?.platform ?? 'facebook',
    auto_send_sales: pixel?.auto_send_sales ?? false,
    page_id: src?.page_id ?? '',
    whatsapp_business_account_id: src?.whatsapp_business_account_id ?? '',
    test_event_code: src?.test_event_code ?? '',
    default_country: src?.default_country ?? 'br',
    auto_lead_on_ad: src?.auto_lead_on_ad ?? false,
  }
  const set = (patch: Partial<FormValues>) => setForm({ ...values, ...patch })
  const errors = { ...validatePixel(values, editing), ...validatePixelExtras(values) }
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: values.name.trim(),
        pixel_id: values.pixel_id.trim(),
        access_token: values.access_token.trim() || null,
        platform: values.platform,
        auto_send_sales: values.auto_send_sales,
        page_id: values.page_id.trim() || null,
        whatsapp_business_account_id: values.whatsapp_business_account_id.trim() || null,
        test_event_code: values.test_event_code.trim() || null,
        default_country: values.default_country.trim().toLowerCase(),
        auto_lead_on_ad: values.auto_lead_on_ad,
      }
      return pixel ? updatePixel(pixel.id, body) : createPixel({ ...body, access_token: body.access_token ?? '' })
    },
    onSuccess: () => {
      notify(`${P}-saved`, t(editing ? 'pixel.updated' : 'pixel.created'))
      onSaved()
      onClose()
    },
  })
  const err = (k: keyof typeof errors) => (touched && errors[k] ? t(`pixel.errors.${errors[k]}`) : null)
  const bm = src?.business_messaging
  return (
    <FormDialog
      prefix={P}
      open
      wide
      title={t(editing ? 'pixel.editTitle' : 'pixel.newTitle')}
      onClose={onClose}
      pending={save.isPending || !loaded}
      error={save.isError ? (serverMessage(save.error) ?? t('common.error')) : full.isError ? t('common.loadError') : null}
      onSubmit={() => {
        setTouched(true)
        if (Object.keys(errors).length === 0) save.mutate()
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('pixel.fields.name')} htmlFor={`${P}-name`} error={err('name')} errorTestId={`${P}-name-error`}>
          <input id={`${P}-name`} data-testid={`${P}-name`} className={inputClass} maxLength={255} value={values.name} disabled={!loaded} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={t('pixel.fields.platform')} htmlFor={`${P}-platform`}>
          <select id={`${P}-platform`} data-testid={`${P}-platform`} className={selectClass} value={values.platform} onChange={(e) => set({ platform: e.target.value })}>
            <option value="facebook">{t('pixel.platforms.facebook')}</option>
          </select>
        </Field>
        <Field label={t('pixel.fields.pixelId')} htmlFor={`${P}-pixel-id`} error={err('pixel_id')} errorTestId={`${P}-pixel-id-error`}>
          <input
            id={`${P}-pixel-id`}
            data-testid={`${P}-pixel-id`}
            className={inputClass}
            inputMode="numeric"
            value={values.pixel_id}
            disabled={!loaded}
            onChange={(e) => set({ pixel_id: onlyDigits(e.target.value) })}
          />
        </Field>
        <Field
          label={t('pixel.fields.token')}
          htmlFor={`${P}-token`}
          error={err('access_token')}
          errorTestId={`${P}-token-error`}
          hint={editing ? t('pixel.tokenKeepHint') : undefined}
        >
          <input
            id={`${P}-token`}
            data-testid={`${P}-token`}
            className={inputClass}
            type="password"
            autoComplete="off"
            value={values.access_token}
            disabled={!loaded}
            onChange={(e) => set({ access_token: e.target.value })}
          />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-semibold">{t('pixel.sections.adMessaging')}</legend>
        <p className="text-xs text-muted-foreground">{t('pixel.help.adMessaging')}</p>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('pixel.fields.pageId')} htmlFor={`${P}-page-id`} error={err('page_id')} errorTestId={`${P}-page-id-error`} hint={t('pixel.help.pageId')}>
            <input
              id={`${P}-page-id`}
              data-testid={`${P}-page-id`}
              className={inputClass}
              inputMode="numeric"
              placeholder="105222333444555"
              value={values.page_id}
              disabled={!loaded}
              onChange={(e) => set({ page_id: onlyDigits(e.target.value) })}
            />
          </Field>
          <Field label={t('pixel.fields.wabaId')} htmlFor={`${P}-waba-id`} error={err('whatsapp_business_account_id')} errorTestId={`${P}-waba-id-error`} hint={t('pixel.help.wabaId')}>
            <input
              id={`${P}-waba-id`}
              data-testid={`${P}-waba-id`}
              className={inputClass}
              inputMode="numeric"
              value={values.whatsapp_business_account_id}
              disabled={!loaded}
              onChange={(e) => set({ whatsapp_business_account_id: onlyDigits(e.target.value) })}
            />
          </Field>
        </div>
        {bm ? (
          <p data-testid={`${P}-bm-status`} className={bm.status === 'rejected' ? 'text-xs text-amber-700 dark:text-amber-300' : 'text-xs text-emerald-700 dark:text-emerald-300'}>
            {t(`pixel.bmResult.${bm.status}`, { date: new Date(bm.checked_at).toLocaleString(), error: bm.error ?? '' })}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-semibold">{t('pixel.sections.events')}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" data-testid={`${P}-auto-send`} checked={values.auto_send_sales} onChange={(e) => set({ auto_send_sales: e.target.checked })} />
          {t('pixel.fields.autoSend')}
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" data-testid={`${P}-auto-lead`} checked={values.auto_lead_on_ad} onChange={(e) => set({ auto_lead_on_ad: e.target.checked })} />
          <span>
            {t('pixel.fields.autoLead')}
            <span className="block text-xs text-muted-foreground">{t('pixel.help.autoLead')}</span>
          </span>
        </label>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('pixel.fields.country')} htmlFor={`${P}-country`} error={err('default_country')} hint={t('pixel.help.country')}>
            <select id={`${P}-country`} data-testid={`${P}-country`} className={selectClass} value={values.default_country} onChange={(e) => set({ default_country: e.target.value })}>
              {[...new Set([values.default_country, ...PIXEL_COUNTRIES])].map((c) => (
                <option key={c} value={c}>
                  {c.toUpperCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('pixel.fields.testCode')} htmlFor={`${P}-test-code`} error={err('test_event_code')} errorTestId={`${P}-test-code-error`} hint={t('pixel.help.testCode')}>
            <input
              id={`${P}-test-code`}
              data-testid={`${P}-test-code`}
              className={inputClass}
              placeholder="TEST12345"
              autoComplete="off"
              value={values.test_event_code}
              disabled={!loaded}
              onChange={(e) => set({ test_event_code: e.target.value.trim() })}
            />
          </Field>
        </div>
        {values.test_event_code.trim() ? (
          <p data-testid={`${P}-test-code-warning`} role="status" className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            {t('pixel.help.testCodeOn')}
          </p>
        ) : null}
      </fieldset>
    </FormDialog>
  )
}
