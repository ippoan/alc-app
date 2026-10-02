// 機体の版が配布中の版と違うときの帯 (Refs ippoan/alc-app#425)。
// 帯を出す条件・押下・結果の出し分け・配布中の版の取り直し (60 分) と切断を見る。
// 「更新中」の幕は FirmwareOtaHost の持ち物なので、ここには無い
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import DeviceFirmwareNotice from '~/components/DeviceFirmwareNotice.vue'
import type { SerialOtaResult, SerialOtaState } from '~/composables/useSerialOta'

const fetchLatest = vi.hoisted(() => vi.fn())
vi.mock('~/utils/firmware-updates', async importOriginal => ({
  ...await importOriginal<typeof import('~/utils/firmware-updates')>(),
  fetchLatestFirmwareVersions: fetchLatest,
}))

const ota = vi.hoisted(() => ({ state: null as unknown as { value: SerialOtaState } }))
mockNuxtImport('useSerialOta', () => () => ota)

const kioskScreen = vi.hoisted(() => ({ isDeviceBusy: null as unknown as { value: boolean } }))
mockNuxtImport('useKioskScreen', () => () => kioskScreen)

const HOUR_MS = 60 * 60 * 1000
const INSTALLER = 'https://ippoan.github.io/alc-app-s3/'

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const root = (w: Wrapper) => w.find('[data-testid="device-firmware-notice"]')
const startButton = (w: Wrapper) => w.find('[data-testid="device-firmware-start"]')
const resultLine = (w: Wrapper) => w.find('[data-testid="device-firmware-result"]')

