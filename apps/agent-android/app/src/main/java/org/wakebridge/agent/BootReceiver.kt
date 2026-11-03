package org.wakebridge.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val store = SecretStore(context)
        if (
            !store.prefs.getBoolean("boot", false) ||
                !store.prefs.getBoolean("running", false) ||
                store.read() == null
        )
            return
        try {
            context.startForegroundService(
                Intent(context, RelayService::class.java).setAction("START")
            )
        } catch (_: Exception) {
            store.status(
                "Início após boot bloqueado pelo Android. Abra o aplicativo e toque em Iniciar."
            )
        }
    }
}
