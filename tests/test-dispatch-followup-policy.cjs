#!/usr/bin/env node
/**
 * tests/test-dispatch-followup-policy.cjs —— 「继续聊」闸门/文案/接线回归
 *
 * 病根：派活详情以前只在 running/stale 时给取消、失败时给重试；续聊端点
 * POST 8103 /dispatch/followup 已就绪，但 UI 没有任何入口。这里锁住四件事：
 *   ① 闸门与后端 followupDispatchTask 同源：终态(done/failed/cancelled)+sessionId 才允许；
 *      running/cancelling/unknown 一律拦住（unknown 可能还在跑，续聊会双执行）；
 *   ② 失配/回退的文案必须是「没接上原会话，已带上下文重开」，不能只报成功；
 *   ③ 请求体只带 {taskId, task, newTaskId}，空正文/超长在本地就拒绝；
 *   ④ 接线没断：策略是同一份（CJS + 浏览器全局）、插件工具面、账本终态口径一致。
 *
 * 只读文件 + 用宿主桩加载 dispatch 插件；不联网、不写真实数据目录。
 *
 * 用法：node tests/test-dispatch-followup-policy.cjs
 * 退出码：0 = PASS，1 = FAIL
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'live-2d');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

const P = require(path.join(APP, 'js', 'core', 'dispatch-followup-policy.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}

console.log('派活「继续聊」策略回归');
console.log('');

// ── ① 闸门 ────────────────────────────────────────────────────────────────
console.log('闸门（与 8103 followupDispatchTask 对齐）');
ok('done + sessionId → 允许', P.isFollowupEligible({ state: 'done', sessionId: 'sess-1' }));
ok('failed + sessionId → 允许', P.isFollowupEligible({ state: 'failed', sessionId: 'sess-1' }));
ok('cancelled + sessionId → 允许（后端也把 cancelled 当终态）',
    P.isFollowupEligible({ state: 'cancelled', sessionId: 'sess-1' }));
ok('done_unproven 是 outcome，state=done → 允许',
    P.isFollowupEligible({ state: 'done', outcome: 'done_unproven', sessionId: 'sess-1' }));
ok('done 无 sessionId → 拒绝', !P.isFollowupEligible({ state: 'done', sessionId: '' }));
ok('done 无 sessionId 的原因提到会话', /会话 id/.test(P.followupBlockedReason({ state: 'done' })),
    P.followupBlockedReason({ state: 'done' }));
ok('running → 拒绝', !P.isFollowupEligible({ state: 'running', sessionId: 'sess-1' }));
ok('running 的原因提到还在跑', /还在跑/.test(P.followupBlockedReason({ state: 'running', sessionId: 's' })));
ok('cancelling → 拒绝', !P.isFollowupEligible({ state: 'cancelling', sessionId: 'sess-1' }));
ok('unknown → 拒绝', !P.isFollowupEligible({ state: 'unknown', sessionId: 'sess-1' }));
ok('unknown 的原因提到结果未知', /结果未知/.test(P.followupBlockedReason({ state: 'unknown', sessionId: 's' })));
ok('空任务 → 拒绝', !P.isFollowupEligible(null) && !P.isFollowupEligible({}));
ok('终态白名单只有三个', P.TERMINAL_STATES.join(',') === 'done,failed,cancelled', P.TERMINAL_STATES.join(','));
// 与后端唯一真源对比：账本 TERMINAL_STATES 改了而这里没跟 → 立刻红
const ledgerSrc = read('petbridge/dispatch-ledger.mjs');
const backendTerm = (() => {
    const m = /TERMINAL_STATES = Object\.freeze\(\[([^\]]+)\]\)/.exec(ledgerSrc);
    return m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
})();
ok('终态白名单与 dispatch-ledger 同源',
    backendTerm.length === 3 && P.TERMINAL_STATES.join(',') === backendTerm.join(','),
    'UI=' + P.TERMINAL_STATES.join(',') + ' 后端=' + backendTerm.join(','));

// ── ② 请求体 ──────────────────────────────────────────────────────────────
console.log('');
console.log('请求体');
const built = P.buildFollowupRequest('task-1', '  接着修测试  ', 'ui-followup-x');
ok('合法请求裁剪正文', built.ok && built.body.task === '接着修测试', JSON.stringify(built.body));
ok('只带三个键', built.ok && Object.keys(built.body).sort().join(',') === 'newTaskId,task,taskId',
    built.ok ? Object.keys(built.body).join(',') : 'not ok');
ok('空正文 → empty_task', P.buildFollowupRequest('t', '   ', 'n').error === 'empty_task');
ok('缺父 id → missing_task_id', P.buildFollowupRequest('', 'x', 'n').error === 'missing_task_id');
ok('超 20000 字 → task_too_long', P.buildFollowupRequest('t', 'x'.repeat(20001), 'n').error === 'task_too_long');
const genId = P.makeFollowupTaskId(1750000000000, 0.123456);
ok('生成的子任务 id 带 ui-followup 前缀且可作文件名',
    /^ui-followup-[a-z0-9]+-[a-z0-9]{1,4}$/.test(genId), genId);
ok('默认生成的 id 也不同', P.makeFollowupTaskId() !== P.makeFollowupTaskId());

// ── ③ 回执文案（失配必须明说）────────────────────────────────────────────
console.log('');
console.log('回执文案');
const reused = P.describeFollowupOutcome({ state: 'done', sessionReused: true });
ok('接上会话 → 已续聊（会话接上了）', reused.level === 'ok' && reused.message.includes('会话接上了'), reused.message);
const mismatch = P.describeFollowupOutcome({ state: 'done', sessionMismatch: true });
ok('sessionMismatch → 没接上原会话，已带上下文重开',
    mismatch.level === 'warn' && mismatch.message.includes('没接上原会话，已带上下文重开'), mismatch.message);
const fallback = P.describeFollowupOutcome({ state: 'done', fallback: true });
ok('fallback → 同一句失配文案', fallback.message.includes('没接上原会话，已带上下文重开'), fallback.message);
const fbFailed = P.describeFollowupOutcome({ state: 'failed', fallback: true, error: 'verify 失败' });
ok('回退后仍失败 → 先说没接上，再说失败', fbFailed.level === 'error'
    && fbFailed.message.includes('没接上原会话，已带上下文重开')
    && fbFailed.message.includes('verify 失败'), fbFailed.message);
const spawnFailed = P.describeFollowupOutcome({ state: 'failed', attempted: false, error: 'spawn ENOENT' });
ok('启动失败 → 续聊没启动', spawnFailed.level === 'error' && spawnFailed.message.includes('续聊没启动'), spawnFailed.message);
const unknown = P.describeFollowupOutcome({ state: 'unknown' });
ok('unknown → 结果未知/别重复', unknown.level === 'warn' && /结果未知/.test(unknown.message), unknown.message);
const noSessionBack = P.describeFollowupOutcome({ state: 'done' });
ok('完成但没回传 session → 如实说没确认', noSessionBack.message.includes('没能确认接上原会话'), noSessionBack.message);
const pending = P.describeFollowupPending('ui-followup-abc');
ok('8s 未结束 → 已派出 + 子任务 id', pending.level === 'ok'
    && pending.message.includes('已派出续聊') && pending.message.includes('ui-followup-abc'), pending.message);

// ── ④ 接线（静态 + 宿主桩）────────────────────────────────────────────────
console.log('');
console.log('接线');
const pluginSrc = read('plugins/community/dispatch/index.js');
const policySrc = read('js/core/dispatch-followup-policy.js');
const liveMatch = /LIVE_STATES = Object\.freeze\(\[([^\]]+)\]\)/.exec(ledgerSrc);
const backendLive = liveMatch ? liveMatch[1] : '';
ok('dispatch 插件存在且提供 _followup', pluginSrc.includes('async _followup('));
ok('工具面注册 dispatch_followup', /name:\s*'dispatch_followup'/.test(pluginSrc));
ok('插件只认三个终态', /\[['"]done['"],\s*['"]failed['"],\s*['"]cancelled['"]\]/.test(pluginSrc));
ok('插件要求父任务有 sessionId', /parent\.sessionId/.test(pluginSrc));
ok('插件 POST /dispatch/followup', pluginSrc.includes("path: '/dispatch/followup'"));
ok('插件预分配并透传 newTaskId', /newTaskId:\s*childId/.test(pluginSrc));
ok('插件有 10 分钟续聊刹车', /10 \* 60 \* 1000/.test(pluginSrc) && pluginSrc.includes('_recentFollowups'));
ok('账本把 unknown 列为非终态（live）', backendLive.includes('unknown'));
ok('策略同一份实现可被浏览器直接加载（UMD）',
    policySrc.includes('module.exports = api') && policySrc.includes('root.DispatchFollowupPolicy = api'));

// 宿主桩：只验闸门在插件入口真的生效（不触发 HTTP）
function loadPluginWithStub() {
    const origLoad = Module._load;
    Module._load = function (request) {
        if (request === 'electron') return { clipboard: null, shell: null, ipcRenderer: null };
        if (/plugin-base\.js$/.test(String(request))) {
            return { Plugin: class Plugin { constructor(meta, context) { this.meta = meta; this.context = context; } } };
        }
        return origLoad.apply(this, arguments);
    };
    try {
        return require(path.join(APP, 'plugins', 'community', 'dispatch', 'index.js'));
    } finally {
        Module._load = origLoad;
    }
}

(async () => {
    let DispatchPlugin = null;
    let loadError = null;
    try { DispatchPlugin = loadPluginWithStub(); } catch (e) { loadError = e; }
    ok('dispatch 插件可被宿主桩加载', typeof DispatchPlugin === 'function', loadError ? String(loadError.message) : '');

    if (typeof DispatchPlugin === 'function') {
        const logs = [];
        const plugin = new DispatchPlugin({ name: 'dispatch' }, {
            log: (lvl, msg) => logs.push(lvl + ':' + msg),
            getPluginFileConfig: () => ({ control_port: 8103, timeout_seconds: 900, max_concurrent: 2 }),
        });
        await plugin.onInit();
        const tools = plugin.getTools().map((t) => t.function.name);
        ok('onInit 后工具面含 dispatch_followup', tools.includes('dispatch_followup'), tools.join(','));

        let out = JSON.parse(await plugin._followup({ task: '接着干' }));
        ok('缺 taskId → 拒绝并说清要哪个 id', out.ok === false && /任务 id/.test(String(out.error)), String(out.error));

        let threw = '';
        try { await plugin._followup({ taskId: 't', task: 'x' }); } catch (e) { threw = String((e && e.message) || e); }
        ok('正文太短 → 本地抛错', /说清楚/.test(threw), threw);

        plugin._ledgerV2Enabled = () => false;
        out = JSON.parse(await plugin._followup({ taskId: 't', task: '接着修测试' }));
        ok('ledger_v2=false → 明确拒绝', out.ok === false && /ledger_v2/.test(String(out.error)), String(out.error));

        plugin._ledgerV2Enabled = () => true;
        plugin._ledgerGet = async () => ({ status: 200, json: { ok: true, task: { state: 'running', sessionId: 's' } } });
        out = JSON.parse(await plugin._followup({ taskId: 't', task: '接着修测试' }));
        ok('父任务 running → 拒绝', out.ok === false && /还没结束/.test(String(out.error)), String(out.error));

        plugin._ledgerGet = async () => ({ status: 200, json: { ok: true, task: { state: 'done' } } });
        out = JSON.parse(await plugin._followup({ taskId: 't', task: '接着修测试' }));
        ok('父任务无 sessionId → 拒绝', out.ok === false && /会话 id/.test(String(out.error)), String(out.error));

        let dispatched = null;
        plugin._ledgerGet = async () => ({ status: 200, json: { ok: true, task: { state: 'done', sessionId: 's' } } });
        plugin._runFollowup = (childId, parentId, text) => { dispatched = { childId, parentId, text }; return Promise.resolve(); };
        out = JSON.parse(await plugin._followup({ taskId: 't', task: '接着修测试' }));
        ok('终态 + sessionId → 放行并预分配子任务 id',
            out.ok === true && !!out.id && dispatched && dispatched.parentId === 't', JSON.stringify(out));
        ok('放行回执带 parentId 与说明', out.parentId === 't' && /后台跑/.test(String(out.note)), JSON.stringify(out));
    }

    console.log('');
    console.log(`结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('FATAL ' + (e && e.stack || e));
    process.exit(1);
});
