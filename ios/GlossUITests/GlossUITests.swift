// iOS 这一侧特有的坑，和网页版 test/ 那套是同一个用意：
// 每一条都对应一个「别的地方测不出来」的东西。
//
// 为什么非得是 XCUITest：这里要验的是**原生控件**的有无。
// 系统的选择菜单是 UIKit 视图，不在 DOM 里 —— playwright 看不见它，
// 安卓那套 adb 更管不着。而模拟器上没有 idb / cliclick 可用，
// 只有 XCUITest 能在不要辅助功能权限的前提下真的长按一次。
//
// 用首页那句演示正文来长按，不导文档：演示句本来就是可选中的正文，
// 验菜单足够了，还省掉往模拟器里塞 EPUB 那一整套。

import XCTest

final class GlossUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// 系统那个「拷贝 / 查询 / 翻译 / 共享」菜单一项都不许冒出来。
    ///
    /// 这是从安卓搬过来的红线，理由一字不差：这个 App 的卖点就是不用走
    /// 「选中 → 菜单 → 翻译」那三步，而系统菜单是原生视图，永远盖在 WebView 上面。
    /// 留着它等于在最核心的界面上摆一个「点这里去别处翻译」的入口。
    func testLongPressShowsNoSystemEditMenu() throws {
        let app = XCUIApplication()
        app.launch()

        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30), "WebView 没起来")

        // 首页那句演示正文。等它出现 = 网页和词典都已经就绪。
        let demo = web.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "detective")).firstMatch
        XCTAssertTrue(demo.waitForExistence(timeout: 30), "首页的演示句没渲染出来")

        demo.press(forDuration: 1.2)

        // 菜单是异步弹的，给它一点时间冒头 —— 这里要证明的是「不出现」，
        // 所以必须真的等过它该出现的那一刻，否则测试是假绿的。
        Thread.sleep(forTimeInterval: 1.5)

        let menuCount = app.menuItems.count
        let named = ["拷贝", "复制", "查询", "查找", "翻译", "共享", "分享", "全选",
                     "Copy", "Look Up", "Translate", "Share", "Select All", "Search Web"]
        let leaked = named.filter { app.menuItems[$0].exists || app.buttons[$0].exists }

        XCTAssertEqual(menuCount, 0, "系统选择菜单冒出来了，menuItems = \(menuCount)")
        XCTAssertTrue(leaked.isEmpty, "系统菜单项漏出来了：\(leaked)")
    }

    /// 点一个词，释义卡片要出来 —— App 的全部意义就是这一下。
    /// 这里顺带证明词典是从包里读出来的（模拟器上没有网络能兜底）。
    func testTapWordShowsGloss() throws {
        let app = XCUIApplication()
        app.launch()

        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30), "WebView 没起来")

        let word = web.staticTexts["detective"]
        guard word.waitForExistence(timeout: 30) else {
            // 有些 WebKit 版本把整句合成一个 staticText，逐词元素不单独暴露。
            // 那就退回按坐标点第一个带虚线的词的位置，别让测试因为
            // 无障碍树的形状变化而变成假红。
            let demo = web.staticTexts.containing(
                NSPredicate(format: "label CONTAINS %@", "detective")).firstMatch
            XCTAssertTrue(demo.waitForExistence(timeout: 10), "演示句没出来")
            demo.coordinate(withNormalizedOffset: CGVector(dx: 0.18, dy: 0.5)).tap()
            assertGlossAppeared(app)
            return
        }
        word.tap()
        assertGlossAppeared(app)
    }

    /// 首页的演示是把释义填进那个虚线框，不是弹卡片 —— 断言框里不再是占位文案。
    private func assertGlossAppeared(_ app: XCUIApplication) {
        let placeholder = app.webViews.staticTexts["点一个词，在这里看中文释义。"]
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: placeholder)
        waitForExpectations(timeout: 15) { err in
            XCTAssertNil(err, "点了词但释义没填进去，占位文案还在")
        }
    }
}
