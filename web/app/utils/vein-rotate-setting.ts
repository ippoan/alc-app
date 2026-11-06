import { isClient } from '~/utils/env'

/**
 * 照合が通ったとき、同じ置き方で撮った 1 本で記録の一番古い 1 本を入れ替えるか (`rotateVeinModuleRecord`、
 * Refs ippoan/alc-app-s3#352)。端末ごとに localStorage へ持つ (デバイス設定で切り替える)。既定は入れ替える。
 *
 * 入れ替え続けると、登録で撮った 6 本がだんだん照合のときの撮影に置き換わる。開発用の端末で照合が外れやすく
 * なった件 (2026-11-05) で、記録の側が原因かを確かめるために止められるようにした。
 */
const STORAGE_KEY = 'alc-vein-rotate'

/** 入れ替えるか。未設定・壊れた値・localStorage が使えない環境は既定の true */
export function readVeinRotateEnabled(): boolean {
  if (!isClient) return true
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'
  }
  catch {
    return true
  }
}

/** 保存する。保存できない環境でも例外にしない */
export function writeVeinRotateEnabled(on: boolean): void {
  if (!isClient) return
  try {
    if (on) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, '0')
  }
  catch {
    // 保存できなくても続ける
  }
}
