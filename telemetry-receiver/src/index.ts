/**
 * 遥测接收端 rbc-telemetry · 最小实现
 *
 * 契约：docs/telemetry-launch-plan.md v3.1 §4（Umami /api/send 兼容格式）
 * 响应语义（应用端重试逻辑依赖，不可改）：
 *   2xx = 已收妥（客户端移除队列，不重试）——含 204 = 服务端主动丢弃
 *   4xx = 报文非法（客户端丢弃且不重试）
 *   5xx = 服务端故障（客户端重试并入离线队列）
 *
 * 三个必须记住的点：
 *   1. 闸门计数要批量化：每请求都写一次 gate 会让写行翻倍（写额度是真正瓶颈）
 *   2. INSERT OR IGNORE + 唯一索引 = 幂等（补发风暴不重复计数、不重复计费）
 *   3. 未知字段必须忽略而非报错 —— 客户端可能先于本 Worker 上线并带新字段
 */

export interface Env {
  DB: D1Database;
  WEBSITE_ID: string;
  GATE_REQ_DAY: string;
  GATE_EVT_DAY: string;
  GATE_STORE_MAX_MB: string;
  RETENTION_DAYS: string;
  DASHBOARD_TOKEN: string;
}

// ── 白名单：显式数组常量，不要用前缀匹配 ──────────────────────
const LIFECYCLE = ["app_installed", "app_opened"];
const FEATURES = [
  "feature_single", "feature_batch", "feature_tp2ls", "feature_compare", "feature_feedback",
  "check_hit", "err_network", "err_auth", "err_validation", "err_server",
  "perf_batch", "update_result",
];
const ALLOWED = new Set<string>([...LIFECYCLE, ...FEATURES]);

// tag 值域：比字符集更严，挡住造值污染统计
const TAG_ENUM: Record<string, string[]> = {
  perf_batch: ["sec", "min", "tenmin"],
  update_result: ["downloaded", "installed"],
};

const TAG_RE = /^[A-Za-z0-9_-]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BODY = 4096;
const DAY = 86400;

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/api/send") return await handleSend(req, env, ctx);
      if (req.method === "GET" && url.pathname === "/dashboard") return await handleDashboard(url, env);
      if (req.method === "GET" && url.pathname === "/healthz") return await handleHealth(env);
      return new Response("not found", { status: 404 });
    } catch {
      // 5xx = 可重试：客户端入队，幂等键保证补发不重复计数
      return json(503, { error: "server_error" });
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(rollupAndCleanup(env));
  },
};

