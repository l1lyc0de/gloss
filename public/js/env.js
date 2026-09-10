// 跑在哪儿。
//
// 网页版由 server.js 托管，有 /api/sync；
// 打包成 App 之后页面由壳直接从安装包里喂出来，机器上没有任何服务器 ——
// 同步码、Service Worker、词典预下载在那边全都没有意义，得关掉。
//
// 判断放在这里单独一份，是为了让「哪些功能在单机版里不存在」只有一个出处。
// 两个壳各有各的来源，但对网页来说绝大多数时候是同一件事，所以主开关只有 NATIVE 一个；
// PLATFORM 是给少数**两个壳确实不一样**的地方用的（目前只有「怎么拿到新版」那一句：
// 安卓是自己分发的安装包，iOS 归 App Store 管），别拿它去分叉功能。
//
//   安卓  WebViewAssetLoader 固定的这个域名
//   iOS   壳注册的自定义 scheme。这边认的是 protocol 而不是域名 ——
//         http/https 是 WebKit 的保留字，WKURLSchemeHandler 注册上去会直接抛，
//         所以 iOS 那边根本没有一个「像样的域名」可认。

export const PLATFORM =
  location.hostname === 'appassets.androidplatform.net' ? 'android'
  : location.protocol === 'gloss-app:' ? 'ios'
  : '';

/** 在不在壳里。绝大多数地方只关心这个，不关心是哪个壳。 */
export const NATIVE = PLATFORM !== '';

// 壳注入的只读桥（安卓见 MainActivity 的 NativeBridge，iOS 见 ReaderViewController
// 的 bridgeScript）。网页版下面没有这个对象，
// 两个值都是空串 —— 判断一律用「值是不是空」，不要去判断 GlossNative 在不在，
// 那样每处都得写一遍 typeof 检查。
const bridge = (typeof window !== 'undefined' && window.GlossNative) || null;
const ask = (fn) => {
  try { return (bridge && bridge[fn] && bridge[fn]()) || ''; } catch { return ''; }
};

/** 壳报的版本号（安卓 versionName / iOS CFBundleShortVersionString）。网页版里是空串。 */
export const NATIVE_VERSION = NATIVE ? ask('version') : '';

/**
 * 去哪儿看有没有新版。构建时注入，站点地址属于部署信息，两边那个文件都不进仓库
 * （安卓 android/site.properties，iOS ios/site.xcconfig）。
 *
 * 空串就是「这个包没配」，调用方必须据此**整个不显示**入口 ——
 * 和「服务器上没放 APK 时网页版不露下载入口」是同一条规矩：
 * 不留一个点下去没反应的按钮。
 */
export const UPDATE_URL = NATIVE ? ask('updateUrl') : '';
