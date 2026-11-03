package org.wakebridge.agent

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import org.junit.Assert.*
import org.junit.Test

class CoreTest {
    @Test
    fun magicPacketHasCorrectHeaderAndSixteenMacCopies() {
        val packet = Core.magicPacket("02:11:22:33:44:55")
        assertEquals(102, packet.size)
        assertTrue(packet.take(6).all { it == 0xff.toByte() })
        for (i in 0..15) assertArrayEquals(
            byteArrayOf(2, 17, 34, 51, 68, 85),
            packet.copyOfRange(6 + i * 6, 12 + i * 6),
        )
    }

    @Test
    fun refusesMulticastAndZeroMac() {
        for (mac in listOf("ff:ff:ff:ff:ff:ff", "00:00:00:00:00:00", "shell:whoami")) {
            try {
                Core.magicPacket(mac)
                fail("unsafe MAC accepted")
            } catch (_: IllegalArgumentException) {}
        }
    }

    @Test
    fun subnetChecksAreBoundedToDirectPrivateBroadcast() {
        assertTrue(Core.validateSubnet("192.168.7.10", "192.168.7.20", "192.168.7.255", 24))
        assertFalse(Core.validateSubnet("192.168.7.10", "192.168.8.20", "192.168.8.255", 24))
        assertFalse(Core.validateSubnet("8.8.8.8", "8.8.8.9", "8.8.8.255", 24))
        assertFalse(Core.validateSubnet("10.0.0.1", "10.0.0.2", "255.255.255.255", 32))
    }

    @Test
    fun realUdpTransportCarriesMagicPacket() {
        DatagramSocket(0, InetAddress.getLoopbackAddress()).use { receiver ->
            receiver.soTimeout = 2000
            val bytes = Core.magicPacket("02:11:22:33:44:55")
            Core.sendDatagram("127.0.0.1", "127.0.0.1", receiver.localPort, bytes)
            val incoming = DatagramPacket(ByteArray(200), 200)
            receiver.receive(incoming)
            assertArrayEquals(bytes, incoming.data.copyOf(incoming.length))
        }
    }

    @Test
    fun pairSecretsAndTranscriptsAreDeterministic() {
        val secret = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32))
        val t = Core.transcript("ticket", "from", "to", "nonce", "response", "reply")
        assertEquals(64, Core.sign(secret, t).length)
        assertNotEquals(Core.sign(secret, t), Core.sign(secret, t + "changed"))
    }
}
