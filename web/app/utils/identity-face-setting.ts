import { isClient } from '~/utils/env'

/**
 * 点呼の本人確認 (指静脈の照合) のときの顔を、何で残すかの端末設定 (自己点検表 ト①「生体認証をする時の顔の画像」。
 * Refs ippoan/alc-app#720)。端末ごとに localStorage へ持つ (デバイス設定で切り替える)。
 *
 * - `kiosk` (既定): この端末のカメラで、照合が一致した瞬間の顔を 1 枚撮って点呼に残す。撮れなければ点呼を始めない
 * - `cam`: 端末では撮らず、監視カメラ (alc-cam) の録画から照合の前後を切り出して残す。監視カメラが付いていても
 *   配置によって顔が映らない拠点があるので、どちらを使うかは拠点ごとに選ぶ (2026-11-27 ユーザー決定)
 *
 * 照合した端末・時刻はどちらでもサーバー (tenko_identity_events) に残るので、監視カメラを結び付けた端末では
 * `kiosk` でも切り出しは作られる。
 */
export type IdentityFaceSource = 'kiosk' | 'cam'

const STORAGE_KEY = 'alc-identity-face'

/** 何で残すか。未設定・壊れた値・localStorage が使えない環境は既定の `kiosk` */
export function readIdentityFaceSource(): IdentityFaceSource {
  if (!isClient) return 'kiosk'
  try {
    return localStorage.getItem(STORAGE_KEY) === 'cam' ? 'cam' : 'kiosk'
  }
  catch {
    return 'kiosk'
  }
}

/** 保存する。既定 (`kiosk`) はキーを消す。保存できない環境でも例外にしない */
export function writeIdentityFaceSource(v: IdentityFaceSource): void {
  if (!isClient) return
  try {
    if (v === 'cam') localStorage.setItem(STORAGE_KEY, 'cam')
    else localStorage.removeItem(STORAGE_KEY)
  }
  catch {
    // 保存できなくても続ける
  }
}
