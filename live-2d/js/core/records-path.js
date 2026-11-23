// js/core/records-path.js —— 记录目录的唯一真源。
//
// 背景：这里曾经分裂过一次 —— 插件按 __dirname 往上 3 层算到了 live-2d/,
// 而核心代码（js/ai/*）往上 3 层算到了宿主应用根，于是用户画像和对话历史被劈成两半，
// 「核心用户记忆.txt」更是从来没被创建过。
//
// 约定：**唯一真源是 <宿主应用根>/<数据目录名>**（与 config.json 的 ../<数据目录名> 一致，
// 也是既有对话历史所在处）。数据目录名用 `PET_DATA_DIR_NAME`，缺省 `data`。
// 任何要读写记录目录的地方都必须走这里。
//
//   const { RECORDS_DIR, recordFile } = require('./records-path');
//   recordFile('核心用户记忆.txt')
const path = require('path');

// __dirname = live-2d/js/core  →  往上 3 层 = 宿主应用根
const APP_ROOT = path.join(__dirname, '..', '..', '..');
// 数据目录名（2026-11-23 公开化）：只取最后一段，防止 `../` 把数据写到根外。
const DATA_DIR_NAME = (() => {
  const raw = String(process.env.PET_DATA_DIR_NAME || 'data').trim();
  const last = raw.split(/[\\/]+/).filter(Boolean).pop() || '';
  if (!last || last === '.' || last === '..') return 'data';
  return last.replace(/[<>:"|?*\u0000-\u001f]/g, '') || 'data';
})();
// PET_DATA_ROOT（2026-11-21 A2）：测试隔离用的数据根。设了就把「记录目录」指到该目录下，
// **不设时是 <宿主应用根>/<数据目录名>**（APP_ROOT 也不动 —— 那是程序位置不是数据位置）。
// 动机：测试对真实文件「备份-还原」时宿主正在同时写同一批文件，会偶发 EPERM / 互相覆盖；
// 改成写临时目录后测试与宿主彻底不相交（验收：连跑 10 次真实文件 0 字节变化）。
const RECORDS_DIR = process.env.PET_DATA_ROOT
  ? path.join(path.resolve(process.env.PET_DATA_ROOT), DATA_DIR_NAME)
  : path.join(APP_ROOT, DATA_DIR_NAME);

function recordFile(name) {
  return path.join(RECORDS_DIR, name);
}

module.exports = { APP_ROOT, DATA_DIR_NAME, RECORDS_DIR, recordFile };