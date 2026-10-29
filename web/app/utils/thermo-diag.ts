/**
 * 置き場に `dev <行>` で残す体温計の状態の JSON の `type` (`{"type":"found","device":"thermometer"}` 等)。
 * CoreS3 (useCoreS3Serial) と Vein Station (useVeinSerial) が同じ判定で置き場に残す。
 * 体温が PC に届かなかった回に、体温計を見つけたのか・つながったのか・失敗したのかを
 * 遠隔 (get_log の pwa_log) から追うため。測定値の行 (`temperature`) は利用者の情報なので入れない
 */
const DIAG_THERMO_TYPES = ['found', 'connected', 'disconnected']

/**
 * 体温計の状態の JSON 行か。`error` は `{"type":"error","message":"thermometer: connection failed"}`
 * のように message の先頭で機器を名乗る。読めない行は false (診断の置き場が本処理を落とさない)
 */
export function isThermoDiagLine(line: string): boolean {
  try {
    // `{` で始まる行だけが来るので msg は必ず object
    const msg = JSON.parse(line) as { type?: unknown, device?: unknown, message?: unknown }
    if (msg.type === 'error') return typeof msg.message === 'string' && msg.message.startsWith('thermometer')
    return DIAG_THERMO_TYPES.includes(msg.type as string) && msg.device === 'thermometer'
  }
  catch {
    return false
  }
}
