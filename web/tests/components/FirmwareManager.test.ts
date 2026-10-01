import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { FirmwareDevice } from '~/utils/api'
import FirmwareManager from '~/components/FirmwareManager.vue'
import AdminDashboard from '~/components/AdminDashboard.vue'

// 管理者の画面のタブ「端末のファーム」(Refs ippoan/alc-app#403)。
// api の 2 関数は mock、manifest の fetch と confirm は stubGlobal。

const { listFirmwareDevices, updateFirmware } = vi.hoisted(() => ({
  listFirmwareDevices: vi.fn(),
  updateFirmware: vi.fn(),
}))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  listFirmwareDevices,
  updateFirmware,
}))

const NOW = new Date('2026-10-01T03:00:00Z').getTime()
const MIN = 60_000

const MANIFESTS: Record<string, string | null> = {
  'manifest.json': '1.2.0',
  'manifest-wifi.json': '1.3.0',
  'manifest-dev.json': null, // 取れない
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = Object.keys(MANIFESTS).find(k => url.endsWith(`/${k}`))!
    const version = MANIFESTS[key]
    if (version === null) return { ok: false, json: async () => ({}) }
    return { ok: true, json: async () => ({ version }) }
  }))
}

function dev(over: Partial<FirmwareDevice> = {}): FirmwareDevice {
  return {
    device_id: 'devaaaaa-bbbb',
    label: 'ロビー',
    kind: 'cores3',
    board: 'cores3',
    flavor: 'cores3',
    version: '1.0.0',
    phase: 'idle',
    reported_at_ms: NOW - MIN,
    ...over,
  }
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

async function mountManager(devices: FirmwareDevice[] = [dev()]) {
  listFirmwareDevices.mockResolvedValue({ devices })
  const wrapper = await mountSuspended(FirmwareManager)
  await vi.advanceTimersByTimeAsync(0)
  await flush()
  return wrapper
}

const rows = (w: Awaited<ReturnType<typeof mountManager>>) => w.findAll('[data-testid="firmware-row"]')
const col = (row: ReturnType<ReturnType<typeof rows>['at']>, name: string) => row!.find(`[data-col="${name}"]`).text()
const button = (row: ReturnType<ReturnType<typeof rows>['at']>) => row!.find('[data-testid="firmware-update"]')

describe('FirmwareManager', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    vi.setSystemTime(NOW)
    vi.clearAllMocks()
    stubFetch()
    vi.stubGlobal('confirm', vi.fn(() => true))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe('一覧の引き直し', () => {
    it('mount で 1 回引き、10 秒ごとに引き直し、unmount で止まる', async () => {
      const wrapper = await mountManager()
      expect(listFirmwareDevices).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(listFirmwareDevices).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(listFirmwareDevices).toHaveBeenCalledTimes(3)
      wrapper.unmount()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(listFirmwareDevices).toHaveBeenCalledTimes(3)
    })

    it('前の回が返っていない間は重ねて呼ばない', async () => {
      let resolve!: (v: { devices: FirmwareDevice[] }) => void
      listFirmwareDevices.mockReturnValue(new Promise((r) => { resolve = r }))
      const wrapper = await mountSuspended(FirmwareManager)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(listFirmwareDevices).toHaveBeenCalledTimes(1)
      resolve({ devices: [] })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(listFirmwareDevices).toHaveBeenCalledTimes(2)
      wrapper.unmount()
    })

    it('最新の版は 5 分ごとに引き直す', async () => {
      const wrapper = await mountManager()
      const calls = () => (fetch as ReturnType<typeof vi.fn>).mock.calls.length
      expect(calls()).toBe(3)
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual({ cache: 'no-store' })
      await vi.advanceTimersByTimeAsync(5 * MIN)
      expect(calls()).toBe(6)
      wrapper.unmount()
    })
  })

  describe('列', () => {
    it('label が在る行 / null の行 (device_id の先頭 8 文字)', async () => {
      const wrapper = await mountManager([
        dev({ device_id: 'aaaaaaaa-1', label: 'ロビー' }),
        dev({ device_id: 'bbbbbbbb-2', label: null }),
      ])
      expect(col(rows(wrapper)[0], 'name')).toBe('ロビー')
      expect(col(rows(wrapper)[1], 'name')).toBe('bbbbbbbb')
      wrapper.unmount()
    })

    it('種類は board / flavor (無ければ -)', async () => {
      const wrapper = await mountManager([
        dev({ device_id: 'a1' }),
        dev({ device_id: 'a2', board: undefined, flavor: undefined }),
      ])
      expect(col(rows(wrapper)[0], 'kind')).toBe('cores3 / cores3')
      expect(col(rows(wrapper)[1], 'kind')).toBe('- / -')
      wrapper.unmount()
    })

    it('現在の版: version が無ければ「不明 (古い版)」', async () => {
      const wrapper = await mountManager([dev({ device_id: 'a1' }), dev({ device_id: 'a2', version: undefined })])
      expect(col(rows(wrapper)[0], 'version')).toBe('1.0.0')
      expect(col(rows(wrapper)[1], 'version')).toBe('不明 (古い版)')
      wrapper.unmount()
    })

    it('最新の版: flavor ごと / 取れない flavor・flavor 無し・表に無い flavor は -', async () => {
      const wrapper = await mountManager([
        dev({ device_id: 'a1', flavor: 'cores3' }),
        dev({ device_id: 'a2', flavor: 'cores3-wifi' }),
        dev({ device_id: 'a3', flavor: 'cores3-dev' }),
        dev({ device_id: 'a4', flavor: undefined }),
        dev({ device_id: 'a5', flavor: 'unknown' }),
      ])
      expect(rows(wrapper).map(r => col(r, 'latest'))).toEqual(['1.2.0', '1.3.0', '-', '-', '-'])
      wrapper.unmount()
    })

    it('manifest が例外・version が文字列でないときも行は壊れない', async () => {
      vi.stubGlobal('fetch', vi.fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce({ ok: true, json: async () => ({ version: 3 }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ version: '9.9.9' }) }))
      const wrapper = await mountManager([dev({ device_id: 'a1', flavor: 'cores3' }), dev({ device_id: 'a2', flavor: 'cores3-dev' })])
      expect(rows(wrapper).map(r => col(r, 'latest'))).toEqual(['-', '9.9.9'])
      wrapper.unmount()
    })

    it('最終報告は ja-JP の日時', async () => {
      const wrapper = await mountManager([dev()])
      const expected = new Date(NOW - MIN).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      expect(col(rows(wrapper)[0], 'reported')).toBe(expected)
      wrapper.unmount()
    })
  })

  describe('状態', () => {
    const status = async (over: Partial<FirmwareDevice>) => {
      const wrapper = await mountManager([dev(over)])
      const text = col(rows(wrapper)[0], 'status')
      wrapper.unmount()
      return text
    }

    it('応答なし: 10 分以上古い報告は phase に関係なく最優先', async () => {
      expect(await status({ phase: 'writing', reported_at_ms: NOW - 10 * MIN })).toBe('応答なし')
      expect(await status({ phase: 'done', reported_at_ms: NOW - 11 * MIN })).toBe('応答なし')
      expect(await status({ phase: 'idle', reported_at_ms: NOW - 10 * MIN + 1 })).toBe('待機中')
    })

    it('idle / 更新中 4 種 / done', async () => {
      expect(await status({ phase: 'idle' })).toBe('待機中')
      for (const phase of ['downloading', 'writing', 'rebooting', 'confirming'] as const) {
        expect(await status({ phase })).toBe('更新中')
      }
      expect(await status({ phase: 'done' })).toBe('更新しました')
    })

    it('failed: reason が在れば括弧で添える', async () => {
      expect(await status({ phase: 'failed', reason: 'crc' })).toBe('失敗 (crc)')
      expect(await status({ phase: 'failed' })).toBe('失敗')
    })

    it('skipped: 理由 4 つ + 未知の理由 + 理由なし', async () => {
      expect(await status({ phase: 'skipped', reason: 'up_to_date' })).toBe('更新しませんでした: 最新です')
      expect(await status({ phase: 'skipped', reason: 'busy' })).toBe('更新しませんでした: 使用中でした')
      expect(await status({ phase: 'skipped', reason: 'unsupported' })).toBe('更新しませんでした: 対象外の機種です')
      expect(await status({ phase: 'skipped', reason: 'flavor_mismatch' })).toBe('更新しませんでした: 対象外の種類です')
      expect(await status({ phase: 'skipped', reason: 'other_reason' })).toBe('更新しませんでした: other_reason')
      expect(await status({ phase: 'skipped' })).toBe('更新しませんでした: 理由なし')
    })
  })

  describe('「更新する」の押せる条件', () => {
    it('押せる: 版が違い、応答があり、更新中でなく、最新の版が分かる', async () => {
      const wrapper = await mountManager([dev()])
      expect(button(rows(wrapper)[0]).attributes('disabled')).toBeUndefined()
      wrapper.unmount()
    })

    it('押せない: 版が同じ / 応答なし / 更新中 / version 無し / 最新の版が不明', async () => {
      const wrapper = await mountManager([
        dev({ device_id: 'a1', version: '1.2.0' }),
        dev({ device_id: 'a2', reported_at_ms: NOW - 20 * MIN }),
        dev({ device_id: 'a3', phase: 'writing' }),
        dev({ device_id: 'a4', version: undefined }),
        dev({ device_id: 'a5', flavor: 'cores3-dev' }),
      ])
      for (const r of rows(wrapper)) expect(button(r).attributes('disabled')).toBeDefined()
      wrapper.unmount()
    })

    it('版の大小は見ない (最新より新しくても不一致なら押せる)', async () => {
      const wrapper = await mountManager([dev({ version: '9.0.0' })])
      expect(button(rows(wrapper)[0]).attributes('disabled')).toBeUndefined()
      wrapper.unmount()
    })
  })

  describe('「更新する」を押す', () => {
    it('confirm をキャンセルしたら updateFirmware を呼ばない', async () => {
      vi.stubGlobal('confirm', vi.fn(() => false))
      const wrapper = await mountManager([dev()])
      await button(rows(wrapper)[0]).trigger('click')
      expect(confirm).toHaveBeenCalledWith('ロビー を 1.2.0 に更新します。よろしいですか?')
      expect(updateFirmware).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('OK なら device_id で 1 回呼び、呼んでいる間その行だけ disabled', async () => {
      let resolve!: (v: { sent: number }) => void
      updateFirmware.mockReturnValue(new Promise((r) => { resolve = r }))
      const wrapper = await mountManager([dev({ device_id: 'a1' }), dev({ device_id: 'a2' })])
      await button(rows(wrapper)[0]).trigger('click')
      expect(updateFirmware).toHaveBeenCalledTimes(1)
      expect(updateFirmware).toHaveBeenCalledWith('a1')
      expect(button(rows(wrapper)[0]).attributes('disabled')).toBeDefined()
      expect(button(rows(wrapper)[1]).attributes('disabled')).toBeUndefined()
      resolve({ sent: 1 })
      await flush()
      await wrapper.vm.$nextTick()
      expect(button(rows(wrapper)[0]).attributes('disabled')).toBeUndefined()
      wrapper.unmount()
    })
  })

  describe('結果の文言', () => {
    const notice = (w: Awaited<ReturnType<typeof mountManager>>) => w.find('[data-testid="firmware-notice"]')

    async function press(wrapper: Awaited<ReturnType<typeof mountManager>>) {
      await button(rows(wrapper)[0]).trigger('click')
      await flush()
      await wrapper.vm.$nextTick()
    }

    it('sent: 0', async () => {
      updateFirmware.mockResolvedValue({ sent: 0 })
      const wrapper = await mountManager()
      await press(wrapper)
      expect(notice(wrapper).text()).toBe('開いているキオスクがありません。キオスクの画面を開いてから、もう一度押してください。')
      wrapper.unmount()
    })

    it('sent: 2 は台数を画面に出さない', async () => {
      updateFirmware.mockResolvedValue({ sent: 2 })
      const wrapper = await mountManager()
      await press(wrapper)
      expect(notice(wrapper).text()).toBe('合図を送りました。キオスクが待機画面のときに更新が始まります。')
      expect(notice(wrapper).text()).not.toContain('2')
      wrapper.unmount()
    })

    it('403 + dev_token_write_forbidden', async () => {
      updateFirmware.mockRejectedValue(Object.assign(new Error('API エラー (403): {"error":"dev_token_write_forbidden"}'), { status: 403 }))
      const wrapper = await mountManager()
      await press(wrapper)
      expect(notice(wrapper).text()).toBe('確認用のログインでは更新できません。')
      wrapper.unmount()
    })

    it('それ以外の失敗は message をそのまま出す (403 でも本文が違えば)', async () => {
      updateFirmware.mockRejectedValueOnce(Object.assign(new Error('API エラー (403): forbidden'), { status: 403 }))
      const wrapper = await mountManager()
      await press(wrapper)
      expect(notice(wrapper).text()).toBe('API エラー (403): forbidden')
      updateFirmware.mockRejectedValueOnce(new Error('API エラー (500): boom'))
      await press(wrapper)
      expect(notice(wrapper).text()).toBe('API エラー (500): boom')
      wrapper.unmount()
    })

    it('10 秒で消える', async () => {
      updateFirmware.mockResolvedValue({ sent: 1 })
      const wrapper = await mountManager()
      await press(wrapper)
      expect(notice(wrapper).exists()).toBe(true)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(notice(wrapper).exists()).toBe(false)
      wrapper.unmount()
    })

    it('続けて押したら前の消去の timer を引き継がず新しい文言が 10 秒残る', async () => {
      updateFirmware.mockResolvedValue({ sent: 1 })
      const wrapper = await mountManager()
      await press(wrapper)
      await vi.advanceTimersByTimeAsync(6_000)
      await press(wrapper)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(notice(wrapper).exists()).toBe(true)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(notice(wrapper).exists()).toBe(false)
      wrapper.unmount()
    })
  })

  describe('一覧の取得の失敗・0 件', () => {
    const err = (w: Awaited<ReturnType<typeof mountManager>>) => w.find('[data-testid="firmware-list-error"]')

    it('失敗が表の上に出て、前回の一覧が残り、次に成功したら消える', async () => {
      const wrapper = await mountManager([dev()])
      listFirmwareDevices.mockRejectedValueOnce(new Error('API エラー (500): x'))
      await vi.advanceTimersByTimeAsync(10_000)
      await wrapper.vm.$nextTick()
      expect(err(wrapper).text()).toBe('API エラー (500): x')
      expect(rows(wrapper)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(10_000)
      await wrapper.vm.$nextTick()
      expect(err(wrapper).exists()).toBe(false)
      wrapper.unmount()
    })

    it('Error でない失敗は既定の文言', async () => {
      listFirmwareDevices.mockRejectedValue('boom')
      const wrapper = await mountSuspended(FirmwareManager)
      await vi.advanceTimersByTimeAsync(0)
      await wrapper.vm.$nextTick()
      expect(err(wrapper).text()).toBe('一覧を取得できませんでした')
      wrapper.unmount()
    })

    it('0 件の文言と、注意書き 2 行', async () => {
      const wrapper = await mountManager([])
      expect(wrapper.find('[data-testid="firmware-empty"]').text()).toBe('報告している端末がありません。キオスクに CoreS3 を USB で繋ぎ、キオスクの画面を開いたままにしてください。')
      expect(wrapper.text()).toContain('更新は、その端末を USB で繋いでいるキオスクの画面が開いているときだけ始まります。')
      expect(wrapper.text()).toContain('更新中 (1〜2 分) は、キオスクの画面に「端末を更新しています」と表示され、操作できません。')
      wrapper.unmount()
    })
  })
})

// AdminDashboard のタブ。専用のテストが無かったので、このタブの分だけ小さく見る。
describe('AdminDashboard — 端末のファームのタブ', () => {
  beforeEach(() => {
    listFirmwareDevices.mockResolvedValue({ devices: [] })
    stubFetch()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('タブは一番最後で、押すと FirmwareManager が描画される (最初は描画されない)', async () => {
    const wrapper = await mountSuspended(AdminDashboard)
    const labels = wrapper.findAll('button').map(b => b.text())
    expect(labels[labels.indexOf('端末のファーム') + 1]).toBe('ログアウト')
    expect(labels.at(labels.indexOf('ログアウト') - 1)).toBe('端末のファーム')
    expect(wrapper.findComponent(FirmwareManager).exists()).toBe(false)

    await wrapper.findAll('button').find(b => b.text() === '端末のファーム')!.trigger('click')
    expect(wrapper.findComponent(FirmwareManager).exists()).toBe(true)
    wrapper.unmount()
  })

  it('?tab=firmware (initialTab) で開ける', async () => {
    const wrapper = await mountSuspended(AdminDashboard, { props: { initialTab: 'firmware' } })
    expect(wrapper.findComponent(FirmwareManager).exists()).toBe(true)
    wrapper.unmount()
  })
})
