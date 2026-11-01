import { isClient } from '~/utils/env'

/**
 * この端末で「この端末の指を足す」で足した指を、モジュールに何として置くか (Refs ippoan/alc-app#558)。
 * 端末ごとに localStorage へ持つ (デバイス設定で切り替える)。
 *
 * - `'native'` (既定) … その場で撮った記録のまま (この端末で撮った 6 本。静脈 + 指紋互換で、この端末では強い)。
 *   同期は書き換えない
 * - `'mixed'` … サーバーが組んだ記録 (この端末の 3 本 + 他端末の新しい 3 本)。同期が書き直す。
 *   ほかの端末で撮った指が枠の半分を占め、運行管理者席では静脈の照合がほとんど通らなかった
 *   (2026-11-02、Refs ippoan/alc-app-s3#352) ので既定から外した
 *
 * `vein-module.ts` (同期) も読むので、画面の ref ではなくここの関数で読む。
 */
export type VeinAddedFingerMode = 'mixed' | 'native'

const STORAGE_KEY = 'alc-vein-added-finger'

/** 保存された値。未設定・壊れた値・localStorage が使えない環境は既定の `'native'` */
export function readVeinAddedFingerMode(): VeinAddedFingerMode {
  if (!isClient) return 'native'
  try {
    return localStorage.getItem(STORAGE_KEY) === 'mixed' ? 'mixed' : 'native'
  }
  catch {
    return 'native'
  }
}

/** 保存する。保存できない環境でも例外にしない (そのセッションの画面の ref は呼び手が持つ) */
export function writeVeinAddedFingerMode(mode: VeinAddedFingerMode): void {
  if (!isClient) return
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  }
  catch {
    // 保存できなくても続ける
  }
}
