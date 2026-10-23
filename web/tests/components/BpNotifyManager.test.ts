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
/** i 行目の「変更」を押して選択肢を出す (選択肢は編集中の 1 行にだけ出る) */
async function edit(w: Awaited<ReturnType<typeof mountIt>>, i: number) {
  await rows(w)[i]!.find('[data-testid="bp-notify-edit"]').trigger('click')
}
const linked = (w: Awaited<ReturnType<typeof mountIt>>, i: number) => rows(w)[i]!.find('[data-testid="bp-notify-linked"]').text()

beforeEach(() => {
  vi.clearAllMocks()
  api.getLineworksUsers.mockResolvedValue({ users: USERS })
})

describe('BpNotifyManager 一覧', () => {
  it('説明の一文と、氏名・コードを出す', async () => {
    const w = await mountIt([emp(), emp({ employee_id: 'e2', name: '試験 次郎', code: '002', role: ['manager'], email: 'j@example.test' })])
    expect(w.find('[data-testid="bp-notify-description"]').text()).toBe(
      '血圧を測ると、結び付けた LINE WORKS へ本人に結果が届きます。毎朝 7:00 の日報メールの宛先は、通知の宛先の画面の「血圧の日報」で選びます',
    )
    expect(rows(w)).toHaveLength(2)
    expect(rows(w)[0]!.text()).toContain('試験 太郎')
    expect(rows(w)[0]!.text()).toContain('001')
    expect(w.find('[data-testid="bp-notify-manager"]').exists()).toBe(false)
  })

  it('社員がいなければ空の文言、設定の取得に失敗したら理由を出す', async () => {
    const w = await mountIt([])
    expect(w.find('[data-testid="bp-notify-empty"]').exists()).toBe(true)
    api.getBpNotifySettings.mockRejectedValue(new Error('API エラー (403): forbidden'))
    const w2 = await mountSuspended(BpNotifyManager)
    await flushPromises()
    expect(w2.find('[data-testid="bp-notify-list-error"]').text()).toContain('403')
  })

  it('日報を受け取る列は無い (宛先は通知の宛先の画面で選ぶ)', async () => {
    const w = await mountIt([emp({ role: ['manager'], email: 'm@example.test' })])
    expect(w.text()).not.toContain('日報を受け取る')
    expect(w.find('[data-testid="bp-notify-report"]').exists()).toBe(false)
  })
})

