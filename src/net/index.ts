import { HttpRoomTransport } from './http'
import { LocalRoomTransport } from './local'
import type { RoomTransport } from './online-types'

export interface ResolvedRoomTransport {
  transport: RoomTransport
  /** 远程中继地址；本机回退时为空 */
  endpoint: string | null
}

/**
 * 选择房间通道
 *
 * · 显式配置 `VITE_ONLINE_ROOM_URL` ⇒ 跨设备联机走 HTTP 中继；
 * · 未配置 ⇒ 同浏览器双标签的本机通道（用于联调/验收 UI 隔离，不是跨设备联机）。
 *
 * 不在源码里写死任何公网地址或密钥；部署时由构建环境注入。
 */
export function resolveRoomTransport(): ResolvedRoomTransport {
  const raw = import.meta.env.VITE_ONLINE_ROOM_URL
  const endpoint = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : ''
  if (endpoint !== '') {
    return { transport: new HttpRoomTransport(endpoint), endpoint }
  }
  return { transport: new LocalRoomTransport(), endpoint: null }
}
