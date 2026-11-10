import { isClient } from '~/utils/env'

/**
 * 照合が通ったとき、同じ置き方で撮った 1 本で記録の一番古い 1 本を入れ替えるか (`rotateVeinModuleRecord`、
 * Refs ippoan/alc-app-s3#352)。端末ごとに localStorage へ持つ (デバイス設定で切り替える)。既定は入れ替えない。
 *
 * 入れ替え続けると、登録で撮った 6 本がだんだん照合のときの撮影に置き換わる。開発用の端末で照合が外れやすく
 * なった件 (2026-11-05) で、記録の側が原因かを確かめるために止められるようにした。
 * 入れ替える 1 本が他人に近くないかをサーバーが確かめていないので、入れ替えで精度が上がると確かめられるまで
 * 既定を止める側にした (2026-11-10)。前の既定 (キーが無い = 入れ替える) の端末も止まる。入れ替えるのは `1` のときだけ。
 */
const STORAGE_KEY = 'alc-vein-rotate'

/** 入れ替えるか。未設定・壊れた値・localStorage が使えない環境は既定の false */
export function readVeinRotateEnabled(): boolean {
  if (!isClient) return false
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  }
  catch {
    return false
  }
}

/** 保存する。保存できない環境でも例外にしない */
export function writeVeinRotateEnabled(on: boolean): void {
  if (!isClient) return
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1')
    else localStorage.removeItem(STORAGE_KEY)
  }
  catch {
    // 保存できなくても続ける
  }
}
