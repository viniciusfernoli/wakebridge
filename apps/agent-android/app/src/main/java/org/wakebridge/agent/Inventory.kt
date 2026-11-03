package org.wakebridge.agent

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import java.net.Inet4Address
import java.net.NetworkInterface
import org.json.JSONArray
import org.json.JSONObject

data class LocalInterface(
    val id: String,
    val address: String,
    val prefix: Int,
    val broadcast: String,
    val network: Network,
)

class Inventory(private val context: Context, private val store: SecretStore) {
    private val salt = Core.randomHex(16)

    fun permitted() =
        store.prefs.getBoolean("lan", false) &&
            (Build.VERSION.SDK_INT < 37 ||
                context.checkSelfPermission(Manifest.permission.ACCESS_LOCAL_NETWORK) ==
                    PackageManager.PERMISSION_GRANTED)

    fun interfaces(): List<LocalInterface> {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        return cm.allNetworks
            .flatMap { network ->
                val caps = cm.getNetworkCapabilities(network)
                val props = cm.getLinkProperties(network)
                if (
                    caps == null ||
                        props == null ||
                        !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) ||
                        (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
                            !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
                )
                    emptyList()
                else
                    props.linkAddresses.mapNotNull { a ->
                        val address = a.address
                        if (
                            address !is Inet4Address ||
                                a.prefixLength !in 1..30 ||
                                !Core.privateAddress(address.hostAddress!!)
                        )
                            null
                        else
                            LocalInterface(
                                props.interfaceName ?: "network-${network.networkHandle}",
                                address.hostAddress!!,
                                a.prefixLength,
                                Core.broadcast(address.hostAddress!!, a.prefixLength),
                                network,
                            )
                    }
            }
            .take(32)
    }

    fun epoch(interfaces: List<LocalInterface> = interfaces()) =
        Core.sha(
            salt +
                interfaces
                    .map { "${it.id}:${it.address}/${it.prefix}:${it.network.networkHandle}" }
                    .sorted()
                    .joinToString("|")
        )

    fun snapshot(udpAvailable: Boolean): JSONObject {
        val interfaces = interfaces()
        val enabled = permitted() && udpAvailable
        val nets = JSONArray()
        for ((id, group) in interfaces.groupBy { it.id }) {
            val mac =
                try {
                    NetworkInterface.getByName(id)
                        ?.hardwareAddress
                        ?.takeIf { it.size == 6 }
                        ?.joinToString(":") { "%02X".format(it.toInt() and 255) }
                        ?.takeUnless { it == "02:00:00:00:00:00" }
                } catch (_: Exception) {
                    null
                }
            nets.put(
                JSONObject()
                    .put("nativeId", id)
                    .put("name", id)
                    .put("mac", mac ?: JSONObject.NULL)
                    .put("isUp", true)
                    .put("wolSupport", "unknown")
                    .put(
                        "addresses",
                        JSONArray(
                            group.take(16).map {
                                JSONObject()
                                    .put("address", it.address)
                                    .put("prefixLength", it.prefix)
                                    .put("broadcast", it.broadcast)
                            }
                        ),
                    )
            )
        }
        val memory = android.app.ActivityManager.MemoryInfo()
        context.getSystemService(android.app.ActivityManager::class.java).getMemoryInfo(memory)
        return JSONObject()
            .put("hostname", "${Build.MANUFACTURER} ${Build.MODEL}".take(200))
            .put("osVersion", "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            .put("architecture", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
            .put("agentVersion", BuildConfig.VERSION_NAME)
            .put("cpu", Build.HARDWARE.ifBlank { "unknown" })
            .put("memoryBytes", memory.totalMem)
            .put(
                "capabilities",
                JSONArray(
                    if (enabled) listOf("inventory", "wol", "discovery") else listOf("inventory")
                ),
            )
            .put("lanEnabled", enabled)
            .put("networkEpoch", epoch(interfaces))
            .put("interfaces", nets)
    }

    fun local(payload: JSONObject): LocalInterface? {
        if (!permitted()) return null
        val interfaces = interfaces()
        if (payload.optString("networkEpoch") != epoch(interfaces)) return null
        return interfaces.find {
            it.id == payload.optString("localInterfaceId") &&
                it.address == payload.optString("localAddress") &&
                it.prefix == payload.optInt("prefixLength") &&
                it.broadcast == payload.optString("broadcast")
        }
    }
}
