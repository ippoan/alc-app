import { sameVeinDevice } from '~/utils/vein-device-label'

/**
 * 管理者の画面のタブ「拠点カメラの録画」(Refs ippoan/alc-cam#2) の整形と入力の組み立て。
 * 口は alc-cam の Worker `alc-cam-sd-ingest` (`/api/proxy/cam-clips/*`、中身は ingest/api/src/lib.rs)。
 */

/** `GET /cameras` の 1 台。パスワードは返らない (`has_password` だけ) */
export interface CamClipsCamera {
  id: string
  name: string
  vpc_binding: string | null
  rec_username: string | null
  has_password: boolean
  recording: boolean
  /** RTSP の接続先 (拠点 PC の配信が繋ぐ先。アカウントは rec_username / パスワードを使い回す) */
  lan_ip: string | null
  rtsp_port: number
  rtsp_path: string | null
  device_ids: string[]
  rec_scanned_until: string | null
}

/** 運行管理者 (manager) に返るカメラ一覧の 1 件。読み取り専用で、録画・宛先の項目は載らない */
export type CamClipsCameraSummary = Pick<CamClipsCamera, 'id' | 'name' | 'device_ids'>

export interface CamClipsCameraSummaryList {
  cameras: CamClipsCameraSummary[]
}

export interface CamClipsCameraList {
  /** 宛先 (vpc_binding) を書けるか (開発者の Google ログインのときだけ true) */
  can_edit_destination: boolean
  cameras: CamClipsCamera[]
}

export interface CamClipsDeviceCounts {
  alcohol: number
  blood_pressure: number
  timecard: number
  license: number
  vein_enroll: number
}

/** 録画タブの端末候補に出す CoreS3 の鍵 (`GET /api/cam-host-keys`)。device_id は `alarm:<fingerprint>` */
export interface CamHostKey {
  device_id: string
  label: string | null
}

/** 名前付け用の鍵 (全用途・失効済みを含む。`GET /api/cam-host-keys` の `names`) */
export interface KnownDeviceName {
  device_id: string
  label: string | null
  /** 失効済みの鍵 (無ければ false) */
  revoked?: boolean
}

export interface CamClipsDeviceCandidate {
  device_id: string
  counts: CamClipsDeviceCounts
  last_at: string
  /** 開発端末か (ingest が返さない間は無い = false 扱い) */
  is_dev?: boolean
}

/** `POST /clips` の応答 (使う項目だけ) */
export interface CamClipsClip {
  clip_id: string
  /** `clips/<tenant>/<camera_id>/<開始>_<終了>.mp4` */
  key: string
  size: number
  actual_from: string
  actual_to: string
  reused: boolean
}

/** イベントに付いた自動の切り出し。同じ clip が複数のイベントに付くことがある */
export interface CamClipsEventClip {
  clip_id: string
  key: string
  status: 'ready' | 'failed'
  error: string | null
}

/** `GET /events?camera_id=&date=` の 1 件 (応答は配列そのもの・時刻順) */
export interface CamClipsEvent {
  source_table: 'hub_measurements' | 'vein_enroll_events'
  source_id: string
  kind: 'alcohol' | 'blood_pressure' | 'timecard' | 'license' | 'vein_enroll'
  /** `+09:00` 付き */
  occurred_at: string
  device_id: string
  is_dev: boolean
  /** null = まだ切り出していない */
  clip: CamClipsEventClip | null
}

/** `POST /auto-run` の応答の 1 台ぶん (cron と同じ自動切り出しを手動で回した結果) */
export interface CamClipsAutoRunCamera {
  camera_id: string
  ok: boolean
  events: number
  groups: number
  ready: number
  failed: number
  deferred: number
  fetched: number
  listing_failed: boolean
  error: string | null
}

export interface CamClipsAutoRun {
  cameras: CamClipsAutoRunCamera[]
}

/** `POST /cameras` の本文 */
export interface CamClipsCreateBody {
  name: string
  vpc_binding?: string
  rec_username?: string
  rec_password?: string
  lan_ip?: string
  rtsp_port?: number
  rtsp_path?: string
  device_ids?: string[]
}

/** `PATCH /cameras/{id}` の本文 (省略 = 変えない) */
export interface CamClipsPatchBody {
  name?: string
  vpc_binding?: string | null
  rec_username?: string
  rec_password?: string
  /** null = 消す */
  lan_ip?: string | null
  /** null = 既定 (554) に戻す */
  rtsp_port?: number | null
  /** null = 消す */
  rtsp_path?: string | null
  device_ids?: string[]
}

/** 追加・編集フォームの値 */
export interface CamClipsForm {
  name: string
  vpc_binding: string
  rec_username: string
  /** 書き込み専用。空なら送らない */
  rec_password: string
  lan_ip: string
  /** 空 = 既定 (554) */
  rtsp_port: string
  rtsp_path: string
  device_ids: string[]
  /** 「取り込みをやめる」(vpc_binding を null にする) */
  stop: boolean
}

