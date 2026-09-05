import CoreBluetooth
import Foundation
import Security

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let text = String(data: data, encoding: .utf8) else { return }
    print(text)
    fflush(stdout)
}

final class PlaudBridge: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var manager: CBCentralManager!
    private var target: CBPeripheral?
    private var writer: CBCharacteristic?
    private var writeID: Int?
    private var ready = false
    private var finished = false
    private let identifier: UUID

    init(identifier: UUID) {
        self.identifier = identifier
        super.init()
        manager = CBCentralManager(delegate: self, queue: nil)
    }

    func close(_ reason: String, code: Int32 = 1) {
        guard !finished else { return }
        finished = true
        if manager.state == .poweredOn { manager.stopScan() }
        if let target { manager.cancelPeripheralConnection(target) }
        emit(["event": "closed", "reason": reason])
        exit(code)
    }

    func discoveryTimeout() { if !ready { close("connection_timeout") } }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .unknown || central.state == .resetting { return }
        guard central.state == .poweredOn else { close("bluetooth_unavailable"); return }
        if let cached = central.retrievePeripherals(withIdentifiers: [identifier]).first {
            target = cached; cached.delegate = self; central.connect(cached)
        } else { central.scanForPeripherals(withServices: nil) }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard target == nil, peripheral.identifier == identifier else { return }
        target = peripheral; peripheral.delegate = self
        central.stopScan(); central.connect(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        emit(["event": "connected"])
        peripheral.discoverServices([CBUUID(string: "1910"), CBUUID(string: "180A")])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        close("connection_failed")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        close("disconnected")
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let services = peripheral.services,
              services.contains(where: { $0.uuid == CBUUID(string: "1910") }) else {
            close("missing_command_service"); return
        }
        for service in services { peripheral.discoverCharacteristics(nil, for: service) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil else { close("characteristic_discovery_failed"); return }
        let chars = service.characteristics ?? []
        if service.uuid == CBUUID(string: "1910") {
            writer = chars.first { $0.uuid == CBUUID(string: "2BB1") }
            guard let notify = chars.first(where: { $0.uuid == CBUUID(string: "2BB0") }),
                  writer?.properties.contains(.write) == true else { close("missing_command_characteristics"); return }
            peripheral.setNotifyValue(true, for: notify)
        }
        for char in chars where char.properties.contains(.read) {
            peripheral.readValue(for: char)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, characteristic.isNotifying else { close("subscription_failed"); return }
        ready = true
        emit(["event": "ready", "maxWrite": peripheral.maximumWriteValueLength(for: .withResponse)])
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        let isPacket = characteristic.uuid == CBUUID(string: "2BB0")
        if error != nil {
            if isPacket { close("notification_failed") }
            else { emit(["event": "read_error", "uuid": characteristic.uuid.uuidString]) }
            return
        }
        guard let data = characteristic.value else { return }
        emit(["event": isPacket ? "packet" : "metadata", "uuid": characteristic.uuid.uuidString,
              "data": data.base64EncodedString()])
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let id = writeID else { return }
        writeID = nil
        emit(["event": "reply", "id": id, "ok": error == nil])
    }

    func handle(_ request: [String: Any]) {
        let id = request["id"] as? Int ?? -1
        switch request["op"] as? String {
        case "write": write(request, id: id)
        case "rsa-decrypt": unwrap(request, id: id)
        case "close": close("client_closed", code: 0)
        default: emit(["event": "reply", "id": id, "ok": false])
        }
    }

    private func write(_ request: [String: Any], id: Int) {
        guard ready, writeID == nil, let target, let writer,
              let encoded = request["data"] as? String, let data = Data(base64Encoded: encoded),
              !data.isEmpty, data.count <= target.maximumWriteValueLength(for: .withResponse) else {
            emit(["event": "reply", "id": id, "ok": false]); return
        }
        writeID = id
        target.writeValue(data, for: writer, type: .withResponse)
    }

    private func unwrap(_ request: [String: Any], id: Int) {
        let attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate, kSecAttrKeySizeInBits as String: 2048]
        guard let encodedKey = request["key"] as? String, let keyData = Data(base64Encoded: encodedKey),
              let encoded = request["data"] as? String, let ciphertext = Data(base64Encoded: encoded), ciphertext.count == 256,
              let key = SecKeyCreateWithData(keyData as CFData, attributes as CFDictionary, nil),
              let plaintext = SecKeyCreateDecryptedData(key, .rsaEncryptionPKCS1, ciphertext as CFData, nil) else {
            emit(["event": "reply", "id": id, "ok": false]); return
        }
        emit(["event": "reply", "id": id, "ok": true, "data": (plaintext as Data).base64EncodedString()])
    }
}

guard CommandLine.arguments.count == 2, let identifier = UUID(uuidString: CommandLine.arguments[1]) else {
    emit(["event": "closed", "reason": "invalid_target"]); exit(1)
}
let bridge = PlaudBridge(identifier: identifier)
DispatchQueue.global().async {
    while let line = readLine() {
        guard line.utf8.count <= 16384, let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            DispatchQueue.main.async { bridge.close("invalid_request") }; return
        }
        DispatchQueue.main.async { bridge.handle(object) }
    }
    DispatchQueue.main.async { bridge.close("client_eof", code: 0) }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 35) { bridge.discoveryTimeout() }
DispatchQueue.main.asyncAfter(deadline: .now() + 600) { bridge.close("session_deadline") }
RunLoop.main.run()
