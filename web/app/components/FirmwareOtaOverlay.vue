<script setup lang="ts">
/**
 * 「更新中」の幕 (Refs ippoan/alc-app#403, ippoan/alc-app#425)。
 *
 * 役割 (運行者 / 運行管理者 / IT点呼 …) に依らない位置に 1 つだけ置く — 更新は運行者の画面の
 * 機体 (CoreS3・Vein Station) にも、運行管理者の席の警告デバイスにも走るため。
 * 読むのは `useSerialOta().state` (モジュールのシングルトン) だけで、合図の受けも報告もしない
 * (それは `FirmwareOtaHost.vue`)。
 */
const serialOta = useSerialOta()

/** 画面全体に出す表示 (`null` なら出さない) */
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
