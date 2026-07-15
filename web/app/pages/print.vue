<script setup lang="ts">
// operator 印刷 (Refs ippoan/alc-app-s3#38): PDF を選び、接続中の AtomS3
// 印刷ブリッジへ WS push して LAN の 9100 プリンターで印字する。
// PDF は base64 化して server route (/api/print/:deviceId) に渡すだけ。
import { useAuth } from '@ippoan/auth-client'

const { accessToken } = useAuth()

interface DevicesResponse {
  devices: string[]
}
interface PrintResponse {
  ok: boolean
  chunks?: number
  commands?: number
  error?: string
  failedAction?: string
  sent?: number
}
interface LastPdf {
  name: string
  base64: string
}

const LAST_PDF_KEY = 'alc-print:last-pdf'

const devices = ref<string[]>([])
const selectedDevice = ref<string>('')
const pdfName = ref<string>('')
const pdfBase64 = ref<string>('')
const busy = ref<boolean>(false)
const logLines = ref<string[]>([])

function log(line: string): void {
  logLines.value.push(line)
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {}
  if (accessToken.value) h.Authorization = `Bearer ${accessToken.value}`
  return h
}

// 接続中デバイス一覧を読み込む
async function loadDevices(): Promise<void> {
  try {
    const res = await $fetch<DevicesResponse>('/api/print/devices', { headers: authHeaders() })
    devices.value = res.devices ?? []
    if (devices.value.length > 0 && !selectedDevice.value) {
      selectedDevice.value = devices.value[0] ?? ''
    }
  } catch (e: unknown) {
    log('デバイス一覧の取得に失敗: ' + errMsg(e))
  }
}

function errMsg(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

// ファイル選択 → base64 化 (data URL の prefix を除く)。localStorage に保存して
// 次回「前回のファイル」を選び直さずに再印刷できるようにする。
function onFile(ev: Event): void {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const result = typeof reader.result === 'string' ? reader.result : ''
    const comma = result.indexOf(',')
    const b64 = comma >= 0 ? result.slice(comma + 1) : ''
    pdfName.value = file.name
    pdfBase64.value = b64
    rememberPdf({ name: file.name, base64: b64 })
    log(`選択: ${file.name} (${Math.round(b64.length / 1024)}KB base64)`)
  }
  reader.readAsDataURL(file)
}

function rememberPdf(pdf: LastPdf): void {
  try {
    localStorage.setItem(LAST_PDF_KEY, JSON.stringify(pdf))
  } catch {
    // localStorage 上限 / 無効化時は履歴保存を諦める (印刷自体は続行可能)
  }
}

// 前回選んだ PDF を localStorage から復元する
function useLastPdf(): void {
  try {
    const raw = localStorage.getItem(LAST_PDF_KEY)
    if (!raw) {
      log('前回のファイルはありません')
      return
    }
    const pdf = JSON.parse(raw) as LastPdf
    pdfName.value = pdf.name
    pdfBase64.value = pdf.base64
    log(`前回のファイルを選択: ${pdf.name}`)
  } catch {
    log('前回のファイルの復元に失敗しました')
  }
}

async function print(): Promise<void> {
  if (!selectedDevice.value) {
    log('印刷先デバイスを選んでください')
    return
  }
  if (!pdfBase64.value) {
    log('PDF を選んでください')
    return
  }
  busy.value = true
  log(`印刷開始 → ${selectedDevice.value} (${pdfName.value})`)
  try {
    const res = await $fetch<PrintResponse>(`/api/print/${encodeURIComponent(selectedDevice.value)}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: { pdfBase64: pdfBase64.value },
    })
    if (res.ok) {
      log(`送信完了: ${res.chunks ?? 0} チャンク / ${res.commands ?? 0} コマンド`)
    } else {
      log(`印刷失敗: ${res.error ?? '不明'} (${res.failedAction ?? ''})`)
    }
  } catch (e: unknown) {
    log('印刷リクエストに失敗: ' + errMsg(e))
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void loadDevices()
})
</script>

<template>
  <div style="max-width: 40rem; margin: 2rem auto; padding: 0 1rem; font-family: system-ui, sans-serif">
    <h1 style="font-size: 1.4rem">点呼記録の印刷</h1>
    <p style="color: #555; font-size: 0.9rem">
      PDF を選んで営業所の AtomS3 プリンター (9100) へ送信します。印刷先の宛先 (プリンター IP) は
      デバイス側で設定済みのものを使います。
    </p>

    <label style="display: block; margin-top: 1rem; font-weight: 600">印刷先デバイス</label>
    <div style="display: flex; gap: 0.5rem; align-items: center">
      <select v-model="selectedDevice" style="flex: 1; padding: 0.4rem">
        <option v-if="devices.length === 0" value="">(接続中のデバイスなし)</option>
        <option v-for="d in devices" :key="d" :value="d">{{ d }}</option>
      </select>
      <button :disabled="busy" @click="loadDevices">再読込</button>
    </div>

    <label style="display: block; margin-top: 1rem; font-weight: 600">PDF</label>
    <input type="file" accept="application/pdf" @change="onFile">
    <div style="margin-top: 0.4rem">
      <button :disabled="busy" @click="useLastPdf">前回のファイルを使う</button>
      <span v-if="pdfName" style="margin-left: 0.5rem; color: #333">選択中: {{ pdfName }}</span>
    </div>

    <p style="margin-top: 1.2rem">
      <button :disabled="busy || !selectedDevice || !pdfBase64" style="padding: 0.5rem 1.2rem; font-size: 1rem" @click="print">
        {{ busy ? '送信中…' : '印刷する' }}
      </button>
    </p>

    <pre style="margin-top: 1rem; padding: 0.8rem; background: #0b1020; color: #7fd1ff; font-size: 0.8rem; border-radius: 0.4rem; white-space: pre-wrap; max-height: 18rem; overflow-y: auto">{{ logLines.join('\n') }}</pre>
  </div>
</template>
