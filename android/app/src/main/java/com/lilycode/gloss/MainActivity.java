package com.lilycode.gloss;

// Gloss 的 Android 壳 —— 只有这一个文件，做的事情和 server.js 一样少：
//
//   1. 把安装包 assets 里的网页当成一个正经的 https 站点喂给 WebView
//   2. 接上 WebView 自己不做的两件事：选文件、返回键
//   3. 告诉网页自己是哪个版本，以及去哪儿看有没有新版
//
// 为什么不能直接 loadUrl("file:///android_asset/index.html")：
// 网页版是 ES module（app.js 里一串 import），file:// 的来源是 "null"，
// 模块脚本会被 CORS 直接拦掉；localStorage / IndexedDB 在 file:// 下也不可靠。
// WebViewAssetLoader 给的是一个正常的 https 来源，这两个问题一起没有了。

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.Nullable;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends ComponentActivity {

    /** WebViewAssetLoader 固定用这个域名，js/env.js 里靠它认出「我在 App 里」。 */
    private static final String HOST = "appassets.androidplatform.net";
    private static final String INDEX = "https://" + HOST + "/index.html";

    // 和 server.js 里那张表一一对应。必须自己报 MIME：
    // .mjs（pdf.js 那两个文件）猜不出来就会退成 text/plain，
    // 而模块脚本的 MIME 不对，浏览器是直接拒绝执行的 —— PDF 导入会整个哑掉。
    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff2", "font/woff2");
        MIME.put("map", "application/json");
    }

    private WebView web;

    /* ---------- 选文件 ---------- */
    // WebView 对 <input type="file"> 默认毫无反应，得自己弹选择器再把结果塞回去。
    // 这里最容易出的错是「取消时不回话」：只要有一次没调 onReceiveValue，
    // 那个 input 就永远卡住，用户之后再也导不进任何文档。所以每条路径都必须回话。
    private ValueCallback<Uri[]> pendingFiles;

    private final ActivityResultLauncher<Intent> picker = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                if (pendingFiles == null) return;
                pendingFiles.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(
                                result.getResultCode(), result.getData()));
                pendingFiles = null;
            });

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", new AssetsHandler())
                .build();

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);      // localStorage：进度和生词本
        s.setDatabaseEnabled(true);        // IndexedDB：文档正文
        s.setUseWideViewPort(true);        // 让 index.html 里的 viewport meta 说了算
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);                // 字号由 App 里的 A− / A＋ 管，不叠加系统缩放
        s.setAllowFileAccess(false);       // 一切都走 assets handler，不需要 file://
        s.setAllowContentAccess(false);

        // 让 CSS 里的 prefers-color-scheme 跟着系统深色走。
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(s, true);
        }

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web.setWebViewClient(new WebViewClient() {
            @Nullable
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;   // 自己的页面，照常加载
                // 导进来的网页里的外链：交给系统浏览器，别把阅读器变成浏览器。
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = cb;

                // 故意不用 params.createIntent() 的类型过滤：那份 accept 列表里混着
                // .epub 这类扩展名，转成 MIME 之后系统选择器反而会把 EPUB 藏起来，
                // 变成「文件明明在，却选不中」。这里一律 */*，格式由 kindOf() 按文件名判。
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*");
                try {
                    picker.launch(intent);
                } catch (ActivityNotFoundException e) {
                    pendingFiles = null;
                    cb.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });

        // 返回键。页面没用 history，goBack() 是空的，语义由网页那边的 __glossBack 定义：
        // 先关浮层，再退回首页，都没有才把 App 收到后台（收到后台而不是 finish，
        // 是为了回来时还停在原来那一节，不用重新从 IndexedDB 读一遍书）。
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                web.evaluateJavascript(
                        "(window.__glossBack && window.__glossBack()) ? 1 : 0",
                        value -> {
                            if (!"1".equals(value)) moveTaskToBack(true);
                        });
            }
        });

        web.addJavascriptInterface(new NativeBridge(), "GlossNative");

        if (savedInstanceState == null) web.loadUrl(INDEX);
    }

    /**
     * 给网页看的两个常量。**只读、只返回编译期字符串**，没有任何一个方法能碰到
     * 文件、网络或 Intent —— 这条界限是刻意的：addJavascriptInterface 暴露出去的
     * 是真正的 Java 对象，网页拿到什么就能调什么。
     *
     * 而且这个 WebView 只加载安装包里的 assets（外链在 shouldOverrideUrlLoading
     * 里被丢给系统浏览器了），网页内容是我们自己的，不存在第三方脚本拿到这个桥。
     *
     * 「检查更新」为什么只是打开一个网址：App 内下载安装要 INTERNET +
     * REQUEST_INSTALL_PACKAGES 两个权限，而权限表是「装完再也不联网」这句承诺
     * 唯一能被外人核实的地方（见 AndroidManifest.xml）。用 ACTION_VIEW 唤起浏览器
     * 不需要任何权限 —— 抓取动作是浏览器做的，不是这个 App。
     */
    public final class NativeBridge {
        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }

        /** 空串表示这个包没配站点地址，网页那边据此整个不显示「检查更新」。 */
        @JavascriptInterface
        public String updateUrl() {
            return BuildConfig.UPDATE_URL;
        }
    }

    /** 从 assets 里直接读，自己报 MIME。assets 的根就是 gloss/public。 */
    private final class AssetsHandler implements WebViewAssetLoader.PathHandler {
        @Nullable
        @Override
        public WebResourceResponse handle(String path) {
            if (path.startsWith("/")) path = path.substring(1);
            if (path.isEmpty() || path.endsWith("/")) path = path + "index.html";
            if (path.contains("..")) return notFound();

            try {
                InputStream in = getAssets().open(path);
                int dot = path.lastIndexOf('.');
                String ext = dot < 0 ? "" : path.substring(dot + 1).toLowerCase();
                String mime = MIME.get(ext);
                if (mime == null) mime = "application/octet-stream";

                Map<String, String> headers = new HashMap<>();
                // 资源就在安装包里，读一次是本地磁盘 IO，再缓存一层没有意义。
                headers.put("Cache-Control", "no-store");
                return new WebResourceResponse(mime, "utf-8", 200, "OK", headers, in);
            } catch (IOException e) {
                return notFound();
            }
        }

        private WebResourceResponse notFound() {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                    Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
