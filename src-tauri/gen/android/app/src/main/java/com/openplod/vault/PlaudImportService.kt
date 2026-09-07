package com.openplod.vault

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat

class PlaudImportService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            val controller = DirectPlaudController.get(this@PlaudImportService)
            if (!controller.preferences.getBoolean("autoImport", false)) { stopSelf(); return }
            controller.run(automatic = true)
            handler.postDelayed(this, 60000)
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        channels(this)
        startForeground(4100, NotificationCompat.Builder(this, "plaud-import").setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("OpenPlod auto-import").setContentText("Checking your authorized Plaud. Originals stay on the device.").setOngoing(true).build())
        handler.removeCallbacks(tick); handler.post(tick)
        return START_NOT_STICKY
    }
    override fun onDestroy() { handler.removeCallbacks(tick); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
    companion object {
        private fun channels(context: Context) {
            if (android.os.Build.VERSION.SDK_INT >= 26) context.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("plaud-import", "Plaud imports", NotificationManager.IMPORTANCE_LOW))
        }
        fun notifySaved(context: Context) {
            channels(context)
            runCatching { context.getSystemService(NotificationManager::class.java).notify(4101,
                NotificationCompat.Builder(context, "plaud-import").setSmallIcon(android.R.drawable.stat_sys_download_done).setContentTitle("Plaud recording saved")
                    .setContentText("Playable audio is stored on this phone. Original retained on Plaud.").setAutoCancel(true).build()) }
        }
    }
}