export const EMPTY_FORM: CamClipsForm = {
  name: '', vpc_binding: '', rec_username: '', rec_password: '', lan_ip: '', rtsp_port: '', rtsp_path: '', device_ids: [], stop: false,
}

/** RTSP の既定のポート (サーバーも null をこの値にする) */
export const DEFAULT_RTSP_PORT = 554

/** RTSP のポートの入力の検査。空 (= 既定) か 1〜65535 の整数なら null、違えば画面に出す文 */
export function rtspPortError(port: string): string | null {
  const p = port.trim()
  if (!p) return null
  return /^\d+$/.test(p) && Number(p) >= 1 && Number(p) <= 65535 ? null : 'RTSP のポートは 1〜65535 にしてください'
}

/** 一覧に出す RTSP の接続先。IP とパスが揃っていなければ「未設定」 */
export function rtspLabel(c: Pick<CamClipsCamera, 'lan_ip' | 'rtsp_port' | 'rtsp_path'>): string {
  if (!c.lan_ip || !c.rtsp_path) return '未設定'
  return `${c.lan_ip}:${c.rtsp_port}/${c.rtsp_path.replace(/^\//, '')}`
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const pad = (n: number) => String(n).padStart(2, '0')

/** 画面に出す JST の `YYYY-MM-DD HH:mm:ss`。無ければ「—」、読めなければそのまま */
export function formatJst(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  const d = new Date(ms + JST_OFFSET_MS)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/**
 * `<input type="datetime-local">` の値 (`YYYY-MM-DDTHH:mm`、秒は付くことがある) → `+09:00` 付きの ISO。
 * 形が違えば null。**ブラウザのローカル時刻は使わない** (サーバーは時差が無ければ JST、画面も JST で揃える)
 */
export function jstInputToIso(local: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?$/.exec(local)
  if (!m) return null
  const iso = `${m[1]}:${m[2] ?? '00'}+09:00`
  return Number.isNaN(Date.parse(iso)) ? null : iso
}

/** 切り出しの初期値: 今の分までを終了、5 分前を開始にした datetime-local の値 (JST) */
export function defaultClipRange(now: Date = new Date()): { from: string, to: string } {
  const toLocal = (ms: number) => new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 16)
  const end = Math.floor(now.getTime() / 60_000) * 60_000
  return { from: toLocal(end - 5 * 60_000), to: toLocal(end) }
}

/** 切り出しの入力の検査。問題があれば画面に出す文、無ければ null */
export function clipRangeError(cameraId: string, from: string, to: string): string | null {
  if (!cameraId) return 'カメラを選んでください'
  const f = jstInputToIso(from)
  const t = jstInputToIso(to)
  if (!f || !t) return '開始と終了の日時を入れてください'
  if (Date.parse(f) >= Date.parse(t)) return '終了は開始より後にしてください'
  return null
}

/** 切り出しの本文。`clipRangeError` が null のときだけ呼ぶ */
export function buildClipBody(cameraId: string, from: string, to: string): { camera_id: string, from: string, to: string } {
  return { camera_id: cameraId, from: jstInputToIso(from)!, to: jstInputToIso(to)! }
}

/** 再生の URL (cookie 認証。Range 対応なのでシークできる) */
export function clipSrc(key: string): string {
  return `/api/proxy/cam-clips/${key}`
}

/** カメラ 1 台のフォームの初期値 (パスワードは返らないので空) */
export function formFromCamera(c: CamClipsCamera): CamClipsForm {
  return {
    name: c.name,
    vpc_binding: c.vpc_binding ?? '',
    rec_username: c.rec_username ?? '',
    rec_password: '',
    lan_ip: c.lan_ip ?? '',
    rtsp_port: String(c.rtsp_port),
    rtsp_path: c.rtsp_path ?? '',
    device_ids: [...c.device_ids],
    stop: false,
  }
}

/** 追加の本文。空の項目は送らない。宛先は `canEditDestination` のときだけ */
export function buildCreateBody(f: CamClipsForm, canEditDestination: boolean): CamClipsCreateBody {
  const body: CamClipsCreateBody = { name: f.name.trim() }
  const binding = f.vpc_binding.trim()
  if (canEditDestination && binding) body.vpc_binding = binding
  if (f.rec_username.trim()) body.rec_username = f.rec_username.trim()
  if (f.rec_password) body.rec_password = f.rec_password
  if (f.lan_ip.trim()) body.lan_ip = f.lan_ip.trim()
  if (f.rtsp_port.trim()) body.rtsp_port = Number(f.rtsp_port.trim())
  if (f.rtsp_path.trim()) body.rtsp_path = f.rtsp_path.trim()
  if (f.device_ids.length > 0) body.device_ids = f.device_ids
  return body
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])
}

