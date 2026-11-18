import { describe, it, expect, vi } from 'vitest'
import { RECORDER_BASE } from '../../server/utils/print-relay'
import {
  alarmKeyLabelName,
  buildAlarmKeyLabelForward,
  DEVICE_NAME_READ_ROLES,
  buildDeviceLabelsForward,
  buildOtaReportForward,
  buildOtaStatusForward,
  buildSerialOtaForward,
  deviceIdFromTokenSub,
  firmwareTargetForDevice,
  isFirmwareKind,
  decideFirmwareAdminAccess,
  decideFirmwareReportAccess,
  VEIN_FIRMWARE_REPORT_ROLES,
  isFirmwareDeviceId,
  loadDeviceLabels,
  loadDeviceLabelRows,
  parseDeviceLabelRows,
  mergeFirmwareDevices,
  parseDeviceLabels,
} from '../../server/utils/firmware-relay'

const SECRET = 'test-internal-shared-secret-32!!'

describe('decideFirmwareReportAccess (報告 = キオスクの端末の token だけ、Refs #403)', () => {
  it('★ device-kiosk だけ ok。書き先は introspect の tenant_id', () => {
    expect(decideFirmwareReportAccess({ active: true, tenant_id: 't1', role: 'device-kiosk', sub: 'd1' })).toEqual({
      ok: true,
      tenantId: 't1',
    })
  })

  it('★ ほかの端末・利用者・role 無しは 403', () => {
    for (const role of ['device-hub', 'device-print', 'device-timecard', 'device-gateway', 'admin', 'member', 'viewer', '', undefined]) {
      expect(decideFirmwareReportAccess({ active: true, tenant_id: 't1', role })).toEqual({
        ok: false,
        status: 403,
        message: 'この端末からは報告できません',
      })
    }
    // 文字列でない role (introspect の応答が壊れている)
    expect(decideFirmwareReportAccess({ active: true, tenant_id: 't1', role: 1 as unknown as string })).toMatchObject({
      ok: false,
      status: 403,
    })
  })

  it('inactive・tenant 無しは 401', () => {
    const denied = { ok: false, status: 401, message: 'token が無効です' }
    expect(decideFirmwareReportAccess({ active: false, tenant_id: 't1', role: 'device-kiosk' })).toEqual(denied)
    expect(decideFirmwareReportAccess({ active: true, role: 'device-kiosk' })).toEqual(denied)
    expect(decideFirmwareReportAccess({ active: true, tenant_id: '', role: 'device-kiosk' })).toEqual(denied)
    expect(decideFirmwareReportAccess({})).toEqual(denied)
  })
})

describe('VEIN_FIRMWARE_REPORT_ROLES (指静脈端末の報告は運行管理者席も、Refs ippoan/alc-app-s3#352)', () => {
  it('★ 渡すとキオスクと運行管理者席の token が ok。ほかの端末・利用者は 403。既定 (渡さない) は席を通さない', () => {
    for (const role of ['device-kiosk', 'device-tenko-manager']) {
      expect(decideFirmwareReportAccess({ active: true, tenant_id: 't1', role }, VEIN_FIRMWARE_REPORT_ROLES)).toEqual({ ok: true, tenantId: 't1' })
    }
    for (const role of ['device-hub', 'admin', 'device-bp-station', undefined]) {
      expect(decideFirmwareReportAccess({ active: true, tenant_id: 't1', role }, VEIN_FIRMWARE_REPORT_ROLES)).toMatchObject({ ok: false, status: 403 })
    }
    expect(decideFirmwareReportAccess({ active: true, tenant_id: 't1', role: 'device-tenko-manager' })).toMatchObject({ ok: false, status: 403 })
  })
})

describe('decideFirmwareAdminAccess (一覧・更新 = 利用者の admin だけ、Refs #403)', () => {
  it('★ admin だけ ok', () => {
    expect(decideFirmwareAdminAccess({ active: true, tenant_id: 't1', role: 'admin', sub: 'u1' })).toEqual({
      ok: true,
      tenantId: 't1',
    })
  })

  it('★ member・viewer・端末・role 無しは 403', () => {
    for (const role of ['member', 'viewer', 'device-kiosk', 'device-hub', 'Admin', '', undefined]) {
      expect(decideFirmwareAdminAccess({ active: true, tenant_id: 't1', role })).toEqual({
        ok: false,
        status: 403,
        message: 'ファームの更新は管理者のみ実行できます',
      })
    }
  })

  it('inactive・tenant 無しは 401', () => {
    const denied = { ok: false, status: 401, message: 'token が無効です' }
    expect(decideFirmwareAdminAccess({ active: false, tenant_id: 't1', role: 'admin' })).toEqual(denied)
    expect(decideFirmwareAdminAccess({ active: true, role: 'admin' })).toEqual(denied)
  })
})

