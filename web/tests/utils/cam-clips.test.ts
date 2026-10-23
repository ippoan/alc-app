// 管理者の画面のタブ「拠点カメラの録画」の純関数 (Refs ippoan/alc-cam#2)。
import { describe, it, expect } from 'vitest'
import {
  buildClipBody, buildCreateBody, buildPatchBody, clipRangeError, clipSrc, defaultClipRange,
  deviceDisplayName, EMPTY_FORM, errorText, formatJst, formFromCamera, jstInputToIso, summarizeCounts,
  type CamClipsCamera, type CamClipsForm,
} from '~/utils/cam-clips'

const CAM: CamClipsCamera = {
  id: 'c1', name: '正門', vpc_binding: 'CAM_A', rec_username: 'admin', has_password: true,
  recording: true, device_ids: ['d1', 'd2'], rec_scanned_until: '2026-10-23T12:58:00.000+09:00',
}
const form = (over: Partial<CamClipsForm> = {}): CamClipsForm => ({ ...formFromCamera(CAM), ...over })

describe('formatJst', () => {
  it('JST の日時にする (UTC 表記でも +9h)', () => {
    expect(formatJst('2026-10-23T12:58:00.000+09:00')).toBe('2026-10-23 12:58:00')
    expect(formatJst('2026-10-23T03:58:00Z')).toBe('2026-10-23 12:58:00')
    expect(formatJst('2026-10-23T20:00:00Z')).toBe('2026-10-24 05:00:00')
  })
  it('無ければ —、読めなければそのまま', () => {
    expect(formatJst(null)).toBe('—')
    expect(formatJst(undefined)).toBe('—')
    expect(formatJst('')).toBe('—')
    expect(formatJst('x')).toBe('x')
  })
})

