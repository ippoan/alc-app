/**
 * 開発用の端末だけの診断の口 `window.alcVein.send` (Refs ippoan/alc-app#436)。
 *
 * 送れるのはモジュール自身の照合の試験コマンド (`VEIN TEST …`) と `VEIN FINGER?` だけ。
 * 鍵の署名 (`AUTH SIGN`) など、ほかの行は送らずに reject する。残す理由: 機体の撮像・
 * モジュールの照合の確かめは今後も要る。
 *
 * 開発用の端末 (`isDevDevice('kiosk')`) のときだけ生やし、印が後から外れたら
 * (`DEV_DEVICE_MARK_EVENT`) 消す。開発用でない端末には最初から生やさない。
 * UI は無く、応答はそのまま返す (自分から画面にもコンソールにも出さない)。
 */

import { DEV_DEVICE_MARK_EVENT, isDevDevice } from '~/utils/token-selection'

/** 応答待ちの既定 (ms)。照合は指を待つので長め */
export const VEIN_DEV_SEND_TIMEOUT_MS = 30_000

/** 失敗行の接頭辞。試験コマンドの失敗は `ERR VEIN TEST …` に限らないので `ERR ` で受ける */
const ERR_PREFIX = 'ERR '

export interface AlcVeinDevPort {
  send: (line: string, matchPrefix: string, timeoutMs?: number) => Promise<string>
}

declare global {
  interface Window {
    alcVein?: AlcVeinDevPort
  }
}

/** 送ってよい行か。`VEIN TEST ` で始まる行か、`VEIN FINGER?` と完全一致。改行を含む行は不可 */
export function isAllowedVeinDevLine(line: string): boolean {
  if (/[\r\n]/.test(line)) return false
  return line === 'VEIN FINGER?' || line.startsWith('VEIN TEST ')
}

export type VeinRequest = (line: string, matchPrefix: string, timeoutMs: number, errPrefix?: string) => Promise<string>

/**
 * allowlist (`isAllowedVeinDevLine`) を通した行だけを `request` に渡す、診断の口の唯一の送信関数。
 * `window.alcVein.send` と、試験専用のタブ (`useVeinTest`) が同じ関数を使う — 別の allowlist を持たない。
 * 通らない行は送らずに reject する
 */
export function sendVeinDevLine(
  request: VeinRequest,
  line: string,
  matchPrefix: string,
  timeoutMs: number = VEIN_DEV_SEND_TIMEOUT_MS,
): Promise<string> {
  if (!isAllowedVeinDevLine(line)) {
    return Promise.reject(new Error('alcVein.send: 送れるのは VEIN TEST … と VEIN FINGER? だけです'))
  }
  return request(line, matchPrefix, timeoutMs, ERR_PREFIX)
}

/**
 * 印を見て `window.alcVein` を生やす/消す。返り値で解除する (イベントの購読と生やしたものを外す)。
 * 呼ぶのは 1 か所 (app.vue)。
 */
export function installVeinDevPort(request: VeinRequest): () => void {
  const port: AlcVeinDevPort = {
    send(line, matchPrefix, timeoutMs = VEIN_DEV_SEND_TIMEOUT_MS) {
      return sendVeinDevLine(request, line, matchPrefix, timeoutMs)
    },
  }
  const sync = (): void => {
    if (isDevDevice('kiosk')) window.alcVein = port
    else delete window.alcVein
  }
  sync()
  window.addEventListener(DEV_DEVICE_MARK_EVENT, sync)
  return () => {
    window.removeEventListener(DEV_DEVICE_MARK_EVENT, sync)
    delete window.alcVein
  }
}
