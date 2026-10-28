package dev.callsign.companion

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.VpnService
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

/**
 * MainActivity: Dummy-proof 1-Button Android UI for the `Callsign` Split-DNS Companion APK.
 *
 * ZERO-TYPING ONBOARDING:
 * 1. Bundled Config: Reads `assets/callsign.json` if packaged by the `Callsign` daemon.
 * 2. Deep-Link QR Scan: Handles `callsign://configure?ip=192.168.1.159&domain=x&id=cs-...`
 *    so scanning the QR code on the dashboard configures and starts the service automatically.
 */
class MainActivity : Activity() {

    companion object {
        private const val PREFS_NAME = "callsign_prefs"
        private const val KEY_DAEMON_IP = "daemon_ip"
        private const val KEY_DOMAIN = "domain"
        private const val KEY_INSTANCE_ID = "instance_id"
        private const val KEY_ENABLED = "vpn_enabled"
        private const val VPN_REQUEST_CODE = 1001
    }

    private lateinit var ipInput: EditText
    private lateinit var domainInput: EditText
    private lateinit var statusLabel: TextView
    private lateinit var toggleButton: Button

    private var isVpnEnabled = false
    private var expectedInstanceId = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        loadBundledAssetsIfFirstRun(prefs)

        var savedIp = prefs.getString(KEY_DAEMON_IP, "192.168.1.159") ?: "192.168.1.159"
        var savedDomain = prefs.getString(KEY_DOMAIN, "x") ?: "x"
        expectedInstanceId = prefs.getString(KEY_INSTANCE_ID, "") ?: ""
        isVpnEnabled = prefs.getBoolean(KEY_ENABLED, false)

        // Check if opened via QR code deep-link: callsign://configure?ip=192.168.1.159&domain=x
        intent?.data?.let { uri ->
            if (uri.scheme == "callsign" && uri.host == "configure") {
                uri.getQueryParameter("ip")?.takeIf { it.isNotBlank() }?.let { savedIp = it.trim() }
                uri.getQueryParameter("domain")?.takeIf { it.isNotBlank() }?.let {
                    savedDomain = it.trim().trim('.').lowercase()
                }
                uri.getQueryParameter("id")?.takeIf { it.isNotBlank() }?.let {
                    expectedInstanceId = it.trim()
                }
                prefs.edit()
                    .putString(KEY_DAEMON_IP, savedIp)
                    .putString(KEY_DOMAIN, savedDomain)
                    .putString(KEY_INSTANCE_ID, expectedInstanceId)
                    .apply()
            }
        }

        buildMinimalistLayout(savedIp, savedDomain)

