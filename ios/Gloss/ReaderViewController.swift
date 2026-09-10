// Gloss 的 iOS 壳。和安卓那边的 MainActivity 一一对应，做的事情一样少：
//
//   1. 把 App 包里的网页当成一个正经的、有 origin 的站点喂给 WKWebView
//   2. 接上 WebView 自己不做的事：外链、选中时的系统菜单
//   3. 告诉网页自己是哪个版本，以及去哪儿看有没有新版
//
// 为什么不能直接 loadFileURL(index.html)：
// 网页版是 ES module（app.js 里一串 import），file:// 的来源是 opaque，
// 模块脚本会被 CORS 直接拦掉。绕过它要开 allowFileAccessFromFileURLs 这个
// 私有 preference —— 一个上架 App 不该把地基压在私有 API 上。
// 自定义 scheme 给的是一个正常的 origin（gloss-app://local），
// 模块、localStorage、IndexedDB 一起恢复正常。
//
// 和安卓的一处真实差别：<input type="file"> 在 WKWebView 里是原生支持的，
// 会自己弹 UIDocumentPicker。安卓那边要手写一整套 onShowFileChooser，
// 这边一行都不用 —— 也就没有「取消时忘了回话，之后再也导不进文档」那个坑。

import UIKit
import WebKit

final class ReaderViewController: UIViewController {

    /// 自定义 scheme 固定用这一对，js/env.js 里靠它认出「我在 App 里」。
    /// 注意 http/https 是 WebKit 保留的，注册上去会直接抛异常。
    static let scheme = "gloss-app"
    static let host = "local"
    private static let index = URL(string: "\(scheme)://\(host)/index.html")!

    private var web: QuietWebView!

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AssetSchemeHandler(), forURLScheme: Self.scheme)

        // 不要 WebKit 自己的媒体/侧滑之类的额外行为，壳越薄越好。
        config.allowsInlineMediaPlayback = true
        config.userContentController.addUserScript(Self.bridgeScript())

        let w = QuietWebView(frame: .zero, configuration: config)
        w.navigationDelegate = self
        w.allowsBackForwardNavigationGestures = false   // 页面不用 history，侧滑回退只会白屏
        w.scrollView.contentInsetAdjustmentBehavior = .never

        // 网页画出来之前先铺上和启动屏同一张纸（跟着系统深浅），
        // 否则从启动屏到首屏之间会闪一下白 —— 深色下尤其刺眼。
        w.isOpaque = false
        let paper = UIColor(named: "LaunchBackground") ?? .systemBackground
        w.backgroundColor = paper
        w.scrollView.backgroundColor = paper

        if #available(iOS 16.4, *) {
            #if DEBUG
            w.isInspectable = true
            #endif
        }

        /* 安全区在原生这边让开，不让网页管。
         *
         * 网页的 CSS 只用过 env(safe-area-inset-bottom) —— 安卓的 WebView 不延伸到
         * 状态栏，顶部从来不需要留。iOS 上 WKWebView 是铺满整块屏的，直接放上去
         * 灵动岛会压在「Gloss」那行标题上，阅读页那条 sticky 的 .rhead 更是会被吃掉一半。
         *
         * 与其在 CSS 里为 iOS 补一套 inset-top（还要照顾 sticky 的粘附位置和
         * 横屏时左右的缺口），不如把 WebView 整个收进安全区里：网页看到的就是一块
         * 规规矩矩的矩形，和安卓那边的处境一字不差，两个平台共用同一份 CSS。
         * 让出来的那一圈由下面这层 view 铺同一张纸，看上去就是页边距。 */
        let container = UIView()
        container.backgroundColor = paper
        container.addSubview(w)
        w.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            w.topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor),
            w.leadingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.leadingAnchor),
            w.trailingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.trailingAnchor),
            w.bottomAnchor.constraint(equalTo: container.safeAreaLayoutGuide.bottomAnchor),
        ])

        web = w
        view = container
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        web.load(URLRequest(url: Self.index))
    }

    /// 键盘和状态栏的深浅跟着网页的暖纸/深色走，交给系统按 traitCollection 判断。
    override var preferredStatusBarStyle: UIStatusBarStyle { .default }

    /* ---------- 给网页看的两个常量 ----------
     *
     * 和安卓的 NativeBridge 逐字对应：**只读、只返回编译期字符串**。
     * 这边更省事也更严 —— 注入的是一个冻起来的字面量对象，
     * 网页拿到的不是一座通往原生的桥，就是两个字符串，
     * 没有任何一个方法能碰到文件、网络或别的 App。
     *
     * 「检查更新」为什么只是打开一个网址：和安卓同一个理由 ——
     * 抓取动作是 Safari 做的，不是这个 App。见 PrivacyInfo.xcprivacy。
     */
    private static func bridgeScript() -> WKUserScript {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = (info["CFBundleShortVersionString"] as? String) ?? ""
        // 空串表示这个包没配站点地址，网页那边据此整个不显示「检查更新」。
        let updateURL = (info["GlossUpdateURL"] as? String) ?? ""

        let src = """
        window.GlossNative = Object.freeze({
          version: function () { return \(jsString(version)); },
          updateUrl: function () { return \(jsString(updateURL)); }
        });
        """
        return WKUserScript(source: src, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    /// 拿 JSONSerialization 出字符串字面量，别自己拼引号 —— 版本号里将来出现
    /// 任何一个引号或反斜杠，自己拼就是一个注入点。
    private static func jsString(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [s]),
              let arr = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(arr.dropFirst().dropLast())   // ["x"] → "x"
    }
}

