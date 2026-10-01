<script setup lang="ts">
/**
 * ファームの更新の置き場 (Refs ippoan/alc-app#403)。
 *
 * 運行者の画面にタブに関係なく常に在る。繋がっている機体の報告 (`useFirmwareReport`) を
 * 動かし、「更新中」の幕を描く。幕が読むのは `useSerialOta().state` (モジュールの
 * シングルトン) だけ — **合図の受け (購読・待機の判定・預かり) はここには無い**
 * (Vein Station の受けは `TenkoKiosk.vue`)。
 */
const firmwareReport = useFirmwareReport()
const serialOta = useSerialOta()

onMounted(() => { firmwareReport.start() })
onBeforeUnmount(() => { firmwareReport.stop() })

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
