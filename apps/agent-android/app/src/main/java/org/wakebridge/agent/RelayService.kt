package org.wakebridge.agent

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

class RelayService : Service() {
    private lateinit var store: SecretStore
    private var connection: AgentConnection? = null
    private val worker = Executors.newSingleThreadExecutor()
    private val pairing = AtomicBoolean(false)
    private val stopped = AtomicBoolean(false)

    override fun onCreate() {
        super.onCreate()
        store = SecretStore(this)
        val channel =
            NotificationChannel(
                "relay",
                "Conexão com dispositivos",
                NotificationManager.IMPORTANCE_LOW,
            )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "STOP") {
            store.prefs.edit().putBoolean("running", false).apply()
            store.status("Serviço parado por você")
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent == null && !store.prefs.getBoolean("running", false)) {
            stopSelf()
            return START_NOT_STICKY
        }
        val stop =
            PendingIntent.getService(
                this,
                2,
                Intent(this, RelayService::class.java).setAction("STOP"),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val open =
            PendingIntent.getActivity(
                this,
                1,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val notification =
            Notification.Builder(this, "relay")
                .setSmallIcon(org.wakebridge.agent.R.drawable.ic_bridge)
                .setContentTitle("WakeBridge em execução")
                .setContentText(
                    "Conexão com seu servidor. Standby pode interromper a disponibilidade."
                )
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(Notification.Action.Builder(null, "Parar", stop).build())
                .build()
        try {
            if (Build.VERSION.SDK_INT >= 34)
                startForeground(
                    1,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
                )
            else startForeground(1, notification)
        } catch (_: Exception) {
            store.status("O Android bloqueou o serviço. Abra o aplicativo para tentar novamente.")
            stopSelf()
            return START_NOT_STICKY
        }
        store.prefs.edit().putBoolean("running", true).apply()
        if (intent?.action == "PAIR") {
            if (!pairing.compareAndSet(false, true)) return START_NOT_STICKY
            val server = intent.getStringExtra("server") ?: ""
            val name = intent.getStringExtra("name") ?: "Android"
            worker.execute {
                try {
                    connection?.close()
                    connection = null
                    val origin = AgentApi.origin(server)
                    val result =
                        AgentApi.post(
                            origin,
                            "pairing/start",
                            JSONObject().put("name", name.take(80)).put("platform", "android"),
                        )
                    val id = result.getString("pairingId")
                    val secret = result.getString("secret")
                    val code = result.getString("code")
                    store.prefs
                        .edit()
                        .putString("pairCode", code)
                        .putString("server", origin)
                        .apply()
                    store.status("Confira o código no dashboard e autorize este aparelho.")
                    val deadline = System.currentTimeMillis() + 300000
                    while (!stopped.get() && System.currentTimeMillis() < deadline) {
                        Thread.sleep(2000)
                        val claim =
                            try {
                                AgentApi.post(
                                    origin,
                                    "pairing/claim",
                                    JSONObject().put("pairingId", id).put("secret", secret),
                                )
                            } catch (_: Exception) {
                                continue
                            }
                        if (claim.optString("status") == "paired") {
                            val identity =
                                Identity(
                                    origin,
                                    claim.getString("deviceId"),
                                    claim.getString("token"),
                                )
                            store.save(identity)
                            store.prefs.edit().remove("pairCode").apply()
                            if (!stopped.get()) connection = AgentConnection(this, identity, store)
                            return@execute
                        }
                    }
                    store.status("Código expirado. Gere um novo pareamento.")
                } catch (_: Exception) {
                    store.status("Não foi possível parear. Confira a URL HTTPS e sua conexão.")
                } finally {
                    pairing.set(false)
                }
            }
        } else if (!pairing.get()) {
            val identity = store.read()
            if (identity == null) {
                store.status("Pareie este aparelho para iniciar.")
                stopSelf()
                return START_NOT_STICKY
            }
            connection?.close()
            connection = AgentConnection(this, identity, store)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopped.set(true)
        connection?.close()
        worker.shutdownNow()
        super.onDestroy()
    }
}
