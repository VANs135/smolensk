import {
  OnlineError,
  RoomConflictError,
  type CreateRoomInput,
  type OnlineRoomRecord,
  type RoomTransport,
  type WriteRoomInput,
} from './online-types'

/**
 * 自建房间中继客户端
 *
 * 服务端只存 `OnlineRoomRecord` 并做 `seq` CAS；对局内容对服务端是不透明 JSON。
 * 部署说明见 `docs/online/README.md`。静态站点必须使用 HTTPS 地址（不能在 HTTPS 页面
 * 里请求 HTTP 中继，浏览器会按 mixed content 拦截）。
 */
export class HttpRoomTransport implements RoomTransport {
  readonly kind = 'remote' as const
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        credentials: 'omit',
        headers: { 'content-type': 'application/json', ...init.headers },
      })
    } catch {
      throw new OnlineError('transportUnavailable', '联机服务不可达')
    }
    return response
  }

  private async readJson<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T
    } catch {
      throw new OnlineError('transportUnavailable', '联机服务返回了无法解析的内容')
    }
  }

  private async assertRoomResponse(response: Response): Promise<OnlineRoomRecord> {
    if (response.status === 409) {
      const body = await this.readJson<{ latest?: OnlineRoomRecord }>(response)
      if (body.latest !== undefined) throw new RoomConflictError(body.latest)
      throw new OnlineError('transportUnavailable', '联机服务返回了冲突但没有最新房间')
    }
    if (response.status === 404) throw new OnlineError('roomNotFound', '房间不存在')
    if (response.status === 401 || response.status === 403)
      throw new OnlineError('badToken', '房间密钥不匹配')
    if (!response.ok) throw new OnlineError('transportUnavailable', '联机服务写入失败')
    return this.readJson<OnlineRoomRecord>(response)
  }

  async createRoom(input: CreateRoomInput): Promise<OnlineRoomRecord> {
    const response = await this.request('/rooms', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    if (!response.ok) throw new OnlineError('transportUnavailable', '联机服务无法创建房间')
    return this.readJson<OnlineRoomRecord>(response)
  }

  async readRoom(code: string, token: string): Promise<OnlineRoomRecord> {
    const response = await this.request(`/rooms/${encodeURIComponent(code)}`, {
      method: 'GET',
      headers: { 'x-room-token': token },
    })
    return this.assertRoomResponse(response)
  }

  async writeRoom(input: WriteRoomInput): Promise<OnlineRoomRecord> {
    const response = await this.request(`/rooms/${encodeURIComponent(input.code)}`, {
      method: 'PUT',
      headers: {
        'x-room-token': input.token,
        'if-match': String(input.expectedSeq),
      },
      body: JSON.stringify({
        expectedSeq: input.expectedSeq,
        state: input.state,
        stateHash: input.stateHash,
        writerSide: input.writerSide,
      }),
    })
    return this.assertRoomResponse(response)
  }
}
