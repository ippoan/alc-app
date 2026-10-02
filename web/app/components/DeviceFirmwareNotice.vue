<script setup lang="ts">
/**
 * 「機体の版が配布中の版と違う」ことを知らせる帯と「更新する」ボタン (Refs ippoan/alc-app#425)。
 *
 * 画面の前の人が押したときだけ更新を始める (自動では始めない)。機体ごとの差 (対象の語・版・
 * 接続・始め方) は props で受け、ここは帯と結果の 1 行だけを描く。
 *
 * - **URL やファイルは受け取らない。** 配布中の版も、失敗のときの案内先も、`target` の語で
 *   `utils/firmware-targets.ts` の表から引く
 * - 「更新中」の幕は `FirmwareOtaOverlay.vue` が出す。ここでは重ねて作らない
 * - 判定は文字列の不一致だけ (`isFirmwareDifferent`)。大小は比べない
 */
import type { SerialOtaResult } from '~/composables/useSerialOta'
import { FIRMWARE_TARGETS } from '~/utils/firmware-targets'
import { fetchLatestFirmwareVersions, isFirmwareDifferent } from '~/utils/firmware-updates'

/** 配布中の版を取り直す間隔 */
const LATEST_REFRESH_MS = 60 * 60 * 1000

const props = defineProps<{
  /** `FIRMWARE_TARGETS` のキー */
  target: string
  /** 機体が名乗った版。取れていなければ null */
  version: string | null
  /** 機体が名乗った flavor。取れていなければ null */
  flavor: string | null
  /** 機体が USB で繋がっているか */
  connected: boolean
  /** 更新を始める。押したときに 1 回だけ呼ぶ */
  start: () => Promise<SerialOtaResult>
}>()

const { isDeviceBusy } = useKioskScreen()
const serialOta = useSerialOta()

/** 配布中の版 (flavor ごと)。取れていない間は空 = 帯を出さない */
const latest = ref<Record<string, string>>({})
let refreshTimer: ReturnType<typeof setInterval> | null = null

async function refreshLatest(): Promise<void> {
  latest.value = await fetchLatestFirmwareVersions(props.target)
}

function stopRefresh(): void {
  if (refreshTimer === null) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

// 繋がったときに 1 回、その後は 60 分おき。切断・unmount で止める
watch(() => props.connected, (connected) => {
  stopRefresh()
  if (!connected) return
  void refreshLatest()
  refreshTimer = setInterval(() => { void refreshLatest() }, LATEST_REFRESH_MS)
}, { immediate: true })
onBeforeUnmount(stopRefresh)

/** `start()` の結果を待っている間 (ボタンを押せない) */
const starting = ref(false)
/** 直前の結果のうち、画面に出すもの。閉じるまで残す (機体が使用中でも消さない) */
const result = ref<'failed' | 'retry' | 'unsupported' | null>(null)

const showBand = computed(() =>
  props.connected
  && isFirmwareDifferent(props.version, props.flavor, latest.value)
  && !isDeviceBusy.value
  && serialOta.state.value.kind === 'idle',
)

/** 表に無い target では案内先を出さない */
const installerUrl = computed(() =>
  Object.hasOwn(FIRMWARE_TARGETS, props.target) ? FIRMWARE_TARGETS[props.target]!.installerUrl : null,
)

async function onStart(): Promise<void> {
  if (starting.value) return
  starting.value = true
  result.value = null
  try {
    const outcome = await props.start()
    if (outcome === 'failed' || outcome === 'unsupported') result.value = outcome
    else if (outcome === 'busy' || outcome === 'skipped') result.value = 'retry'
  }
  catch {
    result.value = 'failed'
  }
  finally {
    starting.value = false
    // 結果に依らず 1 回取り直す (押すまでの間に配布が変わっていたら、帯を次の周期まで残さない)
    void refreshLatest()
  }
}
</script>

<template>
  <div
    v-if="showBand || result"
    data-testid="device-firmware-notice"
    class="shrink-0 bg-blue-50 text-blue-900 border-b border-blue-200 text-sm px-3 py-1"
  >
    <div v-if="showBand" class="flex items-center justify-center gap-3">
      <span>端末の版が配布中のものと違います</span>
      <button
        type="button"
        data-testid="device-firmware-start"
        class="shrink-0 px-3 py-1 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
        :disabled="starting"
        @click="onStart"
      >
        更新する
      </button>
    </div>
    <div
      v-if="result"
      data-testid="device-firmware-result"
      class="flex items-center justify-center gap-3"
      :class="result === 'failed' ? 'text-red-700' : 'text-amber-800'"
    >
      <span v-if="result === 'failed'">
        更新できませんでした。繰り返すときは、<a
          v-if="installerUrl"
          :href="installerUrl"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="device-firmware-installer"
          class="underline"
        >配布ページ</a><template v-else>配布ページ</template>から書き直してください
      </span>
      <span v-else-if="result === 'unsupported'">
        この端末は、<a
          v-if="installerUrl"
          :href="installerUrl"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="device-firmware-installer"
          class="underline"
        >配布ページ</a><template v-else>配布ページ</template>から 1 回書き直すと、画面から更新できるようになります
      </span>
      <span v-else>いまは更新できません。少し待ってから、もう一度押してください</span>
      <button
        type="button"
        data-testid="device-firmware-result-close"
        class="shrink-0 px-2 py-0.5 rounded-md text-xs text-gray-600 hover:bg-gray-200"
        @click="result = null"
      >
        閉じる
      </button>
    </div>
  </div>
</template>
