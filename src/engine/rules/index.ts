/**
 * 规则常量模块统一出口
 *
 * 引擎各机制只从本模块取数值常量（数值唯一来源 data/rules-constants.json，
 * 加载期为校验 + 深度冻结）。业务代码禁止出现规则数字字面量。
 */

export * from './supply'
export * from './trace-supply'
export * from './supply-phase'
export * from './supply-interaction'
export * from './fuel'
export * from './modes'
export * from './move-types'
export * from './map-facts'
export * from './move'
export * from './move-interaction'
export * from './overrun'
export * from './legality'
export * from './movement'
export * from './terrain'
export * from './combat'
export * from './battle'
export * from './combat-interaction'
export * from './special-combat'
export * from './barrage'
export * from './barrage-interaction'
export * from './air'
export * from './air-mission'
export * from './air-interaction'
export * from './rail-supply'
export * from './construction'
export * from './extender'
export * from './timing'
export * from './weather'
export * from './rail-cap'
export * from './rail'
export * from './breakout'
export * from './variable-exit'
export * from './hedgehog'
export * from './zoc'
// W6 B18：到达、补员与编制调整
export * from './arrival'
export * from './variable-repl'
export * from './rebuild'
export * from './breakdown'
export * from './consolidation'
export * from './cleanup'
export * from './nkvd'
// W6 B19：Smolensk 专规机制
export * from './panzer-groups'
export * from './security-needs'
export * from './supply-cache'
export * from './red-air-force'
export * from './exclusive-timing'
// W6 B20：胜利判定（专规 5.0 / 5.0a / 5.0b / 5.0c）
export * from './victory'
// W7 C12：记录轨与容器管理（回合轨/天气轨/铁路容量轨 + 死亡堆/拆分盒/特殊补员抽取盒/
// 剧本抽取盒/地图外空军盒/边缘盒/编队收纳盒）
export * from './containers'
// W7 C17（B6）：SOP 环节链（2.2 段名原文里的子步）
export * from './sop-segments'
// W7 C13：切方与信息展示纪律（4.9a 敌方堆叠可见性 / 4.8b 堆叠顺序 / 4.9b 参战公开数值 /
// 4.9e 秘密掷骰 / 共识开关 → 信息纪律）
export * from './fog'
// W7 C14：初设与开局流程（通规 IV Set Up Notes / 专规 Setup Notes / 12.1d SP 归属 /
// 3.4b 装甲集群 SP / 13.2h 卡车满载 / IV-E·14.1a 飞机初设）
export * from './setup'
