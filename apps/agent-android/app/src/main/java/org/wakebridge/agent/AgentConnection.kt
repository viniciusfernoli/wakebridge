package org.wakebridge.agent

import android.content.Context
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min
import kotlin.random.Random
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

object AgentApi {
    private val client =
        OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .callTimeout(15, TimeUnit.SECONDS)
            .build()

    fun origin(raw: String): String {
        val uri = URI(raw.trim())
        require(
            uri.host != null &&
                uri.userInfo == null &&
                uri.query == null &&
                uri.fragment == null &&
                (uri.path.isNullOrEmpty() || uri.path == "/")
        )
        require(
            uri.scheme == "https" ||
                (BuildConfig.DEBUG &&
                    uri.scheme == "http" &&
                    uri.host in listOf("localhost", "127.0.0.1", "10.0.2.2"))
        )
        return raw.trim().trimEnd('/')
    }

    fun post(server: String, path: String, body: JSONObject): JSONObject {
        val request =
            Request.Builder()
                .url(server + "/api/" + path)
                .post(body.toString().toRequestBody("application/json".toMediaType()))
                .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful)
                throw IllegalStateException("Servidor recusou a solicitação (${response.code}).")
            val text = response.body.string()
            require(text.length <= 65536)
            return JSONObject(text)
        }
    }
}

class AgentConnection(
    context: Context,
    private val identity: Identity,
    private val store: SecretStore,
) : AutoCloseable {
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val commands = Executors.newSingleThreadExecutor()
    private val stopped = AtomicBoolean(false)
    private val inventory = Inventory(context, store)
    private val lan = LanTransport(identity, store, inventory) { send(it) }
    private val client = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build()
    private var socket: WebSocket? = null
    @Volatile private var session = ""
    private var sequence = 0L
    private var delay = 1000L
    @Volatile private var generation = 0
    @Volatile private var lastAck = 0L
    private var heartbeatMs = 5000L
    private var lastEpoch = ""

    init {
        executor.execute { connect() }
        executor.scheduleWithFixedDelay({ heartbeat() }, 1, 1, TimeUnit.SECONDS)
    }

    @Synchronized
    private fun connect() {
        if (stopped.get()) return
        val ownGeneration = ++generation
        session = ""
        sequence = 0
        store.status("Conectando ao servidor…")
        val url =
            identity.server.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") +
                "/api/agent"
        val request = Request.Builder().url(url).build()
        socket =
            client.newWebSocket(
                request,
                object : WebSocketListener() {
                    override fun onOpen(ws: WebSocket, response: Response) {
                        if (ownGeneration != generation || stopped.get()) {
                            ws.cancel()
                            return
                        }
                        val snapshot = inventory.snapshot(lan.available)
                        lastEpoch = snapshot.getString("networkEpoch")
                        ws.send(
                            JSONObject()
                                .put("type", "auth")
                                .put("version", 2)
                                .put("token", identity.token)
                                .put("inventory", snapshot)
                                .toString()
                        )
                        lastAck = System.currentTimeMillis()
                    }

                    override fun onMessage(ws: WebSocket, text: String) {
                        if (ownGeneration != generation || stopped.get()) return
                        try {
                            require(text.length <= 65536)
                            val message = JSONObject(text)
                            require(message.getInt("version") == 2)
                            when (message.getString("type")) {
                                "ready" -> {
                                    require(message.getString("deviceId") == identity.deviceId)
                                    synchronized(this@AgentConnection) {
                                        if (ownGeneration != generation || stopped.get()) return
                                        session = message.getString("sessionId")
                                        heartbeatMs =
                                            message.getLong("heartbeatMs").also {
                                                require(it in 1000..30000)
                                            }
                                        delay = 1000
                                        lastAck = System.currentTimeMillis()
                                    }
                                    store.status(
                                        if (lan.available)
                                            "Online · relé LAN habilitado neste aparelho"
                                        else "Online · participação LAN desativada ou indisponível"
                                    )
                                }
                                "ack" -> {
                                    lastAck = System.currentTimeMillis()
                                }
                                "command" -> {
                                    require(message.getString("sessionId") == session)
                                    commands.execute {
                                        if (
                                            ownGeneration == generation &&
                                                !stopped.get() &&
                                                message.getString("sessionId") == session
                                        )
                                            lan.execute(message)
                                    }
                                }
                                else -> throw IllegalArgumentException("Operação não suportada")
                            }
                        } catch (_: Exception) {
                            ws.close(1008, "invalid_protocol")
                        }
                    }

                    override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                        disconnected(ownGeneration, false)
                    }

                    override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                        disconnected(
                            ownGeneration,
                            code == 1008 ||
                                (code == 4000 &&
                                    (reason == "credential_revoked" ||
                                        reason == "credential_rotated")),
                        )
                    }

                    override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                        ws.close(code, reason)
                    }
                },
            )
    }

    @Synchronized
    private fun disconnected(ownGeneration: Int, revoked: Boolean) {
        if (ownGeneration != generation || stopped.get()) return
        generation++
        session = ""
        socket = null
        if (revoked) {
            store.status("Acesso recusado. Faça um novo pareamento.")
            close()
            return
        }
        store.status("Offline · tentando reconectar automaticamente")
        val wait = delay / 2 + Random.nextLong(delay + 1)
        delay = min(delay * 2, 60000)
        executor.schedule({ connect() }, wait, TimeUnit.MILLISECONDS)
    }

    private var lastBeat = 0L

    @Synchronized
    private fun heartbeat() {
        if (stopped.get()) return
        val now = System.currentTimeMillis()
        if (socket != null && lastAck > 0 && now - lastAck > maxOf(15000, heartbeatMs * 3)) {
            socket?.cancel()
            disconnected(generation, false)
            return
        }
        if (session.isEmpty() || now - lastBeat < heartbeatMs) return
        lastBeat = now
        val current = inventory.snapshot(lan.available)
        if (sequence % 12 == 0L || current.getString("networkEpoch") != lastEpoch) {
            lastEpoch = current.getString("networkEpoch")
            send(JSONObject().put("type", "inventory").put("inventory", current))
        } else send(JSONObject().put("type", "heartbeat"))
    }

    @Synchronized
    private fun send(message: JSONObject) {
        if (session.isEmpty() || stopped.get()) return
        sequence++
        socket?.send(
            message.put("version", 2).put("sessionId", session).put("seq", sequence).toString()
        )
    }

    override fun close() {
        if (!stopped.compareAndSet(false, true)) return
        socket?.close(1000, "stopped")
        lan.close()
        commands.shutdownNow()
        executor.shutdownNow()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }
}
