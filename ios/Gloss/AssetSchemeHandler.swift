// 从 App 包里直接读网页资源，自己报 MIME。
// 对应安卓那边的 AssetsHandler，包里 public/ 的根就是仓库的 gloss/public。

import Foundation
import WebKit

final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {

    // 和 server.js、MainActivity 里那两张表一一对应。必须自己报 MIME：
    // .mjs（pdf.js 那两个文件）猜不出来就会退成 text/plain，
    // 而模块脚本的 MIME 不对，WebKit 是直接拒绝执行的 —— PDF 导入会整个哑掉。
    private static let mime: [String: String] = [
        "html": "text/html",
        "js": "text/javascript",
        "mjs": "text/javascript",
        "css": "text/css",
        "json": "application/json",
        "webmanifest": "application/manifest+json",
        "svg": "image/svg+xml",
        "png": "image/png",
        "ico": "image/x-icon",
        "woff2": "font/woff2",
        "map": "application/json",
    ]

    /// 包里的 public/。取不到就一律 404 —— 那说明打包时资源没进去，
    /// 与其让页面半死不活，不如让第一个请求就失败得明明白白。
    private let root: URL? = Bundle.main.url(forResource: "public", withExtension: nil)

    private let io = DispatchQueue(label: "space.lilyceng.gloss.assets",
                                   qos: .userInitiated, attributes: .concurrent)

    // 停掉的 task 再回调一次就是 crash，而且这个页面一屏会打几十个请求
    // （648 个词典分片按需读），撞上的概率不是理论值。所以记一份还活着的名单。
    private var live = Set<ObjectIdentifier>()
    private let lock = NSLock()

    private func begin(_ task: WKURLSchemeTask) {
        lock.lock(); live.insert(ObjectIdentifier(task)); lock.unlock()
    }

    private func alive(_ task: WKURLSchemeTask) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return live.contains(ObjectIdentifier(task))
    }

    private func end(_ task: WKURLSchemeTask) {
        lock.lock(); live.remove(ObjectIdentifier(task)); lock.unlock()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        begin(task)
        let request = task.request

        io.async { [weak self] in
            guard let self else { return }
            let (status, mime, body) = self.load(request.url)

            // 读盘期间页面可能已经走了（翻页、关卡片都会取消在途请求）
            guard self.alive(task) else { return }

            let headers = [
                "Content-Type": mime,
                "Content-Length": String(body.count),
                // 资源就在 App 包里，读一次是本地磁盘 IO，再缓存一层没有意义。
                "Cache-Control": "no-store",
            ]
            let response = HTTPURLResponse(url: request.url ?? URL(fileURLWithPath: "/"),
                                           statusCode: status,
                                           httpVersion: "HTTP/1.1",
                                           headerFields: headers)!

            // didReceive 和 didFinish 之间 task 也可能被停掉，所以逐步再确认。
            guard self.alive(task) else { return }
            task.didReceive(response)
            guard self.alive(task) else { return }
            task.didReceive(body)
            guard self.alive(task) else { return }
            task.didFinish()
            self.end(task)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        end(task)
    }

    /// URL → (状态码, MIME, 内容)。任何取不到的东西都是空 body 的 404，
    /// 和安卓那边的 notFound() 一致。
    private func load(_ url: URL?) -> (Int, String, Data) {
        let notFound = (404, "text/plain", Data())
        guard let url, let root else { return notFound }

        var path = url.path
        if path.hasPrefix("/") { path.removeFirst() }
        if path.isEmpty || path.hasSuffix("/") { path += "index.html" }

        let file = root.appendingPathComponent(path).standardizedFileURL

        // 目录穿越：`..` 拼出来的路径 standardize 之后就露馅了。
        // 比较 standardized 之后的前缀，而不是查字符串里有没有 ".."，
        // 后者对百分号编码是拦不住的。
        guard file.path.hasPrefix(root.standardizedFileURL.path + "/") else { return notFound }
        guard let data = try? Data(contentsOf: file, options: .mappedIfSafe) else { return notFound }

        let ext = file.pathExtension.lowercased()
        return (200, Self.mime[ext] ?? "application/octet-stream", data)
    }
}
