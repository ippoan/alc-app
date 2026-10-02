/**
 * ファームの「配布中の版と違うか」の判定 (Refs ippoan/alc-app#403, ippoan/alc-app#425)。
 *
 * 管理者の画面の一覧 (`FirmwareManager.vue`)・タブを出すかどうかの判定 (`AdminDashboard.vue`)・
 * 運転者の画面の帯 (`DeviceFirmwareNotice.vue`) が同じ規則を使うので、ここ 1 か所に置く。
 */
import type { FirmwareDevice } from '~/utils/api'
import { FIRMWARE_TARGETS } from '~/utils/firmware-targets'

/**
 * 配布ページの manifest から、`target` の flavor ごとの最新の版を取る。
 * 取れなかった flavor (非 200・例外・`version` が文字列でない) は key ごと無い。
 * 表 ({@link FIRMWARE_TARGETS}) に無い target は空の結果 (どこにも取りに行かない)。
 */
export async function fetchLatestFirmwareVersions(target: string = 'cores3'): Promise<Record<string, string>> {
  const latest: Record<string, string> = {}
  const entry = Object.hasOwn(FIRMWARE_TARGETS, target) ? FIRMWARE_TARGETS[target]! : null
  if (entry === null) return latest
  await Promise.all(Object.entries(entry.flavors).map(async ([flavor, image]) => {
    try {
      const res = await fetch(image.manifestUrl, { cache: 'no-store' })
      if (!res.ok) return
      const body = await res.json() as { version?: unknown }
      if (typeof body.version === 'string') latest[flavor] = body.version
    } catch {
      // 取れなかった flavor は「不明」のまま (呼び出し側の行は壊さない)
    }
  }))
  return latest
}

/**
 * 機体の版が配布中の版と違うか。**文字列の不一致だけで判定する (大小は比べない)。**
 * 版・flavor が取れていない機体と、配布中の版が取れていない flavor は偽。
 * **判定の式はここ 1 か所** (写しを作らない)。
 */
export function isFirmwareDifferent(
  version: string | null | undefined,
  flavor: string | null | undefined,
  latest: Record<string, string>,
): boolean {
  if (version == null || flavor == null) return false
  const target = latest[flavor]
  return target !== undefined && version !== target
}

/** 一覧の 1 行 (端末の報告) について {@link isFirmwareDifferent}。応答なし・状態は見ない。 */
export function hasFirmwareUpdate(d: FirmwareDevice, latest: Record<string, string>): boolean {
  return isFirmwareDifferent(d.version, d.flavor, latest)
}
