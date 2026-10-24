import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ALC_CAM_EXTENSION_ID,
  EXTENSION_REPLY_TIMEOUT_MS,
  extensionSendMessage,
  requestExtension,
  swallowLastError,
} from '~/utils/alc-cam-extension'

type Cb = (response?: unknown) => void

function stubRuntime(impl: (id: string, msg: unknown, cb: Cb) => void, lastError?: unknown) {
  const runtime = { sendMessage: vi.fn(impl), lastError }
  vi.stubGlobal('chrome', { runtime })
  return runtime
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('alc-cam-extension', () => {
  it('chrome.runtime.sendMessage が無ければ送る口は null・返事も null', async () => {
    vi.stubGlobal('chrome', undefined)
    expect(extensionSendMessage()).toBeNull()
    expect(await requestExtension({ type: 'cam_status' })).toBeNull()
    vi.stubGlobal('chrome', { runtime: {} })
    expect(extensionSendMessage()).toBeNull()
  })

  it('拡張 ID へ送り、返事をそのまま返す (this は runtime)', async () => {
    let self: unknown
    const runtime = stubRuntime(function (this: unknown, _id, _msg, cb) {
      self = this
      cb({ ok: true })
    })
    expect(await requestExtension({ type: 'cam_status' })).toEqual({ ok: true })
    expect(runtime.sendMessage).toHaveBeenCalledWith(ALC_CAM_EXTENSION_ID, { type: 'cam_status' }, expect.any(Function))
    expect(self).toBe(runtime)
  })

  it('lastError・返事なし・送信の throw は null', async () => {
    stubRuntime((_id, _msg, cb) => cb({ ok: true }), { message: 'Could not establish connection' })
    expect(await requestExtension({})).toBeNull()
    stubRuntime((_id, _msg, cb) => cb())
    expect(await requestExtension({})).toBeNull()
    stubRuntime(() => {
      throw new Error('Invalid extension id')
    })
    expect(await requestExtension({})).toBeNull()
  })

  it('返事が来なければ時間切れで null', async () => {
    vi.useFakeTimers()
    stubRuntime(() => {})
    const p = requestExtension({})
    await vi.advanceTimersByTimeAsync(EXTENSION_REPLY_TIMEOUT_MS)
    expect(await p).toBeNull()
  })

  it('swallowLastError は lastError を読むだけ (runtime が無くても落ちない)', () => {
    stubRuntime(() => {}, { message: 'x' })
    expect(() => swallowLastError()).not.toThrow()
    vi.stubGlobal('chrome', undefined)
    expect(() => swallowLastError()).not.toThrow()
  })
})
