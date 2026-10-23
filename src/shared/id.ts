/**
 * 标识符生成（src/shared 纯工具）
 *
 * 注意：本文件不参与规则掷骰，随机性使用 crypto 而非 Math.random，
 * 与引擎的种子化 RNG（engine/rng.ts）职责分离。
 */

let sequence = 0

/** 生成带前缀且保证同进程内唯一的短标识（用于 DOM key、日志游标等） */
export function createId(prefix = 'id'): string {
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`
}

/** 生成 UUID v4（浏览器与 Node 22+ 均原生支持 crypto.randomUUID） */
export function createUuid(): string {
  return crypto.randomUUID()
}
