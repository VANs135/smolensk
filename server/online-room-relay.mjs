#!/usr/bin/env node
/**
 * OCS 斯摩棱斯克 · 双人联机房间中继
 *
 * 只做三件事：房间码分配、房钥校验、`seq` CAS。对局内容是**不透明 JSON**，
 * 服务端不解释规则、不做反作弊（用户 2026-11-27 口径：玩家可信，只隔离 UI）。
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
import { randomBytes } from 'node:crypto'
import { fileURLToPath, URL } from 'node:url'

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10)
const ROOMS_FILE =
  process.env.ROOMS_FILE ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'online-rooms.json')
const MAX_BODY = 12 * 1024 * 1024
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** @type {Map<string, object>} */
const rooms = new Map()

function loadRooms() {
  try {
    const raw = fs.readFileSync(ROOMS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      for (const room of parsed) {
        if (typeof room?.code === 'string') rooms.set(room.code, room)
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
  return (
    typeof state === 'object' &&
    state !== null &&
    typeof state.protocol === 'number' &&
    typeof state.dataVersion === 'string' &&
    typeof state.scenarioId === 'string' &&
    typeof state.session === 'object' &&
    typeof state.workbench === 'object' &&
    typeof state.setup === 'object'
  )
}

function readRoom(request, response, code, token) {
  const room = rooms.get(code.toUpperCase())
  if (room === undefined) {
    fail(response, 404, 'roomNotFound')
    return null
  }
  if (room.token !== token) {
    fail(response, 403, 'badToken')
    return null
  }
  return room
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
    json(response, 200, { ok: true, rooms: rooms.size })
    return
  }

  if (url.pathname === '/rooms' && request.method === 'POST') {
    try {
      const body = await readBody(request)
      if (
        !validSide(body.hostSide) ||
        !validState(body.state) ||
        typeof body.stateHash !== 'string'
      ) {
        fail(response, 400, 'invalidRoomInput')
        return
      }
      if (body.state.scenarioId !== body.scenarioId) {
        fail(response, 400, 'scenarioMismatch')
        return
      }
      const record = {
        code: randomCode(),
        token: typeof body.token === 'string' && body.token !== '' ? body.token : randomToken(),
        scenarioId: body.scenarioId,
        hostSide: body.hostSide,
        guestSide: body.hostSide === 'axis' ? 'soviet' : 'axis',
        seq: 1,
        writerSide: body.hostSide,
        updatedAt: new Date().toISOString(),
        stateHash: body.stateHash,
        state: body.state,
      }
      rooms.set(record.code, record)
      persistRooms()
      json(response, 201, record)
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
  const token = String(request.headers['x-room-token'] ?? '')

  if (request.method === 'GET') {
    const room = readRoom(request, response, code, token)
    if (room !== null) json(response, 200, room)
    return
  }

  if (request.method === 'PUT') {
    const room = readRoom(request, response, code, token)
    if (room === null) return
    try {
      const body = await readBody(request)
      const expectedSeq =
        Number.parseInt(String(request.headers['if-match'] ?? body.expectedSeq), 10) || 0
      if (expectedSeq !== room.seq) {
        json(response, 409, { error: 'roomSeqConflict', latest: room })
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
      if (body.state.scenarioId !== room.scenarioId) {
        fail(response, 400, 'scenarioMismatch')
        return
      }
      const next = {
        ...room,
        seq: room.seq + 1,
        writerSide: body.writerSide,
        updatedAt: new Date().toISOString(),
        stateHash: body.stateHash,
        state: body.state,
      }
      rooms.set(code, next)
      persistRooms()
      json(response, 200, next)
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
