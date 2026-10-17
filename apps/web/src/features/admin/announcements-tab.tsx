// Abas Avisos e Banners (20 §3.6, §3.7, §5 item 6; AC-T100-03): CRUD com busca (debounce 450 ms) e paginação (20),
// imagem por upload global (URL pública) com prévia. O banner só salva com imagem.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  ConfirmDialog,
  DataList,
  Field,
  FormDialog,
  inputClass,
  isFieldError,
  Pager,
  SearchBox,
  serverMessage,
  TabHeader,
  textareaClass,
  useDebounced,
} from '@/features/settings-quick-replies/kit'
import { useI18n, useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { ADMIN_KEY, adminAnnouncementsQuery, adminApi, adminBannersQuery, type AnnouncementDto, type BannerDto } from './api'
import {
  ADMIN_SEARCH_DEBOUNCE_MS,
  ANNOUNCEMENT_TYPES,
  announcementPayload,
  bannerCanSave,
  bannerPayload,
  isoToLocalInput,
  validateAnnouncementDraft,
  validateBannerDraft,
  type AnnouncementDraft,
  type BannerDraft,
} from './rules'
import { fmtDateTime, ImageField, NS, StatusBadge } from './ui'

function useListState() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const applied = useDebounced(search.trim(), ADMIN_SEARCH_DEBOUNCE_MS)
  useEffect(() => setPage(1), [applied])
  return { search, setSearch, page, setPage, applied }
}

/** Erro do campo: o local (chave i18n) e, depois, o do servidor. */
function useFieldErrors(local: Partial<Record<string, string>>, serverError: unknown) {
  const t = useT(NS)
  return (k: string) => (local[k] ? t(`form.errors.${local[k]}`) : isFieldError(serverError, k) ? serverMessage(serverError, k) : null)
}

const generalError = (err: unknown, fields: readonly string[], fallback: string) =>
  err && !fields.some((k) => isFieldError(err, k)) ? serverMessage(err) ?? fallback : null

function ActiveField({ prefix, value, onChange }: { prefix: string; value: boolean; onChange: (v: boolean) => void }) {
  const t = useT(NS)
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" data-testid={`${prefix}-active`} checked={value} onChange={(e) => onChange(e.target.checked)} className="size-4" />
      {t('form.active')}
    </label>
  )
}

function PriorityExpiry({
  prefix,
  priority,
  expires,
  onPriority,
  onExpires,
  priorityError,
}: {
  prefix: string
  priority: string
  expires: string
  onPriority: (v: string) => void
  onExpires: (v: string) => void
  priorityError: string | null
}) {
  const t = useT(NS)
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('form.priority')} htmlFor={`${prefix}-priority`} error={priorityError} errorTestId={`${prefix}-priority-error`} hint={t('form.priorityHint')}>
        <input id={`${prefix}-priority`} data-testid={`${prefix}-priority`} inputMode="numeric" className={inputClass} value={priority} onChange={(e) => onPriority(e.target.value)} />
      </Field>
      <Field label={t('form.expiresAt')} htmlFor={`${prefix}-expires-at`} hint={t('form.expiresHint')}>
        <input id={`${prefix}-expires-at`} data-testid={`${prefix}-expires-at`} type="datetime-local" className={inputClass} value={expires} onChange={(e) => onExpires(e.target.value)} />
      </Field>
    </div>
  )
}

// ---------------------------------------------------------------- avisos

const PA = 'admin-announcements'

