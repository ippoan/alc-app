import { isClient } from '~/utils/env'

/**
 * この端末で「この端末の指を足す」で足した指を、モジュールに何として置くか (Refs ippoan/alc-app#558)。
 * 端末ごとに localStorage へ持つ (デバイス設定で切り替える)。
 *
 * - `'mixed'` (既定) … サーバーが組んだ記録 (この端末の 3 本 + 他端末の新しい 3 本)。同期が書き直す
 * - `'native'` … その場で撮った記録のまま (静脈 + 指紋互換で、この端末では強い)。同期は書き換えない
 *
 * `vein-module.ts` (同期) も読むので、画面の ref ではなくここの関数で読む。
 */
export type VeinAddedFingerMode = 'mixed' | 'native'

const STORAGE_KEY = 'alc-vein-added-finger'

/** 保存された値。未設定・壊れた値・localStorage が使えない環境は既定の `'mixed'` */
export function readVeinAddedFingerMode(): VeinAddedFingerMode {
  if (!isClient) return 'mixed'
  try {
    return localStorage.getItem(STORAGE_KEY) === 'native' ? 'native' : 'mixed'
  }
  catch {
    return 'mixed'
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