describe('isFirmwareDeviceId', () => {
  it('英数字 - _ の 1〜64 文字だけ', () => {
    expect(isFirmwareDeviceId('d1')).toBe(true)
    expect(isFirmwareDeviceId('Abc_09-x')).toBe(true)
    expect(isFirmwareDeviceId('a'.repeat(64))).toBe(true)
  })

  it('空・65 文字・記号・文字列でない値は外れる', () => {
    for (const v of ['', 'a'.repeat(65), 'a b', 'a/b', 'a.b', 'あ', 'a\n', null, undefined, 1, {}, ['d1']]) {
      expect(isFirmwareDeviceId(v)).toBe(false)
    }
  })
})

describe('buildDeviceLabelsForward', () => {
  it('auth-worker の登録簿を tenant_id 付きの GET で叩く。Authorization は secret の生の値', () => {
    const fwd = buildDeviceLabelsForward({ sharedSecret: SECRET, tenantId: 't 1/&x' })
    expect(fwd.url).toBe('https://auth-worker.internal/internal/device-labels?tenant_id=t%201%2F%26x')
    expect(fwd.init).toEqual({ method: 'GET', headers: { Authorization: SECRET } })
  })
})

describe('buildDeviceLabelsForward の all', () => {
  it('all=true のときだけ &all=1 が付く (既定は付けない)', () => {
    const input = { sharedSecret: SECRET, tenantId: 't1' }
    expect(buildDeviceLabelsForward(input).url).not.toContain('all=')
    expect(buildDeviceLabelsForward(input, false).url).toBe('https://auth-worker.internal/internal/device-labels?tenant_id=t1')
    expect(buildDeviceLabelsForward(input, true).url).toBe('https://auth-worker.internal/internal/device-labels?tenant_id=t1&all=1')
  })
})

describe('parseDeviceLabelRows / loadDeviceLabelRows', () => {
  it('revoked は true のときだけ true。形が違えば null', () => {
    expect(parseDeviceLabelRows({ devices: [{ device_id: 'a', label: 'L', revoked: true }, { device_id: 'b', revoked: 'yes' }, { device_id: 'c', label: 3 }] }))
      .toEqual([{ device_id: 'a', label: 'L', revoked: true }, { device_id: 'b', label: null, revoked: false }, { device_id: 'c', label: null, revoked: false }])
    expect(parseDeviceLabelRows({})).toBeNull()
  })

  it('loadDeviceLabelRows(all) は &all=1 で引く。loadDeviceLabels も all を渡せる', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ devices: [{ device_id: 'd1', label: 'L', revoked: true }] })))
    const aw = { fetch: fetch as unknown as typeof globalThis.fetch }
    const input = { sharedSecret: SECRET, tenantId: 't1' }
    expect(await loadDeviceLabelRows(aw, input, true)).toEqual([{ device_id: 'd1', label: 'L', revoked: true }])
    expect([...(await loadDeviceLabels(aw, input, true))!]).toEqual([['d1', 'L']])
    expect((fetch.mock.calls[1] as unknown[])[0]).toBe('https://auth-worker.internal/internal/device-labels?tenant_id=t1&all=1')
  })
})

describe('parseDeviceLabels', () => {
  it('{devices:[{device_id,label}]} を Map にする。label が文字列でなければ null', () => {
    const labels = parseDeviceLabels({
      devices: [
        { device_id: 'd1', label: '事務所' },
        { device_id: 'd2', label: null },
        { device_id: 'd3' },
        { device_id: 'd4', label: 5 },
      ],
    })
    expect([...labels!]).toEqual([['d1', '事務所'], ['d2', null], ['d3', null], ['d4', null]])
  })

  it('device_id が文字列でない要素は飛ばす', () => {
    const labels = parseDeviceLabels({ devices: [null, 'd1', { label: 'x' }, { device_id: 7, label: 'x' }, { device_id: 'd9', label: 'y' }] })
    expect([...labels!]).toEqual([['d9', 'y']])
  })

  it('0 件は空の Map (null ではない)', () => {
    expect(parseDeviceLabels({ devices: [] })?.size).toBe(0)
  })

  it('形が違えば null', () => {
    for (const v of [null, undefined, 'x', 1, [], {}, { devices: {} }, { devices: 'd1' }, { error: 'server_error' }]) {
      expect(parseDeviceLabels(v)).toBeNull()
    }
  })
})

