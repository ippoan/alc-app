import { isWebSerialSupported } from '~/utils/webserial'

export interface PortEntry {
  port: SerialPort
  info: SerialPortInfo
}

export function useSerialDeviceManager() {
  const ports = ref<PortEntry[]>([])
  const isSupported = isWebSerialSupported()

  async function refreshPorts() {
    if (!isSupported) return
    const rawPorts = await navigator.serial.getPorts()
    ports.value = rawPorts.map(p => ({
      port: p,
      info: p.getInfo(),
    }))
  }

  async function requestNewPort(): Promise<boolean> {
    if (!isSupported) return false
    try {
      await navigator.serial.requestPort()
      await refreshPorts()
      return true
    }
    catch {
      return false
    }
  }

  async function forgetPort(target: SerialPort): Promise<void> {
    await target.forget()
    await refreshPorts()
  }

  return {
    ports: readonly(ports),
    isSupported,
    refreshPorts,
    requestNewPort,
    forgetPort,
  }
}
