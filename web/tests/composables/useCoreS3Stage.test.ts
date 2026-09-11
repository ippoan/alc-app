import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import type { MeasurementResult } from '~/types'

// useCoreS3Stage はモジュールスコープに直近送信 (current) + onOpen 購読済みフラグ (wired)
// を持つシングルトンなので、テスト毎に resetModules + dynamic import で分離する
// (useDeviceToken.test.ts と同型)。useCoreS3Serial は Nuxt auto-import なので mockNuxtImport。
const coreS3Mock = vi.hoisted(() => ({
  isConnected: { value: true },
  write: vi.fn(async () => true),
  onOpen: vi.fn(),
}))
mockNuxtImport('useCoreS3Serial', () => () => coreS3Mock)

type Mod = typeof import('~/composables/useCoreS3Stage')

async function load(): Promise<Mod> {
  return await import('~/composables/useCoreS3Stage')
}

function makeResult(overrides: Partial<MeasurementResult> = {}): MeasurementResult {
  return {
    employeeId: 'emp-1',
    alcoholValue: 0.1,
    resultType: 'normal',
    deviceUseCount: 1,
    measuredAt: new Date('2026-01-01'),
    ...overrides,
  }
}

describe('useCoreS3Stage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    coreS3Mock.isConnected.value = true
    coreS3Mock.write.mockReset()
    coreS3Mock.write.mockResolvedValue(true)
    coreS3Mock.onOpen.mockReset()
  })

  describe('stageForStep — 対応表 (全 step 名)', () => {
    it.each([
      ['nfc', 'NFC'],
      ['interrupted', 'NFC'],
      ['cancelled', 'NFC'],
      ['medical', 'TEMP'],
      ['measuring', 'ALCOHOL'],
      ['alcohol', 'ALCOHOL'],
      ['schedule_select', 'PC'],
      ['face_auth', 'PC'],
      ['self_declaration', 'PC'],
      ['daily_inspection', 'PC'],
      ['carrying_items', 'PC'],
      ['safety_result', 'PC'],
      ['result', null],
      ['instruction', null],
      ['report', null],
      ['completed', null],
      ['unknown_step_xyz', null],
    ] as const)('%s → %s', async (step, expected) => {
      const { stageForStep } = await load()
      expect(stageForStep(step)).toBe(expected)
    })
  })

  describe('syncStep', () => {
    it('対応表にある step で STAGE <段階> を送る', async () => {
      const { useCoreS3Stage } = await load()
      const { syncStep } = useCoreS3Stage()
      syncStep('nfc')
      expect(coreS3Mock.write).toHaveBeenCalledWith('STAGE NFC')
    })

    it('対応表に無い step では何も送らない', async () => {
      const { useCoreS3Stage } = await load()
      const { syncStep } = useCoreS3Stage()
      syncStep('result')
      expect(coreS3Mock.write).not.toHaveBeenCalled()
    })

    it('同じ段が続いても再送しない (再送すると CoreS3 側で値が消えることがある)', async () => {
      const { useCoreS3Stage } = await load()
      const { syncStep } = useCoreS3Stage()
      syncStep('nfc')
      syncStep('nfc')
      expect(coreS3Mock.write).toHaveBeenCalledTimes(1)
    })

    it('段が変われば送る', async () => {
      const { useCoreS3Stage } = await load()
      const { syncStep } = useCoreS3Stage()
      syncStep('nfc')
      syncStep('medical')
      expect(coreS3Mock.write).toHaveBeenNthCalledWith(1, 'STAGE NFC')
      expect(coreS3Mock.write).toHaveBeenNthCalledWith(2, 'STAGE TEMP')
    })

    it('未接続では何も送らない', async () => {
      coreS3Mock.isConnected.value = false
      const { useCoreS3Stage } = await load()
      const { syncStep } = useCoreS3Stage()
      syncStep('nfc')
      expect(coreS3Mock.write).not.toHaveBeenCalled()
    })

    it('onOpen (CoreS3 の再接続) で直近の段を再送する', async () => {
      const { useCoreS3Stage } = await load()
      const { syncStep } = useCoreS3Stage()
      syncStep('medical')
      expect(coreS3Mock.onOpen).toHaveBeenCalledTimes(1)

      const onOpenCb = coreS3Mock.onOpen.mock.calls[0]![0] as () => void
      coreS3Mock.write.mockClear()
      onOpenCb()
      expect(coreS3Mock.write).toHaveBeenCalledWith('STAGE TEMP')
    })

    it('未接続のまま送った段も、接続後の onOpen で送られる', async () => {
      coreS3Mock.isConnected.value = false
      const { useCoreS3Stage } = await load()
      const { syncStep } = useCoreS3Stage()
      syncStep('nfc')
      expect(coreS3Mock.write).not.toHaveBeenCalled()

      const onOpenCb = coreS3Mock.onOpen.mock.calls[0]![0] as () => void
      coreS3Mock.isConnected.value = true
      onOpenCb()
      expect(coreS3Mock.write).toHaveBeenCalledWith('STAGE NFC')
    })

    it('複数 component から呼んでも onOpen の購読は 1 回だけ (シングルトン)', async () => {
      const { useCoreS3Stage } = await load()
      useCoreS3Stage()
      useCoreS3Stage()
      expect(coreS3Mock.onOpen).toHaveBeenCalledTimes(1)
    })

    it('何も送っていないうちに onOpen が来ても何もしない', async () => {
      const { useCoreS3Stage } = await load()
      useCoreS3Stage()
      const onOpenCb = coreS3Mock.onOpen.mock.calls[0]![0] as () => void
      onOpenCb()
      expect(coreS3Mock.write).not.toHaveBeenCalled()
    })
  })

  describe('sendResult', () => {
    it('normal → RESULT OK <値> (小数 3 桁)', async () => {
      const { useCoreS3Stage } = await load()
      const { sendResult } = useCoreS3Stage()
      sendResult(makeResult({ alcoholValue: 0.1, resultType: 'normal' }))
      expect(coreS3Mock.write).toHaveBeenCalledWith('RESULT OK 0.100')
    })

    it('over → RESULT NG', async () => {
      const { useCoreS3Stage } = await load()
      const { sendResult } = useCoreS3Stage()
      sendResult(makeResult({ alcoholValue: 0.5, resultType: 'over' }))
      expect(coreS3Mock.write).toHaveBeenCalledWith('RESULT NG 0.500')
    })

    it('error → RESULT NG', async () => {
      const { useCoreS3Stage } = await load()
      const { sendResult } = useCoreS3Stage()
      sendResult(makeResult({ alcoholValue: 0, resultType: 'error' }))
      expect(coreS3Mock.write).toHaveBeenCalledWith('RESULT NG 0.000')
    })

    it('未接続では何も送らない', async () => {
      coreS3Mock.isConnected.value = false
      const { useCoreS3Stage } = await load()
      const { sendResult } = useCoreS3Stage()
      sendResult(makeResult())
      expect(coreS3Mock.write).not.toHaveBeenCalled()
    })
  })
})
