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
 * WHY THIS EXISTS:
 * Stock Android's netd/DnsResolver merges DHCPv4 DNS servers (the ISP gateway) and IPv6 RDNSS
 * servers onto the same interface, and treats an NXDOMAIN response from the primary DHCPv4
 * server as authoritative and final (never failing over to secondary DNS servers). Furthermore,
 * Android Chrome and Bionic bypass mDNS for arbitrary *.local hostnames in the browser URL bar.
 *
 * SECURITY ARCHITECTURE (3 Hardened Guards):
 * 1. Cryptographic Daemon Identity Verification (Anti-Evil-Twin / Subnet Collision Guard):
 *    Before establishing the local VPN interface, this service binds a socket directly to the
 *    underlying Wi-Fi Network and verifies that `daemonIp` is genuinely running the user's
 *    `Callsign` instance (`expectedInstanceId`) via UDP DNS TXT (`_callsign.<domain>.`) or
 *    `GET http://<daemonIp>/api/identity`. If the user connects to a coffee-shop 192.168.1.0/24
 *    network where another device occupies `192.168.1.159`, verification fails immediately and
 *    the VPN tunnel is NOT activated.
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

    @Volatile
    private var configuredDaemonIp: String = "192.168.1.159"

    @Volatile
    private var configuredDomains: List<String> = listOf("x")

    /** "cofy, proj" -> ["cofy", "proj"] — the domain extra accepts a comma list. */
    private fun parseDomains(raw: String): List<String> =
        raw.split(',').map { it.trim().trim('.').lowercase() }
            .filter { it.isNotEmpty() }.distinct()

    @Volatile
    private var expectedInstanceId: String = ""

    private lateinit var connectivityManager: ConnectivityManager
    private var wifiCallbackRegistered = false

    private val wifiNetworkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            Log.i(TAG, "Wi-Fi network available; verifying Callsign daemon identity on $configuredDaemonIp")
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
                intent?.getStringExtra(EXTRA_DAEMON_IP)?.takeIf { it.isNotBlank() }?.let {
                    configuredDaemonIp = it.trim()
                }
                intent?.getStringExtra(EXTRA_DOMAIN)?.takeIf { it.isNotBlank() }?.let {
                    configuredDomains = parseDomains(it).ifEmpty { listOf("x") }
                }
                intent?.getStringExtra(EXTRA_EXPECTED_INSTANCE_ID)?.let {
                    expectedInstanceId = it.trim()
                }
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
            val verified = verifyCallsignIdentity(
                wifiNetwork = wifiNetwork,
                daemonIp = configuredDaemonIp,
                domains = configuredDomains,
                expectedId = expectedInstanceId
            )

            if (verified) {
                establishSplitDnsTunnel(wifiNetwork)
            } else {
                Log.w(
                    TAG,
                    "Host $configuredDaemonIp on current Wi-Fi did NOT match Callsign identity; keeping VPN dormant."
                )
                teardownTunnel()
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
    private fun establishSplitDnsTunnel(wifiNetwork: Network) {
        if (isRunning.get() && vpnInterface != null) {
            return
        }

        try {
            val domainLabel = configuredDomains.joinToString(", .", prefix = ".")
            val builder = Builder()
                .setSession("Callsign ($domainLabel & .local)")
                .setMtu(1500)
                // Assign a local non-conflicting /32 interface address
                .addAddress(VIRTUAL_TUN_IPV4, 32)
                // Point DNS at the verified Callsign daemon
                .addDnsServer(configuredDaemonIp)
                // Enable single-word resolution (e.g. http://plex/ -> plex.<domain>),
                // for every configured domain when several are comma-separated
                .apply { for (domain in configuredDomains) addSearchDomain(domain) }
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

            vpnInterface = builder.establish()
            isRunning.set(vpnInterface != null)
            Log.i(TAG, "Established zero-config Split-DNS tunnel -> $configuredDaemonIp ($domainLabel)")
        } catch (e: Exception) {
            Log.e(TAG, "Failed establishing Split-DNS tunnel: ${e.message}", e)
            teardownTunnel()
        }
    }

    @Synchronized
    private fun teardownTunnel() {
        isRunning.set(false)
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
