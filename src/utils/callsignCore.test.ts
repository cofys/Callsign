import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseServicePair,
  validateTld,
  simulateMdnsQuery,
  simulateDnsQuery,
  buildHostsBlock,
  generateMobileConfigXml,
  generateOfflineQrMatrix,
  isPrivateLanIp,
  verifyMutationRequestOrigin,
  verifyDaemonIdentityProbe,
} from './callsignCore';
import { buildUniversalApkBundleBytes } from './apkBundleGenerator';

test('parseServicePair normalizes bare port, host:port, and full URLs', () => {
  const s1 = parseServicePair('plex=32400');
  assert.equal(s1.name, 'plex');
  assert.equal(s1.targetUrl, 'http://127.0.0.1:32400');
  assert.equal(s1.hostPort, '127.0.0.1:32400');

  const s2 = parseServicePair('nas=192.168.1.50:8080');
  assert.equal(s2.name, 'nas');
  assert.equal(s2.targetUrl, 'http://192.168.1.50:8080');
  assert.equal(s2.hostPort, '192.168.1.50:8080');

  const s3 = parseServicePair('vault=https://10.0.0.12:8200');
  assert.equal(s3.name, 'vault');
  assert.equal(s3.targetUrl, 'https://10.0.0.12:8200');
  assert.equal(s3.hostPort, '10.0.0.12:8200');
});

test('validateTld classifies RED HSTS preloaded TLDs, YELLOW ICANN gTLDs, and GREEN private suffixes', () => {
  const redDev = validateTld('dev', false);
  assert.equal(redDev.tier, 'RED');
  assert.equal(redDev.blocked, true);

  const forcedDev = validateTld('dev', true);
  assert.equal(forcedDev.tier, 'RED');
  assert.equal(forcedDev.blocked, false);

  const yellowCom = validateTld('com', false);
  assert.equal(yellowCom.tier, 'YELLOW');
  assert.equal(yellowCom.blocked, false);

  // Custom extensions (.a, .b, .c, .x, .hub, .lab, etc.) are all valid Green
  for (const ext of ['a', 'b', 'c', 'x', 'z', 'hub', 'home', 'lan', 'lab']) {
    const res = validateTld(ext, false);
    assert.equal(res.tier, 'GREEN', `expected .${ext} to be GREEN`);
    assert.equal(res.blocked, false);
  }
});

test('simulateMdnsQuery answers A records with CacheFlush and AAAA queries with immediate NODATA', () => {
  const services = [parseServicePair('plex=32400')];
  const aResp = simulateMdnsQuery('plex.local', 'A', false, '192.168.1.24', 'x', services);
  assert.equal(aResp.rcode, 'NOERROR');
  assert.equal(aResp.cacheFlush, true);
  assert.equal(aResp.answers.length, 1);

  const aaaaResp = simulateMdnsQuery('plex.local', 'AAAA', true, '192.168.1.24', 'x', services);
  assert.equal(aaaaResp.rcode, 'NOERROR');
  assert.equal(aaaaResp.answers.length, 0);
  assert.equal(aaaaResp.extra.length, 1);

  const unknownResp = simulateMdnsQuery('printer.local', 'A', false, '192.168.1.24', 'x', services);
  assert.equal(unknownResp.rcode, 'IGNORED (Silent Drop)');
});

test('simulateDnsQuery blocks DoH canary domains with NXDOMAIN and resolves *.x', () => {
  const services = [parseServicePair('plex=32400')];
  const canary = simulateDnsQuery('use-application-dns.net', 'A', '192.168.1.24', 'x', services);
  assert.equal(canary.rcode, 'NXDOMAIN');
  assert.equal(canary.authoritative, true);

  const localA = simulateDnsQuery('plex.x', 'A', '192.168.1.24', 'x', services);
  assert.equal(localA.rcode, 'NOERROR');
  assert.equal(localA.authoritative, true);
  assert.equal(localA.answers[0], 'plex.x. 60 IN A 192.168.1.24');
});

test('buildHostsBlock and generateMobileConfigXml produce valid configurations', () => {
  const block = buildHostsBlock('192.168.1.24', 'x', ['plex', 'ha']);
  assert.ok(block.includes('# BEGIN CALLSIGN'));
  assert.ok(block.includes('192.168.1.24 x plex.x ha.x'));
  assert.ok(block.includes('# END CALLSIGN'));

  const xml = generateMobileConfigXml('x', '192.168.1.24');
  assert.ok(xml.includes('com.apple.dnsSettings.managed'));
  assert.ok(xml.includes('<string>x</string>'));
  assert.ok(xml.includes('<string>192.168.1.24</string>'));

  const qr = generateOfflineQrMatrix('http://plex.local');
  assert.equal(qr.length, 21);
  assert.equal(qr[0].length, 21);
});

test('multi-domain support generates entries for all domains simultaneously', () => {
  const multiHosts = buildHostsBlock('192.168.1.24', ['home', 'lab'], ['plex']);
  assert.ok(multiHosts.includes('192.168.1.24 home plex.home lab plex.lab'));

  const multiXml = generateMobileConfigXml(['home', 'lab'], '192.168.1.24');
  assert.ok(multiXml.includes('<string>home</string>'));
  assert.ok(multiXml.includes('<string>lab</string>'));
  assert.ok(multiXml.includes('<string>local</string>'));
});

