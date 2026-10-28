# 新用户使用率统计 · 上线计划书（C 方案：Cloudflare Workers · 挂靠 misakanet.org）

> **v2 · 2026-10-28**（v1 同日定稿）
> 决策：用户范围**全球** → 接收端必须公网可达 → **C 方案（Cloudflare Workers 自建接收器）**
> **v2 新增决策（2026-10-28）：接收端挂靠 misakanet.org**，形态 = **同账号 + 独立子域 `telemetry.misakanet.org`（custom domain）+ 独立 Worker + 独立 D1 库 + 自限流降级**。
> 实施由**另一台电脑的 agent** 按 `docs/telemetry-handoff.md` 完成。
> 配套调研《2026-10-28-misakanet挂靠可行性与风险.md》**仅本地留存、未入本仓**；本计划书已内联其全部结论与数字，无需另找。
>
> **v2 相对 v1 的实质改动（评审必读）**：
> 1. **§5 整章重写**：v1 的容量估算基于"10 万请求/天是遥测的"，但 CF 免费配额是**账号级**的，而 misakanet.org 账号**已实测撞穿 D1 读配额**。新增账号现状表、配额重算、预算切片、自限流与 204 降级语义。
> 2. **§4 契约补 3 项**：客户端时间戳（否则离线补发会污染日粒度指标）、幂等键 `event_id`（否则补发风暴会重复计数）、**204 = 服务端主动丢弃**（否则配额打满时会出现"静默丢数据"与"补发风暴"二选一）。
> 3. **§3 口径补齐**：`first_seen` 建立规则、时区口径、留存率算法。
> 4. **§6 软件侧补 2 项**：配置文件新增 `device_id` 字段（否则每次启动重生成 → 新用户数虚高）、opt-out 开关字段定案。
> 5. **§7 隐私补挂靠专项**：同域挂靠带来的披露义务与"数据不关联"红线。

---

## 0. 决策摘要

| 项 | 决策 | 理由 |
|---|---|---|
| 接收端形态 | CF Worker + D1 | 零成本、免运维、全球边缘可达 |
| 挂靠位置 | **misakanet.org 账号，子域 `telemetry.misakanet.org`** | 不新增账号/域名管理成本；同账号已具备运维流水线与监控习惯 |
| 挂靠形态 | **custom domain（子域）**，非 `misakanet.org/telemetry/*` 路径 route | 路由语义与主站解耦；该 zone 历史上因 zone route 指向错 worker 出过 404 事故 |
| Worker 边界 | **独立 Worker + 独立 D1 库**，绝不并入 `misakanet-register-proxy` | 遥测的写风暴/死循环不得波及 MCP 主服务 |
| 配额策略 | **主动放弃大部分免费额度**：遥测只吃账号级配额的 ≤10%（请求）/≤15%（写） | 账号的 D1 读配额已被主服务用爆过一次，遥测不得成为压垮主服务的变量 |
| 超额行为 | **返回 204**（2xx）而非 4xx/5xx → 客户端直接丢弃、不入队、不重试 | 把"配额用完"从"静默丢数据 / 补发风暴"变成"可观测的优雅降级" |
| 看板实现 | **只读预聚合表 `daily_rollup`**，禁止直扫明细 | 看板读放大正是 2026-10-19 事故的成因 |
| 保留期 | **明细 30 天 + 聚合长期**（放弃 180 天明细） | 免费版单库 500MB，180 天明细塞不下 |
| 默认开关 | **默认开 + 界面可关 + 明示**（勿改） | 已拍板 2026-10-28 |

---

## 1. 背景与目标

**现状**：软件端统计能力已全部内建（v6.22.x 就在）——
- 匿名 `device_id`（UUID v4，本机生成，不含任何身份信息）
- 生命周期事件：`app_installed`（首启）/ `app_opened`（每日首开）
- 使用事件 **12 项白名单**（白名单外事件名一律拒收）
- 离线补发队列（断网/宕机不丢数据，4xx 毒化丢弃、5xx/网络错误重试）
- opt-out（不配置 / `enabled:false` = 零采集零足迹）

**缺口**：接收端（统计服务器）未部署、配置未投放 → **一个数据点都没收到**。

**目标**：全球新用户的装机量、新增、日活/留存、功能使用率可统计、可看板、可导出；
数据可控（自己的库）、成本≈0、免专人运维，且**不得对 MisakaNet 主服务造成任何可用性或配额影响**。

---

## 2. 总体架构

```
全球用户电脑（Windows 桌面版）
   │  HTTPS POST /api/send（Umami 兼容 JSON，<1KB/次）
   ▼
telemetry.misakanet.org  ── CF 边缘（独立 custom domain，独立 Worker：rbc-telemetry）
   │  校验：website_id / 事件名白名单 / tag 字符集+值域 / device_id UUID 格式
   │  自限流：账号级每日预算（请求/写/读三条独立预算）
   ▼
D1 库：telemetry-db（独立库，账号内第 3 个）
   ├── events        明细，保留 30 天，Cron 清理
   ├── first_seen    设备首现（新用户口径依据）
   └── daily_rollup  日粒度聚合（看板唯一读源）
   │
   ├── GET /dashboard   → 读 daily_rollup（读放大 ≈ 0）
   └── GET /api/export  → 导出明细（受 token 保护）

【同账号但不共享】misakanet.org 主站 / misakanet-register-proxy / MISAKANET_D1
   —— 共享的只有账号级配额与域名，故遥测必须自限流（§5.3）
```

