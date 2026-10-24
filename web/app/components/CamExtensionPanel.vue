<script setup lang="ts">
// メンテナンス画面の「カメラ配信 (拡張)」: この端末の alc-cam 拡張の状態と操作 (useCamExtension)。
// chrome.runtime が無いブラウザでは案内だけ出す。
import { tokenLabel, updateLabel, useCamExtension, viewersLabel, type CamLabel } from '~/composables/useCamExtension'

const { supported, found, status, busy, result, control } = useCamExtension()

const rows = computed<{ label: string, value: CamLabel }[]>(() => {
  const st = status.value
  if (!st) return []
  return [
    { label: '版', value: [`拡張 v${st.version}${st.hostVersion ? `・host v${st.hostVersion}` : ''}`, ''] },
    { label: '鍵', value: tokenLabel(st) },
    { label: '担当カメラ', value: st.assigned ? [`${st.assigned.name} (${st.assigned.id})`, st.config[1]] : st.config },
    { label: 'host', value: st.host },
    { label: 'シグナリング', value: st.signal },
    { label: '見る人・映像', value: viewersLabel(st) },
    { label: 'カメラ', value: st.camera },
    { label: 'host 更新', value: updateLabel(st) },
  ]
})

const toneClass = (cls: string) => (cls === 'ok' ? 'text-green-700' : cls === 'warn' ? 'text-amber-700' : 'text-gray-700')
</script>

<template>
  <div class="bg-white rounded-2xl p-6 shadow-sm" data-testid="cam-extension-panel">
    <h2 class="text-lg font-semibold text-gray-700 mb-3">カメラ配信 (拡張)</h2>

    <p v-if="!supported" class="text-sm text-gray-500" data-testid="cam-ext-unsupported">
      このブラウザでは拡張の状態を読めません (拠点 PC の Chrome で開いてください)
    </p>
    <p v-else-if="found === null" class="text-sm text-gray-400">確認中…</p>
    <p v-else-if="!found" class="text-sm text-amber-700" data-testid="cam-ext-missing">
      拡張が見つかりません (入っていない・止まっている、または v0.4.2 より古い拡張です)
    </p>

    <template v-else-if="status">
      <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm mb-4">
        <template v-for="row in rows" :key="row.label">
          <dt class="text-gray-500">{{ row.label }}</dt>
          <dd :class="toneClass(row.value[1])">{{ row.value[0] }}</dd>
        </template>
        <template v-if="status.lastError">
          <dt class="text-gray-500">直近のエラー</dt>
          <dd class="text-red-600" data-testid="cam-ext-error">{{ status.lastError.message }}</dd>
        </template>
      </dl>

      <div class="flex flex-wrap gap-2">
        <button
          class="px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          :class="status.enabled ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-blue-600 text-white hover:bg-blue-700'"
          :disabled="busy !== null"
          data-testid="cam-ext-toggle"
          @click="control(status.enabled ? 'stop' : 'start')"
        >
          {{ status.enabled ? '停止' : '開始' }}
        </button>
        <button
          class="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 transition-colors disabled:opacity-50"
          :disabled="busy !== null"
          data-testid="cam-ext-update"
          @click="control('update_check')"
        >
          更新確認
        </button>
        <button
          class="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 transition-colors disabled:opacity-50"
          :disabled="busy !== null"
          data-testid="cam-ext-refetch"
          @click="control('refetch')"
        >
          担当カメラを取り直す
        </button>
      </div>
    </template>

    <p
      v-if="result"
      class="text-sm mt-3"
      :class="result.ok ? 'text-green-600' : 'text-red-600'"
      data-testid="cam-ext-result"
    >
      {{ result.message }}
    </p>
  </div>
</template>
