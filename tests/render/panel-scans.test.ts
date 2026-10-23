import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { panelScans } from '@/data'
import { chartSources, ooaScanOf, panelScansOf } from '@/render/charts-view'

/**
 * B22：**表格屏的印卡扫描图**（用户口径 2026-09-16）
 *
 * 「盒还有表格可以直接用素材库里辅助卡图片」
 *
 * 这套图不是"手画的表格"而是**官方印卡原样**，故它的正确性只由三件事决定：
 *   ① 图档真的在（素材库有、产物 `public/aux-cards/` 也有 —— 后者证明同步脚本跑过）；
 *   ② **声明的尺寸与 PNG 头逐项一致**（防"标定与图错配"，与 `aux-cards.json` 同一套核对）；
 *   ③ 每一屏都有图、且图只出现在它该在的屏（屏归属写错 ⇒ 玩家在 CRT 页看到补给表）。
 */
describe('B22：印卡扫描图清单（panel-scans.json）', () => {
  /**
   * 素材库候选目录（**允许分散在子目录**）
   *
   * 用户 2026-09-16 把图整理进了 `地图及辅助卡\要放进游戏的\{需要的表格,需要的盒}\` 与 `增援\`，
   * 故按"候选目录"逐个找 —— 素材搬家时门禁仍能分清"图没了"与"目录变了"。
   */
  const SOURCE_DIRS = [
    'D:\\OCS\\OCS斯摩棱斯克素材\\图片素材库\\地图及辅助卡',
    'D:\\OCS\\OCS斯摩棱斯克素材\\图片素材库\\地图及辅助卡\\要放进游戏的\\需要的表格',
    'D:\\OCS\\OCS斯摩棱斯克素材\\图片素材库\\地图及辅助卡\\要放进游戏的\\需要的盒',
    'D:\\OCS\\OCS斯摩棱斯克素材\\图片素材库\\地图及辅助卡\\增援',
  ]
  const PUBLIC_DIR = 'public/aux-cards'

  /** 在候选目录里找这张图（找不到返回 null） */
  const findScan = (image: string): string | null => {
    for (const dir of SOURCE_DIRS) {
      const file = path.join(dir, image)
      if (fs.existsSync(file)) return file
    }
    return null
  }

  /**
   * 五张屏都有图；`arrivals`（到货）没有——那是逐回合现算的计划，纸上没有卡面；
   * ★ B35（用户口径 #11「辅助卡**只放卡图**」）：原 `turn` 屏已撤 —— 天气/回合那张改由**引擎投影表**
   *   在验证页核对、铁路海运容量卡（`Rail-Sea-Cap`）归盒。
   */
  const SCREENS = ['crt', 'supply', 'tec', 'vars', 'ooa'] as const

  it('每张图的 PNG 头尺寸与声明一致，且素材库与产物目录里都在', () => {
    expect(panelScans.scans.length).toBeGreaterThan(0)
    for (const scan of panelScans.scans) {
      const source = findScan(scan.image)
      expect(source, `素材库缺少 ${scan.image}`).not.toBeNull()
      const buf = fs.readFileSync(source!)
      expect(
        { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) },
        `${scan.image} 声明尺寸与 PNG 头不一致`,
      ).toEqual(scan.imageSize)
      // 产物目录那一份由 `scripts/sync-aux-card-images.mjs` 拷入（缺 ⇒ 运行期取不到图）
      expect(
        fs.existsSync(path.join(PUBLIC_DIR, scan.image)),
        `public/aux-cards 缺少 ${scan.image}：请跑 node scripts/sync-aux-card-images.mjs`,
      ).toBe(true)
    }
  })

  it('屏归属完整：五张有卡的屏都至少有图，且没有图落在未知屏上', () => {
    for (const screen of SCREENS) {
      expect(panelScansOf(screen).length, `${screen} 屏应有印卡图`).toBeGreaterThan(0)
    }
    for (const scan of panelScans.scans) {
      expect(SCREENS).toContain(scan.screen)
    }
    // CRT 屏四页官方图表（v4.3），缺一页就是漏接
    expect(panelScansOf('crt')).toHaveLength(4)
    expect(panelScansOf('crt').map((scan) => scan.id)).toEqual([
      'charts-1',
      'charts-2',
      'charts-3',
      'charts-4',
    ])
  })

  it('投影只做筛选与字段搬运（标题、尺寸、可选说明都带到界面）', () => {
    const supply = panelScansOf('supply')
    expect(supply.length).toBeGreaterThan(0)
    for (const scan of supply) {
      expect(scan.title).not.toBe('')
      expect(scan.imageSize.w).toBeGreaterThan(0)
      expect(scan.imageSize.h).toBeGreaterThan(0)
    }
    // 有 `note` 的那几张要把说明带出来（界面上是"怎么用"那一行）
    const withNote = panelScans.scans.filter((scan) => scan.note !== undefined)
    expect(withNote.length).toBeGreaterThan(0)
    for (const scan of withNote) {
      const view = panelScansOf(scan.screen).find((item) => item.id === scan.id)
      expect(view?.note).toBe(scan.note)
    }
  })

  it('图档名不重复（同一张图被两屏引用会让"看原卡"指向错误的内容）', () => {
    const images = panelScans.scans.map((scan) => scan.image)
    expect(new Set(images).size).toBe(images.length)
    const ids = panelScans.scans.map((scan) => scan.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('数据来源自检包含这份清单（托盘折叠头写版本时能看到它）', () => {
    expect(chartSources().some((item) => item.file === 'panel-scans.json')).toBe(true)
  })

  /**
   * B34 余项②：**到达卡（OOA）**接进增援窗
   *
   * 用户口径 2026-09-16 #4：「OOA 卡的窗口都做了，把图加进去吧」；方案 §3 B34 步骤 2 与验收
   * 「增援窗显示**对应方** OOA 卡」。素材实测：`增援\\Smolensk AxOOA.png` 1203×1208、
   * `Smolensk SvOOA.png` 1518×1160（尺寸已由上面那条 PNG 头核对覆盖）。
   *
   * ★ 一条**测法边界（如实）**：本文件只钉**数据与投影**（一方一张、按方取图、图档在位）；
   *   "窗里到底画出来没有"由面板源码守卫 + 人眼在浏览器里看（组件渲染测试不在本仓库的门禁里，
   *   本仓库一律不挂组件测试，故此处不假装覆盖像素结果）。
   */
  it('★ 到达卡一方一张，且按方取图（只看得到自己那张）', () => {
    const cards = panelScansOf('ooa')
    expect(cards).toHaveLength(2)
    expect(cards.map((card) => card.side).sort()).toEqual(['axis', 'soviet'])
    // 按方取图的唯一入口：取到的就是那一方的图
    expect(ooaScanOf('axis')?.image).toBe('Smolensk AxOOA.png')
    expect(ooaScanOf('soviet')?.image).toBe('Smolensk SvOOA.png')
    // 每张卡都带标题与规则说明（界面那一行要显示它，不能是空标题）
    for (const card of cards) {
      expect(card.title).not.toBe('')
      expect(card.note).toBeDefined()
    }
  })

  it('★ 单方共用的表**不带** side（免得界面按方筛掉它们）', () => {
    for (const scan of panelScans.scans.filter((item) => item.screen !== 'ooa')) {
      expect(scan.side, `${scan.id} 不该带 side`).toBeUndefined()
    }
  })
})

describe('B22：托盘的两种看法（源码守卫）', () => {
  const tray = fs.readFileSync('src/components/game/BottomTray.vue', 'utf8')
  it('★ B35：托盘**只留卡图**（"数据表"那一面已从托盘移除，挪到引擎验证页）', () => {
    // 托盘不再有"两种看法"的开关与表渲染
    expect(tray).not.toContain("ref<'scan' | 'table'>")
    expect(tray).not.toContain('数据表（引擎投影）')
    expect(tray).not.toContain('tray__table')
    expect(tray).not.toContain('crtViews()')
    // 只画原卡
    expect(tray).toContain('panelScansOf(')
    // 屏清单＝四屏（`turn` 与 `arrivals` 都撤了）
    expect(tray).toContain("{ key: 'crt', label: 'CRT' }")
    expect(tray).toContain("{ key: 'vars', label: '变量与事件' }")
    expect(tray).not.toContain("key: 'turn'")
    expect(tray).not.toContain("key: 'arrivals'")

    // 投影表仍在**验证页**上（保留可核对，也不让这 10 个投影变成零调用导出）
    const verify = fs.readFileSync('src/views/WorkbenchView.vue', 'utf8')
    for (const call of [
      'crtViews()',
      'gridTableViews()',
      'supplyTableViews()',
      'replTableViews()',
      'specialReplTableViews()',
      'rebuildTableViews()',
      'tecTableView()',
      'tecLegend()',
      'turnWeatherTableView()',
      'arrivalTableView(',
    ]) {
      expect(verify, `验证页缺少 ${call}`).toContain(call)
    }
    expect(verify).toContain('ChartsTable')
  })

  it('★ 取图走同一套 URL 规则（组件不自己拼路径），且未就绪先画占位', () => {
    expect(tray).toContain('panelScanImageUrl')
    expect(tray).not.toContain("'/aux-cards/'")
    expect(tray).toContain('counterImages.preload')
    expect(tray).toContain('scanReady(')
  })

  it('★ 新增「变量与事件」屏（变量撤离 3.3c / 随机事件 3.6 的卡面原先无处可看）', () => {
    expect(tray).toContain("key: 'vars'")
    expect(tray).toContain('变量与事件')
    // 该屏的图从 `charts-view` 取；组件里**不比较规则字面量**（arch 门禁也管这条）
    expect(tray).not.toMatch(/===\s*'3\./)
    expect(tray).not.toContain('变量撤离（3.3c）与随机事件（3.6）')
  })
})

describe('B34②：到达卡接进增援窗（源码守卫）', () => {
  const panel = fs.readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')

  it('★ 增援窗画本方 OOA 卡：取图走唯一入口，组件不挑文件名、不拼路径', () => {
    // 按方取图与 URL 规则都走既有那两处（与 BoxCard / 托盘同一套）
    expect(panel).toContain('ooaScanOf(workbench.activeSide)')
    expect(panel).toContain('auxCardImageUrl(')
    expect(panel).not.toContain("'/aux-cards/'")
    // 面板里**不许**出现 OOA 的图档名（文件名与方的对应只写在数据文件里）
    expect(panel).not.toContain('Smolensk AxOOA.png')
    expect(panel).not.toContain('Smolensk SvOOA.png')
    // 懒加载 + 未就绪画占位（与托盘同一条手感）
    expect(panel).toContain('counterImages.preload')
    expect(panel).toContain('正在读图')
    // 卡面在**动作段**（＝「可下增援单位」窗），右栏只读段不画大图
    const fig = panel.indexOf('class="ooa"')
    expect(fig).toBeGreaterThan(0)
    expect(panel.slice(Math.max(0, fig - 200), fig)).toContain('showsActions')
  })
})
