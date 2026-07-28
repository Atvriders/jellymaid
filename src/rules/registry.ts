import type { Rule } from './types.js'
import { dupeGroupRule } from './dupes/adapter.js'

/** Populated task by task; grouping and keeper scoring are not rules themselves and are not listed here. */
export const ALL_RULES: Rule[] = [dupeGroupRule]

export function ruleById(id: string): Rule | undefined {
  return ALL_RULES.find((r) => r.id === id)
}
