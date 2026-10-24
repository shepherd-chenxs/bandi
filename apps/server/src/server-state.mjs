/* server-state.mjs —— 进程级的**有状态量**（2026-10-22 由 server.mjs 拆出）。
 *
 * AUTH：鉴权上下文（监听地址变化时原地 Object.assign，**对象身份不变**是契约 ——
 *   routes/runtime.mjs 靠它把新令牌塞进 Cookie）。
 * boundHost：这个进程**现在实际**听着什么（restart 后会变；别拿 config.host 冒充）。
 * restart：原地重启监听（server.mjs 启动段赋值进来；handler 里 setTimeout(SERVER.restart) 用）。
 *
 * 原则：**状态在服务端、且只有一份** —— 谁要读都从这儿拿，别再复制一份。
 */
import { host } from './config.mjs';

export const SERVER = { AUTH: null, boundHost: host, restart: () => {} };
