import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoManagerJudgmentPanel from '~/components/TenkoManagerJudgmentPanel.vue'

// 運行管理者が点呼の OK/NG を判定して記録する画面 (Refs ippoan/alc-app#315)。
// safety_judgment (サーバの自動判定) とは別物 — 混ぜないこと。

const submitManagerJudgmentMock = vi.fn(async (_id: string, data: any) => ({
  ...SESSION_UNJUDGED,
  manager_judgment: data.judgment,
  manager_judgment_reason: data.reason ?? null,
  manager_judgment_by: data.judged_by_employee_id,
}))

const getInPersonScopeMock = vi.fn(async (..._args: any[]): Promise<any> => ({
  scope: 'unknown', vehicle_number: null, vehicle_offices: [], judge_offices: [],
}))

vi.mock('~/utils/api', () => ({
  submitManagerJudgment: (...args: any[]) => submitManagerJudgmentMock(...args),
  getInPersonScope: (...args: any[]) => getInPersonScopeMock(...args),
}))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const MANAGER_ID = 'bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb'
const SESSION_ID = 'aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa'

const SESSION_UNJUDGED = {
  id: SESSION_ID, tenant_id: 't-1', employee_id: 'emp-1', status: 'completed',
  manager_judgment: null, manager_judgment_reason: null, manager_judgment_by: null,
} as any

