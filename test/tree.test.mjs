/* ============================================================
   源码目录树（public/tree.mjs）：扁平路径 → 树行列表
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treeRows, dirSummary, isSource, sourceFiles } from '../public/tree.mjs';

// 紧凑表示：目录 → '📁 名(递归文件数)[-收起]'，文件 → '📄 名'，缩进表示层级
const show = (paths, open) => treeRows(paths, open)
  .map(r => '  '.repeat(r.depth) + (r.kind === 'dir'
    ? `📁 ${r.name}(${r.count})${r.open ? '' : '[-]'}`
    : `📄 ${r.name}`))
  .join('\n');

test('fileTree：多层目录折成树，目录在前文件在后，CJK 名不乱序', () => {
  assert.equal(show([
    'src/core/m1-基础工具/index.mjs',
    'src/core/m1-基础工具/index.test.mjs',
    'src/api/m4-接口层/index.mjs',
    'test/core/m1-基础工具.test.mjs',
    'README.md',
  ]), [
    '📁 src(3)',
    '  📁 api(1)',
    '    📁 m4-接口层(1)',
    '      📄 index.mjs',
    '  📁 core(2)',
    '    📁 m1-基础工具(2)',
    '      📄 index.mjs',
    '      📄 index.test.mjs',
    '📁 test(1)',
    '  📁 core(1)',
    '    📄 m1-基础工具.test.mjs',
    '📄 README.md',
  ].join('\n'));
});

test('fileTree：目录默认全展开，显式 false 才收起；收起后仍保留目录行与文件数', () => {
  const paths = ['src/core/a.mjs', 'src/core/b.mjs', 'src/cli/c.mjs'];
  assert.equal(treeRows(paths, {}).filter(r => r.kind === 'file').length, 3, '默认全展开');
  assert.equal(show(paths, { src: false }), '📁 src(3)[-]', '收起 src 后只剩目录行');
  assert.equal(show(paths, { 'src/core': false }), [
    '📁 src(3)',
    '  📁 cli(1)',
    '    📄 c.mjs',
    '  📁 core(2)[-]',
  ].join('\n'), '只收起子目录，兄弟目录不受影响');
});

test('fileTree：同名目录在不同层级各自成节点，文件与目录同名不混淆', () => {
  const out = treeRows(['src/core/a.mjs', 'test/core/b.mjs', 'core.md', 'core']);
  assert.deepEqual(out.map(r => `${r.kind}:${r.path}`), [
    'dir:src', 'dir:src/core', 'file:src/core/a.mjs',
    'dir:test', 'dir:test/core', 'file:test/core/b.mjs',
    'file:core', 'file:core.md',
  ], 'src/core 与 test/core 互不干扰；core 没斜杠就是文件不是目录');
  assert.equal(out.find(r => r.path === 'src/core').count, 1, 'count 只数自己下面的文件');
  assert.equal(out.find(r => r.path === 'src').count, 1, '上层目录递归计数');
});

test('fileTree：空输入、重复路径、多余/前导斜杠都不炸', () => {
  assert.deepEqual(treeRows([]), []);
  assert.deepEqual(treeRows(null), []);
  const dup = treeRows(['a/b.mjs', 'a/b.mjs', 'a/b.mjs']);
  assert.equal(dup.filter(r => r.kind === 'file').length, 1, '同一路径重复只算一次');
  assert.equal(dup.find(r => r.kind === 'dir').count, 1);
  const odd = treeRows(['/a/c.mjs', 'a//d.mjs']);
  assert.equal(odd.filter(r => r.kind === 'dir').length, 1, '前导/重复斜杠不建多余目录');
  assert.deepEqual(odd.filter(r => r.kind === 'file').map(r => r.path), ['/a/c.mjs', 'a//d.mjs'],
    '原始路径原样带在文件行上（取文件要用原路径）');
  assert.equal(dirSummary(['src/a/b.mjs', 'test/c.mjs']), '3 个目录 · 2 个文件');
});

test('isSource：只认产出源码，文档与点文件不算', () => {
  for (const p of ['src/core/m1-x/index.mjs', 'test/core/m1-x.test.mjs', 'src/api/routes.ts', 'src/web/app.js',
                   'src/web/index.html', 'src/web/app.css', 'src/dao/schema.sql', 'src/x/main.py',
                   'src/main/java/web/M1Core.java', 'db/schema.cds', 'srv/order-service.cds'])
    assert.equal(isSource(p), true, `应算源码：${p}`);
  for (const p of ['docs/03-架构设计/ARC-01.md', '.DS_Store', 'src/.DS_Store', '.git/config',
                   'docs/uh/UX-01.md', 'inputs/需求.md', 'README.md', 'notes.txt', 'data.csv', 'package.json'])
    assert.equal(isSource(p), false, `不算源码：${p}`);
  assert.deepEqual(sourceFiles([
    { path: 'docs/a.md', bytes: 1 }, { path: 'src/a.mjs', bytes: 2 },
    { path: '.DS_Store', bytes: 3 }, { path: 'test/a.test.mjs', bytes: 4 },
  ]).map(f => f.path), ['src/a.mjs', 'test/a.test.mjs'], 'sourceFiles 保留原字段并保序');
  assert.deepEqual(sourceFiles(null), []);
});