describe('loadDeviceLabels (取れなければ null)', () => {
  const input = { sharedSecret: SECRET, tenantId: 't1' }

  it('200 なら Map。登録簿の URL と secret で叩く', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ devices: [{ device_id: 'd1', label: 'L' }] })))
    const labels = await loadDeviceLabels({ fetch: fetch as unknown as typeof globalThis.fetch }, input)
    expect([...labels!]).toEqual([['d1', 'L']])
    expect(fetch).toHaveBeenCalledWith('https://auth-worker.internal/internal/device-labels?tenant_id=t1', {
      method: 'GET',
      headers: { Authorization: SECRET },
    })
  })

  it('非 200・形違い・JSON でない本文・例外はどれも null', async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => new Response(JSON.stringify({ error: 'server_error' }), { status: 503 }),
      async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
      async () => new Response(JSON.stringify({ devices: 'x' })),
      async () => new Response('not json'),
      async () => { throw new Error('network') },
    ]
    for (const impl of cases) {
      expect(await loadDeviceLabels({ fetch: vi.fn(impl) as unknown as typeof globalThis.fetch }, input)).toBeNull()
    }
  })
})

describe('recorder への forward (Refs #403)', () => {
  it('buildOtaReportForward: 報告の object をそのまま body に載せる (key を選別しない)', () => {
    const report = { device_id: 'd1', kind: 'cores3', phase: 'idle', extra: 1, tenant_id: 'other' }
    const fwd = buildOtaReportForward({ sharedSecret: SECRET, tenantId: 't/1', report })
    expect(fwd.url).toBe(`${RECORDER_BASE}/tenants/t%2F1/ota-report`)
    expect(fwd.init.method).toBe('POST')
    expect(fwd.init.headers).toEqual({ Authorization: SECRET, 'Content-Type': 'application/json' })
    expect(fwd.init.body).toBe(JSON.stringify(report))
  })

  it('buildOtaStatusForward: GET で body 無し', () => {
    const fwd = buildOtaStatusForward({ sharedSecret: SECRET, tenantId: 't1' })
    expect(fwd.url).toBe(`${RECORDER_BASE}/tenants/t1/ota-status`)
    expect(fwd.init).toEqual({ method: 'GET', headers: { Authorization: SECRET } })
  })

  it('★ buildSerialOtaForward: body は {"target":…,"device_id":"…"} と完全一致', () => {
    const fwd = buildSerialOtaForward({ sharedSecret: SECRET, tenantId: 't1', deviceId: 'd-1', target: 'cores3' })
    expect(fwd.url).toBe(`${RECORDER_BASE}/tenants/t1/serial-ota`)
    expect(fwd.init.method).toBe('POST')
    expect(fwd.init.headers).toEqual({ Authorization: SECRET, 'Content-Type': 'application/json' })
    expect(fwd.init.body).toBe('{"target":"cores3","device_id":"d-1"}')
    expect(buildSerialOtaForward({ sharedSecret: SECRET, tenantId: 't1', deviceId: 'd-2', target: 'timecard-station' }).init.body)
      .toBe('{"target":"timecard-station","device_id":"d-2"}')
  })
})

describe('指静脈端末の報告と 1 台宛ての更新 (Refs ippoan/alc-app-s3#352)', () => {
  it('isFirmwareKind: cores3 と timecard だけ', () => {
    expect(isFirmwareKind('cores3')).toBe(true)
    expect(isFirmwareKind('timecard')).toBe(true)
    for (const v of ['timecard-station', 'alarm', 'toString', '__proto__', '', undefined, 1]) expect(isFirmwareKind(v)).toBe(false)
  })

  it('deviceIdFromTokenSub: 鍵の token は alarm-<指紋> (keyed)、それ以外は sub のまま', () => {
    expect(deviceIdFromTokenSub('alarm:0123456789abcdef')).toEqual({ deviceId: 'alarm-0123456789abcdef', keyed: true })
    expect(deviceIdFromTokenSub('k1')).toEqual({ deviceId: 'k1', keyed: false })
    // 形の違う alarm: は鍵として扱わない (sub のまま。id の検査で落ちる)
    expect(deviceIdFromTokenSub('alarm:XYZ')).toEqual({ deviceId: 'alarm:XYZ', keyed: false })
    expect(deviceIdFromTokenSub(undefined)).toEqual({ deviceId: undefined, keyed: false })
  })

  it('★ firmwareTargetForDevice: 最後の報告の kind から target を引く', () => {
    const status = { devices: [
      { device_id: 'c1', kind: 'cores3' },
      { device_id: 'v1', kind: 'timecard' },
      { device_id: 'a1', kind: 'alarm' },
      null,
    ] }
    expect(firmwareTargetForDevice(status, 'c1')).toEqual({ ok: true, target: 'cores3' })
    expect(firmwareTargetForDevice(status, 'v1')).toEqual({ ok: true, target: 'timecard-station' })
    expect(firmwareTargetForDevice(status, 'a1')).toEqual({ ok: false, error: 'unknown_kind' })
    expect(firmwareTargetForDevice(status, 'zz')).toEqual({ ok: false, error: 'no_report' })
    expect(firmwareTargetForDevice(null, 'c1')).toEqual({ ok: false, error: 'no_report' })
    expect(firmwareTargetForDevice({ devices: 'x' }, 'c1')).toEqual({ ok: false, error: 'no_report' })
  })
})

