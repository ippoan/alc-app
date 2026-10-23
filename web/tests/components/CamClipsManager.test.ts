// 管理者の画面のタブ「拠点カメラの録画」(Refs ippoan/alc-cam#2)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import CamClipsManager from '~/components/CamClipsManager.vue'
import type { CamClipsCamera } from '~/utils/cam-clips'

const api = vi.hoisted(() => ({
  listCamClipsCameras: vi.fn(),
  createCamClipsCamera: vi.fn(),
  updateCamClipsCamera: vi.fn(),
  listCamClipsDeviceCandidates: vi.fn(),
  createCamClipsClip: vi.fn(),
  listFirmwareDevices: vi.fn(),
}))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

const CAM: CamClipsCamera = {
  id: 'c1', name: '正門', vpc_binding: 'CAM_A', rec_username: 'admin', has_password: true,
  recording: true, device_ids: ['dev-1'], rec_scanned_until: '2026-10-23T12:58:00.000+09:00',
}
const CANDIDATES = [
  { device_id: 'dev-1', counts: { alcohol: 3, blood_pressure: 0, timecard: 1, license: 0, vein_enroll: 0 }, last_at: '2026-10-23T12:00:00.000+09:00' },
  { device_id: 'dev-2', counts: { alcohol: 0, blood_pressure: 2, timecard: 0, license: 0, vein_enroll: 0 }, last_at: '2026-10-22T08:00:00.000+09:00' },
]

async function mountIt(canEdit = true, cameras: CamClipsCamera[] = [CAM]) {
  api.listCamClipsCameras.mockResolvedValue({ can_edit_destination: canEdit, cameras })
  const w = await mountSuspended(CamClipsManager)
  await flushPromises()
  return w
}
const t = (id: string) => `[data-testid="cam-clips-${id}"]`

beforeEach(() => {
  vi.clearAllMocks()
  api.listCamClipsDeviceCandidates.mockResolvedValue(CANDIDATES)
  api.listFirmwareDevices.mockResolvedValue({ devices: [{ device_id: 'dev-1', label: '事務所の端末' }] })
  api.updateCamClipsCamera.mockResolvedValue(CAM)
  api.createCamClipsCamera.mockResolvedValue(CAM)
})

describe('CamClipsManager 一覧', () => {
  it('カメラの項目と、端末の表示名 (一致するときだけ) を出す', async () => {
    const w = await mountIt()
    const row = w.find(t('row')).text()
    expect(row).toContain('正門')
    expect(row).toContain('取り込み中')
    expect(row).toContain('CAM_A')
    expect(row).toContain('admin')
    expect(row).toContain('設定済み')
    expect(w.find(t('row-device-name')).text()).toBe('事務所の端末')
    expect(w.find(t('row-device-id')).text()).toBe('dev-1')
    expect(row).not.toContain('(dev-1)')
    expect(row).toContain('2026-10-23 12:58:00')
  })
  it('カメラが無い・取り込みを止めている・端末なし・パスワード未設定', async () => {
    expect((await mountIt(true, [])).find(t('empty')).exists()).toBe(true)
    const w = await mountIt(true, [{ ...CAM, vpc_binding: null, recording: false, has_password: false, device_ids: [], rec_username: null, rec_scanned_until: null }])
    const row = w.find(t('row')).text()
    expect(row).toContain('止めている')
    expect(row).toContain('未設定')
  })
  it('一覧の取得に失敗したら error の文言を出す', async () => {
    api.listCamClipsCameras.mockRejectedValue(new Error('API エラー (403): {"error":"admin だけです"}'))
    const w = await mountSuspended(CamClipsManager)
    await flushPromises()
    expect(w.find(t('list-error')).text()).toBe('admin だけです')
  })
  it('端末の候補・表示名が取れなくても画面は出る', async () => {
    api.listCamClipsDeviceCandidates.mockRejectedValue(new Error('x'))
    api.listFirmwareDevices.mockRejectedValue(new Error('y'))
    const w = await mountIt()
    expect(w.find(t('row')).text()).toContain('dev-1')
    await w.find(t('add')).trigger('click')
    expect(w.find(t('no-candidates')).exists()).toBe(true)
  })
})

