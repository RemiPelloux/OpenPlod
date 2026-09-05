package com.openplod.vault

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.appcompat.app.AppCompatActivity
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.tinnotech.penblesdk.entity.BleDevice
import com.tinnotech.penblesdk.entity.BleFile
import org.json.JSONArray
import org.json.JSONObject
import sdk.PlaudDeviceAgent
import sdk.PlaudDeviceAgentListener
import sdk.NiceBuildSdk
import sdk.audio.AudioExportFormat
import sdk.audio.AudioExporter
import java.io.File
import java.util.concurrent.Executors
import kotlinx.coroutines.runBlocking

@TauriPlugin(permissions = [
    Permission(alias = "bluetooth", strings = [Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT]),
    Permission(alias = "location", strings = [Manifest.permission.ACCESS_FINE_LOCATION])
])
class PlaudPlugin(private val activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val store by lazy { PlaudStore(activity) }
    private val vault = PlaudVaultClient()
    private val identity = PlaudIdentity()
    private val devices = linkedMapOf<String, BleDevice>()
    private var files = JSONArray()
    private var state = "not_configured"
    private var error: String? = null
    private var serial: String? = null
    private var battery: Int? = null
    private var listLoaded = false
    private var initialized = false
    private var downloading = false
    private var progress = 0
    private var player: MediaPlayer? = null
    private var playingId: String? = null
    @Volatile private var generation = 0
    private var lastProgressAt = 0L

    @Command fun snapshot(invoke: Invoke) = guarded(invoke) { snapshotValue() }

    @Command fun exportDocument(invoke: Invoke) = guarded(invoke) {
        val args = invoke.getArgs()
        PlaudExports(activity).document(args.getString("filename"), args.getString("content"), args.getString("mime"))
        snapshotValue()
    }

    @Command fun exportRecording(invoke: Invoke) = guarded(invoke) {
        PlaudExports(activity).audio(store.file(invoke.getArgs().getString("sourceRecordingId")))
        snapshotValue()
    }

    @Command fun exportVaultRecording(invoke: Invoke) {
        val args = invoke.getArgs()
        worker.execute {
            try {
                vault.configure(args.getString("origin"), args.getString("pairingToken"))
                val file = vault.exportAudio(File(activity.cacheDir, "document-exports"), args.getString("recordingId"), args.getString("filename"))
                main.post { guarded(invoke) { PlaudExports(activity).audio(file); snapshotValue() } }
            } catch (exception: Exception) { main.post { fail(invoke, exception) } }
        }
    }

    @Command fun initialize(invoke: Invoke) {
        if (state in setOf("authenticating", "connecting", "ready") || downloading) {
            invoke.reject("Finish the current connection or transfer first."); return
        }
        val args = invoke.getArgs()
        state = "authenticating"; error = null; initialized = false
        worker.execute {
            try {
                vault.configure(args.getString("origin"), args.getString("pairingToken"))
                val session = vault.session()
                identity.configure(session)
                main.post {
                    try {
                        NiceBuildSdk.getPartnerApiManager().updateBaseUrl("https://${session.getString("domain")}")
                        PlaudDeviceAgent.listener = listener
                        PlaudDeviceAgent.initSDK(activity.applicationContext, session.getString("userAccessToken"), session.getString("domain"))
                        initialized = true; state = "disconnected"; error = null
                        invoke.resolve(snapshotValue())
                    } catch (exception: Exception) { state = "not_configured"; fail(invoke, exception) }
                }
            } catch (exception: Exception) { main.post { state = "not_configured"; fail(invoke, exception) } }
        }
    }

    @Command fun permissions(invoke: Invoke) {
        val aliases = if (Build.VERSION.SDK_INT >= 31) arrayOf("bluetooth", "location") else arrayOf("location")
        requestPermissionForAliases(aliases, invoke, "permissionResult")
    }

    @PermissionCallback fun permissionResult(invoke: Invoke) = guarded(invoke) { snapshotValue() }

    @Command fun scan(invoke: Invoke) = guarded(invoke) {
        require(initialized) { "Configure Plaud developer access first." }
        require(getPermissionState("location") == PermissionState.GRANTED) { "Allow nearby device and location access first." }
        if (Build.VERSION.SDK_INT >= 31) require(getPermissionState("bluetooth") == PermissionState.GRANTED) { "Allow Bluetooth access first." }
        require(activity.getSystemService(BluetoothManager::class.java).adapter?.isEnabled == true) { "Turn Bluetooth on to find the Note Pro." }
        check(!downloading) { "A recording is being downloaded." }
        check(state !in setOf("connecting", "authenticating", "ready")) { "Finish the current connection first." }
        devices.clear()
        state = "scanning"; error = null
        PlaudDeviceAgent.startScan()
        snapshotValue()
    }

    @Command fun connect(invoke: Invoke) = guarded(invoke) {
        val sn = invoke.getArgs().getString("serial")
        val device = devices[sn] ?: error("Scan for the device again.")
        check(!downloading) { "A recording is being downloaded." }
        check(initialized && state !in setOf("connecting", "ready")) { "Finish the current connection first." }
        PlaudDeviceAgent.stopScan()
        serial = sn; listLoaded = false; files = JSONArray(); state = "connecting"; error = null
        val attempt = ++generation
        worker.execute {
            try {
                runBlocking { identity.prepare(sn) }
                main.post { if (generation == attempt) PlaudDeviceAgent.connectBleDevice(device) }
            } catch (exception: Exception) { main.post { if (generation == attempt) { state = "disconnected"; setError(exception.message ?: "Device authorization failed.") } } }
        }
        main.postDelayed({ if (attempt == generation && state == "connecting") {
            generation++; state = "disconnected"; PlaudDeviceAgent.disconnect()
            setError("The Note Pro handshake timed out. Check its existing app binding.")
        } }, 60_000)
        snapshotValue()
    }

    @Command fun refresh(invoke: Invoke) = guarded(invoke) { queryFiles(); snapshotValue() }

    @Command fun download(invoke: Invoke) = guarded(invoke) {
        check(state == "ready" && !downloading) { "Connect and finish the current transfer first." }
        val id = invoke.getArgs().getString("sessionId").toLong()
        require((0 until files.length()).any { files.getJSONObject(it).getString("sessionId") == id.toString() }) { "Refresh the device recording list first." }
        val sn = serial ?: error("No device selected.")
        if (runCatching { store.file("$sn:$id") }.isSuccess) return@guarded snapshotValue()
        downloading = true; progress = 0; error = null
        lastProgressAt = android.os.SystemClock.elapsedRealtime()
        val attempt = ++generation
        val output = File(activity.cacheDir, "plaud-export-$attempt").apply { mkdirs() }
        val channels = devices[sn]?.audioChannel?.takeIf { it in 1..2 } ?: 1
        PlaudDeviceAgent.exportAudio(id, output, AudioExportFormat.OPUS, channels, exportCallback(sn, id, attempt))
        watchDownload(attempt, lastProgressAt)
        snapshotValue()
    }

    private fun exportCallback(sn: String, id: Long, attempt: Int) = object : AudioExporter.ExportCallback {
        override fun onProgress(value: Int, message: String) { main.post { if (generation == attempt) {
            progress = value.coerceIn(0, 100); lastProgressAt = android.os.SystemClock.elapsedRealtime()
        } } }
        override fun onError(message: String) { main.post { if (generation == attempt) { generation++; downloading = false; setError("Audio download failed. Reconnect and retry.") } } }
        override fun onComplete(outputFile: File) {
            worker.execute {
                if (generation != attempt) return@execute
                try {
                    store.retain(sn, id, outputFile)
                    main.post { if (generation == attempt) { downloading = false; progress = 100; error = null } }
                } catch (exception: Exception) { main.post { if (generation == attempt) { downloading = false; setError(exception.message ?: "Audio could not be saved.") } } }
            }
        }
    }

    private fun watchDownload(attempt: Int, startedAt: Long) {
        main.postDelayed({
            if (generation == attempt && downloading) {
                val now = android.os.SystemClock.elapsedRealtime()
                if (now - lastProgressAt > 90_000 || now - startedAt > 15 * 60_000) {
                    generation++; downloading = false; PlaudDeviceAgent.stopSyncFile()
                    setError("Audio transfer timed out. Keep the Note Pro nearby and retry.")
                } else watchDownload(attempt, startedAt)
            }
        }, 5000)
    }

    @Command fun upload(invoke: Invoke) {
        val args = invoke.getArgs()
        worker.execute {
            try {
                vault.configure(args.getString("origin"), args.getString("pairingToken"))
                val result = vault.upload(store, args.getString("sourceRecordingId"))
                main.post { invoke.resolve(JSObject(result.toString())) }
            } catch (exception: Exception) { main.post { fail(invoke, exception) } }
        }
    }

    @Command fun play(invoke: Invoke) = guarded(invoke) {
        val id = invoke.getArgs().getString("sourceRecordingId")
        player?.release()
        player = MediaPlayer().apply {
            setDataSource(store.file(id).absolutePath)
            setOnPreparedListener { it.start(); playingId = id }
            setOnCompletionListener { playingId = null }
            setOnErrorListener { _, _, _ -> playingId = null; setError("This audio could not be played."); true }
            prepareAsync()
        }
        snapshotValue()
    }

    @Command fun stopPlayback(invoke: Invoke) = guarded(invoke) { player?.release(); player = null; playingId = null; snapshotValue() }
    @Command fun cancel(invoke: Invoke) = guarded(invoke) {
        generation++; PlaudDeviceAgent.stopSyncFile(); downloading = false; progress = 0
        setError("Download cancelled. The recording remains on your Note Pro."); snapshotValue()
    }
    @Command fun disconnect(invoke: Invoke) = guarded(invoke) {
        check(!downloading) { "Cancel the transfer first." }
        generation++; PlaudDeviceAgent.stopScan(); PlaudDeviceAgent.disconnect(); state = "disconnected"; listLoaded = false; snapshotValue()
    }

    private fun queryFiles() {
        check(state == "ready" && !downloading) { "Authenticate the Note Pro before reading recordings." }
        listLoaded = false; error = null
        val attempt = ++generation
        PlaudDeviceAgent.getFileList()
        main.postDelayed({ if (attempt == generation && !listLoaded) setError("The Note Pro did not return its recording list. Retry when recording has stopped.") }, 20_000)
    }

    private val listener = object : PlaudDeviceAgentListener {
        override fun bleScanResult(found: List<BleDevice>) { main.post { found.filter { it.serialNumber?.startsWith("881") == true }.forEach { devices[it.serialNumber] = it } } }
        override fun bleScanOverTime() { main.post { if (state == "scanning") state = "disconnected" } }
        override fun bleConnectState(value: Int) { main.post {
            if (value == 0 || value == 2) {
                generation++; listLoaded = false
                if (state == "connecting") setError("The Note Pro rejected the connection. Check its account binding and retry.")
                state = "disconnected"
                if (downloading) { downloading = false; setError("Device disconnected during transfer. Retry to download again.") }
            }
        } }
        override fun bleBind(sn: String?, status: Int, protVersion: Int, timezone: Int) { main.post {
            if (state != "connecting" || sn != serial) return@post
            if (status == 0 && sn == serial) finishBinding(sn!!)
            else { generation++; state = "disconnected"; PlaudDeviceAgent.disconnect(); setError("The Note Pro rejected authentication (status $status). Check its account binding.") }
        } }
        override fun bleFileList(recordings: List<BleFile>) { main.post {
            if (state != "ready" || downloading) return@post
            files = JSONArray(recordings.map { JSONObject().put("sessionId", it.sessionId.toString()).put("size", it.fileSize).put("scene", it.scene) })
            listLoaded = true; error = null
        } }
        override fun blePowerChange(power: Int, oldPower: Int) { main.post { battery = power } }
        override fun bleChargingState(isCharging: Boolean, level: Int) { main.post { battery = level } }
        override fun bleRecordStop(sessionId: Long, reason: Int, fileExist: Boolean, fileSize: Long) { main.postDelayed({ if (state == "ready" && !downloading) queryFiles() }, 1500) }
    }

    private fun finishBinding(sn: String) {
        val attempt = generation
        worker.execute {
            try {
                identity.bind(sn)
                main.post { if (generation == attempt) { state = "ready"; error = null; queryFiles(); PlaudDeviceAgent.getChargingState() } }
            } catch (exception: Exception) { main.post { if (generation == attempt) { state = "disconnected"; PlaudDeviceAgent.disconnect(); setError(exception.message ?: "Device binding failed.") } } }
        }
    }

    private fun snapshotValue(): JSObject = JSObject().apply {
        put("state", state); put("error", error ?: JSONObject.NULL); put("serial", serial ?: JSONObject.NULL)
        put("battery", battery ?: JSONObject.NULL); put("listLoaded", listLoaded); put("files", files)
        put("downloading", downloading); put("progress", progress); put("localRecordings", store.list())
        put("playingId", playingId ?: JSONObject.NULL)
        put("devices", JSONArray(devices.values.map { JSONObject().put("serial", it.serialNumber).put("name", "Plaud Note Pro").put("rssi", it.rssi) }))
    }

    private fun guarded(invoke: Invoke, block: () -> JSObject) {
        try { invoke.resolve(block()) } catch (exception: Exception) { fail(invoke, exception) }
    }
    private fun fail(invoke: Invoke, exception: Exception) { setError(exception.message ?: "Plaud request failed."); invoke.reject(error) }
    private fun setError(message: String) { error = message.take(240) }

    override fun onDestroy(activity: AppCompatActivity) {
        generation++; main.removeCallbacksAndMessages(null)
        player?.release(); player = null
        if (initialized) { PlaudDeviceAgent.stopScan(); PlaudDeviceAgent.stopSyncFile(); PlaudDeviceAgent.disconnect() }
        worker.shutdown()
        super.onDestroy(activity)
    }
}
