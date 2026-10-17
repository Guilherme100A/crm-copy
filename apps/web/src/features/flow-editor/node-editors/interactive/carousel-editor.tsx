// Editor do nó Carrossel (AC-T56-02/04; 06 §3.6 `send_carousel`): texto, até 10 cartões (texto + imagem por upload ou
// URL + até 3 botões com id estável), prazo do gatilho até 31 dias e a prévia em formato de chat do que o motor envia
// no clone (imagens com legenda e, no fim, o menu numerado dos botões de resposta).
import { MAX_CAROUSEL_BUTTONS, MAX_CAROUSEL_CARDS, type FlowAction } from '@crm/shared/flows'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { ChatPreview, DraftStatus, ErrorText, Field, inputClass, MediaInput, Notice, NS, num, Select, str, TimeoutFields, useActionsDraft, VarText } from '../messaging/kit'
import { defaultConfig, moveItem, optional, setField, type FieldErrors } from '../messaging/rules'
import { ensureAction, findAction } from '../messaging/single'
import { carouselPreview, list, newHandleId, OPTION_TYPES, type OptionType } from './rules'

type Config = Record<string, unknown>
const TYPE = 'send_carousel'

const newCard = (): Config => ({ card_id: newHandleId('card'), text: '', media_kind: 'image', media_source: 'file', buttons: [] })

export function CarouselEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const normalize = useCallback((l: FlowAction[]) => ensureAction(l, TYPE, () => ({ ...defaultConfig(TYPE, { carouselText: t('carousel.defaultText') }), carousel: [newCard()] })), [t])
  const { draft, errors, blocked, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, TYPE)
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const patch = (fn: (cfg: Config) => Config) => patchConfig(action.id, fn)
  const cards = list(c.carousel)
  const setCards = (next: Config[]) => patch((cfg) => ({ ...cfg, carousel: next }))
  const patchCard = (i: number, fn: (card: Config) => Config) => setCards(cards.map((k, j) => (j === i ? fn(k) : k)))
  const gatilho = (c.gatilho && typeof c.gatilho === 'object' ? c.gatilho : {}) as Config

  return (
    <div data-testid="ne-carousel" className="flex flex-col gap-2">
      <Notice testId="ne-carousel-baileys-notice">{t('carousel.baileysNotice')}</Notice>
      <VarText label={t('carousel.text')} path="text" errors={errs} multiline testId="ne-carousel-text" value={str(c, 'text')} disabled={readOnly} onChange={(v) => patch((cfg) => setField(cfg, 'text', v))} />
      <p className="text-xs font-medium">{t('carousel.cards', { n: cards.length, max: MAX_CAROUSEL_CARDS })}</p>
      <ol data-testid="ne-carousel-cards" className="flex flex-col gap-2">
        {cards.map((card, i) => (
          <CardItem
            key={str(card, 'card_id') || i}
            card={card}
            index={i}
            count={cards.length}
            errors={errs}
            readOnly={readOnly}
            onPatch={(fn) => patchCard(i, fn)}
            onMove={(to) => setCards(moveItem(cards, i, to))}
            onRemove={() => setCards(cards.filter((_, j) => j !== i))}
          />
        ))}
      </ol>
      <ErrorText path="carousel" error={errs?.carousel} />
      {readOnly ? null : (
        <Button variant="outline" size="sm" className="h-7 w-fit px-2 text-xs" data-testid="ne-carousel-add-card" disabled={cards.length >= MAX_CAROUSEL_CARDS} onClick={() => setCards([...cards, newCard()])}>
          <Plus aria-hidden /> {t('carousel.addCard')}
        </Button>
      )}
      <TimeoutFields
        value={num(gatilho, 'timeout_value')}
        unit={str(gatilho, 'timeout_unit')}
        errors={errs}
        paths={['gatilho', 'gatilho.timeout_value', 'gatilho.timeout_unit']}
        disabled={readOnly}
        hint={t('timeout.menuHint')}
        onChange={(v, u) => patch((cfg) => ({ ...cfg, gatilho: setField({ ...gatilho, timeout_unit: u }, 'timeout_value', v) }))}
      />
      <ChatPreview messages={carouselPreview(c)} />
      <DraftStatus blocked={blocked} />
    </div>
  )
}