describe('CamClipsManager 追加', () => {
  it('パスワードが空なら送らない。端末は候補から選ぶ', async () => {
    const w = await mountIt(true)
    await w.find(t('add')).trigger('click')
    expect(w.findAll(t('candidate'))).toHaveLength(2)
    expect(w.findAll(t('candidate'))[0]!.text()).toContain('事務所の端末')
    expect(w.findAll(t('candidate'))[0]!.text()).toContain('アルコール 3 / 打刻 1')
    expect(w.find(t('candidates-help')).text()).toContain('前後 10 秒')
    expect(w.find(t('save')).attributes('disabled')).toBeDefined()
    await w.find(t('name')).setValue('裏門')
    await w.find(t('binding')).setValue('CAM_B')
    await w.findAll(`${t('candidate')} input`)[1]!.setValue(true)
    await w.find(t('form')).trigger('submit')
    await flushPromises()
    expect(api.createCamClipsCamera).toHaveBeenCalledWith({ name: '裏門', vpc_binding: 'CAM_B', device_ids: ['dev-2'] })
    expect(w.find(t('notice')).text()).toBe('カメラを追加しました')
    expect(w.find(t('form')).exists()).toBe(false)
  })
  it('端末の選択を外せる', async () => {
    const w = await mountIt(true)
    await w.find(t('add')).trigger('click')
    const boxes = w.findAll(`${t('candidate')} input`)
    await boxes[0]!.setValue(true)
    await boxes[0]!.setValue(false)
    await w.find(t('name')).setValue('x')
    await w.find(t('form')).trigger('submit')
    await flushPromises()
    expect(api.createCamClipsCamera).toHaveBeenCalledWith({ name: 'x' })
  })
  it('409 などは error の文言をそのまま出し、フォームは開いたまま', async () => {
    api.createCamClipsCamera.mockRejectedValue(new Error('API エラー (409): {"error":"その VPC binding は既に使われています"}'))
    const w = await mountIt(true)
    await w.find(t('add')).trigger('click')
    await w.find(t('name')).setValue('x')
    await w.find(t('form')).trigger('submit')
    await flushPromises()
    expect(w.find(t('save-error')).text()).toBe('その VPC binding は既に使われています')
    expect(w.find(t('form')).exists()).toBe(true)
  })
  it('キャンセルで閉じる', async () => {
    const w = await mountIt()
    await w.find(t('add')).trigger('click')
    await w.find(t('cancel')).trigger('click')
    expect(w.find(t('form')).exists()).toBe(false)
  })
})

describe('CamClipsManager 編集', () => {
  it('can_edit_destination=false: binding は読み取り専用で送らない / パスワード空も送らない', async () => {
    const w = await mountIt(false)
    await w.find(t('edit')).trigger('click')
    const binding = w.find(t('binding'))
    expect((binding.element as HTMLInputElement).value).toBe('CAM_A')
    expect(binding.attributes('readonly')).toBeDefined()
    expect(w.find(t('binding-locked')).exists()).toBe(true)
    expect(w.find(t('stop')).exists()).toBe(false)
    expect(w.find(t('password-set')).exists()).toBe(true)
    await w.find(t('name')).setValue('正門 (北)')
    await w.find(t('form')).trigger('submit')
    await flushPromises()
    expect(api.updateCamClipsCamera).toHaveBeenCalledWith('c1', { name: '正門 (北)' })
    expect(w.find(t('notice')).text()).toBe('カメラを更新しました')
  })
  it('取り込みをやめる = vpc_binding: null (can_edit_destination のときだけ)', async () => {
    const w = await mountIt(true)
    await w.find(t('edit')).trigger('click')
    expect(w.find(t('binding-locked')).exists()).toBe(false)
    await w.find(t('stop')).setValue(true)
    await w.find(t('form')).trigger('submit')
    await flushPromises()
    expect(api.updateCamClipsCamera).toHaveBeenCalledWith('c1', { vpc_binding: null })
  })
  it('結び付いているが候補に無い端末も選択肢に残る', async () => {
    api.listCamClipsDeviceCandidates.mockResolvedValue([])
    const w = await mountIt(true)
    await w.find(t('edit')).trigger('click')
    expect(w.find(t('candidate')).text()).toContain('直近 30 日のイベントなし')
  })
})

