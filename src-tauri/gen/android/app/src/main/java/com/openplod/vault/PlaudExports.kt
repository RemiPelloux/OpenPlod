package com.openplod.vault

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

class PlaudExports(private val activity: Activity) {
    fun document(filename: String, content: String, mime: String) {
        require(mime in setOf("text/markdown", "text/plain", "application/json")) { "Unsupported document format." }
        require(content.toByteArray().size <= 10 * 1024 * 1024) { "Document is too large to export." }
        val safeName = filename.replace(Regex("[^a-zA-Z0-9._-]"), "_").take(120).ifEmpty { "transcript.md" }
        val directory = File(activity.cacheDir, "document-exports").apply { mkdirs() }
        val file = File(directory, "${System.currentTimeMillis()}-$safeName")
        file.writeText(content)
        share(file, mime)
    }

    fun audio(file: File) = share(file, when (file.extension.lowercase()) {
        "ogg", "opus" -> "audio/ogg"
        "m4a", "mp4" -> "audio/mp4"
        "wav" -> "audio/wav"
        "webm" -> "audio/webm"
        "flac" -> "audio/flac"
        else -> "audio/mpeg"
    })

    private fun share(file: File, mime: String) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newRawUri(file.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.startActivity(Intent.createChooser(intent, "Export recording"))
    }
}
