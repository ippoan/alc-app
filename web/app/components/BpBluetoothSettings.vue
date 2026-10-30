<script setup lang="ts">
/**
 * 血圧の画面から、Vein Station の血圧計 (Omron、Bluetooth) の設定とペアリングを行う
 * (Refs ippoan/alc-app#436)。CoreS3 の無い PC では端末設定の画面へ行かなくても済むように。
 *
 * - 血圧計を使う / 使わない: 機体の NVS (`OMRON BP ON|OFF`)。反映は機体の再起動の後
 *   (再起動はこの画面のボタンで、USB の信号から行う)
 * - ペアリング: `PAIR` で受付を開く。**機体の BLE のボンドを全部消してから**受け付けるので、確認を挟む
 */

import { restartVeinAndReload } from '~/utils/vein-restart'

const emit = defineEmits<{ close: [] }>()

const vein = useVeinSerial()
const busy = ref(false)
const message = ref<string | null>(null)
const error = ref<string | null>(null)
/** 設定を書いたが、まだ再起動していない */
const needsRestart = ref(false)
/** ペアリングの確認を出している */
const confirmingPair = ref(false)

const stateLabel = computed(() => {
  if (vein.omronBp.value === null) return '分かりません (機体が答えませんでした)'
  return vein.omronBp.value ? '使う' : '使わない'
})

async function run(action: () => Promise<void>, done: string) {
  busy.value = true
  error.value = null
  message.value = null
  try {
    await action()
    message.value = done
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    busy.value = false
  }
}

function setBp(enabled: boolean) {
  return run(async () => {
    await vein.setOmronBp(enabled)
    needsRestart.value = true
  }, enabled ? '血圧計を使う設定にしました。再起動すると有効になります' : '血圧計を使わない設定にしました。再起動すると有効になります')
}

function restart() {
  return run(async () => {
    await restartVeinAndReload(vein.restart)
    needsRestart.value = false
  }, 'Vein Station を再起動しました。数秒後に画面を読み込み直します')
}

function startPairing() {
  confirmingPair.value = false
  return run(
    () => vein.startPairing(),
    'ペアリングの受付を開きました。血圧計の Bluetooth ボタンを長押しして「-P-」を点滅させてください',
  )
}
</script>

<template>
  <div class="bg-white rounded-2xl p-4 shadow-sm">
    <h2 class="text-lg font-semibold text-gray-700 mb-3">血圧計 (Bluetooth)</h2>
    <p v-if="!vein.isConnected.value" class="text-sm text-gray-500 mb-3">Vein Station がつながっていません</p>
    <template v-else>
      <dl class="grid grid-cols-2 gap-x-4 text-sm mb-3">
        <dt class="text-gray-500">血圧計 (Omron)</dt>
        <dd data-testid="bp-ble-state">{{ stateLabel }}</dd>
      </dl>
      <div class="grid grid-cols-2 gap-3">
        <button
          data-testid="bp-ble-on"
          :disabled="busy || vein.omronBp.value === true"
          class="px-4 py-3 rounded-xl border border-blue-600 text-blue-700 font-medium disabled:opacity-40"
          @click="setBp(true)"
        >
          使う
        </button>
        <button
          data-testid="bp-ble-off"
          :disabled="busy || vein.omronBp.value === false"
          class="px-4 py-3 rounded-xl border border-gray-300 text-gray-700 font-medium disabled:opacity-40"
          @click="setBp(false)"
        >
          使わない
        </button>
        <button
          data-testid="bp-ble-restart"
          :disabled="busy"
          class="px-4 py-3 rounded-xl font-medium disabled:opacity-40"
          :class="needsRestart ? 'bg-amber-500 text-white' : 'border border-gray-300 text-gray-700'"
          @click="restart"
        >
          Vein Station を再起動
        </button>
        <button
          data-testid="bp-ble-pair"
          :disabled="busy"
          class="px-4 py-3 rounded-xl border border-gray-300 text-gray-700 font-medium disabled:opacity-40"
          @click="confirmingPair = true"
        >
          ペアリングを始める
        </button>
      </div>
      <div v-if="confirmingPair" data-testid="bp-ble-pair-confirm" class="mt-3 text-sm bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
        <p class="text-amber-800">この機体の Bluetooth のペアリングを全部消してから受け付けます。よろしいですか</p>
        <div class="mt-2 flex gap-2">
          <button data-testid="bp-ble-pair-yes" class="px-3 py-1.5 rounded-lg bg-amber-600 text-white" @click="startPairing">始める</button>
          <button class="px-3 py-1.5 rounded-lg border border-gray-300" @click="confirmingPair = false">やめる</button>
        </div>
      </div>
    </template>
    <p v-if="message" data-testid="bp-ble-message" class="mt-3 text-sm text-blue-700">{{ message }}</p>
    <p v-if="error" data-testid="bp-ble-error" class="mt-3 text-sm text-red-600">{{ error }}</p>
    <button class="mt-4 w-full px-4 py-3 rounded-xl bg-blue-600 text-white font-medium" @click="emit('close')">閉じる</button>
  </div>
</template>
