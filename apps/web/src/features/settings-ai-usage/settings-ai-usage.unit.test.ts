import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { dispatchRealtime, registeredTypes } from '@/lib/realtime'
import { SETTINGS_TABS } from '../settings/tabs'
import { walletKey, walletQuery, type WalletDto } from './api'
import { applyWalletEvent, formatCredits, periodRange, quotaBars, startOfPeriod, sumSummary, tzOffsetMs, walletTone } from './format'
import './wallet-chip'

const wallet: WalletDto = {
  balance_credits: 5000,
  low_threshold_credits: 1000,
  max_overrun_credits: 0,
  status: 'ok',
  lifetime_credited_credits: 6000,
  lifetime_spent_credits: 1000,
  last_topup: { amount_credits: 6000, created_at: '2026-10-01T12:00:00.000Z' },
}

describe('AC-T59-01 chip "Créditos de IA"', () => {
  it('saldo no formato compacto (≥1M "1.2M", ≥10k "12k", senão inteiro) e negativo com sinal', () => {
    expect(formatCredits(1_234_567, 'en')).toBe('1.2M')
    expect(formatCredits(12_345, 'en')).toBe('12k')
    expect(formatCredits(9_999, 'en')).toBe('9,999')
    expect(formatCredits(9_999, 'pt-BR')).toBe('9.999')
    expect(formatCredits(0)).toBe('0')
    expect(formatCredits(-250)).toBe('-250')
  })

  it('destaque: esgotado com status exhausted ou saldo ≤ 0; baixo com status low ou saldo ≤ limiar', () => {
    expect(walletTone(wallet)).toBe('ok')
    expect(walletTone({ ...wallet, status: 'low' })).toBe('low')
    expect(walletTone({ ...wallet, balance_credits: 1000 })).toBe('low')
    expect(walletTone({ ...wallet, status: 'exhausted' })).toBe('exhausted')
    expect(walletTone({ ...wallet, balance_credits: 0 })).toBe('exhausted')
    expect(walletTone({ ...wallet, balance_credits: -10, status: 'low' })).toBe('exhausted')
  })

  it('ai_wallet.updated grava saldo/status no cache da empresa do evento sem perder a última recarga', () => {
    expect(registeredTypes()).toContain('ai_wallet.updated')
    const qc = new QueryClient()
    qc.setQueryData(walletKey('c1'), wallet)
    dispatchRealtime({ id: '1', type: 'ai_wallet.updated', company_id: 'c1', at: '', data: { balance_credits: 300, status: 'low' } }, qc)
    expect(qc.getQueryData<WalletDto>(walletKey('c1'))).toMatchObject({ balance_credits: 300, status: 'low', last_topup: wallet.last_topup, low_threshold_credits: 1000 })
    // Sem cache ainda: monta a carteira mínima a partir do evento; outra empresa não é tocada.
    dispatchRealtime({ id: '2', type: 'ai_wallet.updated', company_id: 'c2', at: '', data: { balance_credits: 0, status: 'exhausted', low_threshold_credits: 50 } }, qc)
    expect(walletTone(qc.getQueryData<WalletDto>(walletKey('c2'))!)).toBe('exhausted')
    expect(qc.getQueryData<WalletDto>(walletKey('c1'))!.balance_credits).toBe(300)
    expect(applyWalletEvent(undefined, { balance_credits: 1, status: 'ok' }).lifetime_spent_credits).toBe(0)
  })

  it('a query da carteira relê ao focar a janela (o padrão do app é não reler)', () => {
    expect(walletQuery('c1').refetchOnWindowFocus).toBe(true)
    expect(walletQuery('c1').queryKey).toEqual(['ai-wallet', 'c1'])
  })
})

describe('AC-T59-02 aba de consumo', () => {
  it('aba ai_usage registrada no grupo conta com ai_usage.view', () => {
    expect(SETTINGS_TABS.find((x) => x.id === 'ai_usage')).toMatchObject({ group: 'account', labelKey: 'settings-ai-usage:tab', permissions: ['ai_usage.view'] })
  })

  it('período: últimos N dias até agora', () => {
    const now = new Date('2026-10-16T12:00:00.000Z')
    expect(periodRange('7d', now)).toEqual({ from: '2026-10-09T12:00:00.000Z', to: '2026-10-16T12:00:00.000Z' })
    expect(periodRange('30d', now).from).toBe('2026-09-16T12:00:00.000Z')
  })

  it('início do dia/mês no fuso da empresa (America/Sao_Paulo = UTC-3; Asia/Tokyo = UTC+9)', () => {
    const now = new Date('2026-10-16T02:30:00.000Z') // 23:30 do dia 15 em São Paulo; 11:30 do dia 16 em Tóquio
    expect(tzOffsetMs('America/Sao_Paulo', now)).toBe(-3 * 3_600_000)
    expect(startOfPeriod('day', 'America/Sao_Paulo', now)).toBe('2026-10-15T03:00:00.000Z')
    expect(startOfPeriod('month', 'America/Sao_Paulo', now)).toBe('2026-10-01T03:00:00.000Z')
    expect(startOfPeriod('day', 'Asia/Tokyo', now)).toBe('2026-10-15T15:00:00.000Z')
    expect(startOfPeriod('day', 'UTC', now)).toBe('2026-10-16T00:00:00.000Z')
    // Horário de verão: Nova York em 2026-03-08 (meia-noite ainda em EST, UTC-5).
    expect(startOfPeriod('day', 'America/New_York', new Date('2026-03-08T15:00:00.000Z'))).toBe('2026-03-08T05:00:00.000Z')
  })

  it('cotas: uma barra por limite definido, uso somado do resumo (tokens = entrada + saída), passa de 100% marca over', () => {
    const used = sumSummary([
      { key: 'ai_agent', count: 2, input_tokens: 100, output_tokens: 50, cost_micros: 300_000, credits: 30 },
      { key: null, count: 1, input_tokens: 10, output_tokens: 0, cost_micros: 100_000, credits: 10 },
    ])
    expect(used).toEqual({ count: 3, credits: 40, cost_micros: 400_000, tokens: 160 })
    const bars = quotaBars({ period: 'day', max_credits: 80, max_cost_micros: null, max_tokens: 100, hard: true, updated_at: null }, used)
    expect(bars).toEqual([
      { metric: 'credits', used: 40, max: 80, pct: 50, over: false },
      { metric: 'tokens', used: 160, max: 100, pct: 100, over: true },
    ])
    expect(quotaBars({ period: 'month', max_credits: 0, max_cost_micros: null, max_tokens: null, hard: false, updated_at: null }, sumSummary([]))).toEqual([
      { metric: 'credits', used: 0, max: 0, pct: 0, over: false },
    ])
  })
})
