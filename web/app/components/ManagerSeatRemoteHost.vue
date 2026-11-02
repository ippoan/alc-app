<script setup lang="ts">
/**
 * 運行管理者席の、開発用の遠隔操作の受け答え (Refs ippoan/alc-app-s3#352)。キオスクの VeinFleetHost と同じ形。
 *
 * 運行管理者の役割のときだけ置く (認証ゲートの外。ログイン前でも受ける)。Vein Base が最初に
 * つながった時点で、席の鍵 (`manager-device`) で購読を 1 回だけ張る。recorder は席の購読に
 * 遠隔操作の命令だけを配る (打刻・シリアル OTA・対応表の合図は来ない)。実行するのは端末設定で
 * 「開発用の遠隔操作を受ける」をオンにした PC だけ (`utils/kiosk-remote`)。描くものは無い。
 */
import { reportKioskCommandResult } from '~/utils/api'
import { respondToKioskCommand, VEIN_FIRMWARE_TARGET } from '~/utils/kiosk-remote'

const veinSerial = useVeinSerial()
const managerToken = useManagerDeviceToken()
/** 遠隔操作の `firmware_update` で使う (画面の更新と同じ手順・同じ「更新中」の印) */
const serialOta = useSerialOta()

const seatWatch = useTimecardWatch({
  getToken: () => managerToken.getManagerJwt(),
  onKioskCommand: (data) => {
    void respondToKioskCommand(data, {
      jwt: () => managerToken.getManagerJwt(),
      port: veinSerial,
      scope: 'manager-device',
      firmwareUpdate: () => serialOta.run(VEIN_FIRMWARE_TARGET),
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
