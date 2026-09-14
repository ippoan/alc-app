import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MeasurementDetail from '~/components/MeasurementDetail.vue'
import type { ApiMeasurement } from '~/types'

// 録画・顔写真の表示は MeasurementFacePhoto / MeasurementVideo に分離済み
// (Refs #238, #259, ippoan/alc-app-s3#135)。MeasurementDetail は 2 部品へ measurement を渡し、
// 表示順 (顔写真が先頭、録画は基本情報の後) を保つことだけ確認する。

vi.mock('~/utils/api', () => ({
  fetchFacePhoto: vi.fn(async () => null),
  fetchMeasurementVideo: vi.fn(async () => null),
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
