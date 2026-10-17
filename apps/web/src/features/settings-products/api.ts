// API dos produtos (T34; 19 §2.6): lista com busca (até 200, por nome) e CRUD. DTO local: a web não importa `@crm/core`.
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'
import type { ProductInput } from './rules'

export interface ProductDto {
  id: string
  public_id: string
  name: string
  currency: string
  price_min_cents: number
  price_max_cents: number
  price_fallback_cents: number
  created_at: string
  updated_at: string
}

export const PRODUCTS_KEY = ['settings-products'] as const
const enc = encodeURIComponent

export const productsQuery = (search = '') =>
  queryOptions({
    queryKey: [...PRODUCTS_KEY, 'list', search] as const,
    queryFn: async () =>
      (await api.get<{ items: ProductDto[] }>('/api/products', { query: { search: search || undefined } })).items,
    placeholderData: keepPreviousData,
  })

export const productsApi = {
  create: async (input: ProductInput) => (await api.post<{ product: ProductDto }>('/api/products', input)).product,
  update: async (id: string, input: ProductInput) =>
    (await api.patch<{ product: ProductDto }>(`/api/products/${enc(id)}`, input)).product,
  remove: (id: string) => api.delete(`/api/products/${enc(id)}`),
}
