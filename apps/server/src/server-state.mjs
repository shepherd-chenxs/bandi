/* server-state.mjs —— 进程级的**有状态量**（2026-10-22 由 server.mjs 拆出）。
 *
 * AUTH：鉴权上下文（**对象身份不变**是契约 —— routes 靠它读令牌/要求位；
 *   监听地址整个进程生命周期不变，AUTH 不会再被原地换过）。
 * boundHost：这个进程**现在实际**听着什么（别拿 config.host 冒充 —— bind 后可能规范化）。
 *
 * 原则：**状态在服务端、且只有一份** —— 谁要读都从这儿拿，别再复制一份。
 */
import { host } from './config.mjs';

export const SERVER = { AUTH: null, boundHost: host };
