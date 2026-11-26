import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MeasurementDetail from '~/components/MeasurementDetail.vue'
import type { ApiMeasurement } from '~/types'

// 録画・顔写真の表示は MeasurementFacePhoto / MeasurementVideo に分離済み
// (Refs #238, #259, ippoan/alc-app-s3#135)。MeasurementDetail は 2 部品へ measurement を渡し、
// 表示順 (顔写真が先頭、録画は基本情報の後) を保つことだけ確認する。

const excludeMeasurementBpMock = vi.hoisted(() => vi.fn())

vi.mock('~/utils/api', () => ({
  fetchFacePhoto: vi.fn(async () => null),
  fetchMeasurementVideo: vi.fn(async () => null),
  excludeMeasurementBp: excludeMeasurementBpMock,
}))

function baseMeasurement(overrides: Partial<ApiMeasurement> = {}): ApiMeasurement {
  return {
    id: 'm-1',
    tenant_id: 't-1',
    employee_id: 'emp-1',
    alcohol_value: 0,
    result_type: 'normal',
    device_use_count: 1,
    measured_at: '2026-09-12T00:33:00Z',
    created_at: '2026-09-12T00:33:00Z',
    updated_at: '2026-09-12T00:33:00Z',
    status: 'completed',
    ...overrides,
  }
}

async function mountDetail(overrides: Partial<ApiMeasurement> = {}) {
  return mountSuspended(MeasurementDetail, {
    props: { measurement: baseMeasurement(overrides), employeeName: '山田太郎' },
    global: { stubs: { MeasurementFacePhoto: true, MeasurementVideo: true } },
  })
}

describe('MeasurementDetail — 顔写真・録画の委譲と表示順', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:http://localhost/x'),
      revokeObjectURL: vi.fn(),
    })
  })

  it('MeasurementFacePhoto と MeasurementVideo が描画され measurement が渡る', async () => {
    const measurement = baseMeasurement({ video_url: 'https://example.com/video.webm' })
    const wrapper = await mountSuspended(MeasurementDetail, {
      props: { measurement, employeeName: '山田太郎' },
      global: { stubs: { MeasurementFacePhoto: true, MeasurementVideo: true } },
    })

    const facePhoto = wrapper.findComponent({ name: 'MeasurementFacePhoto' })
    const video = wrapper.findComponent({ name: 'MeasurementVideo' })
    expect(facePhoto.exists()).toBe(true)
    expect(video.exists()).toBe(true)
    expect(facePhoto.props('measurement')).toEqual(measurement)
    expect(video.props('measurement')).toEqual(measurement)
    wrapper.unmount()
  })

  it('録画 (MeasurementVideo) は基本情報 (乗務員・測定日時) より後にある', async () => {
    const wrapper = await mountDetail()
    const html = wrapper.html()
    const employeeIdx = html.indexOf('山田太郎')
    const videoStubIdx = html.indexOf('measurement-video-stub')
    expect(employeeIdx).toBeGreaterThan(-1)
    expect(videoStubIdx).toBeGreaterThan(-1)
    expect(videoStubIdx).toBeGreaterThan(employeeIdx)
    wrapper.unmount()
  })

  it('顔写真 (MeasurementFacePhoto) は本文の先頭にある', async () => {
    const wrapper = await mountDetail()
    const html = wrapper.html()
    const facePhotoIdx = html.indexOf('measurement-face-photo-stub')
    const employeeIdx = html.indexOf('山田太郎')
    expect(facePhotoIdx).toBeGreaterThan(-1)
    expect(facePhotoIdx).toBeLessThan(employeeIdx)
    wrapper.unmount()
  })

  it('Escape で close を emit する', async () => {
    const wrapper = await mountDetail()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })
})

