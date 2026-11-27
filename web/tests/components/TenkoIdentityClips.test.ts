import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import TenkoIdentityClips from '~/components/TenkoIdentityClips.vue'

// 点呼の詳細の「本人確認のときの録画」(自己点検表 ト①。Refs ippoan/alc-app#720)

const api = vi.hoisted(() => ({ listTenkoIdentityClips: vi.fn(), fetchCamClip: vi.fn() }))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

const clip = (n: number, status = 'ready', camera: string | null = '入口') =>
  ({ clip_id: `c${n}`, key: `clips/t/cam/${n}.mp4`, status, error: null, camera_name: camera })
const ITEMS = [
  { id: 'i1', phase: 'start', method: 'vein', occurred_at: '2026-11-27T09:00:00+09:00', device_id: 'alarm:k', clips: [clip(1), clip(2, 'failed', null)] },
  { id: 'i2', phase: 'resume', method: null, occurred_at: '2026-11-27T09:30:00+09:00', device_id: 'alarm:k', clips: [] },
]

async function mountIt() {
  const w = await mountSuspended(TenkoIdentityClips, { props: { sessionId: 's1' } })
  await flushPromises()
  return w
}

describe('TenkoIdentityClips', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.URL.revokeObjectURL = vi.fn()
  })

  it('★ 本人確認ごとに開始/再開・時刻・方法と、切り出しの再生ボタンを出す (切っていなければ「録画なし」)', async () => {
    api.listTenkoIdentityClips.mockResolvedValue(ITEMS)
    const w = await mountIt()
    expect(api.listTenkoIdentityClips).toHaveBeenCalledWith('s1', 'tenko-monitor')
    const rows = w.findAll('[data-testid="identity-clips-item"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('開始 2026-11-27 09:00:00')
    expect(rows[0]!.text()).toContain('(指静脈)')
    expect(rows[0]!.text()).toContain('入口の録画を再生')
    expect(rows[0]!.text()).toContain('カメラ: 切り出しできませんでした')
    expect(rows[1]!.text()).toContain('再開')
    expect(rows[1]!.text()).toContain('録画なし')
    expect(rows[1]!.text()).not.toContain('指静脈')
  })

  it('再生を押すと切り出しを取って再生し、閉じると URL を捨てる', async () => {
    api.listTenkoIdentityClips.mockResolvedValue(ITEMS)
    api.fetchCamClip.mockResolvedValue('blob:x')
    const w = await mountIt()
    await w.find('[data-testid="identity-clips-play"]').trigger('click')
    await flushPromises()
    expect(api.fetchCamClip).toHaveBeenCalledWith('clips/t/cam/1.mp4', 'tenko-monitor')
    expect(w.find('[data-testid="identity-clips-player"] video').attributes('src')).toBe('blob:x')
    await w.find('[data-testid="identity-clips-close"]').trigger('click')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
    expect(w.find('[data-testid="identity-clips-player"]').exists()).toBe(false)
  })

  it('取れなければ理由を出す。取り終える前に閉じたら、後から届いた URL は捨てる', async () => {
    api.listTenkoIdentityClips.mockResolvedValue(ITEMS)
    api.fetchCamClip.mockResolvedValueOnce(null)
    const w = await mountIt()
    await w.find('[data-testid="identity-clips-play"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('録画を取得できませんでした')

    let resolve!: (v: string | null) => void
    api.fetchCamClip.mockReturnValueOnce(new Promise(r => { resolve = r }))
    await w.find('[data-testid="identity-clips-play"]').trigger('click')
    expect(w.text()).toContain('録画を取得しています')
    await w.find('[data-testid="identity-clips-close"]').trigger('click')
    resolve('blob:late')
    await flushPromises()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late')
    expect(w.find('[data-testid="identity-clips-player"]').exists()).toBe(false)

    // 後から届いたのが null なら何も捨てない
    api.fetchCamClip.mockReturnValueOnce(new Promise(r => { resolve = r }))
    await w.find('[data-testid="identity-clips-play"]').trigger('click')
    await w.find('[data-testid="identity-clips-close"]').trigger('click')
    resolve(null)
    await flushPromises()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('本人確認が無ければその旨、取れなければ理由を出す', async () => {
    api.listTenkoIdentityClips.mockResolvedValueOnce([])
    const w = await mountIt()
    expect(w.find('[data-testid="identity-clips-empty"]').exists()).toBe(true)

    api.listTenkoIdentityClips.mockRejectedValueOnce(new Error('403'))
    const w2 = await mountIt()
    expect(w2.find('[data-testid="identity-clips-error"]').exists()).toBe(true)
  })

  it('読み込み中は読み込み中と出す', async () => {
    api.listTenkoIdentityClips.mockReturnValue(new Promise(() => {}))
    const w = await mountSuspended(TenkoIdentityClips, { props: { sessionId: 's1' } })
    expect(w.text()).toContain('読み込み中')
  })
})
