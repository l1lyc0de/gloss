// 零散的小工具：DOM、转义、提示、朗读。

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function relTime(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}

export function fmtSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

let toastT;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), 1900);
}

/** 转菊花。progress 传 0..1 时显示进度条，传 null 只转圈。 */
export const busy = {
  show(msg, progress) {
    const box = $('#busy');
    $('.busymsg', box).textContent = msg;
    const bar = $('.busybar', box);
    if (progress == null) bar.classList.remove('on');
    else {
      bar.classList.add('on');
      $('i', bar).style.width = Math.round(progress * 100) + '%';
    }
    box.classList.add('on');
  },
  hide() { $('#busy').classList.remove('on'); },
};

/* ---------- 朗读 ---------- */
let VOICE = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  VOICE = vs.find((v) => /Samantha|US/i.test(v.name + v.lang)) || vs[0] || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
} else {
  // Android WebView 根本没有 Web Speech API。喇叭按钮由 CSS 一并藏掉 ——
  // 摆一个按下去只会道歉的按钮，比没有这个按钮更差。
  document.documentElement.classList.add('no-tts');
}
export function speak(text, rate) {
  // 不支持就安静地什么都不做：按钮已经不在了，而复习卡「显示释义」会自动念一次，
  // 在那儿每翻一张弹一次「不支持」纯粹是噪音。
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text).replace(/\s+/g, ' '));
  u.lang = 'en-US';
  if (VOICE) u.voice = VOICE;
  u.rate = rate || 0.92;
  speechSynthesis.speak(u);
}

export async function copyText(str) {
  try {
    await navigator.clipboard.writeText(str);
    toast('已复制');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = str;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch { toast('复制失败，请手动选中'); }
    ta.remove();
  }
}

/** 有并发上限的 map，用来批量抓词典分片，别一口气开几百个请求。 */
export async function pMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 让出一帧，长任务里定期调用，免得页面卡住不响应。 */
export const yieldFrame = () => new Promise((r) => setTimeout(r, 0));
