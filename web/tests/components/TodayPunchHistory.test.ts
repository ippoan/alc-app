import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TodayPunchHistory from '~/components/TodayPunchHistory.vue'

// TimePunchKiosk.vue から切り出した部品 (Refs ippoan/alc-app#238)。
// 取得 (今日の打刻を JST で引く) / 表示 (未登録カード) / 購読での引き直し /
// unmount での購読停止 / reload・highlight の公開 を見る。

const listTimePunchesMock = vi.fn(async () => ({ punches: [] as any[] }))
const getEmployeesMock = vi.fn(async () => [] as any[])

vi.mock('~/utils/api', () => ({
  listTimePunches: (...args: any[]) => listTimePunchesMock(...args),
  getEmployees: (...args: any[]) => getEmployeesMock(...args),
}))

mockNuxtImport('useAuth', () => () => ({
  accessToken: ref(null),
}))

const deviceJwtReady = ref(false)
mockNuxtImport('useDeviceToken', () => () => ({
  getDeviceJwt: vi.fn(() => null),
  hasDeviceJwt: deviceJwtReady,
}))

/** onMounted の await 群と watch の後段を流し切る */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

let watchOnChange: (() => void) | null = null
const watchConnectMock = vi.fn(async () => {})
const watchStopMock = vi.fn()
mockNuxtImport('useTimecardWatch', () => (options: { onChange: () => void }) => {
  watchOnChange = options.onChange
  return {
    isConnected: ref(false),
    connect: watchConnectMock,
    stop: watchStopMock,
  }
})

describe('TodayPunchHistory — 今日の打刻の取得と表示', () => {
  beforeEach(() => {
    listTimePunchesMock.mockClear()
    getEmployeesMock.mockClear()
    watchConnectMock.mockClear()
    watchStopMock.mockClear()
    watchOnChange = null
  })

  it('本日の打刻を JST の今日で引く (date_from が渡る)', async () => {
    const wrapper = await mountSuspended(TodayPunchHistory)
    expect(listTimePunchesMock).toHaveBeenCalledWith(
      expect.objectContaining({ date_from: expect.any(String), per_page: 200 }),
    )
    wrapper.unmount()
  })

  it('取得成功で 0 件なら「本日の打刻はまだありません」を出す', async () => {
    const wrapper = await mountSuspended(TodayPunchHistory)
    await flush()
    expect(wrapper.text()).toContain('本日の打刻はまだありません')
    wrapper.unmount()
  })

  it('取得が完了するまでは「読み込み中…」を出す (「まだありません」ではない)', async () => {
    let resolvePunches: ((v: { punches: any[] }) => void) | undefined
    listTimePunchesMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePunches = resolve }))
    const wrapper = await mountSuspended(TodayPunchHistory)
    await flush()
    expect(wrapper.text()).toContain('読み込み中…')
    expect(wrapper.text()).not.toContain('本日の打刻はまだありません')

    // 取得が完了すれば「まだありません」に切り替わる
    resolvePunches!({ punches: [] })
    await flush()
    expect(wrapper.text()).toContain('本日の打刻はまだありません')
    wrapper.unmount()
  })

  it('取得に失敗したら「打刻履歴を読み込めませんでした」を出す (「まだありません」でも「読み込み中…」のままでもない、Refs #238)', async () => {
    listTimePunchesMock.mockRejectedValueOnce(new Error('network error'))
    const wrapper = await mountSuspended(TodayPunchHistory)
    await flush()
    expect(wrapper.text()).toContain('打刻履歴を読み込めませんでした')
    expect(wrapper.text()).not.toContain('本日の打刻はまだありません')
    expect(wrapper.text()).not.toContain('読み込み中…')
    wrapper.unmount()
  })

  it('社員解決できたタップは社員名を、未解決の未登録カードは「未登録カード <id>」を出す', async () => {
    getEmployeesMock.mockResolvedValueOnce([{ id: 'emp-1', name: '山田太郎' }] as any)
    listTimePunchesMock.mockResolvedValueOnce({
      punches: [
        { id: 'p1', employee_id: 'emp-1', employee_name: null, card_id: null, punched_at: '2026-09-11T00:00:00Z' },
        { id: 'p2', employee_id: null, employee_name: null, card_id: 'card-xyz', punched_at: '2026-09-11T00:01:00Z' },
      ],
    })
    const wrapper = await mountSuspended(TodayPunchHistory)
    // mountSuspended は onMounted 内の await 群の完了までは待たない (Suspense は
    // setup() の非同期のみを見る) ので、DOM への反映を明示的に待つ
    await flush()
    expect(wrapper.text()).toContain('山田太郎')
    expect(wrapper.text()).toContain('未登録カード card-xyz')
    wrapper.unmount()
  })

  it('購読の onChange が呼ばれたら一覧を引き直す', async () => {
    const wrapper = await mountSuspended(TodayPunchHistory)
    listTimePunchesMock.mockClear()
    expect(watchOnChange).toBeTruthy()
    watchOnChange!()
    await Promise.resolve()
    expect(listTimePunchesMock).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('unmount で購読を止める', async () => {
    const wrapper = await mountSuspended(TodayPunchHistory)
    expect(watchStopMock).not.toHaveBeenCalled()
    wrapper.unmount()
    expect(watchStopMock).toHaveBeenCalled()
  })
})

