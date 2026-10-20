<script setup lang="ts">
/**
 * Vein Station の版の帯 (Refs ippoan/alc-app#436)。運行者の区画の中にだけ置く。
 *
 * `DeviceFirmwareNotice.vue` に Vein Station の接続・名乗り・始め方を渡すだけの部品
 * (`CoreS3DeviceFirmwareNotice.vue` と同じ形)。station 版も vein 版も target は
 * `timecard-station` で、どのイメージかは機体が名乗った FLAVOR で表から引く。
 *
 * - 宛先の照合は無い (USB で繋がっている 1 台が相手)
 * - 書き込みの間は `useVeinSerial` の錠が、鍵の署名・指静脈の読み取り・案内の音声を止める
 * - URL のデモ (`?demo=1`) では出さない。デモのタブで出さないのは置く側 (`index.vue`)
 */
const vein = useVeinSerial()
const serialOta = useSerialOta()
const { isDeviceBusy } = useKioskScreen()
const { isDemoMode } = useDemoMode()

/** 機体を使っている画面 (点呼の途中・指静脈の読み取り中) では始めない */
function start() {
  return serialOta.run('timecard-station', { isBusy: () => isDeviceBusy.value })
}
</script>

<template>
  <DeviceFirmwareNotice
    v-if="!isDemoMode"
    target="timecard-station"
    :version="vein.deviceInfo.value?.ver ?? null"
    :flavor="vein.deviceInfo.value?.flavor ?? null"
    :connected="vein.isConnected.value"
    :start="start"
  />
</template>
