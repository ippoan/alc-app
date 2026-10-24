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
  listDeviceLabels: vi.fn(),
  listCamHostKeys: vi.fn(),
}))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

const CAM: CamClipsCamera = {
  id: 'c1', name: '正門', vpc_binding: 'CAM_A', rec_username: 'admin', has_password: true,
  recording: true, lan_ip: null, rtsp_port: 554, rtsp_path: null,
  device_ids: ['dev-1'], rec_scanned_until: '2026-10-23T12:58:00.000+09:00',
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
  api.listDeviceLabels.mockResolvedValue({ devices: [{ device_id: 'dev-1', label: '事務所の端末' }] })
  api.updateCamClipsCamera.mockResolvedValue(CAM)
  api.createCamClipsCamera.mockResolvedValue(CAM)
  api.listCamHostKeys.mockResolvedValue({ keys: [] })
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
    api.listDeviceLabels.mockRejectedValue(new Error('y'))
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

describe('CamClipsManager RTSP の接続先と機体の鍵', () => {
  const KEYS = { keys: [
    { device_id: 'alarm:fp-1', label: '帯広の拠点 PC' },
    { device_id: 'dev-2', label: null },
  ] }

  it('一覧に RTSP の接続先を出す (未設定なら「未設定」)', async () => {
    const w = await mountIt(true, [{ ...CAM, lan_ip: '192.168.1.64', rtsp_path: 'stream1' }, { ...CAM, id: 'c2' }])
    const cells = w.findAll(t('row-rtsp'))
    expect(cells[0]!.text()).toBe('192.168.1.64:554/stream1')
    expect(cells[1]!.text()).toBe('未設定')
  })

  it('追加: IP・ポート・パスを送る。機体の鍵は候補に label 付きで出て、選べる (イベントの候補と重なる鍵は 1 行)', async () => {
    api.listCamHostKeys.mockResolvedValue(KEYS)
    const w = await mountIt(true)
    await w.find(t('add')).trigger('click')
    const rows = w.findAll(t('candidate'))
    expect(rows).toHaveLength(3)
    expect(rows[2]!.find(t('candidate-name')).text()).toBe('帯広の拠点 PC')
    expect(rows[2]!.find(t('candidate-id')).text()).toBe('alarm:fp-1')
    expect(rows[2]!.text()).toContain('機体の鍵 (拠点 PC のカメラ配信)')
    expect(w.find(t('rtsp-port')).attributes('placeholder')).toBe('554')
    await w.find(t('name')).setValue('裏門')
    await w.find(t('lan-ip')).setValue('192.168.1.64')
    await w.find(t('rtsp-port')).setValue('8554')
    await w.find(t('rtsp-path')).setValue('stream1')
    await rows[2]!.find('input').setValue(true)
    await w.find(t('form')).trigger('submit')
    await flushPromises()
    expect(api.createCamClipsCamera).toHaveBeenCalledWith({
      name: '裏門', lan_ip: '192.168.1.64', rtsp_port: 8554, rtsp_path: 'stream1', device_ids: ['alarm:fp-1'],
    })
  })

  it('結び付けた鍵は一覧でも label で出る', async () => {
    api.listCamHostKeys.mockResolvedValue(KEYS)
    const w = await mountIt(true, [{ ...CAM, device_ids: ['alarm:fp-1'] }])
    expect(w.find(t('row-device-name')).text()).toBe('帯広の拠点 PC')
  })

  it('鍵の名前を全部出す: 別用途の鍵 (names)・失効済み (失効)・browser', async () => {
    api.listDeviceLabels.mockResolvedValue({ devices: [{ device_id: 'alarm:dead', label: '旧機', revoked: true }] })
    api.listCamHostKeys.mockResolvedValue({ keys: [], names: [{ device_id: 'alarm:0666000000000000', label: 'VoiceS3R', revoked: false }] })
    const w = await mountIt(true, [{ ...CAM, device_ids: ['alarm-0666000000000000', 'alarm-dead', 'browser'] }])
    expect(w.findAll(t('row-device-name')).map(n => n.text())).toEqual(['VoiceS3R', '旧機 (失効)', 'ブラウザ (ログイン利用者の打刻)'])
  })

  it('ポートが不正なら送らずに文言を出す', async () => {
    const w = await mountIt(true)
    await w.find(t('edit')).trigger('click')
    await w.find(t('rtsp-port')).setValue('70000')
    await w.find(t('form')).trigger('submit')
    await flushPromises()
    expect(api.updateCamClipsCamera).not.toHaveBeenCalled()
    expect(w.find(t('save-error')).text()).toBe('RTSP のポートは 1〜65535 にしてください')
  })

  it('編集: RTSP の項目の差分だけ送る', async () => {
    const w = await mountIt(true, [{ ...CAM, lan_ip: '192.168.1.64', rtsp_path: 'stream1' }])
    await w.find(t('edit')).trigger('click')
    expect((w.find(t('lan-ip')).element as HTMLInputElement).value).toBe('192.168.1.64')
    await w.find(t('rtsp-path')).setValue('stream2')
    await w.find(t('form')).trigger('submit')
    await flushPromises()
    expect(api.updateCamClipsCamera).toHaveBeenCalledWith('c1', { rtsp_path: 'stream2' })
  })

  it('鍵の一覧が取れなくても候補はイベントの端末だけで出る', async () => {
    api.listCamHostKeys.mockRejectedValue(new Error('403'))
    const w = await mountIt(true)
    await w.find(t('add')).trigger('click')
    expect(w.findAll(t('candidate'))).toHaveLength(2)
  })
})

describe('CamClipsManager 配信担当 (順位)', () => {
  const KEYS = { keys: [
    { device_id: 'alarm:pc-1', label: '帯広 PC 1' },
    { device_id: 'alarm:pc-2', label: '帯広 PC 2' },
    { device_id: 'alarm:vein', label: 'Vein Station' },
  ] }

  it('一覧に 1 位と待機の台数。未設定なら先着の説明', async () => {
    api.listCamHostKeys.mockResolvedValue(KEYS)
    const w = await mountIt(true, [{ ...CAM, stream_device_ids: ['alarm:pc-2', 'alarm:pc-1'] }, { ...CAM, id: 'c2' }, { ...CAM, id: 'c3', stream_device_ids: ['alarm:pc-1'] }])
    const cells = w.findAll(t('row-stream'))
    expect(cells[0]!.find(t('row-stream-name')).text()).toBe('帯広 PC 2')
    expect(cells[0]!.find(t('row-stream-more')).text()).toBe('ほか 1 台が待機')
    expect(cells[1]!.find(t('row-stream-unset')).exists()).toBe(true)
    expect(cells[2]!.find(t('row-stream-more')).exists()).toBe(false)
  })

  /** 候補の行 (結び付ける端末) のうち、その device_id の行のチェックを付け外しする */
  async function check(w: Awaited<ReturnType<typeof mountIt>>, id: string, on = true) {
    const row = w.findAll(t('candidate')).find(r => r.find(t('candidate-id')).text() === id)!
    await row.find('input').setValue(on)
  }

  it('選べるのは上でチェックした機体の鍵だけ (イベントの端末・未チェックの鍵は出ない)', async () => {
    api.listCamHostKeys.mockResolvedValue(KEYS)
    const w = await mountIt(true)
    await w.find(t('add')).trigger('click')
    // 何もチェックしていなければ選ぶ欄は無く、チェックを促す
    expect(w.find(t('stream-pick')).exists()).toBe(false)
    expect(w.find(t('stream-no-keys')).text()).toContain('チェックすると選べます')
    await check(w, 'dev-1')
    expect(w.find(t('stream-pick')).exists()).toBe(false)
    await check(w, 'alarm:pc-2')
    await check(w, 'alarm:vein')
    const options = w.find(t('stream-pick')).findAll('option').map(o => o.attributes('value'))
    expect(options).toEqual(['', 'alarm:pc-2', 'alarm:vein'])
  })

  it('追加: チェックした鍵を順に足し、上下で並べ替え・外して、並びのまま送る', async () => {
    api.listCamHostKeys.mockResolvedValue(KEYS)
    const w = await mountIt(true)
    await w.find(t('add')).trigger('click')
    for (const id of ['alarm:pc-1', 'alarm:pc-2', 'alarm:vein']) await check(w, id)
    expect(w.find(t('stream-empty')).exists()).toBe(true)
    expect((w.find(t('stream-add')).element as HTMLButtonElement).disabled).toBe(true)
    for (const id of ['alarm:pc-1', 'alarm:pc-2', 'alarm:vein']) {
      await w.find(t('stream-pick')).setValue(id)
      await w.find(t('stream-add')).trigger('click')
    }
    // 足した鍵は選択肢から消え、全部足すと選ぶ欄の代わりに理由が出る
    expect(w.find(t('stream-pick')).exists()).toBe(false)
    expect(w.find(t('stream-no-keys')).exists()).toBe(false)
    expect(w.find(t('stream-all-in')).text()).toContain('すべて順位に入っています')
    expect(w.findAll(t('stream-rank')).map(n => n.text())).toEqual(['1 位', '2 位', '3 位'])
    expect(w.findAll(t('stream-name')).map(n => n.text())).toEqual(['帯広 PC 1', '帯広 PC 2', 'Vein Station'])
    const ups = w.findAll(t('stream-up'))
    const downs = w.findAll(t('stream-down'))
    expect((ups[0]!.element as HTMLButtonElement).disabled).toBe(true)
    expect((downs[2]!.element as HTMLButtonElement).disabled).toBe(true)
    await ups[1]!.trigger('click')
    await w.findAll(t('stream-down'))[1]!.trigger('click')
    expect(w.findAll(t('stream-name')).map(n => n.text())).toEqual(['帯広 PC 2', 'Vein Station', '帯広 PC 1'])
    await w.findAll(t('stream-remove'))[1]!.trigger('click')
    // 外した鍵は結び付けたままなので、選択肢に戻る
    expect(w.find(t('stream-pick')).findAll('option').map(o => o.attributes('value'))).toEqual(['', 'alarm:vein'])
    await w.find(t('name')).setValue('裏門')
    await w.find(t('form')).trigger('submit')
    await flushPromises()
    expect(api.createCamClipsCamera).toHaveBeenCalledWith({
      name: '裏門', device_ids: ['alarm:pc-1', 'alarm:pc-2', 'alarm:vein'], stream_device_ids: ['alarm:pc-2', 'alarm:pc-1'],
    })
  })

  it('結び付けのチェックを外すと配信担当からも外れる', async () => {
    api.listCamHostKeys.mockResolvedValue(KEYS)
    const w = await mountIt(true, [{ ...CAM, device_ids: ['alarm:pc-1', 'alarm:pc-2'], stream_device_ids: ['alarm:pc-1', 'alarm:pc-2'] }])
    await w.find(t('edit')).trigger('click')
    await check(w, 'alarm:pc-1', false)
    expect(w.findAll(t('stream-name')).map(n => n.text())).toEqual(['帯広 PC 2'])
    await w.find(t('form')).trigger('submit')
    await flushPromises()
    expect(api.updateCamClipsCamera).toHaveBeenCalledWith('c1', { device_ids: ['alarm:pc-2'], stream_device_ids: ['alarm:pc-2'] })
  })

  it('編集: 今の並びを出し、並べ替えたら全部を送る', async () => {
    api.listCamHostKeys.mockResolvedValue(KEYS)
    const w = await mountIt(true, [{ ...CAM, device_ids: ['alarm:pc-1', 'alarm:gone'], stream_device_ids: ['alarm:pc-1', 'alarm:gone'] }])
    await w.find(t('edit')).trigger('click')
    // 鍵の一覧に無い (失効した等) 端末も並びに残り、名前は「名前未登録の端末」
    expect(w.findAll(t('stream-name')).map(n => n.text())).toEqual(['帯広 PC 1', '名前未登録の端末'])
    await w.findAll(t('stream-down'))[0]!.trigger('click')
    await w.find(t('form')).trigger('submit')
    await flushPromises()
    expect(api.updateCamClipsCamera).toHaveBeenCalledWith('c1', { stream_device_ids: ['alarm:gone', 'alarm:pc-1'] })
  })

  it('10 台まで (上限で足す欄が消える)', async () => {
    const keys = Array.from({ length: 11 }, (_, i) => ({ device_id: `alarm:k${i}`, label: `PC ${i}` }))
    api.listCamHostKeys.mockResolvedValue({ keys })
    const ids = keys.map(k => k.device_id)
    const w = await mountIt(true, [{ ...CAM, device_ids: ids, stream_device_ids: ids.slice(0, 10) }])
    await w.find(t('edit')).trigger('click')
    expect(w.findAll(t('stream-item'))).toHaveLength(10)
    expect(w.find(t('stream-pick')).exists()).toBe(false)
    expect(w.find(t('stream-no-keys')).exists()).toBe(false)
    // 結び付けた鍵が 1 つ余っていても、上限の理由を出す
    expect(w.find(t('stream-all-in')).exists()).toBe(false)
    expect(w.find(t('stream-full')).text()).toBe('配信担当は 10 台までです (これ以上は足せません)')
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
