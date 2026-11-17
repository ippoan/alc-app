<script setup lang="ts">
/**
 * 右下の版の表示 (`VersionBadge` の slot) の「端末: <名前>」(Refs ippoan/alc-app-s3#352)。
 * 名前の決め方は `useBadgeDeviceName`。名前の後ろに id の短縮形を括弧で付ける。長い表示は省略し、
 * title に全文 (id も全文) を入れる
 */
const device = useBadgeDeviceName()
</script>

<template>
  <span v-if="device" data-testid="badge-device-name">
    / 端末: <span class="inline-block max-w-[16rem] truncate align-bottom" :title="device.title">{{ device.text }}</span>
  </span>
</template>
