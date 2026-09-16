/**
 * Artifact Store（S13.2）。
 *
 * 大日志、大 diff、构建产物放文件系统，状态里只留一个 ref。
 *
 * 为什么非做不可：整份状态是一次写出去的 JSON。一次执行能吐几十万字符，
 * 几十条 Mission 之后这个文件会大到每次写都卡住——而**每一次工具调用
 * 都会触发一次写**。截断能缓解但会丢信息；存到旁边既不丢也不撑。
 *
 * 判据是大小，不是类型：小的东西内联更方便（点开就看到，不用再取一次），
 * 大的才值得外置。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export interface StoredBlob {
  /** 内联时是内容本身；外置时是 undefined。 */
  readonly inline?: string;
  /** 外置时的引用；内联时是 undefined。 */
  readonly ref?: string;
  readonly bytes: number;
  /** 外置时保留的开头一段，让人不用取就知道大概是什么。 */
  readonly preview?: string;
}

export interface ArtifactStore {
  /** 按大小决定内联还是外置。 */
  put(content: string): StoredBlob;
  get(ref: string): string | undefined;
}

/** 内联阈值：小于它就不值得外置。 */
const INLINE_LIMIT = 4_000;
const PREVIEW = 400;

export class FileArtifactStore implements ArtifactStore {
  #root: string;
  #limit: number;

  constructor(root: string, inlineLimit = INLINE_LIMIT) {
    this.#root = resolve(root);
    this.#limit = inlineLimit;
  }

  put(content: string): StoredBlob {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes <= this.#limit) return { inline: content, bytes };

    // 用内容哈希做文件名：同一段输出重复提交不会堆出多份副本。
    const ref = createHash('sha256').update(content).digest('hex').slice(0, 32);
    mkdirSync(this.#root, { recursive: true });
    const path = join(this.#root, `${ref}.txt`);
    if (!existsSync(path)) writeFileSync(path, content, 'utf8');
    return { ref, bytes, preview: content.slice(0, PREVIEW) };
  }

  get(ref: string): string | undefined {
    // 只认十六进制哈希：ref 是从状态文件里读出来的，拼进路径之前
    // 必须先确认它不是 `../` 这种东西。
    if (!/^[0-9a-f]{8,64}$/.test(ref)) return undefined;
    const path = join(this.#root, `${ref}.txt`);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  }
}

/** 全部内联。测试与"不想落盘"的场景用。 */
export class InlineArtifactStore implements ArtifactStore {
  put(content: string): StoredBlob {
    return { inline: content, bytes: Buffer.byteLength(content, 'utf8') };
  }

  get(): undefined {
    return undefined;
  }
}
