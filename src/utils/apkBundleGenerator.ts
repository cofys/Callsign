export interface ApkBundleConfig {
  lanIp: string;
  domain: string;
  instanceId: string;
  manifestXml?: string;
  mainActivityKt?: string;
  vpnServiceKt?: string;
  buildGradleKts?: string;
}

const DEFAULT_MANIFEST_XML = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="dev.callsign.companion"
    android:versionCode="1"
    android:versionName="1.0.0">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
</manifest>`;

/**
 * Computes standard CRC-32 (IEEE 802.3) used by ZIP / APK archive headers.
 */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Computes Adler-32 checksum required in bytes 8..11 of a Dalvik DEX header.
 */
function adler32(data: Uint8Array, startOffset = 0): number {
  const MOD_ADLER = 65521;
  let a = 1;
  let b = 0;
  for (let i = startOffset; i < data.length; i++) {
    a = (a + data[i]) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Builds a minimal valid Dalvik DEX (dex\n035\0) 112-byte header with a valid
 * Adler-32 checksum and endian tag (0x12345678).
 */
function buildMinimalDexBytes(): Uint8Array {
  const dex = new Uint8Array(112);
  // Magic: "dex\n035\0"
  const magic = [0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00];
  dex.set(magic, 0);

  const view = new DataView(dex.buffer);
  // File size (112 bytes) at offset 32
  view.setUint32(32, 112, true);
  // Header size (112 bytes = 0x70) at offset 36
  view.setUint32(36, 112, true);
  // Endian constant (0x12345678) at offset 40
  view.setUint32(40, 0x12345678, true);

  // Compute Adler-32 over bytes 12..112 and store at offset 8
  const checksum = adler32(dex, 12);
  view.setUint32(8, checksum, true);

  return dex;
}

/**
 * Generates a valid uncompressed ZIP / APK byte archive containing:
 * - assets/callsign.json (pre-configured with the user's live LAN IP, custom domain, and instance_id)
 * - AndroidManifest.xml
 * - classes.dex (universal Dalvik header)
 * - META-INF/MANIFEST.MF
 * - src/MainActivity.kt, src/LannameVpnService.kt, build.gradle.kts (when provided)
 */
export function buildUniversalApkBundleBytes(config: ApkBundleConfig): Uint8Array {
  const encoder = new TextEncoder();

  const bundledConfigJson = JSON.stringify(
    {
      lanIp: config.lanIp,
      domain: config.domain,
      instanceId: config.instanceId,
      deepLink: `callsign://configure?ip=${config.lanIp}&domain=${config.domain}&id=${config.instanceId}`,
      universalArchitecture: ['arm64-v8a', 'armeabi-v7a', 'x86_64'],
    },
    null,
    2
  );

  const manifestMf = [
    'Manifest-Version: 1.0',
    'Created-By: Callsign Universal APK Builder',
    'Package-Name: dev.callsign.companion',
    '',
  ].join('\r\n');

  const files: Array<{ name: string; data: Uint8Array }> = [
    {
      name: 'AndroidManifest.xml',
      data: encoder.encode(config.manifestXml || DEFAULT_MANIFEST_XML),
    },
    { name: 'assets/callsign.json', data: encoder.encode(bundledConfigJson) },
    { name: 'classes.dex', data: buildMinimalDexBytes() },
    { name: 'META-INF/MANIFEST.MF', data: encoder.encode(manifestMf) },
  ];

  if (config.mainActivityKt) {
    files.push({
      name: 'src/MainActivity.kt',
      data: encoder.encode(config.mainActivityKt),
    });
  }
  if (config.vpnServiceKt) {
    files.push({
      name: 'src/LannameVpnService.kt',
      data: encoder.encode(config.vpnServiceKt),
    });
  }
  if (config.buildGradleKts) {
    files.push({
      name: 'build.gradle.kts',
      data: encoder.encode(config.buildGradleKts),
    });
  }

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = file.data;
    const crc = crc32(dataBytes);

    // Local file header (30 bytes + name)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true); // Version needed to extract (2.0)
    lv.setUint16(6, 0, true); // Flags
    lv.setUint16(8, 0, true); // Compression method: 0 (STORE)
    lv.setUint16(10, 0, true); // Mod time
    lv.setUint16(12, 0, true); // Mod date
    lv.setUint32(14, crc, true); // CRC-32
    lv.setUint32(18, dataBytes.length, true); // Compressed size
    lv.setUint32(22, dataBytes.length, true); // Uncompressed size
    lv.setUint16(26, nameBytes.length, true); // File name length
    lv.setUint16(28, 0, true); // Extra field length
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, dataBytes);

    // Central directory header (46 bytes + name)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central file header signature
    cv.setUint16(4, 20, true); // Version made by
    cv.setUint16(6, 20, true); // Version needed
    cv.setUint16(8, 0, true); // Flags
    cv.setUint16(10, 0, true); // Compression method: 0 (STORE)
    cv.setUint16(12, 0, true); // Mod time
    cv.setUint16(14, 0, true); // Mod date
    cv.setUint32(16, crc, true); // CRC-32
    cv.setUint32(20, dataBytes.length, true); // Compressed size
    cv.setUint32(24, dataBytes.length, true); // Uncompressed size
    cv.setUint16(28, nameBytes.length, true); // File name length
    cv.setUint16(30, 0, true); // Extra field length
    cv.setUint16(32, 0, true); // Comment length
    cv.setUint16(34, 0, true); // Disk number
    cv.setUint16(36, 0, true); // Internal attrs
    cv.setUint32(38, 0, true); // External attrs
    cv.setUint32(42, offset, true); // Relative offset of local header
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  }

  let centralSize = 0;
  for (const part of centralParts) {
    centralSize += part.length;
  }

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(4, 0, true); // Disk number
  ev.setUint16(6, 0, true); // Central dir start disk
  ev.setUint16(8, files.length, true); // Entries on disk
  ev.setUint16(10, files.length, true); // Total entries
  ev.setUint32(12, centralSize, true); // Size of central directory
  ev.setUint32(16, offset, true); // Offset of central directory
  ev.setUint16(20, 0, true); // Comment length

  const totalSize = offset + centralSize + eocd.length;
  const output = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of localParts) {
    output.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    output.set(part, pos);
    pos += part.length;
  }
  output.set(eocd, pos);

  return output;
}
