<script setup lang="ts">
/**
 * 警告デバイスの版の帯 (Refs ippoan/alc-app#425)。運行管理者 / IT点呼 の席にだけ置く。
 *
 * `DeviceFirmwareNotice.vue` に警告デバイスの接続・名乗り・始め方を渡すだけの部品
 * (`CoreS3DeviceFirmwareNotice.vue` と同じ形)。
 *
 * - 帯を出すのは、機体が待機 (`idle`) と分かっている間だけ。鳴っている・着信を知らせている・
 *   状態がまだ分からない間は出さない。**部品ごと `v-if` で外さない** — 外すと、更新後の再起動で
 *   状態が分からなくなった瞬間に、結果の行 (失敗の案内) まで消える
 * - 宛先の照合は無い (USB で繋がっている 1 台が相手)
 * - 席の見張り (`useAlarmWatch`) には触らない。更新後の再起動は今までどおり「切断」と数えられる
 */
const alarm = useAlarmDevice()
const serialOta = useSerialOta()
const { isDeviceBusy } = useKioskScreen()
const { callingRooms } = useActiveRooms()

/** 機体が待機でない (鳴っている・状態が分からない) か */
const notIdle = computed(() => alarm.deviceState.value?.state !== 'idle')

/** 書き込みの直前にも、通話・判定の入力・画面共有と、着信・鳴動を聞き直す */
function start() {
  return serialOta.run('alarm', {
    isBusy: () => isDeviceBusy.value || notIdle.value || callingRooms.value.length > 0,
  })
}
</script>

<template>
  <DeviceFirmwareNotice
    target="alarm"
    :version="alarm.deviceInfo.value?.ver ?? null"
    :flavor="alarm.deviceInfo.value?.flavor ?? null"
    :connected="alarm.isConnected.value && alarm.deviceInfo.value !== null && !notIdle"
    :start="start"
  />
</template>
