import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { withSetup } from '../helpers/with-setup'
import type { LatestPunch } from '~/types'

// --- useCoreS3Serial のモック (EVT を流す口だけ) ---
const { onEventMock, emitEvent, unsubscribeMock } = vi.hoisted(() => {
  const handlers: Array<(name: string, args: string[]) => void> = []
  const unsubscribeMock = vi.fn()
  return {
    onEventMock: vi.fn((cb: (name: string, args: string[]) => void) => {
      handlers.push(cb)
      return unsubscribeMock
    }),
    emitEvent: (name: string, args: string[]) => handlers.forEach(h => h(name, args)),
    unsubscribeMock,
  }
})
mockNuxtImport('useCoreS3Serial', () => () => ({ onEvent: onEventMock }))

// --- useTimecardCardIndex のモック (台帳の引き当てだけ) ---
const resolveMock = vi.fn<(cardId: string) => string | null>()
const restoreMock = vi.fn(async () => {})
const startPeriodicRefreshMock = vi.fn()
const stopPeriodicRefreshMock = vi.fn()
mockNuxtImport('useTimecardCardIndex', () => () => ({
  resolve: resolveMock,
  restore: restoreMock,
  refresh: vi.fn(async () => {}),
  startPeriodicRefresh: startPeriodicRefreshMock,
  stopPeriodicRefresh: stopPeriodicRefreshMock,
}))

import { useHubTimecardPunch } from '~/composables/useHubTimecardPunch'

// ハブの IC 打刻を USB シリアルから直接受けて画面を動かす (Refs ippoan/rust-alc-api#644)。
// これまではクラウドを一周してからボタンが出ていた (WS が切れている間は出なかった)。

const NAMES: Record<string, string> = { 'emp-1': '山田太郎', 'emp-2': '佐藤花子' }
const resolveName = (id: string) => NAMES[id] ?? null

function serverPunch(over: Partial<LatestPunch> = {}): LatestPunch {
  return {
    id: 'row-1',
    employeeId: 'emp-1',
    name: '山田太郎',
    cardKind: 'other',
    punchedAt: new Date().toISOString(),
    ...over,
  }
}

describe('useHubTimecardPunch', () => {
  beforeEach(() => {
    onEventMock.mockClear()
    unsubscribeMock.mockClear()
    restoreMock.mockClear()
    startPeriodicRefreshMock.mockClear()
    stopPeriodicRefreshMock.mockClear()
    resolveMock.mockReset()
    resolveMock.mockReturnValue('emp-1')
  })

  it('★ EVT TIMECARD を受けて、その人ぶんの最新打刻を立てる (クラウドを待たない)', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    expect(hub.latest.value).toBeNull()

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    expect(hub.latest.value).toMatchObject({
      employeeId: 'emp-1',
      name: '山田太郎',
      // felica_idm / nfca_uid は 'other' に畳まれる (IcPunchAlcoholPrompt が出す条件)
      cardKind: 'other',
    })
    app.unmount()
  })

  it('nfca_uid も other に畳む', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    emitEvent('TIMECARD', ['card_id=BBBB', 'card_kind=nfca_uid'])
    expect(hub.latest.value?.cardKind).toBe('other')
    app.unmount()
  })

  it('★ 台帳に無いカードでは何もしない (従来どおりサーバ由来のボタンへ倒れる)', () => {
    resolveMock.mockReturnValue(null)
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', ['card_id=UNKNOWN', 'card_kind=felica_idm'])

    expect(hub.latest.value).toBeNull()
    app.unmount()
  })

  it('★ 氏名が引けなければ何もしない', () => {
    resolveMock.mockReturnValue('emp-unknown')
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))

    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    expect(hub.latest.value).toBeNull()
    app.unmount()
  })

  it('card_id が無い行は捨てる', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    emitEvent('TIMECARD', ['card_kind=felica_idm'])
    expect(hub.latest.value).toBeNull()
    app.unmount()
  })

  it('TIMECARD 以外の EVT は無視する', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    emitEvent('WS_CONNECTED', [])
    emitEvent('FC1200', ['WARMING'])
    expect(hub.latest.value).toBeNull()
    app.unmount()
  })

  it('起動時に台帳を復元する', () => {
    const [, app] = withSetup(() => useHubTimecardPunch(resolveName))
    expect(restoreMock).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('unmount で購読を解除する', () => {
    const [, app] = withSetup(() => useHubTimecardPunch(resolveName))
    expect(onEventMock).toHaveBeenCalledTimes(1)
    app.unmount()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it('★ 定期同期を start / stop する (取り消されたカードを消す経路)', () => {
    const [, app] = withSetup(() => useHubTimecardPunch(resolveName))
    expect(startPeriodicRefreshMock).toHaveBeenCalledTimes(1)
    expect(stopPeriodicRefreshMock).not.toHaveBeenCalled()
    app.unmount()
    expect(stopPeriodicRefreshMock).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // 同じタップで 2 回ボタンを出さない
  // -------------------------------------------------------------------------

  it('★★ 同じ社員・近い時刻のサーバ由来は捨てる (押した後にボタンが出し直されない)', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])
    const serialId = hub.latest.value?.id

    // 数秒後にサーバ由来の行が届く = 同じタップ
    hub.setFromServer(serverPunch({ id: 'row-1', employeeId: 'emp-1' }))

    expect(hub.latest.value?.id).toBe(serialId)
    app.unmount()
  })

  it('★ 別の社員のサーバ由来は素通しする', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    hub.setFromServer(serverPunch({ id: 'row-2', employeeId: 'emp-2', name: '佐藤花子' }))

    expect(hub.latest.value?.id).toBe('row-2')
    app.unmount()
  })

  it('★ 同じ社員でも時刻が離れていれば素通しする (別のタップ)', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    emitEvent('TIMECARD', ['card_id=AAAA', 'card_kind=felica_idm'])

    hub.setFromServer(serverPunch({
      id: 'row-9',
      employeeId: 'emp-1',
      punchedAt: new Date(Date.now() + 120_000).toISOString(),
    }))

    expect(hub.latest.value?.id).toBe('row-9')
    app.unmount()
  })

  it('シリアル由来がまだ無ければサーバ由来をそのまま使う (従来の挙動)', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    hub.setFromServer(serverPunch({ id: 'row-1' }))
    expect(hub.latest.value?.id).toBe('row-1')
    app.unmount()
  })

  it('サーバ由来が null でもそのまま反映する (打刻がまだ 1 件も無い)', () => {
    const [hub, app] = withSetup(() => useHubTimecardPunch(resolveName))
    hub.setFromServer(null)
    expect(hub.latest.value).toBeNull()
    app.unmount()
  })
})
