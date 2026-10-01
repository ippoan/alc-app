<script setup lang="ts">
/**
 * 「この端末は開発用の鍵で動いている」ことを画面の上に常に出す帯 (Refs ippoan/alc-app#387)。
 *
 * 端末の鍵が開発用だと、その端末の点呼・測定・打刻は本番の記録簿に出ない。逆に開発用でない
 * 状態で点呼をすると記録が本番に入るので、どちらの状態かをメニューを開かずに見分けられるようにする。
 *
 * **印が 1 つも無い端末 (= 本番の全端末) では何も描画しない** (ルート要素ごと出さない)。
 * 表示だけで、押せるものは持たない (印を外す操作は `DevDeviceRecords.vue`)。
 *
 * 印 (`isDevDevice`) は同期で読める代わりに reactive ではないので、ここに写しを持ち、
 * 印が変わったときに出るイベント (`DEV_DEVICE_MARK_EVENT`) で読み直す。
 */
import { DEV_DEVICE_MARK_EVENT, isDevDevice, type DeviceTokenKind } from '~/utils/token-selection'

/** 帯に出す順と表示名 */
const KINDS: { kind: DeviceTokenKind, label: string }[] = [
  { kind: 'kiosk', label: 'キオスク' },
  { kind: 'manager-device', label: '運行管理者席' },
  { kind: 'bp-station', label: '血圧測定台' },
]

function readDevLabels(): string[] {
  return KINDS.filter(k => isDevDevice(k.kind)).map(k => k.label)
}

const devLabels = ref(readDevLabels())
function refresh() {
  devLabels.value = readDevLabels()
}

onMounted(() => {
  refresh()
  window.addEventListener(DEV_DEVICE_MARK_EVENT, refresh)
})
onUnmounted(() => window.removeEventListener(DEV_DEVICE_MARK_EVENT, refresh))
</script>

<template>
  <div
    v-if="devLabels.length > 0"
    data-testid="dev-device-banner"
    class="shrink-0 bg-amber-100 text-amber-900 border-b border-amber-300 text-sm px-3 py-1 text-center"
  >
    <span class="font-bold inline-block mr-2">開発用の端末です</span>
    <span class="inline-block">この端末の記録は本番の記録簿に出ません ({{ devLabels.join('・') }})</span>
  </div>
</template>
