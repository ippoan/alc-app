// 管理者の画面のタブ「血圧の通知」(Refs ippoan/alc-app#436)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { ApiBpNotifyEmployee, ApiBpNotifyLinkResult } from '~/utils/api'
import BpNotifyManager from '~/components/BpNotifyManager.vue'

const api = vi.hoisted(() => ({
  getBpNotifySettings: vi.fn(),
  updateBpNotifySetting: vi.fn(),
  getLineworksUsers: vi.fn(),
  linkBpNotifyByName: vi.fn(),
}))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

function emp(over: Partial<ApiBpNotifyEmployee> = {}): ApiBpNotifyEmployee {
  return {
    employee_id: 'e1', name: '試験 太郎', code: '001', role: ['driver'],
    lineworks_user_id: null, lineworks_name: null, email: null,
    notify_self: false, daily_report: false, ...over,
  }
}
const USERS = [
  { user_id: 'u1', name: '試験 太郎', email: 'taro@example.test' },
  { user_id: 'u2', name: '試験 花子', email: null },
]

async function mountIt(employees: ApiBpNotifyEmployee[] = [emp()]) {
  api.getBpNotifySettings.mockResolvedValue({ employees })
  const w = await mountSuspended(BpNotifyManager)
  await flushPromises()
  return w
}
const rows = (w: Awaited<ReturnType<typeof mountIt>>) => w.findAll('[data-testid="bp-notify-row"]')

beforeEach(() => {
  vi.clearAllMocks()
  api.getLineworksUsers.mockResolvedValue({ users: USERS })
})

describe('BpNotifyManager 一覧', () => {
  it('説明の一文と、氏名・コード・管理者の印を出す', async () => {
    const w = await mountIt([emp(), emp({ employee_id: 'e2', name: '試験 次郎', code: '002', role: ['manager'], email: 'j@example.test' })])
    expect(w.find('[data-testid="bp-notify-description"]').text()).toBe(
      '血圧を測ると、結び付けた LINE WORKS へ本人に結果が届きます。毎朝 7:00 に前日の記録の一覧が、日報を受け取る管理者へメールで届きます',
    )
    expect(rows(w)).toHaveLength(2)
    expect(rows(w)[0]!.text()).toContain('試験 太郎')
    expect(rows(w)[0]!.text()).toContain('001')
    expect(rows(w)[0]!.find('[data-testid="bp-notify-manager"]').exists()).toBe(false)
    expect(rows(w)[1]!.find('[data-testid="bp-notify-manager"]').exists()).toBe(true)
  })

  it('社員がいなければ空の文言、設定の取得に失敗したら理由を出す', async () => {
    const w = await mountIt([])
    expect(w.find('[data-testid="bp-notify-empty"]').exists()).toBe(true)
    api.getBpNotifySettings.mockRejectedValue(new Error('API エラー (403): forbidden'))
    const w2 = await mountSuspended(BpNotifyManager)
    await flushPromises()
    expect(w2.find('[data-testid="bp-notify-list-error"]').text()).toContain('403')
  })

  it('日報の列は管理者 (manager/admin) だけ操作でき、ほかは「-」。メールが無ければ disabled で理由を出す', async () => {
    const w = await mountIt([
      emp({ employee_id: 'a', role: ['driver'] }),
      emp({ employee_id: 'b', role: ['admin'], email: null }),
      emp({ employee_id: 'c', role: ['manager'], email: 'c@example.test' }),
    ])
    const [a, b, c] = rows(w)
    expect(a!.find('[data-testid="bp-notify-report-na"]').text()).toBe('-')
    expect(a!.find('[data-testid="bp-notify-report"]').exists()).toBe(false)
    expect((b!.find('[data-testid="bp-notify-report"]').element as HTMLInputElement).disabled).toBe(true)
    expect(b!.find('[data-testid="bp-notify-report-reason"]').text()).toContain('メールが未設定')
    expect((c!.find('[data-testid="bp-notify-report"]').element as HTMLInputElement).disabled).toBe(false)
    expect(c!.find('[data-testid="bp-notify-report-reason"]').exists()).toBe(false)
  })
})

