#!/usr/bin/env node
/**
 * tests/test-dispatch-retry-policy.cjs —— 派活「重试」闸门/请求体回归
 *
 * 设计（docs 设计-派活v2 §4.2）：**只有 spawn 同步失败**
 * （state=failed 且 attempted=false）才允许安全重派；attempted=true 意味着任务
 * 可能已经跑过/正在写盘，重派就是双执行。UI 与 IPC 必须共用这一份判据。
 *
 * 本用例只加载纯函数策略模块，覆盖：可重试/不可重试/次数上限/禁用原因/请求体。
 *
 * 用法：node tests/test-dispatch-retry-policy.cjs
 * 退出码：0 = PASS，1 = FAIL
 */
'use strict';

const path = require('path');

const P = require(path.join(__dirname, '..', 'live-2d', 'js', 'core', 'dispatch-retry-policy.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}

console.log('派活「重试」策略回归');
console.log('');

// ── ① 可重试判定 ──────────────────────────────────────────────────────────
console.log('可重试判定（只有 failed + 明确 attempted=false）');
ok('null → 不可重试', P.canRetry(null) === false);
ok('非对象 → 不可重试', P.canRetry('x') === false && P.canRetry(42) === false);
ok('running → 不可重试', P.canRetry({ state: 'running', attempted: false, taskText: 'x' }) === false);
ok('done → 不可重试', P.canRetry({ state: 'done', attempted: false, taskText: 'x' }) === false);
ok('cancelled → 不可重试', P.canRetry({ state: 'cancelled', attempted: false, taskText: 'x' }) === false);
ok('unknown → 不可重试', P.canRetry({ state: 'unknown', attempted: false, taskText: 'x' }) === false);
ok('failed 但缺 attempted → 不可重试（保守）',
    P.canRetry({ state: 'failed', taskText: 'x' }) === false);
ok('failed 且 attempted=true → 不可重试（可能双执行）',
    P.canRetry({ state: 'failed', attempted: true, taskText: 'x' }) === false);
ok('failed 且 attempted=false 但正文为空 → 不可重试',
    P.canRetry({ state: 'failed', attempted: false, taskText: '   ' }) === false);
ok('failed + attempted=false + 有正文 → 可重试',
    P.canRetry({ state: 'failed', attempted: false, taskText: '写一个文件' }) === true);

// ── ② 禁用原因（不出现空按钮）─────────────────────────────────────────────
console.log('');
console.log('禁用原因');
ok('没有任务详情 → 说没有', /没有任务详情/.test(P.retryBlockedReason(null)));
ok('非 failed → 说只有失败能重试',
    /只有失败/.test(P.retryBlockedReason({ state: 'running', attempted: false, taskText: 'x' })));
ok('attempted=true → 说可能双执行',
    /双执行/.test(P.retryBlockedReason({ state: 'failed', attempted: true, taskText: 'x' })));
ok('attempted 缺失 → 说按可能执行过处理',
    /可能执行过/.test(P.retryBlockedReason({ state: 'failed', taskText: 'x' })));
ok('正文为空 → 说账本没有任务正文',
    /没有任务正文/.test(P.retryBlockedReason({ state: 'failed', attempted: false, taskText: '' })));
ok('可重试时没有禁用原因',
    P.retryBlockedReason({ state: 'failed', attempted: false, taskText: 'x' }) === '');

// ── ③ 一致性与次数 ────────────────────────────────────────────────────────
console.log('');
console.log('一致性与次数');
const matrix = [
    null,
    {},
    { state: 'done', attempted: false, taskText: 'x' },
    { state: 'failed', attempted: true, taskText: 'x' },
    { state: 'failed', attempted: false },
    { state: 'failed', attempted: false, taskText: 'x' },
];
ok('canRetry 与 retryBlockedReason 完全同源',
    matrix.every((t) => P.canRetry(t) === (P.retryBlockedReason(t) === '')));
ok('可重试次数没有隐藏上限（同一任务可多次判定）',
    [1, 2, 3, 10].every(() => P.canRetry({ state: 'failed', attempted: false, taskText: 'x' }) === true));
ok('重试 id 前缀是 ui-retry', /^ui-retry-/.test(P.makeRetryTaskId(1750000000000)));
ok('重试 id 可作文件名', /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(P.makeRetryTaskId()));
ok('同一毫秒生成的 id 也不相同', P.makeRetryTaskId(1750000000000) !== P.makeRetryTaskId(1750000000000));

// ── ④ 请求体 ──────────────────────────────────────────────────────────────
console.log('');
console.log('请求体');
const minimal = P.buildRetryBody({ taskText: '写一个文件' }, { taskId: 't-2' });
ok('最小体只有 task/taskId', Object.keys(minimal).sort().join(',') === 'task,taskId',
    Object.keys(minimal).join(','));
ok('最小体带上原任务正文', minimal.task === '写一个文件', minimal.task);
ok('最小体带上新任务 id', minimal.taskId === 't-2', minimal.taskId);
const full = P.buildRetryBody({
    taskText: '接着修',
    workspaceAlias: 'w',
    verifyCommand: 'npm test',
    timeoutMs: 9000,
    outcome: 'failed',
    state: 'failed',
}, { taskId: 't-3', requestId: 'req-3' });
ok('完整体带 requestId', full.requestId === 'req-3', JSON.stringify(full));
ok('完整体带 workspace', full.workspace === 'w');
ok('完整体带 verify', full.verify === 'npm test');
ok('完整体带 timeoutMs', full.timeoutMs === 9000);
ok('不把 outcome/state 等展示字段塞进请求体',
    full.outcome === undefined && full.state === undefined, JSON.stringify(full));
const zero = P.buildRetryBody({ taskText: 'x', timeoutMs: 0 }, { taskId: 't-4' });
ok('timeoutMs=0 不带（不猜）', zero.timeoutMs === undefined, JSON.stringify(zero));
const negative = P.buildRetryBody({ taskText: 'x', timeoutMs: -5 }, { taskId: 't-5' });
ok('负数 timeoutMs 不带', negative.timeoutMs === undefined, JSON.stringify(negative));
const noRequest = P.buildRetryBody({ taskText: 'x' }, { taskId: 't-6' });
ok('没有 requestId 时不造一个', noRequest.requestId === undefined, JSON.stringify(noRequest));

console.log('');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
