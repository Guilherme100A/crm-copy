// Erros do consumo de IA (T18).

/** Não há preço vigente para provedor/modelo/tipo na data do uso. */
export class PriceNotFoundError extends Error {
  constructor(
    readonly provider: string,
    readonly model: string,
    readonly kind: string,
    readonly at: Date,
  ) {
    super(`sem preço vigente para ${provider}/${model} (${kind}) em ${at.toISOString()}`)
    this.name = 'PriceNotFoundError'
  }
}

export class UsageNotFoundError extends Error {
  constructor(readonly usageId: string) {
    super(`uso de IA não encontrado: ${usageId}`)
    this.name = 'UsageNotFoundError'
  }
}

export class InvalidCreditsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCreditsError'
  }
}
