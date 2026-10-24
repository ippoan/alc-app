// 管理者の画面のタブ「拠点カメラの録画」の純関数 (Refs ippoan/alc-cam#2)。
import { describe, it, expect } from 'vitest'
import {
  buildClipBody, buildCreateBody, buildPatchBody, clipRangeError, clipSrc, defaultClipRange,
  DEFAULT_RTSP_PORT, deviceDisplayName, EMPTY_FORM, isCamHostKeyId, moveStreamDevice, streamPrimary, rtspLabel, rtspPortError, errorText, eventKindLabel, UNNAMED_DEVICE, formatJst, formFromCamera, jstInputToIso, summarizeCounts, summarizeAutoRun,
  type CamClipsCamera, type CamClipsForm,
} from '~/utils/cam-clips'

const CAM: CamClipsCamera = {
  id: 'c1', name: '正門', vpc_binding: 'CAM_A', rec_username: 'admin', has_password: true,
  recording: true, lan_ip: '192.168.1.64', rtsp_port: 554, rtsp_path: 'stream1',
  device_ids: ['d1', 'd2'], rec_scanned_until: '2026-10-23T12:58:00.000+09:00',
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

describe('RTSP の接続先', () => {
  it('追加: 入れた項目だけ送る (ポートは数にする)', () => {
    expect(buildCreateBody({ ...EMPTY_FORM, name: 'x', lan_ip: ' 192.168.1.64 ', rtsp_port: ' 8554 ', rtsp_path: ' stream1 ' }, true)).toEqual({
      name: 'x', lan_ip: '192.168.1.64', rtsp_port: 8554, rtsp_path: 'stream1',
    })
  })
  it('編集: 変えた項目だけ。IP・パスを空にしたら null (消す)、ポートを空にしたら null (既定に戻す)', () => {
    expect(buildPatchBody(CAM, form({ lan_ip: '192.168.1.65', rtsp_port: '8554', rtsp_path: 'stream2' }), true)).toEqual({
      lan_ip: '192.168.1.65', rtsp_port: 8554, rtsp_path: 'stream2',
    })
    expect(buildPatchBody(CAM, form({ lan_ip: '', rtsp_path: '' }), true)).toEqual({ lan_ip: null, rtsp_path: null })
    // 既定のポートのまま空にしても送らない / 既定でないポートを空にしたら既定へ戻す
    expect(buildPatchBody(CAM, form({ rtsp_port: '' }), true)).toEqual({})
    expect(buildPatchBody({ ...CAM, rtsp_port: 8554 }, form({ rtsp_port: '' }), true)).toEqual({ rtsp_port: null })
    // 元から無い (null) とき、空のままなら変えない
    const c = { ...CAM, lan_ip: null, rtsp_path: null }
    expect(buildPatchBody(c, formFromCamera(c), true)).toEqual({})
  })
  it('ポートの検査 (空 = 既定は通す)', () => {
    expect(DEFAULT_RTSP_PORT).toBe(554)
    expect(rtspPortError('')).toBeNull()
    expect(rtspPortError(' 554 ')).toBeNull()
    expect(rtspPortError('65535')).toBeNull()
    for (const bad of ['0', '65536', 'abc', '5.5', '-1']) expect(rtspPortError(bad)).toBe('RTSP のポートは 1〜65535 にしてください')
  })
  it('一覧の表示: IP とパスが揃ったときだけ', () => {
    expect(rtspLabel(CAM)).toBe('192.168.1.64:554/stream1')
    expect(rtspLabel({ ...CAM, rtsp_path: '/live/ch1' })).toBe('192.168.1.64:554/live/ch1')
    expect(rtspLabel({ ...CAM, lan_ip: null })).toBe('未設定')
    expect(rtspLabel({ ...CAM, rtsp_path: null })).toBe('未設定')
  })
})

describe('配信担当 (順位)', () => {
  const STREAM = { ...CAM, stream_device_ids: ['alarm:a', 'alarm:b'] }
  it('フォームは写し (並びのまま)。ingest が返さない間は空', () => {
    const f = formFromCamera(STREAM)
    expect(f.stream_device_ids).toEqual(['alarm:a', 'alarm:b'])
    expect(f.stream_device_ids).not.toBe(STREAM.stream_device_ids)
    expect(formFromCamera(CAM).stream_device_ids).toEqual([])
  })
  it('追加: 入れたときだけ送る', () => {
    expect(buildCreateBody({ ...EMPTY_FORM, name: 'x', stream_device_ids: ['alarm:b', 'alarm:a'] }, true)).toEqual({ name: 'x', stream_device_ids: ['alarm:b', 'alarm:a'] })
    expect('stream_device_ids' in buildCreateBody({ ...EMPTY_FORM, name: 'x' }, true)).toBe(false)
  })
  it('編集: 並べ替えだけでも全部を送る。外せば [] 。同じなら送らない', () => {
    const f = (ids: string[]) => ({ ...formFromCamera(STREAM), stream_device_ids: ids })
    expect(buildPatchBody(STREAM, f(['alarm:a', 'alarm:b']), true)).toEqual({})
    expect(buildPatchBody(STREAM, f(['alarm:b', 'alarm:a']), true)).toEqual({ stream_device_ids: ['alarm:b', 'alarm:a'] })
    expect(buildPatchBody(STREAM, f(['alarm:a']), true)).toEqual({ stream_device_ids: ['alarm:a'] })
    expect(buildPatchBody(STREAM, f([]), true)).toEqual({ stream_device_ids: [] })
    expect(buildPatchBody(CAM, { ...formFromCamera(CAM), stream_device_ids: ['alarm:a'] }, true)).toEqual({ stream_device_ids: ['alarm:a'] })
  })
  it('配信の鍵になれる id は alarm: の sub だけ', () => {
    expect(isCamHostKeyId('alarm:0666000000000000')).toBe(true)
    expect(isCamHostKeyId('alarm-0666000000000000')).toBe(false)
    expect(isCamHostKeyId('browser')).toBe(false)
    expect(isCamHostKeyId('dev-1')).toBe(false)
  })
  it('1 位と並べ替え', () => {
    expect(streamPrimary(STREAM)).toBe('alarm:a')
    expect(streamPrimary(CAM)).toBeNull()
    expect(streamPrimary({ stream_device_ids: [] })).toBeNull()
    const ids = ['a', 'b', 'c']
    expect(moveStreamDevice(ids, 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveStreamDevice(ids, 1, 1)).toEqual(['a', 'c', 'b'])
    expect(moveStreamDevice(ids, 0, -1)).toEqual(ids)
    expect(moveStreamDevice(ids, 2, 1)).toEqual(ids)
    expect(moveStreamDevice(ids, 5, -1)).toEqual(ids)
    expect(moveStreamDevice(ids, 1, 1)).not.toBe(ids)
    expect(ids).toEqual(['a', 'b', 'c'])
  })
})

describe('formFromCamera', () => {
  it('null は空文字、端末は写し、パスワードは空', () => {
    const c = { ...CAM, vpc_binding: null, rec_username: null }
    const f = formFromCamera(c)
    expect(f).toEqual({
      name: '正門', vpc_binding: '', rec_username: '', rec_password: '',
      lan_ip: '192.168.1.64', rtsp_port: '554', rtsp_path: 'stream1', device_ids: ['d1', 'd2'], stream_device_ids: [], stop: false,
    })
    expect(formFromCamera({ ...CAM, lan_ip: null, rtsp_path: null })).toMatchObject({ lan_ip: '', rtsp_path: '' })
    expect(f.device_ids).not.toBe(c.device_ids)
  })
})

describe('候補の表示', () => {
  it('件数は 0 の種類を出さない', () => {
    expect(summarizeCounts({ alcohol: 3, blood_pressure: 0, timecard: 2, license: 0, vein_enroll: 1 })).toBe('アルコール 3 / 打刻 2 / 指静脈登録 1')
    expect(summarizeCounts({ alcohol: 0, blood_pressure: 4, timecard: 0, license: 5, vein_enroll: 0 })).toBe('血圧 4 / 免許証 5')
    expect(summarizeCounts({ alcohol: 0, blood_pressure: 0, timecard: 0, license: 0, vein_enroll: 0 })).toBe('件数なし')
  })
  it('イベントの種類の表示名 (知らない種類はそのまま)', () => {
    expect(['alcohol', 'blood_pressure', 'timecard', 'license', 'vein_enroll'].map(eventKindLabel))
      .toEqual(['アルコール', '血圧', '打刻', '免許証', '指静脈登録'])
    expect(eventKindLabel('toString')).toBe('toString')
    expect(eventKindLabel('future_kind')).toBe('future_kind')
  })
  it('device_id が一致するときだけ表示名 (label が無ければ「名前未登録の端末」。ID は付けない)', () => {
    const known = [{ device_id: 'd1', label: '事務所' }, { device_id: 'd2', label: null }]
    expect(deviceDisplayName('d1', known)).toBe('事務所')
    expect(deviceDisplayName('d2', known)).toBe(UNNAMED_DEVICE)
    expect(deviceDisplayName('d9', known)).toBe('名前未登録の端末')
  })

  it('失効済みの鍵は名前の後ろに「 (失効)」。revoked が無い・false は付けない', () => {
    const known = [{ device_id: 'alarm:a', label: '旧機', revoked: true }, { device_id: 'alarm:b', label: '現役', revoked: false }, { device_id: 'alarm:c', label: '無印' }]
    expect(deviceDisplayName('alarm:a', known)).toBe('旧機 (失効)')
    expect(deviceDisplayName('alarm:b', known)).toBe('現役')
    expect(deviceDisplayName('alarm:c', known)).toBe('無印')
  })

  it('browser は鍵ではない固定 ID。鍵の有無に関わらず固定の名前', () => {
    expect(deviceDisplayName('browser', [])).toBe('ブラウザ (ログイン利用者の打刻)')
    expect(deviceDisplayName('browser', [{ device_id: 'browser', label: '別名' }])).toBe('ブラウザ (ログイン利用者の打刻)')
  })

  it('alarm: と alarm- の違いを吸収して別用途の鍵の名前が出る。label 無しの行は飛ばして次の名前を使う', () => {
    const fp = '0666000000000000'
    expect(deviceDisplayName(`alarm-${fp}`, [{ device_id: `alarm:${fp}`, label: null }, { device_id: `alarm:${fp}`, label: 'VoiceS3R' }])).toBe('VoiceS3R')
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

describe('summarizeAutoRun', () => {
  const base = {
    camera_id: 'c1', ok: true, events: 5, groups: 3, ready: 2, failed: 1, deferred: 0,
    fetched: 2, listing_failed: false, error: null,
  }
  it('ok なら切り出し・失敗・次回への件数', () => {
    expect(summarizeAutoRun(base)).toBe('切り出し 2 本 / 失敗 1 / 次回へ 0')
  })
  it('SD の一覧が取れなかったときは末尾に添える', () => {
    expect(summarizeAutoRun({ ...base, listing_failed: true })).toBe('切り出し 2 本 / 失敗 1 / 次回へ 0 (SD の一覧が取れず)')
  })
  it('ok でなければ error を出す', () => {
    expect(summarizeAutoRun({ ...base, ok: false, error: 'カメラに届きません' })).toBe('実行できませんでした: カメラに届きません')
  })
})
