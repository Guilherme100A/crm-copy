// Ponte das rotas `/register` e `/cadastro` com a tela de cadastro: mesma busca e mesmo componente.
import { z } from 'zod'
import { RegisterPage } from './register-page'
import { pickReferral } from '@/features/affiliate/referral'

const opt = z.string().trim().max(120).optional().catch(undefined)

export const referralSearch = z.object({ ref: opt, via: opt })

export function RegisterRoutePage({ search }: { search: z.infer<typeof referralSearch> }) {
  return <RegisterPage referral={pickReferral(search)} />
}
