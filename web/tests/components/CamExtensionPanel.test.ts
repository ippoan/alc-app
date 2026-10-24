// メンテナンス画面の「カメラ配信 (拡張)」: 拡張の cam_status を数秒ごとに出し、cam_control を送る。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import CamExtensionPanel from '~/components/CamExtensionPanel.vue'
import { defineComponent, h } from 'vue'
import { POLL_MS, jstMinuteLabel, useCamExtension, parseStatusReply, tokenLabel, updateLabel, viewersLabel, type CamExtensionStatus } from '~/composables/useCamExtension'
import { ALC_CAM_EXTENSION_ID } from '~/utils/alc-cam-extension'

const NOW = Date.parse('2026-10-24T00:00:00Z')

function makeStatus(patch: Partial<CamExtensionStatus> = {}): CamExtensionStatus {
  return {
    version: '0.4.2',
    hostVersion: '0.4.2',
    enabled: true,
    tokenLive: true,
    tokenExp: NOW + 600_000,
    tokenSub: 'alarm:fp1',
    assigned: { id: 'site-1', name: '本社' },
    config: ['本社', 'ok'],
    host: ['起動 (v0.4.2)', 'ok'],
    signal: ['接続済み', 'ok'],
    camera: ['受信中 (H264)', 'ok'],
    viewers: [{ ok: true, message: '接続 (P2P)' }],
    update: ['最新', 'ok'],
    updateState: 'latest',
    updateAt: NOW,
    lastError: null,
    ...patch,
  }
}

type Cb = (response?: unknown) => void
let reply: (msg: { type: string, action?: string }) => unknown
let sendMessage: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
  reply = () => ({ ok: true, status: makeStatus() })
  sendMessage = vi.fn((_id: string, msg: { type: string }, cb: Cb) => cb(reply(msg)))
  vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const text = (w: Awaited<ReturnType<typeof mountSuspended>>, id: string) => w.find(`[data-testid="${id}"]`)

