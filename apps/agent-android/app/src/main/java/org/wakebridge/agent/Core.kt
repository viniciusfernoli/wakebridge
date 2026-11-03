package org.wakebridge.agent

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object Core {
    const val DISCOVERY_PORT = 34780

    fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }

    fun randomHex(size: Int) = ByteArray(size).also { SecureRandom().nextBytes(it) }.let(::hex)

    fun sha(value: String) =
        hex(MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)))

    fun sign(secret: String, value: String): String {
        val key = Base64.getUrlDecoder().decode(secret)
        require(key.size == 32)
        return hex(
            Mac.getInstance("HmacSHA256")
                .apply { init(SecretKeySpec(key, "HmacSHA256")) }
                .doFinal(value.toByteArray(Charsets.UTF_8))
        )
    }

    fun transcript(
        ticket: String,
        from: String,
        to: String,
        nonce: String,
        responseNonce: String,
        kind: String,
    ) = "wakebridge|2|$ticket|$from|$to|$nonce|$responseNonce|$kind"

    fun ip(value: String): Long {
        val p = value.split('.')
        require(p.size == 4 && p.all { it.matches(Regex("[0-9]{1,3}")) && it.toInt() <= 255 })
        return p.fold(0L) { n, b -> (n shl 8) or b.toLong() }
    }

    fun privateAddress(value: String): Boolean {
        val n = ip(value)
        return n ushr 24 == 10L || n ushr 20 == 0xAC1L || n ushr 16 == 0xC0A8L
    }

    fun broadcast(address: String, prefix: Int): String {
        require(prefix in 1..30)
        val result = ip(address) or (0xffffffffL ushr prefix)
        return listOf(24, 16, 8, 0).joinToString(".") { ((result ushr it) and 255).toString() }
    }

    fun validateSubnet(local: String, target: String, broadcast: String, prefix: Int): Boolean =
        try {
            prefix in 1..30 &&
                privateAddress(local) &&
                privateAddress(target) &&
                ip(local) ushr (32 - prefix) == ip(target) ushr (32 - prefix) &&
                broadcast(local, prefix) == broadcast &&
                target != broadcast
        } catch (_: IllegalArgumentException) {
            false
        }

    fun magicPacket(mac: String): ByteArray {
        require(mac.matches(Regex("([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}")))
        val bytes = mac.split(':').map { it.toInt(16).toByte() }.toByteArray()
        require(bytes[0].toInt() and 1 == 0 && bytes.any { it.toInt() != 0 })
        return ByteArray(102) { if (it < 6) 0xff.toByte() else bytes[(it - 6) % 6] }
    }

    fun sendDatagram(
        local: String,
        destination: String,
        port: Int,
        data: ByteArray,
        bindNetwork: ((DatagramSocket) -> Unit)? = null,
    ) {
        DatagramSocket(null).use { socket ->
            socket.reuseAddress = false
            bindNetwork?.invoke(socket)
            socket.bind(InetSocketAddress(InetAddress.getByName(local), 0))
            socket.broadcast = true
            socket.soTimeout = 1000
            socket.send(DatagramPacket(data, data.size, InetAddress.getByName(destination), port))
        }
    }
}
