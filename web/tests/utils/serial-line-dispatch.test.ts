import { describe, it, expect, vi } from 'vitest'
import { createLineDispatch } from '~/utils/serial-line-dispatch'

// CoreS3 / Atom S3 / Vein Station が共有する行の配り方 (Refs ippoan/alc-app#436)
describe('createLineDispatch', () => {
  it('EVT は名前と引数に割って配る', () => {
    const d = createLineDispatch('T')
    const seen: Array<[string, string[]]> = []
    d.onEvent((name, args) => seen.push([name, args]))

    d.dispatchLine('EVT NFC_LICENSE issue=20230401 expiry=20280401')
    d.dispatchLine('EVT NFC_READY')

    expect(seen).toEqual([
      ['NFC_LICENSE', ['issue=20230401', 'expiry=20280401']],
      ['NFC_READY', []],
    ])
  })

  it('JSON は読んで配り、壊れていたら label 付きで警告して捨てる', () => {
    const d = createLineDispatch('T')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: unknown[] = []
    d.onJson(msg => seen.push(msg))

    d.dispatchLine('{"type":"alcohol","value":0.1}')
    d.dispatchLine('{broken')

    expect(seen).toEqual([{ type: 'alcohol', value: 0.1 }])
    expect(warn).toHaveBeenCalledWith('[T] Invalid JSON:', '{broken')
    warn.mockRestore()
  })

  it('EVT でも JSON でもない行 (コマンドの応答等) は配らない', () => {
    const d = createLineDispatch('T')
    const seen: unknown[] = []
    d.onEvent(name => seen.push(name))
    d.onJson(msg => seen.push(msg))

    d.dispatchLine('VEIN CHARA 0a1b')
    d.dispatchLine('OK VEIN SAY PLACE')
    d.dispatchLine('EVTX')

    expect(seen).toEqual([])
  })

  it('onEvent の返り値で解除できる / 購読者の Set は呼び出しごとに別', () => {
    const a = createLineDispatch('A')
    const b = createLineDispatch('B')
    const seenA: string[] = []
    const seenB: string[] = []
    const offA = a.onEvent(name => seenA.push(name))
    b.onEvent(name => seenB.push(name))

    a.dispatchEvent('EVT ONE')
    offA()
    a.dispatchEvent('EVT TWO')
    b.dispatchEvent('EVT THREE')

    expect(seenA).toEqual(['ONE'])
    expect(seenB).toEqual(['THREE'])
  })
})
