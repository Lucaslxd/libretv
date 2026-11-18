import Foundation
import Capacitor

@objc(LTBridgeProxyPlugin)
public class LTBridgeProxyPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "LTBridgeProxyPlugin"
    public let jsName = "LTProxy"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getBase", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        _ = LTBridgeProxyServer.shared.startIfNeeded()
    }

    /// 返回本地代理地址，例如 http://127.0.0.1:8899
    @objc func getBase(_ call: CAPPluginCall) {
        let base = LTBridgeProxyServer.shared.startIfNeeded()
        call.resolve([
            "base": base ?? "",
            "port": LTBridgeProxyServer.shared.currentPort,
        ])
    }
}
