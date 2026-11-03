/**
 * 网络周界闸（security/ipallow.mjs，2026-11-03）—— 授权 IP 白名单（E3003）+ 域名绑定（E3004）。
 *
 * 这是令牌闸**之前**那道网络层的门，错了就是把整个面板关在门外或敞开，所以逐条钉死：
 *   ① 名单解析：脏条目进 bad（整体 400 E1052 的前置）、去重去空行、`::ffff:` 归一；
 *   ② 匹配：精确 v4/v6、IPv4 网段（/24 命中与不命中、/0、/32）、库里有脏数据跳过不卡死；
 *   ③ 闸：关=不设卡；开（哪怕空名单）=名单外一律拦、本机直连除外（误锁自救的门）；
 *      **本机直连永远放行**（名单填错也锁不死自己）；
 *   ④ 伪造面：peer 回环但带转发头（无 trustProxy）→ 不算本机直连，照拦；
 *   ⑤ trustProxy：按 XFF 第一段取真实来源（多段取第一段），名单内外两样；
 *   ⑥ 域名绑定：Host 不符 E3004、大小写/结尾点归一后相符放行、本机直连不看 Host；
 *   ⑦ 域名归一化：scheme / 路径 / 端口 / 结尾的点 / 大小写。
 *
 * 纯函数级：临时数据目录 + 直接种 netmode.json（走 writeNetMode 种缓存），不起服务器、不联网。
 * 跑法：node apps/server/src/smoke-network.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* dataDir 在 config.mjs 模块加载时定型 —— 必须先种环境变量再 import */
process.env.BANDI_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-net-'));
delete process.env.BANDI_TRUST_PROXY; // 用例自己逐段开关这个变量

const { normalizeIpList, ipAllowed, normalizeDomain, guardNetwork, clientIpOf, CODE_IP, CODE_DOMAIN } =
  await import('./security/ipallow.mjs');
