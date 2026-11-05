import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const api = vi.hoisted(() => ({ reportEquipmentFailure: vi.fn() }))
vi.mock('~/utils/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/utils/api')>()
  return { apiErrorCode: real.apiErrorCode, ...api }
})

import {
  reportFailure, reportApiFailure, flushPending, httpStatusOf, resetFailureReportState, pendingFailureCount,
  DEDUP_WINDOW_MS, MAX_PENDING, DETECTED_BY,
} from '~/utils/equipment-failure-report'

/** 送信は fire-and-forget なので、マイクロタスクを空にしてから見る */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const http = (status: number) => Object.assign(new Error(`API エラー (${status}): x`), { status })

describe('equipment-failure-report (故障の自動記録)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-05T09:00:00Z'))
    resetFailureReportState()
    api.reportEquipmentFailure.mockResolvedValue({})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('reportFailure', () => {
    it('★ 種別・説明・検知時刻・検知者を付けて送る。機器名とセッション ID は分かっていれば付ける', async () => {
      reportFailure({ type: 'measurement_recording_failed', description: '説明', device: 'FC-1200', sessionId: 'sess-1' })
      await settle()
      expect(api.reportEquipmentFailure).toHaveBeenCalledWith({
        failure_type: 'measurement_recording_failed',
        description: '説明',
        detected_at: '2026-11-05T09:00:00.000Z',
        detected_by: DETECTED_BY,
        affected_device: 'FC-1200',
        session_id: 'sess-1',
      })
    })

    it('機器名・セッション ID が無ければ送らない', async () => {
      reportFailure({ type: 'kiosk_offline', description: '説明' })
      await settle()
      const body = api.reportEquipmentFailure.mock.calls[0]![0]
      expect(body).not.toHaveProperty('affected_device')
      expect(body).not.toHaveProperty('session_id')
    })

    it('★ 同じ種別 + 説明は 5 分のあいだ 1 回だけ。過ぎたら、また送る', async () => {
      const r = { type: 'face_recognition_error', description: '同じ失敗' } as const
      reportFailure(r)
      reportFailure(r)
      await settle()
      expect(api.reportEquipmentFailure).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + DEDUP_WINDOW_MS - 1)
      reportFailure(r)
      await settle()
      expect(api.reportEquipmentFailure).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + 2)
      reportFailure(r)
      await settle()
      expect(api.reportEquipmentFailure).toHaveBeenCalledTimes(2)
    })

    it('期限の切れた古い印は次の記録のときに掃除され、同じ失敗はまた送れる', async () => {
      reportFailure({ type: 'kiosk_offline', description: '古い' })
      vi.setSystemTime(Date.now() + DEDUP_WINDOW_MS + 1)
      reportFailure({ type: 'kiosk_offline', description: '新しい' })
      reportFailure({ type: 'kiosk_offline', description: '古い' })
      await settle()
      expect(api.reportEquipmentFailure).toHaveBeenCalledTimes(3)
    })

    it('説明が違えば別の失敗として送る。種別が違っても別', async () => {
      reportFailure({ type: 'kiosk_offline', description: 'A' })
      reportFailure({ type: 'kiosk_offline', description: 'B' })
      reportFailure({ type: 'database_sync_error', description: 'A' })
      await settle()
      expect(api.reportEquipmentFailure).toHaveBeenCalledTimes(3)
    })

    it('★ 例外を出さない (送信が落ちても・日時が壊れていても)', async () => {
      api.reportEquipmentFailure.mockRejectedValue(new Error('down'))
      expect(() => reportFailure({ type: 'kiosk_offline', description: 'X' })).not.toThrow()
      await settle()

      vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock') })
      expect(() => reportFailure({ type: 'kiosk_offline', description: 'Y' })).not.toThrow()
      expect(console.warn).toHaveBeenCalledWith('[FailureReport] 故障の記録に失敗しました:', expect.any(Error))
    })

    it('4xx で拒まれた記録は預からず捨てる(警告だけ)', async () => {
      api.reportEquipmentFailure.mockRejectedValue(http(400))
      reportFailure({ type: 'kiosk_offline', description: 'X' })
      await settle()
      expect(pendingFailureCount()).toBe(0)
      expect(console.warn).toHaveBeenCalled()
    })
  })

  describe('通信が落ちているとき (メモリ上の待ち行列)', () => {
    it('★ 送れなかった記録を預かり、次の送信が通ったときに古い順で送り直す', async () => {
      api.reportEquipmentFailure.mockRejectedValueOnce(new Error('Failed to fetch'))
      reportFailure({ type: 'kiosk_offline', description: '1 件目' })
      await settle()
      expect(pendingFailureCount()).toBe(1)

      reportFailure({ type: 'kiosk_offline', description: '2 件目' })
      await settle()
      expect(pendingFailureCount()).toBe(0)
      expect(api.reportEquipmentFailure.mock.calls.map(c => c[0].description)).toEqual(['1 件目', '2 件目', '1 件目'])
    })

    it('★ 通信が戻った合図 (online) でも送り直す', async () => {
      api.reportEquipmentFailure.mockRejectedValueOnce(new Error('Failed to fetch'))
      reportFailure({ type: 'kiosk_offline', description: '預ける' })
      await settle()
      expect(pendingFailureCount()).toBe(1)

      window.dispatchEvent(new Event('online'))
      await settle()
      expect(pendingFailureCount()).toBe(0)
      expect(api.reportEquipmentFailure).toHaveBeenCalledTimes(2)
    })

    it('預かりは最大件数まで。あふれたら古い方を捨てる', async () => {
      api.reportEquipmentFailure.mockRejectedValue(new Error('Failed to fetch'))
      for (let i = 0; i < MAX_PENDING + 3; i++) {
        reportFailure({ type: 'kiosk_offline', description: `失敗 ${i}` })
      }
      await settle()
      expect(pendingFailureCount()).toBe(MAX_PENDING)
    })

    it('送り直しの途中でまた落ちたら、残りを預け直す。4xx で拒まれた分は捨てる', async () => {
      api.reportEquipmentFailure.mockRejectedValue(new Error('Failed to fetch'))
      for (const d of ['a', 'b', 'c']) reportFailure({ type: 'kiosk_offline', description: d })
      await settle()
      expect(pendingFailureCount()).toBe(3)

      api.reportEquipmentFailure.mockReset()
      api.reportEquipmentFailure
        .mockRejectedValueOnce(http(400))
        .mockRejectedValueOnce(new Error('Failed to fetch'))
      await flushPending()
      // a は 4xx で捨て、b で落ちて b・c が残る
      expect(pendingFailureCount()).toBe(2)

      api.reportEquipmentFailure.mockResolvedValue({})
      await flushPending()
      expect(pendingFailureCount()).toBe(0)
    })
  })

  describe('httpStatusOf', () => {
    it('.status を優先し、無ければ「API エラー (nnn)」の文言から読む。どちらも無ければ null', () => {
      expect(httpStatusOf(Object.assign(new Error('x'), { status: 503 }))).toBe(503)
      expect(httpStatusOf(new Error('API エラー (404): not found'))).toBe(404)
      expect(httpStatusOf(new Error('Failed to fetch'))).toBeNull()
      expect(httpStatusOf('boom')).toBeNull()
      expect(httpStatusOf(null)).toBeNull()
    })
  })

  describe('reportApiFailure (API 呼び出しの失敗の分類)', () => {
    it('★ 4xx は記録しない (入力の不備・権限・存在しない ID は故障ではない)', async () => {
      reportApiFailure(http(400), '体温・血圧の記録')
      reportApiFailure(http(404), '乗務員の照会', { type: 'measurement_recording_failed' })
      await settle()
      expect(api.reportEquipmentFailure).not.toHaveBeenCalled()
    })

    it('★ 点呼の記録が書けなかった (500 record_failed) は記録しない (サーバーが機器故障として記録済み)', async () => {
      reportApiFailure(Object.assign(new Error('API エラー (500): {"error":"record_failed","message":"x"}'), { status: 500 }), '指示確認の送信')
      await settle()
      expect(api.reportEquipmentFailure).not.toHaveBeenCalled()
    })

    it('★ 応答が無い失敗 (fetch の TypeError・タイムアウト) は kiosk_offline', async () => {
      reportApiFailure(new TypeError('Failed to fetch'), '予定の取得', { sessionId: 'sess-1' })
      await settle()
      expect(api.reportEquipmentFailure).toHaveBeenCalledWith(expect.objectContaining({
        failure_type: 'kiosk_offline',
        description: '予定の取得に失敗しました (サーバーに接続できません)',
        session_id: 'sess-1',
      }))
    })

    it('★ 5xx は database_sync_error', async () => {
      reportApiFailure(http(502), '点呼の開始')
      await settle()
      expect(api.reportEquipmentFailure).toHaveBeenCalledWith(expect.objectContaining({
        failure_type: 'database_sync_error',
        description: '点呼の開始に失敗しました (サーバーエラー 502)',
      }))
    })

    it('何が失敗したか分かっている場面は種別と機器名を上書きできる', async () => {
      reportApiFailure(http(500), '顔写真の保存', { type: 'photo_storage_error', device: 'カメラ' })
      await settle()
      expect(api.reportEquipmentFailure).toHaveBeenCalledWith(expect.objectContaining({
        failure_type: 'photo_storage_error', affected_device: 'カメラ',
      }))
    })
  })
})
