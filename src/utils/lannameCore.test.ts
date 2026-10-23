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
} from './lannameCore';

test('parseServicePair normalizes bare port, host:port, and full URLs', () => {
  const s1 = parseServicePair('hq=3100');
  assert.equal(s1.name, 'hq');
  assert.equal(s1.targetUrl, 'http://127.0.0.1:3100');
  assert.equal(s1.hostPort, '127.0.0.1:3100');

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

  const greenCofy = validateTld('cofy', false);
  assert.equal(greenCofy.tier, 'GREEN');
  assert.equal(greenCofy.blocked, false);
});

test('simulateMdnsQuery answers A records with CacheFlush and AAAA queries with immediate NODATA', () => {
  const services = [parseServicePair('hq=3100')];
  const aResp = simulateMdnsQuery('hq.local', 'A', false, '192.168.1.24', 'cofy', services);
  assert.equal(aResp.rcode, 'NOERROR');
  assert.equal(aResp.cacheFlush, true);
  assert.equal(aResp.answers.length, 1);

  const aaaaResp = simulateMdnsQuery('hq.local', 'AAAA', true, '192.168.1.24', 'cofy', services);
  assert.equal(aaaaResp.rcode, 'NOERROR');
  assert.equal(aaaaResp.answers.length, 0);
  assert.equal(aaaaResp.extra.length, 1);

  const unknownResp = simulateMdnsQuery('printer.local', 'A', false, '192.168.1.24', 'cofy', services);
  assert.equal(unknownResp.rcode, 'IGNORED (Silent Drop)');
});

test('simulateDnsQuery blocks DoH canary domains with NXDOMAIN and resolves *.cofy', () => {
  const services = [parseServicePair('hq=3100')];
  const canary = simulateDnsQuery('use-application-dns.net', 'A', '192.168.1.24', 'cofy', services);
  assert.equal(canary.rcode, 'NXDOMAIN');
  assert.equal(canary.authoritative, true);

  const localA = simulateDnsQuery('hq.cofy', 'A', '192.168.1.24', 'cofy', services);
  assert.equal(localA.rcode, 'NOERROR');
  assert.equal(localA.authoritative, true);
  assert.equal(localA.answers[0], 'hq.cofy. 60 IN A 192.168.1.24');
});

test('buildHostsBlock and generateMobileConfigXml produce valid configurations', () => {
  const block = buildHostsBlock('192.168.1.24', 'cofy', ['hq', 'pool']);
  assert.ok(block.includes('# BEGIN LANNAME'));
  assert.ok(block.includes('192.168.1.24 cofy hq.cofy pool.cofy'));
  assert.ok(block.includes('# END LANNAME'));

  const xml = generateMobileConfigXml('cofy', '192.168.1.24');
  assert.ok(xml.includes('com.apple.dnsSettings.managed'));
  assert.ok(xml.includes('<string>cofy</string>'));
  assert.ok(xml.includes('<string>192.168.1.24</string>'));

  const qr = generateOfflineQrMatrix('http://hq.local');
  assert.equal(qr.length, 21);
  assert.equal(qr[0].length, 21);
});