describe('jstInputToIso / defaultClipRange', () => {
  it('datetime-local を +09:00 の ISO にする (秒が無ければ 00)', () => {
    expect(jstInputToIso('2026-10-23T12:58')).toBe('2026-10-23T12:58:00+09:00')
    expect(jstInputToIso('2026-10-23T12:58:30')).toBe('2026-10-23T12:58:30+09:00')
  })
  it('形が違う・存在しない日時は null', () => {
    expect(jstInputToIso('')).toBeNull()
    expect(jstInputToIso('2026-10-23')).toBeNull()
    expect(jstInputToIso('2026-13-45T25:61')).toBeNull()
  })
  it('初期値は JST の今の分と 5 分前', () => {
    // 2026-10-23 03:00:45 UTC = 12:00:45 JST
    expect(defaultClipRange(new Date('2026-10-23T03:00:45Z'))).toEqual({ from: '2026-10-23T11:55', to: '2026-10-23T12:00' })
    // 日付をまたぐ (UTC 15:02 = JST 翌 00:02)
    expect(defaultClipRange(new Date('2026-10-23T15:02:00Z'))).toEqual({ from: '2026-10-23T23:57', to: '2026-10-24T00:02' })
  })
  it('引数なしでも形は datetime-local', () => {
    expect(defaultClipRange().to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })
})

describe('切り出しの入力', () => {
  it('検査と本文', () => {
    expect(clipRangeError('', '2026-10-23T12:00', '2026-10-23T12:05')).toBe('カメラを選んでください')
    expect(clipRangeError('c1', '', '2026-10-23T12:05')).toBe('開始と終了の日時を入れてください')
    expect(clipRangeError('c1', '2026-10-23T12:00', 'x')).toBe('開始と終了の日時を入れてください')
    expect(clipRangeError('c1', '2026-10-23T12:05', '2026-10-23T12:05')).toBe('終了は開始より後にしてください')
    expect(clipRangeError('c1', '2026-10-23T12:00', '2026-10-23T12:05')).toBeNull()
    expect(buildClipBody('c1', '2026-10-23T12:00', '2026-10-23T12:05')).toEqual({
      camera_id: 'c1', from: '2026-10-23T12:00:00+09:00', to: '2026-10-23T12:05:00+09:00',
    })
  })
  it('再生の URL は proxy 経由', () => {
    expect(clipSrc('clips/t/c/a_b.mp4')).toBe('/api/proxy/cam-clips/clips/t/c/a_b.mp4')
  })
})

describe('buildCreateBody', () => {
  const f: CamClipsForm = { ...EMPTY_FORM, name: ' 正門 ', vpc_binding: ' CAM_A ', rec_username: ' u ', rec_password: 'pw', device_ids: ['d1'] }
  it('全部入り', () => {
    expect(buildCreateBody(f, true)).toEqual({ name: '正門', vpc_binding: 'CAM_A', rec_username: 'u', rec_password: 'pw', device_ids: ['d1'] })
  })
  it('宛先を書けないとき vpc_binding は送らない', () => {
    expect('vpc_binding' in buildCreateBody(f, false)).toBe(false)
  })
  it('空の項目は送らない (パスワード空・宛先空・端末なし)', () => {
    expect(buildCreateBody({ ...EMPTY_FORM, name: 'x' }, true)).toEqual({ name: 'x' })
  })
})

describe('buildPatchBody', () => {
  it('変えていなければ空', () => {
    expect(buildPatchBody(CAM, form(), true)).toEqual({})
  })
  it('名前・ユーザー名・端末・宛先の差分だけ', () => {
    expect(buildPatchBody(CAM, form({ name: '裏門', rec_username: 'root', device_ids: ['d3'], vpc_binding: 'CAM_B' }), true)).toEqual({
      name: '裏門', rec_username: 'root', device_ids: ['d3'], vpc_binding: 'CAM_B',
    })
  })
  it('端末は並びが違うだけなら変えない', () => {
    expect(buildPatchBody(CAM, form({ device_ids: ['d2', 'd1'] }), true)).toEqual({})
  })
  it('パスワードは入力したときだけ', () => {
    expect(buildPatchBody(CAM, form({ rec_password: '' }), true)).toEqual({})
    expect(buildPatchBody(CAM, form({ rec_password: 'new' }), true)).toEqual({ rec_password: 'new' })
  })
  it('宛先を書けないときは vpc_binding を送らない (取り込みをやめるも無効)', () => {
    expect(buildPatchBody(CAM, form({ vpc_binding: 'CAM_B', stop: true }), false)).toEqual({})
  })
  it('取り込みをやめる = null。既に無ければ送らない。空欄は変えない', () => {
    expect(buildPatchBody(CAM, form({ stop: true }), true)).toEqual({ vpc_binding: null })
    expect(buildPatchBody({ ...CAM, vpc_binding: null }, form({ vpc_binding: '', stop: true }), true)).toEqual({})
    expect(buildPatchBody(CAM, form({ vpc_binding: '' }), true)).toEqual({})
  })
  it('ユーザー名が元から無い (null) とき、空のままなら変えない', () => {
    const c = { ...CAM, rec_username: null }
    expect(buildPatchBody(c, formFromCamera(c), true)).toEqual({})
  })
})

describe('formFromCamera', () => {
  it('null は空文字、端末は写し、パスワードは空', () => {
    const c = { ...CAM, vpc_binding: null, rec_username: null }
    const f = formFromCamera(c)
    expect(f).toEqual({ name: '正門', vpc_binding: '', rec_username: '', rec_password: '', device_ids: ['d1', 'd2'], stop: false })
    expect(f.device_ids).not.toBe(c.device_ids)
  })
})

describe('候補の表示', () => {
  it('件数は 0 の種類を出さない', () => {
    expect(summarizeCounts({ alcohol: 3, blood_pressure: 0, timecard: 2, license: 0, vein_enroll: 1 })).toBe('アルコール 3 / 打刻 2 / 指静脈登録 1')
    expect(summarizeCounts({ alcohol: 0, blood_pressure: 4, timecard: 0, license: 5, vein_enroll: 0 })).toBe('血圧 4 / 免許証 5')
    expect(summarizeCounts({ alcohol: 0, blood_pressure: 0, timecard: 0, license: 0, vein_enroll: 0 })).toBe('件数なし')
  })
  it('device_id が一致するときだけ表示名 (label が無ければ null)', () => {
    const known = [{ device_id: 'd1', label: '事務所' }, { device_id: 'd2', label: null }]
    expect(deviceDisplayName('d1', known)).toBe('事務所')
    expect(deviceDisplayName('d2', known)).toBeNull()
    expect(deviceDisplayName('d9', known)).toBeNull()
  })
})

describe('errorText', () => {
  it('本文の error を取り出す', () => {
    expect(errorText(new Error('API エラー (409): {"error":"その VPC binding は既に使われています"}'), 'x')).toBe('その VPC binding は既に使われています')
  })
  it('読めなければ Error の文言、それも無ければ fallback', () => {
    expect(errorText(new Error('API エラー (502): <html>'), 'x')).toBe('API エラー (502): <html>')
    expect(errorText(new Error('API エラー (500): {broken'), 'x')).toBe('API エラー (500): {broken')
    expect(errorText(new Error('API エラー (500): {"error":3}'), 'x')).toBe('API エラー (500): {"error":3}')
    expect(errorText('文字列', 'fallback')).toBe('fallback')
  })
})
