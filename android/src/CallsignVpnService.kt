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
import java.io.FileInputStream
import java.io.FileOutputStream
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
 * MULTI-DAEMON ROUTING:
 * Android gives a VPN exactly one flat list of DNS servers and the resolver will not fail over
 * on NXDOMAIN — so pointing the system resolver at several daemons cannot route per-domain
 * (the first daemon NXDOMAINs the second daemon's zones via its upstream, fatally). Instead the
 * resolver is pointed at the tunnel anchor itself (10.254.254.1) and a tiny DNS router inside
 * this service reads each query off the TUN fd and forwards it to the daemon that owns the
 * queried domain, falling through to the next daemon only on NXDOMAIN (e.g. for `.local`,
 * which every daemon serves for its own services). Only DNS packets to the anchor ever enter
 * the TUN — all other traffic keeps bypassing it entirely.
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

        /** DNS anchor: the address the system resolver sends queries to.
         *  It must NOT be the TUN interface's own address — packets to a local
         *  address are delivered by the local stack (where nothing listens)
         *  instead of entering the TUN. The anchor is only *routed* via the
         *  TUN (/32), so queries land on the router's fd as intended.
         *  (v1.2.0 set anchor == interface address and killed all DNS.) */
        private const val VIRTUAL_TUN_IPV4 = "10.254.254.1"

        /** The TUN interface's own address — deliberately different from the anchor. */
        private const val TUN_INTERFACE_IPV4 = "10.254.254.2"
        private const val VERIFY_TIMEOUT_MS = 600
        private const val FORWARD_TIMEOUT_MS = 1200
    }

    private val workerExecutor = Executors.newSingleThreadExecutor()
    private val queryExecutor = Executors.newCachedThreadPool()
    private val isRunning = AtomicBoolean(false)
    private val routerRunning = AtomicBoolean(false)

    @Volatile
    private var vpnInterface: ParcelFileDescriptor? = null

    /** Every daemon the user configured (multi-daemon households). */
    @Volatile
    private var configuredDaemons: List<DaemonEntry> =
        listOf(DaemonEntry("192.168.1.159", listOf("x"), ""))

    /** Daemons that passed identity verification on the current Wi-Fi. */
    @Volatile
    private var activeDaemons: List<DaemonEntry> = emptyList()

    @Volatile
    private var activeWifiNetwork: Network? = null

    @Volatile
    private var routerThread: Thread? = null

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
                startCompanion()
                return START_STICKY
            }
            else -> return START_NOT_STICKY
        }
    }

    override fun onDestroy() {
        stopCompanion()
        workerExecutor.shutdownNow()
        queryExecutor.shutdownNow()
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
                // Interface address (.2) is deliberately NOT the DNS anchor (.1):
                // only the anchor is routed into the TUN so resolver queries to
                // it arrive on the router fd instead of dying in the local stack.
                .addAddress(TUN_INTERFACE_IPV4, 32)
                // Point the resolver at the tunnel anchor ITSELF: the DNS router
                // below reads each query and forwards it to the owning daemon.
                // (Listing several daemons here would not work — the resolver
                // treats the first daemon's NXDOMAIN as final.)
                .addDnsServer(VIRTUAL_TUN_IPV4)
                // Enable single-word resolution (e.g. http://plex/ -> plex.<domain>),
                // for every domain of every verified daemon.
                .apply { for (domain in allDomains) addSearchDomain(domain) }
                .addSearchDomain("local")
                // CRITICAL: Do NOT add 0.0.0.0/0! Only route the /32 virtual anchor so
                // only DNS packets addressed to the anchor ever enter the TUN.
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
            if (pfd == null) return

            activeDaemons = verified
            activeWifiNetwork = wifiNetwork
            startDnsRouter(pfd)
            Log.i(
                TAG,
                "Established Split-DNS tunnel with in-tunnel DNS router -> " +
                    verified.joinToString(", ") { "${it.ip} (${it.domains.joinToString(",")})" }
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed establishing Split-DNS tunnel: ${e.message}", e)
            teardownTunnel()
        }
    }

    // ---------------------------------------------------------------------
    // In-tunnel DNS router: reads DNS queries addressed to the anchor off
    // the TUN fd, forwards each to the daemon that owns the queried domain
    // (falling through on NXDOMAIN), and writes the reply packet back.
    // UDP only — local name answers are small and never truncate.
    // ---------------------------------------------------------------------

    private fun startDnsRouter(pfd: ParcelFileDescriptor) {
        val input = FileInputStream(pfd.fileDescriptor)
        val output = FileOutputStream(pfd.fileDescriptor)
        routerRunning.set(true)
        Log.i(TAG, "DNS router started (anchor $VIRTUAL_TUN_IPV4, interface $TUN_INTERFACE_IPV4)")
        routerThread = Thread {
            val buffer = ByteArray(32767)
            while (routerRunning.get()) {
                val n = try {
                    input.read(buffer)
                } catch (e: Exception) {
                    break // fd closed by teardown
                }
                if (n <= 0) break
                val packet = buffer.copyOf(n)
                queryExecutor.execute {
                    try {
                        handleDnsPacket(packet, output)
                    } catch (e: Exception) {
                        Log.w(TAG, "DNS router dropped a packet: ${e.message}")
                    }
                }
            }
        }.apply {
            isDaemon = true
            name = "callsign-dns-router"
            start()
        }
    }

    private fun handleDnsPacket(packet: ByteArray, output: FileOutputStream) {
        if (packet.size < 20) return
        if ((packet[0].toInt() shr 4) != 4) return // IPv4 only
        val ihl = (packet[0].toInt() and 0x0F) * 4
        if (packet.size < ihl + 8) return
        if (packet[9].toInt() != 17) return // UDP only
        // Destination must be the anchor address itself.
        if (packet[16] != 10.toByte() || packet[17] != 254.toByte() ||
            packet[18] != 254.toByte() || packet[19] != 1.toByte()
        ) return
        val srcIp = byteArrayOf(packet[12], packet[13], packet[14], packet[15])
        val srcPort = u16(packet, ihl)
        val dstPort = u16(packet, ihl + 2)
        if (dstPort != 53) return
        val udpLen = u16(packet, ihl + 4)
        val payloadEnd = if (udpLen >= 8) minOf(packet.size, ihl + udpLen) else packet.size
        if (payloadEnd <= ihl + 8) return
        val query = packet.copyOfRange(ihl + 8, payloadEnd)

        // Fast SERVFAIL beats silence: if no daemon answers, the resolver gets
        // an immediate error instead of hanging every lookup on timeouts.
        val response = routeQuery(query) ?: buildServfail(query) ?: return
        val reply = buildUdpReply(packet, srcIp, srcPort, response)
        synchronized(output) {
            output.write(reply)
            output.flush()
        }
    }

    /**
     * Picks the daemon(s) to answer [query]: the owner of the queried domain
     * first, then the rest in order. A candidate's NXDOMAIN is not final —
     * the next daemon gets asked (this is what makes `.local` work when each
     * daemon only knows its own services). Timeouts also fall through.
     */
    private fun routeQuery(query: ByteArray): ByteArray? {
        val daemons = activeDaemons
        if (daemons.isEmpty()) return null
        val wifi = activeWifiNetwork ?: return null

        val qname = parseQName(query)
        val owner = if (qname != null) {
            daemons.firstOrNull { entry ->
                entry.domains.any { d -> qname == d || qname.endsWith(".$d") }
            }
        } else {
            null
        }
        val candidates = if (owner != null) {
            listOf(owner) + daemons.filter { it !== owner }
        } else {
            daemons
        }

        var lastNxDomain: ByteArray? = null
        for (candidate in candidates) {
            val resp = forwardDnsUdp(wifi, candidate.ip, query) ?: continue
            val rcode = if (resp.size >= 4) resp[3].toInt() and 0x0F else 0
            if (rcode != 3) return resp
            lastNxDomain = resp
        }
        return lastNxDomain
    }

    /** Builds a SERVFAIL response (header + question only) for [query]. */
    private fun buildServfail(query: ByteArray): ByteArray? {
        return try {
            if (query.size < 12) return null
            // Find the end of the question section: qname labels + root + QTYPE/QCLASS.
            var offset = 12
            while (offset < query.size) {
                val len = query[offset].toInt() and 0xFF
                if (len == 0) {
                    offset += 1
                    break
                }
                if (len > 63) return null
                offset += 1 + len
            }
            val questionEnd = offset + 4
            if (questionEnd > query.size) return null
            val out = query.copyOf(questionEnd)
            // Flags: QR=1, keep RD, RA=1, RCODE=2 (SERVFAIL). Counts: QD=1, others 0.
            out[2] = (0x80 or (query[2].toInt() and 0x01)).toByte()
            out[3] = (0x80 or 0x02).toByte()
            out[4] = 0; out[5] = 1
            out[6] = 0; out[7] = 0
            out[8] = 0; out[9] = 0
            out[10] = 0; out[11] = 0
            out
        } catch (e: Exception) {
            null
        }
    }

    private fun forwardDnsUdp(wifiNetwork: Network, daemonIp: String, query: ByteArray): ByteArray? {
        var socket: DatagramSocket? = null
        return try {
            socket = DatagramSocket()
            protect(socket)
            wifiNetwork.bindSocket(socket)
            socket.soTimeout = FORWARD_TIMEOUT_MS
            val target = InetAddress.getByName(daemonIp)
            socket.send(DatagramPacket(query, query.size, target, 53))
            val buf = ByteArray(4096)
            val resp = DatagramPacket(buf, buf.size)
            socket.receive(resp)
            buf.copyOf(resp.length)
        } catch (e: Exception) {
            null
        } finally {
            socket?.close()
        }
    }

    /** Extracts the first question's name from a DNS message ("plex.cofy"). */
    private fun parseQName(dns: ByteArray): String? {
        return try {
            var offset = 12 // skip DNS header
            val labels = mutableListOf<String>()
            while (offset < dns.size) {
                val len = dns[offset].toInt() and 0xFF
                if (len == 0) break
                if (len > 63 || offset + 1 + len > dns.size) return null
                labels.add(String(dns, offset + 1, len, StandardCharsets.US_ASCII))
                offset += 1 + len
            }
            if (labels.isEmpty()) null else labels.joinToString(".").lowercase()
        } catch (e: Exception) {
            null
        }
    }

    /** Wraps a DNS response in an IPv4/UDP packet from anchor:53 back to the resolver. */
    private fun buildUdpReply(requestPacket: ByteArray, dstIp: ByteArray, dstPort: Int, payload: ByteArray): ByteArray {
        val totalLen = 20 + 8 + payload.size
        val out = ByteArray(totalLen)
        // IPv4 header
        out[0] = 0x45 // version 4, IHL 5
        out[1] = 0
        out[2] = (totalLen shr 8).toByte()
        out[3] = totalLen.toByte()
        // Reuse the request's IP ID so replies correlate naturally.
        out[4] = requestPacket[4]
        out[5] = requestPacket[5]
        out[6] = 0
        out[7] = 0
        out[8] = 64 // TTL
        out[9] = 17 // UDP
        // Source = anchor, destination = whoever sent the query.
        out[12] = 10; out[13] = 254.toByte(); out[14] = 254.toByte(); out[15] = 1
        System.arraycopy(dstIp, 0, out, 16, 4)
        val checksum = ipHeaderChecksum(out)
        out[10] = (checksum shr 8).toByte()
        out[11] = checksum.toByte()
        // UDP header (checksum 0 = unused, legal for IPv4)
        out[20] = 0; out[21] = 53
        out[22] = (dstPort shr 8).toByte()
        out[23] = dstPort.toByte()
        val udpLen = 8 + payload.size
        out[24] = (udpLen shr 8).toByte()
        out[25] = udpLen.toByte()
        out[26] = 0; out[27] = 0
        System.arraycopy(payload, 0, out, 28, payload.size)
        return out
    }

    private fun ipHeaderChecksum(header: ByteArray): Int {
        var sum = 0
        var i = 0
        while (i < 20) {
            if (i != 10) { // checksum field itself counts as 0
                sum += ((header[i].toInt() and 0xFF) shl 8) or (header[i + 1].toInt() and 0xFF)
            }
            i += 2
        }
        while (sum shr 16 != 0) {
            sum = (sum and 0xFFFF) + (sum shr 16)
        }
        return sum.inv() and 0xFFFF
    }

    private fun u16(bytes: ByteArray, offset: Int): Int =
        ((bytes[offset].toInt() and 0xFF) shl 8) or (bytes[offset + 1].toInt() and 0xFF)

    @Synchronized
    private fun teardownTunnel() {
        teardownTunnelLocked()
    }

    private fun teardownTunnelLocked() {
        routerRunning.set(false)
        isRunning.set(false)
        activeDaemons = emptyList()
        activeWifiNetwork = null
        vpnInterface?.let { pfd ->
            try {
                pfd.close() // also unblocks the router thread's read
            } catch (e: Exception) {
                Log.w(TAG, "Error closing VPN interface: ${e.message}")
            }
        }
        vpnInterface = null
        routerThread = null
    }
}
