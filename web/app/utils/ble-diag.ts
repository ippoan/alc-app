/**
 * 置き場に `dev <行>` で残す BLE 機器 (体温計・血圧計) の診断の行。
 * CoreS3 (useCoreS3Serial) と Vein Station (useVeinSerial) が同じ判定で置き場に残し、
 * 置き場の `dev ` 行は signaling の `/device-log` へ送られる (useDiagUpload)。
 * 体温・血圧が PC に届かなかった回や遅かった回に、どの段 (見つけた・つながった・暗号化・値) で
 * 止まった / 時間を使ったかを後から追うため。**測定値は利用者の情報なので残さない** —
 * 値の行は `{"type":"blood_pressure"}` のように type だけにして、届いた時刻だけを残す
 */

/** 残す EVT 行の先頭 (ファームの hub-ble。体温計の試行と結果・Omron の接続から受信までの各段) */
export const BLE_DIAG_EVT_PREFIXES = ['EVT THERMO_', 'EVT OMRON_', 'EVT BP_', 'EVT BLE_SCAN_']

const DIAG_DEVICES = ['thermometer', 'blood_pressure']
/** 状態の JSON の `type` (`{"type":"found","device":"thermometer"}` 等) */
const DIAG_STATUS_TYPES = ['found', 'connected', 'disconnected']
/** 測定値の JSON の `type`。値を落として type だけ残す */
const DIAG_VALUE_TYPES = ['temperature', 'blood_pressure']

/** 残す EVT 行か */
export function isBleDiagEvent(line: string): boolean {
  return BLE_DIAG_EVT_PREFIXES.some(prefix => line.startsWith(prefix))
}

/**
 * JSON 行を置き場に残す形にする。残さない行は null。
 * `error` は `{"type":"error","message":"thermometer: connection failed"}` のように message の先頭で
 * 機器を名乗る。読めない行は null (診断の置き場が本処理を落とさない)
 */
export function bleDiagJson(line: string): string | null {
  try {
    // `{` で始まる行だけが来るので msg は必ず object
    const msg = JSON.parse(line) as { type?: unknown, device?: unknown, message?: unknown }
    if (msg.type === 'error') {
      return typeof msg.message === 'string' && DIAG_DEVICES.some(d => (msg.message as string).startsWith(d)) ? line : null
    }
    if (DIAG_VALUE_TYPES.includes(msg.type as string)) return JSON.stringify({ type: msg.type })
    return DIAG_STATUS_TYPES.includes(msg.type as string) && DIAG_DEVICES.includes(msg.device as string) ? line : null
  }
  catch {
    return null
  }
}
