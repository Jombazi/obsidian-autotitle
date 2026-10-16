import { CustomReplacement } from '../types';

/**
 * Apply the user's custom replacement rules to a line, in list order.
 * @param line - Line to rewrite
 * @param rules - Rules from settings; a rule with empty search text is skipped
 * @returns The line after every rule has run
 */
export function applyCustomReplacementRules(
  line: string,
  rules: CustomReplacement[]
): string {
  let result = line;
  for (const rule of rules) {
    if (rule.searchText === '') continue;

    if (rule.onlyWholeLine) {
      if (result.trim() === rule.searchText.trim()) {
        result = rule.replaceText;
      }
    } else if (rule.onlyAtStart) {
      if (result.startsWith(rule.searchText)) {
        result = rule.replaceText + result.slice(rule.searchText.length);
      }
    } else {
      // Replacer function so `$&` and `$$` in the user's replacement text stay literal.
      result = result.replaceAll(rule.searchText, () => rule.replaceText);
    }
  }
  return result;
}

/**
 * The rule dialog's duplicate key: two rules share it when they replace the same text with the same match options, whatever each replaces it with.
 * Branches in `applyCustomReplacementRules`'s order, so a rule with both options keys as whole-line, the only branch the engine takes for it.
 * @param rule - Rule, or the dialog's values for one
 * @returns The key; the whole-line branch trims, because the engine compares trimmed text there
 */
export function customReplacementMatchKey(rule: CustomReplacement): string {
  if (rule.onlyWholeLine) {
    return JSON.stringify(['line', rule.searchText.trim()]);
  }
  if (rule.onlyAtStart) {
    return JSON.stringify(['start', rule.searchText]);
  }
  return JSON.stringify(['any', rule.searchText]);
}
