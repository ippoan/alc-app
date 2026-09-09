<script setup lang="ts">
import type { ApiEmployee } from '~/types'
import { initApi, getEmployees, getEmployeeByNfcId, uploadFacePhoto, updateEmployeeFace } from '~/utils/api'
import { getFaceDescriptor } from '~/utils/face-db'
import { employeeNotFoundByNfc } from '~/utils/employee-lookup-messages'
import { FACE_MODEL_VERSION } from '~/composables/useFaceDetection'

const config = useRuntimeConfig()
const { isAuthenticated, isLoading, accessToken, deviceTenantId, refreshAccessToken } = useAuth()

initApi(
  config.public.apiBase as string,
  () => accessToken.value,
  () => deviceTenantId.value,
  () => refreshAccessToken(),
)

// 未ログインならログイン画面へ
watch([isAuthenticated, isLoading], ([auth, loading]) => {
  if (!loading && !auth) navigateTo('/login?redirect=/register')
}, { immediate: true })

const employees = ref<ApiEmployee[]>([])
const selectedEmployee = ref<ApiEmployee | null>(null)
const lookupError = ref<string | null>(null)
const registered = ref(false)
const uploading = ref(false)
const uploadError = ref<string | null>(null)

async function fetchEmployees() {
  try {
    employees.value = await getEmployees()
  } catch { /* ignore */ }
}

// NFC タッチで乗務員を特定
async function onNfcRead(nfcId: string) {
  lookupError.value = null
  try {
    const emp = await getEmployeeByNfcId(nfcId)
    selectedEmployee.value = emp
  } catch {
    lookupError.value = employeeNotFoundByNfc(nfcId)
  }
}

// ドロップダウンから選択
function onSelectEmployee(event: Event) {
  const id = (event.target as HTMLSelectElement).value
  selectedEmployee.value = id ? employees.value.find(e => e.id === id) || null : null
  lookupError.value = null
}

async function onRegistered(snapshot: Blob | null) {
  if (selectedEmployee.value) {
    uploading.value = true
    uploadError.value = null
    try {
      let url: string | undefined
      if (snapshot) {
        url = await uploadFacePhoto(snapshot)
      }
      const embedding = await getFaceDescriptor(selectedEmployee.value.id)
      await updateEmployeeFace(selectedEmployee.value.id, url, embedding ?? undefined, FACE_MODEL_VERSION)
    } catch (e) {
      uploadError.value = e instanceof Error ? e.message : '顔写真アップロードエラー'
    } finally {
      uploading.value = false
    }
  }
  registered.value = true
}

function reset() {
  selectedEmployee.value = null
  lookupError.value = null
  uploadError.value = null
  registered.value = false
}

onMounted(() => fetchEmployees())
</script>

<template>
  <div class="flex flex-col items-center min-h-screen p-4">
    <header class="w-full max-w-md text-center py-6">
      <h1 class="text-2xl font-bold text-gray-800">顔登録</h1>
    </header>

    <main class="w-full max-w-md flex-1">
      <div v-if="!registered" class="flex flex-col gap-4">
        <div class="bg-white rounded-2xl p-6 shadow-sm">
          <!-- NFC タッチ -->
          <label class="block text-sm font-medium text-gray-700 mb-2">NFC カードをタッチ</label>
          <NfcStatus @read="onNfcRead" />

          <!-- ドロップダウン -->
          <div class="border-t border-gray-200 pt-3 mt-4">
            <label class="block text-sm font-medium text-gray-700 mb-2">または一覧から選択</label>
            <select
              class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              :value="selectedEmployee?.id || ''"
              @change="onSelectEmployee"
            >
              <option value="">-- 選択してください --</option>
              <option v-for="emp in employees" :key="emp.id" :value="emp.id">
                {{ emp.code ? `[${emp.code}] ` : '' }}{{ emp.name }}
              </option>
            </select>
          </div>

          <p v-if="lookupError" class="mt-3 text-sm text-red-600">{{ lookupError }}</p>

          <!-- 選択結果 -->
          <div v-if="selectedEmployee" class="mt-4 p-3 bg-blue-50 rounded-lg">
            <p class="text-sm text-blue-800">
              <strong>{{ selectedEmployee.name }}</strong>
              <span v-if="selectedEmployee.code" class="text-blue-600 ml-2 text-xs">({{ selectedEmployee.code }})</span>
            </p>
          </div>

          <!-- 顔登録 -->
          <div v-if="selectedEmployee" class="mt-4">
            <FaceAuth
              :employee-id="selectedEmployee.id"
              mode="register"
              @registered="onRegistered"
            />
            <p v-if="uploading" class="mt-3 text-sm text-blue-600 text-center">
              写真アップロード中...
            </p>
            <p v-if="uploadError" class="mt-3 text-sm text-amber-600 text-center">
              写真アップロードに失敗しましたが、顔認証は利用できます
            </p>
          </div>
        </div>
      </div>

      <div v-else class="bg-white rounded-2xl p-6 shadow-sm text-center">
        <div class="text-5xl mb-4">&#10003;</div>
        <h2 class="text-lg font-semibold text-green-700 mb-2">登録完了</h2>
        <p class="text-gray-500 mb-6">{{ selectedEmployee?.name }} の顔を登録しました</p>
        <div class="flex gap-3 justify-center">
          <button
            class="px-6 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
            @click="reset"
          >
            続けて登録
          </button>
          <NuxtLink
            to="/"
            class="px-6 py-3 bg-gray-200 text-gray-700 rounded-xl font-medium hover:bg-gray-300 transition-colors"
          >
            測定へ
          </NuxtLink>
        </div>
      </div>
    </main>

    <footer class="w-full max-w-md py-4">
      <div class="flex justify-center">
        <NuxtLink to="/" class="text-blue-600 hover:underline text-sm">
          測定画面へ戻る
        </NuxtLink>
      </div>
    </footer>
  </div>
</template>
