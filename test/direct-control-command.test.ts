/**
 * direct 主控命令的形状解析：`order.contextRefs` 的窄类型。
 *
 * kernel 的 `WorkOrder.contextRefs` 是 `(string | ContextRef)[]`，direct 命令只收
 * 带类型的对象（`{kind, ref, why?}`）：裸字符串在协议面无法表达 kind。
 * 这一份守三件事：合法对象引用原样通过且不改输入；各类坏形状统一
 * `INVALID_DIRECT_COMMAND` 且不回显字段值；空数组仍合法（老工单不废）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDirectControlCommand } from '../src/application/platform/direct-control-command.ts';
import { PlatformRuleError } from '../src/application/platform/context.ts';

const CONTEXT_REFS = [
  { kind: 'file', ref: 'src/foo.ts', why: '要改的就是它' },
  { kind: 'living_spec', ref: 'scheduling' },
] as const;

function order(contextRefs: unknown): Record<string, unknown> {
  return {
    objective: '把 foo 修好',
    allowedScope: ['src/foo.ts'],
    requiredBehaviour: 'foo() 返回 1',
    constraints: [],
    acceptance: ['foo() === 1'],
    verification: ['node --test test/foo.test.ts'],
    doNot: [],
    contextRefs,
  };
}

function assertRejected(command: unknown, echoed: readonly string[] = []): void {
  let thrown: unknown;
  try {
    parseDirectControlCommand(command);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof PlatformRuleError, '应抛 PlatformRuleError');
  assert.equal(thrown.code, 'INVALID_DIRECT_COMMAND');
  for (const value of echoed) {
    assert.ok(!thrown.message.includes(value), `报错不应回显输入值 ${value}`);
  }
}

test('contextRefs 只收带类型的对象引用，两类工单命令一致', () => {
  // 合法的对象引用：create_work_item 与 revise_work_order 都原样通过，且不改输入。
  const create = { action: 'create_work_item', title: '修 foo', order: order(CONTEXT_REFS) };
  const createSnapshot = structuredClone(create);
  const created = parseDirectControlCommand(create);
  assert.equal(created.action, 'create_work_item');
  assert.deepEqual(create, createSnapshot, '解析不应改输入');

  const revise = { action: 'revise_work_order', workItemId: 'W-1', order: order(CONTEXT_REFS) };
  const reviseSnapshot = structuredClone(revise);
  const revised = parseDirectControlCommand(revise);
  assert.equal(revised.action, 'revise_work_order');
  assert.deepEqual(revise, reviseSnapshot, '解析不应改输入');

  // 空数组仍合法。
  for (const action of ['create_work_item', 'revise_work_order'] as const) {
    const body =
      action === 'create_work_item'
        ? { action, title: '修 foo', order: order([]) }
        : { action, workItemId: 'W-1', order: order([]) };
    assert.equal(parseDirectControlCommand(body).action, action);
  }

  // 坏形状一律拒绝，报错不带字段值。同一批也覆盖 revise_work_order。
  const badRefs: readonly { refs: unknown; echoed: readonly string[] }[] = [
    { refs: ['src/foo.ts'], echoed: ['src/foo.ts'] }, // 裸字符串引用
    { refs: [['src/foo.ts']], echoed: ['src/foo.ts'] }, // 数组不是 plain object
    { refs: [null], echoed: [] },
    { refs: [{ ref: 'src/foo.ts' }], echoed: ['src/foo.ts'] }, // 缺 kind
    { refs: [{ kind: 'path', ref: 'src/foo.ts' }], echoed: ['src/foo.ts'] }, // 未知 kind
    { refs: [{ kind: 'file', ref: '' }], echoed: [] }, // ref 空串
    { refs: [{ kind: 'file', ref: '   ' }], echoed: [] }, // ref 全空白
    { refs: [{ kind: 'file', ref: 42 }], echoed: ['42'] }, // ref 非字符串
    { refs: [{ kind: 'file' }], echoed: [] }, // 缺 ref
    { refs: [{ kind: 'file', ref: 'src/foo.ts', why: 7 }], echoed: ['src/foo.ts'] }, // why 非字符串
    { refs: {}, echoed: [] }, // 非数组
    { refs: undefined, echoed: [] }, // 缺字段
  ];
  for (const { refs, echoed } of badRefs) {
    assertRejected({ action: 'create_work_item', title: '修 foo', order: order(refs) }, echoed);
    assertRejected({ action: 'revise_work_order', workItemId: 'W-1', order: order(refs) }, echoed);
  }
});