describe('CamClipsManager 端末候補の表示', () => {
  it('表示名と ID は別の要素。名前が無い端末は「名前未登録の端末」、is_dev=true だけ「開発端末」', async () => {
    api.listCamClipsDeviceCandidates.mockResolvedValue([
      CANDIDATES[0],
      { ...CANDIDATES[1], is_dev: true },
    ])
    const w = await mountIt(true)
    await w.find(t('add')).trigger('click')
    const [first, second] = w.findAll(t('candidate'))
    expect(first!.find(t('candidate-name')).text()).toBe('事務所の端末')
    expect(first!.find(t('candidate-id')).text()).toBe('dev-1')
    expect(first!.find(t('candidate-dev')).exists()).toBe(false)
    expect(second!.find(t('candidate-name')).text()).toBe('名前未登録の端末')
    expect(second!.find(t('candidate-id')).text()).toBe('dev-2')
    expect(second!.find(t('candidate-dev')).text()).toBe('開発端末')
  })
})

describe('CamClipsManager 切り出し', () => {
  async function fill(w: Awaited<ReturnType<typeof mountIt>>) {
    await w.find(t('clip-camera')).setValue('c1')
    await w.find(t('clip-from')).setValue('2026-10-23T12:58')
    await w.find(t('clip-to')).setValue('2026-10-23T12:59')
  }
  it('JST の +09:00 で送り、返った key で video を出す', async () => {
    api.createCamClipsClip.mockResolvedValue({
      clip_id: 'k1', key: 'clips/t/c1/20261023T125800_20261023T125900.mp4', size: 1,
      actual_from: '2026-10-23T12:57:58.257+09:00', actual_to: '2026-10-23T12:59:00.000+09:00', reused: true,
    })
    const w = await mountIt()
    await fill(w)
    await w.find(t('clip-make')).trigger('click')
    await flushPromises()
    expect(api.createCamClipsClip).toHaveBeenCalledWith({
      camera_id: 'c1', from: '2026-10-23T12:58:00+09:00', to: '2026-10-23T12:59:00+09:00',
    })
    expect(w.find(t('video')).attributes('src')).toBe('/api/proxy/cam-clips/clips/t/c1/20261023T125800_20261023T125900.mp4')
    expect(w.find(t('result')).text()).toContain('2026-10-23 12:57:58')
    expect(w.find(t('result')).text()).toContain('再利用')
  })
  it('入力が足りなければ送らず理由を出す', async () => {
    const w = await mountIt()
    await w.find(t('clip-make')).trigger('click')
    expect(w.find(t('clip-error')).text()).toBe('カメラを選んでください')
    expect(api.createCamClipsClip).not.toHaveBeenCalled()
  })
  it('502 などは error の文言をそのまま出し、video は出さない', async () => {
    api.createCamClipsClip.mockRejectedValue(new Error('API エラー (502): {"error":"SD のフォルダを特定できません"}'))
    const w = await mountIt()
    await fill(w)
    await w.find(t('clip-make')).trigger('click')
    await flushPromises()
    expect(w.find(t('clip-error')).text()).toBe('SD のフォルダを特定できません')
    expect(w.find(t('video')).exists()).toBe(false)
  })
})

describe('CamClipsManager カメラ ID', () => {
  it('拡張の設定に入れる camera.id を出し、コピーできる', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const w = await mountIt()
    expect(w.find(t('row-id')).text()).toBe('c1')
    await w.find(t('copy-id')).trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('c1')
    expect(w.find(t('copy-id')).text()).toBe('コピーしました')
  })
  it('クリップボードが使えなければ表示のまま (選択コピー)', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('x')) }, configurable: true })
    const w = await mountIt()
    await w.find(t('copy-id')).trigger('click')
    await flushPromises()
    expect(w.find(t('copy-id')).text()).toBe('コピー')
  })
})
