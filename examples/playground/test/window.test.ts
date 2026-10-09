import { test } from 'node:test';
import assert from 'node:assert/strict';
import { head } from '../src/window.ts';

test('head 取前 n 个元素', () => {
  assert.deepEqual(head([1, 2, 3, 4], 2), [1, 2]);
});
