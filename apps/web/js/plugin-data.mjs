/**
 * plugin-data.mjs —— 声明式插件数据源的**纯整形**（2026-10-24）。
 *
 * `source` 上那三个通用修饰（filter / sort / limit）和 `stats` 的 `calc` 聚合都在这里。
 * 为什么单独拆一个文件：这段是纯函数，**不碰 DOM** —— 拆出来 Node 里能直接 import 着测
 * （experts.mjs 一进来就要 document，浏览器外跑不了）。渲染只管把结果画出来。
 *
 * 口径只有一条：**聚合规则写在 manifest 里**，宿主只提供算子。
 * 页面要多加一个数（比如「未纳管几个」），改 manifest 就行，不用回来改这个文件。
 */

/** 宿主认识的聚合算子。别往这里加业务口径 —— 那是 manifest 的 calc 的事 */
export const CALC_OPS = ['count', 'countIf', 'sum', 'sumIf'];

/**
 * 一个字段值算不算"命中"声明里的 `is`。
 * `is` 省略＝取真值；`is` 是数组＝值在其中之一即可；其余按同值比
 * （`true` 与 `"true"` 视为同一个 —— 接口有的给布尔有的给字符串，别让作者去猜）。
 */
export function hitValue(v, is) {
  const truthy = !!v && v !== 'false' && v !== '0';
  if (is === undefined) return truthy;
  if (Array.isArray(is)) return is.some((x) => hitValue(v, x));
  // `is:false` 是"取假值"，不是"取真值"—— 写反了页面就少一整栏，而且不报错
  if (typeof is === 'boolean') return is ? truthy : !truthy;
  return String(v ?? '') === String(is);
}

/**
 * `source` 上的三个修饰：filter / sort / limit（都可选）。
 * 返回 `{ rows, total }` —— total 是筛之前有几行，给模板的 `{total_count}` 用。
 *
 * 排序时空值**恒排最后**（不随 dir 翻面）：`updated` 这种字段对未纳管的项目就是空串，
 * 按倒序排它该垫底，翻成升序也不该顶到最前 —— 空代表"没有值"，不是"最小值"。
 */
export function applySource(rows, source = {}) {
  const total = rows.length;
  let out = rows;

  const f = source?.filter;
  if (f && typeof f === 'object' && f.field) out = out.filter((r) => hitValue(r?.[f.field], f.is));

  const so = source?.sort;
  if (so && so.by) {
    const dir = so.dir === 'asc' ? 1 : -1;
    out = [...out].sort((a, b) => {
      const av = a?.[so.by];
      const bv = b?.[so.by];
      const aEmpty = av == null || av === '';
      const bEmpty = bv == null || bv === '';
      if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  if (Number.isInteger(source?.limit) && source.limit > 0) out = out.slice(0, source.limit);
  return { rows: out, total };
}

/** 单个算子 → 数字。arg 是声明里跟算子配对的那个值（字段名 / `{field, is}`）。 */
function calcOp(op, arg, rows) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const fieldOf = (a) => (typeof a === 'string' ? a : String(a?.field ?? ''));
  switch (op) {
    case 'count':
      return rows.length;
    case 'countIf': {
      if (arg && typeof arg === 'object') return rows.filter((r) => hitValue(r?.[arg.field], arg.is)).length;
      return rows.filter((r) => hitValue(r?.[fieldOf(arg)])).length;
    }
    case 'sum':
      return rows.reduce((s, r) => s + num(r?.[fieldOf(arg)]), 0);
    case 'sumIf': {
      const where = arg?.where;
      const keep =
        where && typeof where === 'object'
          ? (r) => hitValue(r?.[where.field], where.is)
          : (r) => hitValue(r?.[String(where ?? '')]);
      return rows.filter(keep).reduce((s, r) => s + num(r?.[fieldOf(arg)]), 0);
    }
    default:
      return 0;
  }
}

/**
 * 把一条 `calc` 声明算成一组变量（键就是模板里 `{键}` 的名字）。
 * 三种写法：裸算子名 → 变量名记作 `value`；`{算子: 字段}` → 同名变量；`{变量名: 子声明}` → 一次算多个。
 * 例：`{"released":{"sum":"released_count"},"managed":{"countIf":"ok"}}` → `{released, managed}`。
 */
export function calcVars(calc, rows) {
  const out = {};
  if (calc == null) return out;
  if (typeof calc === 'string') {
    out.value = calcOp(calc, null, rows);
    return out;
  }
  if (typeof calc !== 'object' || Array.isArray(calc)) return out;
  for (const [key, val] of Object.entries(calc)) {
    /*
     * **键是算子名就一定是算子**，值可以是字段名、`{field,is}` 或 `where` 形状。
     * 想给变量起名靠"键不是算子"，别拿算子名当变量名 —— 那两种写法长一样，
     * 分不清的话 `{countIf:{field,is}}` 会被当成变量名递归下去，算出 0（写测试时遇到过）。
     */
    if (CALC_OPS.includes(key)) {
      out[key] = calcOp(key, val, rows);
      continue;
    }
    // 键不是算子 → 当变量名，值再当一条子声明递归算（`{"released":{"sum":"released_count"}}`）
    const sub = calcVars(val, rows);
    const first = sub.value !== undefined ? sub.value : Object.values(sub)[0];
    out[key] = first ?? 0;
  }
  return out;
}
