import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TenkoSessionMonitor from '~/components/TenkoSessionMonitor.vue'

// 「点呼記録」タブを廃止し、CSV 出力をここへ移植する (Refs #238, ippoan/alc-app-s3#135)
// 行クリックで開くセッション詳細 1 枚の中に動画・顔写真も表示する (Refs #238, #259, ippoan/alc-app-s3#135)

const listTenkoSessionsMock = vi.fn(async () => ({ sessions: [] as any[], total: 0, page: 1, per_page: 20 }))
const getEmployeesMock = vi.fn(async () => [] as any[])
const downloadTenkoRecordsCsvMock = vi.fn(async () => {})
const getMeasurementMock = vi.fn(async (_id: string) => ({}) as any)
const interruptTenkoSessionMock = vi.fn(async () => ({}) as any)
const resumeTenkoSessionMock = vi.fn(async () => ({}) as any)
const cancelTenkoSessionMock = vi.fn(async () => ({}) as any)

vi.mock('~/utils/api', () => ({
  listTenkoSessions: (...args: any[]) => listTenkoSessionsMock(...args),
  getEmployees: (...args: any[]) => getEmployeesMock(...args),
  downloadTenkoRecordsCsv: (...args: any[]) => downloadTenkoRecordsCsvMock(...args),
  getMeasurement: (...args: any[]) => getMeasurementMock(...args),
  interruptTenkoSession: (...args: any[]) => interruptTenkoSessionMock(...args),
  resumeTenkoSession: (...args: any[]) => resumeTenkoSessionMock(...args),
  cancelTenkoSession: (...args: any[]) => cancelTenkoSessionMock(...args),
}))

// ログイン中の利用者 (実物の useAuth().user は readonly なのでテストでは差し替える)
const authUser = ref<{ name: string } | null>(null)
mockNuxtImport('useAuth', () => () => ({ user: authUser }))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const SESSION_NORMAL = {
  id: 's-1', tenant_id: 't-1', employee_id: 'emp-1', tenko_type: 'normal', status: 'completed',
  responsible_manager_name: null, started_at: '2026-09-12T00:00:00Z', created_at: '2026-09-12T00:00:00Z',
  completed_at: '2026-09-12T00:05:00Z', measurement_id: null,
}

const SESSION_WITH_MEASUREMENT = {
  ...SESSION_NORMAL, id: 's-2', measurement_id: 'm-1',
}