describe('MeasurementDetail — 血圧を外す (Refs ippoan/alc-app#676)', () => {
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  const bp = { systolic: 150, diastolic: 90 }

  beforeEach(() => {
    excludeMeasurementBpMock.mockReset()
  })

  it('血圧の無い測定には外す操作を出さない', async () => {
    const wrapper = await mountDetail({ temperature: 36.5 })
    expect(wrapper.find('[data-testid="bp-exclude-open"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bp-excluded"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('外した血圧は取り消し線と「外した (理由・氏名・日時)」を出し、外す操作は出さない', async () => {
    const wrapper = await mountDetail({
      ...bp,
      bp_excluded_at: '2026-09-12T01:00:00Z',
      bp_excluded_reason: '別の人の血圧',
      bp_excluded_by_name: '運行 太郎',
    })
    expect(wrapper.find('[data-testid="bp-excluded"]').text()).toContain('外した (別の人の血圧・運行 太郎・')
    expect(wrapper.find('.line-through').text()).toBe('150/90')
    expect(wrapper.find('[data-testid="bp-exclude-open"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('理由が空のうちは外せない。理由と氏名を送り、外した測定を updated で返して閉じる', async () => {
    const updated = baseMeasurement({ ...bp, bp_excluded_at: '2026-09-12T01:00:00Z', bp_excluded_reason: 'テレコ', bp_excluded_by_name: '運行 太郎' })
    excludeMeasurementBpMock.mockResolvedValueOnce(updated)
    const wrapper = await mountDetail(bp)
    expect(wrapper.find('.line-through').exists()).toBe(false)
    await wrapper.find('[data-testid="bp-exclude-open"]').trigger('click')
    const submit = wrapper.find('[data-testid="bp-exclude-submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
    await wrapper.find('[data-testid="bp-exclude-reason"]').setValue('   ')
    expect(submit.attributes('disabled')).toBeDefined()
    // 押せない状態で呼ばれても送らない
    await (wrapper.vm as unknown as { $: { setupState: { submitExclude: () => Promise<void> } } }).$.setupState.submitExclude()
    expect(excludeMeasurementBpMock).not.toHaveBeenCalled()

    await wrapper.find('[data-testid="bp-exclude-reason"]').setValue(' テレコ ')
    await wrapper.find('[data-testid="bp-exclude-by-name"]').setValue(' 運行 太郎 ')
    expect(submit.attributes('disabled')).toBeUndefined()
    await submit.trigger('click')
    await flush()
    expect(excludeMeasurementBpMock).toHaveBeenCalledWith('m-1', { reason: 'テレコ', excluded_by_name: '運行 太郎' })
    expect(wrapper.emitted('updated')).toEqual([[updated]])
    expect(wrapper.find('[data-testid="bp-exclude-form"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('送信中は「外しています...」で二度押しを受けない', async () => {
    let finish!: (m: ApiMeasurement) => void
    excludeMeasurementBpMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const wrapper = await mountDetail(bp)
    await wrapper.find('[data-testid="bp-exclude-open"]').trigger('click')
    await wrapper.find('[data-testid="bp-exclude-reason"]').setValue('テレコ')
    await wrapper.find('[data-testid="bp-exclude-submit"]').trigger('click')
    expect(wrapper.find('[data-testid="bp-exclude-submit"]').text()).toBe('外しています...')
    await (wrapper.vm as unknown as { $: { setupState: { submitExclude: () => Promise<void> } } }).$.setupState.submitExclude()
    expect(excludeMeasurementBpMock).toHaveBeenCalledTimes(1)
    finish(baseMeasurement(bp))
    await flush()
    wrapper.unmount()
  })

  it('409 は「すでに外されています」、他の失敗は文言、文言の無い失敗は既定の文言。やめると閉じ、開き直すと入力を消す', async () => {
    excludeMeasurementBpMock
      .mockRejectedValueOnce(Object.assign(new Error('API エラー (409): already_excluded'), { status: 409 }))
      .mockRejectedValueOnce(new Error('API エラー (500): x'))
      .mockRejectedValueOnce(null)
    const wrapper = await mountDetail(bp)
    await wrapper.find('[data-testid="bp-exclude-open"]').trigger('click')
    await wrapper.find('[data-testid="bp-exclude-reason"]').setValue('テレコ')
    const submit = () => wrapper.find('[data-testid="bp-exclude-submit"]').trigger('click').then(flush)
    const errorText = () => wrapper.find('[data-testid="bp-exclude-error"]').text()

    await submit()
    expect(errorText()).toBe('この血圧はすでに外されています')
    await submit()
    expect(errorText()).toBe('API エラー (500): x')
    await submit()
    expect(errorText()).toBe('血圧を外せませんでした')
    expect(wrapper.emitted('updated')).toBeUndefined()

    await wrapper.find('[data-testid="bp-exclude-cancel"]').trigger('click')
    expect(wrapper.find('[data-testid="bp-exclude-form"]').exists()).toBe(false)
    await wrapper.find('[data-testid="bp-exclude-open"]').trigger('click')
    expect((wrapper.find('[data-testid="bp-exclude-reason"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.find('[data-testid="bp-exclude-error"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
