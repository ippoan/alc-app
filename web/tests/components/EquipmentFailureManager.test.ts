import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import EquipmentFailureManager from '~/components/EquipmentFailureManager.vue'

const FAILURE = {
  id: 'f-1', tenant_id: 't', failure_type: 'manual_report', description: '故障', affected_device: null,
  detected_at: '2026-09-12T00:00:00Z', detected_by: null, resolved_at: null, resolution_notes: null, session_id: null,
}

const listFailuresMock = vi.fn(async () => ({ failures: [FAILURE], total: 1, page: 1, per_page: 20 }))
const getHistoryMock = vi.fn(async (_id: string, _scope?: string): Promise<any[]> => [])

vi.mock('~/utils/api', () => ({
  listFailures: (...a: any[]) => (listFailuresMock as any)(...a),
  createFailure: vi.fn(),
  resolveFailure: vi.fn(),
  downloadFailuresCsv: vi.fn(),
  getEquipmentFailureHistory: (id: string, scope?: string) => getHistoryMock(id, scope),
}))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function mountIt() {
  const w = await mountSuspended(EquipmentFailureManager)
  await flush()
  await w.vm.$nextTick()
  return w
}

describe('EquipmentFailureManager — 保存の注記と変更履歴', () => {
  beforeEach(() => {
    getHistoryMock.mockReset()
    getHistoryMock.mockResolvedValue([])
  })

  it('故障の記録は削除できず履歴が残る旨の注記が出る', async () => {
    const w = await mountIt()
    expect(w.find('[data-testid="failure-retention-note"]').text())
      .toBe('故障の記録は 1 年間以上保存され、削除できません。解決を記録すると、変更前の内容が履歴に残ります。')
    w.unmount()
  })

  it('履歴を開くと変更前の内容が古い順に出て、もう一度押すと閉じる', async () => {
    getHistoryMock.mockResolvedValue([
      { changed_at: '2026-09-13T00:00:00Z', old_row: { resolved_at: null, resolution_notes: null } },
      { changed_at: '2026-09-14T00:00:00Z', old_row: { resolved_at: '2026-09-13T00:00:00Z', resolution_notes: '交換' } },
    ])
    const w = await mountIt()
    await w.find('[data-testid="history-toggle"]').trigger('click')
    await flush()
    await w.vm.$nextTick()
    expect(getHistoryMock).toHaveBeenCalledWith('f-1', 'tenko-monitor')
    const items = w.findAll('[data-testid="history-item"]')
    expect(items).toHaveLength(2)
    expect(items[0]!.text()).toContain('未解決')
    expect(items[1]!.text()).toContain('解決済')
    expect(items[1]!.text()).toContain('解決メモ: 交換')
    await w.find('[data-testid="history-toggle"]').trigger('click')
    expect(w.find('[data-testid="history-row"]').exists()).toBe(false)
    w.unmount()
  })

  it('履歴が無いときの文言と、取得失敗の理由 (非 Error は既定文言)', async () => {
    const w = await mountIt()
    await w.find('[data-testid="history-toggle"]').trigger('click')
    await flush()
    await w.vm.$nextTick()
    expect(w.find('[data-testid="history-row"]').text()).toContain('変更履歴はありません')
    await w.find('[data-testid="history-toggle"]').trigger('click')

    getHistoryMock.mockRejectedValueOnce(new Error('取れません'))
    await w.find('[data-testid="history-toggle"]').trigger('click')
    await flush()
    await w.vm.$nextTick()
    expect(w.find('[data-testid="history-row"]').text()).toContain('取れません')
    await w.find('[data-testid="history-toggle"]').trigger('click')

    getHistoryMock.mockRejectedValueOnce('x')
    await w.find('[data-testid="history-toggle"]').trigger('click')
    await flush()
    await w.vm.$nextTick()
    expect(w.find('[data-testid="history-row"]').text()).toContain('履歴の取得エラー')
    w.unmount()
  })

  it('取得中に別の履歴へ切り替えたら古い結果は反映しない', async () => {
    let release!: (v: any[]) => void
    getHistoryMock.mockImplementationOnce(() => new Promise(r => { release = r }))
    const w = await mountIt()
    await w.find('[data-testid="history-toggle"]').trigger('click')
    await w.find('[data-testid="history-toggle"]').trigger('click')
    release([{ changed_at: '2026-09-13T00:00:00Z', old_row: {} }])
    await flush()
    expect(w.find('[data-testid="history-row"]').exists()).toBe(false)
    w.unmount()
  })

  it('取得中に閉じた後の失敗も反映しない', async () => {
    let fail!: (e: unknown) => void
    getHistoryMock.mockImplementationOnce(() => new Promise((_r, rej) => { fail = rej }))
    const w = await mountIt()
    await w.find('[data-testid="history-toggle"]').trigger('click')
    await w.find('[data-testid="history-toggle"]').trigger('click')
    fail(new Error('遅れた失敗'))
    await flush()
    expect(w.text()).not.toContain('遅れた失敗')
    w.unmount()
  })
})
