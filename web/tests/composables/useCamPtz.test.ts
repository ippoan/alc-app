// 拠点カメラの首振り (データチャネル ptz)。メッセージの形は alc-cam の docs/host-protocol.md
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shallowRef } from 'vue'
import { withSetup } from '../helpers/with-setup'
import { useCamPtz, PTZ_RESEND_MS } from '~/composables/useCamPtz'

class FakeChannel {
  readyState = 'open'
  send = vi.fn()
  listeners: Record<string, Array<(ev: any) => void>> = {}
  addEventListener(type: string, fn: (ev: any) => void) {
    (this.listeners[type] ??= []).push(fn)
  }

  removeEventListener(type: string, fn: (ev: any) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn)
  }

  emit(type: string, data?: unknown) {
    for (const fn of [...(this.listeners[type] ?? [])]) fn({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }

  /** 送った JSON を読み戻す */
  sent() {
    return this.send.mock.calls.map(c => JSON.parse(c[0]))
  }
}

const CAPS = { type: 'ptz', event: 'caps', dirs: ['up', 'down', 'left', 'right'], home: true, presets: [1, 2, 3, 4], zoom: false }

function setup(initial: FakeChannel | null = new FakeChannel()) {
  const channel = shallowRef<any>(initial)
  const [ptz, app] = withSetup(() => useCamPtz(channel))
  return { channel, ptz, app, ch: initial }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useCamPtz', () => {
  it('caps が届くまでは null、届いたら中身を出す (欠けた項目は空・false)', () => {
    const { ptz, ch } = setup()
    expect(ptz.caps.value).toBeNull()
    ch!.emit('message', CAPS)
    expect(ptz.caps.value).toEqual({ dirs: ['up', 'down', 'left', 'right'], home: true, presets: [1, 2, 3, 4], zoom: false })
    ch!.emit('message', { type: 'ptz', event: 'caps' })
    expect(ptz.caps.value).toEqual({ dirs: [], home: false, presets: [], zoom: false })
  })

  it('ptz 以外・読めない・知らない event は無視する', () => {
    const { ptz, ch } = setup()
    ch!.emit('message', 'not json')
    ch!.emit('message', 'null')
    ch!.emit('message', { type: 'other', event: 'caps' })
    ch!.emit('message', { type: 'ptz', event: 'unknown' })
    expect(ptz.caps.value).toBeNull()
    expect(ptz.message.value).toBeNull()
  })

  it('押している間は move を送り直し、離したら stop を 1 回だけ送る', () => {
    const { ptz, ch } = setup()
    ptz.move('left')
    ptz.move('left') // 押しっぱなしの二重発火は無視
    expect(ptz.held.value).toBe('left')
    vi.advanceTimersByTime(PTZ_RESEND_MS * 2)
    expect(ch!.sent()).toEqual([
      { type: 'ptz', action: 'move', dir: 'left' },
      { type: 'ptz', action: 'move', dir: 'left' },
      { type: 'ptz', action: 'move', dir: 'left' },
    ])
    ptz.move('up') // 向きを変えた
    ptz.stop()
    ptz.stop() // 2 回目は送らない
    vi.advanceTimersByTime(PTZ_RESEND_MS * 3)
    expect(ch!.sent().slice(3)).toEqual([{ type: 'ptz', action: 'move', dir: 'up' }, { type: 'ptz', action: 'stop' }])
    expect(ptz.held.value).toBeNull()
  })

  it('home・preset・zoom は 1 通。押し続けは止める', () => {
    const { ptz, ch } = setup()
    ptz.move('down')
    ptz.home()
    ptz.preset(3)
    ptz.zoom('in')
    vi.advanceTimersByTime(PTZ_RESEND_MS * 2)
    expect(ch!.sent()).toEqual([
      { type: 'ptz', action: 'move', dir: 'down' },
      { type: 'ptz', action: 'home' },
      { type: 'ptz', action: 'preset', preset: 3 },
      { type: 'ptz', action: 'zoom', dir: 'in' },
    ])
  })

  it('チャネルが開いていなければ送らない', () => {
    const ch = new FakeChannel()
    ch.readyState = 'closing'
    const { ptz } = setup(ch)
    ptz.home()
    expect(ch.send).not.toHaveBeenCalled()
    const none = setup(null)
    expect(() => none.ptz.preset(1)).not.toThrow()
  })

  it('失敗は message に出し、成功で消す。move の失敗は送り直しを止める', () => {
    const { ptz, ch } = setup()
    ch!.emit('message', CAPS)
    ptz.move('right')
    ch!.emit('message', { type: 'ptz', event: 'result', action: 'move', ok: false, message: 'カメラの認証に失敗しました' })
    expect(ptz.message.value).toBe('カメラの認証に失敗しました')
    expect(ptz.held.value).toBeNull()
    vi.advanceTimersByTime(PTZ_RESEND_MS * 3)
    expect(ch!.send).toHaveBeenCalledTimes(1)
    expect(ptz.caps.value).not.toBeNull()
    ch!.emit('message', { type: 'ptz', event: 'result', action: 'preset', ok: true })
    expect(ptz.message.value).toBeNull()
    ch!.emit('message', { type: 'ptz', event: 'result', action: 'preset', ok: false })
    expect(ptz.message.value).toBe('首振りに失敗しました')
  })

  it('非対応 (unsupported) ならボタンを畳む。ズームの非対応では畳まない', () => {
    const { ptz, ch } = setup()
    ch!.emit('message', CAPS)
    ch!.emit('message', { type: 'ptz', event: 'result', action: 'zoom', ok: false, unsupported: true, message: 'ズームできません' })
    expect(ptz.caps.value).not.toBeNull()
    ch!.emit('message', { type: 'ptz', event: 'result', action: 'home', ok: false, unsupported: true, message: '対応していません' })
    expect(ptz.caps.value).toBeNull()
    expect(ptz.message.value).toBe('対応していません')
  })

  it('チャネルが閉じた・付け替わったら状態を捨て、古いチャネルは聞かない', () => {
    const { ptz, ch, channel } = setup()
    ch!.emit('message', CAPS)
    ptz.move('up')
    ch!.emit('close')
    expect(ptz.caps.value).toBeNull()
    expect(ptz.held.value).toBeNull()

    ch!.emit('message', CAPS)
    const next = new FakeChannel()
    channel.value = next
    expect(ptz.caps.value).toBeNull()
    ch!.emit('message', CAPS)
    expect(ptz.caps.value).toBeNull()
    next.emit('message', CAPS)
    expect(ptz.caps.value).not.toBeNull()
    channel.value = null
    expect(ptz.caps.value).toBeNull()
  })

  it('unmount で送り直しを止め、チャネルから外れる', () => {
    const { ptz, ch, app } = setup()
    ptz.move('left')
    app.unmount()
    vi.advanceTimersByTime(PTZ_RESEND_MS * 3)
    expect(ch!.send).toHaveBeenCalledTimes(1)
    expect(ch!.listeners.message).toEqual([])
    expect(ch!.listeners.close).toEqual([])
    const none = setup(null)
    expect(() => none.app.unmount()).not.toThrow()
  })
})
