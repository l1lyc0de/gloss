// 状态与持久化。
//
// 分工是产品构想里定死的：**书可以丢，进度不能丢。**
//   书正文        → IndexedDB（大，丢了重新导入一次就行，原文件还在他手机上）
//   进度 + 生词本 → localStorage + 自动同步到服务器（丢了人就不读了）
//
// iOS Safari 在存储紧张时会清掉网页的 IndexedDB，这正是进度必须走服务器的理由。

import { today, toast } from './util.js';
import { NATIVE } from './env.js';

const KEY = 'gloss_state_v1';
const SYNC_KEY = 'gloss_sync_code';
const SYNC_RE = /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/;

function blank() {
  return {
    v: 1,
    updatedAt: 0,
    books: {},     // id -> {title, author, kind, n, words, addedAt, cur, read:{}, learned:{}}
    vocab: {},     // word -> {ts, due, lvl, src, book, sec}
    days: {},      // 'YYYY-MM-DD' -> 1
    nrev: 0,
    settings: { fs: 18, markHard: true, level: 'cet4', levelSet: false },
  };
}

export let S = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const s = JSON.parse(raw);
    return Object.assign(blank(), s, { settings: Object.assign(blank().settings, s.settings || {}) });
  } catch {
    return blank();
  }
}

function persistLocal() {
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
  } catch {
    toast('本地存储写不进去了，可能是空间满了');
  }
}

export function save() {
  S.updatedAt = Date.now();
  persistLocal();
  schedulePush();
}

/** 只要今天动过就算一天，用来算连续天数。 */
export function touchDay() {
  if (!S.days[today()]) { S.days[today()] = 1; save(); }
}

export function streak() {
  let n = 0;
  const d = new Date();
  for (;;) {
    const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (S.days[k]) { n++; d.setDate(d.getDate() - 1); }
    else if (n === 0 && k === today()) { d.setDate(d.getDate() - 1); }  // 今天还没读，不算断
    else break;
  }
  return n;
}

export function replaceState(next) {
  S = Object.assign(blank(), next, { settings: Object.assign(blank().settings, next.settings || {}) });
  persistLocal();
}

/* ---------- 免密同步码 ---------- */
// 没有账号密码，也没有登录态：每台设备生成一串不可猜测的码，
// 换设备时输入这串码就能取回进度和生词本。服务器只按码存一段 JSON。

const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉了 I/O/0/1 这些抄起来会认错的
function genCode() {
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  const s = [...buf].map((b) => A[b % A.length]).join('');
  return s.slice(0, 5) + '-' + s.slice(5);
}

export let SYNC_CODE = localStorage.getItem(SYNC_KEY) || '';
if (!SYNC_RE.test(SYNC_CODE)) {
  SYNC_CODE = genCode();
  localStorage.setItem(SYNC_KEY, SYNC_CODE);
}

export const syncStatus = { state: 'idle', at: 0 };
let onSyncChange = () => {};
export function onSync(fn) { onSyncChange = fn; }

let pushT = null;
let dirty = false;

function schedulePush() {
  dirty = true;
  clearTimeout(pushT);
  pushT = setTimeout(doPush, 1500);   // 防抖：连点十个词也只推一次
}

/** 立刻推，不等防抖。页面要被关掉/切走的时候用。 */
export function pushNow() {
  if (!dirty) return Promise.resolve();
  clearTimeout(pushT);
  return doPush();
}

async function doPush() {
  if (NATIVE) return;
  syncStatus.state = 'syncing';
  onSyncChange();
  try {
    const r = await fetch('/api/sync/' + encodeURIComponent(SYNC_CODE), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(S),
    });
    if (r.ok) { syncStatus.state = 'ok'; syncStatus.at = Date.now(); dirty = false; }
    else syncStatus.state = 'offline';
  } catch {
    syncStatus.state = 'offline';   // 同步失败绝不影响本地阅读，联网后自动重试
  }
  onSyncChange();
}

// 手机上「关掉页面」往往不触发 unload，只有 visibilitychange 靠得住。
// 不在这里补一刀的话，最后 1.5 秒内攒的进度会随着切走一起丢。
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pushNow();
  });
  window.addEventListener('pagehide', () => pushNow());
}

export async function pullSync(code, { force } = {}) {
  if (NATIVE) return { ok: false };
  try {
    const r = await fetch('/api/sync/' + encodeURIComponent(code));
    const j = await r.json();
    if (!j.found) return { ok: true, found: false };
    // 合并策略简单粗暴：谁的 updatedAt 新就用谁的
    const remoteAt = j.data.updatedAt || 0;
    if (force || remoteAt > (S.updatedAt || 0)) {
      replaceState(j.data);
      return { ok: true, found: true, applied: true, remoteAt };
    }
    return { ok: true, found: true, applied: false, remoteAt };
  } catch {
    return { ok: false, found: false };
  }
}

export function setSyncCode(code) {
  SYNC_CODE = code;
  localStorage.setItem(SYNC_KEY, code);
}

export async function initSync() {
  if (NATIVE) return;            // 单机版：进度只在 localStorage，靠「手动备份」那一块换设备
  const r = await pullSync(SYNC_CODE);
  if (!r.ok) syncStatus.state = 'offline';
  else if (r.found) {
    // 「已备份」只能由服务器上确实存着东西来支撑。
    // 光是 GET 成功什么都不说明 —— 那只证明网通，不证明数据在。
    syncStatus.state = 'ok';
    syncStatus.at = r.remoteAt || Date.now();
  } else {
    syncStatus.state = 'idle';
  }
  onSyncChange();
  if (r.ok && !r.found && S.updatedAt) doPush();   // 本地有数据、服务器没有 → 先推一份上去
}

export { SYNC_RE };
