// Editor dos nós Menu interativo e Lista de opções legada (AC-T56-02/03; 06 §3.6): opções com id estável gerado uma
// vez (handle `option:<id>`, que não muda ao reordenar), aviso de envio como menu numerado em texto (Baileys), prazo
// até 31 dias (0 = padrão de 2 dias), "salvar resposta" opcional e a prévia do texto enviado.
import { MENU_TYPES, type FlowAction } from '@crm/shared/flows'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import type { NodeEditorProps } from '../registry'
import { ChatPreview, Check, DraftStatus, ErrorText, Field, inputClass, MediaInput, Notice, NS, num, Select, str, TimeoutFields, useActionsDraft, VarText } from '../messaging/kit'
import { defaultConfig, moveItem, optional, setField, type FieldErrors } from '../messaging/rules'
import { ensureAction, findAction } from '../messaging/single'
import { list, MENU_PRIMARY, menuPreview, newHandleId, OPTION_TYPES, type OptionType } from './rules'
import { SaveUserDataFields } from './save-field'

type Config = Record<string, unknown>

export function MenuEditor({ nodeId, type, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const primary = MENU_PRIMARY[type] ?? 'send_interactive_menu'
  const normalize = useCallback(
    (l: FlowAction[]) => ensureAction(l, primary, () => ({ ...defaultConfig(primary, { buttonLabel: t('menu.defaultButton') }), options: [{ id: newHandleId('option'), title: '' }] })),
    [primary, t],
  )
  const { draft, errors, blocked, update, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange, normalize })
  const action = findAction(draft, primary)
  if (!action) return null
  const c = action.config
  const errs = errors[action.id]
  const patch = (fn: (cfg: Config) => Config) => patchConfig(action.id, fn)
  const set = (key: string, value: unknown) => patch((cfg) => setField(cfg, key, value))
  const menuType = (str(c, 'menuType') || 'list') as (typeof MENU_TYPES)[number]
  const options = list(c.options)
  const setOptions = (next: Config[]) => set('options', next)

  return (
    <div data-testid="ne-menu" className="flex flex-col gap-2">
      <Notice testId="ne-menu-baileys-notice">{t('menu.baileysNotice')}</Notice>
      {type === 'menu' ? (
        <Notice testId="ne-menu-legacy-notice" tone="warn">
          {t('menu.legacyNotice')}
        </Notice>
      ) : null}
      <Field label={t('menu.type')} path="menuType" errors={errs}>
        {({ id }) => <Select id={id} testId="ne-menu-type" value={menuType} options={MENU_TYPES} label={(v) => t(`menu.types.${v}`)} disabled={readOnly} onChange={(v) => set('menuType', v)} />}
      </Field>
      <VarText label={t('menu.message')} path="message" errors={errs} multiline testId="ne-menu-message" value={str(c, 'message')} disabled={readOnly} onChange={(v) => set('message', v)} />
      {menuType === 'list' ? (
        <Field label={t('menu.buttonLabel')} path="buttonLabel" errors={errs}>
          {({ id, invalid }) => <input id={id} data-testid="ne-menu-button-label" className={inputClass} aria-invalid={invalid} value={str(c, 'buttonLabel')} disabled={readOnly} onChange={(e) => set('buttonLabel', e.target.value)} />}
        </Field>
      ) : null}
      <Field label={t('menu.footer')} path="footerText" errors={errs}>
        {({ id }) => <input id={id} data-testid="ne-menu-footer" className={inputClass} value={str(c, 'footerText')} disabled={readOnly} onChange={(e) => set('footerText', optional(e.target.value))} />}
      </Field>
      {menuType === 'button' ? (
        <div className="flex flex-col gap-1.5 rounded-md border p-2">
          <Check label={t('menu.image')} testId="ne-menu-image-enabled" checked={c.imageButtonEnabled === true} disabled={readOnly} onChange={(v) => set('imageButtonEnabled', v || undefined)} />
          {c.imageButtonEnabled === true ? (
            <MediaInput
              testId={(p) => `ne-menu-image-${p}`}
              source={c.imageButtonSource === 'url' ? 'url' : 'file'}
              url={str(c, 'imageButton')}
              mediaId={str(c, 'imageButton_media_id') || undefined}
              accept="image/*"
              showPreview
              disabled={readOnly}
              onSource={(s) => patch((cfg) => ({ ...setField(setField(cfg, 'imageButton', undefined), 'imageButton_media_id', undefined), imageButtonSource: s }))}
              onUrl={(url) => set('imageButton', optional(url))}
              onUploaded={(media, ref) => patch((cfg) => ({ ...cfg, imageButtonSource: 'file', imageButton: ref, imageButton_media_id: media.id }))}
            />
          ) : null}
        </div>
      ) : null}

      <OptionsList options={options} errors={errs} menuType={menuType} readOnly={readOnly} onChange={setOptions} />

      <TimeoutFields
        value={num(c, 'timeout_value')}
        unit={str(c, 'timeout_unit')}
        errors={errs}
        disabled={readOnly}
        hint={t('timeout.menuHint')}
        onChange={(v, u) => patch((cfg) => setField({ ...cfg, timeout_unit: u }, 'timeout_value', v))}
      />
      <SaveUserDataFields draft={draft} errors={errors} readOnly={readOnly} update={update} />
      <ChatPreview messages={menuPreview(c)} />
      <DraftStatus blocked={blocked} />
    </div>
  )
}

