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

vi.mock('~/utils/api', () => ({
  submitManagerJudgment: (...args: any[]) => submitManagerJudgmentMock(...args),
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

  it('判定済みのセッションでは OK/NG ボタンを出さず、結果 (値 + 理由) を表示する', async () => {
    const judged = { ...SESSION_UNJUDGED, manager_judgment: 'ng', manager_judgment_reason: '体調不良' }
    const wrapper = await mountPanel(judged)
    expect(wrapper.text()).toContain('NG')
    expect(wrapper.text()).toContain('体調不良')
    expect(wrapper.findAll('button').find(b => b.text() === 'OK')).toBeUndefined()
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
