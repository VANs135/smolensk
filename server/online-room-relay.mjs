#!/usr/bin/env node
/**
 * OCS 斯摩棱斯克 · 双人联机房间中继（大厅版）
 *
 * 职责：房间名/密码托管、加入校验、房间码分配、`seq` CAS。对局内容是**不透明 JSON**，
 * 服务端不解释规则、不做反作弊（用户 2026-11-27 口径：玩家可信，只隔离 UI）。
 *
 * 大厅模型：
 *   · 房主自带显示 ID、房间名、房间密码建房；密码只存 scrypt 哈希；
 *   · 大厅 `GET /rooms` 只返回房名/房主 ID/人数/阶段，不返回密码或写房令牌；
 *   · 加入者 `POST /rooms/:code/join` 提交密码与自己的 ID，服务端校验后下发令牌；
 *   · 每间房最多两人；房主可用同一 ID + 密码重连，客人同理；
 *   · 房主离开会关闭房间，客人离开会释放座位；超过 TTL 未活动的房间自动清理。
 *
 * 运行：
 *   node server/online-room-relay.mjs
 *   PORT=8787 ROOMS_FILE=./server/online-rooms.json node server/online-room-relay.mjs
 *
 * 生产必须在 HTTPS 反向代理后面（静态站点是 https，浏览器会拦截 http 请求）。
 * 也可直接提供证书：
 *   TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem node server/online-room-relay.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { fileURLToPath, URL } from 'node:url'

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10)
const ROOMS_FILE =
  process.env.ROOMS_FILE ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'online-rooms.json')
const MAX_BODY = 12 * 1024 * 1024
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ROOM_TTL_MS = (Number.parseInt(process.env.ROOM_TTL_HOURS ?? '24', 10) || 24) * 3_600_000
const NAME_MAX = 24
const PLAYER_ID_MAX = 16
const PASSWORD_MIN = 4
const PASSWORD_MAX = 64
const JOIN_FAIL_LIMIT = 8
const JOIN_FAIL_WINDOW_MS = 60_000

/** @type {Map<string, object>} */
const rooms = new Map()
/** @type {Map<string, { count: number, resetAt: number }>} */
const joinFailures = new Map()

function loadRooms() {
  try {
    const raw = fs.readFileSync(ROOMS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      for (const room of parsed) {
        if (
          typeof room?.code === 'string' &&
          typeof room?.name === 'string' &&
          typeof room?.hostId === 'string' &&
          typeof room?.passwordHash === 'string' &&
          typeof room?.passwordSalt === 'string'
        ) {
          rooms.set(room.code, room)
        }
      }
    }
  } catch {
    // 首次运行或文件损坏：从空房间表开始，不阻止启动
  }
}

function persistRooms() {
  try {
    fs.mkdirSync(path.dirname(ROOMS_FILE), { recursive: true })
    fs.writeFileSync(ROOMS_FILE, JSON.stringify([...rooms.values()], null, 2), 'utf8')
  } catch (error) {
    console.error(`room relay: persist failed: ${error.message}`)
  }
}

function randomToken() {
  return randomBytes(18).toString('base64url')
}

function randomCode() {
  const bytes = randomBytes(6)
  let code = ''
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  return rooms.has(code) ? randomCode() : code
}

function normalizeText(value, maxLength) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length === 0 || text.length > maxLength) return ''
  return text
}

function normalizePassword(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length < PASSWORD_MIN || text.length > PASSWORD_MAX) return ''
  return text
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 32).toString('hex')
}

