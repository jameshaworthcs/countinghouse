import { ACCESS_GROUPS, WRAPPER_GROUPS } from '../../shared/accounts';
import { SERIES } from '../components/charts/common';

/** Colour follows the group, in the fixed categorical order, never its rank. */
export function wrapperColor(id: string): string {
  const i = (WRAPPER_GROUPS as readonly string[]).indexOf(id);
  return SERIES[i >= 0 ? i : 7]!;
}

export function accessColor(id: string): string {
  const i = (ACCESS_GROUPS as readonly string[]).indexOf(id);
  return SERIES[i >= 0 ? i : 7]!;
}
