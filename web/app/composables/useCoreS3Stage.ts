import type { MeasurementResult } from '~/types'

/** PC → CoreS3 に送る段階 (firmware の HostStage と固定の語彙。変えない) */
export type CoreS3Stage = 'NFC' | 'TEMP' | 'ALCOHOL' | 'PC'

/**
 * 通常点呼 / 自動点呼 (TenkoKiosk) の step 名 → CoreS3 に送る段階の対応表 (1 か所に集約)。
 * 対応表に無い step (result / instruction / report / completed など、結果画面や
 * PC 単体の後始末) は送らない — 結果画面は既存の `RESULT` で入る (Refs ippoan/alc-app-s3#135)。
 */
const STEP_TO_STAGE: Record<string, CoreS3Stage | undefined> = {
  nfc: 'NFC',
  interrupted: 'NFC',
  cancelled: 'NFC',
  medical: 'TEMP',
  measuring: 'ALCOHOL',
  alcohol: 'ALCOHOL',
  schedule_select: 'PC',
  face_auth: 'PC',
  self_declaration: 'PC',
  daily_inspection: 'PC',
  carrying_items: 'PC',
  safety_result: 'PC',
}

/** step 名から送る段階を決める純関数。対応表に無ければ null (送らない)。 */
export function stageForStep(step: string): CoreS3Stage | null {
  return STEP_TO_STAGE[step] ?? null
}

// シングルトン: 直近に送った行 (再送防止 / CoreS3 の再接続時の再送に使う)
let current: string | null = null
/** onOpen の購読を 1 回だけにする (useCoreS3Stage は複数の component から呼ばれる) */
let wired = false

/**
 * PC の今の段階を CoreS3 に `STAGE <段階>` で送る (送信専用、CoreS3 からの応答は読まない)。
 * CoreS3 の画面を PC の流れに連動させるための送信口 (Refs ippoan/alc-app-s3#135)。
 * 古い firmware は `STAGE` を未知のコマンドとして捨てるだけなので、firmware の OTA より
 * 先にこちらをマージしても害は無い。
 */
export function useCoreS3Stage() {
  const coreS3 = useCoreS3Serial()

  if (!wired) {
    wired = true
    // CoreS3 の再起動・掴み直しで、直近に送った段階を取り戻す
    coreS3.onOpen(() => {
      if (current) void coreS3.write(current)
    })
  }

  /** 同じ行は再送しない（再送すると CoreS3 側で値が消えることがある）。未接続なら送らない。 */
  function send(line: string): void {
    if (line === current) return
    current = line
    if (!coreS3.isConnected.value) return
    void coreS3.write(line)
  }

  /** step が変わるたびに呼ぶ。対応表に無い step は何もしない。 */
  function syncStep(step: string): void {
    const stage = stageForStep(step)
    if (stage === null) return
    send(`STAGE ${stage}`)
  }

  /** 測定結果を CoreS3 に伝える (CoreS3 は Screen::Result へ)。`STAGE RESULT` は無い。 */
  function sendResult(result: MeasurementResult): void {
    if (!coreS3.isConnected.value) return
    const verdict = result.resultType === 'normal' ? 'OK' : 'NG'
    void coreS3.write(`RESULT ${verdict} ${result.alcoholValue.toFixed(3)}`)
  }

  return {
    syncStep,
    sendResult,
  }
}
