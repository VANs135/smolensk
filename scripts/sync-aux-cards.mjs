/**
 * 辅助卡分区同步（源库 `aux_cards.json` → 产物 `src/data/aux-cards.json`）
 *
 * 数据用途：把「盒」画成真实卡面，并把盒内算子摆进**标定好的分区**（死人堆、标记存放、
 * 拆分单位存放、编队标记抽取盒、特补师池、警戒单位池、地图外东北/东南盒、空军激活/未激活）。
 * 坐标是**卡面图像素**（左上原点，x 右 y 下），渲染侧按卡片显示尺寸等比缩放即可。
 *
 * 单一来源：用户 2026-09-16 交付的 `D:\OCS\六角格标定测试\辅助卡标定\*.boxes.json`，
 * 已由入库脚本规范化进源库（含矩形越界校验）；本脚本只做搬运与字段归一，不再做规则判断。
 *
 * 运行：node scripts/sync-aux-cards.mjs（产物无手写内容时可加 --force）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { format, resolveConfig } from 'prettier'

import { decideOverwrite, refusalLines } from './overwrite-guard.mjs'

/** 与数据管线 DATA_VERSION 保持一致的产物版本 */
export const AUX_CARDS_VERSION = '0.4.0'

/** 单条分区 → 产物记录（纯函数，供单测） */
export function toCardRegion(region) {
  return {
    id: region.region_id,
    label: region.label,
    boxKind: region.box_kind,
    rect: { x: region.x, y: region.y, w: region.w, h: region.h },
  }
}

/** 单张卡 → 产物记录（纯函数，供单测） */
export function toCard(item) {
  return {
    id: item.card_id,
    side: item.side,
    boxKind: item.box_kind,
    name: item.name,
    image: item.image,
    imageSize: { w: item.image_size.w, h: item.image_size.h },
    regions: item.regions.map(toCardRegion),
  }
}

/** 组装产物（纯函数：meta + 卡清单，按 id 字典序稳定） */
export function buildAuxCards(input) {
  const cards = input.items.map(toCard).sort((a, b) => a.id.localeCompare(b.id))
  return {
    meta: {
      version: AUX_CARDS_VERSION,
      description:
        '辅助卡分区（地图外盒 / 死人堆 / 空军盒）：每张卡的卡面尺寸与分区矩形（卡面图像素坐标），供界面把盒内算子摆进真实分区',
      source: [
        'aux_cards.json（6 张卡 / 12 个分区；用户 2026-09-16 交付，工具：六角格标定测试 · 辅助卡标定）',
        '卡面图：图片素材库\\地图及辅助卡（German/Russian Dead Pile、German-Offboard-2、Russian-Offboard4、German Airfields1、RussianAirfields）',
      ],
    },
    cards,
  }
}

async function main() {
  const DB_DIR = 'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库'
  const cwd = dirname(fileURLToPath(import.meta.url))
  const OUT_FILE = join(cwd, '..', 'src', 'data', 'aux-cards.json')
  const source = JSON.parse(readFileSync(join(DB_DIR, 'aux_cards.json'), 'utf8'))

  const next = buildAuxCards(source)
  const text = JSON.stringify(next, null, 2) + '\n'
  const config = await resolveConfig(OUT_FILE)
  const formatted = await format(text, { ...config, parser: 'json' })

  const existingText = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : null
  const decision = decideOverwrite({
    nextText: formatted,
    existingText,
    force: process.argv.includes('--force'),
  })
  if (!decision.ok) {
    for (const line of refusalLines({ outFile: OUT_FILE, preserved: [] })) console.error(line)
    process.exit(1)
  }

  writeFileSync(OUT_FILE, formatted, 'utf8')
  const regions = next.cards.reduce((sum, card) => sum + card.regions.length, 0)
  console.log(
    `written aux-cards.json（卡 ${next.cards.length} · 分区 ${regions} · ${decision.reason}）`,
  )
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) void main()
