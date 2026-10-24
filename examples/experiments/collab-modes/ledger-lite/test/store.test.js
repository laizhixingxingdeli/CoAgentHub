import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { StoreError, addTransactions, emptyLedger, loadLedger, saveLedger } from '../src/store.js';
import { workdir } from './helpers.js';

const tx = (date, amount, category = '餐饮', note = '') => ({ date, amount, category, note });

test('没有账本文件时返回空账本', () => {
  const dir = workdir();
  assert.deepEqual(loadLedger(join(dir, 'ledger.json')), emptyLedger());
});

test('保存后能读回', () => {
  const dir = workdir();
  const path = join(dir, 'ledger.json');
  const ledger = { version: 1, transactions: [tx('2026-01-01', 100)] };
  saveLedger(path, ledger);
  const loaded = loadLedger(path);
  assert.deepEqual(
    loaded.transactions.map(({ date, amount, category, note }) => ({ date, amount, category, note })),
    ledger.transactions,
  );
  assert.ok(Number.isInteger(JSON.parse(readFileSync(path, 'utf8')).version));
});

test('完全相同的交易只记一次，不修改原账本', () => {
  const original = { version: 1, transactions: [tx('2026-01-01', 100)] };
  const result = addTransactions(original, [tx('2026-01-01', 100), tx('2026-01-01', 101), tx('2026-01-01', 101)]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.ledger.transactions.length, 2);
  assert.equal(original.transactions.length, 1);
});

test('坏文件报 StoreError', () => {
  const dir = workdir();
  const path = join(dir, 'ledger.json');
  writeFileSync(path, '{oops');
  assert.throws(() => loadLedger(path), StoreError);
  writeFileSync(path, JSON.stringify({ version: 99, transactions: [] }));
  assert.throws(() => loadLedger(path), /不认识的账本版本/);
});
