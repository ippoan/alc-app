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
 */

import { putVeinTemplate, apiErrorMessage } from '~/utils/api'

/** ERR VEIN の理由 (useVeinSerial が message に載せる) / 422 の message (apiErrorMessage) を拾う */
function veinErrorMessage(e: unknown): string {
  return apiErrorMessage(e) ?? (e instanceof Error ? e.message : '指静脈登録エラー')
}

export function useVeinEnroll() {
  const veinSerial = useVeinSerial()
  const registering = ref(false)
  const error = ref<string | null>(null)
  const registered = ref(false)

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
      await veinSerial.say('PLACE')
      const first = await veinSerial.capture()
      await veinSerial.say('AGAIN')
      const second = await veinSerial.capture()
      await putVeinTemplate(employeeId, [first, second])
      await veinSerial.say('ENROLLED')
      registered.value = true
    } catch (e) {
      error.value = veinErrorMessage(e)
      try { await veinSerial.say('FAILED') } catch { /* 案内の失敗は握り潰す (登録失敗の表示が主) */ }
    } finally {
      registering.value = false
    }
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
    disabledReason,
    enroll,
    reset,
  }
}