function OptionsList({
  options,
  errors,
  menuType,
  readOnly,
  onChange,
}: {
  options: Config[]
  errors: FieldErrors | undefined
  menuType: string
  readOnly: boolean
  onChange: (next: Config[]) => void
}) {
  const t = useT(NS)
  const withTypes = menuType === 'button'
  const patchAt = (i: number, key: string, value: unknown) => onChange(options.map((o, j) => (j === i ? setField(o, key, value) : o)))
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium">{t('menu.options', { n: options.length })}</p>
      <ol data-testid="ne-menu-options" className="flex flex-col gap-1.5">
        {options.map((o, i) => {
          const id = str(o, 'id')
          const optType = (str(o, 'type') || 'REPLY') as OptionType
          const replies = optType === 'REPLY'
          return (
            <li key={id || i} data-testid={`ne-menu-option-${id}`} data-index={i} data-handle={id ? `option:${id}` : undefined} className="flex flex-col gap-1.5 rounded-md border bg-card p-2">
              <div className="flex items-center gap-1">
                <span className="text-xs font-medium">{i + 1}.</span>
                <code data-testid={`ne-menu-option-handle-${id}`} title={t('menu.handle')} className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                  {replies ? `option:${id}` : t('menu.noHandle')}
                </code>
                {readOnly ? null : (
                  <>
                    <Button variant="ghost" size="icon" className="size-6" data-testid={`ne-menu-option-up-${id}`} aria-label={t('message.up')} disabled={i === 0} onClick={() => onChange(moveItem(options, i, i - 1))}>
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon" className="size-6" data-testid={`ne-menu-option-down-${id}`} aria-label={t('message.down')} disabled={i === options.length - 1} onClick={() => onChange(moveItem(options, i, i + 1))}>
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon" className="size-6 text-destructive" data-testid={`ne-menu-option-remove-${id}`} aria-label={t('message.remove')} onClick={() => onChange(options.filter((_, j) => j !== i))}>
                      <Trash2 aria-hidden />
                    </Button>
                  </>
                )}
              </div>
              <Field label={t('menu.optionTitle')} path={`options.${i}.title`} errors={errors}>
                {({ id: fid, invalid }) => (
                  <input id={fid} data-testid={`ne-menu-option-title-${id}`} className={inputClass} aria-invalid={invalid} value={str(o, 'title')} disabled={readOnly} onChange={(e) => patchAt(i, 'title', e.target.value)} />
                )}
              </Field>
              {withTypes ? (
                <Field label={t('menu.optionType')} path={`options.${i}.type`} errors={errors}>
                  {({ id: fid }) => (
                    <Select id={fid} testId={`ne-menu-option-type-${id}`} value={optType} options={OPTION_TYPES} label={(v) => t(`menu.optionTypes.${v}`)} disabled={readOnly} onChange={(v) => patchAt(i, 'type', v === 'REPLY' ? undefined : v)} />
                  )}
                </Field>
              ) : null}
              <Field label={replies ? t('menu.optionDescription') : t(`menu.optionTarget.${optType}`)} path={`options.${i}.description`} errors={errors}>
                {({ id: fid }) => (
                  <input id={fid} data-testid={`ne-menu-option-description-${id}`} className={inputClass} value={str(o, 'description')} disabled={readOnly} onChange={(e) => patchAt(i, 'description', optional(e.target.value))} />
                )}
              </Field>
            </li>
          )
        })}
      </ol>
      <ErrorText path="options" error={errors?.options} />
      {readOnly ? null : (
        <Button variant="outline" size="sm" className="h-7 w-fit px-2 text-xs" data-testid="ne-menu-add-option" onClick={() => onChange([...options, { id: newHandleId('option'), title: '' }])}>
          <Plus aria-hidden /> {t('menu.addOption')}
        </Button>
      )}
    </div>
  )
}

