import {
  OnlineError,
  RoomConflictError,
  type CreateRoomInput,
  type JoinRoomInput,
  type LeaveRoomInput,
  type OnlineRoomRecord,
  type OnlineRoomSummary,
  type RoomTransport,
  type WriteRoomInput,
} from './online-types'

/**
 * 自建房间中继客户端
 *
 * 服务端只存 `OnlineRoomRecord` 并做 `seq` CAS；对局内容对服务端是不透明 JSON。
 * 房间密码只在 `createRoom` / `joinRoom` 的请求体里出现，服务端校验后只下发写房令牌。
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

  private errorFromBody(status: number, body: Record<string, unknown>): OnlineError {
    const error = typeof body.error === 'string' ? body.error : ''
    if (error === 'roomNotFound' || status === 404) {
      return new OnlineError('roomNotFound', '房间不存在或已经关闭')
    }
    if (error === 'badHostClaim') {
      return new OnlineError(
        'badHostClaim',
        '房主座位凭证不匹配；请用原浏览器标签重连，或换一个 ID 以客人加入',
      )
    }
    if (error === 'badGuestClaim') {
      return new OnlineError(
        'badGuestClaim',
        '客人座位凭证不匹配；请用原浏览器标签重连，或换一个 ID 重新加入',
      )
    }
    if (error === 'badToken' || status === 403) {
      return new OnlineError('badToken', '房间令牌不匹配')
    }
    if (error === 'badPassword' || status === 401) {
      return new OnlineError('badPassword', '房间密码不正确')
    }
    if (error === 'roomFull') {
      return new OnlineError('roomFull', '房间已经坐满，只有房主和已加入的玩家能重连')
    }
    if (error === 'roomNameTaken') {
      return new OnlineError('roomNameTaken', '这个房间名已经有人用了，请换一个')
    }
    if (error === 'invalidRoomInput' || error === 'invalidInput' || status === 400) {
      return new OnlineError('invalidInput', '房间信息不完整或格式不正确')
    }
    if (status === 429 || error === 'joinRateLimited') {
      return new OnlineError('transportUnavailable', '密码尝试过多，请稍后再试')
    }
    return new OnlineError('transportUnavailable', '联机服务请求失败')
  }

  private async assertRoomResponse(response: Response): Promise<OnlineRoomRecord> {
    const body = await this.readJson<Record<string, unknown>>(response)
    if (!response.ok) {
      if (response.status === 409 && body.latest !== undefined) {
        throw new RoomConflictError(body.latest as OnlineRoomRecord)
      }
      throw this.errorFromBody(response.status, body)
    }
    return body as unknown as OnlineRoomRecord
  }

  async listRooms(): Promise<OnlineRoomSummary[]> {
    const response = await this.request('/rooms', { method: 'GET' })
    const body = await this.readJson<{ rooms?: unknown }>(response)
    if (!response.ok) throw this.errorFromBody(response.status, body as Record<string, unknown>)
    if (!Array.isArray(body.rooms)) {
      throw new OnlineError('transportUnavailable', '联机服务返回的房间列表格式不正确')
    }
    return body.rooms as OnlineRoomSummary[]
  }

  async createRoom(input: CreateRoomInput): Promise<OnlineRoomRecord> {
    const response = await this.request('/rooms', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return this.assertRoomResponse(response)
  }

  async joinRoom(input: JoinRoomInput): Promise<OnlineRoomRecord> {
    const response = await this.request(`/rooms/${encodeURIComponent(input.code)}/join`, {
      method: 'POST',
      body: JSON.stringify({
        password: input.password,
        playerId: input.playerId,
        hostSecret: input.hostSecret,
        guestSecret: input.guestSecret,
      }),
    })
    return this.assertRoomResponse(response)
  }

  async readRoom(code: string, token: string): Promise<OnlineRoomRecord> {
    const response = await this.request(`/rooms/${encodeURIComponent(code)}`, {
      method: 'GET',
      headers: { 'x-room-token': token },
    })
    return this.assertRoomResponse(response)
  }

  async leaveRoom(input: LeaveRoomInput): Promise<void> {
    const response = await this.request(`/rooms/${encodeURIComponent(input.code)}/leave`, {
      method: 'POST',
      body: JSON.stringify({
        password: input.password,
        playerId: input.playerId,
        hostSecret: input.hostSecret,
        guestSecret: input.guestSecret,
      }),
    })
    if (!response.ok) {
      const body = await this.readJson<Record<string, unknown>>(response)
      throw this.errorFromBody(response.status, body)
    }
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
