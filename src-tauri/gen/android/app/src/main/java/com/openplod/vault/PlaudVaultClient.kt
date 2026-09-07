package com.openplod.vault

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.io.File

class PlaudVaultClient {
    private val client = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.MINUTES)
        .readTimeout(5, TimeUnit.MINUTES).writeTimeout(5, TimeUnit.MINUTES)
        .followRedirects(false).followSslRedirects(false).build()
    private var origin = ""
    private var token = ""

    fun configure(address: String, pairingToken: String) {
        val uri = java.net.URI(address)
        require(uri.scheme in listOf("http", "https") && uri.host != null && uri.userInfo == null && uri.query == null) { "Invalid desktop address." }
        require(pairingToken.isNotBlank()) { "Pair the desktop vault first." }
        origin = address.trimEnd('/')
        token = pairingToken
    }

    fun requestAuthorization(publicKey: String, name: String): JSONObject = execute(Request.Builder().url("$origin/api/plaud/authorizations")
        .post(JSONObject().put("publicKey", publicKey).put("name", name).toString().toRequestBody("application/json".toMediaType())))
    fun authorization(id: String): JSONObject { require(id.matches(Regex("[a-f0-9-]{36}"))); return execute(Request.Builder().url("$origin/api/plaud/authorizations/$id")) }
    fun acknowledgeAuthorization(id: String): JSONObject { require(id.matches(Regex("[a-f0-9-]{36}"))); return execute(Request.Builder().url("$origin/api/plaud/authorizations/$id/acknowledge").post("{}".toRequestBody("application/json".toMediaType()))) }

    fun exportAudio(directory: File, id: String, filename: String): File {
        require(id.matches(Regex("[a-zA-Z0-9-]+"))) { "Invalid recording ID." }
        directory.mkdirs()
        val safeName = filename.replace(Regex("[^a-zA-Z0-9._-]"), "_").take(120).ifEmpty { "recording.ogg" }
        val target = File(directory, "${System.currentTimeMillis()}-$safeName")
        val request = Request.Builder().url("$origin/api/recordings/$id/audio").header("X-OpenPlod-Token", token).build()
        client.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "Audio export failed (HTTP ${response.code})." }
            val body = response.body ?: error("Desktop returned no audio.")
            try {
                body.byteStream().use { input -> target.outputStream().use { input.copyTo(it) } }
                check(target.length() > 0) { "Desktop returned empty audio." }
            } catch (error: Exception) { target.delete(); throw error }
        }
        return target
    }

    fun upload(store: PlaudStore, id: String): JSONObject {
        val row = store.row(id)
        val file = store.file(id)
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", file.name, file.asRequestBody((if (file.extension == "ogg") "audio/ogg" else "audio/mpeg").toMediaType()))
            .addFormDataPart("source_provider", "plaud")
            .addFormDataPart("source_recording_id", id)
            .addFormDataPart("recorded_at", row.getString("recordedAt"))
            .addFormDataPart("duration_ms", row.getLong("durationMs").toString())
            .addFormDataPart("fingerprint", row.getString("fingerprint")).build()
        val result = execute(Request.Builder().url("$origin/api/mobile/recordings").post(body))
        val recordingId = result.getString("recordingId")
        require(recordingId.isNotBlank()) { "Desktop returned no recording ID." }
        store.acknowledge(id, recordingId, result.getString("fingerprint"))
        return result
    }

    private fun execute(builder: Request.Builder): JSONObject {
        check(origin.isNotEmpty()) { "Pair the desktop vault first." }
        client.newCall(builder.header("X-OpenPlod-Token", token).build()).execute().use { response ->
            val body = response.body?.string().orEmpty()
            val payload = runCatching { JSONObject(body) }.getOrNull()
            if (!response.isSuccessful || payload?.optBoolean("success") != true) {
                val message = payload?.optString("error")?.take(200)
                error(message?.takeIf { it.isNotBlank() } ?: "Desktop request failed (HTTP ${response.code}).")
            }
            return payload.getJSONObject("data")
        }
    }
}
