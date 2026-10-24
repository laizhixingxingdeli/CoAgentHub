// 账本文件 ledger.json 的读写。格式：{ version, transactions: [{ date, amount, category, note }] }

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export class StoreError extends Error {}

export const STORE_VERSION = 1;

export function emptyLedger() {
  return { version: STORE_VERSION, transactions: [] };
}

export function loadLedger(path) {
  if (!existsSync(path)) return emptyLedger();
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StoreError(`账本文件读不懂：${error.message}`);
  }
  if (data?.version !== 1) throw new StoreError(`不认识的账本版本：${data?.version}`);
  if (!Array.isArray(data.transactions)) throw new StoreError('账本文件缺少 transactions');
  return data;
}

export function saveLedger(path, ledger) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

/** 判重用的键：所有字段都相同才算同一笔。 */
export function transactionKey(tx) {
  return JSON.stringify([tx.date, tx.amount, tx.category, tx.note]);
}

/** 返回新账本与实际新增、跳过的笔数；不修改传入的账本。 */
export function addTransactions(ledger, incoming) {
  const seen = new Set(ledger.transactions.map(transactionKey));
  const transactions = [...ledger.transactions];
  let added = 0;
  let skipped = 0;
  for (const tx of incoming) {
    const key = transactionKey(tx);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    transactions.push(tx);
    added++;
  }
  return { ledger: { ...ledger, transactions }, added, skipped };
}
