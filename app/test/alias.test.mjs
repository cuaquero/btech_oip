import test from 'node:test';
import assert from 'node:assert/strict';
import { Aliaser } from '../alias.mjs';

const key = (s) => Buffer.from(s);
const octets = (ip) => ip.split('.').map(Number);
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip);

test('hosts in one real /24 stay together, in a different fake /24 per real /24', () => {
  const al = new Aliaser(key('k1'));
  const a = ['192.168.200.5', '192.168.200.70', '192.168.200.200'].map((x) => al.map(x));
  const net = (ip) => ip.split('.').slice(0, 3).join('.');
  assert.equal(new Set(a.map(net)).size, 1);
  assert.notEqual(net(al.map('192.168.201.5')), net(a[0]));
});

test('inside a /24 every real host gets a different fake host (a bijection)', () => {
  const al = new Aliaser(key('k2'));
  const out = new Set();
  for (let d = 0; d < 255; d++) out.add(al.map(`192.168.200.${d}`));
  assert.equal(out.size, 255);
});

test('a real /16 stays one fake /16 and its /24s stay distinct', () => {
  const al = new Aliaser(key('k3'));
  const seen = new Set();
  const second = new Set();
  for (let c = 0; c < 256; c++) {
    const [, y, z] = octets(al.map(`10.1.${c}.9`));
    second.add(y);
    seen.add(z);
  }
  assert.equal(second.size, 1);
  assert.equal(new Set(Array.from({ length: 256 }, (_, c) => al.map(`10.1.${c}.9`).split('.')[2])).size, 256);
});

test('no real private address or octet pattern survives', () => {
  const al = new Aliaser(key('k4'));
  const real = '192.168.200.70';
  const fake = al.map(real);
  assert.match(fake, /^10\./);
  assert.notEqual(fake, real);
  assert.equal(al.cidr('192.168.200.0/24').startsWith('10.'), true);
});

test('broadcast and multicast are unchanged and .255 stays .255', () => {
  const al = new Aliaser(key('k5'));
  assert.equal(al.map('224.0.0.251'), '224.0.0.251');
  assert.equal(al.map('239.255.255.250'), '239.255.255.250');
  assert.equal(al.map('255.255.255.255'), '255.255.255.255');
  assert.equal(al.map('0.0.0.0'), '0.0.0.0');
  assert.equal(al.map('192.168.200.255').endsWith('.255'), true);
});

test('public addresses become non-private, non-broadcast fakes', () => {
  const al = new Aliaser(key('k6'));
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '255.1.2.3'.replace('255', '203'), '100.64.1.1', '203.0.113.255']) {
    const fake = al.map(ip);
    assert.match(fake, /^198\.1[89]\./);
    assert.equal(isPrivate(fake), false);
    assert.equal(fake.endsWith('.255'), false);
  }
});

test('the same secret always gives the same answer, another secret does not', () => {
  const ips = ['192.168.200.1', '192.168.200.70', '10.99.1.2', '8.8.8.8'];
  const a = ips.map((i) => new Aliaser(key('same')).map(i));
  const b = ips.map((i) => new Aliaser(key('same')).map(i));
  const c = ips.map((i) => new Aliaser(key('other')).map(i));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('IPv6: private stays private, public stays public, multicast unchanged', () => {
  const al = new Aliaser(key('k7'));
  const same1 = al.map('fd00:1:2:3::10');
  const same2 = al.map('fd00:1:2:3::99');
  assert.match(same1, /^fd/);
  assert.equal(same1.split(':').slice(0, 4).join(':'), same2.split(':').slice(0, 4).join(':'));
  assert.match(al.map('fe80::1'), /^fd/);
  assert.match(al.map('2606:4700::1111'), /^2001:db8:/);
  assert.equal(al.map('ff02::fb'), 'ff02::fb');
  assert.equal(al.map('not-an-address'), 'invalid');
});

test('names look like devices, are stable, and are unique', () => {
  const al = new Aliaser(key('k8'));
  const names = new Set();
  for (let i = 1; i < 255; i++) names.add(al.name(al.map(`192.168.200.${i}`)));
  assert.equal(names.size, 254);
  const first = al.name(al.map('192.168.200.5'));
  assert.match(first, /^[A-Z][a-z]+ [A-Z][a-z]+( \d+)?$/);
  assert.equal(al.name(al.map('192.168.200.5')), first);
  assert.equal(new Aliaser(key('k8')).name(new Aliaser(key('k8')).map('192.168.200.5')), first);
});

test('zone names are unique per network', () => {
  const al = new Aliaser(key('k9'));
  const z = new Set();
  for (let c = 0; c < 30; c++) z.add(al.zone(`10.1.${c}.0/24`));
  assert.equal(z.size, 30);
});

test('cidr maps the grid network and keeps its size', () => {
  const al = new Aliaser(key('k10'));
  assert.match(al.cidr('10.1.0.0/16'), /^10\.\d+\.0\.0\/16$/);
  assert.match(al.cidr('192.168.200.0/24'), /^10\.\d+\.\d+\.0\/24$/);
  // the /24's fake network matches where its hosts really land
  const host = al.map('192.168.200.7').split('.').slice(0, 3).join('.');
  assert.equal(al.cidr('192.168.200.0/24'), `${host}.0/24`);
  assert.equal(al.cidr('nonsense'), null);
});
