// 打刻の管理画面 (TimecardManager) の履歴で、打刻から点呼に移った行 (measurement_id で
// 結ばれた行) を「点呼」とアルコール値で出す (Refs ippoan/alc-app#436)。
// 結ばれていない行は今どおり (打刻)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TimecardManager from '~/components/TimecardManager.vue'
import { resetDeviceNames } from '~/composables/useDeviceNames'

const listTimePunchesMock = vi.fn(async () => ({ punches: [] as unknown[], total: 0 }))
const listCamHostKeysMock = vi.fn(async () => ({ keys: [] as unknown[], names: [] as unknown[] }))
const listDeviceLabelsMock = vi.fn(async () => ({ devices: [] as unknown[] }))

vi.mock('~/utils/api', () => ({
  getEmployees: vi.fn(async () => []),
  listTimecardCards: vi.fn(async () => []),
  createTimecardCard: vi.fn(async () => ({})),
  deleteTimecardCard: vi.fn(async () => {}),
  listTimePunches: () => listTimePunchesMock(),
  downloadTimePunchesCsv: vi.fn(async () => {}),
  listCamHostKeys: () => listCamHostKeysMock(),
  listDeviceLabels: () => listDeviceLabelsMock(),
}))

mockNuxtImport('useAuth', () => () => ({ accessToken: ref(null) }))
mockNuxtImport('useDeviceToken', () => () => ({ getDeviceJwt: vi.fn(async () => null) }))
mockNuxtImport('useTimecardWatch', () => () => ({ isConnected: ref(false), connect: vi.fn(async () => {}), stop: vi.fn() }))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function punch(id: string, at: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: 't',
    employee_id: null,
    device_id: null,
    device_name: 'kiosk-1',
    card_id: null,
    kind: 'timecard',
    employee_name: `社員${id}`,
    card_kind: null,
    punched_at: at,
    created_at: at,
    ...extra,
  }
}

describe('TimecardManager — 打刻に結ばれた点呼の表示', () => {
  it('★ 結ばれた行は「点呼」とアルコール値 (0 は通常、0 より上は赤)、結ばれていない行は「打刻」のまま', async () => {
    listTimePunchesMock.mockResolvedValueOnce({
      punches: [
        punch('1', '2026-10-20T00:02:00Z', { measurement_id: 'm-1', alcohol_level: 0.05, result: 'normal', tenko_recorded: false }),
        punch('2', '2026-10-20T00:01:00Z', { measurement_id: 'm-2', alcohol_level: 0, result: 'normal', tenko_recorded: true }),
        punch('3', '2026-10-20T00:00:00Z'),
      ],
      total: 3,
    })
    const wrapper = await mountSuspended(TimecardManager)
    await flush()

    const rows = wrapper.findAll('tbody tr')
    expect(rows).toHaveLength(3)

    expect(rows[0]!.text()).toContain('点呼')
    expect(rows[0]!.find('[data-testid="punch-alcohol-value"]').text()).toBe('0.050 mg/L')
    const detected = rows[0]!.find('[data-testid="punch-alcohol-result"]')
    expect(detected.text()).toBe('検知')
    expect(detected.classes()).toContain('bg-red-100')
    expect(rows[0]!.find('[data-testid="punch-tenko-pending"]').exists()).toBe(true)

    const normal = rows[1]!.find('[data-testid="punch-alcohol-result"]')
    expect(normal.text()).toBe('正常')
    expect(normal.classes()).toContain('bg-green-100')
    expect(rows[1]!.find('[data-testid="punch-tenko-pending"]').exists()).toBe(false)

    expect(rows[2]!.text()).toContain('打刻')
    expect(rows[2]!.text()).not.toContain('点呼')
    expect(rows[2]!.find('[data-testid="punch-alcohol-result"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('吹込不良 (error) は値を出さず「測定エラー」だけ', async () => {
    listTimePunchesMock.mockResolvedValueOnce({
      punches: [punch('1', '2026-10-20T00:00:00Z', { measurement_id: 'm-1', alcohol_level: 0, result: 'error' })],
      total: 1,
    })
    const wrapper = await mountSuspended(TimecardManager)
    await flush()

    expect(wrapper.find('[data-testid="punch-alcohol-value"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="punch-alcohol-result"]').text()).toBe('測定エラー')
    wrapper.unmount()
  })
})

describe('TimecardManager — 「端末」列は名前 (ID はツールチップ)', () => {
  beforeEach(() => resetDeviceNames())

  it('★ 機体の鍵はラベル・browser は固定名・結び付きの無い hub は登録簿の名前 + 印・不明は名前未登録。端末の記録が無い行は「-」', async () => {
    listCamHostKeysMock.mockResolvedValueOnce({ keys: [], names: [{ device_id: 'alarm:fp-1', label: '事務所の機体', revoked: false }] })
    listDeviceLabelsMock.mockResolvedValueOnce({ devices: [{ device_id: 'cores3-a', label: '旧ハブ' }] })
    listTimePunchesMock.mockResolvedValueOnce({
      punches: [
        punch('1', '2026-10-20T00:04:00Z', { device_name: 'alarm:fp-1' }),
        punch('2', '2026-10-20T00:03:00Z', { device_name: 'browser' }),
        punch('3', '2026-10-20T00:02:00Z', { device_name: 'cores3-a' }),
        punch('4', '2026-10-20T00:01:00Z', { device_name: 'cores3-z' }),
        punch('5', '2026-10-20T00:00:00Z', { device_name: null }),
      ],
      total: 5,
    })
    const wrapper = await mountSuspended(TimecardManager)
    await flush()
    await flush()

    const cells = wrapper.findAll('[data-testid="punch-device"]')
    expect(cells.map(c => c.text())).toEqual([
      '事務所の機体', 'ブラウザ (ログイン利用者の打刻)', '旧ハブ (鍵の ID 未登録)', '名前未登録の端末', '-',
    ])
    expect(cells.map(c => c.attributes('title'))).toEqual(['alarm:fp-1', 'browser', 'cores3-a', 'cores3-z', undefined])
    wrapper.unmount()
  })

  it('名前の表が取れなくても一覧は出る (名前未登録の端末)', async () => {
    listCamHostKeysMock.mockRejectedValueOnce(new Error('403'))
    listDeviceLabelsMock.mockRejectedValueOnce(new Error('403'))
    listTimePunchesMock.mockResolvedValueOnce({ punches: [punch('1', '2026-10-20T00:00:00Z', { device_name: 'alarm:fp-1' })], total: 1 })
    const wrapper = await mountSuspended(TimecardManager)
    await flush()
    expect(wrapper.find('[data-testid="punch-device"]').text()).toBe('名前未登録の端末')
    wrapper.unmount()
  })
})
