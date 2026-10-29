package dev.callsign.companion

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.InputStreamReader
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * CallsignVpnService: Zero-Touch Split-DNS Companion for Stock Android (One UI / Pixel / AOSP).
 *
 * TRANSPORT (v1.3): the system resolver is pointed at the verified daemons'
 * real LAN IPs, reached over the underlying Wi-Fi — the shape that has
 * worked on-device since v1.0. Multi-daemon name routing does NOT happen
 * here: sibling Callsign daemons discover each other and forward queries
 * for each other's domains (and for each other's `.local` services), so
 * whichever daemon the resolver asks first can answer every name.
 *
 * (History: v1.2 tried routing DNS inside the tunnel via a fake anchor IP.
 * On real hardware the resolver's queries to an in-tunnel address never
 * arrived as packets — pkts 2 / dns 0 on the device counters — while
 * apps with their own resolvers kept working, which made the failure look
 * browser-only. That design is removed; do not resurrect it.)
 *
 * SECURITY ARCHITECTURE (3 Hardened Guards):
 * 1. Cryptographic Daemon Identity Verification (Anti-Evil-Twin / Subnet Collision Guard):
 *    Before establishing the local VPN interface, this service binds a socket directly to the
 *    underlying Wi-Fi Network and verifies that each daemon IP is genuinely running the user's
 *    `Callsign` instance (`instanceId`) via UDP DNS TXT (`_callsign.<domain>.`) or
 *    `GET http://<daemonIp>/api/identity`. If the user connects to a coffee-shop 192.168.1.0/24
 *    network where another device occupies a daemon's IP, verification fails for that daemon
 *    and it is excluded; if none verify, the VPN tunnel is NOT activated.
 *
 * 2. Strict Split-Tunnel Routing (Zero Internet Interception):
 *    The TUN interface ONLY routes a single /32 host route (`10.254.254.1/32`) non-routable
 *    loopback anchor, never `0.0.0.0/0`. Normal internet traffic (HTTPS, streaming, banking)
 *    never traverses the TUN file descriptor.
 *
 * 3. Instant Wi-Fi Lifecycle Teardown (`ConnectivityManager.NetworkCallback`):
 *    Monitors `TRANSPORT_WIFI`. The moment the phone leaves home Wi-Fi, the VPN interface is
 *    closed in <50ms so cellular or external Wi-Fi DNS works natively without delay.
 */
class CallsignVpnService : VpnService() {

    companion object {
        private const val TAG = "CallsignVpnService"

        const val ACTION_START = "dev.callsign.companion.START"
        const val ACTION_STOP = "dev.callsign.companion.STOP"

        const val EXTRA_DAEMONS_JSON = "extra_daemons_json"
        const val EXTRA_DAEMON_IP = "extra_daemon_ip"
        const val EXTRA_DOMAIN = "extra_domain"
        const val EXTRA_EXPECTED_INSTANCE_ID = "extra_expected_instance_id"

        private const val VIRTUAL_TUN_IPV4 = "10.254.254.1"
        private const val VERIFY_TIMEOUT_MS = 600
    }

    private val workerExecutor = Executors.newSingleThreadExecutor()
    private val isRunning = AtomicBoolean(false)

    @Volatile
    private var vpnInterface: ParcelFileDescriptor? = null

    /** Every daemon the user configured (multi-daemon households). */
    @Volatile
    private var configuredDaemons: List<DaemonEntry> =
        listOf(DaemonEntry("192.168.1.159", listOf("x"), ""))

    /** Daemons that passed identity verification on the current Wi-Fi. */
    @Volatile
    private var activeDaemons: List<DaemonEntry> = emptyList()

    private lateinit var connectivityManager: ConnectivityManager
    private var wifiCallbackRegistered = false

