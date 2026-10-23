/**
 * 数据契约版本
 *
 * 所有经管线加载的 JSON 文件，其 meta.version 必须与此一致；
 * 数据契约发生破坏性变更（字段增删改）时递增本常量，迫使旧数据文件暴露版本不匹配。
 */
export const DATA_VERSION = '0.4.0'