describe('BpNotifyManager 選択とチェック', () => {
  it('★ 社員 400 人・ユーザー 200 人でも、選択肢は編集中の 1 行の分しか置かない (全行に置くと画面が固まった)', async () => {
    api.getLineworksUsers.mockResolvedValue({
      users: Array.from({ length: 200 }, (_, i) => ({ user_id: `u${i}`, name: `試験 ${i}`, email: null })),
    })
    const w = await mountIt(Array.from({ length: 400 }, (_, i) => emp({ employee_id: `e${i}`, code: String(i) })))
    expect(rows(w)).toHaveLength(400)
    expect(w.findAll('option')).toHaveLength(0)
    await edit(w, 7)
    expect(w.findAll('select')).toHaveLength(1)
    expect(w.findAll('option')).toHaveLength(201)
  })

  it('他の社員に結び付いたユーザーは選べず、自分の結び付きは残る', async () => {
    const w = await mountIt([
      emp({ employee_id: 'a', lineworks_user_id: 'u1', lineworks_name: '試験 太郎' }),
      emp({ employee_id: 'b', name: '試験 花子' }),
    ])
    const opts = (i: number) => rows(w)[i]!.findAll('option').map(o => o.text())
    await edit(w, 0)
    expect(opts(0)).toEqual(['(未設定)', '試験 太郎', '試験 花子'])
    await edit(w, 1)
    // 選択肢は編集中の 1 行にだけ出る
    expect(rows(w)[0]!.find('select').exists()).toBe(false)
    expect(opts(1)).toEqual(['(未設定)', '試験 花子'])
    await rows(w)[1]!.find('[data-testid="bp-notify-edit-cancel"]').trigger('click')
    expect(w.find('select').exists()).toBe(false)
  })

  it('ユーザー一覧が取れないとき理由を出し、結び付き済みの名前は選択肢に残り、ほかの操作は使える', async () => {
    api.getLineworksUsers.mockRejectedValue(new Error('API エラー (503): {"error":"lineworks_unavailable"}'))
    const w = await mountIt([emp({ lineworks_user_id: 'u1', lineworks_name: '試験 太郎', email: 'x@example.test' })])
    expect(w.find('[data-testid="bp-notify-users-error"]').text()).toContain('LINE WORKS に接続できません')
    expect(linked(w, 0)).toBe('試験 太郎')
    await edit(w, 0)
    expect(rows(w)[0]!.findAll('option').map(o => o.text())).toEqual(['(未設定)', '試験 太郎'])
    api.updateBpNotifySetting.mockResolvedValue(emp({ notify_self: true, lineworks_user_id: 'u1' }))
    await rows(w)[0]!.find('[data-testid="bp-notify-self"]').setValue(true)
    await flushPromises()
    expect(api.updateBpNotifySetting).toHaveBeenCalledWith('e1', { notify_self: true })
  })

  it('名前が無い結び付きは user_id を出す', async () => {
    api.getLineworksUsers.mockResolvedValue({ users: [] })
    const w = await mountIt([emp({ lineworks_user_id: 'zz', lineworks_name: null })])
    expect(linked(w, 0)).toBe('zz')
    await edit(w, 0)
    expect(rows(w)[0]!.findAll('option').map(o => o.text())).toEqual(['(未設定)', 'zz'])
  })

  it('ユーザーを選ぶと名前とメールも送り、返ってきた行で置き換える', async () => {
    const w = await mountIt()
    expect(linked(w, 0)).toBe('(未設定)')
    api.updateBpNotifySetting.mockResolvedValue(emp({ lineworks_user_id: 'u1', lineworks_name: '試験 太郎', email: 'taro@example.test' }))
    await edit(w, 0)
    await rows(w)[0]!.find('select').setValue('u1')
    await flushPromises()
    expect(api.updateBpNotifySetting).toHaveBeenCalledWith('e1', {
      lineworks_user_id: 'u1', lineworks_name: '試験 太郎', email: 'taro@example.test',
    })
    // 選び終えたら選択肢を閉じ、結び付いた名前を出す
    expect(rows(w)[0]!.find('select').exists()).toBe(false)
    expect(linked(w, 0)).toBe('試験 太郎')
  })

  it('メールの無いユーザーを選んだら「メールなし」を出す。「(未設定)」で外す', async () => {
    const w = await mountIt()
    api.updateBpNotifySetting.mockResolvedValueOnce(emp({ lineworks_user_id: 'u2', lineworks_name: '試験 花子' }))
    await edit(w, 0)
    await rows(w)[0]!.find('select').setValue('u2')
    await flushPromises()
    expect(rows(w)[0]!.text()).toContain('メールなし')
    api.updateBpNotifySetting.mockResolvedValueOnce(emp())
    await edit(w, 0)
    await rows(w)[0]!.find('select').setValue('')
    await flushPromises()
    expect(api.updateBpNotifySetting).toHaveBeenLastCalledWith('e1', { lineworks_user_id: null, lineworks_name: null, email: null })
  })

  it('選択の保存が 409 なら理由を出し、選択を元に戻す', async () => {
    const w = await mountIt()
    api.updateBpNotifySetting.mockRejectedValue(new Error('API エラー (409): {"error":"lineworks_user_taken"}'))
    await edit(w, 0)
    await rows(w)[0]!.find('select').setValue('u1')
    await flushPromises()
    expect(w.find('[data-testid="bp-notify-save-error"]').text()).toContain('別の社員に結び付いています')
    expect(linked(w, 0)).toBe('(未設定)')
  })

  it('本人に通知のチェックを PUT し、失敗したら戻して理由を出す', async () => {
    const w = await mountIt([emp()])
    api.updateBpNotifySetting.mockResolvedValueOnce(emp({ notify_self: true }))
    await rows(w)[0]!.find('[data-testid="bp-notify-self"]').setValue(true)
    await flushPromises()
    expect(api.updateBpNotifySetting).toHaveBeenCalledWith('e1', { notify_self: true })
    expect(w.find('[data-testid="bp-notify-save-error"]').exists()).toBe(false)

    api.updateBpNotifySetting.mockRejectedValueOnce(new Error('API エラー (500): boom'))
    await rows(w)[0]!.find('[data-testid="bp-notify-self"]').setValue(false)
    await flushPromises()
    expect(w.find('[data-testid="bp-notify-save-error"]').text()).toContain('試験 太郎 さんの設定を保存できませんでした')
    expect((rows(w)[0]!.find('[data-testid="bp-notify-self"]').element as HTMLInputElement).checked).toBe(true)
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
