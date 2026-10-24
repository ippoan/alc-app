// 管理者の画面「拠点カメラの録画」の自動切り出しの一覧 (Refs ippoan/alc-cam#2)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import CamClipEvents from '~/components/CamClipEvents.vue'
import type { CamClipsCamera, CamClipsEvent } from '~/utils/cam-clips'
import { clipSrc } from '~/utils/cam-clips'
import { jstTodayDate } from '~/utils/jst'
import { FETCH_TIMEOUT_MESSAGE_WRITE } from '~/utils/fetch-timeout'

const api = vi.hoisted(() => ({
  listCamClipsCameras: vi.fn(),
  listCamClipsEvents: vi.fn(),
  runCamClipsAuto: vi.fn(),
  listDeviceLabels: vi.fn(),
}))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

const cam = (id: string, name: string): CamClipsCamera => ({
  id, name, vpc_binding: null, rec_username: null, has_password: false,
  recording: false, device_ids: [], rec_scanned_until: null,
})
const ev = (over: Partial<CamClipsEvent>): CamClipsEvent => ({
  source_table: 'hub_measurements', source_id: 's', kind: 'alcohol',
  occurred_at: '2026-10-23T09:05:00.000+09:00', device_id: 'dev-1', is_dev: false, clip: null, ...over,
})
const EVENTS: CamClipsEvent[] = [
  ev({ source_id: 's1' }),
  ev({ source_id: 's2', kind: 'blood_pressure', is_dev: true, clip: { clip_id: 'k1', key: 'clips/t/c/a.mp4', status: 'failed', error: 'カメラに届きません' } }),
  ev({ source_id: 's3', kind: 'vein_enroll', source_table: 'vein_enroll_events', clip: { clip_id: 'k2', key: 'clips/t/c/b.mp4', status: 'ready', error: null } }),
  ev({ source_id: 's4', kind: 'timecard', clip: { clip_id: 'k3', key: 'clips/t/c/c.mp4', status: 'ready', error: null } }),
]
const t = (id: string) => `[data-testid="cam-clips-events-${id}"]`

async function mountIt(cameras = [cam('c1', '正門')]) {
  api.listCamClipsCameras.mockResolvedValue({ can_edit_destination: false, cameras })
  const w = await mountSuspended(CamClipEvents)
  await flushPromises()
  return w
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listCamClipsEvents.mockResolvedValue(EVENTS)
  api.listDeviceLabels.mockResolvedValue({ devices: [{ device_id: 'dev-1', label: '事務所の端末' }] })
})

