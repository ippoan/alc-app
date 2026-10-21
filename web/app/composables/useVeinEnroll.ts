/**
 * 指静脈の登録手順 (Refs ippoan/vein-match#20)。顔登録画面 (`pages/register.vue`) と
 * 血圧測定タブの指静脈登録 (`components/VeinRegistration.vue`) が同じ手順を使う。
 *
 * 端末は Vein Station (kind `timecard` の vein build)。CoreS3/警告デバイス/測定台と
 * 同じ調停 (useSerialArbiter) を通るので、ここでは接続だけ持てば足りる — ポートの探索・
 * `DEVICE timecard` の判定は arbiter 側。unmount で release/disconnect しないのは
 * NfcStatus.vue と同じ理由 (Refs ippoan/rust-alc-api#644): 画面遷移のたびに開き直すと
 * ESP32-S3 を再起動させうる。
 *
 * 手順は「案内 PLACE → 1 回目 → 案内 AGAIN → 2 回目 → 保存 → 案内 ENROLLED」。
 * 失敗したら案内 FAILED を鳴らし、理由を `error` に出す。
 *
 * **開発用の端末 (`usesVeinModule`) は、照合をモジュールに任せる経路で登録する** (M-b、
 * Refs ippoan/alc-app#436): 案内 PLACE → モジュールの ID (その人の ID、無ければ 10〜100 の空き) に
 * `VEIN ENROLL` (置き直しの案内は `notice` に出す) → 記録をサーバーへ預ける → 手元の対応表に
 * 「承認待ち」で入れる → 案内 ENROLLED。
 */

import { putVeinModuleRecord, putVeinTemplate, apiErrorCode, apiErrorMessage } from '~/utils/api'
import { deleteVeinModuleEntry, loadVeinModuleEntries, putVeinModuleEntry } from '~/utils/vein-db'
import { allocateVeinModuleId, usesVeinModule } from '~/utils/vein-module'
import { VEIN_RECORD_BROKEN } from '~/composables/useVeinSerial'

/** モジュールの ID が空いていない / サーバーの上限 (409) */
export const VEIN_ENROLL_FULL_MESSAGE = 'これ以上登録できません'
/** 置き直しの照合が外れた (`ERR VEIN RETAKE`)。自動では繰り返さない */
export const VEIN_ENROLL_RETAKE_MESSAGE = 'もう一度、最初から登録してください'

/** ERR VEIN の理由 (useVeinSerial が message に載せる) / 422 の message (apiErrorMessage) を拾う */
function veinErrorMessage(e: unknown): string {
  return apiErrorMessage(e) ?? (e instanceof Error ? e.message : '指静脈登録エラー')
}

export function useVeinEnroll() {
  const veinSerial = useVeinSerial()
  const registering = ref(false)
  const error = ref<string | null>(null)
  const registered = ref(false)
  /** 登録の途中の案内 (置き直し)。終わったら null */
  const notice = ref<string | null>(null)
  const { isBpStation } = useBpStationMode()

  onMounted(() => veinSerial.connect())

  /** ボタンを押せない理由。`null` なら押せる */
  const disabledReason = computed<string | null>(() => {
    if (!veinSerial.isSupported) return 'この端末は WebSerial に対応していません'
    if (!veinSerial.isConnected.value) return 'Vein Station (指静脈読み取り端末) が接続されていません'
    return null
  })

  async function enroll(employeeId: string): Promise<void> {
    if (disabledReason.value || registering.value) return
    registering.value = true
    error.value = null
    try {
      if (usesVeinModule(isBpStation.value)) await enrollToModule(employeeId)
      else await enrollChara(employeeId)
      await veinSerial.say('ENROLLED')
      registered.value = true
    } catch (e) {
      error.value = veinErrorMessage(e)
      try { await veinSerial.say('FAILED') } catch { /* 案内の失敗は握り潰す (登録失敗の表示が主) */ }
    } finally {
      notice.value = null
      registering.value = false
    }
  }

  /** 今の経路: 特徴量を 2 回読んでサーバーへ */
  async function enrollChara(employeeId: string): Promise<void> {
    await veinSerial.say('PLACE')
    const first = await veinSerial.capture()
    await veinSerial.say('AGAIN')
    const second = await veinSerial.capture()
    await putVeinTemplate(employeeId, [first, second])
  }

  /** モジュールの経路: モジュールに登録し、記録をサーバーへ預け、対応表に承認待ちで入れる */
  async function enrollToModule(employeeId: string): Promise<void> {
    const id = allocateVeinModuleId(await loadVeinModuleEntries(), employeeId)
    if (id === null) throw new Error(VEIN_ENROLL_FULL_MESSAGE)
    // 登録し直しはモジュールの記録が置き換わる。承認前の記録を承認済みとして引かないよう先に外す
    await deleteVeinModuleEntry(employeeId)
    await veinSerial.say('PLACE')
    let record: Uint8Array
    try {
      record = await veinSerial.enroll(id, (n) => { notice.value = `もう一度置いてください (${n}/3)` })
    }
    catch (e) {
      const reason = (e as Error).message
      if (reason === 'RETAKE') throw new Error(VEIN_ENROLL_RETAKE_MESSAGE)
      if (reason === VEIN_RECORD_BROKEN) {
        // 行が壊れて受け取れなかった記録はモジュールに残さない
        await veinSerial.syncClear(id).catch(() => {})
        throw new Error(VEIN_ENROLL_RETAKE_MESSAGE)
      }
      throw e
    }
    let saved: { updated_at: string }
    try {
      saved = await putVeinModuleRecord(employeeId, record)
    }
    catch (e) {
      // サーバーが預からなかった記録はモジュールに残さない (消せなくても照合は対応表で外れる)
      await veinSerial.syncClear(id).catch(() => {})
      if (apiErrorCode(e) === 'too_many_module_records') throw new Error(VEIN_ENROLL_FULL_MESSAGE)
      throw e
    }
    await putVeinModuleEntry({ employeeId, moduleId: id, updatedAt: saved.updated_at, approved: false })
  }

  function reset(): void {
    error.value = null
    registered.value = false
  }

  return {
    isConnected: veinSerial.isConnected,
    registering: readonly(registering),
    error: readonly(error),
    registered: readonly(registered),
    notice: readonly(notice),
    disabledReason,
    enroll,
    reset,
  }
}
