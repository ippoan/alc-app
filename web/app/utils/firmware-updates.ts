/**
 * CoreS3 のファームの「更新があるか」の判定 (Refs ippoan/alc-app#403)。
 *
 * 管理者の画面の一覧 (`FirmwareManager.vue`) と、タブを出すかどうかの判定
 * (`AdminDashboard.vue`) が同じ規則を使うので、ここ 1 か所に置く。
 */
import type { FirmwareDevice } from '~/utils/api'
import { FIRMWARE_TARGETS } from '~/utils/firmware-targets'

/**
 * 配布ページの manifest から、flavor ごとの最新の版を取る。
 * 取れなかった flavor (非 200・例外・`version` が文字列でない) は key ごと無い。
 */
export async function fetchLatestFirmwareVersions(): Promise<Record<string, string>> {
  const latest: Record<string, string> = {}
  await Promise.all(Object.entries(FIRMWARE_TARGETS.cores3!.flavors).map(async ([flavor, image]) => {
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
 * 端末の版が最新の版と違うか。**文字列の不一致だけで判定する (大小は比べない)。**
 * 版・flavor が無い端末と、最新の版が取れていない flavor は偽。応答なし・状態は見ない。
 */
export function hasFirmwareUpdate(d: FirmwareDevice, latest: Record<string, string>): boolean {
  if (d.version === undefined || d.flavor === undefined) return false
  const target = latest[d.flavor]
  return target !== undefined && d.version !== target
}
