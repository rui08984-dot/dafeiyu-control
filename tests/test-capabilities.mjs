#!/usr/bin/env node
/**
 * tests/test-capabilities.mjs —— 功能注册表与自检
 *
 * 这张表的意义：把「开关在哪、默认值、改完是否即时生效、谁实现的」固定成一行，
 * 启动时和真实 config/插件清单对账，三类病（死开关/野键/假持久化）当场暴露。
 *
 * 本仓库只带控制层，不随附宿主实现文件（edge-tts/、asr/、js/voice/…）。
 * 所以 impl 自检分两段验：
 *   · 默认根（从 live-2d/js/core 往上 5 层）行为不变 —— 用「预期缺失集合」对账；
 *   · 传 implRoot 指向临时造好的宿主根时，impl-missing 必须归零 —— 证明可配置生效。
 */
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'live-2d', 'js', 'core');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const mod = require(path.join(CORE, 'capabilities.js'));
const { CAPABILITIES, auditCapabilities, renderCapabilityReport } = mod;

// ── ① 表结构 ──────────────────────────────────────────────────────────────
ok('声明数量 ≥ 30', CAPABILITIES.length >= 30, String(CAPABILITIES.length));
ok('每项都有 id/name/group/kind',
  CAPABILITIES.every((c) => c.id && c.name && c.group && c.kind), '');
ok('id 不重复', new Set(CAPABILITIES.map((c) => c.id)).size === CAPABILITIES.length);
ok('kind 只有 config/plugin/port',
  CAPABILITIES.every((c) => ['config', 'plugin', 'port'].includes(c.kind)));
ok('config 类必须带 key', CAPABILITIES.filter((c) => c.kind === 'config').every((c) => !!c.key));
ok('plugin 类必须带 key', CAPABILITIES.filter((c) => c.kind === 'plugin').every((c) => !!c.key));
ok('port 类必须带 port', CAPABILITIES.filter((c) => c.kind === 'port').every((c) => Number(c.port) > 0));
ok('有 hot 字段的项都标了', CAPABILITIES.filter((c) => 'hot' in c).length > 10,
  String(CAPABILITIES.filter((c) => 'hot' in c).length));

// ── ② 自检：缺键 ──────────────────────────────────────────────────────────
const r1 = auditCapabilities({ config: { tts: { enabled: true } }, enabledPlugins: [] });
const missing = r1.problems.filter((p) => p.kind === 'missing-key');
ok('能检测出缺失的配置键', missing.length > 0, missing.length + ' 条');
ok('soft 的缺键不报',
  !missing.some((p) => p.id === 'llm.intent_router'),
  'intent_router 标了 soft');
ok('非 soft 的缺键会报',
  missing.some((p) => p.id === 'perf.choreo_v1' || p.id === 'voice.tts'),
  'tts 在假 config 里存在，choreo 应该缺');

// ── ③ 自检：插件 ──────────────────────────────────────────────────────────
const r2 = auditCapabilities({ config: {}, enabledPlugins: [] });
const off = r2.problems.filter((p) => p.kind === 'plugin-off');
ok('声明默认开但不在启用列表 → 报', off.length > 0, off.length + ' 条');
const r3 = auditCapabilities({ config: {}, enabledPlugins: CAPABILITIES.filter((c) => c.kind === 'plugin').map((c) => c.key) });
ok('全部插件都在列表里 → 不报 plugin-off',
  r3.problems.filter((p) => p.kind === 'plugin-off').length === 0);
ok('已删除插件的声明不残留（core-memory-injector）',
  !CAPABILITIES.some((c) => c.id === 'memory.core_inject'),
  '2026-11-16 插件收敛后同步移除');

// ── ④ impl 自检：默认根行为不变 + implRoot 可配置 ────────────────────────
const implCaps = CAPABILITIES.filter((c) => c.impl);
const DEFAULT_ROOT = path.resolve(CORE, '..', '..', '..', '..', '..');
const expectedMissing = implCaps.filter((c) => {
  const fallback = path.join(CORE, '..', '..', c.impl);   // 旧代码的第二候选
  return !fs.existsSync(path.join(DEFAULT_ROOT, c.impl)) && !fs.existsSync(fallback);
}).map((c) => c.id).sort();
const defaultMissing = auditCapabilities({ config: {}, enabledPlugins: [] })
  .problems.filter((p) => p.kind === 'impl-missing').map((p) => p.id).sort();
ok('默认根仍是从 core 往上 5 层（预期缺失集合一致）',
  JSON.stringify(defaultMissing) === JSON.stringify(expectedMissing),
  '默认缺 ' + defaultMissing.length + ' 项 / 预期 ' + expectedMissing.length + ' 项');
