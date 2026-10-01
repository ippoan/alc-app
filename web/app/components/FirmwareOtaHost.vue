<script setup lang="ts">
/**
 * ファームの更新の置き場 (Refs ippoan/alc-app#403)。
 *
 * 運行者の画面にタブに関係なく常に在る。繋がっている機体の報告 (`useFirmwareReport`) を
 * 動かし、「更新中」の幕を描き、**CoreS3 の更新の合図を受ける**。幕が読むのは
 * `useSerialOta().state` (モジュールのシングルトン) だけ。
 *
 * Vein Station (target `timecard-station`) の合図の受けは `TenkoKiosk.vue` — ここは
 * `cores3` 以外の合図では何もしない。
 */
const props = defineProps<{
  /** いまのタブがデモ (実機を使わない画面) か。デモの間は合図を受けても始めない */
  demo?: boolean
}>()

const firmwareReport = useFirmwareReport()
const serialOta = useSerialOta()
const coreS3 = useCoreS3Serial()
const { isDeviceBusy } = useKioskScreen()
const { isDemoMode: isDemoModeFromUrl } = useDemoMode()

onMounted(() => { firmwareReport.start() })
onBeforeUnmount(() => { firmwareReport.stop() })

// --- CoreS3 の更新の合図 ---
// 管理者が 1 台を指定して「更新する」を押すと、recorder が購読 WS に合図を送る (全キオスクへ届く)。
// 自分の機体宛てかどうかの照合は `useSerialOta` が実行時に行う (ここに二重に書かない)。
// 機体を使っている画面 (点呼・測定の途中) では始めず、預けておいて空いたときに走らせる。
// 「機体を使用中」の申告が無いタブ (端末設定など) では、その場で始まる。
const otaWatch = useTimecardWatch({
  getToken: () => useDeviceToken().getDeviceJwt(),
  onSerialOta: (target, deviceId) => {
    if (props.demo || isDemoModeFromUrl.value || target !== 'cores3') return
    serialOta.enqueue(target, { deviceId, isBusy: () => isDeviceBusy.value })
    if (!isDeviceBusy.value) void serialOta.runQueued()
  },
})
watch(isDeviceBusy, (busy) => {
  if (!busy) void serialOta.runQueued()
})
// 購読は、CoreS3 が最初に繋がった時点で 1 回だけ張り、以後は張りっぱなし。
// - 一度も繋いでいないブラウザでは張らない (端末の token が取れないまま再試行し続けるのを避ける)
// - 切断に合わせて止めない: 更新は再起動で接続を一度失う。`useTimecardWatch` は `stop()` の後に
//   `connect()` し直せない。unmount で止めるのは `useTimecardWatch` 自身
let subscribed = false
watch(coreS3.isConnected, (connected) => {
  if (!connected || subscribed) return
  subscribed = true
  void otaWatch.connect()
}, { immediate: true })

/** 画面全体に出す OTA の表示 (`null` なら出さない) */
const serialOtaMessage = computed<string | null>(() => {
  const s = serialOta.state.value
  switch (s.kind) {
    case 'idle': return null
    case 'downloading': return '端末を更新しています 0%'
    case 'writing': return `端末を更新しています ${s.pct}%`
    case 'rebooting':
    case 'confirming': return '端末を再起動しています…'
    case 'done': return `更新しました ${s.ver}`
    case 'failed': return '更新できませんでした (元の版のまま)'
  }
})
</script>

<template>
  <div
    v-if="serialOtaMessage"
    data-testid="serial-ota-overlay"
    class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
  >
    <!-- 端末のシリアル OTA (Refs ippoan/alc-app-s3#279)。実行中は画面全体を覆って操作させない。
         どのモーダル (z-50) よりも上に出す -->
    <p class="bg-white rounded-2xl px-8 py-6 text-2xl font-bold text-gray-800 text-center shadow-xl">
      {{ serialOtaMessage }}
    </p>
  </div>
</template>