要点：
- **公网可达**：CF 边缘全球节点，任何地区用户直连，无需域名备案/端口转发；
- **协议零改动**：应用端已按 Umami `/api/send` 协议发包，Worker 只需兼容该格式（§4）；
- **数据主权**：D1 存在自己的 CF 账号下，可随时导出/删除；
- **隔离优先于便利**：能并进主 Worker 的，本方案也并——但遥测**不并**（爆炸半径不对等）。

---

## 3. 指标口径（「新用户使用率」怎么算）

| 指标 | 口径 | 数据来源 |
|---|---|---|
| **新用户数**（按日/周） | `device_id` **首次出现**当天计 1 | `first_seen`（见下方规则） |
| **日活 DAU** | 当日去重 `device_id` | `app_opened` |
| **留存率** | 第 N 天仍出现 `app_opened` 的新用户占比（cohort 按 `first_seen.first_ts` 所在自然日分组） | `first_seen` + `app_opened` |
| **总装机量** | 累计去重 `device_id` | `first_seen` |
| **功能使用率** | 各功能事件计数 / 活跃用户数 | 12 项白名单 |
| **升级率** | `update_result` 的 downloaded/installed 计数 | 同上 |

**三条必须写死的口径规则**（v2 新增，v1 缺失会导致两台机器算出不同数）：

1. **`first_seen` 建立规则**：**只由 `app_installed` 建立**（`INSERT OR IGNORE`）。
   不得由任意事件建立——否则 `app_installed` 丢失（4xx 毒化 / 端点切换期）的设备会按"第一次成功上报功能事件那天"计首启，新用户数失真。
   （若客户端实际上保证 `app_installed` 必达，也可放宽为任意事件，但**必须二选一并写进交接书**。）
2. **时区口径**：全部指标按 **UTC 自然日** 切分（与 SQL `strftime('%s','now','start of day')` 一致），看板上标注 "UTC"。
   禁止用本地时区——全球用户场景下无法统一，而混用会让"手查 SQL 对不上看板"。
3. **留存算法**：`cohort_day = date(first_seen.first_ts)`；留存 N 天 = 该 cohort 中在 `cohort_day + N` 当天有 `app_opened` 的设备数 / 该 cohort 设备数。SQL 见附录 C。

**12 项事件白名单**（应用端已实现，名字以此为准；Worker 白名单用显式数组常量，不要靠前缀匹配）：

| 事件名 | 含义 | tag 取值域 |
|---|---|---|
| `feature_single` / `feature_batch` / `feature_tp2ls` / `feature_compare` | 四大功能入口 | — |
| `feature_feedback` | 提交反馈 | — |
| `check_hit` | 检查项命中 | 检查项 ID 集合（**需从源码导出核对**是否全匹配 `[A-Za-z0-9_-]{1,32}`，含点号/中文会被 400 静默丢弃） |
| `err_network` / `err_auth` / `err_validation` / `err_server` | 错误码计数 | — |
| `perf_batch` | 批量性能档位 | **枚举**：`sec` / `min` / `tenmin` |
| `update_result` | 自动更新结果 | **枚举**：`downloaded` / `installed` |

---

## 4. 协议契约（Worker 必须兼容的现有报文）

应用端发送（`POST {endpoint}`，`Content-Type: application/json`，UA `robot-backup-checker-telemetry`）：

```json
{
  "type": "event",
  "payload": {
    "website": "<telemetry.json 的 website_id>",
    "hostname": "app",
    "language": "zh-CN",
    "screen": "",
    "title": "机器人程序检查&转换工具",
    "url": "app://telemetry",
    "name": "app_installed | app_opened | <12 项白名单之一>",
    "id": "<device_id，匿名 UUID v4>",
    "timestamp": "<客户端 Unix 秒，v2 新增>",
    "event_id": "<幂等键，v2 新增>",
    "data": {
      "version": "<应用版本，如 6.23.0>",
      "os": "windows",
      "tag": "<聚合键，字母数字-_，≤32 字符>"
    }
  }
}
```

**响应语义**（应用端重试逻辑依赖，必须遵守）：

| 状态码 | 含义 | 应用端行为 |
|---|---|---|
| **2xx**（含 **204**） | 已收妥 | 从队列移除，不重试 |
| **4xx** | 报文非法（毒报文） | **丢弃且不重试**——校验不过就返 400 |
| **5xx** | 服务端故障 | **重试并入离线队列**（上限后丢最旧） |

