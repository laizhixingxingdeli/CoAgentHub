/**
 * 画板比对：把 layout.xml 里的设计坐标与脚本量到的实测框对齐。
 *
 * 纯函数，不读文件、不 spawn、不 fetch——layout.xml 由调用方读好传进来。
 * 这样测试能内联一小段 XML 直接跑，不依赖工作区里有设计稿，也就不用起浏览器。
 *
 * 坐标规则（照设计稿文件头的约定）：子元素的 x/y 相对父元素，逐层累加得到画板内
 * 坐标；画板根自己的 x/y 是它在 Figma 画布上的位置，**不计入**——把它加进去会让
 * 每个节点的设计坐标整体平移 1520px，比对结果全是超差。
 */

const BOX_AXES = ['x', 'y', 'w', 'h'];

/** XML 里常见 `-` 与 `:` 混用（2-140 / 2:140）。统一成 `:` 再比。 */
function canon(node) {
  return String(node ?? '')
    .trim()
    .replace(/-/g, ':');
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** `&amp;` 必须最后替换：否则 `&amp;lt;` 会先变成 `<`，再被当成真的尖括号。 */
function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 逐个标签扫描。注释与 `<? ?>` 要整段跳过：注释里出现的 `<board>` 字样如果被
 * 当成真标签，要么找错画板，要么让栈深度错位，后面的坐标全歪。
 */
function scanTags(xml) {
  const tags = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      i = end < 0 ? xml.length : end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      i = end < 0 ? xml.length : end + 1;
      continue;
    }
    const found = readTag(xml, lt);
    if (!found) break;
    tags.push(found.tag);
    i = found.next;
  }
  return tags;
}

/** 读一个标签。引号里的 `>` 与换行不算标签结束——属性值里这两种都存在。 */
function readTag(xml, lt) {
  let i = lt + 1;
  let quote = null;
  while (i < xml.length) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      break;
    }
    i += 1;
  }
  if (i >= xml.length) return undefined;

  const body = xml.slice(lt + 1, i);
  const closing = body.startsWith('/');
  const bare = closing ? body.slice(1) : body;
  const selfClosing = !closing && /\/\s*$/.test(bare);
  const head = selfClosing ? bare.replace(/\/\s*$/, '') : bare;
  return { next: i + 1, tag: { closing, selfClosing, ...parseNameAndAttrs(head) } };
}

function parseNameAndAttrs(head) {
  let i = 0;
  while (i < head.length && !/\s/.test(head[i])) i += 1;
  const name = head.slice(0, i);
  const attrs = {};

  while (i < head.length) {
    while (i < head.length && /\s/.test(head[i])) i += 1;
    if (i >= head.length) break;
    const keyStart = i;
    while (i < head.length && !/[\s=]/.test(head[i])) i += 1;
    const key = head.slice(keyStart, i);
    while (i < head.length && /\s/.test(head[i])) i += 1;

    let raw = '';
    if (head[i] === '=') {
      i += 1;
      while (i < head.length && /\s/.test(head[i])) i += 1;
      const quote = head[i];
      if (quote === '"' || quote === "'") {
        i += 1;
        const from = i;
        while (i < head.length && head[i] !== quote) i += 1;
        raw = head.slice(from, i);
        i += 1;
      } else {
        const from = i;
        while (i < head.length && !/\s/.test(head[i])) i += 1;
        raw = head.slice(from, i);
      }
    }
    if (key) attrs[key] = decodeEntities(raw);
  }
  return { name, attrs };
}

/** 取出指定画板的内部标签。画板找不到时返回空数组，让每个 pair 各记一次缺失。 */
function boardBody(tags, boardNode) {
  const want = canon(boardNode);
  let start = -1;
  let depth = 0;
  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    if (tag.name !== 'board') continue;
    if (start < 0) {
      if (!tag.closing && canon(tag.attrs.node) === want) start = i;
      continue;
    }
    if (tag.closing) {
      if (depth === 0) return tags.slice(start + 1, i);
      depth -= 1;
    } else if (!tag.selfClosing) {
      depth += 1;
    }
  }
  // 画板没闭合也照样用它剩下的部分：宁可少算，不要整块丢失。
  return start < 0 ? [] : tags.slice(start + 1);
}

function buildIndex(body, boardNode) {
  const want = canon(boardNode);
  const index = new Map();
  const stack = [];

  for (const tag of body) {
    if (tag.closing) {
      stack.pop();
      continue;
    }
    const { attrs } = tag;
    const parent = stack.length > 0 ? stack[stack.length - 1] : undefined;
    const isRoot = attrs.id !== undefined && canon(attrs.id) === want;
    const node = {
      x: isRoot ? 0 : toNumber(attrs.x) + (parent ? parent.x : 0),
      y: isRoot ? 0 : toNumber(attrs.y) + (parent ? parent.y : 0),
      w: toNumber(attrs.width),
      h: toNumber(attrs.height),
      name: attrs.name ?? '',
    };
    if (attrs.id !== undefined) index.set(canon(attrs.id), node);
    // 自闭合元素不留在栈上：留在栈上会让后面的兄弟节点挂到它底下，坐标多算一层。
    if (!tag.selfClosing) stack.push(node);
  }
  return index;
}

function boxOf(node) {
  return node ? { x: node.x, y: node.y, w: node.w, h: node.h } : null;
}

function lineOf(row) {
  const design = row.design
    ? `${row.design.x},${row.design.y},${row.design.w}×${row.design.h}`
    : '缺失';
  const actual = row.actual
    ? `${row.actual.x},${row.actual.y},${row.actual.w}×${row.actual.h}`
    : '缺失';
  const delta = row.delta ? BOX_AXES.map((axis) => row.delta[axis]).join(',') : '-';
  const tail = row.status === 'ok' ? '✓' : row.status === 'over' ? '✗' : '缺失';
  return `Figma ${row.figma} ${row.name} | 设计 ${design} | 实测 ${actual} | 差值 ${delta} | ${tail}`;
}

/**
 * 比对设计框与实测框。`measured` 是 `{ [selector]: {x,y,w,h} | null }`，
 * 缺键与 null 一样算没有匹配元素；这里不再自己查 DOM。
 */
export function compareBoard({ xml, boardNode, pairs, measured, tol } = {}) {
  const source = String(xml ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const index = buildIndex(boardBody(scanTags(source), boardNode), boardNode);
  const limit = Number.isFinite(Number(tol)) ? Number(tol) : 2;
  const rows = [];
  let over = 0;
  let missing = 0;

  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const node = index.get(canon(pair.figma)) ?? null;
    const hit = measured ? measured[pair.selector] : undefined;
    const row = {
      figma: pair.figma,
      name: node ? node.name : '',
      selector: pair.selector,
      design: boxOf(node),
      actual: hit ? { x: hit.x, y: hit.y, w: hit.w, h: hit.h } : null,
      delta: null,
      status: 'missing',
    };

    if (row.design && row.actual) {
      row.delta = {};
      for (const axis of BOX_AXES) row.delta[axis] = row.actual[axis] - row.design[axis];
      const within = BOX_AXES.every((axis) => Math.abs(row.delta[axis]) <= limit);
      row.status = within ? 'ok' : 'over';
      if (!within) over += 1;
    } else {
      // 节点和元素都缺时只记一次：一对拍一行，列两次数会让人以为缺了两件事。
      missing += 1;
    }
    rows.push(row);
  }

  const lines = rows.map((row) => lineOf(row));
  lines.push(`超差 ${over} 项，缺失 ${missing} 项`);
  return { over, missing, lines, rows };
}
