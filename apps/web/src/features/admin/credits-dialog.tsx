// Recarga / ajuste de créditos de IA de uma empresa (T37; 20 §3.9, §5 item 8; AC-T100-04): créditos inteiros
// (recarga > 0, ajuste ≠ 0), nota obrigatória e confirmação antes de enviar.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Field, FormDialog, inputClass, isFieldError, serverMessage, textareaClass } from '@/features/settings-quick-replies/kit'
import { useI18n, useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { ADMIN_KEY, adminApi } from './api'
import { validateCreditsDraft, type CreditsDraft, type CreditsMode } from './rules'
import { ConfirmAction, fmtNumber, NS } from './ui'

export interface CreditsTarget {
  companyId: string
  companyName: string
  mode: CreditsMode
}

export function CreditsDialog({ target, onClose }: { target: CreditsTarget; onClose: () => void }) {
  const t = useT(NS)
  const { locale } = useI18n()
  const qc = useQueryClient()
  const [d, setD] = useState<CreditsDraft>({ credits: '', note: '' })
  const [errors, setErrors] = useState<ReturnType<typeof validateCreditsDraft>>({})
  const [confirming, setConfirming] = useState(false)
  const save = useMutation({
    mutationFn: () => adminApi.credits(target.companyId, target.mode, Number(d.credits.trim()), d.note.trim()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [...ADMIN_KEY, 'ai-wallets'] })
      notify('admin-credits-saved', t(target.mode === 'topup' ? 'credits.toppedUp' : 'credits.adjusted'))
      onClose()
    },
    onError: () => setConfirming(false),
  })
  const fieldErr = (k: 'credits' | 'note') =>
    errors[k] ? t(`credits.errors.${errors[k]}`) : isFieldError(save.error, k) ? serverMessage(save.error, k) : null
  const general = save.error && !isFieldError(save.error, 'credits') && !isFieldError(save.error, 'note') ? serverMessage(save.error) ?? t('common.saveFailed') : null
  const title = t(target.mode === 'topup' ? 'credits.topupTitle' : 'credits.adjustTitle', { company: target.companyName })

  return (
    <>
      <FormDialog
        prefix="admin-credits"
        open
        title={title}
        onClose={onClose}
        pending={save.isPending}
        error={general}
        onSubmit={() => {
          const e = validateCreditsDraft(d, target.mode)
          setErrors(e)
          if (Object.keys(e).length === 0) setConfirming(true)
        }}
      >
        <Field
          label={t('credits.amount')}
          htmlFor="admin-credits-amount"
          error={fieldErr('credits')}
          errorTestId="admin-credits-amount-error"
          hint={t(target.mode === 'topup' ? 'credits.topupHint' : 'credits.adjustHint')}
        >
          <input
            id="admin-credits-amount"
            data-testid="admin-credits-amount"
            inputMode="numeric"
            className={inputClass}
            value={d.credits}
            onChange={(e) => setD((x) => ({ ...x, credits: e.target.value }))}
          />
        </Field>
        <Field label={`${t('credits.note')} *`} htmlFor="admin-credits-note" error={fieldErr('note')} errorTestId="admin-credits-note-error">
          <textarea
            id="admin-credits-note"
            data-testid="admin-credits-note"
            className={textareaClass}
            maxLength={500}
            value={d.note}
            onChange={(e) => setD((x) => ({ ...x, note: e.target.value }))}
          />
        </Field>
      </FormDialog>
      <ConfirmAction
        prefix="admin-credits"
        open={confirming}
        title={t('credits.confirmTitle')}
        body={t(target.mode === 'topup' ? 'credits.confirmTopup' : 'credits.confirmAdjust', {
          credits: fmtNumber(Number(d.credits.trim()), locale),
          company: target.companyName,
        })}
        confirmLabel={t('common.confirm')}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await save.mutateAsync().catch(() => undefined)
        }}
      />
    </>
  )
}