describe('CamExtensionPanel', () => {
  it('chrome.runtime が無いブラウザでは案内だけで、拡張に送らない', async () => {
    vi.stubGlobal('chrome', undefined)
    const w = await mountSuspended(CamExtensionPanel)
    expect(text(w, 'cam-ext-unsupported').exists()).toBe(true)
    expect(text(w, 'cam-ext-toggle').exists()).toBe(false)
    w.unmount()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('状態を出し (版・鍵の sub・担当カメラ・host 更新の時刻は JST)、POLL_MS ごとに取り直す', async () => {
    const w = await mountSuspended(CamExtensionPanel)
    await flushPromises()
    expect(sendMessage).toHaveBeenCalledWith(ALC_CAM_EXTENSION_ID, { type: 'cam_status' }, expect.any(Function))
    const body = w.text()
    expect(body).toContain('拡張 v0.4.2・host v0.4.2')
    expect(body).toContain('alarm:fp1')
    expect(body).toContain('本社 (site-1)')
    expect(body).toContain('1 人: 接続 (P2P) 1 人')
    expect(body).toContain('(10/24 09:00)')
    expect(text(w, 'cam-ext-toggle').text()).toBe('停止')
    expect(text(w, 'cam-ext-error').exists()).toBe(false)

    reply = () => ({ ok: true, status: makeStatus({ hostVersion: '', assigned: null, config: ['担当カメラ待ち', 'warn'], lastError: { message: 'host: 終了', at: NOW } }) })
    vi.advanceTimersByTime(POLL_MS)
    await flushPromises()
    expect(w.text()).toContain('担当カメラ待ち')
    expect(w.text()).not.toContain('host v')
    expect(text(w, 'cam-ext-error').text()).toBe('host: 終了')

    const calls = sendMessage.mock.calls.length
    w.unmount()
    vi.advanceTimersByTime(POLL_MS * 2)
    expect(sendMessage.mock.calls.length).toBe(calls)
  })

  it('拡張が無い・古い拡張 ({ ok: false }) は「拡張が見つかりません」', async () => {
    reply = () => ({ ok: false })
    const w = await mountSuspended(CamExtensionPanel)
    await flushPromises()
    expect(text(w, 'cam-ext-missing').exists()).toBe(true)
  })

  it('停止/開始・更新確認・取り直しのボタンで cam_control を送り、結果と新しい状態を出す', async () => {
    const w = await mountSuspended(CamExtensionPanel)
    await flushPromises()

    reply = msg => (msg.type === 'cam_control'
      ? { ok: true, message: '停止しました', status: makeStatus({ enabled: false }) }
      : { ok: true, status: makeStatus({ enabled: false }) })
    await text(w, 'cam-ext-toggle').trigger('click')
    await flushPromises()
    expect(sendMessage).toHaveBeenLastCalledWith(ALC_CAM_EXTENSION_ID, { type: 'cam_control', action: 'stop' }, expect.any(Function))
    expect(text(w, 'cam-ext-result').text()).toBe('停止しました')
    expect(text(w, 'cam-ext-toggle').text()).toBe('開始')

    reply = () => ({ ok: true, status: makeStatus({ enabled: false }) }) // message 無し
    await text(w, 'cam-ext-toggle').trigger('click')
    await flushPromises()
    expect(sendMessage).toHaveBeenLastCalledWith(ALC_CAM_EXTENSION_ID, { type: 'cam_control', action: 'start' }, expect.any(Function))
    expect(text(w, 'cam-ext-result').text()).toBe('')

    await text(w, 'cam-ext-update').trigger('click')
    await flushPromises()
    expect(sendMessage).toHaveBeenLastCalledWith(ALC_CAM_EXTENSION_ID, { type: 'cam_control', action: 'update_check' }, expect.any(Function))

    reply = () => ({ ok: false, message: '鍵がありません', status: makeStatus() })
    await text(w, 'cam-ext-refetch').trigger('click')
    await flushPromises()
    expect(sendMessage).toHaveBeenLastCalledWith(ALC_CAM_EXTENSION_ID, { type: 'cam_control', action: 'refetch' }, expect.any(Function))
    expect(text(w, 'cam-ext-result').classes()).toContain('text-red-600')
    expect(text(w, 'cam-ext-result').text()).toBe('鍵がありません')

    // 応答が無くなった (拡張が外された)
    sendMessage.mockImplementation((_id: string, _msg: unknown, cb: Cb) => cb())
    await text(w, 'cam-ext-refetch').trigger('click')
    await flushPromises()
    expect(text(w, 'cam-ext-missing').exists()).toBe(true)
    expect(text(w, 'cam-ext-result').text()).toBe('拡張が見つかりません')
  })

  it('操作中は次の操作を送らない', async () => {
    const w = await mountSuspended(CamExtensionPanel)
    await flushPromises()
    let pending: Cb = () => {}
    sendMessage.mockImplementation((_id: string, _msg: unknown, cb: Cb) => { pending = cb })
    void text(w, 'cam-ext-update').trigger('click')
    await flushPromises()
    expect(text(w, 'cam-ext-refetch').attributes('disabled')).toBeDefined()
    pending({ ok: true, status: makeStatus() })
    await flushPromises()
    expect(text(w, 'cam-ext-refetch').attributes('disabled')).toBeUndefined()
  })
})

describe('useCamExtension', () => {
  const mountComposable = async () => {
    let api!: ReturnType<typeof useCamExtension>
    await mountSuspended(defineComponent({
      setup() {
        api = useCamExtension()
        return () => h('div')
      },
    }))
    return api
  }

  it('操作中・未対応のブラウザでは control を送らない', async () => {
    const api = await mountComposable()
    await flushPromises()
    sendMessage.mockImplementation(() => {})
    void api.control('update_check')
    const before = sendMessage.mock.calls.length
    await api.control('refetch')
    expect(sendMessage.mock.calls.length).toBe(before)
    expect(api.busy.value).toBe('update_check')

    vi.stubGlobal('chrome', undefined)
    const off = await mountComposable()
    await off.control('stop')
    await off.refresh()
    expect(off.supported).toBe(false)
    expect(off.found.value).toBeNull()
  })

  it('parseStatusReply は形が違えば null', () => {
    expect(parseStatusReply(null)).toBeNull()
    expect(parseStatusReply({ ok: true })).toBeNull()
    expect(parseStatusReply({ ok: true, status: null })).toBeNull()
    expect(parseStatusReply({ ok: true, status: { version: 1, enabled: true } })).toBeNull()
    expect(parseStatusReply({ ok: true, status: { version: '0.4.2' } })).toBeNull()
  })

  it('鍵: なし / あり / 期限切れ (sub 無しも)', () => {
    expect(tokenLabel(makeStatus({ tokenExp: 0 }))[1]).toBe('warn')
    expect(tokenLabel(makeStatus())).toEqual([`あり (${jstMinuteLabel(NOW + 600_000)} まで、alarm:fp1)`, 'ok'])
    expect(tokenLabel(makeStatus({ tokenLive: false, tokenSub: '' }))).toEqual([`期限切れ (${jstMinuteLabel(NOW + 600_000)})`, ''])
  })

  it('見る人: なし / 混在', () => {
    expect(viewersLabel(makeStatus({ viewers: [] }))).toEqual(['なし', ''])
    expect(viewersLabel(makeStatus({ viewers: [{ ok: false, message: '接続待ち' }, { ok: false, message: '接続待ち' }] }))).toEqual(['2 人: 接続待ち', ''])
  })

  it('host 更新: 未確認は時刻を付けない', () => {
    expect(updateLabel(makeStatus({ updateAt: 0, update: ['-', ''] }))).toEqual(['-', ''])
  })
})
