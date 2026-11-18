import Foundation
import Capacitor
import GCDWebServer

/**
 本地回环代理。
 iOS 上 `<video>` 播 HLS 时请求由 AVFoundation 自己发出，Web 层无法注入 Referer/UA。
 这里起一个只监听 127.0.0.1 的 HTTP 服务，把上游 m3u8 及其分片地址全部改写成代理地址，
 转发时补上请求头，系统播放器就只跟本地服务打交道。
 */
final class LTBridgeProxyServer {

    static let shared = LTBridgeProxyServer()

    private(set) var currentPort: Int = 0

    private var server: GCDWebServer?
    private let session: URLSession

    private static let uriRegex = try! NSRegularExpression(pattern: "URI=\"([^\"]*)\"", options: [])

    private init() {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 20
        cfg.timeoutIntervalForResource = 120
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.httpMaximumConnectionsPerHost = 8
        session = URLSession(configuration: cfg)
    }

    var baseURLString: String? {
        guard currentPort > 0 else { return nil }
        return "http://127.0.0.1:\(currentPort)"
    }

    @discardableResult
    func startIfNeeded() -> String? {
        if let base = baseURLString { return base }

        for candidate in 8899...8910 {
            let candidateServer = GCDWebServer()
            _ = candidateServer.addHandler(
                forMethod: "GET",
                pathRegex: "/p",
                request: GCDWebServerRequest.self
            ) { [weak self] request, completion in
                self?.handle(request, completion: completion)
            }

            do {
                try candidateServer.start(options: [
                    GCDWebServerOption_Port: candidate,
                    GCDWebServerOption_BindToLocalhost: true,
                ])
                server = candidateServer
                currentPort = candidate
                return baseURLString
            } catch {
                continue
            }
        }

        CAPLog.print("LTBridgeProxy: 无法在 8899-8910 上启动本地代理")
        return nil
    }

    /* ---------- 请求处理 ---------- */

    private func handle(_ request: GCDWebServerRequest, completion: @escaping GCDWebServerCompletionBlock) {
        let query = (request.query as? [AnyHashable: Any]) ?? [:]
        let encoded = (query["u"] as? String) ?? ""
        let referer = (query["r"] as? String) ?? ""
        let userAgent = (query["a"] as? String) ?? ""

        guard let target = Self.decodeBase64URL(encoded), let url = URL(string: target) else {
            completion(GCDWebServerResponse(statusCode: 400))
            return
        }

        var upstream = URLRequest(url: url)
        if !referer.isEmpty { upstream.setValue(referer, forHTTPHeaderField: "Referer") }
        if !userAgent.isEmpty { upstream.setValue(userAgent, forHTTPHeaderField: "User-Agent") }
        let headers = (request.headers as? [AnyHashable: Any]) ?? [:]
        if let range = (headers["Range"] as? String), !range.isEmpty {
            upstream.setValue(range, forHTTPHeaderField: "Range")
        }

        let task = session.dataTask(with: upstream) { [weak self] data, response, _ in
            guard let self = self else { return }
            guard let http = response as? HTTPURLResponse else {
                completion(GCDWebServerResponse(statusCode: 502))
                return
            }
            guard http.statusCode < 400 else {
                completion(GCDWebServerResponse(statusCode: 502))
                return
            }

            let payload = data ?? Data()
            let contentType = http.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
            let finalURL = http.url ?? url

            if self.looksLikePlaylist(contentType: contentType, data: payload, url: finalURL) {
                let text = String(data: payload, encoding: .utf8) ?? ""
                let rewritten = self.rewritePlaylist(text, base: finalURL, referer: referer, userAgent: userAgent)
                let body = GCDWebServerDataResponse(
                    data: Data(rewritten.utf8),
                    contentType: "application/vnd.apple.mpegurl"
                )
                body.setValue("no-cache, no-store", forAdditionalHeader: "Cache-Control")
                completion(body)
                return
            }

            completion(GCDWebServerDataResponse(data: payload, contentType: contentType))
        }
        task.resume()
    }

    private func looksLikePlaylist(contentType: String, data: Data, url: URL) -> Bool {
        let ct = contentType.lowercased()
        if ct.contains("mpegurl") { return true }
        let path = url.path.lowercased()
        if path.hasSuffix(".m3u8") || path.hasSuffix(".m3u") { return true }
        guard let head = String(data: data.prefix(1024), encoding: .utf8) else { return false }
        return head.contains("#EXTM3U")
    }

    /* ---------- m3u8 改写 ---------- */

    private func rewritePlaylist(_ text: String, base: URL, referer: String, userAgent: String) -> String {
        var output: [String] = []
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { output.append(""); continue }
            if line.hasPrefix("#") {
                output.append(rewriteTagLine(line, base: base, referer: referer, userAgent: userAgent))
            } else {
                output.append(proxyURL(for: line, base: base, referer: referer, userAgent: userAgent) ?? line)
            }
        }
        return output.joined(separator: "\n")
    }

    /// 处理 #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA / #EXT-X-PART 里的 URI="..."
    private func rewriteTagLine(_ line: String, base: URL, referer: String, userAgent: String) -> String {
        guard line.contains("URI=") else { return line }
        let ns = line as NSString
        let matches = Self.uriRegex.matches(in: line, range: NSRange(location: 0, length: ns.length))
        guard !matches.isEmpty else { return line }

        var result = line
        for match in matches.reversed() {
            let uriRange = match.range(at: 1)
            guard uriRange.location != NSNotFound else { continue }
            guard let fullRange = Range(match.range, in: result) else { continue }
            let uri = ns.substring(with: uriRange)
            guard let wrapped = proxyURL(for: uri, base: base, referer: referer, userAgent: userAgent) else { continue }
            result.replaceSubrange(fullRange, with: "URI=\"\(wrapped)\"")
        }
        return result
    }

    private func proxyURL(for raw: String, base: URL, referer: String, userAgent: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty || value.hasPrefix("data:") { return nil }
        guard let origin = baseURLString else { return nil }
        if value.hasPrefix(origin + "/p?") { return value }

        let absolute: URL?
        if let direct = URL(string: value), direct.scheme != nil {
            absolute = direct
        } else {
            absolute = URL(string: value, relativeTo: base)?.absoluteURL
        }
        guard let target = absolute?.absoluteString, target.hasPrefix("http") else { return nil }

        var out = origin + "/p?u=" + Self.encodeBase64URL(target)
        if !referer.isEmpty { out += "&r=" + Self.encodeURIComponent(referer) }
        if !userAgent.isEmpty { out += "&a=" + Self.encodeURIComponent(userAgent) }
        return out
    }

    /* ---------- 编解码 ---------- */

    static func encodeBase64URL(_ value: String) -> String {
        return Data(value.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decodeBase64URL(_ value: String) -> String? {
        guard !value.isEmpty else { return nil }
        var text = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = (4 - text.count % 4) % 4
        if padding > 0 { text += String(repeating: "=", count: padding) }
        guard let data = Data(base64Encoded: text) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func encodeURIComponent(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }
}
