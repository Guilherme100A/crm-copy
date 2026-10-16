// Autosave do rascunho (06 §2.2 "Salvo às"): cada mudança agenda um salvamento com debounce; só um salvamento por vez
// (mudanças durante o envio geram outro ao terminar); `flush` salva já o que estiver pendente (antes de ativar ou de
// recarregar por realtime).

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export interface AutosaveStatus {
  state: SaveState
  /** Hora do último salvamento bem-sucedido. */
  savedAt: Date | null
}

export const AUTOSAVE_DELAY_MS = 800

export class Autosaver {
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private inflight: Promise<void> | null = null
  private status: AutosaveStatus = { state: 'idle', savedAt: null }

  constructor(
    private readonly save: () => Promise<void>,
    private readonly onStatus: (s: AutosaveStatus) => void,
    private readonly delay = AUTOSAVE_DELAY_MS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get pending(): boolean {
    return this.dirty || this.inflight !== null
  }

  /** Marca mudança e agenda o salvamento. */
  schedule(): void {
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, this.delay)
  }

  /** Salva agora o que estiver pendente e espera terminar. Lança se o salvamento falhar. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    while (this.dirty || this.inflight) {
      if (this.inflight) await this.inflight.catch(() => undefined)
      else await this.run()
      if (this.status.state === 'error') throw new Error('save failed')
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private set(s: Partial<AutosaveStatus>) {
    this.status = { ...this.status, ...s }
    this.onStatus(this.status)
  }

  private async run(): Promise<void> {
    if (this.inflight) return
    if (!this.dirty) return
    this.dirty = false
    this.set({ state: 'saving' })
    this.inflight = this.save()
      .then(() => this.set({ state: 'saved', savedAt: this.now() }))
      .catch(() => this.set({ state: 'error' }))
      .finally(() => {
        this.inflight = null
        // Mudou durante o envio: salva de novo.
        if (this.dirty && !this.timer && this.status.state !== 'error') void this.run()
      })
    await this.inflight
  }
}
