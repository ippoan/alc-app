// 拠点 PC の自己更新を管理者の画面から確認させる。メッセージの形は alc-cam の docs/host-protocol.md
import { describe, it, expect, vi } from 'vitest'
import { shallowRef } from 'vue'
import { withSetup } from '../helpers/with-setup'
import { useCamUpdate } from '~/composables/useCamUpdate'

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
}

function setup(initial: FakeChannel | null = new FakeChannel()) {
  const channel = shallowRef<any>(initial)
  const [update, app] = withSetup(() => useCamUpdate(channel))
  return { channel, update, app, ch: initial }
}

describe('useCamUpdate', () => {
  it('caps が来るまで null。版をそのまま出し、欠けた項目は空・null', () => {
    const { update, ch } = setup()
    expect(update.caps.value).toBeNull()
    ch!.emit('message', { type: 'update', event: 'caps', host: '0.4.5', extension: '0.4.5' })
    expect(update.caps.value).toEqual({ host: '0.4.5', extension: '0.4.5' })
    ch!.emit('message', { type: 'update', event: 'caps' })
    expect(update.caps.value).toEqual({ host: '', extension: null })
  })

  it('update 以外・読めない・知らない event・知らない state は無視する', () => {
    const { update, ch } = setup()
    ch!.emit('message', 'not json')
    ch!.emit('message', 'null')
    ch!.emit('message', { type: 'ptz', event: 'caps', host: '9' })
    ch!.emit('message', { type: 'update', event: 'unknown' })
    ch!.emit('message', { type: 'update', event: 'state' })
    ch!.emit('message', { type: 'update', event: 'state', state: 'exploded' })
    expect([update.caps.value, update.state.value, update.message.value]).toEqual([null, null, null])
  })

  it('check で 1 通送って確認中に。確認中・閉じたチャネルでは送らない', () => {
    const { update, ch } = setup()
    update.check()
    expect(ch!.send).toHaveBeenCalledWith(JSON.stringify({ type: 'update', action: 'check' }))
    expect([update.state.value, update.message.value]).toEqual(['checking', '確認中...'])
    update.check()
    expect(ch!.send).toHaveBeenCalledTimes(1)
    ch!.emit('message', { type: 'update', event: 'state', state: 'latest', current: '0.4.5', latest: '0.4.5', message: '' })
    ch!.readyState = 'closing'
    update.check()
    expect(ch!.send).toHaveBeenCalledTimes(1)
    expect(update.state.value).toBe('latest')
  })

  it('結果は host の文言を優先し、無ければ状態の名前を出す (他の人が押した結果も出る)', () => {
    const { update, ch } = setup()
    ch!.emit('message', { type: 'update', event: 'state', state: 'installed', message: 'host を v0.4.6 にしました (次の起動から)' })
    expect([update.state.value, update.message.value]).toEqual(['installed', 'host を v0.4.6 にしました (次の起動から)'])
    for (const [state, label] of [
      ['latest', '最新です'],
      ['deferred', '見る人が居なくなってから入れ替えます'],
      ['failed', '更新に失敗しました'],
      ['unsupported', 'この拠点 PC は自己更新に対応していません'],
    ]) {
      ch!.emit('message', { type: 'update', event: 'state', state })
      expect(update.message.value).toBe(label)
    }
  })

  it('チャネルが無い・閉じた・付け替わったら畳む。unmount で受け取りをやめる', () => {
    const none = setup(null)
    none.update.check()
    expect(none.update.state.value).toBeNull()
    none.app.unmount()

    const { update, ch, channel, app } = setup()
    ch!.emit('message', { type: 'update', event: 'caps', host: '0.4.5', extension: null })
    ch!.emit('close')
    expect(update.caps.value).toBeNull()
    const next = new FakeChannel()
    channel.value = next
    ch!.emit('message', { type: 'update', event: 'caps', host: '1' })
    expect(update.caps.value).toBeNull()
    next.emit('message', { type: 'update', event: 'caps', host: '0.4.5' })
    expect(update.caps.value?.host).toBe('0.4.5')
    app.unmount()
    expect(next.listeners.message).toEqual([])
  })
})