test('security guards: Private LAN ACL, CSRF/DNS-rebinding check, and Android Evil-Twin identity verification', () => {
  assert.equal(isPrivateLanIp('192.168.1.159'), true);
  assert.equal(isPrivateLanIp('fd00::1'), true);
  assert.equal(isPrivateLanIp('8.8.8.8'), false);

  const validOrigin = verifyMutationRequestOrigin({
    hostHeader: 'x.local',
    originHeader: 'http://x.local',
    secFetchSite: 'same-origin',
    lanIp: '192.168.1.159',
    domain: 'x',
  });
  assert.equal(validOrigin.allowed, true);

  const csrfAttack = verifyMutationRequestOrigin({
    hostHeader: '192.168.1.159',
    originHeader: 'https://evil.example.com',
    secFetchSite: 'cross-site',
    lanIp: '192.168.1.159',
    domain: 'x',
  });
  assert.equal(csrfAttack.allowed, false);

  const rebindAttack = verifyMutationRequestOrigin({
    hostHeader: 'attacker-rebind.com',
    lanIp: '192.168.1.159',
    domain: 'x',
  });
  assert.equal(rebindAttack.allowed, false);

  const genuineDaemon = verifyDaemonIdentityProbe({
    txtRecords: ['callsign-daemon=active', 'callsign-instance=cs-abc123'],
    expectedInstanceId: 'cs-abc123',
  });
  assert.equal(genuineDaemon.verified, true);

  const evilTwin = verifyDaemonIdentityProbe({
    txtRecords: ['callsign-daemon=active', 'callsign-instance=cs-rogue999'],
    expectedInstanceId: 'cs-abc123',
  });
  assert.equal(evilTwin.verified, false);
});

import {
  isTailscaleIp,
  resolveSplitHorizonIp,
  authorizeAgentMcpCall,
} from './callsignCore';

test('Tailscale CGNAT (100.64.0.0/10) and Split-Horizon DNS answer based on source IP', () => {
  assert.equal(isTailscaleIp('100.64.0.1'), true);
  assert.equal(isTailscaleIp('100.85.12.34'), true);
  assert.equal(isTailscaleIp('100.127.255.254'), true);
  assert.equal(isTailscaleIp('100.63.255.255'), false);
  assert.equal(isTailscaleIp('100.128.0.1'), false);
  assert.equal(isTailscaleIp('fd7a:115c:a1e0::1a2b'), true);

  // Tailscale IPs are recognized as trusted private clients
  assert.equal(isPrivateLanIp('100.85.12.34'), true);

  const lanHorizon = resolveSplitHorizonIp('192.168.1.50', '192.168.1.159', '100.85.12.34');
  assert.equal(lanHorizon.horizon, 'LAN');
  assert.equal(lanHorizon.answerIp, '192.168.1.159');

  const tsHorizon = resolveSplitHorizonIp('100.90.4.12', '192.168.1.159', '100.85.12.34');
  assert.equal(tsHorizon.horizon, 'TAILSCALE');
  assert.equal(tsHorizon.answerIp, '100.85.12.34');

  const services = [parseServicePair('ollama=11434')];
  const tsDns = simulateDnsQuery('ollama.x', 'A', '192.168.1.159', 'x', services, undefined, {
    clientIp: '100.90.4.12',
    tailscaleIp: '100.85.12.34',
  });
  assert.equal(tsDns.answers[0], 'ollama.x. 60 IN A 100.85.12.34');
});

test('authorizeAgentMcpCall enforces Zero-Trust Read-Only default and Scoped Bearer Token for mutations', () => {
  // Public IP blocked even for read-only
  const pubRead = authorizeAgentMcpCall({
    toolName: 'callsign_list_services',
    clientIp: '8.8.4.4',
    allowMutations: true,
  });
  assert.equal(pubRead.allowed, false);
  assert.equal(pubRead.status, 403);

  // Tailscale peer allowed for read-only discovery
  const tsRead = authorizeAgentMcpCall({
    toolName: 'callsign_resolve',
    clientIp: '100.90.4.12',
    allowMutations: false,
  });
  assert.equal(tsRead.allowed, true);

  // Mutation blocked when allowMutations is false
  const blockedWrite = authorizeAgentMcpCall({
    toolName: 'callsign_register_service',
    clientIp: '127.0.0.1',
    allowMutations: false,
  });
  assert.equal(blockedWrite.allowed, false);

  // Mutation blocked when Bearer token does not match
  const badTokenWrite = authorizeAgentMcpCall({
    toolName: 'callsign_register_service',
    clientIp: '100.90.4.12',
    allowMutations: true,
    expectedToken: 'cs_tok_secret123',
    authHeader: 'Bearer wrong_token',
  });
  assert.equal(badTokenWrite.allowed, false);
  assert.equal(badTokenWrite.status, 401);

  // Mutation allowed with valid Bearer token
  const validTokenWrite = authorizeAgentMcpCall({
    toolName: 'callsign_register_service',
    clientIp: '100.90.4.12',
    allowMutations: true,
    expectedToken: 'cs_tok_secret123',
    authHeader: 'Bearer cs_tok_secret123',
  });
  assert.equal(validTokenWrite.allowed, true);
  assert.equal(validTokenWrite.status, 200);
});

test('buildUniversalApkBundleBytes generates valid PKZIP APK archive with bundled assets/callsign.json and classes.dex', () => {
  const apkBytes = buildUniversalApkBundleBytes({
    lanIp: '192.168.1.159',
    domain: 'x',
    instanceId: 'cs-test1234',
  });
  // Verify PK\x03\x04 ZIP header magic
  assert.equal(apkBytes[0], 0x50); // 'P'
  assert.equal(apkBytes[1], 0x4b); // 'K'
  assert.equal(apkBytes[2], 0x03);
  assert.equal(apkBytes[3], 0x04);

  const ascii = new TextDecoder().decode(apkBytes);
  assert.ok(ascii.includes('assets/callsign.json'));
  assert.ok(ascii.includes('classes.dex'));
  assert.ok(ascii.includes('192.168.1.159'));
  assert.ok(ascii.includes('callsign://configure?ip=192.168.1.159&domain=x'));
});
