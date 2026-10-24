// 拠点カメラのスピーカーへ話す (押して話す)。メッセージの形は alc-cam の docs/host-protocol.md の「音声」
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shallowRef } from 'vue'
import { withSetup } from '../helpers/with-setup'
import {
  useCamTalk, TALK_RESEND_MS, MIC_DENIED_MESSAGE, MIC_UNAVAILABLE_MESSAGE, TAKEN_OVER_MESSAGE,
} from '~/composables/useCamTalk'

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

  sent() {
    return this.send.mock.calls.map(c => JSON.parse(c[0]))
  }
}

function fakeStream(tracks = 1) {
  const list = Array.from({ length: tracks }, () => ({ stop: vi.fn() }))
  return { getTracks: () => list, getAudioTracks: () => list, list }
}

const gum = vi.fn()

function setup(opts: { channel?: FakeChannel | null, sender?: any } = {}) {
  const ch = opts.channel === undefined ? new FakeChannel() : opts.channel
  const sender = opts.sender === undefined ? { replaceTrack: vi.fn().mockResolvedValue(undefined) } : opts.sender
  const channel = shallowRef<any>(ch)
  const senderRef = shallowRef<any>(sender)
  const [talk, app] = withSetup(() => useCamTalk(channel, senderRef))
  return { talk, app, ch, sender, channel, senderRef }
}

