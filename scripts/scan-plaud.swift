import CoreBluetooth
import Foundation

final class PlaudScanner: NSObject, CBCentralManagerDelegate {
    private var manager: CBCentralManager!
    private var target: CBPeripheral?
    private var name: String?
    private var finished = false

    override init() {
        super.init()
        manager = CBCentralManager(delegate: self, queue: nil)
    }

    private func finish(connected: Bool = false, detail: String) {
        guard !finished else { return }
        finished = true
        if manager.state == .poweredOn { manager.stopScan() }
        if let peripheral = target { manager.cancelPeripheralConnection(peripheral) }
        let result: [String: Any] = [
            "detected": target != nil, "name": name as Any? ?? NSNull(),
            "connectionVerified": connected, "detail": detail,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: result),
           let text = String(data: data, encoding: .utf8) { print(text) }
        exit(0)
    }

    func timeout() {
        finish(detail: target == nil
            ? "No advertising Plaud found. Wake the device and keep it near this Mac."
            : "Plaud detected, but the Bluetooth connection timed out. It may be connected elsewhere.")
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .unknown || central.state == .resetting { return }
        guard central.state == .poweredOn else {
            finish(detail: central.state == .unauthorized
                ? "Bluetooth permission denied. Allow OpenPlod in System Settings > Privacy & Security > Bluetooth."
                : "Bluetooth is unavailable. Turn Bluetooth on and retry.")
            return
        }
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let advertisedName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let foundName = advertisedName ?? peripheral.name ?? ""
        guard target == nil, foundName.localizedCaseInsensitiveContains("plaud") else { return }
        target = peripheral
        name = foundName
        central.stopScan()
        central.connect(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        finish(connected: true, detail: "Bluetooth connection verified. Recording access is not authenticated.")
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        finish(detail: "Plaud detected, but the Bluetooth connection failed. Retry with other Plaud clients disconnected.")
    }
}

let scanner = PlaudScanner()
DispatchQueue.main.asyncAfter(deadline: .now() + 15) { scanner.timeout() }
RunLoop.main.run()
