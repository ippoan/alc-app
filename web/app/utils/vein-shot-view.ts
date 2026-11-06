/**
 * 開発用の端末だけ、置いた指 (撮影) と登録の件の平面を画面の隅に描くための置き場 (Refs ippoan/alc-app-s3#352)。
 *
 * 指静脈の照合が外れる回が、置き方 (位置) のせいかを目で見るため。サーバーの本人との判定が返した位置のずれ
 * (`postVeinAuthShot` の `shift`) と撮影をここに置き、`components/VeinShiftView.vue` が登録の記録を引いて
 * wasm (`shot_plane` / `enroll_planes`) で平面にして描く。平面は端末の中だけで描き、どこにも送らない。
 * 開発用の端末でなければ何も置かない。
 */
import { shallowRef } from 'vue'
import type { RequestTokenScope, VeinShotShift } from '~/utils/api'
import { isDevDevice } from '~/utils/token-selection'

/** 平面の幅・高さ (vein-match の WIDTH / HEIGHT) */
export const VEIN_PLANE_W = 120
export const VEIN_PLANE_H = 72

export interface VeinShotView {
  shift: VeinShotShift
  /** `VEIN IDENTIFY KEEP ALL` で撮った生の記録 */
  shot: Uint8Array
  employeeId: string
  /** 認証ログを送った鍵 (登録の記録を同じ鍵・同じ組み方で引く) */
  scope: RequestTokenScope
  pick?: 'own'
  /** 置いた時刻 (ms) */
  at: number
}

const view = shallowRef<VeinShotView | null>(null)

/** いま描く撮影 (無ければ null) */
export function useVeinShotView() {
  return view
}

/** 開発用の端末なら、描く撮影を差し替える */
export function noteVeinShotView(v: VeinShotView): void {
  if (isDevDevice('kiosk') || isDevDevice('manager-device')) view.value = v
}

/** 描くのをやめる */
export function clearVeinShotView(): void {
  view.value = null
}

/** ずれを日本語にする (撮影が登録より右・下なら正) */
export function veinShiftText(s: VeinShotShift): string {
  const parts: string[] = []
  if (s.dx) parts.push(`${s.dx > 0 ? '右' : '左'}に ${Math.abs(s.dx)}`)
  if (s.dy) parts.push(`${s.dy > 0 ? '下' : '上'}に ${Math.abs(s.dy)}`)
  const where = parts.length ? `登録より${parts.join('・')}ずれ` : '登録と同じ位置'
  return `${where} (重なり ${Math.round(s.overlap / 10)}%、ずらさずに ${Math.round(s.overlap0 / 10)}%)`
}

/** `enroll_planes` の戻り (`[件の通し番号, 平面]` の並び) から、通し番号 `entry` の平面を取り出す */
export function pickEnrollPlane(planes: Uint8Array, entry: number): Uint8Array | null {
  const size = 1 + VEIN_PLANE_W * VEIN_PLANE_H
  for (let o = 0; o + size <= planes.length; o += size) {
    if (planes[o] === entry) return planes.subarray(o + 1, o + size)
  }
  return null
}

/** 画素の色 (RGBA) */
export type VeinPixel = [number, number, number, number]

/** 登録だけ・撮影だけ・両方の色 */
export const VEIN_COLORS: { enroll: VeinPixel, shot: VeinPixel, both: VeinPixel, none: VeinPixel } = {
  enroll: [150, 150, 150, 255],
  shot: [220, 38, 38, 255],
  both: [22, 163, 74, 255],
  none: [255, 255, 255, 255],
}

/**
 * 登録の平面と撮影の平面を 1 枚に重ねた画素 (RGBA、幅 120 × 高さ 72)。`dx`・`dy` だけ撮影を戻して
 * (撮影の (x, y) を (x - dx, y - dy) に) 重ねる。0, 0 ならそのまま
 */
export function overlayVeinPlanes(enroll: Uint8Array, shot: Uint8Array, dx = 0, dy = 0): Uint8ClampedArray {
  const W = VEIN_PLANE_W
  const H = VEIN_PLANE_H
  const moved = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!shot[y * W + x]) continue
      const tx = x - dx
      const ty = y - dy
      if (tx >= 0 && tx < W && ty >= 0 && ty < H) moved[ty * W + tx] = 1
    }
  }
  const out = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    const e = enroll[i] ? 1 : 0
    const s = moved[i] ? 1 : 0
    const c = e && s ? VEIN_COLORS.both : e ? VEIN_COLORS.enroll : s ? VEIN_COLORS.shot : VEIN_COLORS.none
    out.set(c, i * 4)
  }
  return out
}
