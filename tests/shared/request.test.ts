import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { buildUrl, getJson, HttpError, postJson } from '@/shared'

type JsonResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}

function jsonResponse(status: number, body: unknown = null): JsonResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

const originalFetch = globalThis.fetch

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalFetch) globalThis.fetch = originalFetch
})

describe('buildUrl', () => {
  it('拼接 baseURL 与路径并序列化查询参数', () => {
    expect(buildUrl('units', { side: 'axis', n: 3, skip: null }, 'https://api.example.com')).toBe(
      'https://api.example.com/units?side=axis&n=3',
    )
    expect(buildUrl('/charts/crt', undefined, '')).toBe('/charts/crt')
  })
})

describe('getJson', () => {
  it('GET 并返回解析后的 JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { count: 3 })))
    const data = await getJson<{ count: number }>('/data/units.json')
    expect(data.count).toBe(3)
  })

  it('带 schema 时校验通过返回数据', async () => {
    const schema = z.object({ name: z.string() })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { name: '3 Pz Div' })))
    await expect(getJson('/a.json', schema)).resolves.toEqual({ name: '3 Pz Div' })
  })

  it('schema 校验失败时抛 ZodError（指出字段路径）', async () => {
    const schema = z.object({ name: z.string() })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { name: 42 })))
    await expect(getJson('/a.json', schema)).rejects.toThrow(/name/)
  })

  it('非 2xx 归一化为 HttpError 并携带状态码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { detail: 'not found' })))
    const error = await getJson('/missing.json').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    if (error instanceof HttpError) {
      expect(error.status).toBe(404)
    }
  })
})

describe('postJson', () => {
  it('序列化请求体并返回响应', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 7 }))
    vi.stubGlobal('fetch', fetchMock)
    const data = await postJson<{ id: number }>('/units', { name: 'x' })
    expect(data.id).toBe(7)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/units')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"name":"x"}')
  })
})
