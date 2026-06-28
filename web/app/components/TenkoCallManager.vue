<script setup lang="ts">
import QRCode from 'qrcode'
import {
  getTenkoCallNumbers,
  addTenkoCallNumber,
  deleteTenkoCallNumber,
  type TenkoCallNumber,
} from '~/utils/api'

const numbers = ref<TenkoCallNumber[]>([])
const loading = ref(false)
const error = ref('')

// 新規登録フォーム
const newCallNumber = ref('')
const newLabel = ref('')
const adding = ref(false)

// QRコード画像キャッシュ
const qrImages = ref<Record<string, string>>({})

async function generateQr(callNumber: string): Promise<string> {
  if (qrImages.value[callNumber]) return qrImages.value[callNumber]
  const url = await QRCode.toDataURL(callNumber, { width: 200, margin: 2 })
  qrImages.value[callNumber] = url
  return url
}

async function fetchData() {
  loading.value = true
  error.value = ''
  try {
    const nums = await getTenkoCallNumbers()
    numbers.value = nums
    // QRコード生成
    for (const num of nums) {
      await generateQr(num.call_number)
    }
  } catch (e: any) {
    error.value = e.message || '取得に失敗しました'
  } finally {
    loading.value = false
  }
}

async function addNumber() {
  if (!newCallNumber.value.trim()) return
  adding.value = true
  error.value = ''
  try {
    await addTenkoCallNumber({
      call_number: newCallNumber.value.trim(),
      label: newLabel.value.trim() || null,
    })
    newCallNumber.value = ''
    newLabel.value = ''
    await fetchData()
  } catch (e: any) {
    error.value = e.message || '追加に失敗しました'
  } finally {
    adding.value = false
  }
}

async function removeNumber(id: number) {
  if (!confirm('この点呼用番号を削除しますか？')) return
  try {
    await deleteTenkoCallNumber(id)
    await fetchData()
  } catch (e: any) {
    error.value = e.message || '削除に失敗しました'
  }
}

// QR拡大表示
const showQrModal = ref(false)
const modalQrNumber = ref('')

function openQr(callNumber: string) {
  modalQrNumber.value = callNumber
  showQrModal.value = true
}

onMounted(fetchData)
</script>

<template>
  <div class="space-y-6">
    <!-- QR拡大モーダル -->
    <div
      v-if="showQrModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="showQrModal = false"
    >
      <div class="bg-white rounded-2xl shadow-xl p-8 text-center">
        <h3 class="text-lg font-semibold text-gray-800 mb-4">{{ modalQrNumber }}</h3>
        <img
          v-if="qrImages[modalQrNumber]"
          :src="qrImages[modalQrNumber]"
          :alt="modalQrNumber"
          class="w-64 h-64 mx-auto"
        >
        <p class="mt-3 text-sm text-gray-500">ドライバーのアプリでこのQRコードを読み取ってください</p>
        <button
          class="mt-4 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300"
          @click="showQrModal = false"
        >
          閉じる
        </button>
      </div>
    </div>

    <!-- 点呼用番号マスタ -->
    <div class="bg-white rounded-xl p-4 shadow-sm">
      <h3 class="text-sm font-semibold text-gray-800 mb-3">点呼用電話番号</h3>

      <!-- 追加フォーム -->
      <div class="flex gap-2 mb-4">
        <input
          v-model="newCallNumber"
          type="tel"
          placeholder="電話番号 (例: 0312345678)"
          class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
        <input
          v-model="newLabel"
          type="text"
          placeholder="ラベル (任意)"
          class="w-32 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
        <button
          :disabled="adding || !newCallNumber.trim()"
          class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors disabled:opacity-50"
          @click="addNumber"
        >
          追加
        </button>
      </div>

      <!-- 一覧 -->
      <div v-if="numbers.length" class="divide-y">
        <div v-for="num in numbers" :key="num.id" class="flex items-center gap-4 py-3">
          <!-- QRコードサムネイル -->
          <img
            v-if="qrImages[num.call_number]"
            :src="qrImages[num.call_number]"
            :alt="num.call_number"
            class="w-16 h-16 cursor-pointer hover:opacity-80 transition-opacity rounded border"
            @click="openQr(num.call_number)"
          >
          <div class="flex-1">
            <span class="font-mono text-sm">{{ num.call_number }}</span>
            <span v-if="num.label" class="ml-2 text-xs text-gray-500">{{ num.label }}</span>
          </div>
          <button
            class="px-3 py-1 text-sm text-blue-600 hover:bg-blue-50 rounded transition-colors"
            @click="openQr(num.call_number)"
          >
            QR表示
          </button>
          <button
            class="text-red-500 hover:text-red-700 text-xs"
            @click="removeNumber(num.id)"
          >
            削除
          </button>
        </div>
      </div>
      <p v-else class="text-sm text-gray-400">登録された番号はありません</p>
    </div>

    <!-- エラー表示 -->
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <!-- ローディング -->
    <div v-if="loading" class="text-center text-gray-400 text-sm">読み込み中...</div>
  </div>
</template>