describe('mergeFirmwareDevices', () => {
  const status = {
    devices: [
      { device_id: 'd1', kind: 'cores3', phase: 'idle', version: '1.2.3', reported_at_ms: 2 },
      { device_id: 'd2', kind: 'cores3', phase: 'failed', reason: 'x', reported_at_ms: 1 },
    ],
  }

  it('label が付く。Map に無い端末・label が null の端末は null', () => {
    const merged = mergeFirmwareDevices(status, new Map([['d1', '事務所']]))
    expect(merged.devices.map(d => d.label)).toEqual(['事務所', null])
    expect(mergeFirmwareDevices(status, new Map([['d1', null]])).devices[0]!.label).toBeNull()
  })

  it('labels が null なら全部 null', () => {
    expect(mergeFirmwareDevices(status, null).devices.map(d => d.label)).toEqual([null, null])
  })

  it('★ recorder が省いた key は省いたまま (null を足さない)。順序も保つ', () => {
    const merged = mergeFirmwareDevices(status, new Map([['d1', 'L']]))
    expect(Object.keys(merged.devices[0]!)).toEqual(['device_id', 'kind', 'phase', 'version', 'reported_at_ms', 'label'])
    expect(Object.keys(merged.devices[1]!)).toEqual(['device_id', 'kind', 'phase', 'reason', 'reported_at_ms', 'label'])
    expect(merged.devices[0]).toEqual({ ...status.devices[0], label: 'L' })
  })

  it('0 件は空のまま。object でない要素は落とす', () => {
    expect(mergeFirmwareDevices({ devices: [] }, null)).toEqual({ devices: [] })
    expect(mergeFirmwareDevices({ devices: [null, 'x', 1, ['d1'], { device_id: 'd1' }] }, null)).toEqual({
      devices: [{ device_id: 'd1', label: null }],
    })
  })

  it('形違いは空の一覧', () => {
    for (const v of [null, undefined, 'x', [], {}, { devices: {} }, { error: 'server_error' }]) {
      expect(mergeFirmwareDevices(v, new Map())).toEqual({ devices: [] })
    }
  })
})

describe('buildAlarmKeyLabelForward / alarmKeyLabelName / DEVICE_NAME_READ_ROLES (Refs ippoan/alc-app-s3#352)', () => {
  it('鍵 1 本の名前の口を tenant_id と指紋付きの GET で叩く。Authorization は secret の生の値', () => {
    const fwd = buildAlarmKeyLabelForward({ sharedSecret: SECRET, tenantId: 't 1', fingerprint: '0123456789abcdef' })
    const url = new URL(fwd.url)
    expect(url.pathname).toBe('/internal/alarm-keys/label')
    expect(url.searchParams.get('tenant_id')).toBe('t 1')
    expect(url.searchParams.get('fingerprint')).toBe('0123456789abcdef')
    expect(fwd.init).toEqual({ method: 'GET', headers: { Authorization: SECRET } })
  })

  it('label を名前にし、失効は「 (失効)」付き。無い・空・形違いは null', () => {
    expect(alarmKeyLabelName({ label: 'a', revoked: false })).toBe('a')
    expect(alarmKeyLabelName({ label: 'a', revoked: true })).toBe('a (失効)')
    expect(alarmKeyLabelName({ label: '' })).toBeNull()
    expect(alarmKeyLabelName({ label: null })).toBeNull()
    expect(alarmKeyLabelName(null)).toBeNull()
  })

  it('報告の端末 (キオスク・運行管理者席) と管理者だけ', () => {
    expect([...DEVICE_NAME_READ_ROLES].sort()).toEqual([...VEIN_FIRMWARE_REPORT_ROLES, 'admin'].sort())
    expect(DEVICE_NAME_READ_ROLES.has('viewer')).toBe(false)
  })
})
