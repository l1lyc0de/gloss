// Gloss 本地服务器 —— 零依赖，`node gloss/server.js` 就能跑。
//
// 只做两件事，和产品构想里写的一样：
//   1. 托管静态文件（应用本身 + 词典分片）
//   2. 免密同步码接口（进度和生词本那几 KB 的 JSON）
//   3. 安卓安装包的下载入口（如果 download/ 里放了一个的话）
//
// 书的正文永远不经过这里。用户选的文件由浏览器的 File API 直接读，
// 解析、清洗、存储全在本地完成 —— 服务器不碰用户的书，这是产品的前提，
// 不是可选项。
//
// 用法：
//   node gloss/server.js            # 默认 http://localhost:5173
//   PORT=8080 node gloss/server.js
//   HOST=0.0.0.0 node gloss/server.js   # 手机在同一 Wi-Fi 下访问

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'sync-data');

// APK 故意**不**放在 public/ 下面。public/ 会被整个打进 APK 的 assets，
// 安装包放进去就等于让它再装一份自己，体积当场翻倍。
// 所以单开一个目录，只有下面那两条路由摸得到它。
const DOWNLOAD_DIR = path.join(__dirname, 'download');
const APK_FILE = 'gloss.apk';
const MAX_BODY = 256 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
};

// 同步码只允许「大写字母数字-大写字母数字」，直接当文件名用是安全的
// （这个正则已经排除了 . / \ 等任何能穿越路径的字符）。
const CODE_RE = /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/;

// 每 IP 每分钟 120 次，够一台设备防抖同步用很多倍
const hits = new Map();
function clientIp(req) {
  const cloudflareIp = req.headers['cf-connecting-ip'];
  if (typeof cloudflareIp === 'string' && cloudflareIp) return cloudflareIp;
  return req.socket.remoteAddress || '?';
}

function rateLimited(ip) {
  const now = Date.now();
  const win = Math.floor(now / 60000);
  const rec = hits.get(ip);
  if (!rec || rec.win !== win) {
    hits.set(ip, { win, n: 1 });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  rec.n += 1;
  return rec.n > 120;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleSync(req, res, code) {
  if (!CODE_RE.test(code)) return json(res, 400, { error: 'bad_code' });
  const file = path.join(DATA_DIR, code + '.json');

  if (req.method === 'GET') {
    fs.readFile(file, 'utf8', (err, raw) => {
      if (err) return json(res, 200, { found: false });
      try {
        json(res, 200, { found: true, data: JSON.parse(raw) });
      } catch {
        json(res, 200, { found: false });
      }
    });
    return;
  }

  if (req.method === 'PUT') {
    let buf;
    try {
      buf = await readBody(req, MAX_BODY);
    } catch {
      return json(res, 413, { error: 'too_large' });
    }
    let body;
    try {
      body = JSON.parse(buf.toString('utf8'));
    } catch {
      return json(res, 400, { error: 'bad_json' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json(res, 400, { error: 'bad_body' });
    }
    if (typeof body.updatedAt !== 'number') {
      return json(res, 400, { error: 'missing_updatedAt' });
    }
    // 先写临时文件再 rename，避免写到一半断电留下半个 JSON
    const tmp = file + '.tmp' + process.pid;
    fs.writeFile(tmp, JSON.stringify(body), (err) => {
      if (err) return json(res, 500, { error: 'write_failed' });
      fs.rename(tmp, file, (err2) =>
        err2 ? json(res, 500, { error: 'write_failed' }) : json(res, 200, { ok: true })
      );
    });
    return;
  }

  json(res, 405, { error: 'method_not_allowed' });
}

/* ---------- 安卓安装包 ---------- */

/** 有没有可下的包，以及它是哪一版。没有就老实说没有，前端据此决定要不要露出入口。 */
function apkMeta() {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(DOWNLOAD_DIR, 'gloss.json'), 'utf8'));
    const st = fs.statSync(path.join(DOWNLOAD_DIR, APK_FILE));
    return { available: true, version: meta.version, bytes: st.size, builtAt: meta.builtAt, sha256: meta.sha256 };
  } catch {
    return { available: false };
  }
}

function serveApk(req, res) {
  const file = path.join(DOWNLOAD_DIR, APK_FILE);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('还没有构建安装包，见 README 的「安卓 APK」一节');
    }
    res.writeHead(200, {
      'content-type': MIME['.apk'],
      'content-length': st.size,
      // 带上文件名，否则有些浏览器会存成 "gloss.apk.zip" 或者干脆当网页打开
      'content-disposition': `attachment; filename="${APK_FILE}"`,
      // 换了新包必须立刻拿到新的，11 MB 的东西被缓存住了很难自查
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel.endsWith('/')) rel += 'index.html';
  // path.normalize 之后再确认还在 PUBLIC_DIR 里面，挡住 ../ 穿越
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return json(res, 403, { error: 'forbidden' });
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    const ext = path.extname(target).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      // 本地开发要能改一行就刷新看到，所以应用代码一律不缓存；
      // 词典分片是内容不变的静态资源，交给浏览器长缓存。
      'cache-control': rel.startsWith('/dict/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    res.writeHead(200, headers);
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    const ip = clientIp(req);
    if (rateLimited(ip)) return json(res, 429, { error: 'rate_limited' });
    if (p === '/api/health') return json(res, 200, { ok: true, time: Date.now() });
    if (p === '/api/apk') return json(res, 200, apkMeta());
    const m = p.match(/^\/api\/sync\/([^/]+)$/);
    if (m) return handleSync(req, res, m[1]);
    return json(res, 404, { error: 'not_found' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: 'method_not_allowed' });
  }
  if (p === '/download/' + APK_FILE) return serveApk(req, res);
  // 下载页。/download 和 /download/ 都认 —— 这个地址是要写给人看、发给人点的，
  // 差一个斜杠就 404 太蠢了。安装包在 /download/gloss.apk，上面那行先接走了。
  if (p === '/download' || p === '/download/') return serveStatic(req, res, '/download.html');
  serveStatic(req, res, p === '/' ? '/index.html' : p);
});

server.listen(PORT, HOST, () => {
  console.log(`Gloss 已启动 → http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal) {
          console.log(`  同一 Wi-Fi 下的手机 → http://${ni.address}:${PORT}`);
        }
      }
    }
  }
  console.log(`同步数据目录：${DATA_DIR}`);
});