> **204 的语义（v2 新增，务必写进客户端）**：当 Worker 因**自身配额预算耗尽**而主动放弃记录时，返回 **204**。
> 因为 2xx = 已收妥，客户端会直接丢弃该条、**不入队、不重试** → 配额打满时既不会静默丢数据（服务端有 dropped 计数、看板可见），也不会产生补发风暴。
> 若改成 400 → 数据被当毒报文丢弃且不可观测；改成 503 → 队列膨胀 + 恢复时风暴。

**v2 新增的两个字段（客户端需配合，见 §6 工作项 B-1/B-5）**：

1. **`timestamp`（客户端 Unix 秒）** —— **不是可选项**。
   若只有服务端打点：断网 3 天的设备恢复后补发 `app_installed`，会被记成"今天"→ **新用户数、DAU、留存三项核心指标同时失真**。
   服务端取值优先级：`payload.timestamp`（合法区间校验：|now − ts| ≤ 30 天）→ 否则用服务端时间，并标记为"接收口径"计数。
2. **`event_id`（幂等键）** —— 建议客户端生成 UUID v4，或服务端按 `id + name + timestamp` 派生。
   服务端 `INSERT OR IGNORE` 去重 → 补发风暴不会重复计数 → 这是"允许 5xx 重试"的必要配套。

隐私红线（应用端已保证，Worker 侧也应照此不收集额外信息）：
- `hostname` 恒为 `"app"`（真实主机名绝不进报文）——**Worker 侧要校验而非信任**：若收到非 `"app"` 直接 400。
- `id` 仅为随机 UUID；不收 IP 入库（CF 日志层面有 IP，见 §7 保留期）
- `tag` 已在应用端收敛为 `[A-Za-z0-9_-]{≤32}`；**Worker 侧在字符集之外，再对有固定取值域的 tag 做枚举校验**（越界 400）

---

## 5. Cloudflare 侧设计（v2 整章重写）

### 5.1 挂靠账号现状（2026-10-28 实读，非推测）

挂靠到 misakanet.org = 挂到**同一个 CF 账号**，因此**所有配额都是账号级共享**。

| 资源 | 账号现状 | 免费版上限 | 遥测占用后 |
|---|---|---|---|
| Workers | `misakanet-web`、`misakanet-register-proxy`、`email-register`（3 个） | 100 个 | 4 个 ✅ |
| **Cron Triggers** | register-proxy 已用 **2**（`*/15 * * * *`、`17 3 * * *`） | **5 个** | 3 个（余 2）✅ |
| **D1 数据库** | 已用 **2**（`MISAKANET_D1`、`MISAKANET_OPS_D1`） | 10 个 | 3 个 ✅ |
| Workers 请求 | register-proxy 实测 **≈14,000/天**；静态站另有流量（口径需在 Dashboard 核实是否计入 Worker 请求配额） | **100,000/天（账号级）** | 遥测切片 ≤10,000/天 |
| **D1 读行** | **2026-10-19 实测 6,240,000 行/天，已超免费版 5,000,000** | **5,000,000/天（账号级）** | 遥测切片 ≤5,000/天 |
| **D1 写行** | 主服务语料同步 + counters + 缓存写入 | **100,000/天（账号级）** | 遥测切片 ≤15,000/天 |
| D1 存储 | 与语料库共享 | 5 GB（账号合计）/ 单库 500 MB | 遥测 ≤300 MB |
| Workers Logs | 已开（register-proxy） | 200,000 events/天 | 遥测仅异常日志 |

> ⚠️ **v1 的估算错在哪**：v1 §5.1 写"Workers ≈10 万请求/天，按 2 请求/天·台 ≈ 数万用户冗余"——把**账号级**配额当成了遥测独占额度。实际可用额度 = 10 万 − 主服务占用，且 D1 侧**读配额已经被主服务用爆过一次**（当时的现象是"每个页面加载仍然发 35 次 counters 查询打向一个拒绝服务的库"，无熔断 → 整站受影响）。

### 5.2 方案对比与选定

| 方案 | 隔离度 | 风险 | 结论 |
|---|---|---|---|
| **A. 同账号 + 子域 custom domain `telemetry.misakanet.org`** | 代码/部署/回滚/路由/数据全隔离；仅配额与域名信誉共享 | 低 | ✅ **选定** |
| B. 同账号 + 路径 route `misakanet.org/telemetry/*` | 路由与主站 catch-all 耦合 | 中 | 备选。该 zone 历史上因 route 指向错 worker 造成 `/mcp` 404 事故；且改 route 必须 `PUT`（`PATCH` → 10405 Method not allowed） |
| C. 并进 `misakanet-register-proxy` | 无隔离 | 高 | ❌ 遥测的写风暴/死循环会拖垮 MCP 主服务，并污染其部署新鲜度门禁 |
| D. 独立 CF 账号 | 完全隔离 | 低但**用不了 misakanet.org 域名** | 🔵 保留为迁移路径（附录 D） |

**选 A 的理由**：同账号下 A 与 B 的隔离差异不在配额（都共享），而在**路由语义解耦**——主站是"catch-all 静态站 + 若干精确 route"，遥测是"另一个域名的独立 worker"，两者不共享路径匹配规则，不会出现"A 改 route 踩到 B 的路径"。