async function mountPanel(session: any = SESSION_UNJUDGED, managerId: string | null = MANAGER_ID) {
  const wrapper = await mountSuspended(TenkoManagerJudgmentPanel, {
    props: { session, managerId },
  })
  await flush()
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('TenkoManagerJudgmentPanel — OK/NG 判定', () => {
  beforeEach(() => {
    submitManagerJudgmentMock.mockClear()
  })

  it('OK を押すと judgment: "ok" で submitManagerJudgment が呼ばれる', async () => {
    const wrapper = await mountPanel()
    const okButton = wrapper.findAll('button').find(b => b.text() === 'OK')
    await okButton!.trigger('click')
    await flush()
    expect(submitManagerJudgmentMock).toHaveBeenCalledTimes(1)
    expect(submitManagerJudgmentMock.mock.calls[0][0]).toBe(SESSION_ID)
    expect(submitManagerJudgmentMock.mock.calls[0][1]).toMatchObject({ judgment: 'ok' })
    wrapper.unmount()
  })

  it('★ prop scope を渡さなければ、遠隔点呼モニターの口として送る (scope \'tenko-monitor\'。Refs ippoan/alc-app#387)', async () => {
    const wrapper = await mountPanel()
    const okButton = wrapper.findAll('button').find(b => b.text() === 'OK')
    await okButton!.trigger('click')
    await flush()
    expect(submitManagerJudgmentMock.mock.calls[0][2]).toBe('tenko-monitor')
    wrapper.unmount()
  })

  it('★ scope="manager-device" を渡すと、その口で送る (IT点呼 の受け画面)', async () => {
    const wrapper = await mountSuspended(TenkoManagerJudgmentPanel, {
      props: { session: SESSION_UNJUDGED, managerId: MANAGER_ID, scope: 'manager-device' },
    })
    await flush()
    const okButton = wrapper.findAll('button').find(b => b.text() === 'OK')
    await okButton!.trigger('click')
    await flush()
    expect(submitManagerJudgmentMock).toHaveBeenCalledTimes(1)
    expect(submitManagerJudgmentMock.mock.calls[0][2]).toBe('manager-device')
    wrapper.unmount()
  })

  it('NG を押すと理由の自由記入欄が出る (即座には送信しない)', async () => {
    const wrapper = await mountPanel()
    const ngButton = wrapper.findAll('button').find(b => b.text() === 'NG')
    await ngButton!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('textarea').exists()).toBe(true)
    expect(submitManagerJudgmentMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('NG で理由を入れて送ると judgment: "ng" + reason で呼ばれる', async () => {
    const wrapper = await mountPanel()
    const ngButton = wrapper.findAll('button').find(b => b.text() === 'NG')
    await ngButton!.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.find('textarea').setValue('体調不良の申告あり')
    const confirmButton = wrapper.findAll('button').find(b => b.text().includes('NG として記録する'))
    await confirmButton!.trigger('click')
    await flush()
    expect(submitManagerJudgmentMock).toHaveBeenCalledTimes(1)
    expect(submitManagerJudgmentMock.mock.calls[0][1]).toMatchObject({ judgment: 'ng', reason: '体調不良の申告あり' })
    wrapper.unmount()
  })

  it('NG で理由が空でも送信できる (任意入力なので reason を省く)', async () => {
    const wrapper = await mountPanel()
    const ngButton = wrapper.findAll('button').find(b => b.text() === 'NG')
    await ngButton!.trigger('click')
    await wrapper.vm.$nextTick()
    const confirmButton = wrapper.findAll('button').find(b => b.text().includes('NG として記録する'))
    await confirmButton!.trigger('click')
    await flush()
    expect(submitManagerJudgmentMock).toHaveBeenCalledTimes(1)
    const body = submitManagerJudgmentMock.mock.calls[0][1]
    expect(body.judgment).toBe('ng')
    expect(body.reason).toBeUndefined()
    wrapper.unmount()
  })

  it('judged_by_employee_id が body に入っている', async () => {
    const wrapper = await mountPanel()
    const okButton = wrapper.findAll('button').find(b => b.text() === 'OK')
    await okButton!.trigger('click')
    await flush()
    expect(submitManagerJudgmentMock.mock.calls[0][1]).toMatchObject({ judged_by_employee_id: MANAGER_ID })
    wrapper.unmount()
  })

  it('判定済みのセッションでは結果 (値 + 理由) を表示する', async () => {
    const judged = { ...SESSION_UNJUDGED, manager_judgment: 'ng', manager_judgment_reason: '体調不良' }
    const wrapper = await mountPanel(judged)
    expect(wrapper.text()).toContain('NG')
    expect(wrapper.text()).toContain('体調不良')
    wrapper.unmount()
  })

  // 押し間違いは実運用で起きるので、判定済みでも押し直せる (確認ダイアログ無し。親の判断)
  it('判定済みのセッションでも OK/NG ボタンで押し直せる (再判定)', async () => {
    const judged = { ...SESSION_UNJUDGED, manager_judgment: 'ok', manager_judgment_reason: null }
    const wrapper = await mountPanel(judged)
    const ngButton = wrapper.findAll('button').find(b => b.text() === 'NG')
    expect(ngButton).toBeTruthy()
    await ngButton!.trigger('click')
    await wrapper.vm.$nextTick()
    const confirmButton = wrapper.findAll('button').find(b => b.text().includes('NG として記録する'))
    await confirmButton!.trigger('click')
    await flush()
    expect(submitManagerJudgmentMock).toHaveBeenCalledTimes(1)
    expect(submitManagerJudgmentMock.mock.calls[0][1]).toMatchObject({ judgment: 'ng' })
    wrapper.unmount()
  })

  it('管理者 ID が無い場合は送信せずエラーを表示する', async () => {
    const wrapper = await mountPanel(SESSION_UNJUDGED, null)
    const okButton = wrapper.findAll('button').find(b => b.text() === 'OK')
    await okButton!.trigger('click')
    await flush()
    expect(submitManagerJudgmentMock).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('運行管理者が特定できていません')
    wrapper.unmount()
  })

  it('エラー時 (403 等) に画面が壊れず、利用者にエラーが伝わる', async () => {
    submitManagerJudgmentMock.mockRejectedValueOnce(new Error('API エラー (403)'))
    const wrapper = await mountPanel()
    const okButton = wrapper.findAll('button').find(b => b.text() === 'OK')
    await okButton!.trigger('click')
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('判定の送信に失敗しました')
    // 壊れていなければ引き続き操作できる
    expect(wrapper.findAll('button').find(b => b.text() === 'OK')).toBeTruthy()
    wrapper.unmount()
  })
})

// IT点呼 の「確認の方法」(Refs ippoan/alc-app#387)。**`defaultMethod` を渡さない遠隔点呼モニターは、
// 画面も送信 body も今までと同一**であることをここで固定する (上の既存のテストは書き換えていない)。
// 判定を保存できた点呼の部屋だけを、着信 (警告デバイスの call=1) から外す (Refs ippoan/alc-app#387)
describe('TenkoManagerJudgmentPanel — 判定を保存できた部屋は着信から外す', () => {
  const rooms = () => useState<string[]>('active-rooms')
  const handled = () => useState<string[]>('active-rooms-handled')
  const calling = () => useActiveRooms().callingRooms.value

  beforeEach(() => {
    submitManagerJudgmentMock.mockClear()
    rooms().value = []
    handled().value = []
    useState<string | null>('active-rooms-joined').value = null
  })

  async function pressOk(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
    await wrapper.findAll('button').find(b => b.text() === 'OK')!.trigger('click')
    await flush()
  }

  it.each([
    ['遠隔点呼 (部屋の id = 記録の id)', SESSION_ID],
    ['IT点呼 (部屋の id = it-<記録の id>)', `it-${SESSION_ID}`],
  ])('★ %s: 保存に成功したら、その部屋は残っていても着信に数えない', async (_label, roomId) => {
    rooms().value = [roomId, 'other-room']
    const wrapper = await mountPanel()
    expect(calling()).toEqual([roomId, 'other-room'])

    await pressOk(wrapper)

    expect(handled().value).toEqual([roomId])
    // 別の部屋は待っているので数える
    expect(calling()).toEqual(['other-room'])
    wrapper.unmount()
  })

  it('NG の判定でも同じ (判定が付けば対応を終えた)', async () => {
    rooms().value = [SESSION_ID]
    const wrapper = await mountPanel()
    await wrapper.findAll('button').find(b => b.text() === 'NG')!.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.findAll('button').find(b => b.text().includes('NG として記録する'))!.trigger('click')
    await flush()

    expect(submitManagerJudgmentMock.mock.calls[0][1]).toMatchObject({ judgment: 'ng' })
    expect(calling()).toEqual([])
    wrapper.unmount()
  })

  it('★ 保存に失敗したら、対応を終えたことにしない (鳴り続ける)', async () => {
    rooms().value = [`it-${SESSION_ID}`]
    submitManagerJudgmentMock.mockRejectedValueOnce(new Error('403'))
    const wrapper = await mountPanel()

    await pressOk(wrapper)

    expect(wrapper.text()).toContain('判定の送信に失敗しました')
    expect(handled().value).toEqual([])
    expect(calling()).toEqual([`it-${SESSION_ID}`])
    wrapper.unmount()
  })

  it('運行管理者が特定できず送信しなかったときも、対応を終えたことにしない', async () => {
    rooms().value = [SESSION_ID]
    const wrapper = await mountPanel(SESSION_UNJUDGED, null)

    await pressOk(wrapper)

    expect(submitManagerJudgmentMock).not.toHaveBeenCalled()
    expect(calling()).toEqual([SESSION_ID])
    wrapper.unmount()
  })

  it('★ 回帰: その点呼の部屋が一覧に無ければ (通話なしで確定・相手は既に閉じた) 何も印にしない', async () => {
    rooms().value = ['other-room']
    const wrapper = await mountPanel()

    await pressOk(wrapper)

    expect(handled().value).toEqual([])
    expect(calling()).toEqual(['other-room'])
    wrapper.unmount()
  })
})

describe('TenkoManagerJudgmentPanel — 確認の方法 (defaultMethod)', () => {
  beforeEach(() => {
    submitManagerJudgmentMock.mockClear()
  })

  async function mountWithMethod(defaultMethod: 'it' | 'in_person' | undefined, session: any = SESSION_UNJUDGED) {
    const wrapper = await mountSuspended(TenkoManagerJudgmentPanel, {
      props: { session, managerId: MANAGER_ID, defaultMethod },
    })
    await flush()
    await wrapper.vm.$nextTick()
    return wrapper
  }

  async function clickOk(wrapper: Awaited<ReturnType<typeof mountWithMethod>>) {
    await wrapper.findAll('button').find(b => b.text() === 'OK')!.trigger('click')
    await flush()
  }

  const checkedMethod = (wrapper: Awaited<ReturnType<typeof mountWithMethod>>) =>
    wrapper.findAll<HTMLInputElement>('input[type="radio"]').find(r => r.element.checked)?.element.value

  it('★ prop なし: 確認の方法の欄が無く、body は今までと同じ key だけ (method の key が無い)', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="judgment-method"]').exists()).toBe(false)
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('確認の方法')
    await clickOk(wrapper)
    const body = submitManagerJudgmentMock.mock.calls[0][1]
    expect(body).toEqual({ judgment: 'ok', judged_by_employee_id: MANAGER_ID })
    expect('method' in body).toBe(false)
    wrapper.unmount()
  })

  it('★ prop なし: 記録に manager_judgment_method が付いていても欄を出さず、method を送らない', async () => {
    const wrapper = await mountPanel({ ...SESSION_UNJUDGED, manager_judgment_method: 'it' })
    expect(wrapper.find('[data-testid="judgment-method"]').exists()).toBe(false)
    await clickOk(wrapper)
    expect('method' in submitManagerJudgmentMock.mock.calls[0][1]).toBe(false)
    wrapper.unmount()
  })

  it('prop あり: 欄が出て、初期値は prop。OK で method が body に載る', async () => {
    const wrapper = await mountWithMethod('it')
    expect(wrapper.find('[data-testid="judgment-method"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('IT点呼 (通話で確認)')
    expect(wrapper.text()).toContain('対面で確認')
    expect(checkedMethod(wrapper)).toBe('it')
    await clickOk(wrapper)
    expect(submitManagerJudgmentMock.mock.calls[0][1]).toEqual({
      judgment: 'ok', judged_by_employee_id: MANAGER_ID, method: 'it',
    })
    wrapper.unmount()
  })

  it('prop あり (対面): 初期値は対面', async () => {
    const wrapper = await mountWithMethod('in_person')
    expect(checkedMethod(wrapper)).toBe('in_person')
    wrapper.unmount()
  })

  it('切り替えた値が body に載る (NG でも同じ)', async () => {
    const wrapper = await mountWithMethod('it')
    await wrapper.find('input[type="radio"][value="in_person"]').setValue(true)
    await wrapper.findAll('button').find(b => b.text() === 'NG')!.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.findAll('button').find(b => b.text().includes('NG として記録する'))!.trigger('click')
    await flush()
    expect(submitManagerJudgmentMock.mock.calls[0][1]).toEqual({
      judgment: 'ng', judged_by_employee_id: MANAGER_ID, method: 'in_person',
    })
    wrapper.unmount()
  })

  it('記録に既に確認の方法が付いていれば、prop よりそちらが初期値', async () => {
    const wrapper = await mountWithMethod('it', { ...SESSION_UNJUDGED, manager_judgment: 'ok', manager_judgment_method: 'in_person' })
    expect(checkedMethod(wrapper)).toBe('in_person')
    wrapper.unmount()
  })

  it('記録の確認の方法が null なら prop が初期値', async () => {
    const wrapper = await mountWithMethod('in_person', { ...SESSION_UNJUDGED, manager_judgment_method: null })
    expect(checkedMethod(wrapper)).toBe('in_person')
    wrapper.unmount()
  })
})

// 席の警告デバイスの更新を始めてよいかの材料 (Refs ippoan/alc-app#425)。リロードの申告とは別の集合
describe('TenkoManagerJudgmentPanel — 「機体を使用中」の申告', () => {
  it('★ NG 理由の入力中は申告し、キャンセルで下ろす。unmount でも下りる', async () => {
    const wrapper = await mountPanel()
    const { isDeviceBusy } = useKioskScreen()
    expect(isDeviceBusy.value).toBe(false)

    await wrapper.findAll('button').find(b => b.text() === 'NG')!.trigger('click')
    expect(isDeviceBusy.value).toBe(true)
    await wrapper.findAll('button').find(b => b.text() === 'キャンセル')!.trigger('click')
    expect(isDeviceBusy.value).toBe(false)

    await wrapper.findAll('button').find(b => b.text() === 'NG')!.trigger('click')
    expect(isDeviceBusy.value).toBe(true)
    wrapper.unmount()
    expect(isDeviceBusy.value).toBe(false)
  })

  it('送信中も申告し、送り終えたら下ろす', async () => {
    let finish!: (value: unknown) => void
    submitManagerJudgmentMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }) as never)
    const wrapper = await mountPanel()
    const { isDeviceBusy } = useKioskScreen()

    await wrapper.findAll('button').find(b => b.text() === 'OK')!.trigger('click')
    expect(isDeviceBusy.value).toBe(true)
    finish({ ...SESSION_UNJUDGED, manager_judgment: 'ok' })
    await flush()
    expect(isDeviceBusy.value).toBe(false)
    wrapper.unmount()
  })
})

