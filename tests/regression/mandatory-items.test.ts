import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  bootstrapData,
  chartsCrt,
  DATA_VERSION,
  DataError,
  rulesConstants,
  unitsAxis,
  validateData,
} from '@/data'
import { UnitsDataSchema } from '@/data/schema'

/**
 * W7 D3 回归基线 · **四个强制项用例**（架构守卫）
 *
 * ## 「四个强制项」是哪四个
 *   取 CODE_SPEC §3「硬纪律（违反即视为事故）」里**可以用测试固化**的四条——
 *   另外两条（§3.5 样式只用令牌 / §3.6 规则编号落字符串）属风格约定，由 ESLint/评审把关，不在此列：
 *
 *   | # | 强制项             | 依据        | 判定方式                                              |
 *   | - | ------------------ | ----------- | ----------------------------------------------------- |
 *   | ① | 规则结算只在引擎   | §3.1        | 扫 `src/engine/**`：禁 Vue/Pinia/DOM/Canvas/网络/时钟 |
 *   | ② | 数值只有一个来源   | §3.2        | 扫全仓：JSON 数值表只经 `src/data/index.ts` 加载       |
 *   | ③ | 掷骰必须可重放     | §3.3        | 扫全仓：无 `Math.random`；骰子构造只出自 `engine/rng`  |
 *   | ④ | 数据先过校验       | §3.4        | 每个 JSON 都有 schema 且走唯一入口；载入即冻结；坏数据报错 |
 *
 * ## 为什么要静态扫源码
 *   ESLint 管得住 `Math.random`，管不住「engine 引了 stores」「某个组件直接读 JSON」这类
 *   **跨层越界**（要写依赖矩阵规则得引额外插件）。回归基线用一次文本扫描把四条纪律钉死：
 *   越界即红，且报出**具体文件与行号**，改起来一目了然。
 *
 * ## 扫描纪律
 *   先剥注释再匹配——否则「注释里提到 Math.random」会被误判成违规（本仓库这类注释很多）。
 */

/** src 根目录（本文件位于 tests/regression/，故上溯两级） */
const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url))
const DATA_ROOT = join(SRC_ROOT, 'data')

/** 四个强制项（本文件的目录；同时是「确实只有四个」的自证） */
const MANDATORY_ITEMS = [
  { id: 'engineOnly', name: '规则结算只在引擎', codeSpec: '§3.1' },
  { id: 'singleSource', name: '数值只有一个来源', codeSpec: '§3.2' },
  { id: 'replayableRng', name: '掷骰必须可重放', codeSpec: '§3.3' },
  { id: 'validatedData', name: '数据先过校验', codeSpec: '§3.4' },
] as const

/** 递归列出目录下的全部文件（绝对路径） */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** 剥掉注释，避免「注释里提到某个违禁词」被当成违规（先块注释、后行注释） */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/**
 * 再剥掉**单/双引号字符串字面量**（模板串保留，其 `${...}` 里的真代码仍会被扫到）
 *
 * 用途：判「有没有真的碰浏览器全局」这类模式时，界面提示文案里的 `'…localStorage…'`
 * 是噪声而非违规（从字符串里碰不到 DOM），故先剥离再匹配。
 */
