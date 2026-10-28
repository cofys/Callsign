package dev.callsign.companion

import org.json.JSONArray
import org.json.JSONObject

/**
 * One Callsign daemon the companion knows about: where it lives (LAN IP),
 * which custom domains it owns, and its identity (verified before use so a
 * stranger's device on the same IP can never impersonate it).
 *
 * Multi-daemon support: a household can run several daemons — e.g. one box
 * serving `.cofy` and another serving `.proj`. The companion keeps a list
 * of these and the VPN service routes each DNS query to the daemon that
 * owns the queried domain.
 */
data class DaemonEntry(
    val ip: String,
    val domains: List<String>,
    val instanceId: String
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("ip", ip)
        put("domains", JSONArray(domains))
        put("instanceId", instanceId)
    }

    companion object {
        fun fromJson(obj: JSONObject): DaemonEntry? {
            val ip = obj.optString("ip", "").trim()
            if (ip.isEmpty()) return null
            val domains = mutableListOf<String>()
            val arr = obj.optJSONArray("domains")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val d = arr.optString(i, "").trim().trim('.').lowercase()
                    if (d.isNotEmpty()) domains.add(d)
                }
            }
            return DaemonEntry(ip, domains.distinct(), obj.optString("instanceId", "").trim())
        }

        fun listToJson(entries: List<DaemonEntry>): String {
            val arr = JSONArray()
            for (e in entries) arr.put(e.toJson())
            return arr.toString()
        }

        fun listFromJson(raw: String?): List<DaemonEntry> {
            if (raw.isNullOrBlank()) return emptyList()
            return try {
                val arr = JSONArray(raw)
                val out = mutableListOf<DaemonEntry>()
                for (i in 0 until arr.length()) {
                    arr.optJSONObject(i)?.let { fromJson(it)?.let { e -> out.add(e) } }
                }
                out
            } catch (_: Exception) {
                emptyList()
            }
        }

        fun parseDomains(raw: String): List<String> =
            raw.split(',').map { it.trim().trim('.').lowercase() }
                .filter { it.isNotEmpty() }.distinct()
    }
}
