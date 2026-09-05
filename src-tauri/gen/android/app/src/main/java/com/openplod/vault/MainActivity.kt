package com.openplod.vault

import android.content.Intent
import android.database.Cursor
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

class MainActivity : TauriActivity() {
  private data class SharedAudio(
    val id: String,
    val file: File,
    val filename: String,
    val mimeType: String,
    val durationMs: Long,
    val sourcePackage: String,
  )

  @Volatile
  private var pendingShare: SharedAudio? = null
  private var appWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    receiveSharedAudio(intent)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    receiveSharedAudio(intent)
    notifySharedAudioReady()
  }

  override fun onWebViewCreate(webView: WebView) {
    appWebView = webView
    webView.addJavascriptInterface(SharedAudioBridge(), "OpenPlodShare")
    notifySharedAudioReady()
  }

  private fun receiveSharedAudio(intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND || intent.type?.startsWith("audio/") != true) return
    val uri = intent.clipData?.getItemAt(0)?.uri ?: streamUri(intent) ?: return

    runCatching {
      val filename = sanitizeFilename(displayName(uri) ?: "plaud-recording.m4a")
      val inbox = File(filesDir, "shared-audio").apply { mkdirs() }
      val id = UUID.randomUUID().toString()
      val target = File(inbox, "$id-$filename")
      contentResolver.openInputStream(uri)?.use { input ->
        target.outputStream().use { output -> input.copyTo(output) }
      } ?: error("The shared audio stream could not be opened.")

      pendingShare?.file?.delete()
      pendingShare = SharedAudio(
        id = id,
        file = target,
        filename = filename,
        mimeType = intent.type ?: contentResolver.getType(uri) ?: "audio/mp4",
        durationMs = audioDuration(target),
        sourcePackage = shareSource(intent, uri),
      )
    }
  }

  @Suppress("DEPRECATION")
  private fun streamUri(intent: Intent): Uri? = intent.getParcelableExtra(Intent.EXTRA_STREAM)

  private fun displayName(uri: Uri): String? {
    if (uri.scheme == "file") return uri.lastPathSegment
    var cursor: Cursor? = null
    return try {
      cursor = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
      if (cursor?.moveToFirst() == true) cursor.getString(0) else uri.lastPathSegment
    } finally {
      cursor?.close()
    }
  }

  private fun audioDuration(file: File): Long = runCatching {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(file.absolutePath)
      retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
    } finally {
      retriever.release()
    }
  }.getOrDefault(0L)

  private fun shareSource(intent: Intent, uri: Uri): String {
    val namedReferrer = intent.getStringExtra(Intent.EXTRA_REFERRER_NAME)
    return listOfNotNull(namedReferrer, referrer?.authority, uri.authority)
      .firstOrNull { it.isNotBlank() }
      ?: "android-share"
  }

  private fun sanitizeFilename(value: String): String {
    val cleaned = value.replace(Regex("[^a-zA-Z0-9._ -]"), "_").take(160).trim()
    return cleaned.ifBlank { "plaud-recording.m4a" }
  }

  private fun notifySharedAudioReady() {
    appWebView?.post {
      appWebView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('openplod:shared-audio'))",
        null,
      )
    }
  }

  private inner class SharedAudioBridge {
    @JavascriptInterface
    fun metadata(): String {
      val shared = pendingShare ?: return ""
      return JSONObject()
        .put("id", shared.id)
        .put("filename", shared.filename)
        .put("mimeType", shared.mimeType)
        .put("size", shared.file.length())
        .put("durationMs", shared.durationMs)
        .put("sourcePackage", shared.sourcePackage)
        .toString()
    }

    @JavascriptInterface
    fun readChunk(id: String, offset: Long, requestedLength: Int): String {
      val shared = pendingShare ?: return ""
      if (shared.id != id || offset < 0 || offset >= shared.file.length()) return ""
      val length = requestedLength.coerceIn(1, 256 * 1024)
      val bytes = ByteArray(minOf(length.toLong(), shared.file.length() - offset).toInt())
      RandomAccessFile(shared.file, "r").use { input ->
        input.seek(offset)
        input.readFully(bytes)
      }
      return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    @JavascriptInterface
    fun complete(id: String): Boolean {
      val shared = pendingShare ?: return false
      if (shared.id != id) return false
      val deleted = shared.file.delete()
      pendingShare = null
      return deleted || !shared.file.exists()
    }
  }
}
