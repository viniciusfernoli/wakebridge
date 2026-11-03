package org.wakebridge.agent

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

class LanTransport(
    private val identity: Identity,
    private val store: SecretStore,
    private val inventory: Inventory,
    private val emit: (JSONObject) -> Unit,
) : AutoCloseable {
    private data class Probe(
        val payload: JSONObject,
        val expiresAt: Long,
        val initiator: Boolean,
        val used: AtomicBoolean = AtomicBoolean(false),
    )

    private val probes = ConcurrentHashMap<String, Probe>()
    private val workers = Executors.newFixedThreadPool(2)
    private val closed = AtomicBoolean(false)
    private val socket: DatagramSocket? =
        if (inventory.permitted())
            try {
                DatagramSocket(null).apply {
                    reuseAddress = false
                    bind(InetSocketAddress(Core.DISCOVERY_PORT))
                    soTimeout = 1000
                }
            } catch (_: Exception) {
                null
            }
        else null
    val available: Boolean
        get() = socket != null && !closed.get()

    init {
        if (socket != null) workers.execute { receive() }
    }

    private fun signature(secret: String, d: JSONObject) =
        Core.sign(
            secret,
            Core.transcript(
                d.getString("ticketId"),
                d.getString("from"),
                d.getString("to"),
                d.getString("nonce"),
                d.getString("responseNonce"),
                d.getString("kind"),
            ),
        )

    private fun validSignature(secret: String, d: JSONObject) =
        MessageDigest.isEqual(
            signature(secret, d).toByteArray(Charsets.US_ASCII),
            d.getString("signature").toByteArray(Charsets.US_ASCII),
        )

    private fun proof(d: JSONObject) {
        emit(
            JSONObject()
                .put("type", "probe.proof")
                .put("ticketId", d.getString("ticketId"))
                .put("nonce", d.getString("nonce"))
                .put("responseNonce", d.getString("responseNonce"))
                .put("signature", d.getString("signature"))
        )
    }

    fun execute(command: JSONObject) {
        val id = command.optString("commandId")
        val expiry = command.optLong("expiresAt")
        val action = command.optString("action")
        val now = System.currentTimeMillis()
        fun result(status: String, reason: String) {
            emit(
                JSONObject()
                    .put("type", "command.result")
                    .put("commandId", id)
                    .put("status", status)
                    .put("reason", reason)
            )
        }
        if (expiry < now || expiry > now + 30000) {
            if (action == "wake") result("failed", "expired")
            return
        }
        val payload = command.optJSONObject("payload") ?: return
        if (action == "wake") {
            if (!available || !inventory.permitted()) {
                result("failed", "not_authorized")
                return
            }
            try {
                if (
                    !Core.validateSubnet(
                        payload.getString("localAddress"),
                        payload.getString("targetAddress"),
                        payload.getString("broadcast"),
                        payload.getInt("prefixLength"),
                    )
                ) {
                    result("failed", "invalid_payload")
                    return
                }
                val packet = Core.magicPacket(payload.getString("mac"))
                val local = inventory.local(payload)
                if (local == null) {
                    result("failed", "interface_changed")
                    return
                }
                if (!store.markCommand(id, expiry)) {
                    result("failed", "duplicate")
                    return
                }
                Core.sendDatagram(local.address, local.broadcast, 9, packet) {
                    local.network.bindSocket(it)
                }
                result("packet_sent", "udp_sent")
            } catch (_: Exception) {
                result("failed", "udp_failed")
            }
            return
        }
        if (action != "probe.listen" && action != "probe.send") return
        if (
            !available ||
                payload.optString("ticketId") != id ||
                !Core.validateSubnet(
                    payload.optString("localAddress"),
                    payload.optString("peerAddress"),
                    payload.optString("broadcast"),
                    payload.optInt("prefixLength"),
                ) ||
                inventory.local(payload) == null
        )
            return
        probes.entries.removeIf { it.value.expiresAt < now }
        if (probes.size >= 64) return
        val probe = Probe(payload, expiry, action == "probe.send")
        probes[id] = probe
        if (action == "probe.listen")
            emit(JSONObject().put("type", "probe.ready").put("ticketId", id))
        else workers.execute { sendProbe(probe) }
    }

    private fun sendProbe(probe: Probe) {
        try {
            val p = probe.payload
            val local = inventory.local(p) ?: return
            DatagramSocket(null).use { out ->
                local.network.bindSocket(out)
                out.bind(InetSocketAddress(local.address, 0))
                out.broadcast = true
                out.soTimeout = 700
                val nonce = Core.randomHex(16)
                val d =
                    JSONObject()
                        .put("version", 2)
                        .put("kind", "challenge")
                        .put("ticketId", p.getString("ticketId"))
                        .put("from", identity.deviceId)
                        .put("to", p.getString("peerDeviceId"))
                        .put("nonce", nonce)
                        .put("responseNonce", "")
                d.put("signature", signature(p.getString("secret"), d))
                val data = d.toString().toByteArray(Charsets.UTF_8)
                repeat(3) {
                    if (closed.get() || System.currentTimeMillis() > probe.expiresAt) return
                    out.send(
                        DatagramPacket(
                            data,
                            data.size,
                            java.net.InetAddress.getByName(local.broadcast),
                            Core.DISCOVERY_PORT,
                        )
                    )
                    val packet = DatagramPacket(ByteArray(2049), 2049)
                    try {
                        out.receive(packet)
                    } catch (_: SocketTimeoutException) {
                        return@repeat
                    }
                    if (
                        packet.length > 2048 ||
                            packet.address.hostAddress != p.getString("peerAddress")
                    )
                        return@repeat
                    val reply = JSONObject(String(packet.data, 0, packet.length, Charsets.UTF_8))
                    if (
                        reply.optInt("version") == 2 &&
                            reply.optString("kind") == "reply" &&
                            reply.optString("ticketId") == p.getString("ticketId") &&
                            reply.optString("from") == p.getString("peerDeviceId") &&
                            reply.optString("to") == identity.deviceId &&
                            reply.optString("nonce") == nonce &&
                            reply.optString("responseNonce").matches(Regex("[a-f0-9]{32}")) &&
                            validSignature(p.getString("secret"), reply)
                    ) {
                        proof(reply)
                        return
                    }
                }
            }
        } catch (_: Exception) {
            /* A missing proof expires at the coordinator; no connectivity is inferred. */
        }
    }

    private fun receive() {
        val input = socket ?: return
        var window = System.currentTimeMillis()
        var count = 0
        while (!closed.get()) {
            try {
                val packet = DatagramPacket(ByteArray(2049), 2049)
                input.receive(packet)
                val now = System.currentTimeMillis()
                if (now - window > 1000) {
                    window = now
                    count = 0
                }
                count++
                if (packet.length > 2048 || count > 40) continue
                val d = JSONObject(String(packet.data, 0, packet.length, Charsets.UTF_8))
                if (
                    d.optInt("version") != 2 ||
                        d.optString("kind") != "challenge" ||
                        d.optString("to") != identity.deviceId ||
                        !d.optString("nonce").matches(Regex("[a-f0-9]{32}")) ||
                        d.optString("responseNonce") != ""
                )
                    continue
                val probe = probes[d.optString("ticketId")] ?: continue
                val p = probe.payload
                if (
                    probe.initiator ||
                        probe.expiresAt < now ||
                        p.optString("peerDeviceId") != d.optString("from") ||
                        p.optString("peerAddress") != packet.address.hostAddress ||
                        !validSignature(p.getString("secret"), d)
                )
                    continue
                val local = inventory.local(p) ?: continue
                if (!probe.used.compareAndSet(false, true)) continue
                val reply =
                    JSONObject()
                        .put("version", 2)
                        .put("kind", "reply")
                        .put("ticketId", d.getString("ticketId"))
                        .put("from", identity.deviceId)
                        .put("to", d.getString("from"))
                        .put("nonce", d.getString("nonce"))
                        .put("responseNonce", Core.randomHex(16))
                reply.put("signature", signature(p.getString("secret"), reply))
                Core.sendDatagram(
                    local.address,
                    packet.address.hostAddress!!,
                    packet.port,
                    reply.toString().toByteArray(Charsets.UTF_8),
                ) {
                    local.network.bindSocket(it)
                }
                proof(reply)
            } catch (_: SocketTimeoutException) {} catch (_: Exception) {
                if (closed.get()) return
            }
        }
    }

    override fun close() {
        closed.set(true)
        socket?.close()
        workers.shutdownNow()
        probes.clear()
    }
}
