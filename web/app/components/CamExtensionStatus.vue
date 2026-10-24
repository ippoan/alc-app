<script setup lang="ts">
// 点呼画面の「カメラ配信」: この端末の alc-cam 拡張の状態を 1 行で出し、押すと詳細と操作 (useCamExtension)。
// 拡張が見つからない端末 (拠点 PC 以外・Chrome 以外) では何も出さない。
// 乗務員も触れる画面なので「停止」は確かめてから送る。詳細は外側のクリック・Esc・× でも閉じる (≡ メニューと同じ作法)。
import { summaryLabel, tokenLabel, updateLabel, useCamExtension, viewersLabel, type CamLabel } from '~/composables/useCamExtension'

const { found, status, busy, result, control } = useCamExtension()

const open = ref(false)
const confirmStop = ref(false)
const rootRef = ref<HTMLElement | null>(null)

const summary = computed(() => (status.value ? summaryLabel(status.value) : null))

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

function toggle() {
  open.value = !open.value
  confirmStop.value = false
}

function close() {
  open.value = false
  confirmStop.value = false
}

function onDocClick(e: Event) {
  if (open.value && !rootRef.value?.contains(e.target as Node)) close()
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKeydown)
})

async function run(action: 'start' | 'stop' | 'update_check' | 'refetch') {
  confirmStop.value = false
  await control(action)
}
</script>

<template>
  <div v-if="found && status && summary" ref="rootRef" class="relative w-full max-w-lg mx-auto px-4 mt-1" data-testid="cam-ext-status">
    <button
      class="w-full flex items-center gap-2 text-xs text-left px-2 py-1 rounded-md hover:bg-gray-100 transition-colors"
      :aria-expanded="open ? 'true' : 'false'"
      data-testid="cam-ext-summary"
      @click="toggle"
    >
      <span class="w-2 h-2 rounded-full shrink-0" :class="summary[1] === 'ok' ? 'bg-green-500' : 'bg-amber-500'" />
      <span class="text-gray-500 shrink-0">カメラ配信:</span>
      <span class="truncate" :class="toneClass(summary[1])">{{ summary[0] }}</span>
    </button>

    <div
      v-if="open"
      class="absolute left-4 right-4 top-full mt-1 z-40 bg-white rounded-xl shadow-lg border p-4"
      data-testid="cam-ext-detail"
    >
      <button
        class="absolute top-2 right-2 p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100"
        aria-label="閉じる"
        data-testid="cam-ext-close"
        @click="close"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
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

      <div v-if="confirmStop" class="bg-red-50 border border-red-200 rounded-lg p-3 mb-3 text-sm" data-testid="cam-ext-confirm">
        <p class="text-red-700 mb-2">カメラ配信を止めますか? 見ている人の映像が切れ、「開始」を押すまで配信しません。</p>
        <div class="flex gap-2">
          <button
            class="px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700"
            data-testid="cam-ext-confirm-stop"
            @click="run('stop')"
          >
            止める
          </button>
          <button
            class="px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
            data-testid="cam-ext-confirm-cancel"
            @click="confirmStop = false"
          >
            やめる
          </button>
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          class="px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          :class="status.enabled ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-blue-600 text-white hover:bg-blue-700'"
          :disabled="busy !== null"
          data-testid="cam-ext-toggle"
          @click="status.enabled ? (confirmStop = true) : run('start')"
        >
          {{ status.enabled ? '停止' : '開始' }}
        </button>
        <button
          class="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 transition-colors disabled:opacity-50"
          :disabled="busy !== null"
          data-testid="cam-ext-update"
          @click="run('update_check')"
        >
          更新確認
        </button>
        <button
          class="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 transition-colors disabled:opacity-50"
          :disabled="busy !== null"
          data-testid="cam-ext-refetch"
          @click="run('refetch')"
        >
          担当カメラを取り直す
        </button>
      </div>

      <p
        v-if="result"
        class="text-sm mt-3"
        :class="result.ok ? 'text-green-600' : 'text-red-600'"
        data-testid="cam-ext-result"
      >
        {{ result.message }}
      </p>
    </div>
  </div>
</template>
