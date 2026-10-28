package dev.callsign.companion

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
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
 * 3. Auto-Discover: Scans the Wi-Fi and adds EVERY Callsign daemon it finds.
 *
 * MULTI-DAEMON: households can run several daemons (one per project/box).
 * The app keeps a list of known daemons; the fields above the list edit one
 * daemon at a time (type an IP + its domains, Enable — or Auto-Discover and
 * every daemon on the network is added at once).
 */
class MainActivity : Activity() {

    companion object {
        private const val PREFS_NAME = "callsign_prefs"
        private const val KEY_DAEMON_IP = "daemon_ip"
        private const val KEY_DOMAIN = "domain"
        private const val KEY_INSTANCE_ID = "instance_id"
        private const val KEY_DAEMONS = "daemons_json"
        private const val KEY_ENABLED = "vpn_enabled"
        private const val VPN_REQUEST_CODE = 1001
    }

    private lateinit var ipInput: EditText
    private lateinit var domainInput: EditText
    private lateinit var statusLabel: TextView
    private lateinit var toggleButton: Button
    private lateinit var discoverButton: Button
    private lateinit var daemonListLayout: LinearLayout

    private val scanExecutor = Executors.newCachedThreadPool()

    private var isVpnEnabled = false

    /** All known daemons. The IP/domain fields edit one entry at a time. */
    private val daemons = mutableListOf<DaemonEntry>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        loadBundledAssetsIfFirstRun(prefs)
        loadDaemons(prefs)
        isVpnEnabled = prefs.getBoolean(KEY_ENABLED, false)

        // Check if opened via QR code deep-link: callsign://configure?ip=192.168.1.159&domain=x
        intent?.data?.let { uri ->
            if (uri.scheme == "callsign" && uri.host == "configure") {
                val ip = uri.getQueryParameter("ip")?.trim()?.takeIf { it.isNotBlank() }
                if (ip != null) {
                    val domains = uri.getQueryParameter("domain")
                        ?.let { DaemonEntry.parseDomains(it) } ?: emptyList()
                    val id = uri.getQueryParameter("id")?.trim() ?: ""
                    upsertDaemon(DaemonEntry(ip, domains, id))
                    persistDaemons(prefs)
                }
            }
        }

        val first = daemons.firstOrNull()
        buildMinimalistLayout(
            first?.ip ?: "192.168.1.159",
            first?.domains?.joinToString(",") ?: "x"
        )
        renderDaemonList()

