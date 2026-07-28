import type { Rule } from './types.js'

/** Populated task by task; grouping and keeper scoring are not rules and are not listed here. */
export const ALL_RULES: Rule[] = []

export function ruleById(id: string): Rule | undefined {
  return ALL_RULES.find((r) => r.id === id)
}
