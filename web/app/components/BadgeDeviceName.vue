<script setup lang="ts">
/**
 * 右下の版の表示 (`VersionBadge` の slot) の「端末: <名前>」(Refs ippoan/alc-app-s3#352)。
 * 名前の決め方は `useBadgeDeviceName`。長い名前は省略し、title に全文を入れる
 */
const text = useBadgeDeviceName()
</script>

<template>
  <span v-if="text" data-testid="badge-device-name">
    / 端末: <span class="inline-block max-w-[16rem] truncate align-bottom" :title="text">{{ text }}</span>
  </span>
</template>
