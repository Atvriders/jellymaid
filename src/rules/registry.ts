import type { Rule } from './types.js'
import { dupeGroupRule } from './dupes/adapter.js'
import { FILESYSTEM_RULES } from './filesystem/index.js'
import { METADATA_RULES } from './metadata/index.js'
import { QUALITY_RULES } from './quality/index.js'

/** Populated task by task; grouping and keeper scoring are not rules themselves and are not listed here. */
export const ALL_RULES: Rule[] = [dupeGroupRule, ...FILESYSTEM_RULES, ...METADATA_RULES, ...QUALITY_RULES]

export function ruleById(id: string): Rule | undefined {
  return ALL_RULES.find((r) => r.id === id)
}