const netmode = await import('./netmode.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 造一个最小 req：peer 地址 + Host 头 + 任意附加头 */
const req = ({ ip = '203.0.113.7', host = 'pan.example.com', headers = {} } = {}) => ({
  socket: { remoteAddress: ip },
  headers: { host, ...headers },
});

try {
  /* ---------------- ① 名单解析：脏条目整条进 bad，好条目归一去重 */
  console.log('① 名单解析（normalizeIpList）');
  const r1 = normalizeIpList(['192.168.5.9', '  192.168.5.9  ', '192.168.5.0/24', '', '999.1.1.1', '192.168.5.0/33', 'abc']);
  check('好条目归一保留、去空行、去重复', eq(r1.ips, ['192.168.5.9', '192.168.5.0/24']), JSON.stringify(r1.ips));
  check('写错的整条进 bad（999.x / 掩码超 32 / 不是 IP）', eq(r1.bad, ['999.1.1.1', '192.168.5.0/33', 'abc']), JSON.stringify(r1.bad));
  const r2 = normalizeIpList(['::FFFF:192.168.5.9']);
  check('::ffff: 前缀剥掉（双栈 socket 的报法）', eq(r2.ips, ['192.168.5.9']), JSON.stringify(r2.ips));
  check('空输入 → 空名单无坏条', eq(normalizeIpList([]), { ips: [], bad: [] }));

  /* ---------------- ② 匹配：精确 + 网段 + 脏数据容错 */
  console.log('\n② 名单匹配（ipAllowed）');
  const list = ['192.168.5.9', '192.168.5.0/24', '2001:db8::8', '这条是脏数据'];
  check('精确 v4 命中', ipAllowed('192.168.5.9', list) === true);
  check('精确 v4 不命中（名单之外、网段之外）', ipAllowed('8.8.8.8', list) === false);
  check('网段 /24 内命中（192.168.5.77）', ipAllowed('192.168.5.77', list) === true);
  check('网段外不命中（192.168.6.1）', ipAllowed('192.168.6.1', list) === false);
  check('::ffff: 映射地址按剥前缀后的 v4 匹配', ipAllowed('::ffff:192.168.5.77', list) === true);
  check('精确 v6 命中', ipAllowed('2001:db8::8', list) === true);
  check('库里混进脏数据：跳过该条、不卡死整道闸', ipAllowed('192.168.5.9', list) === true);
  check('/0 放所有人', ipAllowed('8.8.8.8', ['0.0.0.0/0']) === true);
  check('/32 只放自己', ipAllowed('8.8.8.9', ['8.8.8.8/32']) === false);
  check('认不出的来源 IP 一律不命中', ipAllowed('', list) === false);

  /* ---------------- ⑦ 域名归一化（先测，⑤⑥ 的断言要用它的口径） */
  console.log('\n③ 域名归一化（normalizeDomain）');
  check('scheme / 路径 / 端口 / 结尾点 / 大小写全剥掉',
    normalizeDomain('HTTPS://Pan.Example.COM:8443/admin.') === 'pan.example.com',
    normalizeDomain('HTTPS://Pan.Example.COM:8443/admin.'));
  check('空串 = 清除绑定', normalizeDomain('') === '' && normalizeDomain(null) === '');

  /* ---------------- ③④⑤⑥ 闸本体：种 netmode.json 逐态验证 */
  console.log('\n④ 闸 —— 白名单关闭 / 空名单');
  netmode.writeNetMode({ whitelistEnabled: false, whitelistIps: [], boundDomain: '' });
  check('全关：外来 IP 也放行（不设卡）', guardNetwork(req({})) === null);
  netmode.writeNetMode({ whitelistEnabled: true, whitelistIps: [] });
  check('开了但名单是空的：名单外照样拦（开着却谁都不放是对的手感 —— 别替手改文件的人悄悄敞门）',
    guardNetwork(req({}))?.code === 'E3003');
  check('同状态下本机直连仍然放行', guardNetwork(req({ ip: '127.0.0.1' })) === null);

  console.log('\n⑤ 闸 —— 白名单开：拦外来、放名单内、本机直连永远放行');
  netmode.writeNetMode({ whitelistEnabled: true, whitelistIps: ['192.168.5.0/24'] });
  let g = guardNetwork(req({ ip: '203.0.113.7' }));
  check('名单外 → E3003', g?.code === CODE_IP && g?.code === 'E3003', JSON.stringify(g));
  g = guardNetwork(req({ ip: '192.168.5.77' }));
  check('网段内 → 放行', g === null, JSON.stringify(g));
  g = guardNetwork(req({ ip: '127.0.0.1', host: 'whatever.example.com' }));
  check('本机直连永远放行（不在名单也一样 —— 误锁自救的门）', g === null, JSON.stringify(g));
  g = guardNetwork(req({ ip: '::ffff:203.0.113.7' }));
  check('双栈报法（::ffff: 外来 IP）照样拦', g?.code === 'E3003', JSON.stringify(g));

  console.log('\n⑥ 闸 —— 伪造面：peer 回环 + 转发头 ≠ 本机直连');
  g = guardNetwork(req({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.7' } }));
  check('回环 peer 带 XFF（无 trustProxy）→ 按 XFF 判成外来 → E3003（防反代漏配时伪装本机）',
    g?.code === 'E3003', JSON.stringify(g));
  g = guardNetwork(req({ ip: '127.0.0.1', headers: { 'x-real-ip': '1' } }));
  check('任何转发头（x-real-ip）都取消本机直连资格', g?.code === 'E3003', JSON.stringify(g));

  console.log('\n⑦ 闸 —— trustProxy：按 XFF 第一段取真实来源');
  process.env.BANDI_TRUST_PROXY = '1';
  g = guardNetwork(req({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }));
  check('XFF 第一段不在名单 → E3003', g?.code === 'E3003', JSON.stringify(g));
  g = guardNetwork(req({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '192.168.5.77, 10.0.0.1' } }));
  check('XFF 第一段在网段内 → 放行', g === null, JSON.stringify(g));
  check('clientIpOf：trustProxy 下取 XFF 第一段并归一',
    clientIpOf(req({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '::ffff:203.0.113.7, x' } })) === '203.0.113.7');
  delete process.env.BANDI_TRUST_PROXY;
  check('clientIpOf：没 trustProxy 一概不信转发头，看 socket peer',
    clientIpOf(req({ ip: '198.51.100.2', headers: { 'x-forwarded-for': '1.2.3.4' } })) === '198.51.100.2');

  console.log('\n⑧ 闸 —— 域名绑定');
  netmode.writeNetMode({ whitelistEnabled: false, boundDomain: 'pan.example.com' });
  g = guardNetwork(req({ host: 'evil.example.com' }));
  check('Host 不是绑定域名 → E3004', g?.code === 'E3004', JSON.stringify(g));
  g = guardNetwork(req({ host: 'PAN.Example.COM.' }));
  check('大小写 / 结尾点归一后相等 → 放行', g === null, JSON.stringify(g));
  g = guardNetwork(req({ host: 'pan.example.com:8443' }));
  check('Host 带端口：hostnameOf 剥端口后相等 → 放行', g === null, JSON.stringify(g));
  g = guardNetwork(req({ ip: '127.0.0.1', host: 'evil.example.com' }));
  check('本机直连不看 Host（域名绑错也不锁本机）', g === null, JSON.stringify(g));
  g = guardNetwork(req({ ip: '127.0.0.1', host: 'evil.example.com', headers: { 'x-forwarded-for': '203.0.113.7' } }));
  check('带转发头的回环不是本机直连：域名绑定照样拦', g?.code === 'E3004', JSON.stringify(g));

  console.log('\n⑨ 两道闸同时开：任一不过都拒');
  netmode.writeNetMode({ whitelistEnabled: true, whitelistIps: ['203.0.113.0/24'], boundDomain: 'pan.example.com' });
  g = guardNetwork(req({ ip: '203.0.113.7', host: 'evil.example.com' }));
  check('IP 在名单但 Host 不对 → E3004', g?.code === 'E3004', JSON.stringify(g));
  g = guardNetwork(req({ ip: '198.51.100.2', host: 'pan.example.com' }));
  check('Host 对但 IP 不在名单 → E3003', g?.code === 'E3003', JSON.stringify(g));
  g = guardNetwork(req({ ip: '203.0.113.7', host: 'pan.example.com' }));
  check('两道都过 → 放行', g === null, JSON.stringify(g));
} catch (err) {
  console.log('\n跑挂了：' + String(err?.stack ?? err));
  failed += 1;
} finally {
  try { fs.rmSync(process.env.BANDI_DATA, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
