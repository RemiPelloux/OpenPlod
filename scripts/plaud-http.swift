import Foundation

// Private stdin/stdout protocol. Never print requests, headers or response bodies to stderr.
let hosts: Set<String> = ["api.plaud.ai", "api-apse1.plaud.ai", "api-use1.plaud.ai", "api-euc1.plaud.ai", "api-usw2.plaud.ai"]
let paths: Set<String> = ["/device-app/device/sn-sign", "/device-app/e2ee/gen_key"]
func allowed(_ url: URL) -> Bool {
    url.scheme == "https" && hosts.contains(url.host ?? "") && paths.contains(url.path)
        && url.user == nil && url.password == nil && (url.port == nil || url.port == 443)
        && url.query == nil && url.fragment == nil
}
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) { FileHandle.standardOutput.write(data) }
}
if CommandLine.arguments.contains("--self-test") {
    func check(_ condition: Bool) {
        if !condition { fputs("Native transport URL restriction failed\n", stderr); exit(1) }
    }
    for host in hosts {
        for path in paths { check(allowed(URL(string: "https://" + host + path)!)) }
    }
    for value in ["http://api.plaud.ai/device-app/device/sn-sign", "https://api.plaud.ai.attacker.example/device-app/device/sn-sign", "https://user@api.plaud.ai/device-app/device/sn-sign", "https://api.plaud.ai:8443/device-app/device/sn-sign", "https://api.plaud.ai/device-app/device/delete", "https://api.plaud.ai/device-app/device/sn-sign?token=synthetic"] {
        check(!allowed(URL(string: value)!))
    }
    print("Native transport URL restrictions passed")
    exit(0)
}
final class Receiver: NSObject, URLSessionDataDelegate {
    let done = DispatchSemaphore(value: 0)
    var body = Data()
    var response: HTTPURLResponse?
    var oversized = false
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        self.response = response as? HTTPURLResponse
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if body.count + data.count > 262144 { oversized = true; dataTask.cancel(); return }
        body.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { done.signal() }
        guard error == nil, !oversized, let response else { emit(["error":"Native Plaud request failed."]); return }
        var headers: [String: String] = [:]
        for name in ["Content-Type", "X-Encrypt-Response"] { if let value = response.value(forHTTPHeaderField: name) { headers[name] = value } }
        emit(["status": response.statusCode, "headers": headers, "body": body.base64EncodedString()])
    }
}
var input = Data()
while input.count <= 32768 {
    let chunk = FileHandle.standardInput.readData(ofLength: 4096)
    if chunk.isEmpty { break }
    input.append(chunk)
}
guard input.count <= 32768,
      let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any],
      let rawURL = request["url"] as? String, let url = URL(string: rawURL), allowed(url),
      let authorization = request["authorization"] as? String,
      authorization.utf8.count <= 16384, !authorization.contains("\r"), !authorization.contains("\n"),
      let body = request["body"] as? String, body.utf8.count <= 8192 else {
    emit(["error":"Invalid native Plaud request."]); exit(1)
}
var req = URLRequest(url: url)
req.httpMethod = "POST"
req.httpBody = Data(body.utf8)
req.setValue(authorization, forHTTPHeaderField: "Authorization")
req.setValue("application/json", forHTTPHeaderField: "Content-Type")
req.setValue("web", forHTTPHeaderField: "app-platform")
req.setValue("web", forHTTPHeaderField: "edit-from")
req.setValue("1", forHTTPHeaderField: "X-Encrypt-Response")
let receiver = Receiver()
let config = URLSessionConfiguration.ephemeral
config.httpCookieStorage = nil
config.urlCredentialStorage = nil
config.requestCachePolicy = .reloadIgnoringLocalCacheData
config.timeoutIntervalForRequest = 20
config.timeoutIntervalForResource = 20
let session = URLSession(configuration: config, delegate: receiver, delegateQueue: nil)
session.dataTask(with: req).resume()
if receiver.done.wait(timeout: .now() + 22) == .timedOut { session.invalidateAndCancel(); emit(["error":"Native Plaud request timed out."]); exit(1) }
session.invalidateAndCancel()
