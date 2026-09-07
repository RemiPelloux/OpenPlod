package com.openplod.vault

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class DirectPlaudController private constructor(private val context: Context) {
    val store = PlaudStore(context)
    val identity = DirectPlaudIdentity(context)
    private val executor = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    @Volatile private var transport: DirectPlaudTransport? = null
    @Volatile private var cancelled = false
    @Volatile private var state = if (identity.configured()) "disconnected" else "not_configured"
    @Volatile private var error: String? = null
    @Volatile private var files = emptyList<DirectSession>()
    @Volatile private var listLoaded = false
    @Volatile private var progress = 0
    @Volatile private var downloading = false
    @Volatile private var serial: String? = null
    @Volatile private var lastNotice: String? = null
    @Volatile private var lastCheck: Long = 0
    val preferences = context.getSharedPreferences("plaud-direct", Context.MODE_PRIVATE)
    fun snapshot(): JSONObject = JSONObject().put("state", state).put("error", error ?: JSONObject.NULL)
        .put("serial", serial ?: JSONObject.NULL).put("battery", JSONObject.NULL).put("listLoaded", listLoaded)
        .put("files", JSONArray(files.map { JSONObject().put("sessionId", it.sessionId.toString()).put("size", it.size).put("scene", it.scene) }))
        .put("devices", JSONArray()).put("localRecordings", store.list()).put("downloading", downloading).put("busy", busy.get())
        .put("progress", progress).put("playingId", JSONObject.NULL).put("configured", identity.configured())
        .put("autoImport", preferences.getBoolean("autoImport", false)).put("lastNotice", lastNotice ?: JSONObject.NULL)
        .put("lastCheck", lastCheck).put("transport", "direct-bluetooth")
    fun run(downloadIds: Set<Long>? = null, automatic: Boolean = false, done: (Exception?) -> Unit = {}) {
        if (!busy.compareAndSet(false, true)) { done(IllegalStateException("A Plaud operation is already running.")); return }
        cancelled = false; error = null; progress = 0; listLoaded = false
        executor.execute {
            try {
                val credentials = identity.read(); serial = credentials.getString("serial")
                var completed = false
                for (attempt in 0..1) {
                    check(!cancelled) { "Transfer cancelled." }
                    val link = DirectPlaudTransport(context); transport = link
                    try {
                        DirectPlaudConnection(link, credentials).use { connection ->
                            connection.establish { state = it }
                            files = connection.list(); listLoaded = true; lastCheck = System.currentTimeMillis()
                            val local = store.list(); val saved = (0 until local.length()).map { local.getJSONObject(it).getString("sourceRecordingId") }.toSet()
                            val queue = files.filter { "$serial:${it.sessionId}" !in saved && (automatic || downloadIds?.contains(it.sessionId) == true) }
                            downloading = queue.isNotEmpty()
                            for (session in queue) {
                                check(!cancelled) { "Transfer cancelled." }
                                val output = connection.download(session, File(context.noBackupFilesDir, "plaud-transfers")) { progress = it }
                                val row = store.retain(serial!!, session.sessionId, output)
                                check(row.getLong("durationMs") > 0) { "Saved audio has no playable duration." }
                                lastNotice = "Recording saved on this phone. Original retained on Plaud."; progress = 100
                                if (automatic) PlaudImportService.notifySaved(context)
                            }
                        }
                        completed = true; break
                    } catch (e: Exception) {
                        if (cancelled || attempt == 1 || !Regex("timed out|disconnected", RegexOption.IGNORE_CASE).containsMatchIn(e.message.orEmpty())) throw e
                    } finally { link.close(); transport = null }
                }
                check(completed); state = "ready"; done(null)
            } catch (e: Exception) { state = if (identity.configured()) "disconnected" else "not_configured"; error = e.message ?: "Plaud operation failed."; done(e) }
            finally { downloading = false; busy.set(false) }
        }
    }
    fun cancel() { cancelled = true; transport?.close() }
    companion object {
        @Volatile private var instance: DirectPlaudController? = null
        fun get(context: Context): DirectPlaudController = instance ?: synchronized(this) { instance ?: DirectPlaudController(context.applicationContext).also { instance = it } }
    }
}
