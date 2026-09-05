import CoreBluetooth
import Foundation

final class PlaudScanner: NSObject, CBCentralManagerDelegate {
    private var manager: CBCentralManager!
    private var target: CBPeripheral?

    override init() {
        super.init()
        manager = CBCentralManager(delegate: self, queue: nil)
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else {
            print("Bluetooth is unavailable (state: \(central.state.rawValue)).")
            exit(1)
        }
        print("Searching for Plaud devices...")
        central.scanForPeripherals(withServices: nil, options: [
            CBCentralManagerScanOptionAllowDuplicatesKey: false,
        ])
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let localName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let name = peripheral.name ?? localName ?? ""
        guard name.localizedCaseInsensitiveContains("plaud") else { return }
        target = peripheral
        central.stopScan()
        print("Found \(name) (signal: \(RSSI) dBm). Connecting...")
        central.connect(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        print("Connection verified.")
        central.cancelPeripheralConnection(peripheral)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(0) }
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        print("Connection failed: \(error?.localizedDescription ?? "unknown error")")
        exit(1)
    }
}

let scanner = PlaudScanner()
DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
    print("No Plaud device found. Wake the device and keep it near this Mac, then try again.")
    exit(1)
}
RunLoop.main.run()
_ = scanner
