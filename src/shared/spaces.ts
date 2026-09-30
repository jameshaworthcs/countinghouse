// Moves inside an account: between its main balance and one of its Spaces (or pots) whose money
// its statements count in the balance. Starling's statements do, and list no such move; its app
// lists each one, typed "Saving" and named after the Space. Recorded, one would be money in or out
// that the statements on either side of it never saw (docs/INGESTION.md, "Moves inside an account").

import type { Account } from './schema';

/** How a bank's app types a move between the main balance and a Space, by institution. */
const SPACE_MOVE_TYPES: Record<string, RegExp> = {
  starling: /^saving$/i,
};

const same = (a: string | null | undefined, b: string) => Boolean(a) && a!.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The Space a row moves money to or from, inside `account`, or undefined when it is money in or
 * out. A row the bank types as a Space move is one; so is a row naming one of the account's Spaces
 * with no type saying otherwise ("Max · Payments" is a payment to someone called Max).
 */
export function spaceMove(
  account: Pick<Account, 'institutionId' | 'spaces'> | undefined,
  row: { description: string; type?: string | null | undefined; counterpartyName?: string | null | undefined },
): string | undefined {
  if (!account) return undefined;
  const moveType = account.institutionId ? SPACE_MOVE_TYPES[account.institutionId] : undefined;
  const name = row.counterpartyName?.trim() || row.description.trim();
  if (moveType && row.type && moveType.test(row.type.trim())) return name;
  if (row.type && !(moveType?.test(row.type.trim()) ?? false)) return undefined;
  return account.spaces?.find((s) => same(row.counterpartyName, s) || same(row.description, s));
}
