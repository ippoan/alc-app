import { describe, it, expect, vi, beforeEach } from 'vitest'

// isSupported はモジュールレベルで評価されるため、import 前に navigator.serial を設定
// そのため vi.resetModules() + dynamic import を使う

describe('useSerialDeviceManager', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (navigator as any).serial
  })

  it('WebSerial 非対応なら isSupported = false', async () => {
    const { useSerialDeviceManager } = await import('~/composables/useSerialDeviceManager')
    const { isSupported, ports } = useSerialDeviceManager()
    expect(isSupported).toBe(false)
    expect(ports.value).toEqual([])
  })

  it('WebSerial 非対応で refreshPorts は何もしない', async () => {
    const { useSerialDeviceManager } = await import('~/composables/useSerialDeviceManager')
    const { refreshPorts, ports } = useSerialDeviceManager()
    await refreshPorts()
    expect(ports.value).toEqual([])
  })

  it('WebSerial 非対応で requestNewPort は false', async () => {
    const { useSerialDeviceManager } = await import('~/composables/useSerialDeviceManager')
    const { requestNewPort } = useSerialDeviceManager()
    const result = await requestNewPort()
    expect(result).toBe(false)
  })

  it('WebSerial 対応ならポート一覧を取得', async () => {
    const mockPort = {
      getInfo: () => ({ usbVendorId: 0x1234, usbProductId: 0x5678 }),
      forget: vi.fn(),
    }
    ;(navigator as any).serial = {
      getPorts: vi.fn().mockResolvedValue([mockPort]),
      requestPort: vi.fn().mockResolvedValue(mockPort),
    }

    const { useSerialDeviceManager } = await import('~/composables/useSerialDeviceManager')
    const { isSupported, refreshPorts, ports } = useSerialDeviceManager()
    expect(isSupported).toBe(true)

    await refreshPorts()
    expect(ports.value).toHaveLength(1)
    expect(ports.value[0].info.usbVendorId).toBe(0x1234)
  })

  it('requestNewPort でポート追加 + refreshPorts', async () => {
    const mockPort = {
      getInfo: () => ({ usbVendorId: 0x1234 }),
      forget: vi.fn(),
    }
    ;(navigator as any).serial = {
      getPorts: vi.fn().mockResolvedValue([mockPort]),
      requestPort: vi.fn().mockResolvedValue(mockPort),
    }

    const { useSerialDeviceManager } = await import('~/composables/useSerialDeviceManager')
    const { requestNewPort, ports } = useSerialDeviceManager()
    const result = await requestNewPort()
    expect(result).toBe(true)
    expect(ports.value).toHaveLength(1)
  })

  it('requestNewPort でキャンセルされたら false', async () => {
    ;(navigator as any).serial = {
      getPorts: vi.fn().mockResolvedValue([]),
      requestPort: vi.fn().mockRejectedValue(new DOMException('', 'NotFoundError')),
    }

    const { useSerialDeviceManager } = await import('~/composables/useSerialDeviceManager')
    const { requestNewPort } = useSerialDeviceManager()
    const result = await requestNewPort()
    expect(result).toBe(false)
  })

  it('forgetPort でポートを削除', async () => {
    const mockForget = vi.fn().mockResolvedValue(undefined)
    const mockPort = {
      getInfo: () => ({}),
      forget: mockForget,
    }
    ;(navigator as any).serial = {
      getPorts: vi.fn().mockResolvedValue([]),
      requestPort: vi.fn(),
    }

    const { useSerialDeviceManager } = await import('~/composables/useSerialDeviceManager')
    const { forgetPort } = useSerialDeviceManager()
    await forgetPort(mockPort as any)
    expect(mockForget).toHaveBeenCalledOnce()
  })

  // ---------- connect イベント購読 (Refs ippoan/alc-app#221) ----------

  describe('onPortConnected', () => {
    it('2 回呼んでも addEventListener は 1 回だけ', async () => {
      const addEventListener = vi.fn()
      ;(navigator as any).serial = {
        getPorts: vi.fn().mockResolvedValue([]),
        requestPort: vi.fn(),
        addEventListener,
      }

      const { onPortConnected } = await import('~/composables/useSerialDeviceManager')
      onPortConnected(vi.fn())
      onPortConnected(vi.fn())

      expect(addEventListener).toHaveBeenCalledTimes(1)
      expect(addEventListener).toHaveBeenCalledWith('connect', expect.any(Function))
    })

    it('addEventListener が無い mock でも落ちない', async () => {
      ;(navigator as any).serial = {
        getPorts: vi.fn().mockResolvedValue([]),
        requestPort: vi.fn(),
      }

      const { onPortConnected } = await import('~/composables/useSerialDeviceManager')
      expect(() => onPortConnected(vi.fn())).not.toThrow()
    })

    it('WebSerial 非対応でも落ちない (addEventListener を張らない)', async () => {
      // beforeEach で navigator.serial は既に無い
      const { onPortConnected } = await import('~/composables/useSerialDeviceManager')
      expect(() => onPortConnected(vi.fn())).not.toThrow()
    })
  })
})