beforeEach(() => {
  vi.useFakeTimers()
  gum.mockReset()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: gum } })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useCamTalk', () => {
  it('caps が来るまで canTalk は false。speak の真偽をそのまま出す', () => {
    const { talk, ch } = setup()
    expect(talk.canTalk.value).toBe(false)
    ch!.emit('message', { type: 'talk', event: 'caps', speak: true })
    expect(talk.canTalk.value).toBe(true)
    ch!.emit('message', { type: 'talk', event: 'caps' })
    expect(talk.canTalk.value).toBe(false)
  })

  it('talk 以外・読めない・知らない event は無視する', () => {
    const { talk, ch } = setup()
    ch!.emit('message', 'not json')
    ch!.emit('message', 'null')
    ch!.emit('message', { type: 'ptz', event: 'caps', speak: true })
    ch!.emit('message', { type: 'talk', event: 'unknown' })
    expect(talk.canTalk.value).toBe(false)
    expect(talk.message.value).toBeNull()
  })

  it('押したらマイクを送り口に付けて start を送り直し、離したら外して stop を 1 回だけ送る', async () => {
    const { talk, ch, sender } = setup()
    const s = fakeStream()
    gum.mockResolvedValue(s)
    await talk.press()
    expect(gum).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    expect(sender.replaceTrack).toHaveBeenCalledWith(s.list[0])
    expect(talk.holding.value).toBe(true)
    await talk.press() // 押しっぱなしの二重発火は無視
    vi.advanceTimersByTime(TALK_RESEND_MS * 2)
    expect(ch!.sent()).toEqual([{ type: 'talk', action: 'start' }, { type: 'talk', action: 'start' }, { type: 'talk', action: 'start' }])
    talk.release()
    talk.release() // 2 回目は何もしない
    vi.advanceTimersByTime(TALK_RESEND_MS * 3)
    expect(ch!.sent().slice(3)).toEqual([{ type: 'talk', action: 'stop' }])
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(null)
    expect(s.list[0]!.stop).toHaveBeenCalled()
    expect(talk.holding.value).toBe(false)
  })

  it('送り口が無い (古い host) なら押しても何もしない', async () => {
    const { talk } = setup({ sender: null })
    await talk.press()
    expect(gum).not.toHaveBeenCalled()
    expect(talk.holding.value).toBe(false)
  })

  it('マイクの許可が無い・使えないときは案内を出して押していない状態に戻す', async () => {
    const { talk, ch } = setup()
    gum.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    await talk.press()
    expect(talk.message.value).toBe(MIC_DENIED_MESSAGE)
    expect(talk.holding.value).toBe(false)
    gum.mockRejectedValueOnce(new DOMException('none', 'NotFoundError'))
    await talk.press()
    expect(talk.message.value).toBe(MIC_UNAVAILABLE_MESSAGE)
    gum.mockRejectedValueOnce(new Error('x'))
    await talk.press()
    expect(talk.message.value).toBe(MIC_UNAVAILABLE_MESSAGE)
    expect(ch!.send).not.toHaveBeenCalled()
  })

  it('マイクを待つ間に離したら、届いたマイクは止めて何も送らない (失敗も出さない)', async () => {
    const { talk, ch, sender } = setup()
    const s = fakeStream()
    let resolve!: (v: unknown) => void
    gum.mockReturnValueOnce(new Promise((r) => { resolve = r }))
    const p = talk.press()
    talk.release()
    resolve(s)
    await p
    expect(s.list[0]!.stop).toHaveBeenCalled()
    expect(sender.replaceTrack).not.toHaveBeenCalledWith(s.list[0])
    let reject!: (e: unknown) => void
    gum.mockReturnValueOnce(new Promise((_, r) => { reject = r }))
    const q = talk.press()
    talk.release()
    reject(new DOMException('denied', 'NotAllowedError'))
    await q
    expect(talk.message.value).toBeNull()
    expect(ch!.send).not.toHaveBeenCalled()
  })

  it('送り口に付ける間に離した・送り口が消えた・トラックが無い場合', async () => {
    const { talk, ch, sender, senderRef } = setup()
    let done!: () => void
    sender.replaceTrack.mockReturnValueOnce(new Promise<void>((r) => { done = r }))
    gum.mockResolvedValue(fakeStream())
    const p = talk.press()
    await vi.advanceTimersByTimeAsync(0)
    talk.release()
    done()
    await p
    expect(ch!.send).not.toHaveBeenCalled()

    // マイクの無いストリーム → null を付ける
    gum.mockResolvedValueOnce(fakeStream(0))
    await talk.press()
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(null)
    talk.release()

    // マイクを待つ間に送り口が消えた (切断)
    let resolve!: (v: unknown) => void
    gum.mockReturnValueOnce(new Promise((r) => { resolve = r }))
    const q = talk.press()
    senderRef.value = null
    resolve(fakeStream())
    await q
    expect(ch!.sent().at(-1)).toEqual({ type: 'talk', action: 'start' })
    talk.release() // 送り口が無くても畳める
    expect(talk.holding.value).toBe(false)
  })

  it('外すのに失敗しても畳む', async () => {
    const { talk, sender } = setup()
    gum.mockResolvedValue(fakeStream())
    await talk.press()
    sender.replaceTrack.mockRejectedValueOnce(new Error('closed'))
    talk.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(talk.holding.value).toBe(false)
  })

  it('state: 自分が話している・他の人が話している。押している間に他の人に替わったら送るのを止める', async () => {
    const { talk, ch } = setup()
    ch!.emit('message', { type: 'talk', event: 'state', talking: true, mine: false })
    expect(talk.othersTalking.value).toBe(true)
    expect(talk.message.value).toBeNull() // 押していなければ案内は出さない
    gum.mockResolvedValue(fakeStream())
    await talk.press()
    ch!.emit('message', { type: 'talk', event: 'state', talking: true, mine: true })
    expect([talk.talking.value, talk.othersTalking.value]).toEqual([true, false])
    ch!.emit('message', { type: 'talk', event: 'state', talking: true, mine: false })
    expect(talk.message.value).toBe(TAKEN_OVER_MESSAGE)
    expect(talk.holding.value).toBe(false)
    expect(ch!.sent().at(-1)).toEqual({ type: 'talk', action: 'stop' })
    ch!.emit('message', { type: 'talk', event: 'state' })
    expect([talk.talking.value, talk.othersTalking.value]).toEqual([false, false])
  })

  it('result: 繋がったら案内を消し、失敗なら文言を出して離す', async () => {
    const { talk, ch } = setup()
    gum.mockResolvedValue(fakeStream())
    await talk.press()
    ch!.emit('message', { type: 'talk', event: 'result', ok: false, busy: true, message: '他の人がカメラで通話中です' })
    expect(talk.message.value).toBe('他の人がカメラで通話中です')
    expect(talk.holding.value).toBe(false)
    await talk.press()
    ch!.emit('message', { type: 'talk', event: 'result', ok: true, message: 'カメラのスピーカーに接続 (AAC 16kHz)' })
    expect(talk.message.value).toBeNull()
    ch!.emit('message', { type: 'talk', event: 'result', ok: false })
    expect(talk.message.value).toBe('カメラのスピーカーに送れませんでした')
  })

  it('開いていないチャネルには送らない。チャネルが閉じた・付け替わったら畳む', async () => {
    const { talk, ch, channel } = setup()
    ch!.emit('message', { type: 'talk', event: 'caps', speak: true })
    ch!.readyState = 'closing'
    gum.mockResolvedValue(fakeStream())
    await talk.press()
    expect(ch!.send).not.toHaveBeenCalled()
    ch!.emit('close')
    expect([talk.canTalk.value, talk.holding.value]).toEqual([false, false])

    ch!.readyState = 'open'
    ch!.emit('message', { type: 'talk', event: 'caps', speak: true })
    const next = new FakeChannel()
    channel.value = next
    expect(talk.canTalk.value).toBe(false)
    ch!.emit('message', { type: 'talk', event: 'caps', speak: true }) // 古いチャネルからはもう受けない
    expect(talk.canTalk.value).toBe(false)
    next.emit('message', { type: 'talk', event: 'caps', speak: true })
    expect(talk.canTalk.value).toBe(true)
    channel.value = null
    expect(talk.canTalk.value).toBe(false)
  })

  it('unmount で離して受け取りもやめる (チャネルが無くてもよい)', async () => {
    const { talk, ch, app } = setup()
    gum.mockResolvedValue(fakeStream())
    await talk.press()
    app.unmount()
    expect(ch!.sent().at(-1)).toEqual({ type: 'talk', action: 'stop' })
    expect(ch!.listeners.message).toEqual([])
    const none = setup({ channel: null })
    none.app.unmount()
  })
})
