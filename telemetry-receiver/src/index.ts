/**
 * 遥测接收端 rbc-telemetry · 最小实现
 *
 * 契约正本：docs/telemetry-launch-plan.md §4（Umami /api/send 兼容格式）
 *   ⚠️ **正本不在本仓** —— 在公开仓 Ikalus1988/ai-robot-backup-checker-feedback，
 *      固定 commit SHA 见 README「契约正本」一节。本仓只是实现。
 * 响应语义（应用端重试逻辑依赖，不可改）：
 *   2xx = 已收妥（客户端移除队列，不重试）——含 204 = 服务端主动丢弃
 *   4xx = 报文非法（客户端丢弃且不重试）
 *   5xx = 服务端故障（客户端重试并入离线队列）
 *
 * ⚠️ 本仓新增的响应码（契约正本尚未覆盖，实施方 B 必须配合；已在 README 写明）：
 *   401 = 上报端鉴权失败（缺/错 X-Ingest-Key）→ 落在 4xx 语义里：丢弃不重试。
 *         这是**故意的**：客户端 key 配错时若返回 5xx，它会无限重试并入离线队列，
 *         变成重试风暴；4xx 让它立刻停下来报警。
 *   413 = 报文过大（非法）→ 落在 4xx 语义里：丢弃不重试。
 *   429 = 报文**合法**但超出单 isolate 速率 → **唯一可重试的 4xx**（契约的例外）。
 *         客户端必须读 Retry-After 头，退避后重试；不能当 4xx 直接丢弃。
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
  /** 已废弃：单位由「MB」改为「超期未清行数」，新名字见 GATE_RETENTION_BACKLOG_ROWS */
  GATE_STORE_MAX_MB?: string;
  /** 存储闸门新旋钮：清理后仍超期的行数超过它 → 暂停上报（见 README「存储闸门」） */
  GATE_RETENTION_BACKLOG_ROWS?: string;
  RETENTION_DAYS: string;
  DASHBOARD_TOKEN: string;
  /** 上报端共享密钥（CF secret）。fail closed：没配 = 拒绝所有上报 */
  INGEST_KEY: string;
  /** 每 isolate 每分钟允许的上报请求数（令牌桶容量） */
  RATE_LIMIT_PER_MIN?: string;
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
// UUID 放宽：接受 v1–v8、大小写不敏感。
// 为什么放宽（与文件头「未知字段必须忽略」同源）：客户端可能用 UUID v7（时间有序）
// 或直接给大写十六进制；早先只收「小写 v4」的写法会让这类客户端 **100% 静默丢数**
// —— 客户端对 4xx 不重试、不告警，服务端只会看到「怎么一条都没有」。
// 仍拒掉非 UUID 形态（长度/字符集不对），否则毒报文会污染 device_id 统计。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 4096;
const DAY = 86400;

// 上报端共享密钥的请求头名（客户端必须带）
const INGEST_KEY_HEADER = "X-Ingest-Key";

