// Pixel (11 §2.2, §3.3, §5.4; AC-T106-05): tabela com Pixel ID e token mascarados, "Novo Pixel", edição (carrega o
// token com `include_access_token=true`) e exclusão com diálogo de confirmação (nunca `window.confirm`).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ConfirmDialog, DataList, Field, FormDialog, inputClass, serverMessage, TabHeader, type Column } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { createPixel, deletePixel, fetchPixel, fetchPixels, pixelsKey, updatePixel, type PixelConfig } from './api'
import { NS, selectClass, useFacebookSession } from './layout'
import { onlyDigits, validatePixel } from './rules'

const P = 'facebook-pixel'

export function PixelPage() {
  const t = useT(NS)
  const qc = useQueryClient()
  const companyId = useFacebookSession()?.company?.id
  const list = useQuery({ queryKey: pixelsKey(companyId), queryFn: fetchPixels })
  const [editing, setEditing] = useState<PixelConfig | 'new' | null>(null)
  const [removing, setRemoving] = useState<PixelConfig | null>(null)

  const columns: Column<PixelConfig>[] = [
    { id: 'name', header: t('pixel.columns.name'), cell: (p) => <span className="font-medium">{p.name}</span> },
    { id: 'platform', header: t('pixel.columns.platform'), cell: (p) => t(`pixel.platforms.${p.platform}`) },
    { id: 'ad_account', header: t('pixel.columns.adAccount'), cell: () => <span className="text-muted-foreground">{t('pixel.notImplemented')}</span> },
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
  ]

  return (
    <div className="flex flex-col gap-4">
      <TabHeader prefix={P} title={t('pixel.title')} subtitle={t('pixel.subtitle')} canCreate newLabel={t('pixel.new')} onNew={() => setEditing('new')} />
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

function PixelDialog({ pixel, onClose, onSaved }: { pixel: PixelConfig | null; onClose: () => void; onSaved: () => void }) {
  const t = useT(NS)
  const editing = !!pixel
  // Edição: o registro com o token (só o GET individual traz).
  const full = useQuery({ queryKey: ['facebook', 'pixel', pixel?.id ?? ''], queryFn: () => fetchPixel(pixel!.id), enabled: editing, staleTime: 0, gcTime: 0 })
  const loaded = !editing || full.isSuccess
  const [form, setForm] = useState<{ name: string; pixel_id: string; access_token: string; platform: string; auto_send_sales: boolean } | null>(null)
  const [touched, setTouched] = useState(false)
  const values = form ?? {
    name: pixel?.name ?? '',
    pixel_id: full.data?.pixel_id ?? '',
    access_token: full.data?.access_token ?? '',
    platform: pixel?.platform ?? 'facebook',
    auto_send_sales: pixel?.auto_send_sales ?? false,
  }
  const set = (patch: Partial<typeof values>) => setForm({ ...values, ...patch })
  const errors = validatePixel(values, editing)
  const save = useMutation({
    mutationFn: () => {
      const body = { name: values.name.trim(), pixel_id: values.pixel_id.trim(), access_token: values.access_token.trim() || null, platform: values.platform, auto_send_sales: values.auto_send_sales }
      return pixel ? updatePixel(pixel.id, body) : createPixel({ ...body, access_token: body.access_token ?? '' })
    },
    onSuccess: () => {
      notify(`${P}-saved`, t(editing ? 'pixel.updated' : 'pixel.created'))
      onSaved()
      onClose()
    },
  })
  const err = (k: keyof typeof errors) => (touched && errors[k] ? t(`pixel.errors.${errors[k]}`) : null)
  return (
    <FormDialog
      prefix={P}
      open
      title={t(editing ? 'pixel.editTitle' : 'pixel.newTitle')}
      onClose={onClose}
      pending={save.isPending || !loaded}
      error={save.isError ? (serverMessage(save.error) ?? t('common.error')) : full.isError ? t('common.loadError') : null}
      onSubmit={() => {
        setTouched(true)
        if (Object.keys(errors).length === 0) save.mutate()
      }}
    >
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
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" data-testid={`${P}-auto-send`} checked={values.auto_send_sales} onChange={(e) => set({ auto_send_sales: e.target.checked })} />
        {t('pixel.fields.autoSend')}
      </label>
    </FormDialog>
  )
}
