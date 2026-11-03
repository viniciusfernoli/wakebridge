package org.wakebridge.agent

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

data class Identity(val server: String, val deviceId: String, val token: String)

class SecretStore(context: Context) {
    val prefs = context.getSharedPreferences("wakebridge", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (store.getKey("wakebridge-agent", null) as? SecretKey)
            ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
                .apply {
                    init(
                        KeyGenParameterSpec.Builder(
                                "wakebridge-agent",
                                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                            )
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .build()
                    )
                }
                .generateKey()
    }

    fun save(identity: Identity) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val bytes =
            JSONObject()
                .put("server", identity.server)
                .put("deviceId", identity.deviceId)
                .put("token", identity.token)
                .toString()
                .toByteArray(Charsets.UTF_8)
        check(
            prefs
                .edit()
                .putString(
                    "credential",
                    Base64.encodeToString(cipher.iv + cipher.doFinal(bytes), Base64.NO_WRAP),
                )
                .commit()
        )
    }

    fun read(): Identity? =
        try {
            prefs.getString("credential", null)?.let {
                val bytes = Base64.decode(it, Base64.NO_WRAP)
                require(bytes.size > 28)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(
                    Cipher.DECRYPT_MODE,
                    key(),
                    GCMParameterSpec(128, bytes.copyOfRange(0, 12)),
                )
                val json =
                    JSONObject(
                        String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
                    )
                Identity(
                    json.getString("server"),
                    json.getString("deviceId"),
                    json.getString("token"),
                )
            }
        } catch (_: Exception) {
            null
        }

    fun status(message: String) {
        prefs.edit().putString("status", message).apply()
    }

    @Synchronized
    fun markCommand(id: String, expiresAt: Long): Boolean {
        val journal =
            try {
                JSONObject(prefs.getString("commands", "{}")!!)
            } catch (_: Exception) {
                return false
            }
        val now = System.currentTimeMillis()
        journal.keys().asSequence().toList().forEach {
            if (journal.optLong(it) < now) journal.remove(it)
        }
        if (journal.has(id) || journal.length() >= 2048) return false
        journal.put(id, expiresAt)
        return prefs.edit().putString("commands", journal.toString()).commit()
    }
}
