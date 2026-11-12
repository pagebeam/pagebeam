import { BlockList, isIP } from 'node:net';

const denied = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied.addSubnet(ip, bits, 'ipv4');
const global = new BlockList();
global.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) denied.addSubnet(ip, bits, 'ipv6');
const embedded = new BlockList();
for (const ip of ['::', '::ffff:0:0', '64:ff9b::']) embedded.addSubnet(ip, 96, 'ipv6');

export function publicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !denied.check(ip, 'ipv4');
  if (family !== 6) return false;
  if (embedded.check(ip, 'ipv6')) {
    const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const words = normalized.split(':');
    const value = (parseInt(words.at(-2) || '0', 16) * 65536 + parseInt(words.at(-1) || '0', 16)) >>> 0;
    return publicAddress([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.'));
  }
  return global.check(ip, 'ipv6') && !denied.check(ip, 'ipv6');
}
