/**
 * B39 切片 B：**单位工程库的洁净度盘点**（只读；方案 §3 B39 步骤 3 的验收口径）
 *
 *   `node scripts/audit-unit-db.mjs`            —— 打印四项计数与样本
 *   `node scripts/audit-unit-db.mjs --strict`   —— 可修的项**必须归零**，否则退出码 1（当门禁用）
 *
 * 审计对象是**源库**（`D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\units.json`），
 * 不是应用数据 `src/data/units-*.json`（后者是 `sync-counters` 的派生结果，已由数据契约用例守着）。
 *
 * 四项口径（与方案一致，并各写清"能修/不能修"）：
 *   · **D-1** `ocr` 块与印值不一致的面 —— **不能自动改**（哪个是对的要看图/复核）；
 *     但其中 **`ocr_agree` 写着 true 的**属"自相矛盾的标记"，**可安全纠正为 false**；
 *   · **D-2** `images.*_paths` 指向的文件**已不存在**（素材库重排过目录）—— `sync-counters`
 *     按**文件名**取图、**刻意不看** `*_paths`（见该脚本开头注释）⇒ 本项只盘点、不修；
 *   · **D-3** 字符串型印值（`A/AR/MA` 存成 `"2"`）—— **可修**（归一到数字）；
 *   · **D-4** 源库有 `capabilities_raw` 而应用数据里没有 ⇒ **导出**（下一批做）。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DB = 'D:/OCS/OCS斯摩棱斯克素材/斯摩棱斯克工程数据库/units.json'
const LIB = 'D:/OCS/OCS斯摩棱斯克素材'
const NUM = ['A', 'AR', 'MA']

const db = JSON.parse(readFileSync(DB, 'utf8'))
const items = db.items ?? []

let disagree = 0
let lying = 0
let missingPaths = 0
let stringValues = 0
let capabilitiesRaw = 0
const samples = { disagree: [], lying: [], missingPaths: [], stringValues: [] }

for (const item of items) {
  for (const face of ['front', 'back']) {
    const read = item.printed_values?.[face]
    if (read !== undefined && read !== null) {
      for (const key of NUM) {
        if (typeof read[key] === 'string') {
          stringValues += 1
          if (samples.stringValues.length < 5)
            samples.stringValues.push(
              `${item.unit_id}.${face}.${key} = ${JSON.stringify(read[key])}`,
            )
        }
      }
      const ocr = read.ocr
      if (ocr !== undefined && ocr !== null) {
        const differs = NUM.some(
          (key) => ocr[key] !== undefined && read[key] !== undefined && ocr[key] !== read[key],
        )
        if (differs) {
          disagree += 1
          if (samples.disagree.length < 5)
            samples.disagree.push(
              `${item.unit_id}.${face}: ocr ${JSON.stringify(ocr)} vs 印值 ` +
                `${JSON.stringify({ A: read.A, AR: read.AR, MA: read.MA })}`,
            )
          if (read.ocr_agree === true) {
            lying += 1
            if (samples.lying.length < 5) samples.lying.push(`${item.unit_id}.${face}`)
          }
        }
      }
    }
    const paths = item.images?.[`${face}_paths`]
    if (Array.isArray(paths)) {
      for (const p of paths) {
        if (!existsSync(path.join(LIB, String(p)))) {
          missingPaths += 1
          if (samples.missingPaths.length < 3)
            samples.missingPaths.push(`${item.unit_id}.${face}: ${String(p)}`)
        }
      }
    }
  }
  if (Array.isArray(item.capabilities_raw) && item.capabilities_raw.length > 0) capabilitiesRaw += 1
}

console.log(`单位工程库洁净度盘点（${DB}）`)
console.log(`  条目 ${String(items.length)}`)
console.log(
  `  D-1 ocr 与印值不一致的面：${String(disagree)}（其中 ocr_agree 却为 true 的 ${String(lying)} —— 可修）`,
)
for (const s of samples.disagree) console.log('      ' + s)
console.log(
  `  D-2 images.*_paths 指向的文件已不存在：${String(missingPaths)}（sync-counters 刻意不看它 ⇒ 只盘点）`,
)
for (const s of samples.missingPaths) console.log('      ' + s)
console.log(`  D-3 字符串型印值：${String(stringValues)}（可修：归一到数字）`)
for (const s of samples.stringValues) console.log('      ' + s)
console.log(
  `  D-4 源库含 capabilities_raw 的条目（已导出为应用数据的 capabilitiesRaw）：${String(capabilitiesRaw)}（待导出到应用数据）`,
)

const strict = process.argv.includes('--strict')
if (strict) {
  const blockers = []
  if (lying > 0) blockers.push(`D-1 撒谎的 ocr_agree ${String(lying)} 面`)
  if (stringValues > 0) blockers.push(`D-3 字符串型印值 ${String(stringValues)} 个`)
  if (blockers.length > 0) {
    console.error(`\n[strict] 这些项应当已归零：${blockers.join('；')}`)
    process.exit(1)
  }
  console.log(
    '\n[strict] 可修项已归零（D-1 的"值不一致"与 D-2/D-4 属"待复核 / 刻意不修 / 待导出"，不计入）',
  )
}
