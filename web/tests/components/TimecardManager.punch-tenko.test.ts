// 打刻の管理画面 (TimecardManager) の履歴で、打刻から点呼に移った行 (measurement_id で
// 結ばれた行) を「点呼」とアルコール値で出す (Refs ippoan/alc-app#436)。
// 結ばれていない行は今どおり (打刻)。
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TimecardManager from '~/components/TimecardManager.vue'

const listTimePunchesMock = vi.fn(async () => ({ punches: [] as unknown[], total: 0 }))

vi.mock('~/utils/api', () => ({
  getEmployees: vi.fn(async () => []),
  listTimecardCards: vi.fn(async () => []),
  createTimecardCard: vi.fn(async () => ({})),
  deleteTimecardCard: vi.fn(async () => {}),
  listTimePunches: () => listTimePunchesMock(),
  downloadTimePunchesCsv: vi.fn(async () => {}),
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
        punch('1', '2026-10-20T00:02:00Z', { measurement_id: 'm-1', alcohol_level: 0.05, result: 'normal', tenko_pending: true }),
        punch('2', '2026-10-20T00:01:00Z', { measurement_id: 'm-2', alcohol_level: 0, result: 'normal', tenko_pending: false }),
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
