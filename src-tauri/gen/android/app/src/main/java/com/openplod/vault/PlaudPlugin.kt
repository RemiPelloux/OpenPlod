package com.openplod.vault

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import app.tauri.PermissionState
import app.tauri.annotation.*
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.concurrent.Executors

@TauriPlugin(permissions = [
    Permission(alias = "bluetooth", strings = [Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT]),
    Permission(alias = "location", strings = [Manifest.permission.ACCESS_FINE_LOCATION]),
    Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])
])
class PlaudPlugin(private val activity: Activity) : Plugin(activity) {
    private val controller by lazy { DirectPlaudController.get(activity) }
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val vault = PlaudVaultClient()
    private var player: MediaPlayer? = null
    private var playingId: String? = null
    private fun value() = JSObject(controller.snapshot().put("playingId", playingId ?: org.json.JSONObject.NULL).toString())
    private fun guarded(invoke: Invoke, action: () -> Unit = {}) { try { action(); invoke.resolve(value()) } catch (e: Exception) { invoke.reject(e.message ?: "Plaud operation failed.") } }
    @Command fun snapshot(invoke: Invoke) = guarded(invoke)
    @Command fun initialize(invoke: Invoke) = guarded(invoke) { controller.identity.read() }
    @Command fun permissions(invoke: Invoke) {
        requestPermissionForAliases(if (Build.VERSION.SDK_INT >= 33) arrayOf("bluetooth", "notifications") else if (Build.VERSION.SDK_INT >= 31) arrayOf("bluetooth") else arrayOf("location"), invoke, "permissionResult")
    }
    @PermissionCallback fun permissionResult(invoke: Invoke) = guarded(invoke)
    private fun access() {
        if (Build.VERSION.SDK_INT < 31) check(getPermissionState("location") == PermissionState.GRANTED) { "Allow location access for Bluetooth scanning on this Android version." }
        if (Build.VERSION.SDK_INT >= 31) check(getPermissionState("bluetooth") == PermissionState.GRANTED) { "Allow Bluetooth access." }
    }
    @Command fun scan(invoke: Invoke) = guarded(invoke) { access(); controller.run() }
    @Command fun connect(invoke: Invoke) = scan(invoke)
    @Command fun refresh(invoke: Invoke) = scan(invoke)
    @Command fun download(invoke: Invoke) = guarded(invoke) { access(); controller.run(setOf(invoke.getArgs().getString("sessionId").toLong())) }
    @Command fun cancel(invoke: Invoke) = guarded(invoke) { controller.cancel() }
    @Command fun disconnect(invoke: Invoke) = cancel(invoke)
    @Command fun autoImport(invoke: Invoke) = guarded(invoke) {
        val enabled = invoke.getArgs().getBoolean("enabled")
        if (enabled) { access(); controller.identity.read() }
        controller.preferences.edit().putBoolean("autoImport", enabled).apply()
        val intent = Intent(activity, PlaudImportService::class.java)
        if (!enabled) { activity.stopService(intent); controller.cancel() }
        else if (Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent) else activity.startService(intent)
    }
    @Command fun requestAuthorization(invoke: Invoke) {
        val args = invoke.getArgs()
        worker.execute {
            try {
                vault.configure(args.getString("origin"), args.getString("pairingToken"))
                val result = vault.requestAuthorization(controller.identity.enrollmentKey(), Build.MODEL)
                controller.preferences.edit().putString("enrollmentId", result.getString("id")).apply()
                main.post { invoke.resolve(JSObject(result.toString())) }
            } catch (e: Exception) { main.post { invoke.reject(e.message ?: "Could not request authorization.") } }
        }
    }
    @Command fun finishAuthorization(invoke: Invoke) {
        val args = invoke.getArgs()
        worker.execute {
            try {
                vault.configure(args.getString("origin"), args.getString("pairingToken"))
                val id = controller.preferences.getString("enrollmentId", null) ?: error("Request authorization first.")
                val result = vault.authorization(id)
                check(result.getString("state") == "approved") { "Approve this phone in OpenPlod on your Mac." }
                controller.identity.accept(result.getJSONObject("envelope"), id)
                vault.acknowledgeAuthorization(id)
                controller.preferences.edit().remove("enrollmentId").apply()
                main.post { guarded(invoke) }
            } catch (e: Exception) { main.post { invoke.reject(e.message ?: "Authorization failed.") } }
        }
    }
    @Command fun upload(invoke: Invoke) {
        val args = invoke.getArgs()
        worker.execute {
            try { vault.configure(args.getString("origin"), args.getString("pairingToken")); val result = vault.upload(controller.store, args.getString("sourceRecordingId")); main.post { invoke.resolve(JSObject(result.toString())) } }
            catch (e: Exception) { main.post { invoke.reject(e.message ?: "Upload failed; local audio retained.") } }
        }
    }
    @Command fun play(invoke: Invoke) = guarded(invoke) {
        val id = invoke.getArgs().getString("sourceRecordingId")
        player?.release()
        player = MediaPlayer().apply {
            setDataSource(controller.store.file(id).absolutePath)
            setOnPreparedListener { it.start(); playingId = id }
            setOnCompletionListener { playingId = null }
            setOnErrorListener { _, _, _ -> playingId = null; true }; prepareAsync()
        }
    }
    @Command fun stopPlayback(invoke: Invoke) = guarded(invoke) { player?.release(); player = null; playingId = null }
    @Command fun exportDocument(invoke: Invoke) = guarded(invoke) { val a = invoke.getArgs(); PlaudExports(activity).document(a.getString("filename"), a.getString("content"), a.getString("mime")) }
    @Command fun exportRecording(invoke: Invoke) = guarded(invoke) { PlaudExports(activity).audio(controller.store.file(invoke.getArgs().getString("sourceRecordingId"))) }
    @Command fun exportVaultRecording(invoke: Invoke) {
        val args = invoke.getArgs()
        worker.execute {
            try { vault.configure(args.getString("origin"), args.getString("pairingToken")); val file = vault.exportAudio(File(activity.cacheDir, "document-exports"), args.getString("recordingId"), args.getString("filename")); main.post { guarded(invoke) { PlaudExports(activity).audio(file) } } }
            catch (e: Exception) { main.post { invoke.reject(e.message ?: "Audio export failed.") } }
        }
    }
}
