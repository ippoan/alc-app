import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useUsbHub } from '~/composables/useUsbHub'

// USB で挿す機体を機能ごとの組で返す (Refs ippoan/alc-app#436)。
// 各機体の composable は「接続有無・EVT・JSON の購読」だけを持つモックにする

type EventCb = (name: string, args: string[]) => void
type JsonCb = (msg: unknown) => void

function fakeDevice() {
  const isConnected = ref(false)
  const events = new Set<EventCb>()
  const jsons = new Set<JsonCb>()
  return {
    isConnected,
    events,
    jsons,
    api: {
      isConnected: readonly(isConnected),
      onEvent: (cb: EventCb) => { events.add(cb); return () => { events.delete(cb) } },
      onJson: (cb: JsonCb) => { jsons.add(cb) },
    },
    emitEvent(name: string, args: string[]) { for (const cb of [...events]) cb(name, args) },
    emitJson(msg: unknown) { for (const cb of [...jsons]) cb(msg) },
  }
}

const core = fakeDevice()
const atom = fakeDevice()
const vein = fakeDevice()
mockNuxtImport('useCoreS3Serial', () => () => core.api)
mockNuxtImport('useAtomS3Serial', () => () => atom.api)
mockNuxtImport('useVeinSerial', () => () => vein.api)

describe('useUsbHub', () => {
  beforeEach(() => {
    core.isConnected.value = false
    atom.isConnected.value = false
    vein.isConnected.value = false
    for (const d of [core, atom, vein]) { d.events.clear(); d.jsons.clear() }
  })

  it('何もつながっていなければ、どの組も未接続', () => {
    const hub = useUsbHub()
    for (const r of [hub.nfc, hub.alcohol, hub.thermo]) {
      expect(r.isConnected.value).toBe(false)
      expect(r.device.value).toBeNull()
      expect(r.label.value).toBeNull()
      expect(r.connected.value).toEqual([])
    }
  })

  it('CoreS3 だけ: 3 組とも CoreS3', () => {
    core.isConnected.value = true
    const hub = useUsbHub()
    expect(hub.nfc.label.value).toBe('CoreS3')
    expect(hub.alcohol.device.value).toEqual({ kind: 'cores3', label: 'CoreS3' })
    expect(hub.thermo.isConnected.value).toBe(true)
  })

  it('Vein Station だけ: 3 組とも Vein Station', () => {
    vein.isConnected.value = true
    const hub = useUsbHub()
    expect(hub.nfc.label.value).toBe('Vein Station')
    expect(hub.alcohol.device.value).toEqual({ kind: 'vein-station', label: 'Vein Station' })
    expect(hub.thermo.label.value).toBe('Vein Station')
  })

  it('測定台の ATOM S3 だけ: NFC の組にだけ入る (FC-1200・体温計はつながない)', () => {
    atom.isConnected.value = true
    const hub = useUsbHub()
    expect(hub.nfc.label.value).toBe('ATOM S3')
    expect(hub.alcohol.isConnected.value).toBe(false)
    expect(hub.thermo.isConnected.value).toBe(false)
  })

  it('優先順は CoreS3 → ATOM S3 → Vein Station。connected は全部を優先順で持つ', () => {
    core.isConnected.value = true
    atom.isConnected.value = true
    vein.isConnected.value = true
    const hub = useUsbHub()
    expect(hub.nfc.connected.value.map(d => d.kind)).toEqual(['cores3', 'bp-station', 'vein-station'])
    expect(hub.nfc.label.value).toBe('CoreS3')
    expect(hub.alcohol.connected.value.map(d => d.kind)).toEqual(['cores3', 'vein-station'])

    core.isConnected.value = false
    expect(hub.nfc.label.value).toBe('ATOM S3')
    expect(hub.alcohol.label.value).toBe('Vein Station')
  })

  it('onEvent は組の全機体を購読し、どの機体から来たかを渡す。返り値で全部解除', () => {
    const hub = useUsbHub()
    const cb = vi.fn()
    const off = hub.nfc.onEvent(cb)

    core.emitEvent('NFC_LICENSE', ['issue=1'])
    atom.emitEvent('NFC_LICENSE', ['issue=2'])
    vein.emitEvent('NFC_LICENSE', ['issue=3'])
    expect(cb.mock.calls).toEqual([
      ['NFC_LICENSE', ['issue=1'], 'cores3'],
      ['NFC_LICENSE', ['issue=2'], 'bp-station'],
      ['NFC_LICENSE', ['issue=3'], 'vein-station'],
    ])

    off()
    for (const d of [core, atom, vein]) expect(d.events.size).toBe(0)
  })

  it('alcohol の onEvent は ATOM S3 を購読しない', () => {
    const hub = useUsbHub()
    const cb = vi.fn()
    hub.alcohol.onEvent(cb)
    atom.emitEvent('FC1200', ['MEASURING'])
    expect(cb).not.toHaveBeenCalled()
    vein.emitEvent('FC1200', ['MEASURING'])
    expect(cb).toHaveBeenCalledWith('FC1200', ['MEASURING'], 'vein-station')
  })

  it('onJson は組の全機体の JSON を受ける', () => {
    const hub = useUsbHub()
    const cb = vi.fn()
    hub.thermo.onJson(cb)
    core.emitJson({ type: 'temperature', value: 36.1 })
    vein.emitJson({ type: 'temperature', value: 36.2 })
    atom.emitJson({ type: 'temperature', value: 36.3 })
    expect(cb.mock.calls).toEqual([[{ type: 'temperature', value: 36.1 }], [{ type: 'temperature', value: 36.2 }]])
  })
})
