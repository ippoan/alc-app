<script setup lang="ts">
// Windows GW (alc-gw) 確認カード (#124)。GW 構成 (#120) では機器が全て
// CoreS3 側にぶら下がるため、既存カードの USB デバイス登録では切り分け
// できない。どの層で止まっているかをこのカード 1 枚で確認する。
const {
  checking, gwDetected, coreS3Devices, nfcBridge, bleBridge, fc1200Bridge,
  injecting, injectResult, checkAll, injectTemperature,
} = useGwStatus()

onMounted(() => {
  checkAll()
})

const rows = computed(() => [
  { label: 'NFC ブリッジ (9876)', probe: nfcBridge.value },
  { label: '体温血圧ブリッジ (9877)', probe: bleBridge.value },
  { label: 'FC-1200 ブリッジ (9878)', probe: fc1200Bridge.value },
])
</script>

<template>
  <div class="bg-white rounded-xl shadow-sm overflow-hidden">
    <div class="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
      <div>
        <h3 class="text-sm font-medium text-gray-800">Windows GW (alc-gw)</h3>
        <p class="text-xs text-gray-500">GW 常駐アプリ / WS ブリッジ / CoreS3 の疎通確認</p>
      </div>
      <button
        class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
        :disabled="checking"
        @click="checkAll"
      >
        {{ checking ? '確認中...' : '再確認' }}
      </button>
    </div>

    <!-- GW 未検出: 折りたたみ (タブレット運用では出しっぱなしにしない) -->
    <div v-if="gwDetected === false" class="px-4 py-2">
      <p class="text-xs text-gray-400">GW なし環境 (127.0.0.1:11984 に到達できません)</p>
    </div>

    <!-- 初回確認中 -->
    <div v-else-if="gwDetected === null" class="px-4 py-2">
      <p class="text-xs text-gray-400">確認中...</p>
    </div>

    <!-- GW 稼働中: 各層の疎通を表示 -->
    <div v-else class="p-4 space-y-2">
      <div class="flex items-center gap-2 text-xs">
        <span class="w-2 h-2 rounded-full bg-green-500" />
        <span class="text-green-700">GW 常駐アプリ: 稼働中</span>
      </div>

      <div class="flex items-center gap-2 text-xs">
        <span class="w-2 h-2 rounded-full" :class="coreS3Devices.length > 0 ? 'bg-green-500' : 'bg-gray-300'" />
        <span :class="coreS3Devices.length > 0 ? 'text-green-700' : 'text-gray-500'">
          CoreS3: {{ coreS3Devices.length > 0 ? `接続中 (${coreS3Devices.join(', ')})` : '未接続' }}
        </span>
      </div>

      <div v-for="row in rows" :key="row.label" class="flex items-center gap-2 text-xs">
        <span class="w-2 h-2 rounded-full" :class="row.probe?.ok ? 'bg-green-500' : 'bg-red-400'" />
        <span :class="row.probe?.ok ? 'text-green-700' : 'text-red-600'">
          {{ row.label }}: {{ row.probe?.ok ? 'OK' : 'NG' }}
        </span>
        <span v-if="row.probe?.detail" class="text-gray-400">({{ row.probe.detail }})</span>
      </div>

      <!-- テスト注入: temperature を流して点呼フローまで届くかを E2E 確認 -->
      <div class="pt-2 flex items-center gap-2 flex-wrap">
        <button
          class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          :disabled="injecting"
          @click="injectTemperature()"
        >
          {{ injecting ? '注入中...' : 'テスト注入 (体温 36.5℃)' }}
        </button>
        <span
          v-if="injectResult"
          class="text-[11px] rounded px-2 py-1"
          :class="injectResult === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'"
        >
          {{ injectResult === 'success' ? '✓ 注入しました (点呼の体温・血圧ステップに 36.5℃ が届けば OK)' : '⚠ 注入に失敗しました' }}
        </span>
      </div>
    </div>
  </div>
</template>
