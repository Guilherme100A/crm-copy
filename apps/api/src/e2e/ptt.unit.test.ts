import { describe, expect, it } from 'vitest'
import type { ResolvedDeps } from '../lib/types'
import { e2ePttConverter, prepareE2eDeps } from './index'

describe('harness: conversor PTT passthrough (T85)', () => {
  it('devolve os mesmos bytes como Ogg/Opus e é injetado só se não houver outro', async () => {
    const audio = new Uint8Array([1, 2, 3])
    expect(await e2ePttConverter(audio)).toEqual({ audio, mime: 'audio/ogg; codecs=opus', seconds: 0 })
    const deps = {} as ResolvedDeps
    prepareE2eDeps(deps)
    expect(deps.pttConverter).toBe(e2ePttConverter)
    const own = async () => ({ audio, mime: 'x', seconds: 1 })
    const other = { pttConverter: own } as unknown as ResolvedDeps
    prepareE2eDeps(other)
    expect(other.pttConverter).toBe(own)
  })
})