describe('BpNotifyManager 選択とチェック', () => {
  it('他の社員に結び付いたユーザーは選べず、自分の結び付きは残る', async () => {
    const w = await mountIt([
      emp({ employee_id: 'a', lineworks_user_id: 'u1', lineworks_name: '試験 太郎' }),
      emp({ employee_id: 'b', name: '試験 花子' }),
    ])
    const opts = (i: number) => rows(w)[i]!.findAll('option').map(o => o.text())
    expect(opts(0)).toEqual(['(未設定)', '試験 太郎', '試験 花子'])
    expect(opts(1)).toEqual(['(未設定)', '試験 花子'])
  })

  it('ユーザー一覧が取れないとき理由を出し、結び付き済みの名前は選択肢に残り、ほかの操作は使える', async () => {
    api.getLineworksUsers.mockRejectedValue(new Error('API エラー (503): {"error":"lineworks_unavailable"}'))
    const w = await mountIt([emp({ lineworks_user_id: 'u1', lineworks_name: '試験 太郎', email: 'x@example.test' })])
    expect(w.find('[data-testid="bp-notify-users-error"]').text()).toContain('LINE WORKS に接続できません')
    expect(rows(w)[0]!.findAll('option').map(o => o.text())).toEqual(['(未設定)', '試験 太郎'])
    api.updateBpNotifySetting.mockResolvedValue(emp({ notify_self: true, lineworks_user_id: 'u1' }))
    await rows(w)[0]!.find('[data-testid="bp-notify-self"]').setValue(true)
    await flushPromises()
    expect(api.updateBpNotifySetting).toHaveBeenCalledWith('e1', { notify_self: true })
  })

  it('名前が無い結び付きは user_id を出す', async () => {
    api.getLineworksUsers.mockResolvedValue({ users: [] })
    const w = await mountIt([emp({ lineworks_user_id: 'zz', lineworks_name: null })])
    expect(rows(w)[0]!.findAll('option').map(o => o.text())).toEqual(['(未設定)', 'zz'])
  })

  it('ユーザーを選ぶと名前とメールも送り、返ってきた行で置き換える', async () => {
    const w = await mountIt()
    api.updateBpNotifySetting.mockResolvedValue(emp({ lineworks_user_id: 'u1', lineworks_name: '試験 太郎', email: 'taro@example.test' }))
    await rows(w)[0]!.find('select').setValue('u1')
    await flushPromises()
    expect(api.updateBpNotifySetting).toHaveBeenCalledWith('e1', {
      lineworks_user_id: 'u1', lineworks_name: '試験 太郎', email: 'taro@example.test',
    })
    expect((rows(w)[0]!.find('select').element as HTMLSelectElement).value).toBe('u1')
  })

  it('メールの無いユーザーを選んだら「メールなし」を出す。「(未設定)」で外す', async () => {
    const w = await mountIt()
    api.updateBpNotifySetting.mockResolvedValueOnce(emp({ lineworks_user_id: 'u2', lineworks_name: '試験 花子' }))
    await rows(w)[0]!.find('select').setValue('u2')
    await flushPromises()
    expect(rows(w)[0]!.text()).toContain('メールなし')
    api.updateBpNotifySetting.mockResolvedValueOnce(emp())
    await rows(w)[0]!.find('select').setValue('')
    await flushPromises()
    expect(api.updateBpNotifySetting).toHaveBeenLastCalledWith('e1', { lineworks_user_id: null, lineworks_name: null, email: null })
  })

  it('選択の保存が 409 なら理由を出し、選択を元に戻す', async () => {
    const w = await mountIt()
    api.updateBpNotifySetting.mockRejectedValue(new Error('API エラー (409): {"error":"lineworks_user_taken"}'))
    await rows(w)[0]!.find('select').setValue('u1')
    await flushPromises()
    expect(w.find('[data-testid="bp-notify-save-error"]').text()).toContain('別の社員に結び付いています')
    expect((rows(w)[0]!.find('select').element as HTMLSelectElement).value).toBe('')
  })

  it('本人に通知・日報のチェックを PUT し、失敗したら戻して理由を出す', async () => {
    const w = await mountIt([emp({ role: ['manager'], email: 'm@example.test' })])
    api.updateBpNotifySetting.mockResolvedValueOnce(emp({ role: ['manager'], email: 'm@example.test', daily_report: true }))
    await rows(w)[0]!.find('[data-testid="bp-notify-report"]').setValue(true)
    await flushPromises()
    expect(api.updateBpNotifySetting).toHaveBeenCalledWith('e1', { daily_report: true })
    expect(w.find('[data-testid="bp-notify-save-error"]').exists()).toBe(false)

    api.updateBpNotifySetting.mockRejectedValueOnce(new Error('API エラー (500): boom'))
    await rows(w)[0]!.find('[data-testid="bp-notify-self"]').setValue(true)
    await flushPromises()
    expect(w.find('[data-testid="bp-notify-save-error"]').text()).toContain('試験 太郎 さんの設定を保存できませんでした')
    expect((rows(w)[0]!.find('[data-testid="bp-notify-self"]').element as HTMLInputElement).checked).toBe(false)
  })
})