ok('公开仓确实会报 impl-missing（不静默放过）', defaultMissing.length > 0, defaultMissing.length + ' 条');
ok('缺失明细指向 impl 相对路径',
  auditCapabilities({ config: {}, enabledPlugins: [] }).problems
    .filter((p) => p.kind === 'impl-missing').every((p) => /实现文件找不到：/.test(p.detail)));

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-root-'));
try {
  for (const cap of implCaps) {
    const p = path.join(fixture, cap.impl);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '// fixture\n', 'utf8');
  }
  const custom = auditCapabilities({ config: {}, enabledPlugins: [], implRoot: fixture });
  const customMissing = custom.problems.filter((p) => p.kind === 'impl-missing');
  ok('implRoot 指向完整宿主根 → impl-missing 归零', customMissing.length === 0,
    customMissing.map((p) => p.id).join(',') || '全命中');
  ok('自定义 root 覆盖默认 root（不是两边都找）',
    customMissing.length < defaultMissing.length,
    '默认缺 ' + defaultMissing.length + ' / 自定义缺 ' + customMissing.length);
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-empty-'));
  try {
    const empty = auditCapabilities({ config: {}, enabledPlugins: [], implRoot: emptyRoot });
    const emptyMissing = empty.problems.filter((p) => p.kind === 'impl-missing').map((p) => p.id);
    ok('空 implRoot 只保留旧代码的第二候选（不会凭空命中）',
      emptyMissing.length >= expectedMissing.length,
      '空根缺 ' + emptyMissing.length + ' 项');
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

// ── ⑤ 已知死键 ────────────────────────────────────────────────────────────
const r5 = auditCapabilities({
  config: { bert: { enabled: false }, rag: { enabled: true }, tools: { enabled: true } },
  enabledPlugins: [],
});
// bert.enabled 已于 2026-11-16 真正接线（ScreenshotManager 读它），所以不再是死键
ok('能识别已知死键', Array.isArray(r5.deadPresent) && r5.deadPresent.length >= 2,
  (r5.deadPresent || []).join(','));
ok('bert 已接线，不算死键', !(r5.deadPresent || []).includes('bert.enabled'));
ok('死键带原因说明', r5.deadPresent.every((k) => typeof r5.knownDead[k] === 'string' && r5.knownDead[k].length > 5));
ok('没配死键时不误报', (() => {
  const r = auditCapabilities({ config: {}, enabledPlugins: [] });
  return r.deadPresent.length === 0;
})());

// ── ⑤b 死键分「已标注 / 未标注」：_deprecated 里的不算待办 ──
const rAnnot = auditCapabilities({
  config: {
    bert: { enabled: false },     // 已接线，不该再出现在死键里
    rag: { enabled: true },
    _deprecated: { 'rag.enabled': '无消费者（实测）' },
  },
  enabledPlugins: [],
});
ok('bert.enabled 已接线 → 不再算死键', !rAnnot.deadPresent.includes('bert.enabled'),
  rAnnot.deadPresent.join(','));
ok('config._deprecated 里标注的进 deadAnnotated', rAnnot.deadAnnotated.includes('rag.enabled'),
  rAnnot.deadAnnotated.join(','));
ok('未标注的进 deadUnannotated', rAnnot.deadUnannotated.every((k) => k !== 'rag.enabled'),
  rAnnot.deadUnannotated.join(',') || '无');
ok('报告里已标注与未标注分开写', (() => {
  const t = renderCapabilityReport(rAnnot);
  return /已标注废弃/.test(t);
})());

// ── ⑥ 报告可读性 ──────────────────────────────────────────────────────────
const text = renderCapabilityReport(r1);
ok('报告含声明数', /声明 \d+ 项/.test(text));
ok('报告含问题条数', /问题 \d+ 条/.test(text));
ok('报告可单行打印（含换行）', text.includes('\n'));
ok('空问题时不输出问题明细', renderCapabilityReport({ declared: 1, problems: [], undeclared: [], deadPresent: [], knownDead: {} })
  .split('\n').length === 1);

// ── ⑦ 自洽：按表里的默认值造一份完整 config，自检应为 0 问题 ──────────────
function setPath(obj, dotted, value) {
  const keys = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}
const synthetic = {};
for (const cap of CAPABILITIES) {
  if (cap.kind === 'config' && cap.key && cap.default !== undefined) setPath(synthetic, cap.key, cap.default);
}
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-self-'));
try {
  for (const cap of implCaps) {
    const p = path.join(fixtureRoot, cap.impl);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '// fixture\n', 'utf8');
  }
  const rSelf = auditCapabilities({
    config: synthetic,
    enabledPlugins: CAPABILITIES.filter((c) => c.kind === 'plugin').map((c) => c.key),
    implRoot: fixtureRoot,
  });
  ok('按注册表默认值自洽时 0 问题', rSelf.problems.length === 0,
    rSelf.problems.map((p) => p.id + ':' + p.kind).join(',') || '全过');
  ok('自洽时声明数等于表长度', rSelf.declared === CAPABILITIES.length, String(rSelf.declared));
  ok('自洽报告只有一行汇总（无问题时）', renderCapabilityReport(rSelf).split('\n').length === 1);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('');
console.log(`  功能注册表：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