/* ---------- 外链 ---------- */

extension ReaderViewController: WKNavigationDelegate {

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        #if DEBUG
        selfCheck(webView)
        #endif
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        // 自己的页面，照常加载
        if url.scheme == ReaderViewController.scheme {
            decisionHandler(.allow)
            return
        }
        // 导进来的网页里的外链、以及「检查更新」：交给 Safari，
        // 别把阅读器变成浏览器。
        decisionHandler(.cancel)
        if let s = url.scheme?.lowercased(), s == "http" || s == "https" || s == "mailto" {
            UIApplication.shared.open(url)
        }
    }
}

/* ---------- 选中正文时不弹系统菜单 ----------
 *
 * 和安卓那条红线是同一条，理由一字不差：这个 App 的整个卖点就是
 * 「不用走选中 → 菜单 → 翻译那三步」，而系统那个「查询 / 翻译 / 共享」菜单
 * 是原生视图，永远盖在 WebView 上面。留着它，等于在最核心的界面上摆一个
 * 「点这里去别处翻译」的入口，还会把网页里那条划线/笔记的工具条挡住。
 *
 * 只让菜单项一个都不剩，**不碰选择手柄** —— 手柄归 selection UI 管，
 * 和 edit menu 是两套东西。拖着调整选区那件事必须留着，
 * 那比系统菜单碍事严重得多。
 */
final class QuietWebView: WKWebView {

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        false
    }

    /// iOS 16 起菜单还会走这一条。返回一个空菜单，比逐项删稳。
    @available(iOS 16.0, *)
    override func buildMenu(with builder: UIMenuBuilder) {
        // 只清编辑相关的那一组，别去动整个 App 的菜单树
        // （iPad 外接键盘时 App 菜单栏也走这里）。
        builder.remove(menu: .standardEdit)
        builder.remove(menu: .lookup)
        builder.remove(menu: .share)
        builder.remove(menu: .replace)
        builder.remove(menu: .substitutions)
        builder.remove(menu: .transformations)
        builder.remove(menu: .speech)
        builder.remove(menu: .learn)
        builder.remove(menu: .format)
        super.buildMenu(with: builder)
    }
}

#if DEBUG
/* ---------- 起来之后自己验一遍存储 ----------
 *
 * 只在 Debug 里编进去，而且要 -GlossSelfCheck 1 才跑。
 *
 * 验的是这个壳唯一压了赌注的地方：自定义 scheme 给出的 origin
 * 到底算不算「安全上下文」，localStorage 和 IndexedDB 认不认它。
 * 认不认决定了进度、生词本和整本书的正文存不存得下来 ——
 * 而这件事浏览器测不出来（网页版跑在 https 上），
 * 安卓也测不出来（那边是 WebViewAssetLoader 给的 https 域名）。
 * 只有真机/模拟器上的 WKWebView 才说了算，所以让它自己报一次。
 */