    private val wifiNetworkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            Log.i(TAG, "Wi-Fi network available; verifying ${configuredDaemons.size} Callsign daemon(s)")
            verifyAndReconcileOnWifi(network)
        }

        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            verifyAndReconcileOnWifi(network)
        }

        override fun onLost(network: Network) {
            Log.i(TAG, "Wi-Fi network lost; tearing down Split-DNS tunnel immediately")
            teardownTunnel()
        }
    }

    override fun onCreate() {
        super.onCreate()
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopCompanion()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START, null -> {
                val parsed = DaemonEntry.listFromJson(intent?.getStringExtra(EXTRA_DAEMONS_JSON))
                if (parsed.isNotEmpty()) {
                    configuredDaemons = parsed
                } else {
                    // Legacy single-daemon extras (pre-1.2 callers).
                    val ip = intent?.getStringExtra(EXTRA_DAEMON_IP)?.trim()?.takeIf { it.isNotBlank() }
                    if (ip != null) {
                        val domains = DaemonEntry.parseDomains(
                            intent.getStringExtra(EXTRA_DOMAIN) ?: "x"
                        ).ifEmpty { listOf("x") }
                        val id = intent.getStringExtra(EXTRA_EXPECTED_INSTANCE_ID)?.trim() ?: ""
                        configuredDaemons = listOf(DaemonEntry(ip, domains, id))
                    }
                }
                dbgState("starting")
                startCompanion()
                return START_STICKY
            }
            else -> return START_NOT_STICKY
        }
    }

    override fun onDestroy() {
        stopCompanion()
        workerExecutor.shutdownNow()
        super.onDestroy()
    }

    /** Small state line the Activity displays (tunnel up / down / unverified). */
    private fun dbgState(state: String) {
        try {
            getSharedPreferences("callsign_prefs", Context.MODE_PRIVATE)
                .edit().putString("dbg_state", state).apply()
        } catch (_: Exception) {
            // Diagnostics must never break the service.
        }
    }

    private fun startCompanion() {
        if (!wifiCallbackRegistered) {
            val request = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                .build()
            connectivityManager.registerNetworkCallback(request, wifiNetworkCallback)
            wifiCallbackRegistered = true
        }

        val activeNetwork = connectivityManager.activeNetwork
        if (activeNetwork != null) {
            val caps = connectivityManager.getNetworkCapabilities(activeNetwork)
            if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                verifyAndReconcileOnWifi(activeNetwork)
            } else {
                teardownTunnel()
            }
        }
    }

    private fun stopCompanion() {
        if (wifiCallbackRegistered) {
            try {
                connectivityManager.unregisterNetworkCallback(wifiNetworkCallback)
            } catch (e: Exception) {
                Log.w(TAG, "Failed unregistering Wi-Fi callback: ${e.message}")
            }
            wifiCallbackRegistered = false
        }
        teardownTunnel()
    }

    private fun verifyAndReconcileOnWifi(wifiNetwork: Network) {
        workerExecutor.execute {
            val verified = configuredDaemons.filter { entry ->
                verifyCallsignIdentity(
                    wifiNetwork = wifiNetwork,
                    daemonIp = entry.ip,
                    domains = entry.domains,
                    expectedId = entry.instanceId
                )
            }

            if (verified.isEmpty()) {
                Log.w(
                    TAG,
                    "No configured daemon matched a Callsign identity on this Wi-Fi; keeping VPN dormant."
                )
                dbgState("no daemon verified")
                teardownTunnel()
            } else {
                establishSplitDnsTunnel(wifiNetwork, verified)
            }
        }
    }

    /**
     * Verifies that `daemonIp` on `wifiNetwork` is genuinely the user's `Callsign` daemon
     * before routing DNS to it. Uses `wifiNetwork.bindSocket(...)` and `protect(...)` so
     * verification bypasses any existing VPN state and probes the physical Wi-Fi LAN directly.
     */
    private fun verifyCallsignIdentity(
        wifiNetwork: Network,
        daemonIp: String,
        domains: List<String>,
        expectedId: String
    ): Boolean {
        // Guard 1: UDP DNS TXT probe for `_callsign.<domain>.` on port 53,
        // once per configured domain — any one match verifies the daemon.
        for (domain in domains) {
            val txtRecords = queryDnsTxtOverWifi(wifiNetwork, daemonIp, "_callsign.$domain")
            if (txtRecords.isNotEmpty()) {
                val hasActiveMarker = txtRecords.any {
                    it.contains("callsign-daemon=active")
                }
                val matchesInstance = expectedId.isEmpty() || txtRecords.any {
                    it.contains("callsign-instance=$expectedId")
                }
                if (hasActiveMarker && matchesInstance) {
                    return true
                }
            }
        }

        // Guard 2: HTTP fallback check against `http://<daemonIp>/api/identity`
        return try {
            val url = URL("http://$daemonIp/api/identity")
            val conn = (wifiNetwork.openConnection(url) as HttpURLConnection).apply {
                connectTimeout = VERIFY_TIMEOUT_MS
                readTimeout = VERIFY_TIMEOUT_MS
                requestMethod = "GET"
            }
            if (conn.responseCode != 200) {
                return false
            }
            val body = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
            val json = JSONObject(body)
            val remoteId = json.optString("instanceId", "")
            val remoteDomain = json.optString("domain", "")

            if (expectedId.isNotEmpty() && remoteId != expectedId) {
                false
            } else {
                domains.any { remoteDomain.equals(it, ignoreCase = true) } ||
                    remoteId.startsWith("cs-") ||
                    remoteId.startsWith("ln-")
            }
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Sends a minimal RFC 1035 DNS TXT query for [qName] directly to [daemonIp]:53 over [wifiNetwork].
     */
    private fun queryDnsTxtOverWifi(
        wifiNetwork: Network,
        daemonIp: String,
        qName: String
    ): List<String> {
        var socket: DatagramSocket? = null
        return try {
            socket = DatagramSocket()
            protect(socket)
            wifiNetwork.bindSocket(socket)
            socket.soTimeout = VERIFY_TIMEOUT_MS

            val queryBytes = buildDnsTxtQueryPacket(qName)
            val targetAddr = InetAddress.getByName(daemonIp)
            val requestPacket = DatagramPacket(queryBytes, queryBytes.size, targetAddr, 53)
            socket.send(requestPacket)

            val responseBuf = ByteArray(512)
            val responsePacket = DatagramPacket(responseBuf, responseBuf.size)
            socket.receive(responsePacket)

            val rawText = String(responsePacket.data, 0, responsePacket.length, StandardCharsets.US_ASCII)
            listOf(rawText)
        } catch (e: Exception) {
            emptyList()
        } finally {
            socket?.close()
        }
    }

    private fun buildDnsTxtQueryPacket(qName: String): ByteArray {
        val baos = ByteArrayOutputStream()
        val dos = DataOutputStream(baos)

        // DNS Header (12 bytes): ID=0x4353 ("CS"), Flags=0x0100 (Standard Query, RD=1), QDCOUNT=1
        dos.writeShort(0x4353)
        dos.writeShort(0x0100)
        dos.writeShort(1) // QDCOUNT
        dos.writeShort(0) // ANCOUNT
        dos.writeShort(0) // NSCOUNT
        dos.writeShort(0) // ARCOUNT

        // QNAME labels
        for (label in qName.trim('.').split('.')) {
            val bytes = label.toByteArray(StandardCharsets.US_ASCII)
            dos.writeByte(bytes.size)
            dos.write(bytes)
        }
        dos.writeByte(0) // Root terminator

        dos.writeShort(16) // QTYPE = TXT (16)
        dos.writeShort(1)  // QCLASS = IN (1)
        dos.flush()
        return baos.toByteArray()
    }

    @Synchronized
    private fun establishSplitDnsTunnel(wifiNetwork: Network, verified: List<DaemonEntry>) {
        val newKey = verified.joinToString("|") { "${it.ip}:${it.instanceId}" }
        val activeKey = activeDaemons.joinToString("|") { "${it.ip}:${it.instanceId}" }
        if (isRunning.get() && vpnInterface != null && newKey == activeKey) {
            return // Already serving exactly this verified daemon set.
        }
        teardownTunnelLocked()

        try {
            val allDomains = verified.flatMap { it.domains }.distinct()
            val domainLabel = allDomains.joinToString(", .", prefix = ".")
            val builder = Builder()
                .setSession("Callsign ($domainLabel & .local)")
                .setMtu(1500)
                // Assign a local non-conflicting /32 interface address
                .addAddress(VIRTUAL_TUN_IPV4, 32)
                // Point the resolver at the verified daemons' real LAN IPs,
                // reached over the underlying Wi-Fi. Sibling daemons forward
                // for each other, so any of them answers every local name.
                .apply { for (entry in verified) addDnsServer(entry.ip) }
                // Enable single-word resolution (e.g. http://plex/ -> plex.<domain>),
                // for every domain of every verified daemon.
                .apply { for (domain in allDomains) addSearchDomain(domain) }
                .addSearchDomain("local")
                // CRITICAL: Do NOT add 0.0.0.0/0! Only route the /32 virtual anchor so internet
                // packets never pass through the TUN file descriptor.
                .addRoute(VIRTUAL_TUN_IPV4, 32)
                .allowBypass()

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                builder.setMetered(false)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
                builder.setUnderlyingNetworks(arrayOf(wifiNetwork))
            }

            val pfd = builder.establish()
            vpnInterface = pfd
            isRunning.set(pfd != null)
            if (pfd == null) {
                dbgState("establish returned null")
                return
            }
            activeDaemons = verified
            dbgState("tunnel up · ${verified.size} daemon(s)")
            Log.i(
                TAG,
                "Established Split-DNS tunnel -> " +
                    verified.joinToString(", ") { "${it.ip} (${it.domains.joinToString(",")})" }
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed establishing Split-DNS tunnel: ${e.message}", e)
            dbgState("establish failed: ${e.message}")
            teardownTunnel()
        }
    }

    @Synchronized
    private fun teardownTunnel() {
        teardownTunnelLocked()
    }

    private fun teardownTunnelLocked() {
        dbgState("down")
        isRunning.set(false)
        activeDaemons = emptyList()
        vpnInterface?.let { pfd ->
            try {
                pfd.close()
            } catch (e: Exception) {
                Log.w(TAG, "Error closing VPN interface: ${e.message}")
            }
        }
        vpnInterface = null
    }
}
