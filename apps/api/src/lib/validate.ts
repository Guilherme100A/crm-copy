// Validação de entrada com zod sobre `hono/validator` (padrão ai-manager). Falha → 422 VALIDATION_ERROR
// com `details.fields[{ path, message }]`; JSON malformado → 400 MALFORMED_REQUEST (via HTTPException do validator).
import type { ValidationTargets } from 'hono'
import { validator } from 'hono/validator'
import type { z } from 'zod'
import { validationError } from './errors'

/** `app.post('/x', validate('json', schema), (c) => c.req.valid('json'))`. */
export function validate<T extends z.ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return validator(target, async (value) => {
    const result = await schema.safeParseAsync(value)
    if (!result.success) throw validationError(result.error)
    return result.data as z.output<T>
  })
}
