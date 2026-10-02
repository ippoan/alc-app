<script setup lang="ts">
/**
 * CoreS3 の版の帯 (Refs ippoan/alc-app#425)。運行者の区画の中にだけ置く。
 *
 * `DeviceFirmwareNotice.vue` に CoreS3 の接続・名乗り・始め方を渡すだけの部品。ここに分けて
 * あるのは、`useSerialOta()` / `useFirmwareReport()` / `useCoreS3Serial()` を運行者以外の役割の
 * 画面で生成しないため (`useFirmwareReport()` は `useDeviceToken()` を生成し、CoreS3 の切断の
 * 受けを 1 つ登録する)。
 *
 * - 機体の id が取れていない端末 (端末の登録が無い等) では帯を出さない — 押しても宛先の照合で
 *   弾かれるだけで、待っても直らないため
 * - URL のデモ (`?demo=1`) では出さない。デモのタブで出さないのは置く側 (`index.vue`)
 */
const coreS3 = useCoreS3Serial()
const firmwareReport = useFirmwareReport()
const serialOta = useSerialOta()
const { isDeviceBusy } = useKioskScreen()
const { isDemoMode } = useDemoMode()

/** 宛先は押した時点の自分の機体の id。機体を使っている画面では始めない */
function start() {
  return serialOta.run('cores3', {
    deviceId: firmwareReport.deviceId.value ?? undefined,
    isBusy: () => isDeviceBusy.value,
  })
}
</script>

<template>
  <DeviceFirmwareNotice
    v-if="!isDemoMode"
    target="cores3"
    :version="coreS3.deviceInfo.value?.ver ?? null"
    :flavor="coreS3.deviceInfo.value?.flavor ?? null"
    :connected="coreS3.isConnected.value && firmwareReport.deviceId.value !== null"
    :start="start"
  />
</template>
