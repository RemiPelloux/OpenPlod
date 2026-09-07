package com.openplod.vault

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.Build
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

@SuppressLint("MissingPermission")
class DirectPlaudTransport(private val context: Context) : AutoCloseable {
    private val manager = context.getSystemService(BluetoothManager::class.java)
    private val events = LinkedBlockingQueue<String>(32)
    private val packets = LinkedBlockingQueue<ByteArray>(4096)
    @Volatile private var failure: String? = null
    @Volatile private var closed = false
    private var gatt: BluetoothGatt? = null
    private var writer: BluetoothGattCharacteristic? = null
    private var scanCallback: ScanCallback? = null
    private var mtu = 23
    private fun uuid(short: String) = UUID.fromString("0000$short-0000-1000-8000-00805f9b34fb")
    private fun fail(message: String) { failure = message; events.offer("error") }
    private fun checkOpen() { check(!closed) { "Transfer cancelled." }; check(failure == null) { failure!! } }
    private fun awaitEvent(expected: String, timeout: Long = 15000) {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout)
        while (System.nanoTime() < deadline) {
            checkOpen()
            val event = events.poll(200, TimeUnit.MILLISECONDS)
            if (event == expected) return
            if (event != null && event != "error") error("Unexpected Bluetooth operation response.")
        }
        error("Bluetooth $expected timed out.")
    }
    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) {
            if (closed) return
            if (status != BluetoothGatt.GATT_SUCCESS || state == BluetoothProfile.STATE_DISCONNECTED) fail("Plaud disconnected (Bluetooth status $status).")
            else if (state == BluetoothProfile.STATE_CONNECTED) events.offer("connected")
        }
        override fun onMtuChanged(g: BluetoothGatt, value: Int, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) { mtu = value; events.offer("mtu") } else fail("Bluetooth MTU negotiation failed.")
        }
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) events.offer("services") else fail("Bluetooth service discovery failed.")
        }
        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) events.offer("subscribed") else fail("Plaud notification subscription failed.")
        }
        override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) events.offer("written") else fail("Plaud Bluetooth write failed.")
        }
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) { received(characteristic, value) }
        @Deprecated("Legacy Android callback")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT < 33) received(characteristic, characteristic.value ?: byteArrayOf())
        }
        private fun received(characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            if (!closed && characteristic.uuid == uuid("2bb0") && !packets.offer(value.copyOf())) fail("Bluetooth receive queue overflow.")
        }
    }
    fun connect(serial: String, progress: (String) -> Unit) {
        check(manager.adapter?.isEnabled == true) { "Turn Bluetooth on." }
        val found = LinkedBlockingQueue<BluetoothDevice>(1)
        val scanner = manager.adapter.bluetoothLeScanner ?: error("Bluetooth scanner unavailable.")
        val cb = object : ScanCallback() {
            override fun onScanResult(type: Int, result: ScanResult) {
                val data = result.scanRecord?.manufacturerSpecificData ?: return
                for (i in 0 until data.size()) {
                    val id = data.keyAt(i)
                    val full = byteArrayOf(id.toByte(), (id shr 8).toByte()) + data.valueAt(i)
                    if (DirectPlaudProtocol.advertisement(full) == serial) found.offer(result.device)
                }
            }
            override fun onScanFailed(code: Int) { fail("Bluetooth scan failed ($code).") }
        }
        scanCallback = cb
        progress("scanning")
        val pattern = ByteArray(20); val mask = ByteArray(20)
        for (i in 0 until 8) { pattern[9 + i] = serial.substring(i * 2, i * 2 + 2).toInt(16).toByte(); mask[9 + i] = 0xff.toByte() }
        val filter = ScanFilter.Builder().setManufacturerData(0x005d, pattern, mask).build()
        scanner.startScan(listOf(filter), ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb)
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25)
        var device: BluetoothDevice? = null
        try { while (device == null && System.nanoTime() < deadline) { checkOpen(); device = found.poll(200, TimeUnit.MILLISECONDS) } }
        finally { scanner.stopScan(cb); scanCallback = null }
        checkOpen()
        check(device != null) { "Authorized Note Pro not found. Wake it and disconnect other Bluetooth clients." }
        progress("connecting")
        gatt = device!!.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        awaitEvent("connected", 25000)
        val connection = gatt ?: error("Bluetooth unavailable.")
        check(connection.requestMtu(247)) { "Could not negotiate Bluetooth packet size." }
        awaitEvent("mtu")
        check(mtu >= 107) { "Bluetooth MTU too small for the verified protocol." }
        check(connection.discoverServices()) { "Could not discover Plaud services." }; awaitEvent("services")
        val service = connection.getService(uuid("1910")) ?: error("Note Pro command service unavailable.")
        writer = service.getCharacteristic(uuid("2bb1")) ?: error("Note Pro writer unavailable.")
        check(writer!!.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) { "Note Pro does not permit acknowledged writes." }
        val notify = service.getCharacteristic(uuid("2bb0")) ?: error("Note Pro notifications unavailable.")
        check(connection.setCharacteristicNotification(notify, true)) { "Could not subscribe to Plaud." }
        val descriptor = notify.getDescriptor(uuid("2902")) ?: error("Notification descriptor unavailable.")
        if (Build.VERSION.SDK_INT >= 33) check(connection.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS)
        else { descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE; check(connection.writeDescriptor(descriptor)) }
        awaitEvent("subscribed")
        connection.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
    }
    fun write(bytes: ByteArray) {
        checkOpen(); require(bytes.isNotEmpty() && bytes.size <= mtu - 3) { "Invalid Bluetooth packet size." }
        val g = gatt ?: error("Bluetooth disconnected."); val characteristic = writer ?: error("Bluetooth not ready.")
        if (Build.VERSION.SDK_INT >= 33) check(g.writeCharacteristic(characteristic, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS) { "Bluetooth write could not start." }
        else { characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT; characteristic.value = bytes; check(g.writeCharacteristic(characteristic)) }
        awaitEvent("written", 10000)
    }
    fun packet(timeout: Long = 15000): ByteArray {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout.coerceAtLeast(1))
        while (System.nanoTime() < deadline) { checkOpen(); packets.poll(100, TimeUnit.MILLISECONDS)?.let { return it } }
        error("Plaud response timed out; recording count is unknown.")
    }
    override fun close() {
        closed = true
        scanCallback?.let { runCatching { manager.adapter.bluetoothLeScanner?.stopScan(it) } }
        scanCallback = null
        runCatching { gatt?.disconnect() }; runCatching { gatt?.close() }; gatt = null
        packets.clear(); events.offer("error")
    }
}