        // If launched from a QR deep-link, automatically prompt/start VPN immediately
        if (intent?.data?.scheme == "callsign") {
            startVpnFlow()
        }
    }

    /** Loads the daemon list, migrating the pre-1.2 single-daemon prefs on first run. */
    private fun loadDaemons(prefs: SharedPreferences) {
        daemons.clear()
        daemons.addAll(DaemonEntry.listFromJson(prefs.getString(KEY_DAEMONS, null)))
        if (daemons.isEmpty()) {
            val ip = prefs.getString(KEY_DAEMON_IP, null)?.trim()?.takeIf { it.isNotBlank() }
            if (ip != null) {
                val domains = DaemonEntry.parseDomains(prefs.getString(KEY_DOMAIN, "x") ?: "x")
                val id = prefs.getString(KEY_INSTANCE_ID, "") ?: ""
                daemons.add(DaemonEntry(ip, domains, id))
                persistDaemons(prefs)
            }
        }
    }

    private fun persistDaemons(prefs: SharedPreferences = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)) {
        val editor = prefs.edit()
            .putString(KEY_DAEMONS, DaemonEntry.listToJson(daemons))
        // Keep the legacy single-daemon keys pointing at the first entry so a
        // downgrade or older reader still finds a sane configuration.
        daemons.firstOrNull()?.let { first ->
            editor.putString(KEY_DAEMON_IP, first.ip)
                .putString(KEY_DOMAIN, first.domains.joinToString(","))
                .putString(KEY_INSTANCE_ID, first.instanceId)
        }
        editor.apply()
    }

    /** Adds or replaces a daemon: matched by instance ID when known, else by IP. */
    private fun upsertDaemon(entry: DaemonEntry) {
        val idx = daemons.indexOfFirst {
            (entry.instanceId.isNotEmpty() && it.instanceId == entry.instanceId) || it.ip == entry.ip
        }
        if (idx >= 0) {
            val old = daemons[idx]
            daemons[idx] = DaemonEntry(
                ip = entry.ip,
                domains = if (entry.domains.isNotEmpty()) entry.domains else old.domains,
                instanceId = if (entry.instanceId.isNotEmpty()) entry.instanceId else old.instanceId
            )
        } else {
            daemons.add(entry)
        }
    }

    private fun loadBundledAssetsIfFirstRun(prefs: SharedPreferences) {
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
            setOnClickListener { discoverDaemons() }
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

        // Known-daemons list: one row per daemon with a Remove button.
        val listLabel = TextView(this).apply {
            text = "Known Daemons"
            setTextColor(Color.parseColor("#CBD5E1"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(0, dp(16), 0, dp(4))
        }
        card.addView(listLabel)

        daemonListLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        card.addView(daemonListLayout)

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

    /** Rebuilds the known-daemons rows: "192.168.1.159 — .cofy, .proj   [Remove]". */
    private fun renderDaemonList() {
        if (!::daemonListLayout.isInitialized) return
        daemonListLayout.removeAllViews()
        if (daemons.isEmpty()) {
            daemonListLayout.addView(TextView(this).apply {
                text = "None yet — tap Auto-Discover, or type an IP above and Enable."
                setTextColor(Color.parseColor("#64748B"))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                setPadding(0, dp(4), 0, 0)
            })
            return
        }
        for (entry in daemons) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(4), 0, dp(4))
            }
            val label = TextView(this).apply {
                val doms = entry.domains.joinToString(", ") { ".$it" }
                text = if (doms.isEmpty()) entry.ip else "${entry.ip} — $doms"
                setTextColor(Color.parseColor("#E2E8F0"))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                typeface = Typeface.MONOSPACE
            }
            row.addView(label, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            val remove = Button(this).apply {
                text = "Remove"
                isAllCaps = false
                setTextColor(Color.parseColor("#F87171"))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                background = GradientDrawable().apply {
                    setColor(Color.parseColor("#1E293B"))
                    cornerRadius = dp(8).toFloat()
                }
                setOnClickListener {
                    daemons.remove(entry)
                    persistDaemons()
                    renderDaemonList()
                }
            }
            row.addView(remove)
            // Tapping a row loads that daemon into the fields for editing.
            row.setOnClickListener {
                ipInput.setText(entry.ip)
                domainInput.setText(entry.domains.joinToString(","))
            }
            daemonListLayout.addView(row)
        }
    }

    private fun enteredDomains(): String =
        DaemonEntry.parseDomains(domainInput.text.toString())
            .ifEmpty { listOf("x") }.joinToString(",")

    /** The fields describe one daemon: upsert them into the list. */
    private fun upsertFromFields() {
        val ip = ipInput.text.toString().trim().ifEmpty { "192.168.1.159" }
        val domains = DaemonEntry.parseDomains(enteredDomains())
        val knownId = daemons.firstOrNull { it.ip == ip }?.instanceId ?: ""
        upsertDaemon(DaemonEntry(ip, domains, knownId))
    }

    private fun startVpnFlow() {
        upsertFromFields()
        domainInput.setText(enteredDomains())
        persistDaemons()
        renderDaemonList()
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
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
            val startIntent = Intent(this, CallsignVpnService::class.java).apply {
                action = CallsignVpnService.ACTION_START
                putExtra(CallsignVpnService.EXTRA_DAEMONS_JSON, DaemonEntry.listToJson(daemons))
                // Legacy single-daemon extras for compatibility.
                daemons.firstOrNull()?.let { first ->
                    putExtra(CallsignVpnService.EXTRA_DAEMON_IP, first.ip)
                    putExtra(CallsignVpnService.EXTRA_DOMAIN, first.domains.joinToString(","))
                    putExtra(CallsignVpnService.EXTRA_EXPECTED_INSTANCE_ID, first.instanceId)
                }
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
     * Auto-Discover: scans this Wi-Fi's /24 for Callsign daemons by probing
     * `GET /api/identity` on every host (the same endpoint the VPN service
     * trusts for identity) and adds EVERY daemon it finds to the list —
     * households running one daemon per project/box get them all in one tap.
     */
    private fun discoverDaemons() {
        discoverButton.isEnabled = false
        statusLabel.text = "◌ Scanning this Wi-Fi for Callsign…"
        statusLabel.setTextColor(Color.parseColor("#94A3B8"))
        scanExecutor.execute {
            val found = scanForCallsign()
            runOnUiThread {
                discoverButton.isEnabled = true
                if (found.isNotEmpty()) {
                    for (hit in found) {
                        upsertDaemon(
                            DaemonEntry(hit.ip, DaemonEntry.parseDomains(hit.domain), hit.instanceId)
                        )
                    }
                    persistDaemons()
                    renderDaemonList()
                    val first = found.first()
                    ipInput.setText(first.ip)
                    domainInput.setText(daemons.firstOrNull { it.ip == first.ip }?.domains?.joinToString(",") ?: first.domain)
                    statusLabel.text = if (found.size == 1) {
                        "● Found Callsign at ${first.ip} (.${first.domain})"
                    } else {
                        "● Found ${found.size} Callsign daemons — all added"
                    }
                    statusLabel.setTextColor(Color.parseColor("#34D399"))
                } else {
                    statusLabel.text = "○ No Callsign found on this Wi-Fi — enter an IP manually"
                    statusLabel.setTextColor(Color.parseColor("#F87171"))
                }
            }
        }
    }

    /** Collects every daemon on the subnet (deduped by instance ID, then IP). */
    private fun scanForCallsign(): List<FoundDaemon> {
        val prefix = wifiSubnetPrefix() ?: return emptyList()
        val pool = Executors.newFixedThreadPool(32)
        return try {
            val ecs = ExecutorCompletionService<FoundDaemon?>(pool)
            for (host in 1..254) {
                val ip = "$prefix$host"
                ecs.submit(Callable { probeIdentity(ip) })
            }
            val hits = mutableListOf<FoundDaemon>()
            for (i in 1..254) {
                val future = ecs.poll(15, TimeUnit.SECONDS) ?: break
                val hit = try { future.get() } catch (_: Exception) { null }
                if (hit != null && hits.none { it.instanceId == hit.instanceId || it.ip == hit.ip }) {
                    hits.add(hit)
                }
            }
            hits
        } catch (_: Exception) {
            emptyList()
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