extension ReaderViewController {

    func selfCheck(_ webView: WKWebView) {
        guard UserDefaults.standard.bool(forKey: "GlossSelfCheck") else { return }

        let js = """
        const out = [];
        out.push('origin=' + location.origin);
        out.push('isSecureContext=' + window.isSecureContext);
        try {
          localStorage.setItem('__probe', 'x');
          out.push('localStorage=' + (localStorage.getItem('__probe') === 'x' ? 'OK' : 'WRONG'));
          localStorage.removeItem('__probe');
        } catch (e) { out.push('localStorage=ERR:' + (e && e.name)); }
        try {
          const db = await new Promise((res, rej) => {
            const r = indexedDB.open('__probe', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('s');
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          await new Promise((res, rej) => {
            const t = db.transaction('s', 'readwrite');
            t.objectStore('s').put('v', 'k');
            t.oncomplete = res; t.onerror = () => rej(t.error);
          });
          const got = await new Promise((res, rej) => {
            const q = db.transaction('s').objectStore('s').get('k');
            q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
          });
          db.close();
          indexedDB.deleteDatabase('__probe');
          out.push('indexedDB=' + (got === 'v' ? 'OK' : 'WRONG'));
        } catch (e) { out.push('indexedDB=ERR:' + (e && e.name)); }
        // 网页那边认没认出自己在 App 里 —— 认错了同步码和 Service Worker 会冒出来
        try {
          const env = await import('./js/env.js');
          out.push('NATIVE=' + env.NATIVE);
          out.push('NATIVE_VERSION=' + (env.NATIVE_VERSION || '(空)'));
          out.push('UPDATE_URL=' + (env.UPDATE_URL ? '(有)' : '(空)'));
        } catch (e) { out.push('env.js=ERR:' + (e && e.message)); }
        // 词典：走完整条按需读分片的路，而不是只看清单在不在。
        // 这一条才是 scheme handler 真正要扛的活 —— 648 个分片都在包里，
        // 查一个没预加载过的词，就会现去读它那一片。
        try {
          const dict = await import('./js/dict.js');
          await dict.ensureWords(['indemnify']);
          const r = dict.get('indemnify');
          out.push('dict(按需读分片)=' + (r ? (r.entry && r.entry.t || '').split('\\n')[0] : '查不到'));
        } catch (e) { out.push('dict=ERR:' + (e && e.message)); }
        out.push('sw=' + (navigator.serviceWorker && navigator.serviceWorker.controller ? '注册了(不该)' : '没注册(对)'));
        // 朗读：安卓的 WebView 压根没有 speechSynthesis，喇叭按钮被整个藏掉了。
        // iOS 这边有没有决定了 README 那张对照表怎么写，也决定用户看不看得见喇叭。
        // getVoices() 首次可能是空的，等一次 voiceschanged。
        try {
          if (!('speechSynthesis' in window)) { out.push('TTS=没有'); }
          else {
            let vs = speechSynthesis.getVoices();
            if (!vs.length) {
              await new Promise((r) => { speechSynthesis.onvoiceschanged = r; setTimeout(r, 2000); });
              vs = speechSynthesis.getVoices();
            }
            out.push('TTS=有，英文嗓音 ' + vs.filter((v) => v.lang.startsWith('en')).length + ' 个');
          }
        } catch (e) { out.push('TTS=ERR:' + (e && e.name)); }
        out.push('no-tts 类=' + (document.documentElement.classList.contains('no-tts') ? '加了(喇叭藏起来)' : '没加(喇叭可见)'));
        return out.join('\\n  ');
        """

        webView.callAsyncJavaScript(js, in: nil, in: .page) { result in
            switch result {
            case .success(let value):
                print("[GLOSS-SELFCHECK]\n  \(value as? String ?? "\(value)")\n[GLOSS-SELFCHECK-END]")
            case .failure(let error):
                print("[GLOSS-SELFCHECK] 跑不起来：\(error)")
            }
        }
    }
}
#endif
