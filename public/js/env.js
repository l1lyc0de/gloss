// 跑在哪儿。
//
// 网页版由 server.js 托管，有 /api/sync；
// 打包成 APK 后页面由 WebViewAssetLoader 直接从安装包的 assets 里喂出来，
// 域名固定是下面这个，而且机器上没有任何服务器 ——
// 同步码、Service Worker、词典预下载在那边全都没有意义，得关掉。
//
// 判断放在这里单独一份，是为了让「哪些功能在单机版里不存在」只有一个出处。

export const NATIVE = location.hostname === 'appassets.androidplatform.net';
