package com.openplod.vault

import kotlinx.coroutines.delay
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import sdk.NiceBuildSdk
import java.util.concurrent.TimeUnit

class PlaudIdentity {
    private var domain = ""
    private var userToken = ""
    private val client = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build()

    fun configure(session: JSONObject) {
        domain = session.getString("domain")
        require(domain in setOf("platform-us.plaud.ai", "platform-jp.plaud.ai", "platform.plaud.ai")) { "Unsupported Plaud developer region." }
        userToken = session.getString("userAccessToken")
    }

    suspend fun prepare(serial: String) {
        val deadline = android.os.SystemClock.elapsedRealtime() + 15_000
        while (!NiceBuildSdk.isPartnerDataReady() && android.os.SystemClock.elapsedRealtime() < deadline) delay(200)
        check(NiceBuildSdk.isPartnerDataReady()) { "Plaud device encryption keys are not ready. Check developer access and retry." }
        check(NiceBuildSdk.signAndStoreDeviceSn("notepro", serial)) { "Plaud could not authorize this Note Pro serial number." }
    }

    fun bind(serial: String) {
        val body = JSONObject().put("type", "notepro").put("sn", serial).toString()
        val request = Request.Builder().url("https://$domain/developer/api/open/partner/sdk/bind")
            .header("Authorization", "Bearer $userToken")
            .post(body.toRequestBody("application/json".toMediaType())).build()
        client.newCall(request).execute().use {
            check(it.isSuccessful) { "Plaud binding failed (HTTP ${it.code}). Release the previous app binding first." }
        }
    }
}
