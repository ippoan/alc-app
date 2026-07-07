<script setup lang="ts">
// dev 用: Tauri ネイティブ層 (Rust tracing) の 127.0.0.1 WS ハブに繋いで
// ログ行を表示するだけの薄いページ。既存の useNfcWebSocket 等と同じ
// 「ws://127.0.0.1:<port> 固定 + 再接続」パターン。
//
// - 認証不要 (middleware/auth.global.ts の protectedPaths に含めない)
// - 127.0.0.1 のみ待ち受け (Tauri 側の logws hub が外部到達不可)
// - ページ内 UI 最小: 接続状態 + ログ行の tail

const DEFAULT_URL = 'ws://127.0.0.1:9880'
const RECONNECT_DELAY_MS = 3000
const MAX_RECONNECT_ATTEMPTS = 10
const MAX_LINES = 2000

const url = ref(DEFAULT_URL)
const isConnected = ref(false)
const error = ref<string | null>(null)
const lines = ref<string[]>([])
const autoScroll = ref(true)

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let intentionalClose = false

const logRef = ref<HTMLElement | null>(null)

function appendLine(text: string) {
  const trimmed = text.replace(/\r?\n$/, '')
  lines.value.push(trimmed)
  if (lines.value.length > MAX_LINES) {
    lines.value.splice(0, lines.value.length - MAX_LINES)
  }
  if (autoScroll.value) {
    nextTick(() => {
      const el = logRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    error.value
      = 'Tauri ネイティブログハブに接続できません (ws://127.0.0.1:9880)'
    return
  }
  clearReconnectTimer()
  reconnectTimer = setTimeout(() => {
    reconnectAttempts++
    connect()
  }, RECONNECT_DELAY_MS)
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }
  error.value = null
  intentionalClose = false
  try {
    ws = new WebSocket(url.value)
  }
  catch {
    error.value = 'WebSocket 接続に失敗しました'
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    isConnected.value = true
    error.value = null
    reconnectAttempts = 0
    appendLine(`--- connected ${new Date().toISOString()} ---`)
  }
  ws.onmessage = (event: MessageEvent) => {
    if (typeof event.data === 'string') appendLine(event.data)
  }
  ws.onclose = () => {
    isConnected.value = false
    ws = null
    if (!intentionalClose) {
      appendLine(`--- disconnected ${new Date().toISOString()} ---`)
      scheduleReconnect()
    }
  }
  ws.onerror = () => {
    error.value = 'ハブとの接続でエラーが発生しました'
  }
}

function disconnect() {
  intentionalClose = true
  clearReconnectTimer()
  if (ws) {
    ws.close()
    ws = null
  }
  isConnected.value = false
}

function reconnect() {
  disconnect()
  reconnectAttempts = 0
  connect()
}

function clearLines() {
  lines.value = []
}

onMounted(() => {
  connect()
})
onBeforeUnmount(() => {
  disconnect()
})
</script>

<template>
  <div class="min-h-screen bg-gray-900 text-gray-100 flex flex-col">
    <header class="flex items-center gap-3 p-3 border-b border-gray-700 bg-gray-800">
      <h1 class="text-lg font-semibold">
        dev logs
      </h1>
      <span
        class="inline-block w-2 h-2 rounded-full"
        :class="isConnected ? 'bg-green-400' : 'bg-red-400'"
      />
      <span class="text-sm text-gray-400">
        {{ isConnected ? 'connected' : 'disconnected' }}
      </span>
      <input
        v-model="url"
        class="ml-4 px-2 py-1 rounded bg-gray-700 text-sm w-64"
        aria-label="WS URL"
      >
      <button
        class="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-sm"
        @click="reconnect"
      >
        再接続
      </button>
      <button
        class="px-3 py-1 rounded bg-gray-600 hover:bg-gray-500 text-sm"
        @click="clearLines"
      >
        クリア
      </button>
      <label class="text-sm flex items-center gap-1 ml-2">
        <input v-model="autoScroll" type="checkbox">
        autoscroll
      </label>
      <span v-if="error" class="text-sm text-red-400 ml-auto">
        {{ error }}
      </span>
    </header>
    <pre
      ref="logRef"
      class="flex-1 overflow-auto p-3 text-xs font-mono whitespace-pre-wrap leading-relaxed"
    ><span v-for="(line, i) in lines" :key="i">{{ line }}<br></span></pre>
  </div>
</template>
