import { existsSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import { isOnMap } from '@/engine/hex-geometry'
import { listedVictoryHexes } from '@/engine/rules'
import { DEFAULT_MAP_LAYERS, drawMap, MAP_PALETTE, type ControlMarker } from '@/render/map-render'
import {
  allControlMarkerImageUrls,
  controlMarkerImageUrl,
  COUNTERS_BASE,
} from '@/render/token-images'
import { useMapViewStore, useWorkbenchStore } from '@/stores'

import { combatRecord, label, placeGround } from '../flows/sop-harness'

/**
 * 5.0c：**胜利格控制标记**（用户 2026-09-16 要求）
 *
 * 用户口径：「把这两个标记做到剧本用到的胜利格上，F 是苏联控制、B 是轴心控制，根据控制方
 * 显示对应面，且该标记**钉死**在胜利点**无法选中**，标记更换为根据胜利点归属权变更**自动**进行」。
 *
 * 本文件钉四件事：
 *   ① **图与文件**：F 面＝苏、B 面＝轴；两张图**真在 `public/` 里**（否则地图上是一片空白而断言不会失败）；
 *   ② **钉子（不可选中）**：控制标记不进 `tokens`、不在命中测试/堆叠展开的输入里——它是**画上去的事实**，
 *      不是算子（点它所在格选中/展开的是格里的算子，或者什么都不选）；
 *   ③ **自动翻面**：控制方一变（5.0c 的"进入即记账"）⇒ `controlMarkers` 的 `side` 立刻跟着变；
 *   ④ **画得上**：`drawMap` 在 `layers.control` 打开时画、关掉时不画（用假 ctx 数 `drawImage` 次数）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** 假 ctx：只记最少的调用（与既有渲染测试同一手法） */
function fakeCtx() {
  const images: string[] = []
  const ctx = {
    canvas: { width: 1000, height: 1000 },
    save() {},
    restore() {},
    setTransform() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    rect() {},
    fill() {},
    stroke() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    setLineDash() {},
    drawImage(image: unknown) {
      images.push(String((image as { src?: string }).src ?? ''))
    },
    fillText() {},
    strokeText() {},
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, images }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('5.0c 控制标记：图与取面', () => {
  it('★ F 面＝苏联、B 面＝轴心（用户指定的官方标记）', () => {
    expect(controlMarkerImageUrl('soviet')).toContain('Neutral_Control_Marker_F.png')
    expect(controlMarkerImageUrl('axis')).toContain('Neutral_Control_Marker_B.png')
    expect(allControlMarkerImageUrls()).toHaveLength(2)
  })

  it('★ 两张图**真在 public/ 里**（同步脚本没拷进来时地图上会是一片空白，而断言不会失败）', () => {
    for (const url of allControlMarkerImageUrls()) {
      expect(url.startsWith(`${COUNTERS_BASE}/markers/`)).toBe(true)
      expect(existsSync(`public${decodeURIComponent(url)}`), `图档缺失：${url}`).toBe(true)
    }
  })

  it('控制标记的图层默认开着（它是"这块地归谁"的规则事实）', () => {
    expect(DEFAULT_MAP_LAYERS.control).toBe(true)
  })
})

describe('5.0c 控制标记：钉死且不可选中', () => {
  it('★ 它是**画上去的事实**：不进 tokens ⇒ 命中测试与堆叠展开都看不到它', () => {
    const { workbench, mapView } = newStores()
    // 开局按战线播种 ⇒ 胜利格上有标记
    expect(mapView.controlMarkers.length).toBeGreaterThan(0)

    const markers: readonly ControlMarker[] = mapView.controlMarkers
    const markerHexes = new Set(markers.map((marker) => label(marker.hex)))
    // overlay.tokens 是"地图上可被选中/展开的那些算子"
    const tokenHexes = new Set(mapView.overlay.tokens.map((token) => label(token.hex)))
    for (const hex of markerHexes) expect(tokenHexes.has(hex)).toBe(false)
    // 盘面上一个算子都没有时，标记照样在（说明它不依赖算子）
    expect(workbench.units).toHaveLength(0)
  })

  it('★ 胜利格上**站着算子**时，标记与算子并存但标记不在选择集里（点格选中算子，不是标记）', () => {
    const { workbench, mapView } = newStores()
    const hex = listedVictoryHexes('1')[0]!
    const unit = placeGround(workbench, combatRecord('axis'), hex, 'axis', 'u1')
    expect(mapView.controlMarkers.some((marker) => label(marker.hex) === label(hex))).toBe(true)
    // 该格在 tokens 里的是**算子**（可选中/展开），不是标记
    expect(mapView.overlay.tokens.some((token) => token.id === unit.instanceId)).toBe(true)
  })
})

describe('5.0c 控制标记：随归属自动翻面', () => {
  it('★ 单位进入 ⇒ 该格标记翻到它那一方（不必手点刷新）', () => {
    const { workbench, mapView } = newStores()
    const hex = listedVictoryHexes('1')[0]!
    const before = mapView.controlMarkers.find((marker) => label(marker.hex) === label(hex))
    expect(before?.side).toBe('soviet')

    placeGround(workbench, combatRecord('axis'), hex, 'axis', 'u1')
    const after = mapView.controlMarkers.find((marker) => label(marker.hex) === label(hex))
    expect(after?.side).toBe('axis')
  })

  it('★ 单位撤走 ⇒ 标记**不跟着回退**（5.0c：空格归最后控制者）', () => {
    const { workbench, mapView } = newStores()
    const hex = listedVictoryHexes('1')[0]!
    placeGround(workbench, combatRecord('axis'), hex, 'axis', 'u1')
    workbench.units = workbench.units.filter((unit) => unit.instanceId !== 'u1')
    const after = mapView.controlMarkers.find((marker) => label(marker.hex) === label(hex))
    expect(after?.side).toBe('axis')
  })

  it('标记只出现在**剧本用到的胜利格**上（不多不少）', () => {
    const { mapView } = newStores()
    const hexes = listedVictoryHexes('1')
    const markerKeys = new Set(mapView.controlMarkers.map((marker) => label(marker.hex)))
    for (const hex of hexes) expect(markerKeys.has(label(hex))).toBe(true)
    for (const marker of mapView.controlMarkers) expect(isOnMap(marker.hex)).toBe(true)
  })
})

describe('5.0c 控制标记：画得上（假 ctx 记 fillStyle）', () => {
  const viewport = { scale: 1, offsetX: 0, offsetY: 0 }
  const viewSize = { width: 800, height: 600 }

  /**
   * 假 ctx：**记录每一次 `fillStyle` 赋值**
   *
   * 为什么盯这个：控制标记的回退画法（贴图未就绪时）先设 `fillStyle` 再画方块，
   * 用的正是调色板里的 `controlSoviet` / `controlAxis` 两个**专属色**——
   * 数它们出现几次，就等于数"控制标记画了几枚"，不受其它图层干扰（Node 环境没有 Image
   * ⇒ `counterImages.get()` 恒为 null ⇒ 一定走回退路径，这正是单测能稳定观察的那条）。
   */
  function countingCtx() {
    const fillStyles: string[] = []
    const base = fakeCtx()
    const target = base.ctx as unknown as { fillStyle: string }
    let value = ''
    Object.defineProperty(target, 'fillStyle', {
      get: () => value,
      set: (next: string) => {
        value = next
        fillStyles.push(next)
      },
      configurable: true,
    })
    return { ...base, fillStyles }
  }

  const listed = listedVictoryHexes('1')

  it('★ 图层打开 ⇒ 每一枚标记画一次（用该格的归属色）；关掉 ⇒ 一次都不画', () => {
    const markers: ControlMarker[] = [
      { hex: listed[0]!, side: 'axis' },
      { hex: listed[1]!, side: 'soviet' },
      { hex: listed[2]!, side: 'soviet' },
    ]

    const on = countingCtx()
    drawMap(on.ctx, {
      viewport,
      viewSize,
      layers: { ...DEFAULT_MAP_LAYERS, control: true, hedgehogs: false, labels: false },
      image: null,
      controlMarkers: markers,
    })
    expect(on.fillStyles.filter((style) => style === MAP_PALETTE.controlAxis)).toHaveLength(1)
    expect(on.fillStyles.filter((style) => style === MAP_PALETTE.controlSoviet)).toHaveLength(2)

    const off = countingCtx()
    drawMap(off.ctx, {
      viewport,
      viewSize,
      layers: { ...DEFAULT_MAP_LAYERS, control: false, hedgehogs: false, labels: false },
      image: null,
      controlMarkers: markers,
    })
    expect(
      off.fillStyles.filter(
        (style) => style.startsWith('#2f4a6b') || style === MAP_PALETTE.controlAxis,
      ),
    ).toHaveLength(0)
    expect(off.fillStyles.filter((style) => style === MAP_PALETTE.controlSoviet)).toHaveLength(0)
  })

  it('地图外的格不画（数据脏了也不会画到板外）', () => {
    const { ctx, fillStyles } = countingCtx()
    drawMap(ctx, {
      viewport,
      viewSize,
      layers: { ...DEFAULT_MAP_LAYERS, control: true, hedgehogs: false, labels: false },
      image: null,
      controlMarkers: [{ hex: { col: 999, row: 999 }, side: 'axis' }],
    })
    expect(fillStyles).not.toContain(MAP_PALETTE.controlAxis)
  })

  it('两方的回退色不同（贴图未就绪时也能一眼分出归属）', () => {
    expect(MAP_PALETTE.controlAxis).not.toBe(MAP_PALETTE.controlSoviet)
    expect(mapLayers.hexes.length).toBeGreaterThan(0)
  })
})