async function mountMonitor() {
  const wrapper = await mountSuspended(TenkoSessionMonitor, {
    global: { stubs: { MeasurementFacePhoto: true, MeasurementVideo: true } },
  })
  await flush()
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('TenkoSessionMonitor — 点呼記録タブ統合後の CSV 出力と種別表示', () => {
  beforeEach(() => {
    listTenkoSessionsMock.mockClear()
    listTenkoSessionsMock.mockResolvedValue({ sessions: [SESSION_NORMAL], total: 1, page: 1, per_page: 20 })
    getEmployeesMock.mockClear()
    getEmployeesMock.mockResolvedValue([])
    downloadTenkoRecordsCsvMock.mockClear()
  })

  it('CSV 出力ボタンを押すと、今の絞り込みの値で downloadTenkoRecordsCsv を呼ぶ', async () => {
    const wrapper = await mountMonitor()
    const dateFromInput = wrapper.find('input[type="date"]')
    await dateFromInput.setValue('2026-09-01')
    const csvButton = wrapper.findAll('button').find(b => b.text().includes('CSV出力'))
    expect(csvButton).toBeTruthy()
    await csvButton!.trigger('click')
    await flush()
    expect(downloadTenkoRecordsCsvMock).toHaveBeenCalledTimes(1)
    expect(downloadTenkoRecordsCsvMock.mock.calls[0][0]).toMatchObject({ date_from: '2026-09-01' })
    wrapper.unmount()
  })

  it('種別 normal の行は「通常」と灰色バッジで出る', async () => {
    const wrapper = await mountMonitor()
    const row = wrapper.find('tbody > tr')
    expect(row.text()).toContain('通常')
    const badge = row.findAll('span').find(s => s.text() === '通常')
    expect(badge).toBeTruthy()
    expect(badge!.classes()).toContain('bg-gray-100')
    expect(badge!.classes()).toContain('text-gray-700')
    wrapper.unmount()
  })
})

describe('TenkoSessionMonitor — 行クリックのセッション詳細に動画・顔写真を表示', () => {
  beforeEach(() => {
    listTenkoSessionsMock.mockClear()
    listTenkoSessionsMock.mockResolvedValue({ sessions: [SESSION_WITH_MEASUREMENT], total: 1, page: 1, per_page: 20 })
    getEmployeesMock.mockClear()
    getEmployeesMock.mockResolvedValue([])
    downloadTenkoRecordsCsvMock.mockClear()
    getMeasurementMock.mockClear()
    getMeasurementMock.mockResolvedValue({ id: 'm-1', employee_id: 'emp-1' } as any)
  })

  it('行クリックで getMeasurement(id) が呼ばれ、詳細内に MeasurementFacePhoto と MeasurementVideo が出る', async () => {
    const wrapper = await mountMonitor()

    await wrapper.find('tbody > tr').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(getMeasurementMock).toHaveBeenCalledWith('m-1', 'tenko-monitor')
    expect(wrapper.text()).toContain('セッション詳細')
    expect(wrapper.findComponent({ name: 'MeasurementFacePhoto' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'MeasurementVideo' }).exists()).toBe(true)
    wrapper.unmount()
  })

  it('measurement_id が null の行をクリックしても getMeasurement は呼ばれず、2 部品も出ない', async () => {
    listTenkoSessionsMock.mockResolvedValue({ sessions: [SESSION_NORMAL], total: 1, page: 1, per_page: 20 })
    const wrapper = await mountMonitor()

    await wrapper.find('tbody > tr').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(getMeasurementMock).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('セッション詳細')
    expect(wrapper.findComponent({ name: 'MeasurementFacePhoto' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'MeasurementVideo' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('getMeasurement が reject するとエラー文言が出て、種別・アルコールの欄は出たまま', async () => {
    getMeasurementMock.mockRejectedValue(new Error('network error'))
    const wrapper = await mountMonitor()

    await wrapper.find('tbody > tr').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('動画・写真を取得できませんでした')
    expect(wrapper.text()).toContain('通常')
    expect(wrapper.findComponent({ name: 'MeasurementFacePhoto' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('一覧の行に「測定詳細」ボタンが無い', async () => {
    const wrapper = await mountMonitor()
    const button = wrapper.findAll('button').find(b => b.text().includes('測定詳細'))
    expect(button).toBeFalsy()
    wrapper.unmount()
  })

  it('応答前にセッション詳細を閉じる → 後から resolve しても 2 部品は出ない', async () => {
    let resolveGetMeasurement!: (v: any) => void
    getMeasurementMock.mockImplementation(() => new Promise(resolve => { resolveGetMeasurement = resolve }))
    const wrapper = await mountMonitor()

    await wrapper.find('tbody > tr').trigger('click')
    await wrapper.vm.$nextTick()
    // 閉じる (背景クリック相当): × ボタン
    const closeButton = wrapper.findAll('button').find(b => b.text() === '×')
    await closeButton!.trigger('click')
    await wrapper.vm.$nextTick()

    resolveGetMeasurement({ id: 'm-1', employee_id: 'emp-1' })
    await flush()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('セッション詳細')
    expect(wrapper.findComponent({ name: 'MeasurementFacePhoto' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'MeasurementVideo' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('閉じて同じ行を開き直す → 1 本目の遅れた応答で 2 本目の loading が消えず、2 本目の結果が出る', async () => {
    const resolvers: Array<(v: any) => void> = []
    getMeasurementMock.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve) }))
    const wrapper = await mountMonitor()

    const row = wrapper.find('tbody > tr')
    await row.trigger('click')
    await wrapper.vm.$nextTick()
    const closeButton = wrapper.findAll('button').find(b => b.text() === '×')
    await closeButton!.trigger('click')
    await wrapper.vm.$nextTick()

    await row.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('動画・写真を読み込み中…')

    // 1 本目 (古い世代) が遅れて解決しても loading は消えず、部品も出ない
    resolvers[0]!({ id: 'm-1', employee_id: 'emp-1' })
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('動画・写真を読み込み中…')
    expect(wrapper.findComponent({ name: 'MeasurementFacePhoto' }).exists()).toBe(false)

    // 2 本目 (今の世代) が解決すると結果が出る
    resolvers[1]!({ id: 'm-1', employee_id: 'emp-1' })
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent({ name: 'MeasurementFacePhoto' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'MeasurementVideo' }).exists()).toBe(true)
    wrapper.unmount()
  })

  it('種別フィルタに「通常」がある', async () => {
    const wrapper = await mountMonitor()
    // 乗務員フィルタは <select> から EmployeeSearchSelect へ移したので、残る select は
    // ステータス (0) と種別 (1) の 2 つ (Refs #333)
    const options = wrapper.findAll('select')[1]!.findAll('option')
    expect(options.some(o => o.attributes('value') === 'normal' && o.text() === '通常')).toBe(true)
    wrapper.unmount()
  })

  it('体温・血圧の列: 値があれば整形して出る', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{ ...SESSION_WITH_MEASUREMENT, temperature: 36.7, systolic: 120, diastolic: 80 }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()
    const row = wrapper.find('tbody > tr')
    expect(row.text()).toContain('36.7 ℃')
    expect(row.text()).toContain('120/80')
    wrapper.unmount()
  })

  it('区分の列: IT点呼 を対面で確定した行は対面点呼、遠隔点呼はそのまま出る', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [
        { ...SESSION_NORMAL, id: 's-it', tenko_method: 'IT点呼', manager_judgment_method: 'in_person' },
        { ...SESSION_NORMAL, id: 's-remote', tenko_method: '遠隔点呼' },
      ],
      total: 2, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()
    const cells = wrapper.findAll('[data-testid="session-tenko-method"]')
    expect(cells.map(c => c.text())).toEqual(['対面点呼', '遠隔点呼'])
    wrapper.unmount()
  })

  it('体温・血圧の列: 値が null なら "-" になる', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{ ...SESSION_NORMAL, temperature: null, systolic: null, diastolic: null }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()
    const cells = wrapper.findAll('tbody > tr > td')
    expect(cells.map(c => c.text())).toContain('-')
    wrapper.unmount()
  })
})

// 車検の列・詳細 (Refs ippoan/alc-app-s3#110)
describe('TenkoSessionMonitor — 車検の一覧・詳細', () => {
  beforeEach(() => {
    listTenkoSessionsMock.mockClear()
    getEmployeesMock.mockClear()
    getEmployeesMock.mockResolvedValue([])
  })

  it('「車検」列のヘッダーがある', async () => {
    listTenkoSessionsMock.mockResolvedValue({ sessions: [SESSION_NORMAL], total: 1, page: 1, per_page: 20 })
    const wrapper = await mountMonitor()
    const headers = wrapper.findAll('th').map(h => h.text())
    expect(headers).toContain('車検')
    wrapper.unmount()
  })

  it('carins_matched_by が null なら列は "-" (番号を受け取っていない)', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{ ...SESSION_NORMAL, carins_cert_no: null, carins_vehicle_id: null, carins_expires_on: null, carins_matched_by: null }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()
    const row = wrapper.find('tbody > tr')
    const pill = row.findAll('span').find(s => s.text() === '未登録')
    expect(pill).toBeFalsy()
    expect(row.findAll('td').some(td => td.text() === '-')).toBe(true)
    wrapper.unmount()
  })

  it('matched_by="none" (carins に無い車) は灰 pill「未登録」', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{ ...SESSION_NORMAL, carins_cert_no: '000000000001', carins_vehicle_id: null, carins_expires_on: null, carins_matched_by: 'none' }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()
    const row = wrapper.find('tbody > tr')
    const pill = row.findAll('span').find(s => s.text() === '未登録')
    expect(pill).toBeTruthy()
    expect(pill!.classes()).toContain('bg-gray-100')
    wrapper.unmount()
  })

  it('期限切れは赤 pill「期限切れ」', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{ ...SESSION_NORMAL, carins_cert_no: '000000000001', carins_vehicle_id: 'TESTCARID00001', carins_expires_on: '2020-01-01', carins_matched_by: 'cert_no' }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()
    const row = wrapper.find('tbody > tr')
    const pill = row.findAll('span').find(s => s.text() === '期限切れ')
    expect(pill).toBeTruthy()
    expect(pill!.classes()).toContain('bg-red-100')
    wrapper.unmount()
  })

  it('詳細に管理番号・車両 ID・車検期限・照合を出す', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{
        ...SESSION_NORMAL,
        carins_cert_no: '000000000001',
        carins_vehicle_id: 'TESTCARID00001',
        carins_expires_on: '2030-12-31',
        carins_matched_by: 'cert_no',
      }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()

    await wrapper.find('tbody > tr').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('000000000001')
    expect(wrapper.text()).toContain('TESTCARID00001')
    expect(wrapper.text()).toContain('2030-12-31')
    expect(wrapper.text()).toContain('管理番号')
    wrapper.unmount()
  })

  it('carins の情報が無いセッションでは詳細に「車検証」ブロックが出ない', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{ ...SESSION_NORMAL, carins_cert_no: null, carins_vehicle_id: null, carins_expires_on: null, carins_matched_by: null }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()

    await wrapper.find('tbody > tr').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('車検証')
    wrapper.unmount()
  })
})

// 運行管理者席の PC (管理者ログインなし) から一覧の操作を送れるよう、一覧の取得と同じ 'tenko-monitor' で送る
describe('TenkoSessionMonitor — 取り消し・中断・再開は席の鍵 (tenko-monitor) で送る', () => {
  const RUNNING = { ...SESSION_NORMAL, id: 's-run', status: 'medical_pending' }
  const STOPPED = { ...SESSION_NORMAL, id: 's-stop', status: 'interrupted' }

  beforeEach(() => {
    listTenkoSessionsMock.mockClear()
    listTenkoSessionsMock.mockResolvedValue({ sessions: [RUNNING, STOPPED], total: 2, page: 1, per_page: 20 })
    getEmployeesMock.mockResolvedValue([])
    interruptTenkoSessionMock.mockClear()
    resumeTenkoSessionMock.mockClear()
    cancelTenkoSessionMock.mockClear()
  })

  const button = (row: any, label: string) => row.findAll('button').find((b: any) => b.text() === label)

  it('キャンセルの確定・中断・再開が tenko-monitor を渡す', async () => {
    const wrapper = await mountMonitor()
    const rows = () => wrapper.findAll('tbody > tr')

    await button(rows()[0], 'キャンセル').trigger('click')
    await button(rows()[0], '確定').trigger('click')
    await flush()
    expect(cancelTenkoSessionMock).toHaveBeenCalledWith('s-run', { reason: '' }, 'tenko-monitor')

    await button(rows()[0], '中断').trigger('click')
    await button(rows()[0], '中断').trigger('click')
    await flush()
    expect(interruptTenkoSessionMock).toHaveBeenCalledWith('s-run', { reason: undefined }, 'tenko-monitor')

    await button(rows()[1], '再開').trigger('click')
    await rows()[1].find('input[placeholder="再開理由"]').setValue('確認済み')
    await rows()[1].find('[data-testid="resume-by-name"]').setValue('鈴木一郎')
    await button(rows()[1], '再開').trigger('click')
    await flush()
    expect(resumeTenkoSessionMock).toHaveBeenCalledWith('s-stop', { reason: '確認済み', resumed_by_name: '鈴木一郎' }, 'tenko-monitor')
    wrapper.unmount()
  })

  it('一括キャンセルも tenko-monitor を渡す', async () => {
    const wrapper = await mountMonitor()
    await wrapper.find('thead input[type="checkbox"]').setValue(true)
    const bulk = wrapper.findAll('button').find(b => b.text().includes('一括キャンセル'))
    expect(bulk).toBeTruthy()
    await bulk!.trigger('click')
    await flush()
    expect(cancelTenkoSessionMock).toHaveBeenCalledWith('s-run', { reason: '' }, 'tenko-monitor')
    expect(cancelTenkoSessionMock).toHaveBeenCalledWith('s-stop', { reason: '' }, 'tenko-monitor')
    wrapper.unmount()
  })
})


// 自己点検表の不足を埋める: 再開した運行管理者の氏名 / 代替措置 / 車両番号 / 保存の注記
describe('TenkoSessionMonitor — 再開の氏名・代替措置・車両番号', () => {
  const INTERRUPTED = { ...SESSION_NORMAL, id: 's-int', status: 'interrupted', interrupted_at: '2026-09-12T00:01:00Z' }
  const ACTIVE = { ...SESSION_NORMAL, id: 's-act', status: 'alcohol_testing' }

  beforeEach(() => {
    listTenkoSessionsMock.mockReset()
    resumeTenkoSessionMock.mockClear()
    cancelTenkoSessionMock.mockClear()
    getEmployeesMock.mockResolvedValue([])
  })

  async function mountWith(sessions: any[]) {
    listTenkoSessionsMock.mockResolvedValue({ sessions, total: sessions.length, page: 1, per_page: 20 })
    return mountMonitor()
  }
  const btn = (w: any, text: string) => w.findAll('button').find((b: any) => b.text() === text)

  it('記録の画面に保存期間の注記が出る', async () => {
    const w = await mountWith([SESSION_NORMAL])
    expect(w.find('[data-testid="retention-note"]').text()).toBe('記録は 1 年間以上保存され、修正・削除できません。')
    w.unmount()
  })

  it('再開は氏名が空だと押せず、入力した氏名が resumed_by_name で送られる', async () => {
    const w = await mountWith([INTERRUPTED])
    await btn(w, '再開')!.trigger('click')
    const name = w.find('[data-testid="resume-by-name"]')
    expect((name.element as HTMLInputElement).value).toBe('')
    await w.find('input[placeholder="再開理由"]').setValue(' 復帰 ')
    expect(btn(w, '再開')!.attributes('disabled')).toBeDefined()
    await (w.vm as any).handleResume('s-int')
    expect(resumeTenkoSessionMock).not.toHaveBeenCalled()
    await name.setValue(' 鈴木一郎 ')
    await btn(w, '再開')!.trigger('click')
    await flush()
    expect(resumeTenkoSessionMock).toHaveBeenCalledWith('s-int', { reason: '復帰', resumed_by_name: '鈴木一郎' }, 'tenko-monitor')
    w.unmount()
  })

  it('ログイン中の利用者名が再開の氏名の初期値になる', async () => {
    authUser.value = { name: '田中花子' }
    const w = await mountWith([INTERRUPTED])
    await btn(w, '再開')!.trigger('click')
    expect((w.find('[data-testid="resume-by-name"]').element as HTMLInputElement).value).toBe('田中花子')
    authUser.value = null
    w.unmount()
  })

  it.each([['進行中', ACTIVE], ['中断中', INTERRUPTED]])('%sのキャンセルで代替措置が alternative_measure で送られる (空なら載せない)', async (_n, sess) => {
    const w = await mountWith([sess])
    await btn(w, 'キャンセル')!.trigger('click')
    await w.find('[data-testid="cancel-alternative"]').setValue(' 代わりの乗務員を手配 ')
    await btn(w, '確定')!.trigger('click')
    await flush()
    expect(cancelTenkoSessionMock).toHaveBeenLastCalledWith(sess.id, { reason: '', alternative_measure: '代わりの乗務員を手配' }, 'tenko-monitor')
    await btn(w, 'キャンセル')!.trigger('click')
    await btn(w, '確定')!.trigger('click')
    await flush()
    expect(cancelTenkoSessionMock).toHaveBeenLastCalledWith(sess.id, { reason: '' }, 'tenko-monitor')
    w.unmount()
  })

  it('詳細に車両番号 (取得元つき)・再開した運行管理者・代替措置が出る', async () => {
    const full = {
      ...INTERRUPTED, vehicle_number: '品川 100 あ 12-34', vehicle_number_source: 'carins',
      resumed_at: '2026-09-12T00:02:00Z', resume_reason: '復帰', resumed_by_name: '鈴木一郎', alternative_measure: '配車を変更',
    }
    const w = await mountWith([full])
    await w.find('tbody > tr').trigger('click')
    expect(w.find('[data-testid="detail-vehicle-number"]').text()).toContain('品川 100 あ 12-34')
    expect(w.find('[data-testid="detail-vehicle-number"]').text()).toContain('(車検証)')
    expect(w.find('[data-testid="detail-resumed-by"]').text()).toContain('鈴木一郎')
    expect(w.find('[data-testid="detail-alternative"]').text()).toContain('配車を変更')
    w.unmount()
  })

  it.each([['schedule', '(予定)'], ['manual', '(入力)'], [null, '']])('車両番号の取得元 %s の表示', async (src, label) => {
    const w = await mountWith([{ ...SESSION_NORMAL, vehicle_number: '1234', vehicle_number_source: src }])
    await w.find('tbody > tr').trigger('click')
    const t = w.find('[data-testid="detail-vehicle-number"]').text()
    expect(t).toContain('1234')
    if (label) expect(t).toContain(label); else expect(t).not.toContain('(')
    w.unmount()
  })

  it('車両番号が無ければ詳細に欄を出さない', async () => {
    const w = await mountWith([SESSION_NORMAL])
    await w.find('tbody > tr').trigger('click')
    expect(w.find('[data-testid="detail-vehicle-number"]').exists()).toBe(false)
    w.unmount()
  })
})
