/**
 * DETECT-001：changed_files_gt_3 / top_level_modules_gt_2 纯 diff 检测器。
 *
 * 守住：
 *   - 只吃 { files }；不读盘、不 git、不碰 Mission/Platform
 *   - 规范化：trim / 空串丢弃 / 斜杠统一 / 去重
 *   - 阈值严格大于（>3 files / >2 top-level）
 *   - 输入数组不被 mutate
 *   - 两检测器独立，无组合 chooser
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectChangedFilesGt3,
  detectTopLevelModulesGt2,
  normalizeDiffFiles,
} from '../src/application/promotion/diff-detectors.ts';

describe('normalizeDiffFiles', () => {
  test('trim、丢空/空白、统一 \\ → /、去重且保序', () => {
    assert.deepEqual(
      normalizeDiffFiles([
        '  src/a.ts ',
        '',
        '   ',
        'src\\a.ts',
        'src/b.ts',
        'src/b.ts',
        '\t',
      ]),
      ['src/a.ts', 'src/b.ts'],
    );
  });

  test('不 mutate 输入数组', () => {
    const files = [' src\\x.ts ', 'src/x.ts', ''];
    const snapshot = files.slice();
    normalizeDiffFiles(files);
    assert.deepEqual(files, snapshot);
  });
});

describe('detectChangedFilesGt3', () => {
  test('0..3 唯一文件 => null', () => {
    assert.equal(detectChangedFilesGt3({ files: [] }), null);
    assert.equal(detectChangedFilesGt3({ files: ['a.ts'] }), null);
    assert.equal(detectChangedFilesGt3({ files: ['a.ts', 'b.ts'] }), null);
    assert.equal(
      detectChangedFilesGt3({ files: ['a.ts', 'b.ts', 'c.ts'] }),
      null,
    );
  });

  test('恰好 4 唯一文件 => changed_files_gt_3', () => {
    assert.equal(
      detectChangedFilesGt3({
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      }),
      'changed_files_gt_3',
    );
  });

  test('重复路径不能抬高计数', () => {
    assert.equal(
      detectChangedFilesGt3({
        files: [
          'a.ts',
          'a.ts',
          'b.ts',
          'b.ts',
          'c.ts',
          '  c.ts  ',
          'c.ts',
        ],
      }),
      null,
    );
    // slash 变体与空白视为同一路径
    assert.equal(
      detectChangedFilesGt3({
        files: [
          'src/a.ts',
          'src\\a.ts',
          ' src/a.ts ',
          'src/b.ts',
          'src\\b.ts',
          'src/c.ts',
        ],
      }),
      null,
    );
    assert.equal(
      detectChangedFilesGt3({
        files: [
          'src/a.ts',
          'src\\a.ts',
          'src/b.ts',
          'src/c.ts',
          'src/d.ts',
          'src\\d.ts',
        ],
      }),
      'changed_files_gt_3',
    );
  });

  test('空串与纯空白不计入；输入不 mutate', () => {
    const files = ['a.ts', '', '  ', '\t', 'b.ts', 'c.ts', 'd.ts'];
    const snapshot = files.slice();
    assert.equal(detectChangedFilesGt3({ files }), 'changed_files_gt_3');
    assert.deepEqual(files, snapshot);

    assert.equal(
      detectChangedFilesGt3({ files: ['', '  ', 'a.ts', 'b.ts', 'c.ts'] }),
      null,
    );
  });
});

describe('detectTopLevelModulesGt2', () => {
  test('3 个 distinct top-level segments => top_level_modules_gt_2', () => {
    assert.equal(
      detectTopLevelModulesGt2({
        files: ['src/a.ts', 'test/b.ts', 'docs/c.md'],
      }),
      'top_level_modules_gt_2',
    );
  });

  test('≤2 top-level => null', () => {
    assert.equal(detectTopLevelModulesGt2({ files: [] }), null);
    assert.equal(
      detectTopLevelModulesGt2({ files: ['src/a.ts', 'src/b.ts'] }),
      null,
    );
    assert.equal(
      detectTopLevelModulesGt2({
        files: ['src/a.ts', 'test/b.ts', 'src/c.ts'],
      }),
      null,
    );
  });

  test('4 个嵌套文件同属一个 top-level => 仅 changed-files 触发', () => {
    const files = [
      'src/a.ts',
      'src/b.ts',
      'src/nested/c.ts',
      'src/nested/deep/d.ts',
    ];
    assert.equal(detectTopLevelModulesGt2({ files }), null);
    assert.equal(detectChangedFilesGt3({ files }), 'changed_files_gt_3');
  });

  test('backslash/slash 与空/空白处理确定；输入不 mutate', () => {
    const files = [
      'src\\one.ts',
      ' test/two.ts ',
      'docs\\three.md',
      '',
      '   ',
      'src/one.ts',
    ];
    const snapshot = files.slice();
    assert.equal(detectTopLevelModulesGt2({ files }), 'top_level_modules_gt_2');
    assert.deepEqual(files, snapshot);

    // 仅两个 top-level（重复与 slash 变体合并）
    assert.equal(
      detectTopLevelModulesGt2({
        files: ['app\\x.ts', 'app/y.ts', 'lib\\z.ts', '', '  '],
      }),
      null,
    );
  });

  test('检测器相互独立：模块触发不依赖文件数阈值', () => {
    // 3 files / 3 modules：modules 触发，files 不触发
    const threeModules = ['a/x', 'b/y', 'c/z'];
    assert.equal(
      detectTopLevelModulesGt2({ files: threeModules }),
      'top_level_modules_gt_2',
    );
    assert.equal(detectChangedFilesGt3({ files: threeModules }), null);
  });
});
