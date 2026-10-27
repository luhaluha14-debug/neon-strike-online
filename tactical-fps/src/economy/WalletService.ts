import { LEDGER_LIMIT } from './EconomyRules';
import type { AccountState, Transaction, TransactionKind } from './types';

/**
 * GRID credits: the balance and its ledger. Every change is a whole number,
 * the balance never goes below zero, and each movement gets its own
 * transaction id. Works on a draft account (EconomyAuthority commits it).
 */
export const WalletService = {
  balance(a: AccountState): number {
    return a.credits;
  },

  canAfford(a: AccountState, price: number): boolean {
    return Number.isInteger(price) && price >= 0 && a.credits >= price;
  },

  /** Adds (amount > 0) or takes (amount < 0) credits. Throws on an invalid amount or an overdraft. */
  apply(a: AccountState, amount: number, kind: TransactionKind, ref: string, at: string, requestId?: string): Transaction {
    if (!Number.isInteger(amount)) throw new Error(`invalid amount ${amount}`);
    const next = a.credits + amount;
    if (next < 0) throw new Error('overdraft');
    a.credits = next;
    a.seq++;
    const tx: Transaction = { txId: `${a.accountId}-tx-${a.seq}`, at, kind, amount, balanceAfter: next, ref, ...(requestId ? { requestId } : {}) };
    a.ledger.push(tx);
    if (a.ledger.length > LEDGER_LIMIT) a.ledger.splice(0, a.ledger.length - LEDGER_LIMIT);
    return tx;
  },
};
