/* security/tls-check.mjs —— 「现在这条链路是明文」的检测（IAM §10.1.1）。
 *
 * 为什么不强制 TLS：局域网总机（家里两台机器、公司内网）是**正常用法**，
 * 一刀切拒绝启动会把这类部署直接挡在门外；而自签证书在浏览器里还要点"继续访问"，
 * 体验比明文更差。所以默认只**告警**，并且告警要出现在**人一定会看到的地方**（登录页）。
 *
 * 三档（与 §10.1.1 的表一一对应）：
 *   监听回环                → 不检查（单机形态零配置不变）
 *   非回环 + 无 trustProxy  → warn 日志 + 登录页黄条
 *   同上 + BANDI_TLS_STRICT=on → 拒绝启动（给"必须防呆"的公网部署）
 *   有 BANDI_TRUST_PROXY    → 不告警（声明了"证书在反代/隧道那层"，§5.2 同一个开关）
 */
import { trustProxy } from '../config.mjs';
import { isLoopbackHost } from './source.mjs';

const state = { warn: false, fatal: false, text: '' };

/**
 * 启动时算一次。返回 `{ warn, fatal, text }`。
 * @param {string} host 实际监听地址（`SERVER.boundHost`）
 */
export function evaluate(host) {
  state.warn = false;
  state.fatal = false;
  state.text = '';
  if (isLoopbackHost(host)) return { ...state }; // 单机：这条链路没出网卡
  if (trustProxy) return { ...state }; // 证书在反代/隧道那层（用户已声明）
  state.warn = true;
  state.text = '当前是明文 HTTP（没有 TLS，也没声明反代）—— 同一网段里的其他机器可以嗅探密码、Cookie 与会话';
  if (/^(1|on|true|yes)$/i.test(String(process.env.BANDI_TLS_STRICT ?? '').trim())) state.fatal = true;
  return { ...state };
}

/** 登录页要显示的告警（空串 = 不显示） */
export function warning() {
  return state.warn ? state.text : '';
}