describe('BpNotifyManager 氏名での結び付け', () => {
  const PREVIEW: ApiBpNotifyLinkResult = {
    dry_run: true,
    candidates: [{ employee_id: 'e1', employee_name: '試験 太郎', lineworks_user_id: 'u1', lineworks_name: '試験 太郎', email: 'taro@example.test' },
      { employee_id: 'e2', employee_name: '試験 花子', lineworks_user_id: 'u2', lineworks_name: '試験 花子', email: null }],
    skipped: [
      { employee_id: 'e3', employee_name: '甲', reason: 'no_lineworks_user' },
      { employee_id: 'e4', employee_name: '乙', reason: 'multiple_lineworks_users' },
      { employee_id: 'e5', employee_name: '丙', reason: 'lineworks_user_taken' },
    ],
    linked: 0,
  }
  const open = async (w: Awaited<ReturnType<typeof mountIt>>) => {
    await w.find('[data-testid="bp-notify-link"]').trigger('click')
    await flushPromises()
  }

  it('dry_run の候補と結べない理由を見せ、キャンセルで閉じる', async () => {
    const w = await mountIt()
    api.linkBpNotifyByName.mockResolvedValue(PREVIEW)
    await open(w)
    expect(api.linkBpNotifyByName).toHaveBeenCalledWith(true)
    const cands = w.findAll('[data-testid="bp-notify-candidate"]').map(c => c.text())
    expect(cands[0]).toContain('試験 太郎 ↔ 試験 太郎')
    expect(cands[0]).toContain('taro@example.test')
    expect(cands[1]).toContain('メールなし')
    const skipped = w.findAll('[data-testid="bp-notify-skipped"]').map(c => c.text())
    expect(skipped[0]).toContain('同じ名前の LINE WORKS のユーザーがいません')
    expect(skipped[1]).toContain('2 人以上います')
    expect(skipped[2]).toContain('別の社員に結び付いています')
    expect(w.find('[data-testid="bp-notify-link-confirm"]').text()).toBe('2 件を結び付ける')

    await w.find('[data-testid="bp-notify-link-cancel"]').trigger('click')
    expect(w.find('[data-testid="bp-notify-link-panel"]').exists()).toBe(false)
  })

  it('確定すると dry_run:false で呼び、一覧を読み直す', async () => {
    const w = await mountIt()
    api.linkBpNotifyByName.mockResolvedValueOnce(PREVIEW)
    await open(w)
    api.linkBpNotifyByName.mockResolvedValueOnce({ ...PREVIEW, dry_run: false, linked: 2 })
    api.getBpNotifySettings.mockClear()
    await w.find('[data-testid="bp-notify-link-confirm"]').trigger('click')
    await flushPromises()
    expect(api.linkBpNotifyByName).toHaveBeenLastCalledWith(false)
    expect(api.getBpNotifySettings).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="bp-notify-link-panel"]').exists()).toBe(false)
    expect(w.find('[data-testid="bp-notify-notice"]').text()).toBe('2 件を結び付けました')
  })

  it('候補が 0 件なら確定できない', async () => {
    const w = await mountIt()
    api.linkBpNotifyByName.mockResolvedValue({ ...PREVIEW, candidates: [], skipped: [] })
    await open(w)
    expect(w.find('[data-testid="bp-notify-candidates-empty"]').exists()).toBe(true)
    expect((w.find('[data-testid="bp-notify-link-confirm"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('候補の取得に失敗したら理由を出す', async () => {
    const w = await mountIt()
    api.linkBpNotifyByName.mockRejectedValue(new Error('API エラー (503): x'))
    await open(w)
    expect(w.find('[data-testid="bp-notify-link-panel"]').exists()).toBe(false)
    expect(w.find('[data-testid="bp-notify-save-error"]').text()).toContain('503')
  })

  it('確定が 409 (先を越された) なら候補を取り直す。取り直しに失敗したら閉じる', async () => {
    const w = await mountIt()
    api.linkBpNotifyByName.mockResolvedValueOnce(PREVIEW)
    await open(w)
    api.linkBpNotifyByName.mockRejectedValueOnce(new Error('API エラー (409): {"error":"lineworks_user_taken"}'))
    api.linkBpNotifyByName.mockResolvedValueOnce({ ...PREVIEW, candidates: PREVIEW.candidates.slice(1) })
    await w.find('[data-testid="bp-notify-link-confirm"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="bp-notify-link-error"]').text()).toContain('先に結び付けられていました')
    expect(w.find('[data-testid="bp-notify-link-confirm"]').text()).toBe('1 件を結び付ける')

    api.linkBpNotifyByName.mockRejectedValueOnce(new Error('API エラー (409): x'))
    api.linkBpNotifyByName.mockRejectedValueOnce(new Error('API エラー (503): x'))
    await w.find('[data-testid="bp-notify-link-confirm"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="bp-notify-link-panel"]').exists()).toBe(false)
  })

  it('確定のほかの失敗は理由を出して、候補は開いたまま', async () => {
    const w = await mountIt()
    api.linkBpNotifyByName.mockResolvedValueOnce(PREVIEW)
    await open(w)
    api.linkBpNotifyByName.mockRejectedValueOnce(new Error('API エラー (500): boom'))
    await w.find('[data-testid="bp-notify-link-confirm"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="bp-notify-link-error"]').text()).toContain('500')
    expect(w.find('[data-testid="bp-notify-link-panel"]').exists()).toBe(true)
  })
})