### 5.3 账号级配额重算与预算切片（本方案的硬约束）

**遥测能吃多少（按 2.5 事件/台/天，含心跳 + 少量功能事件）**：

| 资源 | 账号上限 | 主服务占用 | **遥测切片** | 遥测换算上限 |
|---|---|---|---|---|
| Workers 请求 | 100,000/天 | ≈14,000+ | **≤10,000/天** | **≈4,000 台设备/天活跃** |
| D1 写行 | 100,000/天 | 语料同步+counters+缓存 | **≤15,000/天** | 索引减法后 2 行/事件 → **≈7,500 事件/天** → **≈3,000 台设备/天** |
| D1 读行 | 5,000,000/天 | **已超限过一次** | **≤5,000/天** | 看板只读 rollup（≈几十行/次）✅ |
| D1 存储 | 5 GB 账号 / 500 MB 单库 | 语料库 | **≤300 MB** | 30 天明细（≈100 万事件上限，实际远小于） |
| Cron | 5 个 | 2 个 | 1 个（清理+聚合合并） | — |

**结论**：**真正的天花板是 D1 写额度，不是请求额度。** 按上表切片，遥测在免费版下的稳定容量约 **3,000–5,000 台日活设备**；超出后按 §5.7 优雅降级（不报错、不风暴），而不是硬扛。

**索引成本（v1 漏算）**：CF 计价规则明写「索引会让写入多算一行」。v1 schema 的 2 个索引 → **每条事件 INSERT = 3 行写**。→ 索引做减法：只保留 `idx_events_name_ts`（看板必需），`idx_events_device` 视是否需要按设备查再定（去掉则 2 行写，**写额度直接提升 50%**）。

### 5.4 D1 表结构（新增 rollup，索引做减法）

```sql
-- 明细：保留 30 天（Cron 清理）
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL DEFAULT '',      -- 幂等键（v2 新增）
  device_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  tag         TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  os          TEXT NOT NULL DEFAULT '',
  ts          INTEGER NOT NULL,              -- 事件发生时间（优先取客户端 timestamp）
  recv_ts     INTEGER NOT NULL               -- 服务端接收时间（用于"接收口径"回退统计）
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id) WHERE event_id <> '';
CREATE INDEX IF NOT EXISTS idx_events_name_ts ON events(name, ts);
-- idx_events_device 默认不建：省一半写额度（需要按设备查时再开）

-- 新用户口径依据：只由 app_installed 建立
CREATE TABLE IF NOT EXISTS first_seen (
  device_id  TEXT PRIMARY KEY,
  first_ts   INTEGER NOT NULL
);

-- 看板唯一读源：日粒度聚合（行数极小，读放大≈0）
CREATE TABLE IF NOT EXISTS daily_rollup (
  day        TEXT NOT NULL,        -- UTC 自然日 YYYY-MM-DD
  metric     TEXT NOT NULL,        -- new_users / dau / retained / feature_* / update_*
  dim        TEXT NOT NULL DEFAULT '',
  value      INTEGER NOT NULL,
  PRIMARY KEY (day, metric, dim)
);
```

> **`daily_rollup` 是硬性要求，不是优化**：直扫 `events` 的看板（`COUNT(DISTINCT device_id) WHERE ts >= 7 天`）在 30 天明细下每次刷新扫 ~30 万行，每小时刷新一次 ≈ 720 万行/天 → **半天打穿账号全部读额度**，且与 2026-10-19 已发生的事故形态完全相同。
> ⚠️ 另注：**`wrangler d1 execute` 的验证查询同样计入读额度**（CF 官方明写）→ 验收阶段的 SQL 查询要控制频次与扫描量。

### 5.5 Worker 职责（`rbc-telemetry`）

| 端点 | 行为 | 状态码 |
|---|---|---|
| `POST /api/send` | 校验（§4）→ 幂等去重 → INSERT `events` +（`app_installed` 时）`INSERT OR IGNORE first_seen` → 200 `{ok:true}` | 200 / 204 / 400 / 429 / 503 |
| `GET /dashboard?token=` | 读 `daily_rollup`，渲染：今日新增 / 昨日新增 / 7 日 DAU / 7 日留存 / 功能 Top / 错误 Top / 版本分布 / 更新结果 / **今日因配额丢弃数** | 200 / 401 |
| `GET /api/export?from=&to=&token=` | CSV 导出明细（含 device_id → 按个人数据对待，落盘位置与保留期写进隐私声明） | 200 / 401 |
| `GET /healthz` | 存活 + 今日预算用量（请求/写/读三条）+ 最近错误计数（给监控与排障用） | 200 |
| **Cron（1 个）** | 每日：① 聚合 `daily_rollup` 刷新 ② 删除 `ts` 超 30 天的 `events` ③ 清理超期的 `first_seen` | — |

