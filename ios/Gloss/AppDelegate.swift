// Gloss 的 iOS 入口。壳统共三个文件，这个是最短的那一个。
//
// 不用 SwiftUI：整个界面就是一块 WKWebView，套一层 SwiftUI 只是多一层
// 生命周期要对付。UIKit 直接把 VC 放进 window，看得见摸得着。
//
// 走 UIScene 而不是老的 application(_:didFinishLaunchingWithOptions:) + window：
// iOS 26 起不采纳 scene 的 App 会被当成过时形态，而且 iPad 上的分屏、
// 多窗口都挂在 scene 上 —— 这个 App 在 iPad 上就是要能和别的东西并排放的。

import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication,
                     configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: session.role)
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene,
               willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let w = UIWindow(windowScene: scene)
        w.rootViewController = ReaderViewController()
        w.makeKeyAndVisible()
        window = w
    }
}
