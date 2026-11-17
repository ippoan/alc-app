<script setup lang="ts">
/**
 * 運行管理者席の、開発用の遠隔操作の受け答え (Refs ippoan/alc-app-s3#352)。キオスクの VeinFleetHost と同じ形。
 *
 * 運行管理者の役割のときだけ置く (認証ゲートの外。ログイン前でも受ける)。Vein Base が最初に
 * つながった時点で、席の鍵 (`manager-device`) で購読を 1 回だけ張る。recorder は席の購読に
 * 遠隔操作の命令と、**指静脈端末を 1 台指定したシリアル OTA の合図**だけを配る (打刻・一斉配信の
 * シリアル OTA・対応表の合図は来ない)。遠隔操作を実行するのは端末設定で「開発用の遠隔操作を受ける」を
 * オンにした PC だけ (`utils/kiosk-remote`)。描くものは無い。
 *
 * **管理者の一覧「端末のファーム」からの 1 台指定の更新もここで受ける** (Refs ippoan/alc-app-s3#352)。
 * 合図の `device_id` が自分 (席の鍵の token の id。版の報告 `useVeinFirmwareReport` と同じ決め方) と
 * 一致したときだけ預かり、席の画面が機体を使っていない (照合・登録の途中でない) ときに走らせる。
 */
import { reportKioskCommandResult } from '~/utils/api'
import { kioskDeviceIdFromJwt, respondToKioskCommand, VEIN_FIRMWARE_TARGET } from '~/utils/kiosk-remote'

const veinSerial = useVeinSerial()
const managerToken = useManagerDeviceToken()
/** 遠隔操作の `firmware_update` で使う (画面の更新と同じ手順・同じ「更新中」の印) */
const serialOta = useSerialOta()
const { isDeviceBusy } = useKioskScreen()

/** 1 台指定の更新の合図。自分宛てなら預け、機体が空いていれば走らせる */
async function onSerialOta(target: string, deviceId?: string): Promise<void> {
  // 席に届くのは device_id 付きの指静脈端末の合図だけ (recorder)。念のため両方を見直す
  if (target !== VEIN_FIRMWARE_TARGET || deviceId === undefined) return
  const own = kioskDeviceIdFromJwt(await managerToken.getManagerJwt().catch(() => null))
  if (own !== deviceId) return
  serialOta.enqueue(target, { isBusy: () => isDeviceBusy.value })
  if (!isDeviceBusy.value) void serialOta.runQueued()
}
watch(isDeviceBusy, (busy) => {
  if (!busy) void serialOta.runQueued()
})

const seatWatch = useTimecardWatch({
  getToken: () => managerToken.getManagerJwt(),
  onSerialOta: (target, deviceId) => { void onSerialOta(target, deviceId) },
  onKioskCommand: (data) => {
    void respondToKioskCommand(data, {
      jwt: () => managerToken.getManagerJwt(),
      port: veinSerial,
      scope: 'manager-device',
      firmwareUpdate: () => serialOta.run(VEIN_FIRMWARE_TARGET),
      logUpload: reason => useVeinLogUpload().upload(reason),
      report: (id, payload) => reportKioskCommandResult(id, payload, 'manager-device'),
    })
  },
})

let subscribed = false
watch(veinSerial.isConnected, (connected) => {
  if (!connected || subscribed) return
  subscribed = true
  void seatWatch.connect()
}, { immediate: true })

onUnmounted(() => seatWatch.stop())
</script>

<template>
  <!-- 描くものは無い -->
</template>