// 限流默认档：宽松到不影响正常客户端（每 isolate 每分钟 120 次），
// 缺配置时用它兜底 + console.error 提示要显式配置。
const DEFAULT_RATE_LIMIT_PER_MIN = 120;
// 存储闸门（超期未清行数）缺省值：保守（宁可早暂停也别让库无限长）
const DEFAULT_BACKLOG_ROWS = 1000;

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// ── 常数时间比较 ──────────────────────────────────────────────
// 共享密钥/看板口令都不能用 !== 比：常规字符串比较会在第一个不同字节处短路，
// 攻击者可用响应时间差逐字节爆破。
// 用同步实现（crypto.subtle.compare 是异步的，热路径上 await 会把一次请求
// 拆成两个微任务，没有必要）。
// 长度差也会被计入 diff —— 不因为「长度不等」就提前返回。
function timingSafeEqual(a: string, b: string): boolean {
  const la = a.length;
  const lb = b.length;
  let diff = la ^ lb;
  const n = la > lb ? la : lb;
  for (let i = 0; i < n; i++) {
    const ca = i < la ? a.charCodeAt(i) : 0;
    const cb = i < lb ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

// ── 配置错误：响亮失败，绝不静默 ──────────────────────────────
// 这个 Worker 存在的意义就是「一个刹车」。刹车若因为环境变量拼错而静默失效
// （Number(undefined) = NaN → 所有比较恒为 false），比没有刹车还危险：
// 运营看到的是「一切正常」，账单在涨。
// 所以：配置非法一律抛 ConfigError，由 fetch 顶层转成 500 + {error:"misconfigured"}。
class ConfigError extends Error {
  constructor(
    readonly varName: string,
    readonly rawValue: string | undefined,
    readonly reason: string,
  ) {
    super(`配置错误：${varName} ${reason}`);
    this.name = "ConfigError";
  }
  // 只回显变量名与原因；**不回显密钥的值**
  describe(): string {
    return this.rawValue === undefined
      ? `${this.varName} 缺失`
      : `${this.varName} 的值非法（必须是正数）`;
  }
}

// 解析正整数型配置：缺失 → null；存在但非有限/非正数 → 抛 ConfigError
function parsePositiveInt(raw: string | undefined, name: string): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(name, raw, "不是有限正数");
  return n;
}

// 解析必填的正整数型配置：缺失也抛（缺失同样是配置错误）
function requirePositiveInt(env: Env, name: string): number {
  const raw = (env as unknown as Record<string, string | undefined>)[name];
  const n = parsePositiveInt(raw, name);
  if (n === null) throw new ConfigError(name, undefined, "缺失");
  return n;
}

// 同一个 isolate 里同一条配置告警只打一次（否则每次请求都刷屏，告警反而被淹没）
const loggedOnce = new Set<string>();
function logOnce(key: string, level: "error" | "warn", message: string) {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  console[level](message);
}

// 限流阈值：缺失 → 宽松默认档 + 一次响亮告警；存在但非法 → 抛（响亮失败）
function resolveRateLimit(env: Env): number {
  const raw = env.RATE_LIMIT_PER_MIN;
  if (raw === undefined || raw === null || raw === "") {
    logOnce(
      "RATE_LIMIT_PER_MIN",
      "error",
      `[config] RATE_LIMIT_PER_MIN 缺失 → 使用默认 ${DEFAULT_RATE_LIMIT_PER_MIN}/分钟/isolate。请在 wrangler.toml [vars] 显式配置。`,
    );
    return DEFAULT_RATE_LIMIT_PER_MIN;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError("RATE_LIMIT_PER_MIN", raw, "不是有限正数");
  return n;
}

// 存储闸门阈值（超期未清行数）：新变量优先，兼容旧变量 GATE_STORE_MAX_MB
// ⚠️ GATE_STORE_MAX_MB 曾经是「MB 预算」，但代码里从来没有真正按 MB 判过
//    （真正判的是「清理后仍有多少超期行」，二值），是个死旋钮。
//    现在统一成「行数」语义，并把旧名当兼容别名（单位变了，日志里会明说）。
function resolveBacklogLimit(env: Env): { limit: number; source: "config" | "legacy" | "default" } {
  const cur = parsePositiveInt(env.GATE_RETENTION_BACKLOG_ROWS, "GATE_RETENTION_BACKLOG_ROWS"); // 非法 → 抛
  if (cur !== null) return { limit: cur, source: "config" };

  const legacy = parsePositiveInt(env.GATE_STORE_MAX_MB, "GATE_STORE_MAX_MB"); // 非法 → 抛（响亮）
  if (legacy !== null) {
    logOnce(
      "GATE_STORE_MAX_MB",
      "warn",
      `[config] GATE_STORE_MAX_MB 已废弃（它从来没按 MB 判过，是个死旋钮）。` +
        `现按「超期未清行数」语义使用，值 ${legacy} 行。请改配 GATE_RETENTION_BACKLOG_ROWS。`,
    );
    return { limit: legacy, source: "legacy" };
  }

  logOnce(
    "GATE_RETENTION_BACKLOG_ROWS",
    "error",
    `[config] GATE_RETENTION_BACKLOG_ROWS 缺失 → 使用保守默认 ${DEFAULT_BACKLOG_ROWS} 行。` +
      "请在 wrangler.toml [vars] 显式配置（否则闸门阈值由代码兜底，容易忘了调）。",
  );
  return { limit: DEFAULT_BACKLOG_ROWS, source: "default" };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/api/send") return await handleSend(req, env, ctx);
      if (req.method === "GET" && url.pathname === "/dashboard") return await handleDashboard(req, url, env);
      if (req.method === "GET" && url.pathname === "/healthz") return await handleHealth(env);
      return notFound(url, req.method);
    } catch (err) {
      // 配置错误 → 500（响亮失败）：刹车没配好时不该让客户端以为「服务端故障可重试」
      if (err instanceof ConfigError) {
        console.error(`[config] ${err.varName} ${err.reason} —— 拒绝服务（不静默放行、不静默失效）`);
        return json(500, {
          error: "misconfigured",
          variable: err.varName,
          detail: err.describe(),
          message: `服务端配置错误（${err.varName}），请检查 wrangler.toml [vars] 与 CF secrets。`,
        });
      }
      // 其它异常 → 5xx = 可重试：客户端入队，幂等键保证补发不重复计数
      // ⚠️ 原来这里是 `catch {}`：异常对象被丢掉，Workers Logs 只抓 console.*，
      //    于是错误彻底静默 —— 看板失灵、闸门失效都查不到原因。
      console.error("[error] 未捕获异常：", err);
      return json(503, { error: "server_error" });
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // ⚠️ 原来没有 .catch()：rollup 失败 = waitUntil 里的未处理拒绝，
    //    cron 触发器照样报「成功」→ daily_rollup 永远不更新，看板静默失灵。
    ctx.waitUntil(
      rollupAndCleanup(env).catch((err) => {
        console.error("[cron] rollup/cleanup 失败（daily_rollup 与存储闸门未更新）：", err);
      }),
    );
  },
};

// ── 错误提示文案 ──────────────────────────────────────────────
// 裸 "not found" / "unauthorized" 对排障毫无帮助：
// 运维看到 401 会以为是端点挂了，看到 404 会以为是路径写错。
// 告诉对方「正确的地址是什么」，一分钟能省掉一轮排查。
const ENDPOINT_HINT =
  "遥测接收端 rbc-telemetry · telemetry.misakanet.org\n" +
  "可用端点：\n" +
  "  POST /api/send      上报事件（客户端用这个，需带 X-Ingest-Key 头）\n" +
  "  GET  /dashboard    看板（Authorization: Bearer <口令>，兼容 ?token=）\n" +
  "  GET  /healthz      存活 + 今日闸门用量";

function notFound(url: URL, method: string): Response {
  const body =
    `404 · 路径不存在\n\n` +
    `你请求的是：${method} ${url.pathname}\n\n` +
    `${ENDPOINT_HINT}\n\n` +
    `注意：/api/send 只接受 POST，用 GET 访问也会得到这个 404。`;
  return new Response(body, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// ── 上报端鉴权：X-Ingest-Key ──────────────────────────────────
// 为什么必须有：WEBSITE_ID = "robot-checker" 是 wrangler.toml 里的**公开常量**，
// 校验它等于没校验 —— 任何人都能伪造事件。而每条被接受的请求要写 3–4 行 D1，
// 伪造流量会烧写额度，还会触发存储闸门把 paused 置 1，
// 之后**所有真实遥测被静默 204 丢弃**（最坏情况：伪造者把真数据全灭掉）。
//
// fail closed：INGEST_KEY 没配 → 一律拒绝（500 + 明确文案），绝不退化成「没配就放行」。
// 401 落在 4xx 语义里（报文非法 → 客户端丢弃不重试）：客户端 key 配错时
// 若返回 5xx，它会无限重试并入离线队列 → 重试风暴。4xx 让它立刻停下来报警。
function checkIngestKey(req: Request, env: Env): Response | null {
  const expected = env.INGEST_KEY;
  if (!expected) {
    console.error("[auth] INGEST_KEY 未配置 → 拒绝所有上报（fail closed）。请执行 `wrangler secret put INGEST_KEY`");
    return json(500, {
      error: "misconfigured",
      variable: "INGEST_KEY",
      message: "服务端未配置 INGEST_KEY，已拒绝所有上报（fail closed）。请联系部署方。",
    });
  }
  const provided = req.headers.get(INGEST_KEY_HEADER.toLowerCase());
  if (provided === null) {
    console.warn(`[auth] 上报请求缺少 ${INGEST_KEY_HEADER} 头 → 401`);
    return json(401, {
      error: "unauthorized",
      header: INGEST_KEY_HEADER,
      message:
        `上报请求缺少 ${INGEST_KEY_HEADER} 头。请在客户端为每次 POST /api/send 带上该头，` +
        "值由部署方下发（CF secret INGEST_KEY）。缺头属于配置错误，会一直 401。",
    });
  }
  if (!timingSafeEqual(provided, expected)) {
    console.warn(`[auth] 上报请求 ${INGEST_KEY_HEADER} 不匹配 → 401`);
    return json(401, {
      error: "unauthorized",
      header: INGEST_KEY_HEADER,
      message:
        `${INGEST_KEY_HEADER} 不正确。请检查客户端是否带了对的密钥（值由部署方下发）。` +
        "按契约 4xx = 报文非法 = 丢弃且不重试，所以不会重试，请修好配置后再上报。",
    });
  }
  return null;
}

// ── 请求体大小限制：先查头，再流式读 ──────────────────────────
// ⚠️ 原来先 `await req.text()` 把整个 body 读进 isolate 内存，再检查长度：
//    CF 允许最大 100MB 的请求体 → 单个请求可以先吃掉 ~100MB 内存才被拒。
// 现在：Content-Length 超限直接 413（不读 body）；chunked（无 Content-Length）
// 时流式读取，超过 MAX_BODY 字节立刻中止。
// 状态码定案：**413**（Payload Too Large）= 报文非法 = 4xx = 客户端丢弃不重试。
//   （早先的 400 too_large 同样在 4xx 语义内，改成 413 是为了「语义更准 + 不与
//     其它 400 混淆」；两者对客户端的行为完全一致：丢弃、不重试。）
const TOO_LARGE = 413;

async function readBodyLimited(req: Request, limit: number): Promise<
  { ok: true; text: string } | { ok: false; tooLarge: true }
> {
  // 1) 先看 Content-Length（绝大多数客户端都会带）→ 超限直接拒，不碰 body
  const cl = req.headers.get("content-length");
  if (cl !== null && cl !== "") {
    const n = Number(cl);
    // Content-Length 非法（NaN）→ 不信任它，走下面的流式读取兜底
    if (Number.isFinite(n) && n > limit) return { ok: false, tooLarge: true };
  }

  // 2) 流式读取，边读边计数（chunked / 无 Content-Length / 头不可信）
  const body = req.body;
  if (!body) return { ok: true, text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        // 立刻中止上游传输，别把 100MB 读进来
        try { await reader.cancel(); } catch { /* 取消失败无所谓，已经拒了 */ }
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    // 读流失败（连接中断等）→ 当作报文读不出来，交由上层 5xx 处理（客户端会重试）
    throw new Error("body read failed");
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return { ok: true, text: new TextDecoder().decode(buf) };
}

// ── 每 isolate 令牌桶限流 ─────────────────────────────────────
// ⚠️ **per-isolate**，不是全局精确限流：CF 会把请求分散到大量 isolate，
//    每个 isolate 各有一只桶。所以它挡不住「多 isolate 并行」的突发，
//    全局成本控制仍然只靠每日闸门（那个才是跨 isolate 精确的）。
// 它的作用是：给单个 isolate 的 CPU/D1 写入设上限，挡住「单 isolate 被瞬间打爆」
// 这种最容易造成跑飞账单的情况。
// 响应码 429：报文**合法**但太频繁 → 这是 4xx「丢弃不重试」语义的一个**例外**，
//   客户端必须读 Retry-After 头退避后重试（README 已写死这条约定）。
interface TokenBucket { tokens: number; last: number }
const bucket: TokenBucket = { tokens: 0, last: 0 };
const RATE_WINDOW_MS = 60_000;

function takeToken(cap: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  if (bucket.last === 0) {
    bucket.last = now;
    bucket.tokens = cap;
  }
  const elapsed = now - bucket.last;
  // 按时间补充令牌（cap 个令牌 / 每分钟补满）
  bucket.tokens = Math.min(cap, bucket.tokens + (elapsed / RATE_WINDOW_MS) * cap);
  bucket.last = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true, retryAfterSec: 0 };
  }
  // 还差多少令牌就补一个 → 折算成等待秒数（至少 1 秒）
  const deficit = 1 - bucket.tokens;
  const sec = Math.max(1, Math.ceil((deficit / cap) * (RATE_WINDOW_MS / 1000)));
  return { ok: false, retryAfterSec: sec };
}

// ── 上报主链路 ────────────────────────────────────────────────
async function handleSend(req: Request, env: Env, _ctx: ExecutionContext) {
  // 1) 鉴权（fail closed）—— 放在读 body 之前：无密钥的请求连内存都不占
  const authFail = checkIngestKey(req, env);
  if (authFail) return authFail;

  // 2) 限流（只对已鉴权流量计数：无密钥请求不写库、不花 D1 额度，
  //    让它们去撞 401，而不是把正常客户端的桶挤爆）
  const rateLimit = resolveRateLimit(env);
  const token = takeToken(rateLimit);
  if (!token.ok) {
    console.warn(`[ratelimit] 单 isolate 速率超限（${rateLimit}/分钟）→ 429，Retry-After=${token.retryAfterSec}s`);
    return new Response(
      JSON.stringify({
        error: "rate_limited",
        message: "上报过于频繁（单 isolate 速率上限）。请读 Retry-After 头退避后重试。",
        retry_after: token.retryAfterSec,
        scope: "per-isolate",
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(token.retryAfterSec),
        },
      },
    );
  }

  // 3) 请求体大小：先查 Content-Length，再流式读（见 readBodyLimited 注释）
  const read = await readBodyLimited(req, MAX_BODY);
  if (!read.ok) {
    console.warn(`[size] 请求体超过 ${MAX_BODY} 字节 → ${TOO_LARGE}`);
    return json(TOO_LARGE, {
      error: "too_large",
      max_bytes: MAX_BODY,
      message: `请求体超过 ${MAX_BODY} 字节上限。按契约 4xx = 报文非法 = 丢弃且不重试。`,
    });
  }
  const body = read.text;
  if (body.length > MAX_BODY) {
    // 兜底：上面限的是**字节**数，字符数必然 ≤ 字节数，这个分支实际不可达；
    // 保留是为了将来若放宽字节上限，别漏掉这一道。
    console.warn(`[size] 请求体字符数超过 ${MAX_BODY} → ${TOO_LARGE}`);
    return json(TOO_LARGE, { error: "too_large", max_bytes: MAX_BODY });
  }

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

  // 幂等键：客户端给就用客户端的，否则按 id+name+tag+ts 派生
  // ⚠️ tag 必须进键：客户端时间戳是**秒级**，同一秒内发 perf_batch 的 sec 与 min
  //    两个 tag（合法组合，TAG_ENUM 里就有 3 个 tag）→ 旧键 id:name:ts 会撞车 →
  //    INSERT OR IGNORE 把第二条**静默丢掉** → 性能分布系统性少算。
  //    为什么不把 version/os 也放进键：客户端升级后补发同一事件的旧消息会带上
  //    新 version → 同一事件被插两行 → 重复计数。tag 在同一事件内恒定，安全。
  const eventId = typeof p.event_id === "string" && p.event_id.length > 0 && p.event_id.length <= 64
    ? p.event_id
    : `${p.id}:${p.name}:${tag}:${ts}`;

  // ── 成本闸门：超预算 → 204（2xx，客户端视为已收妥，直接丢弃、不入队、不重试）──
  // 判定读 D1 的 gate 行：受理路径每次都把计数写进同一个 batch，
  // 所以 D1 里的计数是**全局精确**的（跨 isolate 可见），不会被 isolate 淘汰带走。
  const day = new Date(recvTs * 1000).toISOString().slice(0, 10);
  const g = await readGate(env, day);
  // 阈值走统一解析：变量缺失/非法 → 抛 ConfigError → 顶层 500（不再静默失效）
  const reqLimit = requirePositiveInt(env, "GATE_REQ_DAY");
  const evtLimit = requirePositiveInt(env, "GATE_EVT_DAY");
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
  } catch (err) {
    // 计数写失败**不能**影响返回码：超预算必须返 204（2xx），
    // 抛出去会变成 503 → 客户端重试入队 → 补发风暴，正好和降级目的相反。
    // 但**必须留痕**：原来这里是空 catch，失败了就彻底静默（看板看不出丢过多少）。
    console.error("[gate] 丢弃计数落库失败（不影响 204 响应）：", err instanceof Error ? err.message : err);
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

// ── 看板：今日实时算 + 历史读 daily_rollup ─────────────────────
// 为什么不能只读 daily_rollup：rollup 由每日 cron（04:23 UTC）生成，
// 意味着「今天」的数据要等到次日才可见 —— 部署后到首次 cron 之间看板几乎是空的，
// cron 一挂看板就永久失灵。
// 口径一致性：今日实时算与 rollup 用**同一套 SQL 表达式**，只是数据源不同
// （今日从 events 明细实时 GROUP BY，历史从 daily_rollup 读已聚合值），
// 所以同一天的两条路径结果一致（判据 10「看板 vs 手写 SQL」）。
const LIVE_SQL: string[] = [
  `SELECT 'dau' AS metric, '' AS dim, COUNT(DISTINCT device_id) AS value
     FROM events WHERE name='app_opened' AND ts >= ?1`,
  `SELECT 'new_users' AS metric, '' AS dim, COUNT(*) AS value
     FROM first_seen WHERE first_ts >= ?1`,
  `SELECT 'events' AS metric, '' AS dim, COUNT(*) AS value
     FROM events WHERE ts >= ?1`,
  `SELECT name AS metric, '' AS dim, COUNT(*) AS value
     FROM events WHERE name LIKE 'feature_%' AND ts >= ?1 GROUP BY name`,
  `SELECT 'err' AS metric, name AS dim, COUNT(*) AS value
     FROM events WHERE name LIKE 'err_%' AND ts >= ?1 GROUP BY name`,
  `SELECT 'version' AS metric, app_version AS dim, COUNT(DISTINCT device_id) AS value
     FROM events WHERE ts >= ?1 GROUP BY app_version`,
];

// ── 看板口令：优先 Authorization: Bearer 头，兼容 ?token= ──────
// 为什么加 header：query 参数会进 CF 访问日志、浏览器历史、Referer 头
//（从本页链到别处就会把口令带出去）。query 路径**保留**只为兼容旧书签/旧脚本，
// 但已在响应文案里标注「建议改用 header」。
// 比较走常数时间函数（timingSafeEqual），不用 !==。
function dashboardTokenFrom(req: Request, url: URL): { token: string | null; via: "header" | "query" | null } {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return { token: m[1].trim(), via: "header" };
  }
  const q = url.searchParams.get("token");
  if (q !== null) return { token: q, via: "query" };
  return { token: null, via: null };
}

async function handleDashboard(req: Request, url: URL, env: Env) {
  // fail closed：看板口令没配 → 拒绝（而不是「没配就谁都能看」或「谁都不能看但报 401」）
  if (!env.DASHBOARD_TOKEN) {
    console.error("[auth] DASHBOARD_TOKEN 未配置 → 看板拒绝访问（fail closed）");
    return json(500, {
      error: "misconfigured",
      variable: "DASHBOARD_TOKEN",
      message: "服务端未配置 DASHBOARD_TOKEN，看板拒绝访问。请执行 `wrangler secret put DASHBOARD_TOKEN`。",
    });
  }
  const { token, via } = dashboardTokenFrom(req, url);
  if (token === null || !timingSafeEqual(token, env.DASHBOARD_TOKEN)) {
    // 裸 "unauthorized" 会让人以为是服务挂了。
    // 直接说清楚：缺 token / token 不对 / 正确地址长什么样。
    const reason = token === null
      ? "缺少口令"
      : "口令不正确";
    const how =
      `正确用法（推荐 header，不会进访问日志/浏览器历史）：\n` +
      `  Authorization: Bearer <口令>\n\n` +
      `兼容用法（旧的 query 参数，会进访问日志与 Referer，建议尽快改用 header）：\n` +
      `  /dashboard?token=<口令>\n\n`;
    const body =
      `401 · 未授权（${reason}）\n\n` +
      `看板需要口令，${how}` +
      `口令由部署方通过 CF secret（DASHBOARD_TOKEN）设置，不在仓库里。\n` +
      `若你不知道口令，请向部署方索取。\n\n` +
      `${ENDPOINT_HINT}`;
    console.warn(`[auth] 看板未授权（${reason}，来源：${via ?? "无"}）→ 401`);
    return new Response(body, {
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const today = new Date().toISOString().slice(0, 10);

  // 1) 今日：实时从明细算（UTC 自然日起点）
  const dayStart = Math.floor(new Date(today + "T00:00:00Z").getTime() / 1000);
  const liveRows: Array<{ day: string; metric: string; dim: string; value: number }> = [];
  for (const sql of LIVE_SQL) {
    const r = await env.DB.prepare(sql).bind(dayStart).all<{
      metric: string; dim: string; value: number;
    }>();
    for (const row of r.results ?? []) {
      liveRows.push({ day: today, metric: row.metric, dim: row.dim, value: row.value });
    }
  }

  // 2) 历史：读 daily_rollup（排除今天，避免与实时值重复）
  const rows = await env.DB.prepare(
    `SELECT day, metric, dim, value FROM daily_rollup
      WHERE day >= date('now','-7 days') AND day < ?1
      ORDER BY day DESC, metric, dim`,
  ).bind(today).all<{ day: string; metric: string; dim: string; value: number }>();

  // 3) 闸门用量：走实时表（gate），不依赖 cron
  const live = await env.DB.prepare(
    `SELECT day, req_count, evt_count, dropped, paused FROM gate
      WHERE day >= date('now','-1 days') ORDER BY day DESC`,
  ).all<{ day: string; req_count: number; evt_count: number; dropped: number; paused: number }>();

  const gateRows: Array<{ day: string; metric: string; dim: string; value: number }> = [];
  for (const g of live.results ?? []) {
    gateRows.push(
      { day: g.day, metric: "gate_req", dim: "", value: g.req_count },
      { day: g.day, metric: "gate_evt", dim: "", value: g.evt_count },
      { day: g.day, metric: "gate_dropped", dim: "", value: g.dropped },
      { day: g.day, metric: "gate_paused", dim: "", value: g.paused },
    );
  }

  const merged = [...liveRows, ...(rows.results ?? []), ...gateRows].sort(
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
<p style="color:#666;font-size:13px">
<b>今日</b>（${escapeHtml(today)}）为实时计算，与历史日口径一致；
<b>gate_*</b> 为实时闸门计数（gate_dropped = 因闸门丢弃数，gate_paused = 存储闸门触发）。<br>
dau = 发过 app_opened 的去重设备数 · new_users = 首见设备数 · events = 去重事件总数 ·
feature_* = 各功能事件数 · err = 各错误事件数 ·
version = 各版本<b>发过任意事件</b>的去重设备数（可大于 dau：只发功能事件未发 app_opened 的设备计入 version 不计入 dau）。
</p>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// ── 真实存储大小（只读观测） ──────────────────────────────────
// 用来回答「D1 到底占了多少 MB」。优先用 SQLite 的真实页占用
// （PRAGMA page_count * page_size）；D1 对 PRAGMA 的支持有限，失败时退回
// 「按内容长度估算」，并在返回值里标明来源（page_count / estimated / unavailable），
// **不把估算值伪装成精确值**。
async function readStoreSize(env: Env): Promise<{ mb: number | null; source: string }> {
  try {
    const pages = await env.DB.prepare("PRAGMA page_count").first<{ page_count: number }>();
    const size = await env.DB.prepare("PRAGMA page_size").first<{ page_size: number }>();
    const bytes = Number(pages?.page_count) * Number(size?.page_size);
    if (Number.isFinite(bytes) && bytes > 0) {
      return { mb: Math.round((bytes / 1048576) * 100) / 100, source: "page_count" };
    }
  } catch (err) {
    console.warn("[store] PRAGMA page_count 不可用，退回估算：", err instanceof Error ? err.message : err);
  }
  try {
    const r = await env.DB.prepare(
      `SELECT (SELECT COALESCE(SUM(LENGTH(event_id)+LENGTH(device_id)+LENGTH(name)+LENGTH(tag)+LENGTH(app_version)+LENGTH(os)),0) FROM events)
            + (SELECT COALESCE(SUM(LENGTH(device_id)),0) FROM first_seen)
            + (SELECT COALESCE(SUM(LENGTH(day)+LENGTH(metric)+LENGTH(dim)),0) FROM daily_rollup) AS bytes`,
    ).first<{ bytes: number }>();
    const bytes = Number(r?.bytes);
    if (Number.isFinite(bytes)) {
      return { mb: Math.round((bytes / 1048576) * 100) / 100, source: "estimated" };
    }
  } catch (err) {
    console.error("[store] 存储大小估算失败：", err instanceof Error ? err.message : err);
  }
  return { mb: null, source: "unavailable" };
}

// ── 健康检查：给监控看闸门用量 ────────────────────────────────
async function handleHealth(env: Env) {
  const day = new Date().toISOString().slice(0, 10);
  const g = await readGate(env, day);
  // 阈值统一走解析函数：缺失/非法 → 抛 ConfigError → 顶层 500（响亮），不再静默失效
  const reqLimit = requirePositiveInt(env, "GATE_REQ_DAY");
  const evtLimit = requirePositiveInt(env, "GATE_EVT_DAY");
  const retention = requirePositiveInt(env, "RETENTION_DAYS");
  const backlog = resolveBacklogLimit(env);
  const store = await readStoreSize(env);
  // 超期未清行数：存储闸门的真实判据（与 cron 里判定暂停用的是同一个口径）
  const overdue = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM events WHERE ts < strftime('%s','now', ?1)`,
  ).bind(`-${retention} days`).first<{ c: number }>();
  const backlogRows = Number(overdue?.c ?? 0);
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
    retention_days: retention,
    // 限流配置（注意是 per-isolate，不是全局精确）
    rate_limit_per_min: resolveRateLimit(env),
    rate_limit_scope: "per-isolate",
    // 存储闸门：真实判据是「超期未清行数」，阈值可配
    backlog_limit_rows: backlog.limit,
    backlog_limit_source: backlog.source,
    backlog_rows: backlogRows,
    // 真实存储大小（只读观测）。⚠️ 旧的 store_limit_mb 字段已移除 ——
    // 它回显的是一个从没生效过的「MB 预算」，会误导运维以为有存储预算在把关。
    store_mb: store.mb,
    store_mb_source: store.source,
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
  // 阈值统一解析：RETENTION_DAYS 缺失/非法 → 抛（顶层已改成记日志）
  const retention = requirePositiveInt(env, "RETENTION_DAYS");
  const backlog = resolveBacklogLimit(env);

  // 1) 聚合：UPSERT 覆盖写，可重跑
  for (const sql of ROLLUP_SQL) {
    await env.DB.prepare(
      `INSERT INTO daily_rollup (day, metric, dim, value) ${sql}
       ON CONFLICT(day, metric, dim) DO UPDATE SET value = excluded.value`,
    ).run();
  }

  // 2) 清理：分批删（删除也计写额度，一次删太多会撞执行时限）
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

  // 3) 存储闸门：清理后仍有超期未删的行 → 超过阈值 → 暂停上报（返 204）
  //    阈值来自 GATE_RETENTION_BACKLOG_ROWS（单位：行）——
  //    旧变量 GATE_STORE_MAX_MB（MB）从来没有真的按 MB 判过，是个死旋钮。
  const overdue = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM events WHERE ts < strftime('%s','now', ?1)`,
  ).bind(`-${retention} days`).first<{ c: number }>();
  const overdueRows = Number(overdue?.c ?? 0);
  const paused = overdueRows > backlog.limit ? 1 : 0;
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO gate (day, req_count, evt_count, dropped, paused) VALUES (?1,0,0,0,?2)
     ON CONFLICT(day) DO UPDATE SET paused = excluded.paused`,
  ).bind(day, paused).run();

  if (paused === 1) {
    console.error(
      `[gate] 存储闸门触发：清理后仍有 ${overdueRows} 行超期未清（阈值 ${backlog.limit} 行，来源 ${backlog.source}）→ 暂停上报（204）`,
    );
  } else {
    console.log(
      `[gate] 存储闸门正常：超期未清 ${overdueRows} 行 ≤ 阈值 ${backlog.limit} 行（来源 ${backlog.source}）`,
    );
  }
}