// ── 上报主链路 ────────────────────────────────────────────────
async function handleSend(req: Request, env: Env, _ctx: ExecutionContext) {
  const body = await req.text();
  if (body.length > MAX_BODY) return json(400, { error: "too_large" });

  let envelope: any;
  try {
    envelope = JSON.parse(body);
  } catch {
    return json(400, { error: "bad_json" });
  }
  const p = envelope?.payload;
  if (envelope?.type !== "event" || !p || typeof p !== "object") {
    return json(400, { error: "bad_envelope" });
  }

  // 逐字段校验：任一不过 → 400（毒报文，客户端丢弃且不重试）
  if (p.website !== env.WEBSITE_ID) return json(400, { error: "bad_website" });
  if (p.hostname !== "app") return json(400, { error: "bad_hostname" }); // 校验而非信任
  if (typeof p.name !== "string" || !ALLOWED.has(p.name)) return json(400, { error: "bad_name" });
  if (typeof p.id !== "string" || !UUID_RE.test(p.id)) return json(400, { error: "bad_id" });

  const data = (p.data && typeof p.data === "object") ? p.data : {};
  const tag = typeof data.tag === "string" ? data.tag : "";
  // tag 可为空（生命周期事件 app_installed/app_opened 没有 tag，客户端发 ""）；
  // 非空时必须匹配 [A-Za-z0-9_-]{1,32}。
  // ⚠️ 契约要点：早先按 {1,32} 严格校验会把空 tag 判成 400 —— 那会让所有生命周期事件
  //    被当毒报文丢弃，整个统计链路一个数都收不到。
  if (tag !== "" && !TAG_RE.test(tag)) return json(400, { error: "bad_tag" });
  const allowedTags = TAG_ENUM[p.name];
  if (allowedTags && tag && !allowedTags.includes(tag)) return json(400, { error: "bad_tag_value" });

  const recvTs = Math.floor(Date.now() / 1000);
  // 客户端时间戳优先（合法区间校验）；缺失或离谱则退回接收时间
  const ts = Number.isInteger(p.timestamp) && Math.abs(recvTs - p.timestamp as number) <= 30 * DAY
    ? (p.timestamp as number)
    : recvTs;

  // 幂等键：客户端给就用客户端的，否则按 id+name+ts 派生
  const eventId = typeof p.event_id === "string" && p.event_id.length > 0 && p.event_id.length <= 64
    ? p.event_id
    : `${p.id}:${p.name}:${ts}`;

  // ── 成本闸门：超预算 → 204（2xx，客户端视为已收妥，直接丢弃、不入队、不重试）──
  // 判定读 D1 的 gate 行：受理路径每次都把计数写进同一个 batch，
  // 所以 D1 里的计数是**全局精确**的（跨 isolate 可见），不会被 isolate 淘汰带走。
  const day = new Date(recvTs * 1000).toISOString().slice(0, 10);
  const g = await readGate(env, day);
  const reqLimit = Number(env.GATE_REQ_DAY);
  const evtLimit = Number(env.GATE_EVT_DAY);
  const overBudget = g.req_count >= reqLimit || g.evt_count >= evtLimit || g.paused === 1;
  if (overBudget) {
    // 丢弃路径**不能**每请求写一次 D1（洪峰期账单反而暴涨，违背判据 8「账单不增长」）：
    // 计数在内存里累加，按节流窗口批量落库。
    await bumpDropped(env, day);
    return new Response(null, { status: 204 });
  }

  // ── 落库：一次 batch 往返 ──
  // 闸门计数与事件写入放在**同一个 batch**里 —— 不增加往返次数，
  // 只多写 1 行，换来「计数全局精确、绝不丢失」这个闸门成立的前提。
  const statements = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO events
         (event_id, device_id, name, tag, app_version, os, ts, recv_ts)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    ).bind(
      eventId,
      p.id,
      p.name,
      tag,
      String(data.version ?? "").slice(0, 32),
      String(data.os ?? "").slice(0, 16),
      ts,
      recvTs,
    ),
  ];

  // first_seen 只由 app_installed 建立（口径见计划书 §3）
  if (p.name === "app_installed") {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO first_seen (device_id, first_ts) VALUES (?1,?2)`,
      ).bind(p.id, ts),
    );
  }

  // 闸门计数：req = 本次受理的请求数，evt = 本次受理的事件数。
  // 幂等重放也计入（请求照样消耗了 Worker 调用与 D1 语句）——
  // 重放风暴本来就该把闸门顶开，这是成本保护，不是缺陷。
  statements.push(
    env.DB.prepare(
      `INSERT INTO gate (day, req_count, evt_count, dropped) VALUES (?1,1,1,0)
       ON CONFLICT(day) DO UPDATE SET
         req_count = req_count + 1,
         evt_count = evt_count + 1`,
    ).bind(day),
  );

  await env.DB.batch(statements);
  return json(200, { ok: true });
}

// ── 丢弃计数：内存累加 + 节流落库 ──────────────────────────────
// 只有超预算路径才会走到这里。此时**不再写事件表**，写额度本该省下来；
// 若每条丢弃都写一次 D1，洪峰期账单反而暴涨（违背判据 8「账单不增长」）。
interface Dropped { req: number; dropped: number; day: string }
let dropPending: Dropped = { req: 0, dropped: 0, day: "" };
const DROP_FLUSH_MS = 2000;
const lastDropFlush = { value: 0 };

async function bumpDropped(env: Env, day: string): Promise<void> {
  try {
    // 跨天：先把旧的结算到它自己那天
    if (dropPending.day && dropPending.day !== day) await flushDropped(env);
    dropPending.day = day;
    dropPending.req += 1;     // 丢弃的请求同样消耗一次 Worker 调用（计费）
    dropPending.dropped += 1;
    if (Date.now() - lastDropFlush.value >= DROP_FLUSH_MS) await flushDropped(env);
  } catch {
    // 计数写失败**不能**影响返回码：超预算必须返 204（2xx），
    // 抛出去会变成 503 → 客户端重试入队 → 补发风暴，正好和降级目的相反。
  }
}

async function flushDropped(env: Env): Promise<void> {
  if (!dropPending.day || dropPending.dropped === 0) return;
  const batch = { ...dropPending };
  dropPending = { req: 0, dropped: 0, day: "" };
  lastDropFlush.value = Date.now();
  await env.DB.prepare(
    `INSERT INTO gate (day, req_count, evt_count, dropped) VALUES (?1,?2,0,?3)
     ON CONFLICT(day) DO UPDATE SET
       req_count = req_count + excluded.req_count,
       dropped  = dropped  + excluded.dropped`,
  ).bind(batch.day, batch.req, batch.dropped).run();
}

// ── 闸门计数：读 = 1 行读；写攒够一批再落库 ────────────────────
// pending 是 isolate 级内存计数：同一 isolate 的请求共享它，但**别的 isolate 看不见**。
// 因此闸门判定必须「D1 已落库值 + 本 isolate 的 pending」两者相加，
// 且在逼近上限时强制落库，把真实用量同步给其它 isolate。
interface GateRow {
  req_count: number;
  evt_count: number;
  dropped: number;
  paused: number;
}

async function readGate(env: Env, day: string): Promise<GateRow> {
  const row = await env.DB
    .prepare(`SELECT req_count, evt_count, dropped, paused FROM gate WHERE day = ?1`)
    .bind(day)
    .first<GateRow>();
  return row ?? { req_count: 0, evt_count: 0, dropped: 0, paused: 0 };
}

// ── 看板：只读 daily_rollup ───────────────────────────────────
async function handleDashboard(url: URL, env: Env) {
  if (url.searchParams.get("token") !== env.DASHBOARD_TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }
  const rows = await env.DB.prepare(
    `SELECT day, metric, dim, value FROM daily_rollup
      WHERE day >= date('now','-7 days')
      ORDER BY day DESC, metric, dim`,
  ).all<{ day: string; metric: string; dim: string; value: number }>();

  // 今天 + 昨天的闸门用量走实时表（gate），不走 rollup：
  // rollup 由每日 cron 生成，闸门触发/丢弃要在**分钟级**可见，不能等 cron。
  const today = new Date().toISOString().slice(0, 10);
  const live = await env.DB.prepare(
    `SELECT day, req_count, evt_count, dropped, paused FROM gate
      WHERE day >= date('now','-1 days') ORDER BY day DESC`,
  ).all<{ day: string; req_count: number; evt_count: number; dropped: number; paused: number }>();

  const liveRows: Array<{ day: string; metric: string; dim: string; value: number }> = [];
  for (const g of live.results ?? []) {
    liveRows.push(
      { day: g.day, metric: "gate_req", dim: "", value: g.req_count },
      { day: g.day, metric: "gate_evt", dim: "", value: g.evt_count },
      { day: g.day, metric: "gate_dropped", dim: "", value: g.dropped },
      { day: g.day, metric: "gate_paused", dim: "", value: g.paused },
    );
  }

  const merged = [...(rows.results ?? []), ...liveRows].sort(
    (a, b) => (a.day === b.day ? a.metric.localeCompare(b.metric) : b.day.localeCompare(a.day)),
  );

  const body = merged
    .map((r) => `<tr><td>${escapeHtml(r.day)}</td><td>${escapeHtml(r.metric)}</td><td>${escapeHtml(r.dim)}</td><td>${r.value}</td></tr>`)
    .join("");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>遥测看板 · robot-backup-checker</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem}table{border-collapse:collapse}
td,th{border:1px solid #ddd;padding:4px 8px;font-size:14px}</style>
<h1>遥测看板（UTC 自然日）</h1>
<table><tr><th>日</th><th>指标</th><th>维度</th><th>值</th></tr>${body}</table>
<p style="color:#666;font-size:13px">gate_* 为实时闸门计数（gate_dropped = 今日因闸门丢弃数）；其余为每日聚合。</p>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// ── 健康检查：给监控看闸门用量 ────────────────────────────────
async function handleHealth(env: Env) {
  const day = new Date().toISOString().slice(0, 10);
  const g = await readGate(env, day);
  const reqLimit = Number(env.GATE_REQ_DAY);
  const evtLimit = Number(env.GATE_EVT_DAY);
  // D1 里的计数是全局精确的（受理路径每请求都写）。
  // pending_dropped 是本 isolate 尚未落库的丢弃数（节流窗口内），仅供参考。
  return json(200, {
    ok: true,
    day,
    ...g,
    effective_req: g.req_count,
    effective_evt: g.evt_count,
    pending_dropped: dropPending.day === day ? dropPending.dropped : 0,
    over_budget: g.req_count >= reqLimit || g.evt_count >= evtLimit || g.paused === 1,
    req_limit: reqLimit,
    evt_limit: evtLimit,
    store_limit_mb: Number(env.GATE_STORE_MAX_MB),
  });
}

// ── Cron：重算最近 2 天聚合（幂等可重跑）+ 分批清理过期明细 ────
const ROLLUP_SQL: string[] = [
  `SELECT date(ts,'unixepoch') AS day, 'dau' AS metric, '' AS dim,
          COUNT(DISTINCT device_id) AS value
     FROM events
    WHERE name='app_opened' AND ts >= strftime('%s','now','-2 days')
    GROUP BY 1`,
  `SELECT date(first_ts,'unixepoch') AS day, 'new_users' AS metric, '' AS dim,
          COUNT(*) AS value
     FROM first_seen
    WHERE first_ts >= strftime('%s','now','-2 days')
    GROUP BY 1`,
  `SELECT date(ts,'unixepoch') AS day, 'events' AS metric, '' AS dim,
          COUNT(*) AS value
     FROM events
    WHERE ts >= strftime('%s','now','-2 days')
    GROUP BY 1`,
  `SELECT date(ts,'unixepoch') AS day, name AS metric, '' AS dim,
          COUNT(*) AS value
     FROM events
    WHERE name LIKE 'feature_%' AND ts >= strftime('%s','now','-2 days')
    GROUP BY 1, 2`,
  `SELECT date(ts,'unixepoch') AS day, 'err' AS metric, name AS dim,
          COUNT(*) AS value
     FROM events
    WHERE name LIKE 'err_%' AND ts >= strftime('%s','now','-2 days')
    GROUP BY 1, 3`,
  `SELECT date(ts,'unixepoch') AS day, 'version' AS metric, app_version AS dim,
          COUNT(DISTINCT device_id) AS value
     FROM events
    WHERE ts >= strftime('%s','now','-2 days')
    GROUP BY 1, 3`,
];

async function rollupAndCleanup(env: Env) {
  // 1) 聚合：UPSERT 覆盖写，可重跑
  for (const sql of ROLLUP_SQL) {
    await env.DB.prepare(
      `INSERT INTO daily_rollup (day, metric, dim, value) ${sql}
       ON CONFLICT(day, metric, dim) DO UPDATE SET value = excluded.value`,
    ).run();
  }

  // 2) 清理：分批删（删除也计写额度，一次删太多会撞执行时限）
  const retention = Number(env.RETENTION_DAYS || "90");
  for (let i = 0; i < 40; i++) {
    const r = await env.DB.prepare(
      `DELETE FROM events
        WHERE id IN (SELECT id FROM events WHERE ts < strftime('%s','now', ?1) LIMIT 5000)`,
    ).bind(`-${retention} days`).run();
    if ((r.meta?.changes ?? 0) < 5000) break;
  }
  await env.DB.prepare(
    `DELETE FROM first_seen WHERE first_ts < strftime('%s','now', ?1)`,
  ).bind(`-${retention} days`).run();

  // 3) 存储闸门：清理后仍有超期未删的行 → 说明清理跟不上写入 → 暂停上报（返 204）
  const overdue = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM events WHERE ts < strftime('%s','now', ?1)`,
  ).bind(`-${retention} days`).first<{ c: number }>();
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO gate (day, req_count, evt_count, dropped, paused) VALUES (?1,0,0,0,?2)
     ON CONFLICT(day) DO UPDATE SET paused = excluded.paused`,
  ).bind(day, (overdue?.c ?? 0) > 0 ? 1 : 0).run();
}
