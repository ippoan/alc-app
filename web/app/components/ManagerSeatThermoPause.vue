<script setup lang="ts">
/**
 * 運行管理者の画面にいる間、指静脈の端末 (Vein Base) に体温計へつながせない (Refs ippoan/alc-app-s3#352)。
 *
 * 体温計 (ニプロ NT-100B) は**最初につないだ 1 台にだけ**測定値を送る。運行管理者席の Vein Base も
 * キオスクの Vein Station と同じファーム (hub-ble) で体温計を探すので、同じ机に置くと席が値を先に
 * 受け取り、キオスクに体温が届かなかった (2026-11-02 実測: 席が 37.1 ℃ を受け取った 0.15 秒後に
 * キオスクがつないで空振り)。席は体温を測らないので、運行管理者の役割の間は `THERMO OFF` を送る。
 *
 * - つながるたびに送る (機体は保存しない。電源を入れ直すと ON に戻る)
 * - 運行管理者の画面を離れたら `THERMO ON` に戻す
 * - `THERMO` を知らない古いファームは断るだけ (体温計はそれまでどおり探す)。描くものは無い
 */
import { appendDiag } from '~/utils/serialDiagLog'

/** `THERMO` の応答を待つ上限 (ms)。古いファームは `ERR` ですぐ返る */
const THERMO_TIMEOUT_MS = 3_000

const vein = useVeinSerial()

async function setThermo(on: boolean): Promise<void> {
  const want = on ? 'ON' : 'OFF'
  try {
    const line = await vein.request(`THERMO ${want}`, 'OK THERMO=', THERMO_TIMEOUT_MS, 'ERR')
    appendDiag(`[thermo] 運行管理者の画面 ${line}`)
  }
  catch (e) {
    appendDiag(`[thermo] THERMO ${want} を送れませんでした: ${(e as Error).message}`)
  }
}

watch(vein.isConnected, (connected) => {
  if (connected) void setThermo(false)
}, { immediate: true })

onUnmounted(() => {
  if (vein.isConnected.value) void setThermo(true)
})
</script>

<template>
  <!-- 描くものは無い -->
</template>
