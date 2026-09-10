import { isWebSerialSupported } from '~/utils/webserial'

export interface PortEntry {
  port: SerialPort
  info: SerialPortInfo
}

// --- ポートの挿し直し検知 (module 単位、Refs ippoan/alc-app#221) ---
//
// navigator.serial の `connect` は挿した瞬間に発火するので、これを購読しておけば
// 抜き挿し後の掴み直しを RESCAN_INTERVAL (10 秒) の周期に頼らず即座に始められる。
// 購読者 (useSerialArbiter) は 1 つしか居ないが、増えても addEventListener が
// 重複しないよう module 単位で 1 回だけ張る。解除はしない (arbiter は張りっぱなし)。

let connectListening = false
const connectListeners: Array<(port: SerialPort) => void> = []

/**
 * `navigator.serial` の `connect` イベントを購読する。初回呼び出しでだけ
 * `addEventListener` を張り (`useSerialDeviceManager()` はシングルトンではなく
 * 呼ぶたびに新しいインスタンスができるため、本体の中では張らない)、以後は
 * ここに積んだ購読者へ配る。WebSerial 非対応、または `addEventListener` が
 * 無い環境では何もしない。
 */
export function onPortConnected(cb: (port: SerialPort) => void): void {
  connectListeners.push(cb)
  if (connectListening) return
  if (!isWebSerialSupported()) return
  if (typeof navigator.serial.addEventListener !== 'function') return
  connectListening = true
  navigator.serial.addEventListener('connect', (ev) => {
    const port = ev.target as SerialPort
    for (const listener of connectListeners) listener(port)
  })
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
