<script setup lang="ts">
/**
 * 体温計だけを続けて試す画面 (切り分け用)。Vein Station から届く体温計の行を、届いた時刻つきで上に積む。
 * - `EVT THERMO_CONN try` / `EVT THERMO_RX ok|none|err` (alc-app-s3#336)
 * - JSON の `found` / `connected` / `disconnected` (体温計の分だけ) と `temperature`
 *
 * 「つながるのに体温が来ない」回に、体温計が送らなかったのか (`THERMO_RX none`)・ハブが受け損ねたのか
 * (`THERMO_RX` が出ない / `err`)・PC まで来たのか (`temperature`) を並びで見るための画面。記録は作らない
 */

const emit = defineEmits<{ close: [] }>()

const vein = useVeinSerial()

type RowKind = 'temp' | 'evt' | 'link'
interface Row { id: number; at: Date; kind: RowKind; text: string }

/** 積む上限 (古いものから落とす) */
const MAX_ROWS = 300
const rows = ref<Row[]>([])
let seq = 0
const temps = computed(() => rows.value.filter(r => r.kind === 'temp'))

function push(kind: RowKind, text: string): void {
  rows.value = [{ id: ++seq, at: new Date(), kind, text }, ...rows.value].slice(0, MAX_ROWS)
}

const offEvent = vein.onEvent((name, args) => {
  if (name.startsWith('THERMO')) push('evt', ['EVT', name, ...args].join(' '))
})
const offJson = vein.onJson((msg) => {
  const m = msg as { type?: unknown; device?: unknown; value?: unknown }
  if (m.type === 'temperature' && typeof m.value === 'number') push('temp', `${m.value.toFixed(1)} ℃`)
  else if ((m.type === 'found' || m.type === 'connected' || m.type === 'disconnected') && m.device === 'thermometer') push('link', m.type)
})
onUnmounted(() => {
  offEvent()
  offJson()
})

function clear(): void {
  rows.value = []
}

function hms(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

const ROW_CLASS: Record<RowKind, string> = {
  temp: 'text-green-700 font-bold',
  evt: 'text-blue-700',
  link: 'text-gray-500',
}
</script>

<template>
  <div class="bg-white rounded-2xl p-4 shadow-sm flex flex-col gap-3 min-h-0">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold text-gray-700">
        体温計の受信テスト
      </h2>
      <span
        data-testid="thermo-test-vein"
        class="text-xs px-2 py-1 rounded-full"
        :class="vein.isConnected.value ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'"
      >
        Vein Station {{ vein.isConnected.value ? '接続中' : '未接続' }}
      </span>
    </div>

    <p class="text-sm text-gray-500">
      体温計で続けて測ってください。届いた体温と、体温計の接続・受信の行を新しい順に並べます (記録は作りません)。
    </p>

    <div class="flex items-baseline gap-3">
      <span data-testid="thermo-test-latest" class="text-3xl font-mono font-bold" :class="temps.length ? 'text-green-700' : 'text-gray-300'">
        {{ temps[0]?.text ?? '--.- ℃' }}
      </span>
      <span data-testid="thermo-test-count" class="text-sm text-gray-500">受信 {{ temps.length }} 回</span>
    </div>

    <ol data-testid="thermo-test-rows" class="flex-1 min-h-0 max-h-96 overflow-y-auto border border-gray-200 rounded-xl divide-y divide-gray-100 font-mono text-sm">
      <li v-if="rows.length === 0" class="px-3 py-4 text-center text-gray-400 font-sans">
        まだ何も届いていません
      </li>
      <li v-for="r in rows" :key="r.id" class="px-3 py-1.5 flex gap-3">
        <span class="text-gray-400 shrink-0">{{ hms(r.at) }}</span>
        <span :class="ROW_CLASS[r.kind]">{{ r.text }}</span>
      </li>
    </ol>

    <div class="flex gap-2">
      <button data-testid="thermo-test-clear" class="flex-1 px-4 py-3 bg-white border border-gray-300 text-gray-700 rounded-xl font-medium hover:bg-gray-50" @click="clear">
        消す
      </button>
      <button class="flex-1 px-4 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700" @click="emit('close')">
        戻る
      </button>
    </div>
  </div>
</template>