**校验清单（任一不过 → 400，客户端丢弃）**：
`type == "event"` · `payload.website == "robot-checker"` · `payload.hostname == "app"` ·
`payload.name ∈ 14 个白名单常量` · `payload.id` 匹配 UUID v4 小写带横线 ·
`payload.data.tag` 匹配 `[A-Za-z0-9_-]{1,32}` **且**（若该事件有固定取值域）tag ∈ 枚举 ·
`payload.timestamp` 若存在则 |now − ts| ≤ 30 天 · 报文体长 < 4KB。

**降级语义（核心）**：

```
请求进来
 ├── 校验不过 → 400（毒报文，客户端丢弃）
 ├── 超过单设备限流（device_id > 20 次/小时） → 429（可重试；客户端退避）
 ├── 今日预算已耗尽（请求/写/读任一） → 204（2xx：客户端视为已收妥，直接丢弃，不入队）
 │      + dropped++ 计数（看板可见"今日因配额丢弃 N 条"）✅ 可观测
 ├── D1 瞬时失败 → 503（客户端重试入队）
 └── 成功 → 200 {ok:true}
```

### 5.6 部署形态与步骤

**形态**：custom domain `telemetry.misakanet.org`（CF 自动创建该子域 DNS → 指向 Worker），**不使用 zone route**。
若最终改走路径 route：必须用 `PUT /zones/{zone_id}/workers/routes/{route_id}`（`PATCH` → 10405），改完立即 curl 验证。

```bash
# 0) 前置：CF API Token（权限：Account Workers Scripts Edit + D1 Edit + Zone Workers Routes Edit）
#    注意：本机 ~/.config/.wrangler 的 OAuth 令牌已过期，实施机必须重新登录或用 API Token
wrangler login            # 或 export CLOUDFLARE_API_TOKEN=...

# 1) 建仓（内网 GitLab，不进公开仓）
mkdir telemetry-receiver && cd telemetry-receiver
npm create cloudflare@latest -- .     # Worker + TypeScript

# 2) 建 D1 库（独立库；账号内第 3 个）
wrangler d1 create telemetry-db      # database_id 写入 wrangler.toml

# 3) 建表（schema.sql 见 §5.4）
wrangler d1 execute telemetry-db --file schema.sql

# 4) wrangler.toml 要点
#    name = "rbc-telemetry"
#    compatibility_date = "<近 90 天内>"      # zone 审计会查这个，见下
#    [triggers] crons = ["23 4 * * *"]        # 账号 Cron 共 5 个，已用 2，此处占第 3
#    [[d1_databases]] binding = "TELEMETRY_DB" / database_id = "<id>"
#    [vars] TELEMETRY_WEBSITE_ID = "robot-checker"
#    # dashboard token 走 secret，不进 vars
#    wrangler secret put DASHBOARD_TOKEN

# 5) 部署 + 挂自定义域
npx wrangler deploy
#    然后在 Dashboard: Workers & Pages → rbc-telemetry → Settings → Domains & Routes
#    → Add Custom Domain → telemetry.misakanet.org
#    （或用 API POST /accounts/{acct}/workers/domains）

# 6) 登记进主服务的 zone 审计（否则 CI 会漏检新 worker）
#    MisakaNet 仓：tests/test_worker_compat_dates.py 与 workers 清单需登记 rbc-telemetry

# 7) 回填软件端常量
#    TELEMETRY_DEFAULT_ENDPOINT = "https://telemetry.misakanet.org/api/send"
```

**部署纪律（照抄交接书 §6 的坑位逻辑）**：
- 部署后**必须 curl 验证三个地址**：`/api/send`（合法→200 / 非法→400）、`/dashboard?token=`（200）、`/healthz`（200 且预算用量可见）；
- **不验证不算部署完成**（对应坑 2「构建成功 ≠ 产物含新代码」）；
- 禁止把 Worker 代码推进 `ai-robot-backup-checker-feedback`（公开仓，其 README 明写"只放发布产物"）——见 §5.2 方案 C 的风险与交接书 P1-11。

### 5.7 防刷与自限流

| 层 | 措施 | 理由 |
|---|---|---|
| 报文 | website 常量校验 + 事件名白名单 + tag 值域枚举 + UUID 格式 | 挡住随手构造的垃圾报文 |
| 单设备 | `device_id` 限流 **≤20 次/小时** | 挡住单个客户端的重试 bug / 死循环 |
| 全局 | **每日预算**（请求 ≤10,000 / 写行 ≤15,000 / 读行 ≤5,000），超预算 → **204 降级** | **遥测永远不能把主服务的配额吃穿** |
| 异常 | 事件数/时突增检测 → 告警 | 发现刷量或客户端 bug |
| 路由 | 超限时 fail **closed**（而非 open） | fail open 会让客户端收到 404 → 按契约当毒报文丢弃 → **静默丢数据** |

> **为什么限流主键用 device_id 而不是 IP**：工业用户同一车间/同一出口 IP 下几十台设备，2 请求/天·台 × 30 人 = 60 次/天；按 IP 限流会把整家公司用户误挡在门外。IP 限流只作兜底，阈值放宽（如 120 次/分）。

### 5.8 故障模式与隔离

