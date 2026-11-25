import { existsSync } from 'node:fs'

/**
 * 素材库（**外部资源，不入库**）
 *
 * 素材库在 `D:\OCS\OCS斯摩棱斯克素材`：原始扫描图、`斯摩棱斯克工程数据库/*.json`、图片素材库。
 * 体积太大、版权上也不随仓走，所以**仓库里没有它**。
 *
 * 有些用例是「拿素材库当对照物」的（源库 ↔ 产物、源图 ↔ 声明尺寸）。
 * 这类用例在素材库不在位的机器上（CI 的 runner 就是）应**跳过**而不是失败：
 * 读不到对照物不是产品缺陷，是这台机器没有素材。
 * 统一按仓库既有做法，用 `describe.skipIf(!sourceLibraryAvailable)` / `it.skipIf(...)`。
 *
 * 素材库放在别处时，用 `OCS_SOURCE_DIR` 指过去（CI 不需要设）。
 */
export const SOURCE_LIBRARY_ROOT = process.env.OCS_SOURCE_DIR ?? 'D:\\OCS\\OCS斯摩棱斯克素材'

/** 素材库是否在位（只看根目录；子目录由各用例自己找） */
export const sourceLibraryAvailable = existsSync(SOURCE_LIBRARY_ROOT)
