package org.wakebridge.agent

import android.Manifest
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.WindowInsets
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout

class MainActivity : AppCompatActivity(), SharedPreferences.OnSharedPreferenceChangeListener {
    private lateinit var store: SecretStore
    private lateinit var content: LinearLayout
    private lateinit var status: TextView
    private lateinit var code: TextView
    private lateinit var lan: MaterialSwitch

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        store = SecretStore(this)
        val tv =
            resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK ==
                Configuration.UI_MODE_TYPE_TELEVISION
        val scroll = ScrollView(this).apply { isFillViewport = true }
        content =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                val pad = dp(if (tv) 48 else 24)
                setPadding(pad, pad, pad, pad)
            }
        scroll.addView(content)
        setContentView(scroll)
        scroll.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars =
                    insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                view.setPadding(
                    insets.systemWindowInsetLeft,
                    insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight,
                    insets.systemWindowInsetBottom,
                )
            }
            insets
        }
        text("WakeBridge", 30f)
        text("Conecte este aparelho ao seu espaço", 21f)
        text(
            "O aparelho pode acordar seus computadores enquanto permanecer online. O modo de espera da TV ou do fabricante pode interromper o relé.",
            15f,
        )
        status =
            text(store.prefs.getString("status", "Pronto para parear")!!, 16f).apply {
                accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            }
        code =
            text(store.prefs.getString("pairCode", "")!!, 32f).apply {
                setTextIsSelectable(true)
                contentDescription = "Código temporário de pareamento"
            }
        val server = field("URL HTTPS do servidor", store.prefs.getString("server", "") ?: "", true)
        val name =
            field("Nome deste aparelho", "${Build.MANUFACTURER} ${Build.MODEL}".take(80), false)
        button("Gerar código de pareamento") {
            try {
                val origin = AgentApi.origin(server.text.toString())
                require(name.text.toString().trim().isNotEmpty())
                startForegroundService(
                    Intent(this, RelayService::class.java)
                        .setAction("PAIR")
                        .putExtra("server", origin)
                        .putExtra("name", name.text.toString().trim())
                )
            } catch (_: Exception) {
                status.text = "Informe uma URL HTTPS válida e um nome para este aparelho."
            }
        }
        lan =
            MaterialSwitch(this).apply {
                text = "Autorizar descoberta e pacotes WoL nesta LAN"
                isChecked = store.prefs.getBoolean("lan", false)
                minHeight = dp(56)
                setOnCheckedChangeListener { _, checked ->
                    if (
                        checked &&
                            Build.VERSION.SDK_INT >= 37 &&
                            checkSelfPermission(Manifest.permission.ACCESS_LOCAL_NETWORK) !=
                                PackageManager.PERMISSION_GRANTED
                    ) {
                        isChecked = false
                        requestPermissions(arrayOf(Manifest.permission.ACCESS_LOCAL_NETWORK), 70)
                    } else {
                        store.prefs.edit().putBoolean("lan", checked).apply()
                        restartIfRunning()
                    }
                }
            }
        content.addView(lan)
        val boot =
            MaterialSwitch(this).apply {
                text = "Tentar iniciar após ligar o aparelho"
                isChecked = store.prefs.getBoolean("boot", false)
                minHeight = dp(56)
                setOnCheckedChangeListener { _, checked ->
                    store.prefs.edit().putBoolean("boot", checked).apply()
                }
            }
        content.addView(boot)
        button("Iniciar conexão") {
            try {
                startForegroundService(Intent(this, RelayService::class.java).setAction("START"))
            } catch (_: Exception) {
                status.text =
                    "O Android bloqueou o início do serviço. Tente novamente com este aplicativo aberto."
            }
        }
        button("Parar conexão") {
            startService(Intent(this, RelayService::class.java).setAction("STOP"))
        }
        button("Abrir otimizações de bateria") {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: Exception) {
                status.text =
                    "Abra Configurações do Android → Aplicativos → WakeBridge para conferir as restrições."
            }
        }
        text(
            "Permitir execução em segundo plano pode ajudar, mas não garante que o aparelho funcione em standby. O WakeBridge respeita as restrições do Android e não exige root.",
            14f,
        )
        if (
            Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
                    PackageManager.PERMISSION_GRANTED
        )
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 71)
        store.prefs.registerOnSharedPreferenceChangeListener(this)
    }

    private fun restartIfRunning() {
        if (store.prefs.getBoolean("running", false) && store.read() != null)
            startForegroundService(Intent(this, RelayService::class.java).setAction("START"))
    }

    private fun text(value: String, size: Float): TextView =
        TextView(this).apply {
            text = value
            textSize = size
            setPadding(0, dp(8), 0, dp(12))
            content.addView(this)
        }

    private fun field(label: String, value: String, uri: Boolean): TextInputEditText {
        val wrapper =
            TextInputLayout(this).apply {
                hint = label
                layoutParams =
                    LinearLayout.LayoutParams(-1, -2).apply {
                        topMargin = dp(12)
                        bottomMargin = dp(8)
                    }
            }
        val input =
            TextInputEditText(wrapper.context).apply {
                setText(value)
                isSingleLine = true
                minHeight = dp(56)
                inputType =
                    if (uri)
                        android.text.InputType.TYPE_CLASS_TEXT or
                            android.text.InputType.TYPE_TEXT_VARIATION_URI
                    else android.text.InputType.TYPE_CLASS_TEXT
            }
        wrapper.addView(input)
        content.addView(wrapper)
        return input
    }

    private fun button(label: String, action: () -> Unit) {
        content.addView(
            MaterialButton(this).apply {
                text = label
                minHeight = dp(52)
                layoutParams =
                    LinearLayout.LayoutParams(-1, -2).apply {
                        topMargin = dp(8)
                        bottomMargin = dp(8)
                    }
                setOnClickListener { action() }
            }
        )
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 70) {
            val allowed = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
            store.prefs.edit().putBoolean("lan", allowed).apply()
            lan.isChecked = allowed
            if (!allowed)
                status.text =
                    "Acesso à LAN negado. A conexão com o servidor pode continuar, mas este aparelho não enviará pacotes locais."
        }
    }

    override fun onSharedPreferenceChanged(prefs: SharedPreferences, key: String?) {
        runOnUiThread {
            status.text = prefs.getString("status", "Pronto para parear")
            code.text = prefs.getString("pairCode", "")
        }
    }

    override fun onDestroy() {
        store.prefs.unregisterOnSharedPreferenceChangeListener(this)
        super.onDestroy()
    }
}
