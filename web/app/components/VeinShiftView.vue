<script setup lang="ts">
/**
 * 開発用の端末だけ、指静脈の認証のたびに、置いた指 (撮影) と登録の件の平面を画面の隅に描く
 * (Refs ippoan/alc-app-s3#352)。置き方 (位置) のずれを目で見るため。
 *
 * - 左: そのまま重ねた図 (灰 = 登録だけ、赤 = 置いた指だけ、緑 = 重なった所)
 * - 右: サーバーが求めたずれ (dx, dy) だけ置いた指を戻して重ねた図
 * - 下: 「登録より右に 6・上に 3 ずれ (重なり 81%、ずらさずに 34%)」
 *
 * 登録の記録は認証ログを送った鍵・組み方で引き直し、wasm (`enroll_planes` / `shot_plane`) で平面にする。
 * 平面はこの画面の中だけで描き、どこにも送らない。30 秒で消える (× でも消せる)。
 */
import { getVeinModuleTemplate } from '~/utils/api'
import { loadVeinWasm } from '~/utils/vein-match'
import { enroll_planes, shot_plane } from '~/vendor/vein-match/vein_match_wasm'
import { clearVeinShotView, overlayVeinPlanes, pickEnrollPlane, useVeinShotView, VEIN_PLANE_H, VEIN_PLANE_W, veinShiftText } from '~/utils/vein-shot-view'

/** 表示しておく時間 */
const SHOW_MS = 30_000
/** 1 画素を何倍で描くか */
const SCALE = 2

const view = useVeinShotView()
const raw = ref<HTMLCanvasElement | null>(null)
const aligned = ref<HTMLCanvasElement | null>(null)
const error = ref<string | null>(null)
let hideTimer: ReturnType<typeof setTimeout> | undefined

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

function paint(canvas: HTMLCanvasElement | null, pixels: Uint8ClampedArray): void {
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  const img = new ImageData(new Uint8ClampedArray(pixels), VEIN_PLANE_W, VEIN_PLANE_H)
  // 等倍で置いてから拡大する (ぼかさない)
  const tmp = document.createElement('canvas')
  tmp.width = VEIN_PLANE_W
  tmp.height = VEIN_PLANE_H
  tmp.getContext('2d')?.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height)
}

watch(view, async (v) => {
  clearTimeout(hideTimer)
  error.value = null
  if (!v) return
  hideTimer = setTimeout(clearVeinShotView, SHOW_MS)
  try {
    await loadVeinWasm()
    const record = await getVeinModuleTemplate(v.employeeId, { pick: v.pick, scope: v.scope })
    if (!record) throw new Error('登録の記録がありません')
    const planes = enroll_planes(base64ToBytes(record.record))
    const enroll = planes ? pickEnrollPlane(planes, v.shift.entry) : null
    const shot = shot_plane(v.shot)
    if (!enroll || !shot) throw new Error('平面にできませんでした')
    await nextTick()
    paint(raw.value, overlayVeinPlanes(enroll, shot))
    paint(aligned.value, overlayVeinPlanes(enroll, shot, v.shift.dx, v.shift.dy))
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})

onUnmounted(() => clearTimeout(hideTimer))
</script>

<template>
  <div
    v-if="view"
    class="fixed bottom-12 right-3 z-50 rounded-lg bg-white/95 shadow-lg border border-gray-300 p-2 text-xs text-gray-800"
    data-testid="vein-shift-view"
  >
    <div class="flex items-center justify-between mb-1">
      <span class="font-bold">指の位置 (開発用)</span>
      <button type="button" class="px-2 text-gray-500 hover:text-gray-800" aria-label="閉じる" @click="clearVeinShotView">
        ×
      </button>
    </div>
    <div class="flex gap-2">
      <figure>
        <canvas ref="raw" :width="VEIN_PLANE_W * SCALE" :height="VEIN_PLANE_H * SCALE" class="border border-gray-200" />
        <figcaption class="text-center">そのまま</figcaption>
      </figure>
      <figure>
        <canvas ref="aligned" :width="VEIN_PLANE_W * SCALE" :height="VEIN_PLANE_H * SCALE" class="border border-gray-200" />
        <figcaption class="text-center">ずれを戻して重ねた</figcaption>
      </figure>
    </div>
    <p class="mt-1" data-testid="vein-shift-text">
      {{ veinShiftText(view.shift) }}
    </p>
    <p class="text-gray-500">
      灰 = 登録 / 赤 = 置いた指 / 緑 = 重なった所 (件 {{ view.shift.entry }})
    </p>
    <p v-if="error" class="text-red-600">
      {{ error }}
    </p>
  </div>
</template>
