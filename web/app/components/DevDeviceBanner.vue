<script setup lang="ts">
/**
 * 「この端末が開発用か本番か」を画面の上に常に出す帯 (Refs ippoan/alc-app#387)。
 *
 * 端末の鍵が開発用だと、その端末の点呼・測定・打刻は本番の記録簿に出ない。逆に開発用でない
 * 状態で点呼をすると記録が本番に入るので、どちらの状態かをメニューを開かずに見分けられるようにする。
 *
 * 開発用の印が 1 つでもあれば黄色の帯、**1 つも無ければ控えめな「本番」の表示**を出す
 * (どちらか一方が必ず描画される。「何も出ていない」は本番の意味に読めなかったため)。
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
  <div
    v-else
    data-testid="prod-device-banner"
    class="shrink-0 bg-gray-100 text-gray-500 border-b border-gray-200 text-xs px-3 py-0.5 text-center"
  >本番</div>
</template>
