package com.openplod.vault

import android.media.MediaMetadataRetriever
import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class NativeAudioCompatibilityTest {
    @Test fun markdownExportUsesPrivateReadableShareUri() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        var shared: Intent? = null
        val monitor = object : Instrumentation.ActivityMonitor() {
            override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
                if (intent.action != Intent.ACTION_CHOOSER) return null
                shared = intent.getParcelableExtra(Intent.EXTRA_INTENT)
                return Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null)
            }
        }
        instrumentation.addMonitor(monitor)
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { PlaudExports(it).document("fixture.md", "# Notes\n\nTest fixture", "text/markdown") }
                val intent = requireNotNull(shared)
                assertEquals("text/markdown", intent.type)
                assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
                val uri = requireNotNull(intent.clipData).getItemAt(0).uri
                assertEquals("content", uri.scheme)
                val content = instrumentation.targetContext.contentResolver.openInputStream(uri)!!.bufferedReader().use { it.readText() }
                assertEquals("# Notes\n\nTest fixture", content)
            }
        } finally { instrumentation.removeMonitor(monitor) }
    }

    @Test fun unsafeCommandsAreRejected() {
        assertThrows(IllegalArgumentException::class.java) { DirectPlaudProtocol.chunks(0xfe20, byteArrayOf(1)) }
        assertThrows(IllegalArgumentException::class.java) { DirectPlaudProtocol.command(3, byteArrayOf()) }
    }

    @Test fun androidPlaysOpusWithoutVendorSdk() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val directory = File(context.cacheDir, "opus-compatibility-test").apply { mkdirs() }
        val source = File(directory, "fixture.opus")
        instrumentation.context.assets.open("tone.opus").use { input -> source.outputStream().use { input.copyTo(it) } }
        DirectPlaudProtocol.validateOgg(source.readBytes(), 1)
        val reader = MediaMetadataRetriever()
        try {
            reader.setDataSource(source.path)
            val duration = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLong() ?: 0
            assertTrue("Exported Opus must have playable duration", duration >= 900)
        } finally { reader.release() }
        directory.deleteRecursively()
    }
}
