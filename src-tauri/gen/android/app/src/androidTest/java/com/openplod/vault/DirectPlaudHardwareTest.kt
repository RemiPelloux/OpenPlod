package com.openplod.vault

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
import java.io.File
import android.media.MediaPlayer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class DirectPlaudHardwareTest {
    @Test fun enrollmentPublicKey() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.noBackupFilesDir, "enrollment-public.txt").writeText(DirectPlaudIdentity(context).enrollmentKey())
    }
    @Test fun downloadRealRecording() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val envelopeFile = File(context.noBackupFilesDir, "enrollment-envelope.json")
        val identity = DirectPlaudIdentity(context)
        if (envelopeFile.exists()) {
            val data = JSONObject(envelopeFile.readText())
            identity.accept(data.getJSONObject("envelope"), data.getString("id"))
            assertTrue(envelopeFile.delete())
        }
        assertTrue("Provision the phone through the encrypted enrollment flow first", identity.configured())
        val credentials = identity.read()
        val store = PlaudStore(context)
        DirectPlaudConnection(DirectPlaudTransport(context), credentials).use { connection ->
            connection.establish {}
            val sessions = connection.list()
            assertTrue("No completed recordings returned by real device", sessions.isNotEmpty())
            val session = sessions.filter { it.size > 512 }.minByOrNull { it.size }!!
            val file = connection.download(session, File(context.noBackupFilesDir, "plaud-transfers")) {}
            val row = store.retain(credentials.getString("serial"), session.sessionId, file)
            assertTrue(row.getLong("durationMs") > 0)
            val player = MediaPlayer()
            try {
                player.setDataSource(store.file(row.getString("sourceRecordingId")).absolutePath)
                player.prepare(); assertTrue(player.duration > 0); player.start(); Thread.sleep(1500)
                assertTrue("Audio playback did not advance", player.currentPosition > 0)
            } finally { player.release() }
            assertTrue(connection.list().any { it.sessionId == session.sessionId && it.size == session.size })
            File(context.noBackupFilesDir, "hardware-result.json").writeText(JSONObject().put("transport", "android-direct-bluetooth")
                .put("recordingCount", sessions.size).put("bytes", session.size).put("durationMs", row.getLong("durationMs"))
                .put("fingerprint", row.getString("fingerprint")).put("sourceRetained", true).put("playbackAdvanced", true).toString())
        }
    }
}