describe('CamClipEvents', () => {
  it('カメラが 1 台なら最初から選び、今日の日付で取得する', async () => {
    const w = await mountIt()
    expect((w.find(t('camera')).element as HTMLSelectElement).value).toBe('c1')
    expect((w.find(t('date')).element as HTMLInputElement).value).toBe(jstTodayDate())
    expect(api.listCamClipsEvents).toHaveBeenCalledWith('c1', jstTodayDate())
  })
  it('カメラが複数なら選ぶまで取得しない', async () => {
    const w = await mountIt([cam('c1', '正門'), cam('c2', '裏門')])
    expect(api.listCamClipsEvents).not.toHaveBeenCalled()
    await w.find(t('camera')).setValue('c2')
    await flushPromises()
    expect(api.listCamClipsEvents).toHaveBeenCalledWith('c2', jstTodayDate())
  })
  it('時刻・種類・端末・切り出しの 3 状態を出す', async () => {
    const w = await mountIt()
    const rows = w.findAll(t('row'))
    expect(rows).toHaveLength(4)
    expect(rows[0]!.find(t('time')).text()).toBe('2026-10-23 09:05:00')
    expect(rows[0]!.find(t('kind')).text()).toBe('アルコール')
    expect(rows[0]!.find(t('device')).text()).toBe('dev-1')
    expect(rows[0]!.find(t('device-name')).text()).toBe('事務所の端末')
    expect(rows[0]!.find(t('dev')).exists()).toBe(false)
    expect(rows[0]!.find(t('none')).text()).toBe('未切り出し')
    expect(rows[1]!.find(t('dev')).text()).toBe('開発端末')
    expect(rows[1]!.find(t('failed')).text()).toContain('失敗')
    expect(rows[1]!.find(t('failed')).text()).toContain('カメラに届きません')
    expect(rows[2]!.find(t('kind')).text()).toBe('指静脈登録')
    expect(rows[2]!.find(t('play')).text()).toBe('再生')
  })
  it('失敗に error が無ければ「失敗」だけ', async () => {
    api.listCamClipsEvents.mockResolvedValue([
      ev({ clip: { clip_id: 'k', key: 'k.mp4', status: 'failed', error: null } }),
    ])
    const w = await mountIt()
    expect(w.find(t('failed')).text()).toBe('失敗')
  })
  it('再生はモーダルに押した行の 1 本だけ出し、別の行を押すと差し替わる', async () => {
    const w = await mountIt()
    expect(w.find(t('modal')).exists()).toBe(false)
    expect(w.find(t('video')).exists()).toBe(false)
    const plays = w.findAll(t('play'))
    await plays[0]!.trigger('click')
    expect(w.find(t('modal')).exists()).toBe(true)
    expect(w.find(t('modal')).text()).toContain('2026-10-23 09:05:00 指静脈登録')
    expect(w.findAll(t('video'))).toHaveLength(1)
    expect(w.find(t('video')).attributes('src')).toBe(clipSrc('clips/t/c/b.mp4'))
    expect(w.find(t('video')).attributes('autoplay')).toBeDefined()
    await plays[1]!.trigger('click')
    expect(w.findAll(t('modal'))).toHaveLength(1)
    expect(w.findAll(t('video'))).toHaveLength(1)
    expect(w.find(t('video')).attributes('src')).toBe(clipSrc('clips/t/c/c.mp4'))
  })
  describe('モーダルの閉じ方', () => {
    async function open() {
      const w = await mountIt()
      await w.findAll(t('play'))[0]!.trigger('click')
      expect(w.find(t('video')).exists()).toBe(true)
      return w
    }
    it('閉じるボタンで video ごと消える', async () => {
      const w = await open()
      await w.find(t('modal-close')).trigger('click')
      expect(w.find(t('modal')).exists()).toBe(false)
      expect(w.find(t('video')).exists()).toBe(false)
    })
    it('背景クリックで消え、中身のクリックでは消えない', async () => {
      const w = await open()
      await w.find(t('video')).trigger('click')
      expect(w.find(t('modal')).exists()).toBe(true)
      await w.find(t('modal')).trigger('click')
      expect(w.find(t('modal')).exists()).toBe(false)
      expect(w.find(t('video')).exists()).toBe(false)
    })
    it('Esc で消え、他のキーでは消えない', async () => {
      const w = await open()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flushPromises()
      expect(w.find(t('modal')).exists()).toBe(true)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await flushPromises()
      expect(w.find(t('modal')).exists()).toBe(false)
      expect(w.find(t('video')).exists()).toBe(false)
    })
    it('unmount 後の Esc は何もしない (リスナーを外している)', async () => {
      const w = await open()
      w.unmount()
      expect(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).not.toThrow()
    })
  })
  it('日付を変えると取り直し、再生中の動画は閉じる', async () => {
    const w = await mountIt()
    await w.findAll(t('play'))[0]!.trigger('click')
    await w.find(t('date')).setValue('2026-10-22')
    await flushPromises()
    expect(api.listCamClipsEvents).toHaveBeenLastCalledWith('c1', '2026-10-22')
    expect(w.find(t('video')).exists()).toBe(false)
  })
  it('日付を空にしたら取得しない', async () => {
    const w = await mountIt()
    api.listCamClipsEvents.mockClear()
    await w.find(t('date')).setValue('')
    await flushPromises()
    expect(api.listCamClipsEvents).not.toHaveBeenCalled()
  })
  it('0 件なら「この日のイベントはありません」', async () => {
    api.listCamClipsEvents.mockResolvedValue([])
    const w = await mountIt()
    expect(w.find(t('empty')).text()).toBe('この日のイベントはありません')
    expect(w.find(t('row')).exists()).toBe(false)
  })
  it('イベントの取得に失敗したら error の文言を出す', async () => {
    api.listCamClipsEvents.mockRejectedValue(new Error('API エラー (404): {"error":"カメラがありません"}'))
    const w = await mountIt()
    expect(w.find(t('error')).text()).toBe('カメラがありません')
    expect(w.find(t('empty')).exists()).toBe(false)
  })
  it('カメラの一覧の取得に失敗したら error の文言を出す', async () => {
    api.listCamClipsCameras.mockRejectedValue(new Error('API エラー (403): {"error":"admin だけです"}'))
    const w = await mountSuspended(CamClipEvents)
    await flushPromises()
    expect(w.find(t('error')).text()).toBe('admin だけです')
    expect(api.listCamClipsEvents).not.toHaveBeenCalled()
  })

  describe('今すぐ切り出す', () => {
    const run = (over = {}) => ({
      camera_id: 'c1', ok: true, events: 4, groups: 2, ready: 2, failed: 0, deferred: 1,
      fetched: 2, listing_failed: false, error: null, ...over,
    })
    it('カメラ未選択なら押せない', async () => {
      const w = await mountIt([cam('c1', '正門'), cam('c2', '裏門')])
      expect(w.find(t('run')).attributes('disabled')).toBeDefined()
      await w.find(t('camera')).setValue('c2')
      expect(w.find(t('run')).attributes('disabled')).toBeUndefined()
    })
    it('選択中のカメラで実行し、結果を 1 行出して一覧を取り直す', async () => {
      api.runCamClipsAuto.mockResolvedValue({ cameras: [run()] })
      const w = await mountIt()
      api.listCamClipsEvents.mockClear()
      await w.find(t('run')).trigger('click')
      await flushPromises()
      expect(api.runCamClipsAuto).toHaveBeenCalledWith('c1')
      expect(w.find(t('run-result')).text()).toBe('切り出し 2 本 / 失敗 0 / 次回へ 1')
      expect(api.listCamClipsEvents).toHaveBeenCalledWith('c1', jstTodayDate())
    })
    it('実行中は押せない', async () => {
      let done!: (v: unknown) => void
      api.runCamClipsAuto.mockReturnValue(new Promise((r) => { done = r }))
      const w = await mountIt()
      await w.find(t('run')).trigger('click')
      expect(w.find(t('run')).attributes('disabled')).toBeDefined()
      done({ cameras: [run()] })
      await flushPromises()
      expect(w.find(t('run')).attributes('disabled')).toBeUndefined()
    })
    it('実行に失敗したら error の文言を出す', async () => {
      api.runCamClipsAuto.mockRejectedValue(new Error('API エラー (404): {"error":"カメラがありません"}'))
      const w = await mountIt()
      await w.find(t('run')).trigger('click')
      await flushPromises()
      expect(w.find(t('error')).text()).toBe('カメラがありません')
      expect(w.find(t('run-result')).exists()).toBe(false)
    })
    it('時間切れなら裏で続いている可能性を伝える', async () => {
      api.runCamClipsAuto.mockRejectedValue(new Error(FETCH_TIMEOUT_MESSAGE_WRITE))
      const w = await mountIt()
      await w.find(t('run')).trigger('click')
      await flushPromises()
      expect(w.find(t('error')).text()).toBe('時間がかかっています。裏で続いている可能性があるので、少し後に一覧を更新してください')
    })
  })
})

describe('CamClipEvents 端末の表示名', () => {
  it('鍵の登録簿にラベルが無い端末は「名前未登録の端末」+ 2 行目に device_id', async () => {
    api.listCamClipsEvents.mockResolvedValue([ev({ source_id: 'a', device_id: 'dev-9' })])
    const w = await mountIt()
    expect(api.listDeviceLabels).toHaveBeenCalledTimes(1)
    expect(w.find(t('device-name')).text()).toBe('名前未登録の端末')
    expect(w.find(t('device')).text()).toBe('dev-9')
  })
  it('ラベルの取得に失敗しても一覧は出る (名前は「名前未登録の端末」)', async () => {
    api.listDeviceLabels.mockRejectedValue(new Error('403'))
    const w = await mountIt()
    expect(w.findAll(t('row'))).toHaveLength(4)
    expect(w.find(t('device-name')).text()).toBe('名前未登録の端末')
    expect(w.find(t('error')).exists()).toBe(false)
  })
})
