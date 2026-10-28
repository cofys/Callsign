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
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URL
import java.util.Collections
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

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
    private lateinit var discoverButton: Button

    private val scanExecutor = Executors.newCachedThreadPool()

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

        // IP field + Auto-Discover button on one row: users who don't know the
        // daemon's IP tap the button and the app scans this Wi-Fi for it.
        val ipRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        ipInput = EditText(this).apply {
            setText(initialIp)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#64748B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = Typeface.MONOSPACE
        }
        ipRow.addView(
            ipInput,
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        )
        discoverButton = Button(this).apply {
            text = "Auto-Discover"
            isAllCaps = false
            setTextColor(Color.parseColor("#38BDF8"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#1E293B"))
                cornerRadius = dp(10).toFloat()
            }
            setOnClickListener { discoverDaemon() }
        }
        ipRow.addView(
            discoverButton,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { leftMargin = dp(8) }
        )
        card.addView(ipRow)

        val domainLabel = TextView(this).apply {
            text = "Custom Domain Ending (without dot; comma-separate for multiple)"
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

    /** "cofy, proj" / ".Cofy." -> ["cofy", "proj"] — the domain field accepts a comma list. */
    private fun parseDomains(raw: String): List<String> =
        raw.split(',').map { it.trim().trim('.').lowercase() }
            .filter { it.isNotEmpty() }.distinct()

    private fun enteredDomains(): String =
        parseDomains(domainInput.text.toString()).ifEmpty { listOf("x") }.joinToString(",")

    private fun startVpnFlow() {
        val ip = ipInput.text.toString().trim().ifEmpty { "192.168.1.159" }
        val dom = enteredDomains()
        domainInput.setText(dom)

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
            val dom = enteredDomains()

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

    private data class FoundDaemon(val ip: String, val domain: String, val instanceId: String)

    /**
     * Auto-Discover: scans this Wi-Fi's /24 for a Callsign daemon by probing
     * `GET /api/identity` on every host (the same endpoint the VPN service
     * trusts for identity). A real daemon answers with a `cs-…` instance ID
     * and its domain, so one tap fills in BOTH the IP and the domain fields.
     */
    private fun discoverDaemon() {
        discoverButton.isEnabled = false
        statusLabel.text = "◌ Scanning this Wi-Fi for Callsign…"
        statusLabel.setTextColor(Color.parseColor("#94A3B8"))
        scanExecutor.execute {
            val found = scanForCallsign()
            runOnUiThread {
                discoverButton.isEnabled = true
                if (found != null) {
                    ipInput.setText(found.ip)
                    val merged = (parseDomains(domainInput.text.toString()) + found.domain).distinct()
                    val mergedText = merged.joinToString(",")
                    domainInput.setText(mergedText)
                    expectedInstanceId = found.instanceId
                    getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                        .putString(KEY_DAEMON_IP, found.ip)
                        .putString(KEY_DOMAIN, mergedText)
                        .putString(KEY_INSTANCE_ID, found.instanceId)
                        .apply()
                    statusLabel.text = "● Found Callsign at ${found.ip} (.${found.domain})"
                    statusLabel.setTextColor(Color.parseColor("#34D399"))
                } else {
                    statusLabel.text = "○ No Callsign found on this Wi-Fi — enter the IP manually"
                    statusLabel.setTextColor(Color.parseColor("#F87171"))
                }
            }
        }
    }

    private fun scanForCallsign(): FoundDaemon? {
        val prefix = wifiSubnetPrefix() ?: return null
        val pool = Executors.newFixedThreadPool(32)
        return try {
            val ecs = ExecutorCompletionService<FoundDaemon?>(pool)
            for (host in 1..254) {
                val ip = "$prefix$host"
                ecs.submit(Callable { probeIdentity(ip) })
            }
            for (i in 1..254) {
                val future = ecs.poll(15, TimeUnit.SECONDS) ?: break
                val hit = try { future.get() } catch (_: Exception) { null }
                if (hit != null) return hit
            }
            null
        } catch (_: Exception) {
            null
        } finally {
            pool.shutdownNow()
        }
    }

    private fun probeIdentity(ip: String): FoundDaemon? {
        return try {
            val conn = (URL("http://$ip/api/identity").openConnection() as HttpURLConnection).apply {
                connectTimeout = 700
                readTimeout = 700
                requestMethod = "GET"
            }
            if (conn.responseCode != 200) return null
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            val id = json.optString("instanceId", "")
            val domain = json.optString("domain", "").trim().trim('.').lowercase()
            if ((id.startsWith("cs-") || id.startsWith("ln-")) && domain.isNotEmpty()) {
                FoundDaemon(ip, domain, id)
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    /** "192.168.1." for the phone's current private IPv4 — permission-free via NetworkInterface. */
    private fun wifiSubnetPrefix(): String? {
        return try {
            val candidates = mutableListOf<String>()
            for (iface in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!iface.isUp || iface.isLoopback) continue
                if (iface.name.startsWith("tun") || iface.name.startsWith("ppp")) continue
                for (addr in Collections.list(iface.inetAddresses)) {
                    if (addr !is Inet4Address || addr.isLoopbackAddress) continue
                    val ip = addr.hostAddress ?: continue
                    if (ip == "10.254.254.1") continue // our own VPN anchor address
                    val isPrivate = ip.startsWith("192.168.") || ip.startsWith("10.") ||
                        ip.matches(Regex("^172\\.(1[6-9]|2\\d|3[01])\\..*"))
                    if (isPrivate) {
                        candidates.add(ip.substringBeforeLast('.') + ".")
                    }
                }
            }
            candidates.firstOrNull { it.startsWith("192.168.") } ?: candidates.firstOrNull()
        } catch (_: Exception) {
            null
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