        // If launched from a QR deep-link, automatically prompt/start VPN immediately
        if (intent?.data?.scheme == "callsign") {
            startVpnFlow()
        }
    }

    private fun loadBundledAssetsIfFirstRun(prefs: android.content.SharedPreferences) {
        if (prefs.contains(KEY_DAEMON_IP)) return
        try {
            val jsonText = assets.open("callsign.json").bufferedReader().use { it.readText() }
            val obj = JSONObject(jsonText)
            prefs.edit()
                .putString(KEY_DAEMON_IP, obj.optString("lanIp", "192.168.1.159"))
                .putString(KEY_DOMAIN, obj.optString("domain", "x"))
                .putString(KEY_INSTANCE_ID, obj.optString("instanceId", ""))
                .apply()
        } catch (_: Exception) {
            // No bundled asset override present; defaults apply
        }
    }

    private fun buildMinimalistLayout(initialIp: String, initialDomain: String) {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(Color.parseColor("#0B0F19"))
            val pad = dp(28)
            setPadding(pad, dp(64), pad, pad)
        }

        val title = TextView(this).apply {
            text = "Callsign"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
            typeface = Typeface.DEFAULT_BOLD
        }
        root.addView(title)

        val subtitle = TextView(this).apply {
            text = "Zero-Config Home Wi-Fi Names (.local & custom domains)"
            setTextColor(Color.parseColor("#94A3B8"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(0, dp(6), 0, dp(32))
        }
        root.addView(subtitle)

        // Card container
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#111827"))
                cornerRadius = dp(16).toFloat()
                setStroke(dp(1), Color.parseColor("#1E293B"))
            }
            val pad = dp(20)
            setPadding(pad, pad, pad, pad)
        }

        statusLabel = TextView(this).apply {
            text = if (isVpnEnabled) "● Active on Home Wi-Fi" else "○ Disconnected"
            setTextColor(
                if (isVpnEnabled) Color.parseColor("#34D399") else Color.parseColor("#94A3B8")
            )
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, dp(16))
        }
        card.addView(statusLabel)

        val ipLabel = TextView(this).apply {
            text = "Home Server IP Address"
            setTextColor(Color.parseColor("#CBD5E1"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        }
        card.addView(ipLabel)

        ipInput = EditText(this).apply {
            setText(initialIp)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#64748B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = Typeface.MONOSPACE
        }
        card.addView(ipInput)

        val domainLabel = TextView(this).apply {
            text = "Custom Domain Ending (without dot)"
            setTextColor(Color.parseColor("#CBD5E1"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(0, dp(12), 0, 0)
        }
        card.addView(domainLabel)

        domainInput = EditText(this).apply {
            setText(initialDomain)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#64748B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = Typeface.MONOSPACE
        }
        card.addView(domainInput)

        toggleButton = Button(this).apply {
            text = if (isVpnEnabled) "Turn Off" else "Enable Home DNS"
            isAllCaps = false
            setTextColor(Color.parseColor("#0B0F19"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = Typeface.DEFAULT_BOLD
            background = GradientDrawable().apply {
                setColor(
                    if (isVpnEnabled) Color.parseColor("#F87171") else Color.parseColor("#38BDF8")
                )
                cornerRadius = dp(12).toFloat()
            }
            setOnClickListener {
                if (isVpnEnabled) {
                    stopVpnFlow()
                } else {
                    startVpnFlow()
                }
            }
        }

        val btnParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(48)
        ).apply {
            topMargin = dp(20)
        }
        card.addView(toggleButton, btnParams)

        root.addView(
            card,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        val safetyNote = TextView(this).apply {
            text = "Safe Split-DNS: Only active on verified home Wi-Fi. Internet traffic never passes through a VPN tunnel."
            setTextColor(Color.parseColor("#64748B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(20), dp(12), 0)
        }
        root.addView(safetyNote)

        setContentView(root)
    }

    private fun startVpnFlow() {
        val ip = ipInput.text.toString().trim().ifEmpty { "192.168.1.159" }
        val dom = domainInput.text.toString().trim().trim('.').lowercase().ifEmpty { "x" }

        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putString(KEY_DAEMON_IP, ip)
            .putString(KEY_DOMAIN, dom)
            .putBoolean(KEY_ENABLED, true)
            .apply()

        val prepareIntent = VpnService.prepare(this)
        if (prepareIntent != null) {
            startActivityForResult(prepareIntent, VPN_REQUEST_CODE)
        } else {
            onActivityResult(VPN_REQUEST_CODE, RESULT_OK, null)
        }
    }

    private fun stopVpnFlow() {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_ENABLED, false)
            .apply()

        val stopIntent = Intent(this, CallsignVpnService::class.java).apply {
            action = CallsignVpnService.ACTION_STOP
        }
        startService(stopIntent)
        updateUiState(false)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == VPN_REQUEST_CODE && resultCode == RESULT_OK) {
            val ip = ipInput.text.toString().trim().ifEmpty { "192.168.1.159" }
            val dom = domainInput.text.toString().trim().trim('.').lowercase().ifEmpty { "x" }

            val startIntent = Intent(this, CallsignVpnService::class.java).apply {
                action = CallsignVpnService.ACTION_START
                putExtra(CallsignVpnService.EXTRA_DAEMON_IP, ip)
                putExtra(CallsignVpnService.EXTRA_DOMAIN, dom)
                putExtra(CallsignVpnService.EXTRA_EXPECTED_INSTANCE_ID, expectedInstanceId)
            }
            startService(startIntent)
            updateUiState(true)
        }
    }

    private fun updateUiState(enabled: Boolean) {
        isVpnEnabled = enabled
        statusLabel.text = if (enabled) "● Active on Home Wi-Fi" else "○ Disconnected"
        statusLabel.setTextColor(
            if (enabled) Color.parseColor("#34D399") else Color.parseColor("#94A3B8")
        )
        toggleButton.text = if (enabled) "Turn Off" else "Enable Home DNS"
        toggleButton.background = GradientDrawable().apply {
            setColor(
                if (enabled) Color.parseColor("#F87171") else Color.parseColor("#38BDF8")
            )
            cornerRadius = dp(12).toFloat()
        }
    }

    private fun dp(value: Int): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value.toFloat(),
            resources.displayMetrics
        ).toInt()
    }
}