export function AnnouncementsTab() {
  const t = useT(NS)
  const { locale } = useI18n()
  const qc = useQueryClient()
  const s = useListState()
  const q = useQuery(adminAnnouncementsQuery(s.page, s.applied))
  const [editing, setEditing] = useState<AnnouncementDto | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AnnouncementDto | null>(null)
  return (
    <div data-testid="admin-panel-announcements" className="flex flex-col gap-4">
      <TabHeader prefix={PA} title={t('tabs.announcements')} subtitle={t('announcements.subtitle')} canCreate newLabel={t('announcements.new')} onNew={() => setEditing('new')} />
      <SearchBox prefix={PA} value={s.search} onChange={s.setSearch} placeholder={t('announcements.search')} />
      <DataList
        prefix={PA}
        rows={q.data?.items ?? []}
        rowId={(a) => a.id}
        status={q.status}
        empty={s.applied ? t('common.noResults') : t('announcements.empty')}
        title={(a) => a.title}
        canEdit={() => true}
        canDelete={() => true}
        onEdit={setEditing}
        onDelete={setDeleting}
        columns={[
          { id: 'title', header: t('form.title'), cell: (a) => <span data-testid={`${PA}-item-title-${a.id}`}>{a.title}</span> },
          { id: 'type', header: t('form.type'), cell: (a) => <span data-testid={`${PA}-item-type-${a.id}`}>{t(`types.${a.announcement_type}`)}</span> },
          { id: 'priority', header: t('form.priority'), cell: (a) => a.priority },
          { id: 'expires', header: t('form.expiresAt'), cell: (a) => fmtDateTime(a.expires_at, locale) },
          {
            id: 'active',
            header: t('form.status'),
            cell: (a) => <StatusBadge ok={a.active} testId={`${PA}-item-active-${a.id}`} label={t(a.active ? 'form.activeOn' : 'form.activeOff')} />,
          },
        ]}
      />
      <Pager prefix={PA} meta={q.data?.page} onPage={s.setPage} />
      {editing ? <AnnouncementDialog item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        prefix={PA}
        open={!!deleting}
        title={t('announcements.deleteTitle')}
        body={t('announcements.deleteBody', { title: deleting?.title ?? '' })}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return
          try {
            await adminApi.deleteAnnouncement(deleting.id)
            await qc.invalidateQueries({ queryKey: [...ADMIN_KEY, 'announcements'] })
            notify('admin-announcement-deleted', t('announcements.deleted'))
            setDeleting(null)
          } catch {
            notify('admin-error', t('common.saveFailed'))
          }
        }}
      />
    </div>
  )
}