/**
 * 編集の本文 = 元のカメラとの差分だけ。
 * - 宛先は `canEditDestination` のときだけ。「取り込みをやめる」は null、空欄は変えない
 * - パスワードは空なら送らない (サーバーも "" は変えない)
 * - RTSP の IP・パスは空にしたら null (消す)、ポートは空にしたら null (既定の 554 に戻す)
 */
export function buildPatchBody(orig: CamClipsCamera, f: CamClipsForm, canEditDestination: boolean): CamClipsPatchBody {
  const patch: CamClipsPatchBody = {}
  if (f.name.trim() !== orig.name) patch.name = f.name.trim()
  if (canEditDestination) {
    const binding = f.vpc_binding.trim()
    if (f.stop) {
      if (orig.vpc_binding !== null) patch.vpc_binding = null
    }
    else if (binding && binding !== orig.vpc_binding) {
      patch.vpc_binding = binding
    }
  }
  if (f.rec_username.trim() !== (orig.rec_username ?? '')) patch.rec_username = f.rec_username.trim()
  if (f.rec_password) patch.rec_password = f.rec_password
  const lanIp = f.lan_ip.trim()
  if (lanIp !== (orig.lan_ip ?? '')) patch.lan_ip = lanIp || null
  const port = f.rtsp_port.trim()
  if (!port) {
    if (orig.rtsp_port !== DEFAULT_RTSP_PORT) patch.rtsp_port = null
  }
  else if (Number(port) !== orig.rtsp_port) {
    patch.rtsp_port = Number(port)
  }
  const path = f.rtsp_path.trim()
  if (path !== (orig.rtsp_path ?? '')) patch.rtsp_path = path || null
  if (!sameSet(f.device_ids, orig.device_ids)) patch.device_ids = f.device_ids
  return patch
}

/** イベントの種類の表示名 (並びは候補の 1 行に出す順) */
const KIND_LABELS: Record<keyof CamClipsDeviceCounts, string> = {
  alcohol: 'アルコール', blood_pressure: '血圧', timecard: '打刻', license: '免許証', vein_enroll: '指静脈登録',
}

/** 候補の中身を 1 行にする (件数が 0 の種類は出さない) */
export function summarizeCounts(c: CamClipsDeviceCounts): string {
  return (Object.keys(KIND_LABELS) as (keyof CamClipsDeviceCounts)[])
    .filter(k => c[k] > 0).map(k => `${KIND_LABELS[k]} ${c[k]}`).join(' / ') || '件数なし'
}

/** イベントの種類の表示名。知らない種類はそのまま */
export function eventKindLabel(kind: string): string {
  return Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind as keyof CamClipsDeviceCounts] : kind
}

/** 「今すぐ切り出す」の結果 1 行 */
export function summarizeAutoRun(r: CamClipsAutoRunCamera): string {
  if (!r.ok) return `実行できませんでした: ${r.error}`
  return `切り出し ${r.ready} 本 / 失敗 ${r.failed} / 次回へ ${r.deferred}${r.listing_failed ? ' (SD の一覧が取れず)' : ''}`
}

/** 登録簿に名前が無い端末の表示名 */
export const UNNAMED_DEVICE = '名前未登録の端末'

/** ログイン利用者のブラウザ打刻の固定 ID (`server/utils/timecard-relay.ts` の `BROWSER_DEVICE_ID`)。鍵ではない */
export const BROWSER_DEVICE_ID = 'browser'
export const BROWSER_DEVICE_NAME = 'ブラウザ (ログイン利用者の打刻)'

/**
 * 端末の表示名。登録簿 (ファームの一覧) と device_id が一致すればその名前、無ければ `UNNAMED_DEVICE`。
 * 失効済みの鍵は名前の後ろに「 (失効)」。`browser` は鍵ではないので、鍵の有無に関わらず固定の名前。
 * device_id は付けない (画面で別の行に出す。くっつけると境目が見えない)
 */
export function deviceDisplayName(deviceId: string, known: KnownDeviceName[]): string {
  if (deviceId === BROWSER_DEVICE_ID) return BROWSER_DEVICE_NAME
  const hit = known.find(k => k.label && sameVeinDevice(k.device_id, deviceId))
  if (!hit) return UNNAMED_DEVICE
  return hit.revoked ? `${hit.label} (失効)` : hit.label!
}

/**
 * 失敗の文言。api.ts は `API エラー (409): {"error":"…"}` の形で投げるので、本文の `error` を取り出す。
 * 読めなければ Error の文言をそのまま、それも無ければ fallback
 */
export function errorText(e: unknown, fallback: string): string {
  const text = e instanceof Error ? e.message : ''
  const start = text.indexOf('{')
  if (start >= 0) {
    try {
      const err = (JSON.parse(text.slice(start)) as { error?: unknown }).error
      if (typeof err === 'string' && err) return err
    }
    catch { /* 本文が JSON でなければ下へ */ }
  }
  return text || fallback
}
