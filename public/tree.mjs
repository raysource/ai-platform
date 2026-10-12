/* ============================================================
   tree.mjs — 把扁平文件路径列表折成目录树（纯函数，不碰 DOM）
   返回「行列表」，前端直接 map 成 HTML；测试直接断言行列表。
   ============================================================ */

const cmp = (a, b) => String(a).localeCompare(String(b), 'zh');

/** 建树：路径按 '/' 切段，最后一段是文件名。重复路径只算一次。 */
function build(paths) {
  const root = { dirs: new Map(), files: [] };
  for (const p of new Set(paths || [])) {
    const segs = String(p).split('/').filter(Boolean);
    if (!segs.length) continue;
    const name = segs.pop();
    let node = root;
    for (const d of segs) {
      if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] });
      node = node.dirs.get(d);
    }
    node.files.push({ name, path: p });
  }
  return root;
}

/** 目录下（含子孙）的文件数。 */
function countFiles(node) {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countFiles(d);
  return n;
}

/**
 * 扁平列出树（目录行 + 文件行，深度优先；目录行带 depth/count/open）。
 * @param {string[]} paths 形如 ['src/core/a.mjs','test/core/a.test.mjs']
 * @param {Record<string, boolean>} open 目录展开状态：显式 false 才收起（默认全展开）
 */
export function treeRows(paths, open = {}) {
  const out = [];
  const walk = (node, depth, prefix) => {
    for (const name of [...node.dirs.keys()].sort(cmp)) {
      const sub = node.dirs.get(name);
      const path = prefix ? `${prefix}/${name}` : name;
      const isOpen = open[path] !== false;
      out.push({ kind: 'dir', depth, name, path, count: countFiles(sub), open: isOpen });
      if (isOpen) walk(sub, depth + 1, path);
    }
    for (const f of node.files.slice().sort((a, b) => cmp(a.name, b.name))) {
      out.push({ kind: 'file', depth, name: f.name, path: f.path });
    }
  };
  walk(build(paths), 0, '');
  return out;
}

/** 便于展示：某个目录路径下直接子项的数量描述。 */
export const dirSummary = (paths) => {
  const rows = treeRows(paths, {});
  const dirs = rows.filter(r => r.kind === 'dir').length;
  return `${dirs} 个目录 · ${(paths || []).length} 个文件`;
};

/* ---------- 「这是不是产出源码」 ---------- */

const CODE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|mts|vue|svelte|py|rb|go|java|rs|php|cs|kt|swift|sh|bash|sql|cds|html|css|scss|less|toml)$/i;

/**
 * 产出源码判定：排除文档（docs/）与点文件（.DS_Store 这类 Finder 垃圾）。
 * 代码扩展名不在此列的一律当资料，不算源码。
 */
export const isSource = (path) => {
  const s = String(path || '');
  if (!s || /(^|\/)\./.test(s)) return false;      // 隐藏文件
  if (/^docs\//i.test(s)) return false;            // 阶段文档
  return CODE_EXT.test(s);
};

/** 从工作区文件列表里挑出源码（带 bytes 等原字段）。 */
export const sourceFiles = (files) => (files || []).filter(f => isSource(f.path));
