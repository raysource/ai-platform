/* i18n 三语完整性 + 流水线阶段名（服务端只存中文名，界面按阶段 id 翻译） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const i18n = await import('../public/i18n.mjs');
const harness = await import('../harness.mjs');

const CODES = i18n.LANGS.map(l => l.code);
const STAGE_IDS = harness.STAGES.map(s => s.id);

test('每个键都有中/英/日三条非空文案', () => {
  const bad = i18n.audit();
  assert.deepEqual(bad, [], `三语不齐：${bad.slice(0, 5).join('；')}`);
  assert.ok(i18n.KEYS.length > 300, `词条数 ${i18n.KEYS.length}`);
});

test('8 个阶段名都有三语，且不重复、不是键名本身', () => {
  assert.equal(STAGE_IDS.length, 8);
  for (const code of CODES) {
    i18n.setLang(code);
    const names = STAGE_IDS.map(id => {
      const k = `stage.${id}`;
      assert.ok(i18n.has(k), `${code} 缺词条 ${k}`);
      const v = i18n.t(k);
      assert.notEqual(v, k, `${code} 的 ${k} 没翻译`);
      assert.ok(v.trim().length > 0, `${code} 的 ${k} 是空串`);
      return v;
    });
    assert.equal(new Set(names).size, 8, `${code} 有阶段名重复：${names.join(' / ')}`);
  }
  i18n.setLang('zh');
  assert.equal(i18n.t('stage.requirements'), '需求分析');
  i18n.setLang('en');
  assert.equal(i18n.t('stage.development'), 'Module development');
  i18n.setLang('ja');
  assert.equal(i18n.t('stage.operations'), '運用');
  i18n.setLang('zh');
});

test('阶段名与服务端阶段一一对应（id 不漂移）', () => {
  for (const s of harness.STAGES) assert.ok(i18n.has(`stage.${s.id}`), `服务端新加了阶段「${s.id}」→ 记得补 stage.${s.id} 三语文案`);
});
