<script setup lang="ts">
/**
 * CoreS3 のファームの更新の置き場 (Refs ippoan/alc-app#403)。
 *
 * 運行者の画面にタブに関係なく常に在る。いまは、繋がっている機体の報告
 * (`useFirmwareReport`) を動かすだけで、描画するものは無い。
 */
const firmwareReport = useFirmwareReport()

onMounted(() => { firmwareReport.start() })
onBeforeUnmount(() => { firmwareReport.stop() })
</script>

<template>
  <!-- 描画なし -->
</template>
