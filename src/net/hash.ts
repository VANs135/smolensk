/**
 * 联机状态的稳定序列化与哈希
 *
 * `JSON.stringify` 的键顺序取决于对象插入顺序；两个客户端经过不同的 store 初始化路径时，
 * 同一份对局可能序列化成不同文本。这里按键名排序后再拼，保证哈希只反映内容。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null'
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => {
      const item = record[key]
      return typeof item !== 'function' && item !== undefined
    })
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

/** FNV-1a 32 位；非安全上下文（无 `crypto.subtle`）的兜底，只用于判断是否变化。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a:${hash.toString(16).padStart(8, '0')}:${text.length}`
}

/** 异步 SHA-256；同一浏览器里所有提交/轮询共用同一算法。 */
export async function hashOnlineState(value: unknown): Promise<string> {
  const text = stableStringify(value)
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) return fnv1a(text)
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return `sha256:${hex}`
}