describe('DeviceFirmwareNotice', () => {
  let start: ReturnType<typeof vi.fn<() => Promise<SerialOtaResult>>>

  const mount = async (over: Record<string, unknown> = {}): Promise<Wrapper> => {
    const w = await mountSuspended(DeviceFirmwareNotice, {
      props: { target: 'cores3', version: '0.1.0', flavor: 'cores3', connected: true, start, ...over },
    })
    await flushPromises()
    return w
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    vi.clearAllMocks()
    ota.state = ref<SerialOtaState>({ kind: 'idle' })
    kioskScreen.isDeviceBusy = ref(false)
    fetchLatest.mockResolvedValue({ cores3: '0.2.0' })
    start = vi.fn(async () => 'updated' as SerialOtaResult)
  })

  afterEach(() => vi.useRealTimers())

  // ---------- 帯を出す条件 ----------

  it('★ 繋がっていて、版が配布中の版と違えば帯とボタンを出す (対象の語で配布中の版を取る)', async () => {
    const w = await mount()
    expect(fetchLatest).toHaveBeenCalledTimes(1)
    expect(fetchLatest).toHaveBeenCalledWith('cores3')
    expect(root(w).text()).toContain('端末の版が配布中のものと違います')
    expect(startButton(w).text()).toBe('更新する')
    expect(resultLine(w).exists()).toBe(false)
    w.unmount()
  })

  it('大小は比べない (機体の方が新しく見えても、違えば出す)', async () => {
    const w = await mount({ version: '9.0.0' })
    expect(startButton(w).exists()).toBe(true)
    w.unmount()
  })

  it.each([
    ['版が同じ', { version: '0.2.0' }],
    ['版が取れていない', { version: null }],
    ['flavor が取れていない', { flavor: null }],
    ['配布中の版が取れていない flavor', { flavor: 'cores3-wifi' }],
    ['繋がっていない', { connected: false }],
  ] as Array<[string, Record<string, unknown>]>)('%s → 要素を 1 つも出さない', async (_name, over) => {
    const w = await mount(over)
    expect(root(w).exists()).toBe(false)
    expect(w.text()).toBe('')
    w.unmount()
  })

  it('配布中の版が取れなければ帯を出さない (エラーも出さない)', async () => {
    fetchLatest.mockResolvedValue({})
    const w = await mount()
    expect(root(w).exists()).toBe(false)
    expect(w.text()).toBe('')
    w.unmount()
  })

  it('★ 機体を使用中 (点呼・測定・通話・画面共有) の間は出さず、空いたら出る', async () => {
    kioskScreen.isDeviceBusy.value = true
    const w = await mount()
    expect(root(w).exists()).toBe(false)
    kioskScreen.isDeviceBusy.value = false
    await w.vm.$nextTick()
    expect(startButton(w).exists()).toBe(true)
    w.unmount()
  })

  it('★ 更新が走っている間 (state が idle でない) は出さない (幕は FirmwareOtaHost が出す)', async () => {
    ota.state.value = { kind: 'writing', pct: 10 }
    const w = await mount()
    expect(root(w).exists()).toBe(false)
    ota.state.value = { kind: 'idle' }
    await w.vm.$nextTick()
    expect(startButton(w).exists()).toBe(true)
    w.unmount()
  })

  // ---------- 押下 ----------

  it('★ 押すと start を 1 回呼ぶ。結果が返るまでボタンは押せない (二度押しで 2 本目を呼ばない)', async () => {
    let finish!: (r: SerialOtaResult) => void
    start.mockImplementation(() => new Promise<SerialOtaResult>((resolve) => { finish = resolve }))
    const w = await mount()

    // 同じ tick の 2 連打 (disabled が DOM に載る前) でも 2 本目は呼ばない
    startButton(w).element.dispatchEvent(new Event('click'))
    startButton(w).element.dispatchEvent(new Event('click'))
    await w.vm.$nextTick()
    expect(start).toHaveBeenCalledTimes(1)
    expect(startButton(w).attributes('disabled')).toBeDefined()

    finish('updated')
    await flushPromises()
    expect(startButton(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it.each(['updated', 'up_to_date', 'busy', 'skipped', 'failed'] as SerialOtaResult[])('★ start が %s で返ったら、配布中の版を 1 回取り直す', async (outcome) => {
    start.mockResolvedValue(outcome)
    const w = await mount()
    expect(fetchLatest).toHaveBeenCalledTimes(1)
    await startButton(w).trigger('click')
    await flushPromises()
    expect(fetchLatest).toHaveBeenCalledTimes(2)
    expect(fetchLatest).toHaveBeenLastCalledWith('cores3')
    w.unmount()
  })

  it('★ 押すまでの間に配布が変わっていて up_to_date だったら、取り直した版で帯が消える (次の周期を待たない)', async () => {
    start.mockImplementation(async () => {
      fetchLatest.mockResolvedValue({ cores3: '0.1.0' })
      return 'up_to_date'
    })
    const w = await mount()
    await startButton(w).trigger('click')
    await flushPromises()
    expect(root(w).exists()).toBe(false)
    w.unmount()
  })

  it('start が例外で終わっても取り直す', async () => {
    start.mockRejectedValue(new Error('boom'))
    const w = await mount()
    await startButton(w).trigger('click')
    await flushPromises()
    expect(fetchLatest).toHaveBeenCalledTimes(2)
    w.unmount()
  })

  it('押すまでは start を呼ばない (自動では更新しない)', async () => {
    const w = await mount()
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS)
    expect(start).not.toHaveBeenCalled()
    w.unmount()
  })

  // ---------- 結果 ----------

  it.each(['updated', 'up_to_date'] as SerialOtaResult[])('結果 %s → 何も出さない', async (outcome) => {
    start.mockResolvedValue(outcome)
    const w = await mount()
    await startButton(w).trigger('click')
    await flushPromises()
    expect(resultLine(w).exists()).toBe(false)
    w.unmount()
  })

  it.each(['busy', 'skipped'] as SerialOtaResult[])('結果 %s → 「いまは更新できません…」(配布ページへのリンクは出さない)', async (outcome) => {
    start.mockResolvedValue(outcome)
    const w = await mount()
    await startButton(w).trigger('click')
    await flushPromises()
    expect(resultLine(w).text()).toContain('いまは更新できません。少し待ってから、もう一度押してください')
    expect(w.find('a').exists()).toBe(false)
    // もう一度押せる
    expect(startButton(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('★ 結果 failed → 案内と、配布ページの書き直しのページへのリンク (新しいタブ。URL は表から)', async () => {
    start.mockResolvedValue('failed')
    const w = await mount()
    await startButton(w).trigger('click')
    await flushPromises()
    expect(resultLine(w).text()).toContain('更新できませんでした。繰り返すときは、配布ページから書き直してください')
    const link = w.find('[data-testid="device-firmware-installer"]')
    expect(link.attributes('href')).toBe(INSTALLER)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
    w.unmount()
  })

  it('start が例外で終わっても failed と同じ案内を出し、ボタンは戻る', async () => {
    start.mockRejectedValue(new Error('boom'))
    const w = await mount()
    await startButton(w).trigger('click')
    await flushPromises()
    expect(resultLine(w).text()).toContain('更新できませんでした')
    expect(startButton(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('表に無い対象では、failed の案内にリンクを付けない (URL を作らない)', async () => {
    fetchLatest.mockResolvedValue({ x: '0.2.0' })
    start.mockResolvedValue('failed')
    const w = await mount({ target: 'unknown', flavor: 'x' })
    await startButton(w).trigger('click')
    await flushPromises()
    expect(resultLine(w).text()).toContain('配布ページから書き直してください')
    expect(w.find('a').exists()).toBe(false)
    w.unmount()
  })

  it('★ 結果の表示は、機体が使用中になっても・切断しても消えず、「閉じる」で消える', async () => {
    start.mockResolvedValue('failed')
    const w = await mount()
    await startButton(w).trigger('click')
    await flushPromises()

    kioskScreen.isDeviceBusy.value = true
    await w.vm.$nextTick()
    expect(startButton(w).exists()).toBe(false)
    expect(resultLine(w).exists()).toBe(true)
    await w.setProps({ connected: false })
    expect(resultLine(w).exists()).toBe(true)

    await w.find('[data-testid="device-firmware-result-close"]').trigger('click')
    expect(resultLine(w).exists()).toBe(false)
    expect(root(w).exists()).toBe(false)
    w.unmount()
  })

  it('もう一度押すと、前の結果を消してから始める', async () => {
    start.mockResolvedValueOnce('busy').mockResolvedValueOnce('updated')
    const w = await mount()
    await startButton(w).trigger('click')
    await flushPromises()
    expect(resultLine(w).exists()).toBe(true)
    await startButton(w).trigger('click')
    await flushPromises()
    expect(start).toHaveBeenCalledTimes(2)
    expect(resultLine(w).exists()).toBe(false)
    w.unmount()
  })

  it('利用者が読む文に開発者向けの語を出さない', async () => {
    for (const outcome of ['failed', 'busy'] as SerialOtaResult[]) {
      start.mockResolvedValue(outcome)
      const w = await mount()
      await startButton(w).trigger('click')
      await flushPromises()
      expect(w.text()).not.toMatch(/OTA|ファーム|トークン|鍵|認証|試験|開発|FLAVOR|manifest/i)
      w.unmount()
    }
  })

  // ---------- 配布中の版の取り直し ----------

  it('★ 繋がったときに 1 回、その後は 60 分おきに取り直す (取り直した版で帯が変わる)', async () => {
    const w = await mount()
    expect(fetchLatest).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1)
    expect(fetchLatest).toHaveBeenCalledTimes(1)

    // 配布中の版が機体と同じになった → 帯が消える
    fetchLatest.mockResolvedValue({ cores3: '0.1.0' })
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(fetchLatest).toHaveBeenCalledTimes(2)
    expect(root(w).exists()).toBe(false)

    // 取れなくなった → 出さないまま
    fetchLatest.mockResolvedValue({})
    await vi.advanceTimersByTimeAsync(HOUR_MS)
    await flushPromises()
    expect(fetchLatest).toHaveBeenCalledTimes(3)
    expect(root(w).exists()).toBe(false)
    w.unmount()
  })

  it('未接続で始まったら取りに行かず、繋がった時点で取る', async () => {
    const w = await mount({ connected: false })
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS)
    expect(fetchLatest).not.toHaveBeenCalled()

    await w.setProps({ connected: true })
    await flushPromises()
    expect(fetchLatest).toHaveBeenCalledTimes(1)
    expect(startButton(w).exists()).toBe(true)
    w.unmount()
  })

  it('★ 切断で周期を止め、繋がり直したら取り直して周期を張り直す (二重に張らない)', async () => {
    const w = await mount()
    await w.setProps({ connected: false })
    expect(root(w).exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS)
    expect(fetchLatest).toHaveBeenCalledTimes(1)

    await w.setProps({ connected: true })
    await flushPromises()
    expect(fetchLatest).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(HOUR_MS)
    expect(fetchLatest).toHaveBeenCalledTimes(3)
    w.unmount()
  })

  it('unmount で周期を止める', async () => {
    const w = await mount()
    w.unmount()
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS)
    expect(fetchLatest).toHaveBeenCalledTimes(1)
  })

  it('未接続のまま unmount しても例外にならない (止める周期が無い)', async () => {
    const w = await mount({ connected: false })
    expect(() => w.unmount()).not.toThrow()
  })
})
