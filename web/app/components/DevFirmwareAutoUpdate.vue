<script setup lang="ts">
/**
 * 開発端末の指静脈の端末 (Vein Station / Vein Base) を、配布中のファームへ自動で更新する
 * (Refs ippoan/alc-app-s3#352)。
 *
 * 本番の端末は画面の前の人が「更新する」を押したときだけ更新する (`DeviceFirmwareNotice.vue`)。
 * 開発用の鍵の印 (`isDevDevice` の `kiosk` / `manager-device`) がある端末だけ、版が配布中の版と
 * 違えば押さずに始める。役割に依らない位置に 1 つ置く (運行管理者席の Vein Base も対象)。
 *
 * - 配布中の版はつながったときと、その後 {@link LATEST_REFRESH_MS} おきに取り直す
 * - 機体を使っている画面 (点呼の途中・指静脈の読み取り中) や、別の更新が走っている間は始めない
 * - 同じ「今の版 → 配布中の版」はこの画面を開いている間に 1 回だけ試す (失敗しても繰り返さない)
 * - 書き込みは画面の更新と同じ `useSerialOta` — 「更新中」の幕 (`FirmwareOtaOverlay.vue`) も同じものが出る。
 *   書き終えると画面を読み込み直す。描くものは無い
 */
import { fetchLatestFirmwareVersions, isFirmwareDifferent } from '~/utils/firmware-updates'
import { VEIN_FIRMWARE_TARGET } from '~/utils/kiosk-remote'
import { DEV_DEVICE_MARK_EVENT, isDevDevice } from '~/utils/token-selection'
import { appendDiag } from '~/utils/serialDiagLog'

/** 配布中の版を取り直す間隔 */
const LATEST_REFRESH_MS = 10 * 60 * 1000

const vein = useVeinSerial()
const serialOta = useSerialOta()
const { isDeviceBusy } = useKioskScreen()
const { isDemoMode } = useDemoMode()

/** 開発用の鍵の印 (同期で読めるが reactive ではないので写しを持つ。DevDeviceBanner と同じ) */
const dev = ref(false)
function readDev(): void {
  dev.value = isDevDevice('kiosk') || isDevDevice('manager-device')
}
/** 配布中の版 (flavor ごと) */
const latest = ref<Record<string, string>>({})
/** 試した「今の版 → 配布中の版」 */
const attempted = new Set<string>()
let refreshTimer: ReturnType<typeof setInterval> | null = null

async function refreshLatest(): Promise<void> {
  latest.value = await fetchLatestFirmwareVersions(VEIN_FIRMWARE_TARGET)
}

function stopRefresh(): void {
  if (refreshTimer === null) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

watch(vein.isConnected, (connected) => {
  stopRefresh()
  if (!connected) return
  void refreshLatest()
  refreshTimer = setInterval(() => { void refreshLatest() }, LATEST_REFRESH_MS)
}, { immediate: true })

/** 始めてよいときの「今の版 → 配布中の版」。始めないときは null */
const pending = computed(() => {
  if (!dev.value || isDemoMode.value || !vein.isConnected.value) return null
  if (isDeviceBusy.value || serialOta.state.value.kind !== 'idle') return null
  const ver = vein.deviceInfo.value?.ver ?? null
  const flavor = vein.deviceInfo.value?.flavor ?? null
  if (!isFirmwareDifferent(ver, flavor, latest.value)) return null
  const key = `${flavor}:${ver}->${latest.value[flavor!]}`
  return attempted.has(key) ? null : key
})

watch(pending, async (key) => {
  if (key === null) return
  attempted.add(key)
  appendDiag(`[ota] 開発端末の自動更新を始めます ${key}`)
  const result = await serialOta.run(VEIN_FIRMWARE_TARGET, { isBusy: () => isDeviceBusy.value })
  appendDiag(`[ota] 開発端末の自動更新 ${key} → ${result}`)
})

onMounted(() => {
  readDev()
  window.addEventListener(DEV_DEVICE_MARK_EVENT, readDev)
})
onBeforeUnmount(() => {
  stopRefresh()
  window.removeEventListener(DEV_DEVICE_MARK_EVENT, readDev)
})
</script>

<template>
  <!-- 描くものは無い -->
</template>
