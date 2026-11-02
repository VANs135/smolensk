/** 4.5a / 9.12e：按动作解释同一个敌方ZOC，禁止把抵消结果通用到所有操作。 */
export const ZOC_ACTION_POLICIES = {
  truckMovement: { negatable: true, rule: '4.5a-A' },
  truckSupply: { negatable: true, rule: '4.5a-B' },
  railTransport: { negatable: false, rule: '4.5a-C' },
  railSupply: { negatable: true, rule: '4.5a-D' },
  railConversion: { negatable: false, rule: '4.5a-E' },
  aircraftRefit: { negatable: true, rule: '4.5a-H' },
  reserveMode: { negatable: false, rule: '4.5a-I' },
  stratMode: { negatable: false, rule: '4.5a-J' },
  stratMovement: { negatable: false, rule: '5.8a' },
  rebuild: { negatable: false, rule: '4.5a-K' },
  retreat: { negatable: false, rule: '9.12e' },
} as const
export type ZocAction = keyof typeof ZOC_ACTION_POLICIES
/** 这里只判断该动作是否仍受ZOC影响；停止、拒绝或撤退后果由所属规则执行。 */
export function zocAffectsAction(
  action: ZocAction,
  rawEnemyZoc: boolean,
  negated: boolean,
): boolean {
  return rawEnemyZoc && !(ZOC_ACTION_POLICIES[action].negatable && negated)
}
