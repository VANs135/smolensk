/**
 * 判定表取表 API 统一出口（A7.1）
 *
 * 输入掷骰值与列位（CRT 为 odds、轰炸表为轰炸值、夺取表为类别、防空/空战为数值骰），
 * 返回结果代码；数据源为 data/charts-crt.json 与 charts-tables.json（经管线冻结）。
 */

export * from './lookup'
export * from './crt'
export * from './barrage'
export * from './capture'
export * from './flak'
export * from './air-combat'
export * from './supply-repl'
export * from './attrition'
export * from './surprise'
