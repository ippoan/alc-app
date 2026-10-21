import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import EmployeeList from '~/components/EmployeeList.vue'

/**
 * 乗務員一覧の指静脈の承認・却下 (Refs ippoan/alc-app#436)。
 * 登録は管理者が承認するまで照合に使われない。従業員はすべて合成値。
 */

const user = ref<{ role: string } | null>({ role: 'admin' })
mockNuxtImport('useAuth', () => () => ({ user }))

const api = vi.hoisted(() => ({
  getEmployees: vi.fn(),
  getTenkoCallDrivers: vi.fn(),
  getPendingVeinTemplates: vi.fn(),
  getApprovedVeinTemplates: vi.fn(),
  approveVeinTemplate: vi.fn(),
  deleteVeinTemplate: vi.fn(),
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

vi.mock('~/utils/face-db', () => ({
  getRawFaceDescriptor: vi.fn(),
  getAllDescriptorsWithTimestamp: vi.fn(async () => []),
}))

const EMP = {
  id: 'emp-test-1', code: '001', name: 'テスト太郎', role: ['driver'], nfc_id: null,
  face_approval_status: null, created_at: '2026-10-01T00:00:00Z',
}
const VERSION = '2026-10-20T00:00:00Z'

async function mountList(): Promise<VueWrapper> {
  const wrapper = await mountSuspended(EmployeeList, { shallow: true })
  await flushPromises()
  return wrapper as VueWrapper
}

function button(wrapper: VueWrapper, text: string) {
  return wrapper.findAll('button').find(x => x.text() === text)
}

describe('EmployeeList の指静脈の承認 (Refs ippoan/alc-app#436)', () => {
  beforeEach(() => {
    user.value = { role: 'admin' }
    api.getEmployees.mockReset().mockResolvedValue([EMP])
    api.getTenkoCallDrivers.mockReset().mockResolvedValue([])
    api.getPendingVeinTemplates.mockReset().mockResolvedValue([{ employee_id: EMP.id, updated_at: VERSION }])
    api.getApprovedVeinTemplates.mockReset().mockResolvedValue([])
    api.approveVeinTemplate.mockReset().mockResolvedValue(undefined)
    api.deleteVeinTemplate.mockReset().mockResolvedValue(undefined)
  })

  it('承認待ちの乗務員の行に承認・却下を出し、件数を出す', async () => {
    const wrapper = await mountList()
    expect(button(wrapper, '指静脈を承認')).toBeDefined()
    expect(button(wrapper, '指静脈を却下')).toBeDefined()
    expect(wrapper.text()).toContain('指静脈の承認待ち: 1')
  })

  it('承認待ちでない乗務員の行には出さない', async () => {
    api.getPendingVeinTemplates.mockResolvedValue([])
    const wrapper = await mountList()
    expect(button(wrapper, '指静脈を承認')).toBeUndefined()
    expect(wrapper.text()).not.toContain('指静脈の承認待ち')
  })

  it('管理者でなければ承認待ちを取りに行かない', async () => {
    user.value = { role: 'viewer' }
    const wrapper = await mountList()
    expect(api.getPendingVeinTemplates).not.toHaveBeenCalled()
    expect(button(wrapper, '指静脈を承認')).toBeUndefined()
  })

  it('ログインしていなければ (端末の鍵の画面) 承認待ちを取りに行かない', async () => {
    user.value = null
    await mountList()
    expect(api.getPendingVeinTemplates).not.toHaveBeenCalled()
  })

  it('承認待ちが取れなくても乗務員の一覧は出す', async () => {
    api.getPendingVeinTemplates.mockRejectedValue(new Error('API エラー (500): boom'))
    const wrapper = await mountList()
    expect(wrapper.text()).toContain('テスト太郎')
    expect(button(wrapper, '指静脈を承認')).toBeUndefined()
  })

  it('承認は一覧で見た版で送り、一覧を取り直す', async () => {
    const wrapper = await mountList()
    api.getPendingVeinTemplates.mockResolvedValue([])
    await button(wrapper, '指静脈を承認')!.trigger('click')
    await flushPromises()
    expect(api.approveVeinTemplate).toHaveBeenCalledWith(EMP.id, VERSION)
    expect(api.getPendingVeinTemplates).toHaveBeenCalledTimes(2)
    expect(button(wrapper, '指静脈を承認')).toBeUndefined()
  })

  it('却下は登録を消し、一覧を取り直す', async () => {
    const wrapper = await mountList()
    await button(wrapper, '指静脈を却下')!.trigger('click')
    await flushPromises()
    expect(api.deleteVeinTemplate).toHaveBeenCalledWith(EMP.id)
    expect(api.getPendingVeinTemplates).toHaveBeenCalledTimes(2)
  })

  it('別の版に差し替わっていた (409) ら知らせて取り直す', async () => {
    const NEWER = '2026-10-20T01:00:00Z'
    // 管理者の経路の Error は status を持たず、文言だけ (failureStatus が読む)
    api.approveVeinTemplate.mockRejectedValueOnce(new Error('API エラー (409): stale'))
    const wrapper = await mountList()
    api.getPendingVeinTemplates.mockResolvedValue([{ employee_id: EMP.id, updated_at: NEWER }])
    await button(wrapper, '指静脈を承認')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('登録が更新されました。もう一度確認してください')
    await button(wrapper, '指静脈を承認')!.trigger('click')
    await flushPromises()
    expect(api.approveVeinTemplate).toHaveBeenLastCalledWith(EMP.id, NEWER)
  })

  it('他の失敗は文言をそのまま出す', async () => {
    api.deleteVeinTemplate.mockRejectedValueOnce(new Error('API エラー (403): forbidden'))
    const wrapper = await mountList()
    await button(wrapper, '指静脈を却下')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('API エラー (403): forbidden')
  })

  it('Error でない失敗は既定の文言を出す', async () => {
    api.deleteVeinTemplate.mockRejectedValueOnce('boom')
    const wrapper = await mountList()
    await button(wrapper, '指静脈を却下')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('指静脈の承認エラー')
  })

  describe('承認済みの指静脈の削除', () => {
    const OTHER = { ...EMP, id: 'emp-test-2', code: '002', name: 'テスト次郎' }

    beforeEach(() => {
      api.getEmployees.mockResolvedValue([EMP, OTHER])
      api.getPendingVeinTemplates.mockResolvedValue([])
      api.getApprovedVeinTemplates.mockResolvedValue([{ employee_id: EMP.id, updated_at: VERSION }])
    })

    it('承認済みの乗務員の行にだけ「指静脈を削除」を出す', async () => {
      const wrapper = await mountList()
      const rows = wrapper.findAll('tr').filter(r => r.text().includes('テスト'))
      expect(rows.find(r => r.text().includes('テスト太郎'))!.text()).toContain('指静脈を削除')
      expect(rows.find(r => r.text().includes('テスト次郎'))!.text()).not.toContain('指静脈を削除')
    })

    it('1 段目では消さず、「本当に削除」で消して一覧を取り直す', async () => {
      const wrapper = await mountList()
      await button(wrapper, '指静脈を削除')!.trigger('click')
      await flushPromises()
      expect(api.deleteVeinTemplate).not.toHaveBeenCalled()
      api.getApprovedVeinTemplates.mockResolvedValue([])
      await button(wrapper, '本当に削除')!.trigger('click')
      await flushPromises()
      expect(api.deleteVeinTemplate).toHaveBeenCalledWith(EMP.id)
      expect(api.getApprovedVeinTemplates).toHaveBeenCalledTimes(2)
      expect(button(wrapper, '指静脈を削除')).toBeUndefined()
      expect(button(wrapper, '本当に削除')).toBeUndefined()
    })

    it('乗務員の削除の確認とは別に持つ', async () => {
      const wrapper = await mountList()
      await button(wrapper, '指静脈を削除')!.trigger('click')
      await flushPromises()
      // 乗務員の「削除」は 1 段目のまま (指静脈の確認が乗務員の確認に化けない)
      expect(wrapper.findAll('button').filter(x => x.text() === '本当に削除')).toHaveLength(1)
      expect(wrapper.findAll('button').filter(x => x.text() === '削除')).toHaveLength(2)
    })

    it('失敗は文言をそのまま出す', async () => {
      api.deleteVeinTemplate.mockRejectedValueOnce(new Error('API エラー (403): forbidden'))
      const wrapper = await mountList()
      await button(wrapper, '指静脈を削除')!.trigger('click')
      await flushPromises()
      await button(wrapper, '本当に削除')!.trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('API エラー (403): forbidden')
      expect(button(wrapper, '指静脈を削除')).toBeDefined()
    })

    it('承認待ちにも居るときは承認待ちの表示を優先する', async () => {
      api.getPendingVeinTemplates.mockResolvedValue([{ employee_id: EMP.id, updated_at: VERSION }])
      const wrapper = await mountList()
      expect(button(wrapper, '指静脈を却下')).toBeDefined()
      expect(button(wrapper, '指静脈を削除')).toBeUndefined()
    })

    it('管理者でなければ承認済みを取りに行かず、ボタンも出さない', async () => {
      user.value = { role: 'viewer' }
      const wrapper = await mountList()
      expect(api.getApprovedVeinTemplates).not.toHaveBeenCalled()
      expect(button(wrapper, '指静脈を削除')).toBeUndefined()
    })

    it('ログインしていなければ承認済みを取りに行かない', async () => {
      user.value = null
      const wrapper = await mountList()
      expect(api.getApprovedVeinTemplates).not.toHaveBeenCalled()
      expect(button(wrapper, '指静脈を削除')).toBeUndefined()
    })

    it('承認済みが取れなくても乗務員の一覧は出す', async () => {
      api.getApprovedVeinTemplates.mockRejectedValue(new Error('API エラー (500): boom'))
      const wrapper = await mountList()
      expect(wrapper.text()).toContain('テスト太郎')
      expect(button(wrapper, '指静脈を削除')).toBeUndefined()
    })
  })
})
