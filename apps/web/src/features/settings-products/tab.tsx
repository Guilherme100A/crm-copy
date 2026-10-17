// Aba `/settings?tab=products` (19 §2.6, AC-T90-01/04): tabela (cartões no mobile) com busca no servidor, modal de
// criar/editar com as regras de faixa e fallback do servidor e exclusão com confirmação (as vendas ficam sem produto).
// O id interno (`id`) é o que as fontes de venda usam para ligar a venda ao produto (T73 `productFor`).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useI18n, useT } from '@/i18n'
import { notify } from '@/lib/toast'
import {
  ConfirmDialog,
  DataList,
  SearchBox,
  serverMessage,
  TabHeader,
  useDebounced,
  usePerms,
} from '@/features/settings-quick-replies/kit'
import { PRODUCTS_KEY, productsApi, productsQuery, type ProductDto } from './api'
import { PRODUCTS_PREFIX as P, ProductDialog } from './product-dialog'
import { formatMoney } from './rules'

const NS = 'settings-products'

export default function ProductsTab() {
  const t = useT(NS)
  const { locale } = useI18n()
  const qc = useQueryClient()
  const { canEdit, canDelete } = usePerms(['settings.products.edit'], ['settings.products.delete'])
  const [search, setSearch] = useState('')
  const term = useDebounced(search.trim())
  const q = useQuery(productsQuery(term))
  const [editing, setEditing] = useState<ProductDto | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ProductDto | null>(null)
  const money = (r: ProductDto, cents: number) => formatMoney(cents, r.currency, locale)

  return (
    <section data-testid="page-products" className="flex min-w-0 flex-col gap-4">
      <TabHeader
        prefix={P}
        title={t('title')}
        subtitle={t('subtitle')}
        canCreate={canEdit}
        newLabel={t('new')}
        onNew={() => setEditing('new')}
      />
      <SearchBox prefix={P} value={search} placeholder={t('search')} onChange={setSearch} />
      <DataList
        prefix={P}
        status={q.status}
        rows={q.data ?? []}
        rowId={(r) => r.id}
        empty={term ? t('noResults') : t('empty')}
        title={(r) => <span data-testid={`${P}-item-name-${r.id}`}>{r.name}</span>}
        columns={[
          {
            id: 'name',
            header: t('cols.name'),
            className: 'font-medium',
            cell: (r) => <span data-testid={`${P}-item-name-${r.id}`}>{r.name}</span>,
          },
          {
            id: 'currency',
            header: t('cols.currency'),
            className: 'w-20',
            cell: (r) => <span data-testid={`${P}-item-currency-${r.id}`}>{r.currency}</span>,
          },
          {
            id: 'min',
            header: t('cols.min'),
            className: 'tabular-nums',
            cell: (r) => <span data-testid={`${P}-item-min-${r.id}`}>{money(r, r.price_min_cents)}</span>,
          },
          {
            id: 'max',
            header: t('cols.max'),
            className: 'tabular-nums',
            cell: (r) => <span data-testid={`${P}-item-max-${r.id}`}>{money(r, r.price_max_cents)}</span>,
          },
          {
            id: 'fallback',
            header: t('cols.fallback'),
            className: 'tabular-nums',
            cell: (r) => <span data-testid={`${P}-item-fallback-${r.id}`}>{money(r, r.price_fallback_cents)}</span>,
          },
          {
            id: 'id',
            header: t('cols.id'),
            cell: (r) => (
              <code data-testid={`${P}-item-id-${r.id}`} className="font-mono text-xs break-all text-muted-foreground">
                {r.id}
              </code>
            ),
          },
        ]}
        canEdit={() => canEdit}
        canDelete={() => canDelete}
        onEdit={(r) => setEditing(r)}
        onDelete={(r) => setDeleting(r)}
      />

      {editing ? (
        <ProductDialog
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        prefix={P}
        open={!!deleting}
        title={t('deleteTitle')}
        body={deleting ? t('deleteBody', { name: deleting.name }) : ''}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return
          try {
            await productsApi.remove(deleting.id)
            await qc.invalidateQueries({ queryKey: PRODUCTS_KEY })
          } catch (err) {
            notify('products-error', serverMessage(err) ?? t('errors.generic'))
          }
          setDeleting(null)
        }}
      />
    </section>
  )
}
