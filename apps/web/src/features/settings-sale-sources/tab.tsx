// Aba `/settings?tab=sale_sources` (SPEC T73/T90): lista das fontes de venda (tabela no desktop, cartões no mobile),
// criar (com segredo HMAC gerado no navegador e mostrado uma única vez) e excluir. O detalhe da fonte (URL, segredo,
// mapeamento com teste da amostra e o log de eventos) abre em estado local: o hub só aceita `tab`, `company_tab` e `cat`.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  DataList,
  Field,
  FormDialog,
  inputClass,
  isFieldError,
  serverMessage,
  TabHeader,
  usePerms,
} from '@/features/settings-quick-replies/kit'
import { SALE_SOURCES_KEY, saleSourcesApi, saleSourcesQuery, type SaleSourceDto } from './api'
import { SaleSourceDetail } from './detail'
import { cleanMapping, DEFAULT_MAPPING, generateSecret, SOURCE_NAME_MAX, validSourceName } from './rules'
import { ConfirmAction, NS } from './ui'

const P = 'sale-sources'

export default function SaleSourcesTab() {
  const t = useT(NS)
  const qc = useQueryClient()
  const { canEdit, canDelete } = usePerms(['settings.integrations.edit'], ['settings.integrations.delete'])
  const q = useQuery(saleSourcesQuery())
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<SaleSourceDto | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  // Segredo recém-gerado (criação): mostrado uma única vez no detalhe, some ao sair.
  const [revealed, setRevealed] = useState<{ id: string; secret: string } | null>(null)

  if (openId)
    return (
      <SaleSourceDetail
        id={openId}
        initialSecret={revealed?.id === openId ? revealed.secret : null}
        onBack={() => {
          setOpenId(null)
          setRevealed(null)
        }}
      />
    )

  return (
    <section data-testid="page-sale-sources" className="flex min-w-0 flex-col gap-4">
      <TabHeader
        prefix={P}
        title={t('title')}
        subtitle={t('subtitle')}
        canCreate={canEdit}
        newLabel={t('new')}
        onNew={() => setCreating(true)}
      />
      <DataList
        prefix={P}
        status={q.status}
        rows={q.data ?? []}
        rowId={(r) => r.id}
        empty={t('empty')}
        title={(r) => <OpenLink row={r} onOpen={setOpenId} />}
        columns={[
          {
            id: 'name',
            header: t('cols.name'),
            className: 'font-medium',
            cell: (r) => <OpenLink row={r} onOpen={setOpenId} />,
          },
          {
            id: 'active',
            header: t('cols.status'),
            className: 'w-28',
            cell: (r) => (
              <span
                data-testid={`${P}-item-active-${r.id}`}
                data-active={r.active}
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  r.active
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {t(r.active ? 'status.active' : 'status.inactive')}
              </span>
            ),
          },
          {
            id: 'hmac',
            header: t('cols.hmac'),
            className: 'w-32',
            cell: (r) => (
              <span
                data-testid={`${P}-item-hmac-${r.id}`}
                data-configured={r.hmac_configured}
                className="text-muted-foreground"
              >
                {t(r.hmac_configured ? 'secret.configured' : 'secret.none')}
              </span>
            ),
          },
        ]}
        canEdit={() => true}
        canDelete={() => canDelete}
        onEdit={(r) => setOpenId(r.id)}
        onDelete={(r) => setDeleting(r)}
      />

      {creating ? (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(source, secret) => {
            setCreating(false)
            if (secret) setRevealed({ id: source.id, secret })
            setOpenId(source.id)
          }}
        />
      ) : null}
      <ConfirmAction
        prefix={`${P}-delete`}
        open={!!deleting}
        title={t('delete.title')}
        body={deleting ? t('delete.body', { name: deleting.name }) : ''}
        confirmLabel={t('delete.confirm')}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return
          try {
            await saleSourcesApi.remove(deleting.id)
            await qc.invalidateQueries({ queryKey: SALE_SOURCES_KEY })
          } catch (err) {
            notify('sale-sources-error', serverMessage(err) ?? t('common.error'))
          }
          setDeleting(null)
        }}
      />
    </section>
  )
}

function OpenLink({ row, onOpen }: { row: SaleSourceDto; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      data-testid={`${P}-item-name-${row.id}`}
      onClick={() => onOpen(row.id)}
      className="min-w-0 text-left font-medium break-words underline-offset-2 hover:underline"
    >
      {row.name}
    </button>
  )
}

function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (s: SaleSourceDto, secret: string | null) => void
}) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [withSecret, setWithSecret] = useState(true)
  const [tried, setTried] = useState(false)
  const save = useMutation({
    mutationFn: async () => {
      const secret = withSecret ? generateSecret() : null
      const source = await saleSourcesApi.create({
        name: name.trim(),
        mapping: cleanMapping(DEFAULT_MAPPING),
        ...(secret ? { hmac_secret: secret } : {}),
      })
      return { source, secret }
    },
    onSuccess: async ({ source, secret }) => {
      await qc.invalidateQueries({ queryKey: SALE_SOURCES_KEY })
      onCreated(source, secret)
    },
  })
  const nameError = isFieldError(save.error, 'name')
    ? serverMessage(save.error, 'name')
    : tried && !validSourceName(name)
      ? t('errors.name')
      : null
  return (
    <FormDialog
      prefix={P}
      open
      title={t('create.title')}
      onClose={onClose}
      pending={save.isPending}
      error={save.error && !isFieldError(save.error, 'name') ? (serverMessage(save.error) ?? t('common.error')) : null}
      onSubmit={() => {
        setTried(true)
        if (!validSourceName(name)) return
        save.mutate()
      }}
    >
      <Field
        label={t('fields.name')}
        htmlFor="sale-source-name"
        error={nameError}
        errorTestId={`${P}-create-name-error`}
      >
        <input
          id="sale-source-name"
          data-testid={`${P}-create-name`}
          value={name}
          maxLength={SOURCE_NAME_MAX}
          placeholder={t('create.namePlaceholder')}
          onChange={(e) => {
            setName(e.target.value)
            if (save.error) save.reset()
          }}
          className={inputClass}
          autoComplete="off"
        />
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          data-testid={`${P}-create-hmac`}
          checked={withSecret}
          onChange={(e) => setWithSecret(e.target.checked)}
          className="mt-0.5 size-4"
        />
        <span>
          {t('create.hmac')}
          <span className="block text-xs text-muted-foreground">{t('create.hmacHint')}</span>
        </span>
      </label>
    </FormDialog>
  )
}
