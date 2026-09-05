import CoreBluetooth
import Foundation

// Read-only service/advertisement inspection. Never writes protocol commands.
final class PlaudInspector: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var manager: CBCentralManager!
    private var target: CBPeripheral?
    private var result: [String: Any] = ["connected": false, "authenticated": false]
    private var services: [[String: Any]] = []
    private var pending = 0
    private var finished = false

    override init() {
        super.init()
        manager = CBCentralManager(delegate: self, queue: nil)
    }

    private func finish(_ status: String) {
        guard !finished else { return }
        finished = true
        result["status"] = status
        result["services"] = services
        if manager.state == .poweredOn { manager.stopScan() }
        if let target { manager.cancelPeripheralConnection(target) }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) { print(text) }
        exit(status == "inspected" ? 0 : 1)
    }

    func timeout() { finish(target == nil ? "not_found" : "inspection_timeout") }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .unknown || central.state == .resetting { return }
        guard central.state == .poweredOn else {
            finish(central.state == .unauthorized ? "permission_denied" : "bluetooth_unavailable")
            return
        }
        central.scanForPeripherals(withServices: nil)
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name ?? ""
        guard target == nil, name.localizedCaseInsensitiveContains("plaud") else { return }
        target = peripheral
        result["name"] = name
        result["peripheralID"] = peripheral.identifier.uuidString
        result["rssi"] = RSSI
        if let data = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data {
            result["manufacturerData"] = data.base64EncodedString()
        }
        peripheral.delegate = self
        central.stopScan()
        central.connect(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        result["connected"] = true
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        finish("connection_failed")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        finish("disconnected")
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let found = peripheral.services, !found.isEmpty else {
            finish("service_discovery_failed")
            return
        }
        pending = found.count
        for service in found { peripheral.discoverCharacteristics(nil, for: service) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil else { finish("characteristic_discovery_failed"); return }
        let characteristics = (service.characteristics ?? []).map { characteristic -> [String: Any] in
            let flags = characteristic.properties
            return ["uuid": characteristic.uuid.uuidString, "read": flags.contains(.read),
                    "write": flags.contains(.write), "writeWithoutResponse": flags.contains(.writeWithoutResponse),
                    "notify": flags.contains(.notify), "indicate": flags.contains(.indicate)]
        }
        services.append(["uuid": service.uuid.uuidString, "characteristics": characteristics])
        pending -= 1
        if pending == 0 { finish("inspected") }
    }
}

let inspector = PlaudInspector()
DispatchQueue.main.asyncAfter(deadline: .now() + 25) { inspector.timeout() }
RunLoop.main.run()