| 故障 | 表现 | 客户端行为 | 处置 |
|---|---|---|---|
| 账号撞 100k 请求/天 | Error 1027 | 视 fail mode | route 设 fail closed → 503 → 客户端入队 → 恢复后补发（幂等键保证不重复计数） |
| 遥测自身预算耗尽 | 204 | 视为已收妥，直接丢弃 | 看板显示丢弃数；按需扩预算或接受降级 |
| D1 写/读超限 | D1 拒绝查询 | 503 | Worker 立即 204 降级（不再打 D1） |
| 端点长时间 5xx | 客户端队列增长 | 重试入队 | 客户端指数退避 + 队列上限（上限后丢最旧）；服务端幂等 |
| 主服务流量突增挤占 | 账号级配额紧张 | — | 遥测预算切片（≤10%）保证反向不发生：主服务紧张时**遥测先让** |
| Worker 部署出错 / 崩溃 | 端点 5xx | 客户端入队 | 客户端队列兜底；服务端 `wrangler versions deploy` 回滚上一版 |

---

## 6. 软件侧改动清单（随 6.23.0 发版）

| # | 改动 | 说明 | 量 |
|---|---|---|---|
| 1 | **首启默认配置 bootstrap** | 若 `%APPDATA%/robot-backup-checker/telemetry.json` 不存在 → 写入内置默认（**含 `device_id`**，见下） | 0.5 天 |
| 2 | **界面 opt-out 开关** | 设置区「使用统计」开关 → **写 `enabled:false`（总开关 = 真零采集）**；`usage_enabled` 若保留则作为独立二级开关，有独立入口 | 含上 |
| 3 | **隐私声明** | README/发布页/GitHub Release 说明：匿名统计收集什么（14 事件 + 版本 + OS + 匿名设备 ID）、**不收集什么**、怎么关 | 文档 |
| 4 | **契约配合（v2 新增）** | 报文加 `timestamp`（客户端 Unix 秒）与 `event_id`（幂等键）；客户端把 204 视为"已收妥直接丢弃"；5xx 指数退避 | 0.5 天 |
| 5 | 发版 | 6.23.0 全链门禁 + 签名 + 发布 | 常规 |

✅ **已拍板（2026-10-28）：默认开 + 界面可关 + 明示**（备选「默认关」已否决：统计不到新用户，与目标冲突）。

**配置契约（v2 修订）**：

```json
{
  "enabled": true,
  "endpoint": "https://telemetry.misakanet.org/api/send",
  "website_id": "robot-checker",
  "usage_enabled": true,
  "device_id": "<持久化的 UUID v4，小写带横线；首启生成，之后只读不重生成>"
}
```

- `device_id` **必须持久化在配置里**（v1 模板漏了这个字段）→ 否则每次启动重生成 → 「首次启动仅一次」与「日活去重」同时失真 → **新用户数虚高**。
- bootstrap 写默认配置时：**已有文件绝不覆盖**（保护 opt-out）；文件存在但解析失败 → 重写默认 + **记日志**（不静默吞错）。
- endpoint 用**单点常量** `TELEMETRY_DEFAULT_ENDPOINT`，任何逻辑里不得硬编码域名或路径（保证附录 D 的零改动迁移能力）。

---

## 7. 隐私与合规

- **匿名**：随机 UUID，无用户名/主机名/路径/机器人名/文件名入报文（事件名与 tag 双层白名单拦截）
- **明示**：发布页与 README 声明统计项；软件内开关可见
- **可控**：一键关闭；关闭后零采集零足迹
- **最少留存**：明细 `events` **保留 30 天**（Cron 清理）；`first_seen` 按同周期清理；聚合表长期保留（行数极小）
- **传输**：全链 HTTPS（CF 自动证书）
- **不落 IP**：D1 不入库 IP（CF 边缘日志层面有 IP，见 §7 保留期）

### 7.1 挂靠 misakanet.org 的专项合规义务（v2 新增）

挂靠到一个**已有用户账号与独立隐私政策的公开服务域**下，会带来三项额外义务：

1. **披露**：misakanet.org 的隐私政策需增补"本域另提供匿名使用统计端点（`telemetry.misakanet.org`）"——
   否则一个不做遥测的 MisakaNet 用户访问 misakanet.org 时，无法区分"访问了 misaka"与"访问了机器人工具的遥测端点"。
   若不想改 misaka 的隐私政策，**替代方案是用一个独立域名**（附录 D 阶段 2）。
2. **数据不关联（红线）**：遥测的 `device_id` **不得**与 MisakaNet 的账号 / 节点 ID / 语料库产生任何关联——
   ① 遥测使用**独立 D1 库**，代码中**禁止跨库 join**；② 禁止在遥测报文里带任何 misaka 侧标识；
   ③ 数据处理者口径上两者是独立数据集。这条列为代码评审门禁。
3. **端点公开可查**：遥测端点是公开无鉴权写入端点，应**主动公开其存在与用途**（而不是藏起来），
   并提供明确的停用/举报入口——被举报的"隐蔽数据收集"是 CF 滥用审查的高发点，公开透明反而是保护。

