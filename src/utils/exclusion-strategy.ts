import { EXCLUSION_STRATEGY, ExclusionStrategy } from '../types';

/**
 * Whether listing an entry disables renaming for what it matches: under "Only exclude..." the list names what is excluded, while under "Exclude all except..." it names what is spared, so a listed entry enables renaming there.
 * @param strategy - The list's exclusion mode
 * @returns True when a listed entry disables renaming
 */
export function listedEntryDisablesRenaming(
  strategy: ExclusionStrategy
): boolean {
  return strategy === EXCLUSION_STRATEGY.ONLY_EXCLUDE;
}
