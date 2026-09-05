// 跑在哪儿。
//
// 网页版由 server.js 托管，有 /api/sync；
// 打包成 APK 后页面由 WebViewAssetLoader 直接从安装包的 assets 里喂出来，
// 域名固定是下面这个，而且机器上没有任何服务器 ——
// 同步码、Service Worker、词典预下载在那边全都没有意义，得关掉。
//
// 判断放在这里单独一份，是为了让「哪些功能在单机版里不存在」只有一个出处。

export const NATIVE = location.hostname === 'appassets.androidplatform.net';

// 壳注入的只读桥（见 MainActivity 的 NativeBridge）。网页版下面没有这个对象，
// 两个值都是空串 —— 判断一律用「值是不是空」，不要去判断 GlossNative 在不在，
// 那样每处都得写一遍 typeof 检查。
const bridge = (typeof window !== 'undefined' && window.GlossNative) || null;
const ask = (fn) => {
  try { return (bridge && bridge[fn] && bridge[fn]()) || ''; } catch { return ''; }
};

/** APK 的 versionName。网页版里是空串。 */
export const NATIVE_VERSION = NATIVE ? ask('version') : '';

/**
 * 去哪儿看有没有新版。构建时从 android/site.properties 注入（那个文件不进仓库）。
 *
 * 空串就是「这个包没配」，调用方必须据此**整个不显示**入口 ——
 * 和「服务器上没放 APK 时网页版不露下载入口」是同一条规矩：
 * 不留一个点下去没反应的按钮。
 */
export const UPDATE_URL = NATIVE ? ask('updateUrl') : '';
