import { listCamHostKeys, listDeviceLabels } from '~/utils/api'
import type { CamHostKey } from '~/utils/cam-clips'
import { deviceDisplayName, keyDeviceLabel, type KnownDeviceName } from '~/utils/device-name'

/**
 * 人の目に触れる端末 ID を名前にするための「名前の表」(Refs ippoan/alc-cam#2)。
 * 機体の鍵の一覧 (`/api/cam-host-keys` の keys / names) と端末の登録簿 (`/api/device-labels`) を
 * 1 回だけ取って全画面で使い回す (画面を開くたびに引き直さない)。
 * 取れなくても画面は出す (名前が「名前未登録の端末」/ 短い表記になるだけ)。
 * 両方失敗したときは覚えず、次に使う画面がもう一度引く (管理者でない token・一時的な失敗)。
 */

/** 担当付けに使える機体の鍵 (kiosk / bp-station の用途) */
const keys = ref<CamHostKey[]>([])
/** 名前付け用の鍵 (全用途・失効済みを含む) */
const keyNames = ref<KnownDeviceName[]>([])
/** 端末の登録簿のラベル (hub の credential。結び付きの無い hub の名前付けだけに使う) */
const registry = ref<KnownDeviceName[]>([])

let loading: Promise<void> | null = null

async function fetchAll(): Promise<void> {
  // `.then` で呼ぶ: 呼び出しが同期的に投げても (token が無い等) 1 つの失敗として扱い、loading を reject にしない
  const [reg, ks] = await Promise.allSettled([
    Promise.resolve().then(() => listDeviceLabels()),
    Promise.resolve().then(() => listCamHostKeys()),
  ])
  registry.value = reg.status === 'fulfilled' ? reg.value.devices : []
  keys.value = ks.status === 'fulfilled' ? ks.value.keys : []
  keyNames.value = ks.status === 'fulfilled' ? ks.value.names ?? [] : []
  // 両方失敗したら覚えない (次の画面が引き直す)
  if (reg.status === 'rejected' && ks.status === 'rejected') loading = null
}

/** 名前の表を取る。取得済み・取得中なら同じ Promise を返す。`force` で引き直す */
export function loadDeviceNames(force = false): Promise<void> {
  if (force || !loading) loading = fetchAll()
  return loading
}

/** 覚えた名前の表を捨てる (テスト用・ログインし直し用) */
export function resetDeviceNames(): void {
  loading = null
  keys.value = []
  keyNames.value = []
  registry.value = []
}

export function useDeviceNames() {
  const ready = loadDeviceNames()

  /** 端末の表示名 (`deviceDisplayName`)。表が届くと自動で替わる */
  function nameOf(deviceId: string): string {
    return deviceDisplayName(deviceId, keyNames.value, registry.value)
  }

  /** 機体の鍵のラベル (失効は「(失効)」付き)。引けなければ null (呼び手が今までの短い表記に倒す) */
  function keyLabelOf(deviceId: string | null | undefined): string | null {
    return deviceId ? keyDeviceLabel(deviceId, keyNames.value) : null
  }

  return { keys, keyNames, registry, ready, nameOf, keyLabelOf }
}