---

## 8. 实施步骤与分工

| 阶段 | 内容 | 谁 | 前置 | 预估 |
|---|---|---|---|---|
| 0 拍板 | §0 的 8 项决策（尤其：挂靠形态、配额切片、保留期、幂等键、隐私披露） | 你 | — | — |
| 1 契约修订 | 把 §3/§4 的口径与新字段回写进交接书 v2（§6.3 的同步清单） | 本机 agent | 阶段 0 | 0.5 天 |
| 2 CF 侧 | Worker + D1 schema + rollup + 看板 + 导出 + 自限流 + 部署 + 自定义域 | 实施 agent | **CF API Token** + 阶段 0/1 | 1 天 |
| 3 软件侧 | bootstrap（含 device_id）+ opt-out 开关 + 契约配合（timestamp/event_id/204/退避）+ 隐私声明 | 实施 agent | 阶段 1 | 1 天 |
| 4 验收 | §9 判据全绿（含国内探测点） | 实施 agent | 阶段 2/3 | 0.5 天 |
| 5 发版 | 6.23.0 门禁 + 签名 + 发布（统计随包生效） | 实施 agent | 阶段 4 | 常规 |
| 6 运营 | 看板日常看；月度导出/推飞书；**配额用量周检**（请求/写/读三条预算） | 你 | — | — |

---

## 9. 验收判据（全绿才算上线）

| # | 判据 | 判定方式 | 期望 |
|---|---|---|---|
| 1 | 收数通 | `curl -X POST $EP/api/send` 合法报文 | 200 且 D1 可查 |
| 2 | 毒报文丢弃 | 错 website / 未知事件名 / 坏 UUID / 越界 tag / 坏 hostname 各一条 | 全部 400 且不入表；客户端不重试 |
| 3 | 真机首启 | 新机器首启 | `app_installed` +1，`first_seen` +1 |
| 4 | 日活 | 次日再开 | `app_opened` +1，`device_id` 去重后为 1 |
| 5 | 断网补发 | 断网操作 → 恢复 | 队列清空、事件齐全、**`ts` 取客户端时间戳**（不是恢复时刻） |
| 6 | 幂等 | 同一 `event_id` 重放 3 次 | `events` 只有 1 行 |
| 7 | opt-out | 关开关 → 观察 24h | D1 零新增（总开关语义） |
| 8 | 配额降级 | 把请求预算调成 0 后再发 | 返回 **204**、不入表、**不入客户端队列**、看板"丢弃数" +1 |
| 9 | 口径核对 | 看板数字 vs 手写 SQL（同一 UTC 口径） | 完全一致 |
| 10 | 留存可算 | rollup 里留存卡片有数 | 按 cohort 定义可复现（附录 C） |
| 11 | 全球可达 | 2–3 地探测点，**含中国大陆至少 1 个** | 均 200（workers.dev/自定义域在大陆链路不稳，需实测） |
| 12 | 主服务无影响 | 遥测满负荷跑 24h 后 | MisakaNet 主站请求成功率与 D1 读用量**无异常上升** |

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| **配额争用打穿主服务** | 自限流 + 每日预算切片（请求 ≤10%、写 ≤15%）+ 204 降级 + fail closed + 告警（§5.3/5.7） |
| **看板读放大重演 D1 读超限事故** | 看板只读 `daily_rollup`；明细仅导出；验收期控制 SQL 查询频次（§5.4） |
| **索引翻倍吃掉写额度** | 索引做减法（2 行/事件）；事件/设备日上限（§5.3） |
| **刷量污染统计** | 报文严格校验 + device_id 限流 + 全局预算 + 异常告警；IP 限流仅兜底且放宽（§5.7） |
| **滥用审查牵连 misakanet.org** | 独立子域 + 端点公开透明 + 明确 opt-out + 提供停用联系人；不混用主域路径（§7.1） |
| **隐私质疑（未披露 / 数据关联）** | 隐私政策增补 + 独立 D1 库 + 禁止跨库关联 + 采集项最小化（§7.1） |
| **CF 账号/服务不可用** | 客户端队列自动补发；接收端可整体迁移（附录 D）；遥测不可用**不影响主业务功能** |
| **route 配错 / zone 审计漏登** | 优先用 custom domain 不手改 route；若用 route 须 PUT + 立即 curl 验证；新 worker 登记进 compat-date 审计（§5.6） |
| **国内可达性** | 自定义域 + 国内探测点实测；不可达则切附录 D 阶段 2/3（仅改 endpoint） |
| **数据看不过来** | 看板只放关键数；深度分析走 CSV 导出/飞书 |

---

## 附录 A · telemetry.json 模板（内置默认值）

```json
{
  "enabled": true,
  "endpoint": "https://telemetry.misakanet.org/api/send",
  "website_id": "robot-checker",
  "usage_enabled": true,
  "device_id": "<首启生成的 UUID v4，持久化于此；之后只读不重生成>"
}
```

## 附录 B · Worker 接口骨架

