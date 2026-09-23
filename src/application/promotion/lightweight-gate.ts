/**
 * Lightweight 交卷之后的升级闸（§4.3 接线）：从一份 trusted ValidationReport 推出该不该升级、凭什么。
 *
 * 为什么要这层：检测器（diff-detectors / validator-failure-unrepairable-detector）只回答
 * 「有没有这个信号」，不选优先级、不接线。没有人接线的结果是 E1 实测的那一幕——执行者改对了、
 * 机器验收因为一条配置判失败，Lightweight 没有出口，Mission 停在 stalled 等人（870 秒）。
 *
 * 只读报告里机器写下的东西：changed-paths 检查记下的实际改动清单、每项检查的 passed / failureCode /
 * summary。不读 Mission / WorkItem / 工作区，也不接受调用方自述——触发必须能从这份报告复算出来。
 *
 * 顺序：先看改动规模，再看验收失败。规模超了说明这件事本来就不该走 Lightweight，
 * 即使机器验收过了也要交给协调者做 L2；规模没超、只是验收没过，才是「结果不达标」。
 */

import type { PromotionTriggerCode, ValidationReport } from '../../kernel/index.ts';
import { detectChangedFilesGt3, detectTopLevelModulesGt2, normalizeDiffFiles } from './diff-detectors.ts';
import { detectValidatorFailureUnrepairable } from './validator-failure-unrepairable-detector.ts';

export interface LightweightGateTrigger {
  readonly code: PromotionTriggerCode;
  /** 写进 PromotionRecord.triggerRule，也是协调者被唤醒时看到的那句原因。 */
  readonly rule: string;
}

/** 规则里列文件 / 失败摘要时的上限：原因要说清，但不能把整份报告塞进一条记录。 */
const LIST_LIMIT = 6;
const SUMMARY_LIMIT = 300;

function listed(items: readonly string[]): string {
  const shown = items.slice(0, LIST_LIMIT).join('、');
  return items.length > LIST_LIMIT ? `${shown} 等 ${items.length} 项` : shown;
}

function clipped(text: string): string {
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 1)}…` : text;
}

export function lightweightGateTrigger(report: ValidationReport): LightweightGateTrigger | null {
  const actual = report.checks.find((check) => check.kind === 'changed-paths')?.changedPaths?.actual;
  if (actual !== undefined) {
    const files = normalizeDiffFiles(actual);
    if (detectChangedFilesGt3({ files }) === 'changed_files_gt_3') {
      return {
        code: 'changed_files_gt_3',
        rule: `实际改动 ${files.length} 个文件，超过 Lightweight 的 3 个：${listed(files)}。交给协调者做 L2。`,
      };
    }
    if (detectTopLevelModulesGt2({ files }) === 'top_level_modules_gt_2') {
      const modules = [...new Set(files.map((file) => file.split('/')[0]!))];
      return {
        code: 'top_level_modules_gt_2',
        rule: `实际改动跨 ${modules.length} 个顶层目录（${listed(modules)}），超过 Lightweight 的 2 个。交给协调者做 L2。`,
      };
    }
  }

  if (report.passed !== false) return null;

  const failed = report.checks.filter((check) => !check.passed);
  const summaries = clipped(failed.map((check) => `${check.kind}：${check.summary}`).join('；'));
  if (detectValidatorFailureUnrepairable({ report }) === 'validator_failure_unrepairable') {
    const codes = [...new Set(failed.map((check) => check.failureCode).filter(Boolean))];
    return {
      code: 'validator_failure_unrepairable',
      rule:
        `ValidationReport ${report.id} 的验收配置本身跑不起来（${codes.join('、')}）：${summaries}。` +
        '执行者修不了工单，交给协调者重写。',
    };
  }
  // 普通失败也记成 validator_failure_unrepairable：§4.3 的触发是「首次失败后无法做机械修复」，
  // 而 Lightweight 这条车道没有返工通道——对它来说，任何一次验收失败都修不了。
  // 不另开「让执行者照报告再修一次」的循环：E1 那次失败是工单上限配错了，改动本身是对的，
  // 逼执行者去「修」只会把对的改坏。交给协调者，它能分辨是结果错了还是工单错了。
  return {
    code: 'validator_failure_unrepairable',
    rule:
      `ValidationReport ${report.id} 未通过：${summaries}。` +
      'Lightweight 没有返工通道，交给协调者对照报告做 L2（结果错了就带着修改意见打回，工单错了就改工单）。',
  };
}