function verifyPassword(password, room) {
  if (typeof room.passwordHash !== 'string' || typeof room.passwordSalt !== 'string') return false
  const candidate = scryptSync(password, room.passwordSalt, 32)
  const expected = Buffer.from(room.passwordHash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

function now() {
  return Date.now()
}

function isExpired(room) {
  const updated = Date.parse(String(room.updatedAt ?? ''))
  return !Number.isFinite(updated) || now() - updated > ROOM_TTL_MS
}

function pruneExpired() {
  let changed = false
  for (const [code, room] of rooms) {
    if (isExpired(room)) {
      rooms.delete(code)
      changed = true
    }
  }
  if (changed) persistRooms()
}

function publicRoom(room) {
  return {
    code: room.code,
    name: room.name,
    hostId: room.hostId,
    guestId: typeof room.guestId === 'string' ? room.guestId : null,
    hostSide: room.hostSide,
    guestSide: room.guestSide,
    scenarioId: room.scenarioId ?? null,
    stage: room.state?.stage ?? 'lobby',
    playerCount: typeof room.guestId === 'string' ? 2 : 1,
    joinable: typeof room.guestId !== 'string',
    updatedAt: room.updatedAt,
  }
}

/** 通过密码校验后才下发的完整房间行；绝不带 passwordHash / passwordSalt。 */
function wireRoom(room) {
  return {
    ...publicRoom(room),
    token: room.token,
    seq: room.seq,
    writerSide: room.writerSide,
    stateHash: room.stateHash,
    state: room.state,
  }
}

function cors(response) {
  response.setHeader('access-control-allow-origin', '*')
  response.setHeader('access-control-allow-headers', 'content-type, x-room-token, if-match')
  response.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS')
  response.setHeader('access-control-max-age', '86400')
}

function json(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  response.end(text)
}

function fail(response, status, error) {
  json(response, status, { error })
}

async function readBody(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('bodyTooLarge')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

function validSide(side) {
  return side === 'axis' || side === 'soviet'
}

function validState(state) {
  if (
    typeof state !== 'object' ||
    state === null ||
    typeof state.protocol !== 'number' ||
    typeof state.dataVersion !== 'string'
  ) {
    return false
  }
  if (state.stage === 'lobby') {
    return state.scenarioId === null || typeof state.scenarioId === 'string'
  }
  if (state.stage !== 'setup' && state.stage !== 'game') return false
  return (
    typeof state.scenarioId === 'string' &&
    typeof state.session === 'object' &&
    state.session !== null &&
    typeof state.workbench === 'object' &&
    state.workbench !== null &&
    typeof state.setup === 'object' &&
    state.setup !== null &&
    typeof state.hotseat === 'object' &&
    state.hotseat !== null
  )
}

function readAuthedRoom(request, response, code) {
  pruneExpired()
  const room = rooms.get(code)
  if (room === undefined) {
    fail(response, 404, 'roomNotFound')
    return null
  }
  const token = String(request.headers['x-room-token'] ?? '')
  if (room.token !== token) {
    fail(response, 403, 'badToken')
    return null
  }
  return room
}

function roomNameTaken(name, exceptCode) {
  const normalized = name.toLocaleLowerCase()
  for (const [code, room] of rooms) {
    if (code === exceptCode || isExpired(room)) continue
    if (String(room.name).trim().toLocaleLowerCase() === normalized) return true
  }
  return false
}

function clientIp(request) {
  // 反向代理部署时取原始客户端；直接暴露时该头可伪造，但只影响本机限流桶。
  const forwarded = request.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim() !== '') {
    return forwarded.split(',')[0].trim()
  }
  const real = request.headers['x-real-ip']
  if (typeof real === 'string' && real.trim() !== '') return real.trim()
  return request.socket.remoteAddress ?? 'unknown'
}

function joinFailureState(ip) {
  const current = joinFailures.get(ip)
  if (current === undefined || current.resetAt <= now()) {
    const fresh = { count: 0, resetAt: now() + JOIN_FAIL_WINDOW_MS }
    joinFailures.set(ip, fresh)
    return fresh
  }
  return current
}

function noteJoinFailure(ip) {
  const state = joinFailureState(ip)
  state.count += 1
}

function clearJoinFailures(ip) {
  joinFailures.delete(ip)
}

const server = http.createServer(async (request, response) => {
  cors(response)
  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  if (url.pathname === '/health') {
    pruneExpired()
    json(response, 200, { ok: true, rooms: rooms.size })
    return
  }

  if (url.pathname === '/rooms' && request.method === 'GET') {
    pruneExpired()
    const visible = [...rooms.values()]
      .filter((room) => !isExpired(room))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map(publicRoom)
    json(response, 200, { rooms: visible })
    return
  }

  if (url.pathname === '/rooms' && request.method === 'POST') {
    try {
      const body = await readBody(request)
      const name = normalizeText(body.name, NAME_MAX)
      const password = normalizePassword(body.password)
      const hostId = normalizeText(body.hostId, PLAYER_ID_MAX)
      if (
        name === '' ||
        password === '' ||
        hostId === '' ||
        !validSide(body.hostSide) ||
        !validState(body.state) ||
        typeof body.stateHash !== 'string'
      ) {
        fail(response, 400, 'invalidRoomInput')
        return
      }
      if (
        (body.scenarioId !== null && typeof body.scenarioId !== 'string') ||
        body.state.scenarioId !== body.scenarioId
      ) {
        fail(response, 400, 'scenarioMismatch')
        return
      }
      pruneExpired()
      if (roomNameTaken(name)) {
        fail(response, 409, 'roomNameTaken')
        return
      }
      const salt = randomBytes(16).toString('hex')
      const record = {
        code: randomCode(),
        token: randomToken(),
        name,
        hostId,
        guestId: null,
        hostSide: body.hostSide,
        guestSide: body.hostSide === 'axis' ? 'soviet' : 'axis',
        scenarioId: body.scenarioId,
        passwordSalt: salt,
        passwordHash: hashPassword(password, salt),
        seq: 1,
        writerSide: body.hostSide,
        updatedAt: new Date().toISOString(),
        stateHash: body.stateHash,
        state: body.state,
      }
      rooms.set(record.code, record)
      persistRooms()
      json(response, 201, wireRoom(record))
    } catch (error) {
      fail(response, error.message === 'bodyTooLarge' ? 413 : 400, error.message)
    }
    return
  }

  const joinMatch = url.pathname.match(/^\/rooms\/([A-Za-z0-9]+)\/join$/u)
  if (joinMatch !== null && request.method === 'POST') {
    const code = joinMatch[1].toUpperCase()
    const ip = clientIp(request)
    try {
      const body = await readBody(request)
      pruneExpired()
      const room = rooms.get(code)
      if (room === undefined) {
        fail(response, 404, 'roomNotFound')
        return
      }
      const failure = joinFailureState(ip)
      if (failure.count >= JOIN_FAIL_LIMIT) {
        fail(response, 429, 'joinRateLimited')
        return
      }
      const password = normalizePassword(body.password)
      const playerId = normalizeText(body.playerId, PLAYER_ID_MAX)
      if (password === '' || playerId === '') {
        fail(response, 400, 'invalidInput')
        return
      }
      if (!verifyPassword(password, room)) {
        noteJoinFailure(ip)
        fail(response, 401, 'badPassword')
        return
      }
      clearJoinFailures(ip)
      if (playerId === room.hostId) {
        // 房主刷新/换设备后用同一 ID + 密码回来：直接发回令牌，不占座位。
        json(response, 200, wireRoom(room))
        return
      }
      if (typeof room.guestId === 'string' && room.guestId !== playerId) {
        fail(response, 409, 'roomFull')
        return
      }
      if (typeof room.guestId !== 'string') {
        room.guestId = playerId
        room.updatedAt = new Date().toISOString()
        persistRooms()
      }
      json(response, 200, wireRoom(room))
    } catch (error) {
      fail(response, error.message === 'bodyTooLarge' ? 413 : 400, error.message)
    }
    return
  }

  const leaveMatch = url.pathname.match(/^\/rooms\/([A-Za-z0-9]+)\/leave$/u)
  if (leaveMatch !== null && request.method === 'POST') {
    const code = leaveMatch[1].toUpperCase()
    try {
      const body = await readBody(request)
      pruneExpired()
      const room = rooms.get(code)
      if (room === undefined) {
        fail(response, 404, 'roomNotFound')
        return
      }
      const password = normalizePassword(body.password)
      const playerId = normalizeText(body.playerId, PLAYER_ID_MAX)
      if (password === '' || playerId === '' || !verifyPassword(password, room)) {
        fail(response, 401, 'badPassword')
        return
      }
      if (playerId === room.hostId) {
        rooms.delete(code)
      } else if (room.guestId === playerId) {
        room.guestId = null
        room.updatedAt = new Date().toISOString()
      } else {
        fail(response, 403, 'badToken')
        return
      }
      persistRooms()
      json(response, 200, { ok: true })
    } catch (error) {
      fail(response, error.message === 'bodyTooLarge' ? 413 : 400, error.message)
    }
    return
  }

  const match = url.pathname.match(/^\/rooms\/([A-Za-z0-9]+)$/u)
  if (match === null) {
    fail(response, 404, 'notFound')
    return
  }
  const code = match[1].toUpperCase()

  if (request.method === 'GET') {
    const room = readAuthedRoom(request, response, code)
    if (room !== null) json(response, 200, wireRoom(room))
    return
  }

  if (request.method === 'DELETE') {
    // 删房必须用 `/leave` 带玩家 ID 与密码；这里不接受仅凭共享写房令牌关房。
    fail(response, 405, 'methodNotAllowed')
    return
  }

  if (request.method === 'PUT') {
    const room = readAuthedRoom(request, response, code)
    if (room === null) return
    try {
      const body = await readBody(request)
      const expectedSeq =
        Number.parseInt(String(request.headers['if-match'] ?? body.expectedSeq), 10) || 0
      if (expectedSeq !== room.seq) {
        json(response, 409, { error: 'roomSeqConflict', latest: wireRoom(room) })
        return
      }
      if (
        !validState(body.state) ||
        typeof body.stateHash !== 'string' ||
        !validSide(body.writerSide)
      ) {
        fail(response, 400, 'invalidRoomInput')
        return
      }
      // 进入初设后剧本固定、阶段只许前进：lobby → setup → game，不允许 game/setup 回退。
      // lobby 阶段允许房主改选剧本；一旦带完整初设状态，换剧本会让对方的布设落在错误盘面上。
      if (room.state?.stage === 'setup') {
        if (
          (body.state.stage !== 'setup' && body.state.stage !== 'game') ||
          body.state.scenarioId !== room.scenarioId
        ) {
          fail(response, 400, 'scenarioMismatch')
          return
        }
      }
      if (room.state?.stage === 'game') {
        if (body.state.stage !== 'game' || body.state.scenarioId !== room.scenarioId) {
          fail(response, 400, 'scenarioMismatch')
          return
        }
      }
      const next = {
        ...room,
        seq: room.seq + 1,
        scenarioId: body.state.scenarioId,
        writerSide: body.writerSide,
        updatedAt: new Date().toISOString(),
        stateHash: body.stateHash,
        state: body.state,
      }
      rooms.set(code, next)
      persistRooms()
      json(response, 200, wireRoom(next))
    } catch (error) {
      fail(response, error.message === 'bodyTooLarge' ? 413 : 400, error.message)
    }
    return
  }

  fail(response, 405, 'methodNotAllowed')
})

const cert = process.env.TLS_CERT
const key = process.env.TLS_KEY
const listener =
  cert !== undefined && key !== undefined
    ? https.createServer(
        { cert: fs.readFileSync(cert, 'utf8'), key: fs.readFileSync(key, 'utf8') },
        server.listeners('request')[0],
      )
    : server

loadRooms()
listener.listen(PORT, '0.0.0.0', () => {
  console.log(
    `OCS online room relay listening on ${cert !== undefined ? 'https' : 'http'}://0.0.0.0:${PORT}`,
  )
  console.log(`rooms file: ${ROOMS_FILE}`)
})