function AnnouncementDialog({ item, onClose }: { item: AnnouncementDto | null; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const P = 'admin-announcement'
  const [d, setD] = useState<AnnouncementDraft>(() => ({
    title: item?.title ?? '',
    message: item?.message ?? '',
    announcement_type: item?.announcement_type ?? 'info',
    image_url: item?.image_url ?? '',
    url: item?.url ?? '',
    priority: String(item?.priority ?? 0),
    expires_at: isoToLocalInput(item?.expires_at),
    active: item?.active ?? true,
  }))
  const [errors, setErrors] = useState<ReturnType<typeof validateAnnouncementDraft>>({})
  const [uploading, setUploading] = useState(false)
  const set = <K extends keyof AnnouncementDraft>(k: K, v: AnnouncementDraft[K]) => setD((x) => ({ ...x, [k]: v }))
  const save = useMutation({
    mutationFn: () => (item ? adminApi.updateAnnouncement(item.id, announcementPayload(d)) : adminApi.createAnnouncement(announcementPayload(d))),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [...ADMIN_KEY, 'announcements'] })
      notify('admin-announcement-saved', t(item ? 'announcements.updated' : 'announcements.created'))
      onClose()
    },
  })
  const err = useFieldErrors(errors, save.error)
  const fields = ['title', 'message', 'image_url', 'url', 'priority', 'expires_at', 'announcement_type'] as const
  return (
    <FormDialog
      prefix={P}
      open
      wide
      title={t(item ? 'announcements.edit' : 'announcements.new')}
      onClose={onClose}
      pending={save.isPending || uploading}
      error={generalError(save.error, fields, t('common.saveFailed'))}
      onSubmit={() => {
        const e = validateAnnouncementDraft(d)
        setErrors(e)
        if (Object.keys(e).length === 0) save.mutate()
      }}
    >
      <Field label={`${t('form.title')} *`} htmlFor={`${P}-title`} error={err('title')} errorTestId={`${P}-title-error`}>
        <input id={`${P}-title`} data-testid={`${P}-title`} className={inputClass} maxLength={200} value={d.title} onChange={(e) => set('title', e.target.value)} />
      </Field>
      <Field label={`${t('form.message')} *`} htmlFor={`${P}-message`} error={err('message')} errorTestId={`${P}-message-error`}>
        <textarea id={`${P}-message`} data-testid={`${P}-message`} className={textareaClass} maxLength={5000} value={d.message} onChange={(e) => set('message', e.target.value)} />
      </Field>
      <Field label={t('form.type')} htmlFor={`${P}-type`}>
        <select
          id={`${P}-type`}
          data-testid={`${P}-type`}
          className={inputClass}
          value={d.announcement_type}
          onChange={(e) => set('announcement_type', e.target.value as AnnouncementDraft['announcement_type'])}
        >
          {ANNOUNCEMENT_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`types.${x}`)} — {t(`typeHints.${x}`)}
            </option>
          ))}
        </select>
      </Field>
      <ImageField prefix={P} label={t('form.image')} value={d.image_url} onChange={(v) => set('image_url', v)} onUploading={setUploading} error={err('image_url')} />
      <Field label={t('form.url')} htmlFor={`${P}-url`} error={err('url')} errorTestId={`${P}-url-error`} hint={t('form.urlHint')}>
        <input id={`${P}-url`} data-testid={`${P}-url`} className={inputClass} placeholder="https://" value={d.url} onChange={(e) => set('url', e.target.value)} />
      </Field>
      <PriorityExpiry
        prefix={P}
        priority={d.priority}
        expires={d.expires_at}
        onPriority={(v) => set('priority', v)}
        onExpires={(v) => set('expires_at', v)}
        priorityError={err('priority')}
      />
      <ActiveField prefix={P} value={d.active} onChange={(v) => set('active', v)} />
    </FormDialog>
  )
}

// ---------------------------------------------------------------- banners

const PB = 'admin-banners'

export function BannersTab() {
  const t = useT(NS)
  const { locale } = useI18n()
  const qc = useQueryClient()
  const s = useListState()
  const q = useQuery(adminBannersQuery(s.page, s.applied))
  const [editing, setEditing] = useState<BannerDto | 'new' | null>(null)
  const [deleting, setDeleting] = useState<BannerDto | null>(null)
  return (
    <div data-testid="admin-panel-banners" className="flex flex-col gap-4">
      <TabHeader prefix={PB} title={t('tabs.banners')} subtitle={t('banners.subtitle')} canCreate newLabel={t('banners.new')} onNew={() => setEditing('new')} />
      <SearchBox prefix={PB} value={s.search} onChange={s.setSearch} placeholder={t('banners.search')} />
      <DataList
        prefix={PB}
        rows={q.data?.items ?? []}
        rowId={(b) => b.id}
        status={q.status}
        empty={s.applied ? t('common.noResults') : t('banners.empty')}
        title={(b) => b.title || t('banners.untitled')}
        canEdit={() => true}
        canDelete={() => true}
        onEdit={setEditing}
        onDelete={setDeleting}
        columns={[
          {
            id: 'image',
            header: t('form.image'),
            cell: (b) => <img data-testid={`${PB}-item-image-${b.id}`} src={b.image_url} alt="" className="h-10 max-w-32 rounded border object-cover" />,
          },
          { id: 'title', header: t('banners.title'), cell: (b) => <span data-testid={`${PB}-item-title-${b.id}`}>{b.title || t('banners.untitled')}</span> },
          { id: 'priority', header: t('form.priority'), cell: (b) => b.priority },
          { id: 'expires', header: t('form.expiresAt'), cell: (b) => fmtDateTime(b.expires_at, locale) },
          {
            id: 'active',
            header: t('form.status'),
            cell: (b) => <StatusBadge ok={b.active} testId={`${PB}-item-active-${b.id}`} label={t(b.active ? 'form.activeOn' : 'form.activeOff')} />,
          },
        ]}
      />
      <Pager prefix={PB} meta={q.data?.page} onPage={s.setPage} />
      {editing ? <BannerDialog item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        prefix={PB}
        open={!!deleting}
        title={t('banners.deleteTitle')}
        body={t('banners.deleteBody', { title: deleting?.title || t('banners.untitled') })}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return
          try {
            await adminApi.deleteBanner(deleting.id)
            await qc.invalidateQueries({ queryKey: [...ADMIN_KEY, 'banners'] })
            notify('admin-banner-deleted', t('banners.deleted'))
            setDeleting(null)
          } catch {
            notify('admin-error', t('common.saveFailed'))
          }
        }}
      />
    </div>
  )
}