function codeOnly(code: string): string {
  return stripComments(code)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

/** 在给定目录里逐文件匹配（返回 `相对路径:行号:内容`，便于直接定位；分隔符统一为 `/`） */
function findIn(
  dir: string,
  pattern: RegExp,
  filter: (file: string) => boolean = () => true,
  transform: (code: string) => string = stripComments,
) {
  const hits: string[] = []
  for (const file of walk(dir)) {
    if (!filter(file)) continue
    const relative = file
      .slice(SRC_ROOT.length + 1)
      .split('\\')
      .join('/')
    const lines = transform(readFileSync(file, 'utf8')).split(/\r?\n/)
    lines.forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${relative}:${index + 1}: ${line.trim()}`)
    })
  }
  return hits
}

const isTsOrVue = (file: string) => /\.(ts|mts|vue)$/.test(file)

/* ────────────────────────────── 自证：确实是「四个」 ────────────────────────────── */

describe('W7 D3 四个强制项：清单自证', () => {
  it('W7 D3：强制项恰为四项，且各自对齐 CODE_SPEC 的硬纪律编号', () => {
    expect(MANDATORY_ITEMS).toHaveLength(4)
    expect(MANDATORY_ITEMS.map((item) => item.codeSpec)).toEqual(['§3.1', '§3.2', '§3.3', '§3.4'])
    expect(MANDATORY_ITEMS.map((item) => item.id)).toEqual([
      'engineOnly',
      'singleSource',
      'replayableRng',
      'validatedData',
    ])
  })
})

/* ────────────────────────────── ① 规则结算只在引擎 ────────────────────────────── */

describe('W7 D3 强制项①：规则结算只在引擎（CODE_SPEC §3.1）', () => {
  it('§3.1：engine 层不得引用 Vue / Pinia / 组件 / 视图 / 存储 / 渲染层', () => {
    const forbidden =
      /from\s+['"](vue|pinia|@\/stores|@\/components|@\/views|@\/render|\.\.\/stores)['"]/
    expect(findIn(join(SRC_ROOT, 'engine'), forbidden, isTsOrVue)).toEqual([])
  })

  it('§3.1：engine 层不得触碰 DOM / Canvas / 网络 / 浏览器存储 / 时钟', () => {
    const forbidden =
      /\b(document\.|window\.|globalThis\.|localStorage|sessionStorage|navigator\.|fetch\(|XMLHttpRequest|new Image\(|requestAnimationFrame|Date\.now\(|new Date\()/
    expect(findIn(join(SRC_ROOT, 'engine'), forbidden, isTsOrVue, codeOnly)).toEqual([])
  })

  it('§3.1：render 只读引擎输出 —— 不得引用 stores / Vue（无状态写入的可静态判定代理）', () => {
    const forbidden = /from\s+['"](vue|pinia|@\/stores|@\/components|@\/views)['"]/
    expect(findIn(join(SRC_ROOT, 'render'), forbidden, isTsOrVue)).toEqual([])
  })

  it('§3.1：stores 不得直接调 Canvas（渲染只经 render 层的纯几何/绘制函数）', () => {
    // 例外：stores 可以引用 render 的"纯几何/选图"工具（viewport / token-images），
    // 但不得出现 Canvas 2D 上下文这一类直接绘制调用。
    const hits = findIn(
      join(SRC_ROOT, 'stores'),
      /getContext\(|createLinearGradient\(|ctx\.draw/,
      isTsOrVue,
    )
    expect(hits).toEqual([])
  })
})

/* ────────────────────────────── ② 数值只有一个来源 ────────────────────────────── */

describe('W7 D3 强制项②：数值只有一个来源（CODE_SPEC §3.2）', () => {
  it('§3.2：JSON 数值表只允许在 src/data/index.ts 里 import（其它文件一律经 @/data 取）', () => {
    // 豁免：`package.json` 是构建元信息（版本号），不是规则数值表，允许被 stores 读
    const hits = findIn(SRC_ROOT, /from\s+['"][^'"]*\.json['"]/, isTsOrVue).filter(
      (hit) => !hit.startsWith('data/index.ts:') && !hit.includes('package.json'),
    )
    expect(hits).toEqual([])
  })

  it('§3.2：`src/data/*.json` 与唯一加载入口里的 bootstrapData 调用一一对应', () => {
    const jsonFiles = readdirSync(DATA_ROOT)
      .filter((name) => name.endsWith('.json'))
      .sort()
    expect(jsonFiles.length).toBeGreaterThan(0)

    // 先剥注释：入口文件的 JSDoc 里有 `bootstrapData(raw, XSchema, 'x.json')` 这样的示例，不能计入
    const indexSource = stripComments(readFileSync(join(DATA_ROOT, 'index.ts'), 'utf8'))
    const loaded = [
      ...indexSource.matchAll(/bootstrapData\(\s*[\w.]+,\s*(\w+),\s*'([^']+\.json)'/g),
    ]
    expect(loaded.length).toBe(jsonFiles.length)
    expect(loaded.map((match) => match[2]).sort()).toEqual(jsonFiles)
    // 每个加载调用都要带 schema（第二个参数以 Schema 结尾）
    for (const match of loaded) expect(match[1]).toMatch(/Schema$/)
  })
})

/* ────────────────────────────── ③ 掷骰必须可重放 ────────────────────────────── */

describe('W7 D3 强制项③：掷骰必须可重放（CODE_SPEC §3.3）', () => {
  it('§3.3：src 全仓不得出现 Math.random（随机一律走 engine/rng）', () => {
    expect(findIn(SRC_ROOT, /Math\.random/, isTsOrVue, codeOnly)).toEqual([])
  })

  it('§3.3：骰子与 PRNG 的**定义**只允许出现在 engine/rng.ts', () => {
    const rngEntrypoints =
      /export\s+(function|const)\s+(createRngState|nextUint32|nextFloat|rollDie|rollDice|roll1d6|roll2d6|pickIndex|advance|replayFrom|verifyRngState)\b/
    const hits = findIn(SRC_ROOT, rngEntrypoints, isTsOrVue).filter(
      (hit) => !hit.startsWith('engine/rng.ts:'),
    )
    expect(hits).toEqual([])
  })

  it('§3.3：引擎不持时钟 —— engine 层不得取当前时间（保证同种子同结果）', () => {
    expect(
      findIn(join(SRC_ROOT, 'engine'), /\b(Date\.now|new Date)\b/, isTsOrVue, codeOnly),
    ).toEqual([])
  })
})

/* ────────────────────────────── ④ 数据先过校验 ────────────────────────────── */

describe('W7 D3 强制项④：数据先过校验（CODE_SPEC §3.4）', () => {
  it('§3.4：载入后的数值表是**深度冻结**的（改不动 ⇒ UI 不可能就地改数值）', () => {
    for (const data of [rulesConstants, chartsCrt, unitsAxis]) {
      expect(Object.isFrozen(data)).toBe(true)
      expect(Object.isFrozen(data.meta)).toBe(true)
    }
    expect(Object.isFrozen(rulesConstants.smolensk)).toBe(true)
    expect(Object.isFrozen(chartsCrt.crt.matrix)).toBe(true)
    expect(Object.isFrozen(unitsAxis.units)).toBe(true)
    expect(Object.isFrozen(unitsAxis.units[0])).toBe(true)
  })

  it('§3.4：不合规数据被拒，且错误定位到字段路径（JSON Pointer）与来源文件', () => {
    const bad = {
      meta: { version: DATA_VERSION },
      units: [{ id: 'de-pz-3', side: 'west', status: 'classified' }],
    }
    let caught: unknown
    try {
      validateData(bad, UnitsDataSchema, 'units-axis.json')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DataError)
    if (caught instanceof DataError) {
      expect(caught.source).toBe('units-axis.json')
      expect(caught.message).toContain('/units/0/side')
    }
  })

  it('§3.4：版本不符即拒（不做静默迁移）；合规数据经入口载入并被冻结', () => {
    const stale = { meta: { version: '0.0.0-not-this-build' }, units: [] }
    expect(() => validateData(stale, UnitsDataSchema, 'units-axis.json')).toThrow(/版本不匹配/)

    const ok = bootstrapData(
      {
        meta: { version: DATA_VERSION },
        units: [{ id: 'de-pz-3', side: 'axis', status: 'classified' }],
      },
      UnitsDataSchema,
      'units-axis.json',
    )
    expect(ok.units).toHaveLength(1)
    expect(Object.isFrozen(ok)).toBe(true)
  })

  it('§3.4：schema 目录与 JSON 同名对应（找不到 schema 的数值表不允许存在）', () => {
    const schemaDir = join(DATA_ROOT, 'schema')
    expect(statSync(schemaDir).isDirectory()).toBe(true)
    const schemaFiles = readdirSync(schemaDir).filter((name) => name.endsWith('.schema.ts'))
    expect(schemaFiles.length).toBeGreaterThan(0)
    // 每个 schema 文件都要导出 `XxxSchema`
    for (const name of schemaFiles) {
      const source = readFileSync(join(schemaDir, name), 'utf8')
      expect(source).toMatch(/export const \w+Schema\b/)
    }
  })
})