describe('TodayPunchHistory — reload / highlight の公開 (親から呼ぶ)', () => {
  beforeEach(() => {
    listTimePunchesMock.mockClear()
    getEmployeesMock.mockClear()
  })

  it('reload() で引き直し、先頭行 (直近の打刻) をハイライトする', async () => {
    listTimePunchesMock.mockResolvedValueOnce({ punches: [] })
    const wrapper = await mountSuspended(TodayPunchHistory)

    listTimePunchesMock.mockResolvedValueOnce({
      punches: [
        { id: 'new-1', employee_id: null, employee_name: '鈴木花子', card_id: null, punched_at: '2026-09-11T01:00:00Z' },
      ],
    })
    await (wrapper.vm as any).reload()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('鈴木花子')
    expect(wrapper.find('.bg-green-100').exists()).toBe(true)
    wrapper.unmount()
  })

  it('highlight(null) で強調を消せる', async () => {
    listTimePunchesMock.mockResolvedValueOnce({
      punches: [
        { id: 'p1', employee_id: null, employee_name: '佐藤一郎', card_id: null, punched_at: '2026-09-11T01:00:00Z' },
      ],
    })
    const wrapper = await mountSuspended(TodayPunchHistory)
    ;(wrapper.vm as any).highlight('p1')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bg-green-100').exists()).toBe(true)

    ;(wrapper.vm as any).highlight(null)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bg-green-100').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('TodayPunchHistory — 端末 JWT が取れたら一覧を引き直す (Refs #238)', () => {
  beforeEach(() => {
    deviceJwtReady.value = false
    getEmployeesMock.mockClear()
    listTimePunchesMock.mockClear()
  })

  it('hasDeviceJwt が true になったら employees と本日の打刻を引き直す', async () => {
    const wrapper = await mountSuspended(TodayPunchHistory)
    await flush()
    expect(getEmployeesMock).toHaveBeenCalledTimes(1)
    expect(listTimePunchesMock).toHaveBeenCalledTimes(1)

    deviceJwtReady.value = true
    await flush()
    expect(getEmployeesMock).toHaveBeenCalledTimes(2)
    expect(listTimePunchesMock).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('JWT が無くて最初の取得が失敗しても、hasDeviceJwt が true になったら取り直して表示する (index.vue に置いたときの再現、Refs #238)', async () => {
    listTimePunchesMock.mockRejectedValueOnce(new Error('unauthorized'))
    const wrapper = await mountSuspended(TodayPunchHistory)
    await flush()
    // JWT 無しの最初の取得は失敗 → 「まだありません」ではなく「読み込めませんでした」
    expect(wrapper.text()).toContain('打刻履歴を読み込めませんでした')
    expect(wrapper.text()).not.toContain('本日の打刻はまだありません')

    listTimePunchesMock.mockResolvedValueOnce({
      punches: [
        { id: 'p1', employee_id: null, employee_name: '田中次郎', card_id: null, punched_at: '2026-09-11T02:00:00Z' },
      ],
    })
    deviceJwtReady.value = true
    await flush()
    expect(wrapper.text()).toContain('田中次郎')
    expect(wrapper.text()).not.toContain('読み込み中…')
    expect(wrapper.text()).not.toContain('読み込めませんでした')
    wrapper.unmount()
  })

  it('hasDeviceJwt が false に戻っても (抜線でキャッシュ破棄) 引き直さない', async () => {
    deviceJwtReady.value = true
    const wrapper = await mountSuspended(TodayPunchHistory)
    await flush()
    getEmployeesMock.mockClear()
    listTimePunchesMock.mockClear()

    deviceJwtReady.value = false
    await flush()
    expect(getEmployeesMock).not.toHaveBeenCalled()
    expect(listTimePunchesMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