describe('TenkoManagerJudgmentPanel — 遠隔点呼は乗務員の確定を待つ (waitForDriver)', () => {
  beforeEach(() => {
    submitManagerJudgmentMock.mockClear()
  })

  async function mountWaiting(status: string) {
    const wrapper = await mountSuspended(TenkoManagerJudgmentPanel, {
      props: { session: { ...SESSION_UNJUDGED, status } as any, managerId: MANAGER_ID, waitForDriver: true },
    })
    await flush()
    return wrapper
  }
  const okButton = (w: Awaited<ReturnType<typeof mountWaiting>>) => w.findAll('button').find(b => b.text() === 'OK')!
  const ngButton = (w: Awaited<ReturnType<typeof mountWaiting>>) => w.findAll('button').find(b => b.text() === 'NG')!

  it('★ 乗務員が最後の確定をするまで (instruction_pending) OK/NG を押させない', async () => {
    const wrapper = await mountWaiting('instruction_pending')
    expect(wrapper.find('[data-testid="waiting-for-driver"]').exists()).toBe(true)
    expect(okButton(wrapper).attributes('disabled')).toBeDefined()
    expect(ngButton(wrapper).attributes('disabled')).toBeDefined()
    await okButton(wrapper).trigger('click')
    await flush()
    expect(submitManagerJudgmentMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it.each(['judgment_pending', 'completed'])('%s なら判定できる', async (status) => {
    const wrapper = await mountWaiting(status)
    expect(wrapper.find('[data-testid="waiting-for-driver"]').exists()).toBe(false)
    expect(okButton(wrapper).attributes('disabled')).toBeUndefined()
    await okButton(wrapper).trigger('click')
    await flush()
    expect(submitManagerJudgmentMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('渡さなければ今までどおり、どの状態でも判定できる', async () => {
    const wrapper = await mountSuspended(TenkoManagerJudgmentPanel, {
      props: { session: { ...SESSION_UNJUDGED, status: 'instruction_pending' } as any, managerId: MANAGER_ID },
    })
    expect(wrapper.find('[data-testid="waiting-for-driver"]').exists()).toBe(false)
    expect(okButton(wrapper).attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})


describe('TenkoManagerJudgmentPanel — 代替措置', () => {
  beforeEach(() => {
    submitManagerJudgmentMock.mockClear()
  })

  it('NG のとき代替措置の内容が alternative_measure で送られる', async () => {
    const wrapper = await mountPanel()
    await wrapper.findAll('button').find(b => b.text() === 'NG')!.trigger('click')
    await wrapper.find('[data-testid="judgment-alternative"]').setValue(' 別の乗務員に交代 ')
    await wrapper.findAll('button').find(b => b.text().includes('NG として記録'))!.trigger('click')
    await flush()
    expect(submitManagerJudgmentMock.mock.calls[0][1]).toMatchObject({ judgment: 'ng', alternative_measure: '別の乗務員に交代' })
    wrapper.unmount()
  })

  it('NG で代替措置が空なら載せず、OK は入力があっても載せない', async () => {
    const wrapper = await mountPanel()
    await wrapper.findAll('button').find(b => b.text() === 'NG')!.trigger('click')
    await wrapper.findAll('button').find(b => b.text().includes('NG として記録'))!.trigger('click')
    await flush()
    expect(submitManagerJudgmentMock.mock.calls[0][1]).not.toHaveProperty('alternative_measure')

    await wrapper.findAll('button').find(b => b.text() === 'NG')!.trigger('click')
    await wrapper.find('[data-testid="judgment-alternative"]').setValue('x')
    await wrapper.findAll('button').find(b => b.text() === 'OK')!.trigger('click')
    await flush()
    expect(submitManagerJudgmentMock.mock.calls[1][1]).not.toHaveProperty('alternative_measure')
    wrapper.unmount()
  })

  it('取り消すと代替措置の入力も消え、記録済みの代替措置は判定の横に出る', async () => {
    const wrapper = await mountPanel({ ...SESSION_UNJUDGED, manager_judgment: 'ng', alternative_measure: '配車変更' })
    expect(wrapper.find('[data-testid="judgment-alternative-shown"]').text()).toContain('配車変更')
    await wrapper.findAll('button').find(b => b.text() === 'NG')!.trigger('click')
    await wrapper.find('[data-testid="judgment-alternative"]').setValue('y')
    await wrapper.findAll('button').find(b => b.text() === 'キャンセル')!.trigger('click')
    await wrapper.findAll('button').find(b => b.text() === 'NG')!.trigger('click')
    expect((wrapper.find('[data-testid="judgment-alternative"]').element as HTMLTextAreaElement).value).toBe('')
    wrapper.unmount()
  })
})

describe('TenkoManagerJudgmentPanel — 血圧の記録不足で対面点呼にした点呼の所属 (表示だけ)', () => {
  const SWITCHED = {
    ...SESSION_UNJUDGED, status: 'judgment_pending', schedule_id: 's-1', tenko_type: 'pre_operation',
    tenko_method: '通常点呼', remote_escalation_reason: '血圧の記録が 10 日分に満たない (いま 3 日分) ため対面点呼',
  }
  const scopeOf = () => wrapper_find('[data-testid="judgment-in-person-scope"]')
  let current: any
  const wrapper_find = (sel: string) => current.find(sel)
  beforeEach(() => {
    submitManagerJudgmentMock.mockClear()
    getInPersonScopeMock.mockClear()
  })

  it('同じ営業所なら対面点呼と出し、範囲を送らない (判定した人と運行管理者の口で照合を引く)', async () => {
    getInPersonScopeMock.mockResolvedValueOnce({
      scope: 'same_office', vehicle_number: '品川100あ1234',
      vehicle_offices: [{ id: 'o1', name: '本社営業所', company_name: null }],
      judge_offices: [{ id: 'o1', name: '本社営業所', company_name: null }],
    })
    current = await mountPanel(SWITCHED)
    expect(getInPersonScopeMock).toHaveBeenCalledWith(SESSION_ID, MANAGER_ID, 'tenko-monitor')
    expect(scopeOf().text()).toContain('同じ営業所の運行管理者 (対面点呼として記録します)')
    expect(current.find('[data-testid="judgment-in-person-scope-offices"]').text()).toContain('車両 品川100あ1234の営業所: 本社営業所')
    expect(scopeOf().find('input').exists()).toBe(false)
    await current.findAll('button').find((b: any) => b.text() === 'OK')!.trigger('click')
    await flush()
    expect(submitManagerJudgmentMock.mock.calls[0][1]).not.toHaveProperty('in_person_scope')
  })

  it('別の営業所・グループ企業なら遠隔点呼とみなすと出す (会社名を添える)', async () => {
    getInPersonScopeMock.mockResolvedValueOnce({
      scope: 'other_office', vehicle_number: null,
      vehicle_offices: [{ id: 'o1', name: '帯広営業所', company_name: null }],
      judge_offices: [{ id: 'o2', name: '本社', company_name: 'グループ運輸' }],
    })
    current = await mountPanel(SWITCHED)
    expect(scopeOf().text()).toContain('遠隔点呼とみなして記録します')
    expect(current.find('[data-testid="judgment-in-person-scope-offices"]').text()).toContain('運行管理者の所属: グループ運輸 本社')
  })

  it('所属が未設定なら警告を出す', async () => {
    current = await mountPanel(SWITCHED)
    expect(current.find('[data-testid="judgment-in-person-scope-result"]').text()).toContain('所属営業所が未設定')
    expect(current.find('[data-testid="judgment-in-person-scope-offices"]').text()).toContain('車両の営業所: 未設定')
  })

  it('照合を引けなければその旨を出す。運行管理者が分からなければ引かない', async () => {
    getInPersonScopeMock.mockRejectedValueOnce(new Error('x'))
    current = await mountPanel(SWITCHED)
    expect(current.find('[data-testid="judgment-in-person-scope-error"]').exists()).toBe(true)
    getInPersonScopeMock.mockClear()
    current = await mountPanel(SWITCHED, null)
    expect(getInPersonScopeMock).not.toHaveBeenCalled()
    expect(scopeOf().text()).toContain('所属営業所を確かめています')
  })

  it('切り替えた点呼でなければ出さず、照合も引かない', async () => {
    current = await mountPanel({ ...SWITCHED, remote_escalation_reason: '血圧計の故障' })
    expect(scopeOf().exists()).toBe(false)
    expect(getInPersonScopeMock).not.toHaveBeenCalled()
  })
})