function BannerDialog({ item, onClose }: { item: BannerDto | null; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const P = 'admin-banner'
  const [d, setD] = useState<BannerDraft>(() => ({
    title: item?.title ?? '',
    image_url: item?.image_url ?? '',
    url: item?.url ?? '',
    priority: String(item?.priority ?? 0),
    expires_at: isoToLocalInput(item?.expires_at),
    active: item?.active ?? true,
  }))
  const [errors, setErrors] = useState<ReturnType<typeof validateBannerDraft>>({})
  const [uploading, setUploading] = useState(false)
  const set = <K extends keyof BannerDraft>(k: K, v: BannerDraft[K]) => setD((x) => ({ ...x, [k]: v }))
  const save = useMutation({
    mutationFn: () => (item ? adminApi.updateBanner(item.id, bannerPayload(d)) : adminApi.createBanner(bannerPayload(d))),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [...ADMIN_KEY, 'banners'] })
      notify('admin-banner-saved', t(item ? 'banners.updated' : 'banners.created'))
      onClose()
    },
  })
  const err = useFieldErrors(errors, save.error)
  const fields = ['title', 'image_url', 'url', 'priority', 'expires_at'] as const
  return (
    <FormDialog
      prefix={P}
      open
      wide
      title={t(item ? 'banners.edit' : 'banners.new')}
      onClose={onClose}
      // 20 §3.7: salvar desabilitado enquanto não houver imagem.
      pending={save.isPending || !bannerCanSave(d, uploading)}
      error={generalError(save.error, fields, t('common.saveFailed'))}
      onSubmit={() => {
        const e = validateBannerDraft(d)
        setErrors(e)
        if (Object.keys(e).length === 0) save.mutate()
      }}
    >
      <Field label={t('banners.title')} htmlFor={`${P}-title`} error={err('title')} errorTestId={`${P}-title-error`} hint={t('banners.titleHint')}>
        <input id={`${P}-title`} data-testid={`${P}-title`} className={inputClass} maxLength={200} value={d.title} onChange={(e) => set('title', e.target.value)} />
      </Field>
      <ImageField prefix={P} label={t('form.image')} required value={d.image_url} onChange={(v) => set('image_url', v)} onUploading={setUploading} error={err('image_url')} />
      <Field label={t('form.url')} htmlFor={`${P}-url`} error={err('url')} errorTestId={`${P}-url-error`} hint={t('form.urlHint')}>
        <input id={`${P}-url`} data-testid={`${P}-url`} className={inputClass} placeholder="https://" value={d.url} onChange={(e) => set('url', e.target.value)} />
      </Field>
      <PriorityExpiry
        prefix={P}
        priority={d.priority}
        expires={d.expires_at}
        onPriority={(v) => set('priority', v)}
        onExpires={(v) => set('expires_at', v)}
        priorityError={err('priority')}
      />
      <ActiveField prefix={P} value={d.active} onChange={(v) => set('active', v)} />
    </FormDialog>
  )
}
