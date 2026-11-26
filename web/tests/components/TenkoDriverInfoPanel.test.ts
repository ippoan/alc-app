import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoDriverInfoPanel from '~/components/TenkoDriverInfoPanel.vue'

// 運転者情報パネルが**どの資格で読むか** (Refs ippoan/alc-app#387)。
// 遠隔点呼モニターからは `'tenko-monitor'`、それ以外の画面 (日次の健康状態) は既定のまま。

const getDriverInfoMock = vi.fn(async (..._args: unknown[]): Promise<unknown> => null)
const getMeasurementMock = vi.fn(async (..._args: unknown[]): Promise<unknown> => null)

vi.mock('~/utils/api', () => ({
  getDriverInfo: (...args: unknown[]) => getDriverInfoMock(...args),
  getMeasurement: (...args: unknown[]) => getMeasurementMock(...args),
  excludeMeasurementBp: vi.fn(),
  fetchFacePhoto: vi.fn(async () => null),
  fetchMeasurementVideo: vi.fn(async () => null),
}))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const EMPLOYEE_ID = 'emp-1'

describe('TenkoDriverInfoPanel — 読むときの scope', () => {
  beforeEach(() => {
    getDriverInfoMock.mockClear()
  })

  it('scope を渡さなければ既定 (\'default\') で読む', async () => {
    const wrapper = await mountSuspended(TenkoDriverInfoPanel, { props: { employeeId: EMPLOYEE_ID } })
    await flush()

    expect(getDriverInfoMock.mock.calls).toEqual([[EMPLOYEE_ID, 'default']])
    wrapper.unmount()
  })

  it('遠隔点呼モニターが渡した scope (\'tenko-monitor\') で読む', async () => {
    const wrapper = await mountSuspended(TenkoDriverInfoPanel, {
      props: { employeeId: EMPLOYEE_ID, scope: 'tenko-monitor' },
    })
    await flush()

    expect(getDriverInfoMock.mock.calls).toEqual([[EMPLOYEE_ID, 'tenko-monitor']])
    wrapper.unmount()
  })
})

describe('TenkoDriverInfoPanel — 直近の血圧から測定の詳細を開く (Refs ippoan/alc-app#676)', () => {
  const info = (recent: unknown[]) => ({
    health_baseline: null,
    recent_measurements: recent,
    working_hours: [],
    instruction_records: [],
    carrying_items: [],
    employee: { id: EMPLOYEE_ID, name: '山田太郎' },
    past_tenko_records: [],
    recent_daily_inspections: [],
    equipment_failures: [],
  })
  const BP = { id: 'm-bp', temperature: null, systolic: 150, diastolic: 90, pulse: 70, measured_at: '2026-11-26T00:00:00Z' }
  const TEMP = { id: 'm-temp', temperature: 36.5, systolic: null, diastolic: null, pulse: null, measured_at: '2026-11-26T00:10:00Z' }
  const measurement = (over: Record<string, unknown> = {}) => ({
    id: 'm-bp', tenant_id: 't', employee_id: EMPLOYEE_ID, alcohol_value: null, result_type: null, device_use_count: 0,
    measured_at: '2026-11-26T00:00:00Z', created_at: '2026-11-26T00:00:00Z', updated_at: '2026-11-26T00:00:00Z',
    status: 'completed', systolic: 150, diastolic: 90, ...over,
  })

  beforeEach(() => {
    getDriverInfoMock.mockReset()
    getMeasurementMock.mockReset()
  })

  it('ログインの画面では血圧だけが押せて、押すと測定を取って詳細を開く。外したら詳細を差し替え一覧を読み直す', async () => {
    getDriverInfoMock.mockResolvedValue(info([BP, TEMP]))
    getMeasurementMock.mockResolvedValueOnce(measurement())
    const wrapper = await mountSuspended(TenkoDriverInfoPanel, { props: { employeeId: EMPLOYEE_ID } })
    await flush()
    const buttons = wrapper.findAll('[data-testid="open-bp-measurement"]')
    expect(buttons.map(b => b.text())).toEqual(['150/90'])
    expect(wrapper.text()).toContain('血圧を押すと測定の詳細を開きます')

    await buttons[0]!.trigger('click')
    await flush()
    expect(getMeasurementMock).toHaveBeenCalledWith('m-bp')
    const detail = wrapper.findComponent({ name: 'MeasurementDetail' })
    expect(detail.props('employeeName')).toBe('山田太郎')

    const excluded = measurement({ bp_excluded_at: '2026-11-26T01:00:00Z', bp_excluded_reason: 'テレコ', bp_excluded_by_name: '運行 太郎' })
    detail.vm.$emit('updated', excluded)
    await flush()
    expect(wrapper.findComponent({ name: 'MeasurementDetail' }).props('measurement')).toEqual(excluded)
    expect(getDriverInfoMock).toHaveBeenCalledTimes(2)

    wrapper.findComponent({ name: 'MeasurementDetail' }).vm.$emit('close')
    await flush()
    expect(wrapper.findComponent({ name: 'MeasurementDetail' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('取れなければ文言を出し、詳細は開かない', async () => {
    getDriverInfoMock.mockResolvedValue(info([BP]))
    getMeasurementMock.mockRejectedValueOnce(new Error('x'))
    const wrapper = await mountSuspended(TenkoDriverInfoPanel, { props: { employeeId: EMPLOYEE_ID } })
    await flush()
    await wrapper.find('[data-testid="open-bp-measurement"]').trigger('click')
    await flush()
    expect(wrapper.find('[data-testid="open-bp-error"]').text()).toBe('測定を取得できませんでした')
    expect(wrapper.findComponent({ name: 'MeasurementDetail' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('遠隔点呼モニター (scope tenko-monitor) と血圧の無い一覧では押せない', async () => {
    getDriverInfoMock.mockResolvedValue(info([BP]))
    const monitor = await mountSuspended(TenkoDriverInfoPanel, { props: { employeeId: EMPLOYEE_ID, scope: 'tenko-monitor' } })
    await flush()
    expect(monitor.find('[data-testid="open-bp-measurement"]').exists()).toBe(false)
    expect(monitor.text()).toContain('150/90')
    expect(monitor.text()).not.toContain('血圧を押すと')
    monitor.unmount()

    getDriverInfoMock.mockResolvedValue(info([TEMP]))
    const noBp = await mountSuspended(TenkoDriverInfoPanel, { props: { employeeId: EMPLOYEE_ID } })
    await flush()
    expect(noBp.find('[data-testid="open-bp-measurement"]').exists()).toBe(false)
    expect(noBp.text()).not.toContain('血圧を押すと')
    noBp.unmount()
  })
})
