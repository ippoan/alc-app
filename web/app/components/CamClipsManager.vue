<script setup lang="ts">
import {
  createCamClipsCamera, createCamClipsClip, listCamClipsCameras, listCamClipsDeviceCandidates,
  listFirmwareDevices, updateCamClipsCamera,
} from '~/utils/api'
import type { CamClipsCamera, CamClipsClip, CamClipsDeviceCandidate, CamClipsForm } from '~/utils/cam-clips'
import {
  buildClipBody, buildCreateBody, buildPatchBody, clipRangeError, clipSrc, defaultClipRange,
  deviceDisplayName, EMPTY_FORM, errorText, formatJst, formFromCamera, summarizeCounts,
} from '~/utils/cam-clips'

/**
 * 拠点カメラの録画 (Refs ippoan/alc-cam#2)。カメラの登録・編集と、手動の切り出し・再生。
 * 宛先 (VPC binding) を書けるのは開発者の Google ログインのときだけ (`can_edit_destination`)。
 * 整形と本文の組み立ては `~/utils/cam-clips` の純関数。
 */

const cameras = ref<CamClipsCamera[]>([])
const canEditDestination = ref(false)
const candidates = ref<CamClipsDeviceCandidate[]>([])
const knownDevices = ref<{ device_id: string, label: string | null }[]>([])
const listError = ref('')

/** 編集中のカメラ (null = 追加) とフォーム。`formOpen` が false なら閉じている */
const formOpen = ref(false)
const editing = ref<CamClipsCamera | null>(null)
const form = ref<CamClipsForm>({ ...EMPTY_FORM })
const saving = ref(false)
const saveError = ref('')
const notice = ref('')

const range = defaultClipRange()
const clipCameraId = ref('')
const clipFrom = ref(range.from)
const clipTo = ref(range.to)
const clipBusy = ref(false)
const clipError = ref('')
const clip = ref<CamClipsClip | null>(null)

async function loadCameras() {
  try {
    const res = await listCamClipsCameras()
    cameras.value = res.cameras
    canEditDestination.value = res.can_edit_destination
    listError.value = ''
  }
  catch (e) {
    listError.value = errorText(e, 'カメラの一覧を取得できませんでした')
  }
}

/** 端末の候補と表示名。取れなくても登録はできる (候補が選べないだけ) */
async function loadDevices() {
  const [cand, fw] = await Promise.allSettled([listCamClipsDeviceCandidates(30), listFirmwareDevices()])
  candidates.value = cand.status === 'fulfilled' ? cand.value : []
  knownDevices.value = fw.status === 'fulfilled' ? fw.value.devices : []
}

onMounted(() => Promise.all([loadCameras(), loadDevices()]))

/** 候補に無い (30 日イベントが無い) が結び付いている端末も、選択肢に残す */
const deviceOptions = computed(() => {
  const seen = new Set(candidates.value.map(c => c.device_id))
  const extra = form.value.device_ids.filter(id => !seen.has(id))
  return [
    ...candidates.value.map(c => ({ id: c.device_id, isDev: c.is_dev === true, summary: summarizeCounts(c.counts), last: formatJst(c.last_at) })),
    ...extra.map(id => ({ id, isDev: false, summary: '直近 30 日のイベントなし', last: '—' })),
  ]
})

function nameOf(id: string): string {
  return deviceDisplayName(id, knownDevices.value)
}

function openAdd() {
  editing.value = null
  form.value = { ...EMPTY_FORM, device_ids: [] }
  saveError.value = ''
  formOpen.value = true
}

function openEdit(c: CamClipsCamera) {
  editing.value = c
  form.value = formFromCamera(c)
  saveError.value = ''
  formOpen.value = true
}

function closeForm() {
  formOpen.value = false
}

function toggleDevice(id: string, ev: Event) {
  const on = (ev.target as HTMLInputElement).checked
  const rest = form.value.device_ids.filter(d => d !== id)
  form.value.device_ids = on ? [...rest, id] : rest
}

async function save() {
  saving.value = true
  saveError.value = ''
  notice.value = ''
  try {
    if (editing.value) {
      await updateCamClipsCamera(editing.value.id, buildPatchBody(editing.value, form.value, canEditDestination.value))
      notice.value = 'カメラを更新しました'
    }
    else {
      await createCamClipsCamera(buildCreateBody(form.value, canEditDestination.value))
      notice.value = 'カメラを追加しました'
    }
    formOpen.value = false
    await loadCameras()
  }
  catch (e) {
    saveError.value = errorText(e, '保存に失敗しました')
  }
  finally {
    saving.value = false
  }
}