```
POST /api/send                 200 {ok:true} | 204 预算耗尽主动丢弃 | 400 毒报文 | 429 限流 | 503 服务故障(重试)
GET  /dashboard?token=         指标卡：今日新增/昨日新增/7日DAU/7日留存/功能Top/错误Top/版本分布/更新结果/今日丢弃数
GET  /api/export?from=&to=&token=   CSV 下载（明细，含 device_id → 按个人数据对待）
GET  /healthz                  存活 + 今日三条预算用量 + 最近错误计数
Cron (每日)                     刷新 daily_rollup + 清理 30 天前的 events/first_seen
```

## 附录 C · 关键 SQL（口径统一为 UTC）

```sql
-- 今日新用户（first_seen 只由 app_installed 建立）
SELECT COUNT(*) FROM first_seen WHERE first_ts >= strftime('%s','now','start of day');

-- 7 日 DAU（生产环境请从 daily_rollup 读，不要直扫 events）
SELECT COUNT(DISTINCT device_id) FROM events
 WHERE name='app_opened' AND ts >= strftime('%s','now','-7 days');

-- 留存：cohort = first_seen 所在自然日，第 N 天仍活跃
SELECT f.first_day AS cohort_day,
       COUNT(DISTINCT CASE WHEN e.ts >= strftime('%s','now','-1 days') THEN e.device_id END) AS retained_1d,
       COUNT(DISTINCT f.device_id) AS cohort_size
  FROM first_seen f
  LEFT JOIN events e ON e.device_id = f.device_id AND e.name='app_opened'
 WHERE f.first_day >= strftime('%s','now','-30 days')
 GROUP BY cohort_day;

-- 看板主查询（聚合表，行数极小）
SELECT metric, dim, value FROM daily_rollup WHERE day = date('now');
```

## 附录 D · 切退成本（应用端永不锁死接收端）

```
阶段 1（本次）：同账号 + telemetry.misakanet.org 子域
        ↓ 若遥测量超出账号配额，或账号被 CF 处置
阶段 2：换独立 CF 账号 + workers.dev / 自有第二域名
        → 客户端改动 = 改 telemetry.json 的 endpoint（0 代码改动，因端点是单点常量）
        → 服务端改动 = 换 endpoint 指向 + 数据迁移
阶段 3（可选）：换 VPS + Umami（协议同为 Umami /api/send，仍 0 代码改动）
```
> 前提：**软件端必须把 endpoint 做成单点常量 `TELEMETRY_DEFAULT_ENDPOINT`**，任何逻辑不得硬编码域名/路径。

## 附录 E · 配额与预算监控项（周检 + 告警）

| 指标 | 阈值 | 动作 |
|---|---|---|
| 账号 Workers 请求用量 | >60% | 告警（查遥测还是主服务） |
| 遥测请求预算用量 | >80% | 告警 + 考虑扩切片或降采样 |
| 账号 D1 读行用量 | >60% | 告警（主服务曾超限，重点盯） |
| 遥测 D1 写行用量 | >80% | 告警 + 检查是否有客户端 bug 在高频上报 |
| 遥测存储 | >400 MB | 告警（单库 500MB 上限） |
| 今日丢弃数（204 降级） | >0 | 周报中说明原因 |
| `daily_rollup` 与明细手查一致性 | 不一致 | 立即排查聚合 Cron |

## 附录 F · 与交接书（`docs/telemetry-handoff.md`）的同步清单

计划书 v2 落地后，**交接书必须同步以下章节**，否则实施 agent 拿到的是两份互相矛盾的契约：

| 交接书章节 | 需要同步的内容 |
|---|---|
| §2.1 上报 HTTP 契约 | 报文加 `timestamp` / `event_id`；**新增 204 语义**（服务端主动丢弃）；5xx 语义不变 |
| §2.2 事件字典 | tag 值域枚举（perf_batch / update_result / check_hit）；白名单用显式常量 |
| §2.3 客户端配置契约 | **新增 `device_id` 字段**；`enabled` vs `usage_enabled` 语义定案；endpoint 默认值改为 `https://telemetry.misakanet.org/api/send` |
| §3 工作项 A | 端点主机名改子域；schema 加 `daily_rollup`/`event_id`/`recv_ts`、索引做减法；**新增 §5.3 配额切片与自限流**；新增 Cron（清理+聚合）；部署步骤含 custom domain + zone 审计登记 |
| §4 工作项 B | B-1 bootstrap 必须写 `device_id` 且不覆盖已有；B-2 开关写 `enabled`；**新增 B-5 契约配合**（timestamp/event_id/204/退避） |
| §5 发版速查 | 无需改；但发版链路须先修 `release.yml` 的 checkout ref（见复核报告 §7） |
| §6 已知坑 | **新增第 8 条：发版后必须匿名下载校验产物版本**（现有 7 条坑全在构建期，发版链路是裸奔的） |
| §7 验收判据 | 12 条（新增：幂等、配额降级 204、留存可算、主服务无影响、国内探测点） |
| §8 联系与决策口径 | 补：配额切片、保留期 30 天、幂等键进 6.23.0、隐私政策增补 |
