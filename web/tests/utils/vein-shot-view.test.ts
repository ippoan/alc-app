import { describe, it, expect, vi, beforeEach } from 'vitest'

const dev = vi.hoisted(() => ({ kiosk: false, manager: false }))
vi.mock('~/utils/token-selection', () => ({
  isDevDevice: (kind: string) => (kind === 'kiosk' ? dev.kiosk : dev.manager),
}))

const {
  clearVeinShotView, noteVeinShotView, overlayVeinPlanes, pickEnrollPlane, useVeinShotView,
  VEIN_COLORS, VEIN_PLANE_H, VEIN_PLANE_W, veinShiftText,
} = await import('~/utils/vein-shot-view')

const N = VEIN_PLANE_W * VEIN_PLANE_H
const shift = { entry: 7, dx: 6, dy: -3, overlap: 812, overlap0: 344 }
const v = { shift, shot: new Uint8Array([1]), employeeId: 'e1', scope: 'default' as const, at: 1 }

function px(out: Uint8ClampedArray, x: number, y: number): number[] {
  const i = (y * VEIN_PLANE_W + x) * 4
  return [...out.subarray(i, i + 4)]
}

describe('vein-shot-view', () => {
  beforeEach(() => {
    dev.kiosk = false
    dev.manager = false
    clearVeinShotView()
  })

  it('開発用の端末 (キオスクか運行管理者席) だけ置く', () => {
    noteVeinShotView(v)
    expect(useVeinShotView().value).toBeNull()
    dev.manager = true
    noteVeinShotView(v)
    expect(useVeinShotView().value).toEqual(v)
    clearVeinShotView()
    dev.manager = false
    dev.kiosk = true
    noteVeinShotView(v)
    expect(useVeinShotView().value).toEqual(v)
  })

  it('ずれを日本語にする (右・下が正)', () => {
    expect(veinShiftText(shift)).toBe('登録より右に 6・上に 3ずれ (重なり 81%、ずらさずに 34%)')
    expect(veinShiftText({ ...shift, dx: -2, dy: 4 })).toBe('登録より左に 2・下に 4ずれ (重なり 81%、ずらさずに 34%)')
    expect(veinShiftText({ ...shift, dx: 0, dy: 0 })).toBe('登録と同じ位置 (重なり 81%、ずらさずに 34%)')
  })

  it('enroll_planes の並びから件の平面を取り出す (無ければ null)', () => {
    const a = new Uint8Array(1 + N)
    const b = new Uint8Array(1 + N)
    a[0] = 6
    b[0] = 9
    b[1] = 1
    const all = new Uint8Array([...a, ...b])
    expect(pickEnrollPlane(all, 9)![0]).toBe(1)
    expect(pickEnrollPlane(all, 9)!.length).toBe(N)
    expect(pickEnrollPlane(all, 3)).toBeNull()
  })

  it('重ねた画素: 登録だけ灰・撮影だけ赤・両方緑。ずれを戻すと重なる', () => {
    const enroll = new Uint8Array(N)
    const shot = new Uint8Array(N)
    enroll[10 * VEIN_PLANE_W + 20] = 1
    shot[7 * VEIN_PLANE_W + 26] = 1 // 右に 6・上に 3
    const raw = overlayVeinPlanes(enroll, shot)
    expect(px(raw, 20, 10)).toEqual(VEIN_COLORS.enroll)
    expect(px(raw, 26, 7)).toEqual(VEIN_COLORS.shot)
    expect(px(raw, 0, 0)).toEqual(VEIN_COLORS.none)
    const aligned = overlayVeinPlanes(enroll, shot, 6, -3)
    expect(px(aligned, 20, 10)).toEqual(VEIN_COLORS.both)
    expect(px(aligned, 26, 7)).toEqual(VEIN_COLORS.none)
    // はみ出す画素は捨てる
    const edge = new Uint8Array(N)
    edge[0] = 1
    expect(px(overlayVeinPlanes(new Uint8Array(N), edge, 1, 0), 0, 0)).toEqual(VEIN_COLORS.none)
  })
})