async function makeClip() {
  clip.value = null
  const problem = clipRangeError(clipCameraId.value, clipFrom.value, clipTo.value)
  if (problem) {
    clipError.value = problem
    return
  }
  clipBusy.value = true
  clipError.value = ''
  try {
    clip.value = await createCamClipsClip(buildClipBody(clipCameraId.value, clipFrom.value, clipTo.value))
  }
  catch (e) {
    clipError.value = errorText(e, '切り出しに失敗しました')
  }
  finally {
    clipBusy.value = false
  }
}
</script>

<template>
  <div class="space-y-4" data-testid="cam-clips">
    <div class="bg-white rounded-xl p-4 shadow-sm space-y-3">
      <div class="flex items-center gap-3">
        <h3 class="font-bold text-sm">拠点カメラ</h3>
        <button
          class="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm"
          data-testid="cam-clips-add"
          @click="openAdd"
        >
          カメラを追加
        </button>
        <span v-if="notice" class="text-sm text-green-700" data-testid="cam-clips-notice">{{ notice }}</span>
      </div>
      <p v-if="listError" class="text-sm text-red-600" data-testid="cam-clips-list-error">{{ listError }}</p>
      <p v-else-if="cameras.length === 0" class="text-sm text-gray-500" data-testid="cam-clips-empty">カメラは登録されていません</p>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-gray-500">
              <th class="py-1 pr-3">名前</th>
              <th class="py-1 pr-3">取り込み</th>
              <th class="py-1 pr-3">VPC binding</th>
              <th class="py-1 pr-3">ユーザー名</th>
              <th class="py-1 pr-3">パスワード</th>
              <th class="py-1 pr-3">結び付けた端末</th>
              <th class="py-1 pr-3">走査済み</th>
              <th class="py-1" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in cameras" :key="c.id" class="border-t" data-testid="cam-clips-row">
              <td class="py-2 pr-3">{{ c.name }}</td>
              <td class="py-2 pr-3" data-testid="cam-clips-recording">{{ c.recording ? '取り込み中' : '止めている' }}</td>
              <td class="py-2 pr-3">{{ c.vpc_binding ?? '—' }}</td>
              <td class="py-2 pr-3">{{ c.rec_username ?? '—' }}</td>
              <td class="py-2 pr-3">{{ c.has_password ? '設定済み' : '未設定' }}</td>
              <td class="py-2 pr-3">
                <span v-if="c.device_ids.length === 0" class="text-gray-400">—</span>
                <span v-for="id in c.device_ids" :key="id" class="block" data-testid="cam-clips-row-device">
                  <span class="font-semibold" data-testid="cam-clips-row-device-name">{{ nameOf(id) }}</span>
                  <span class="block text-xs text-gray-500 font-mono" data-testid="cam-clips-row-device-id">{{ id }}</span>
                </span>
              </td>
              <td class="py-2 pr-3">{{ formatJst(c.rec_scanned_until) }}</td>
              <td class="py-2">
                <button class="text-xs text-blue-700 underline" data-testid="cam-clips-edit" @click="openEdit(c)">編集</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <form
      v-if="formOpen"
      class="bg-white rounded-xl p-4 shadow-sm space-y-3"
      data-testid="cam-clips-form"
      @submit.prevent="save"
    >
      <h3 class="font-bold text-sm">{{ editing ? `「${editing.name}」を編集` : 'カメラを追加' }}</h3>

      <label class="block text-sm">
        名前
        <input v-model="form.name" class="mt-1 block w-full border rounded px-2 py-1" data-testid="cam-clips-name" maxlength="100">
      </label>

      <label class="block text-sm">
        VPC binding
        <input
          v-model="form.vpc_binding"
          class="mt-1 block w-full border rounded px-2 py-1 disabled:bg-gray-100"
          data-testid="cam-clips-binding"
          :readonly="!canEditDestination"
          :disabled="!canEditDestination || form.stop"
          placeholder="CAM_…"
        >
        <span class="block text-xs text-gray-500">
          ダッシュボードで VPC Service を作り wrangler.toml に足した binding 名 (CAM_…)
        </span>
        <span v-if="!canEditDestination" class="block text-xs text-gray-500" data-testid="cam-clips-binding-locked">
          宛先を書けるのは開発者の Google ログインのときだけです (表示のみ)
        </span>
      </label>
      <label v-if="canEditDestination && editing?.vpc_binding" class="flex items-center gap-2 text-sm">
        <input v-model="form.stop" type="checkbox" data-testid="cam-clips-stop">
        取り込みをやめる (VPC binding を外す)
      </label>

      <label class="block text-sm">
        ユーザー名
        <input v-model="form.rec_username" class="mt-1 block w-full border rounded px-2 py-1" data-testid="cam-clips-username" autocomplete="off">
      </label>

      <label class="block text-sm">
        パスワード
        <input
          v-model="form.rec_password"
          type="password"
          class="mt-1 block w-full border rounded px-2 py-1"
          data-testid="cam-clips-password"
          autocomplete="new-password"
          :placeholder="editing?.has_password ? '設定済み・変えるときだけ入力' : ''"
        >
        <span v-if="editing?.has_password" class="block text-xs text-gray-500" data-testid="cam-clips-password-set">設定済み・変えるときだけ入力</span>
      </label>

      <fieldset class="text-sm">
        <legend>結び付ける端末 (直近 30 日にイベントを出した端末)</legend>
        <p class="text-xs text-gray-500" data-testid="cam-clips-candidates-help">
          このカメラに映る端末を選びます。選んだ端末で記録したアルコール・血圧・打刻・免許証・指静脈の登録の前後 10 秒が切り出されます。
        </p>
        <p v-if="deviceOptions.length === 0" class="text-gray-500" data-testid="cam-clips-no-candidates">候補はありません</p>
        <label v-for="o in deviceOptions" :key="o.id" class="flex items-start gap-2 py-1" data-testid="cam-clips-candidate">
          <input type="checkbox" :checked="form.device_ids.includes(o.id)" @change="toggleDevice(o.id, $event)">
          <span>
            <span class="block">
              <span class="font-semibold" data-testid="cam-clips-candidate-name">{{ nameOf(o.id) }}</span>
              <span
                v-if="o.isDev"
                class="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-xs"
                data-testid="cam-clips-candidate-dev"
              >開発端末</span>
            </span>
            <span class="block text-xs text-gray-500 font-mono" data-testid="cam-clips-candidate-id">{{ o.id }}</span>
            <span class="block text-xs text-gray-500">{{ o.summary }} ・ 最終 {{ o.last }}</span>
          </span>
        </label>
      </fieldset>

      <p v-if="saveError" class="text-sm text-red-600" data-testid="cam-clips-save-error">{{ saveError }}</p>
      <div class="flex gap-2">
        <button
          type="submit"
          class="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50"
          data-testid="cam-clips-save"
          :disabled="saving || !form.name.trim()"
        >
          保存
        </button>
        <button type="button" class="px-3 py-1.5 rounded-lg bg-gray-200 text-sm" data-testid="cam-clips-cancel" @click="closeForm">
          キャンセル
        </button>
      </div>
    </form>

    <div class="bg-white rounded-xl p-4 shadow-sm space-y-3">
      <h3 class="font-bold text-sm">手動の切り出し</h3>
      <div class="flex flex-wrap items-end gap-3 text-sm">
        <label>
          カメラ
          <select v-model="clipCameraId" class="block border rounded px-2 py-1" data-testid="cam-clips-clip-camera">
            <option value="">(選んでください)</option>
            <option v-for="c in cameras" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <label>
          開始 (JST)
          <input v-model="clipFrom" type="datetime-local" class="block border rounded px-2 py-1" data-testid="cam-clips-clip-from">
        </label>
        <label>
          終了 (JST)
          <input v-model="clipTo" type="datetime-local" class="block border rounded px-2 py-1" data-testid="cam-clips-clip-to">
        </label>
        <button
          class="px-3 py-1.5 rounded-lg bg-blue-600 text-white disabled:opacity-50"
          data-testid="cam-clips-clip-make"
          :disabled="clipBusy"
          @click="makeClip"
        >
          {{ clipBusy ? '切り出し中…' : '切り出す' }}
        </button>
      </div>
      <p class="text-xs text-gray-500">一度に 120 分まで。カメラから元ファイルを取るので、初回は時間がかかります</p>
      <p v-if="clipError" class="text-sm text-red-600" data-testid="cam-clips-clip-error">{{ clipError }}</p>
      <div v-if="clip" class="space-y-1" data-testid="cam-clips-result">
        <video :src="clipSrc(clip.key)" controls preload="metadata" class="w-full max-w-3xl bg-black" data-testid="cam-clips-video" />
        <p class="text-xs text-gray-600">
          実際の範囲: {{ formatJst(clip.actual_from) }} 〜 {{ formatJst(clip.actual_to) }}
          <span v-if="clip.reused">(作成済みのものを再利用)</span>
        </p>
      </div>
    </div>
  </div>
</template>