function CardItem({
  card,
  index,
  count,
  errors,
  readOnly,
  onPatch,
  onMove,
  onRemove,
}: {
  card: Config
  index: number
  count: number
  errors: FieldErrors | undefined
  readOnly: boolean
  onPatch: (fn: (card: Config) => Config) => void
  onMove: (to: number) => void
  onRemove: () => void
}) {
  const t = useT(NS)
  const base = `carousel.${index}`
  const buttons = list(card.buttons)
  const setButtons = (next: Config[]) => onPatch((k) => ({ ...k, buttons: next }))
  const patchButton = (j: number, key: string, value: unknown) => setButtons(buttons.map((b, n) => (n === j ? setField(b, key, value) : b)))
  return (
    <li data-testid={`ne-carousel-card-${index}`} data-card-id={str(card, 'card_id')} className="flex flex-col gap-2 rounded-lg border bg-card p-2">
      <div className="flex items-center gap-1">
        <span className="flex-1 text-xs font-medium">{t('carousel.card', { n: index + 1 })}</span>
        {readOnly ? null : (
          <>
            <Button variant="ghost" size="icon" className="size-6" data-testid={`ne-carousel-card-up-${index}`} aria-label={t('message.up')} disabled={index === 0} onClick={() => onMove(index - 1)}>
              <ArrowUp aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" className="size-6" data-testid={`ne-carousel-card-down-${index}`} aria-label={t('message.down')} disabled={index === count - 1} onClick={() => onMove(index + 1)}>
              <ArrowDown aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" className="size-6 text-destructive" data-testid={`ne-carousel-card-remove-${index}`} aria-label={t('message.remove')} disabled={count <= 1} onClick={onRemove}>
              <Trash2 aria-hidden />
            </Button>
          </>
        )}
      </div>
      <VarText label={t('carousel.cardText')} path={`${base}.text`} errors={errors} multiline testId={`ne-carousel-card-text-${index}`} value={str(card, 'text')} disabled={readOnly} onChange={(v) => onPatch((k) => setField(k, 'text', v))} />
      <Field label={t('carousel.image')} path={`${base}.image`} errors={errors}>
        {({ invalid }) => (
          <MediaInput
            testId={(p) => `ne-carousel-card-${p}-${index}`}
            source={card.media_source === 'url' ? 'url' : 'file'}
            url={str(card, 'image')}
            mediaId={str(card, 'media_id') || undefined}
            fileName={str(card, 'filename') || undefined}
            accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
            showPreview
            invalid={invalid}
            disabled={readOnly}
            onSource={(s) => onPatch((k) => ({ ...setField(setField(setField(k, 'image', undefined), 'media_id', undefined), 'filename', undefined), media_source: s }))}
            onUrl={(url) => onPatch((k) => setField(k, 'image', optional(url)))}
            onUploaded={(media, ref, file) => onPatch((k) => ({ ...k, media_kind: 'image', media_source: 'file', image: ref, media_id: media.id, filename: media.file_name ?? file.name }))}
          />
        )}
      </Field>
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium">{t('carousel.buttons', { n: buttons.length, max: MAX_CAROUSEL_BUTTONS })}</p>
        {buttons.map((b, j) => {
          const id = str(b, 'id')
          const bType = (str(b, 'type') || 'REPLY') as OptionType
          return (
            <div key={id || j} data-testid={`ne-carousel-button-${id}`} data-handle={bType === 'REPLY' ? `option:${id}` : undefined} className="flex flex-col gap-1 rounded-md border p-1.5">
              <div className="grid grid-cols-[minmax(0,1fr)_6.5rem_auto] items-start gap-1">
                <Field label={t('carousel.buttonText')} path={`${base}.buttons.${j}.text`} errors={errors}>
                  {({ id: fid, invalid }) => (
                    <input id={fid} data-testid={`ne-carousel-button-text-${id}`} className={inputClass} aria-invalid={invalid} value={str(b, 'text')} disabled={readOnly} onChange={(e) => patchButton(j, 'text', e.target.value)} />
                  )}
                </Field>
                <Field label={t('menu.optionType')} path={`${base}.buttons.${j}.type`} errors={errors}>
                  {({ id: fid }) => (
                    <Select id={fid} testId={`ne-carousel-button-type-${id}`} value={bType} options={OPTION_TYPES} label={(v) => t(`menu.optionTypes.${v}`)} disabled={readOnly} onChange={(v) => patchButton(j, 'type', v)} />
                  )}
                </Field>
                {readOnly ? null : (
                  <Button variant="ghost" size="icon" className="mt-5 size-7 text-destructive" data-testid={`ne-carousel-button-remove-${id}`} aria-label={t('message.remove')} onClick={() => setButtons(buttons.filter((_, n) => n !== j))}>
                    <Trash2 aria-hidden />
                  </Button>
                )}
              </div>
              {bType === 'REPLY' ? (
                <code data-testid={`ne-carousel-button-handle-${id}`} className="truncate text-[10px] text-muted-foreground">{`option:${id}`}</code>
              ) : (
                <Field label={t(`menu.optionTarget.${bType}`)} path={`${base}.buttons.${j}.payload`} errors={errors}>
                  {({ id: fid }) => (
                    <input id={fid} data-testid={`ne-carousel-button-payload-${id}`} className={inputClass} value={str(b, 'payload')} disabled={readOnly} onChange={(e) => patchButton(j, 'payload', optional(e.target.value))} />
                  )}
                </Field>
              )}
            </div>
          )
        })}
        {readOnly ? null : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-fit px-2 text-xs"
            data-testid={`ne-carousel-add-button-${index}`}
            disabled={buttons.length >= MAX_CAROUSEL_BUTTONS}
            onClick={() => setButtons([...buttons, { id: newHandleId('btn'), text: '', type: 'REPLY' }])}
          >
            <Plus aria-hidden /> {t('carousel.addButton')}
          </Button>
        )}
      </div>
    </li>
  )
}
