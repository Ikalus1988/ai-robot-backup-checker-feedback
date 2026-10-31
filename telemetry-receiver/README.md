# rbc-telemetry · 遥测接收端

「机器人程序检查&转换工具」的匿名使用统计接收端。Cloudflare Worker + D1，部署在
`telemetry.misakanet.org`（misakanet.org 账号下的**独立子域 custom domain**）。

## 契约正本在哪

> **契约正本 = `docs/telemetry-launch-plan.md`，它不在本仓**，在公开仓
> [`Ikalus1988/ai-robot-backup-checker-feedback`](https://github.com/Ikalus1988/ai-robot-backup-checker-feedback)
> 的 `docs/` 目录下。
>
> - 当前版本：**v3.4**（计划书顶部速览表最后一行写的是 v3.3，正文已含 v3.4 的「超时 = 结果未知」语义）
> - 固定 commit 引用：`51ce67354f297f12fa0e5c2b1354125780c5b0d6`
>   （`docs/telemetry-launch-plan.md` 在该 commit 的内容；配套的 `docs/telemetry-handoff.md` 同 commit）
> - 取文档用 `gh api repos/Ikalus1988/ai-robot-backup-checker-feedback/contents/docs/telemetry-launch-plan.md`，
>   **不要用 `raw.githubusercontent.com`**（其 CDN 缓存不刷新，会拿到旧版）。
>
> **本仓是实现，契约正本在那个仓。** 本 README 只讲「怎么跑起来」「改了什么」「哪些还没做完」。

## ⚠️ 这个仓现在只是本地仓

- **代码不推进 `ai-robot-backup-checker-feedback`**（公开仓，其 README 明写"只放发布产物，不含源码"）。
- **代码不推进 MisakaNet 仓**（会连带 schema 应用/备份/诊断/部署新鲜度等 7 处交叉，见计划书 §5.9）。
- 内网 GitLab 到位后整体迁过去（纯 git 操作，无需改代码）。

## 文件

| 文件 | 作用 |
|---|---|
| `wrangler.toml` | 部署配置的**公开版**：`cpu_ms` 刹车、每日 cron、D1 绑定、**每日成本闸门阈值**、限流阈值。CF 账号 ID 与 D1 库 ID 是占位符，真实值不入库 |
| `wrangler.toml.example` | 部署用模板：复制成 `wrangler.local.toml` 后填真实 ID 再部署 |
| `wrangler.local.toml` | **本地私有部署配置**（不入仓，`.gitignore` 已排除）：真实 `account_id` / `database_id`。部署与本地开发都用 `--config wrangler.local.toml` |
| `schema.sql` | 4 张表：`events` / `first_seen` / `daily_rollup` / `gate` |
| `src/index.ts` | 唯一入口：3 个端点 + 1 个 cron，零依赖（无框架、无 zod） |
| `.dev.vars.example` | 本地 secrets 模板（复制成 `.dev.vars` 后填值，`.dev.vars` 不进仓库） |

## 端点

```
POST /api/send      200 收妥 | 204 闸门主动丢弃 | 400 毒报文 | 401 鉴权失败
                    | 413 报文过大 | 429 限流 | 500 服务端配置错误 | 503 服务端故障
GET  /dashboard     看板（Authorization: Bearer <口令>，兼容 ?token=）
GET  /healthz       存活 + 今日闸门用量 + 限流/存储配置
```

**`POST /api/send` 必须带 `X-Ingest-Key` 头**（值由部署方通过 CF secret `INGEST_KEY` 下发）。
不带或带错 → **401**；服务端没配 `INGEST_KEY` → **500**（fail closed，绝不放行）。

**401 / 404 都带提示文案**（不是裸字符串）：会直接说明「正确地址是什么」、
「是缺 token 还是 token 不对」，省掉一轮排查。

### 响应语义（客户端重试逻辑依赖，不可改）

| 状态码 | 含义 | 客户端行为 |
|---|---|---|
| 2xx（含 204） | 已收妥（204 = 服务端主动丢弃） | 移除队列，不重试 |
| 4xx | 报文非法 | 丢弃且不重试 |
| 5xx | 服务端故障 | 重试并入离线队列（靠 `event_id` 幂等兜底） |

**本仓新增的例外（契约正本尚未覆盖，实施方 B 必须配合）**：

| 状态码 | 含义 | 客户端行为 | 备注 |
|---|---|---|---|
| **401** | 上报端鉴权失败（缺/错 `X-Ingest-Key`） | **丢弃且不重试**，并报警 | 落在 4xx 语义里：key 配错时若返 5xx，客户端会无限重试变成风暴 |
| **413** | 报文超过 4096 字节 | **丢弃且不重试** | 落在 4xx 语义里（早先是 `400 too_large`，行为一致，只是状态码更准） |
| **429** | 报文**合法**，但超出单 isolate 速率 | **读 `Retry-After` 头，退避后重试** | ⚠️ **这是「4xx = 丢弃不重试」的唯一例外**，不要按普通 4xx 丢弃 |

超时 / 连接错误 / 空响应 = **结果未知**，按 5xx 处理（计划书 v3.4 §2.1）。

### 限流（429）

- **每 isolate 的令牌桶**：容量 = `RATE_LIMIT_PER_MIN`（默认 120），每分钟补满同样的量。
- ⚠️ **per-isolate，不是全局精确限流**：CF 会把请求分散到大量 isolate，每个 isolate 各有一只桶。
  所以它挡不住「多 isolate 并行」的突发；**全局成本控制仍然只靠每日闸门**（那个才是跨 isolate 精确的）。
  它解决的是「单个 isolate 被瞬间打爆」——最容易造成跑飞账单的那种情况。
- 超限返回 **429 + `Retry-After`（秒）** + `{"error":"rate_limited","retry_after":N,"scope":"per-isolate"}`。
- 阈值走 `wrangler.toml` 的 `[vars] RATE_LIMIT_PER_MIN`，当前配置 **120/分钟/isolate**，在 `/healthz` 里可见。

### 鉴权（`X-Ingest-Key`）

- 为什么必须有：`WEBSITE_ID = "robot-checker"` 是 `wrangler.toml` 里的**公开常量**，校验它等于没校验 ——
  任何人都能伪造事件；每条被接受的请求要写 3–4 行 D1，伪造流量烧写额度，
  还会触发存储闸门把 `paused` 置 1，**之后所有真实遥测被静默 204 丢弃**。
- **fail closed**：`INGEST_KEY` 没配 → 返 `500 {"error":"misconfigured"}` + `console.error`，
  绝不退化成「没配就放行」。
- 比对用**常数时间**函数（同步实现，不引 `crypto.subtle` 的 await）。
- **与看板口令分开**：`INGEST_KEY` 只管上报，`DASHBOARD_TOKEN` 只管看板，两个 secret 不复用。

## ⚠️ 部署后客户端必须改（否则全部 401）

部署新版本后，**任何不带 `X-Ingest-Key` 头的客户端请求会全部得到 401**。
这是预期的安全行为（原来是零鉴权），但客户端必须同步改：

1. **请求头名字**：`X-Ingest-Key`（大小写不敏感）。
2. **值从哪来**：由部署方通过 CF secret `INGEST_KEY` 下发（`wrangler secret put INGEST_KEY`），
   客户端从自己的配置/常量里读。**不要**把它写进客户端日志、不要放在 URL query 里。
3. **怎么带**：每次 `POST /api/send` 都带，例如
   ```python
   headers = {"Content-Type": "application/json", "X-Ingest-Key": INGEST_KEY}
   ```
4. **401 的处理**：按 4xx 语义「丢弃且不重试」——客户端会**静默停止上报**。
   所以客户端应该把 401 当成**配置错误**单独告警（否则表现为「遥测突然一条都没有」）。
5. **上线顺序**：**先**给客户端发新版本（带 header），**再**部署本 Worker 的新版本；
   反过来会让旧客户端立刻全部 401。

## `/healthz` 字段

| 字段 | 含义 |
|---|---|
| `req_count` / `evt_count` | 今日已受理的请求数 / 事件数（**D1 全局精确**，跨 isolate 一致） |
| `dropped` | 今日因闸门丢弃数（已落库部分；未落库的见 `pending_dropped`） |
| `paused` | 存储闸门：清理跟不上写入时置 1 |
| `over_budget` | 今日是否已触顶（`true` 时后续请求一律 204） |
| `pending_dropped` | 本 isolate 尚未落库的丢弃数（节流窗口内） |
| `req_limit` / `evt_limit` | 每日闸门阈值（配置缺失/非法 → 该端点直接 500，见下） |
| `retention_days` | 明细保留天数 |
| `rate_limit_per_min` / `rate_limit_scope` | 限流阈值与作用域（`per-isolate`） |
| `backlog_limit_rows` / `backlog_limit_source` | 存储闸门阈值（行数）及其来源（`config`/`legacy`/`default`） |
| `backlog_rows` | 当前**超期未清**的行数（存储闸门的真实判据） |
| `store_mb` / `store_mb_source` | 库占用（MB）与来源（`page_count`/`estimated`/`unavailable`） |

⚠️ **`store_limit_mb` 字段已移除** —— 它回显的是一个**从来没生效过**的「MB 预算」
（旧的 `GATE_STORE_MAX_MB` 从未被代码用来判过），留着只会让运维以为有存储预算在把关。
现在真实库大小改由 `store_mb` 只读暴露；`store_mb_source` 说明它是精确值还是估算值。

⚠️ **D1 不允许 `PRAGMA page_count`**（实测报 `D1_ERROR: not authorized: SQLITE_AUTH`），
所以线上 `store_mb` 通常是 `estimated`（按内容长度估算，不含索引开销，偏低）。

### 存储闸门（`GATE_RETENTION_BACKLOG_ROWS`）

- 判据：**cron 清理完之后仍超期未清的行数 > 阈值** → `gate.paused = 1` → 后续上报一律 204。
- 旧变量 `GATE_STORE_MAX_MB`（单位 MB）已废弃 —— 它从来没有真正按 MB 判过，是个死旋钮。
  代码仍**容忍**它存在（当作行数阈值的兼容别名，日志里会提示废弃），但新配置请用
  `GATE_RETENTION_BACKLOG_ROWS`（当前 1000 行）。
- 变量缺失时代码用保守默认值 1000 行并 `console.error` 提示要显式配置 —— **不会因为没配就让闸门失效**。

### 配置错误一律响亮失败

`GATE_REQ_DAY` / `GATE_EVT_DAY` / `RETENTION_DAYS` / `RATE_LIMIT_PER_MIN` /
`GATE_RETENTION_BACKLOG_ROWS` 缺失或非法（`NaN`、≤0、非数字）时：

- `/api/send` 与 `/healthz` 返回 **500 + `{"error":"misconfigured","variable":"..."}`**；
- `console.error` 打出**是哪个变量**（不回显任何密钥）；
- 不再出现「`Number(undefined)` = NaN → 比较恒为 false → **整个成本刹车无声消失**」。

## 看板指标的**去重口径各不相同**（别当成互相矛盾）

| 指标 | 去重口径 | 说明 |
|---|---|---|
| `dau` | `COUNT(DISTINCT device_id) WHERE name='app_opened'` | **只**统计发过 `app_opened` 的设备 |
| `new_users` | `COUNT(*) FROM first_seen` | 只由 `app_installed` 建立，一条设备一行 |
| `events` | `COUNT(*)` 去重事件数 | 按 `event_id` 去重（幂等键） |
| `version` 维度 | `COUNT(DISTINCT device_id)` **所有事件** | 发过**任意**事件的设备数 |

> ⚠️ **`version` 的值可以大于 `dau`** —— 一台设备发了 `feature_batch` 但没发 `app_opened`
> → 计入 `version`、不计入 `dau`。这不是矛盾，是两个指标定义不同。
> （实测同一批数据：version 157 / dau 136。）

> ⚠️ 派生幂等键 = `id + name + **tag** + ts`（客户端自带 `event_id` 时以客户端的为准）。
> 加上 tag 是因为客户端时间戳只到**秒**：同一秒内发 `perf_batch` 的 `sec` 与 `min`
> 会撞同一个键 → `INSERT OR IGNORE` 静默丢掉第二条 → 性能分布系统性少算。

## 部署步骤

```bash
# 0) 授权（二选一）
wrangler login                          # 交互式，需在浏览器确认
# 或 export CLOUDFLARE_API_TOKEN=...     # 需含 Account Workers Scripts Edit + D1 Edit

# 1) 建 D1，并把真实标识写进**本地配置**（⚠️ 不是 wrangler.toml）
wrangler d1 create telemetry-db
cp wrangler.toml.example wrangler.local.toml
#    → 在 wrangler.local.toml 里填 account_id 与 database_id
#    ⚠️ wrangler.local.toml 不入仓（见 .gitignore）；仓库里的 wrangler.toml 是
#       **公开版**，account_id / database_id 一律是占位符，真实值永远不进版本库。

# 2) 建表（⚠️ 认准 local/remote 后缀，别建错库）
npm run db:init:remote                 # 打到生产 D1（等价 wrangler d1 execute ... --remote --file schema.sql）
npm run db:init:local                  # 只建到本地 miniflare 库（开发用）

# 3) 设置两个 secret（都不进 vars、不进仓库）
wrangler secret put DASHBOARD_TOKEN    # 看板口令
wrangler secret put INGEST_KEY         # 上报端共享密钥 → 客户端要用它

# 4) 部署（用本地配置，仓库里的 wrangler.toml 是脱敏公开版）
npx wrangler deploy --config wrangler.local.toml

# 5) 挂自定义域（Dashboard → rbc-telemetry → Settings → Domains & Routes
#    → Add Custom Domain → telemetry.misakanet.org）
#    或：POST /accounts/{acct}/workers/domains

# 6) 回填软件端常量
#    TELEMETRY_DEFAULT_ENDPOINT = "https://telemetry.misakanet.org/api/send"
#    TELEMETRY_INGEST_KEY       = "<部署方下发的 INGEST_KEY>"
```

**部署后必做**（不做不算部署完成，见计划书 §5.6）：

1. `curl /api/send` 合法报文 **带 `X-Ingest-Key`** → 200；不带 → 401；非法报文 → 400。
2. **用真实客户端 UA 打一次**：`User-Agent: robot-backup-checker-telemetry` → 必须 **200，不能 403/503**
   （zone 级 Bot Fight Mode / WAF 会连坐子域，被拦即静默丢数据）。
3. 闸门演练：把当日 `gate.req_count` 打满 → 再发 → 期望 **204**。
4. `curl /healthz` → 能看到 req/evt/dropped/paused，且 `req_count` **与实际受理请求数一致**
   （计数没落库 = 看板与告警线全部失灵，是最容易漏掉的静默故障）。
5. 登记进 MisakaNet 的 worker 清单与 `test_worker_compat_dates.py`（compat_date 需 < 1 年）。

## 本地开发

```bash
npm install                 # 装依赖（含 wrangler，见下）
cp .dev.vars.example .dev.vars   # 填 INGEST_KEY / DASHBOARD_TOKEN
cp wrangler.toml.example wrangler.local.toml  # 填 account_id / database_id（本地 D1 绑定要靠它）
npm run db:init:local       # 建本地库
npm run dev                 # 起本地 Worker
npm run db:query:local -- "SELECT COUNT(*) FROM events"
```

⚠️ **本地开发要用 `--config wrangler.local.toml`**：
仓库里的 `wrangler.toml` 是**脱敏公开版**，`database_id` 是占位符，D1 绑定解析不了。
本地跑请显式指定本地配置：

```bash
npx wrangler dev --local --port 8788 --compatibility-date 2026-07-21 --config wrangler.local.toml
```

（`wrangler.local.toml` 不入仓；它只在本机存在，真实 CF 标识永远不进版本库。）

⚠️ **本机 `wrangler dev` 需要显式降 compatibility_date**：
当前 wrangler 4.112.0 自带的 workerd 最高只支持 `2026-07-21`，而 `wrangler.toml` 里是
`2026-10-01`，直接 `npm run dev` 会报
`This Worker requires compatibility date "2026-10-01", but the newest date supported by this server binary is "2026-07-21"`。
本地跑请用：

```bash
npx wrangler dev --local --port 8788 --compatibility-date 2026-07-21 --config wrangler.local.toml
```

（只影响本地开发会话，不改 `wrangler.toml`、不影响线上。workerd 追上兼容日期后可去掉该参数。）

### 依赖与 lockfile

- `wrangler` 已进 `devDependencies`（锁 `4.112.0`，与本机全局版一致），不再依赖全局安装。
- `package-lock.json` 已用 `https://registry.npmjs.org/` 重新生成（不再指向 `registry.npmmirror.com`）。
- 本机 GitHub 直连超时、npm 走代理；安装需要代理时：
  ```bash
  npm_config_proxy=http://127.0.0.1:7890 npm_config_https_proxy=http://127.0.0.1:7890 npm install
  ```
- ⚠️ 本机 `NODE_ENV=production` 会让 npm 跳过 devDependencies（装出来是空的）→ 安装时加 `--include=dev`。
- ⚠️ `wrangler@4.112.0` 的 `peerOptional` 要求 `@cloudflare/workers-types@^5.x`，而本项目按
  compatibility_date 锁 `4.20260702.1` → 需要 `--legacy-peer-deps` 安装（peer 是可选的，不影响运行）。

## 还没做完的

- [ ] `/api/export` CSV（第二阶段）
- [ ] 看板卡片细分（当前是通用表格，可按 metric/dim 渲染成卡片）
- [ ] 单测（当前靠 curl 验收；计划书 §9 的 15 条判据）
- [ ] zone 级 Bot/WAF 例外配置（若「部署后必做」第 2 条检测到 403）
- [ ] 内网 GitLab 仓库 + 独立 CI/Environment
- [ ] 把「契约正本新增的 401/413/429 语义 + X-Ingest-Key」回写进
      `ai-robot-backup-checker-feedback` 的计划书（当前正本里还没有这些内容）

## 六个容易踩的点

1. **闸门计数必须每请求落库**：曾用「isolate 内攒够 100 条再落库」省写行，实测请求分散在多个
   isolate，谁都攒不到 100 条 → D1 计数永远为空 → 看板与告警线读到的永远是 0。
   现在计数与事件写入放进**同一个 batch**：不增加往返次数，只多 1 行写，换来全局精确。
2. **`INSERT OR IGNORE` + 唯一索引 = 幂等**：补发风暴重放不重复计数、不重复计费。
   派生键必须含 **tag**（见上）。
3. **删除也计写额度**：稳态下每日删除量 ≈ 每日插入量，写成本约为"事件数 × 4 行"。
4. **丢弃路径不能每条都写 D1**：洪峰期那会让账单暴涨（违背判据 8「账单不增长」）。
   计数在内存累加、按 2s 窗口批量落库；且写失败**必须吞掉**——抛错会变成 503，
   客户端就会重试入队，正好和降级目的相反。（但失败要 `console.error` 留痕，不能静默。）
5. **CF 的 Bot 规则会连坐子域**（2026-10-28 实测）：`User-Agent: Python-urllib/3.12` 被
   Browser Integrity Check 拦成 **403 / 错误码 1010**；真实客户端 UA、curl、浏览器 UA、
   python-requests、Wget、Java、无 UA 均 200。**1010 说明请求根本没到 Worker**，
   不是 Worker 的问题。运维脚本用 urllib 时要显式带 UA。
6. **配置错了要响亮，不能静默**：本 Worker 存在的意义就是「一个刹车」。
   `Number(undefined)` = `NaN` → 所有比较恒为 false → 刹车无声消失，运营看到「一切正常」，
   账单在涨。所以配置非法一律 500 + `console.error` 打出变量名。
