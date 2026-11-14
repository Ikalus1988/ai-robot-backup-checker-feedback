# 统计上线 · 实施交接书（给另一台电脑上的实施 agent）

> v1.2 · 2026-10-29 · 配套计划书：`docs/telemetry-launch-plan.md`
> **本文件自包含**：实施所需的一切接口/规格/命令/判据都在这里，不依赖任何对话背景。
> 已拍板口径：**默认开 + 界面可关 + 明示**（选项见计划书 §6）。
>
> **v1.1 变更（2026-10-28）**：**工作项 A（Worker 接收端）已完成并上线**，
> 代码在本仓 `telemetry-receiver/`，端点 `https://telemetry.misakanet.org/api/send`。
> 本文件的 §3 已标注"被实现取代"，**实施时以 `telemetry-receiver/` 实际代码为准**。
>
> **v1.11 变更（2026-11-13）**：**§7 判据 17 的归并口径已激活**（`VERSION_DIMENSION_MODE=by_device_max`，Worker `9d8a6b0b`）——
> #6 的 B 组机制结论已确认（混血构建：新 Rust + 旧前端 dist），#9 随之收口。
> `/healthz` 新增 `version_dimension_mode` 字段（运行时直接可见当前口径）。
> ⚠️ 该口径的含义是「该设备当前在用的版本」→ 设备升级会回溯改写 8 天窗口内的历史归属；
> 回滚 = 改回 `raw` + 一次 deploy。
>
> **v1.10 变更（2026-11-12）**：**修正判据 16 的语义错误** —— 服务端推断不再写进 `stale_exe`，
> 改写独立的 **`version_below_max`** 列（见判据 16 与计划书 v3.12）。
> **v1.9 变更（2026-11-11）**：新增 **§7 判据 17（版本维度归并，待激活）**：
> 服务端已实现 `VERSION_DIMENSION_MODE`（默认 `raw` = 现状口径，**未切换**）；
> `by_device_max` = 每台设备归到其最新版本。**等 #6 的 B 组结论拍板后再启用**。
>
> **v1.8 变更（2026-11-11）**：新增**服务端 stale 推断**（§7 判据 16）：
> 服务端维护 `device_version`（每设备见过的最高版本），**同设备下版本更低的事件自动标 `stale_exe=1`**
> —— 覆盖「≤6.25.1 旧副本压根没有标记逻辑」「旧副本抹掉依据」这两类客户端侧管不了的情况。
> 客户端**显式**给了 `stale_exe` 时以客户端为准。**看板口径不变**（归并等 #6 的 B 组结论）。
>
> **v1.7 变更（2026-11-09）**：新增**测试环境配置**（§2.3）：独立 endpoint（workers.dev）、
> 独立 `website_id`、独立 `INGEST_KEY`、独立 D1 库；配合**测试流量「双标记」**
> —— 测试 `device_id` 首段全零（`00000000-…`），服务端统计口径已按「非 `0000%`」**天然排除**，
> 测试流量**不吃生产预算**。完整规定见计划书 §6.1。
>
> **v1.6 变更（2026-11-05）**：服务端已支持契约 **v3.5.1** 的 `data.stale_exe`
> （新增 `events.stale_exe` 列，远端已迁移，实测 `"1"`→1 / 不带→0）。
> **服务端只存不用**（判定权在客户端）；**版本维度的聚合口径暂不改**，
> 等 #6 里「新构建报旧版本号」的样本解释清楚再动。
>
> **v1.5 变更（2026-11-02）**：新增 **单设备限流判据**（§7 判据 15）。
> 服务端已上线 `device_id` 每小时 > **60** 次 → 429 + `Retry-After` + `scope":"per-device"`
> （per-isolate 内存计数，不写 D1）。阈值由原定 20 上调到 60 —— 实测真实用户单设备
> 单小时峰值 **17**（批量功能事件成批产生），20 会误伤正常批量操作。
> 客户端侧无需改动：429 已在既有分类里（`rate_limited`），读 `Retry-After` 退避即可。
>
> **v1.4 变更（2026-11-02）**：**`website_id` 对齐真实客户端** + 记下两个待客户端修的契约缺口。
> 客户端 6.23.1 随安装器分发的 `telemetry.bootstrap.json` 里是 `website_id = "robot-backup-checker"`，
> 而本文件与已部署服务端原为 `robot-checker` → 服务端 `bad_website` → **400 → 客户端按毒报文丢弃**
> → **队列排空但一个数都没进**（静默丢数）。客户端已发布不能改 → **服务端与本文件统一改为
> `robot-backup-checker`**（已上线，等客户端侧确认）。
> 另：实测 6.23.1 真实报文**不带 `event_id` 也不带 `timestamp`** → 服务端只能按 `id:name:tag:ts`
> 派生幂等键（`ts` 每次重试都变 → **幂等失效**），且客户端事件时刻丢失（判据 5 不成立）。
> 详见计划书 §6 工作项 1c 与 issue #2。
>
> **v1.2 变更（2026-10-29）**：新增 **timeout 语义**（§2.1 专条 + §7 判据 9、10）——
> 实测发现企业网出口 → Cloudflare 存在**间歇性超时**且**请求已落地、响应丢失**，
> 客户端必然遇到「结果未知」态；契约原本只写 2xx/4xx/5px，缺 timeout 语义会致实施方误当 4xx 丢弃。
>
> **v1.3 变更（2026-10-31）**：**上报端鉴权契约回写**——
> 服务端已加共享密钥 `X-Ingest-Key`（commit `349ad55`），本文件补齐 **401 / 413 / 429** 三行响应语义
> （§2.1 专条 + §7 判据 11–13）、§2.1 报文补 `timestamp` / `event_id`、§2.3 配置补 `ingest_key`、
> §0 上线顺序写死为**先发客户端 → 再部署服务端**。客户端侧已按此实现并回执（issue #2）。

---

## 0. 交接范围

| 项 | 归属 |
|---|---|
| 计划与接口（本文件 + 计划书） | ✅ 已完成（本机 agent） |
| **A. Cloudflare Worker 接收端**（代码 + D1 + 看板 + 部署） | ✅ **加鉴权版已部署**（2026-11-02 05:39 UTC，版本 `86efafbe`，代码 `349ad55`）。`INGEST_KEY` 已置 = 客户端 6.23.0 那把（指纹 `eb055b926da7cf7d`）。远端 D1 表结构与 `schema.sql` 完全一致，无需重建。判据 16/17/18 线上实测全绿 |
| **B. 软件端小改**（默认配置 bootstrap + 界面开关 + 隐私声明） | 客户端团队（源码在内网 GitLab）——**2026-10-31 回执**：3 件遥测改动（`X-Ingest-Key` / 401 响亮报错 / 429 退避）**已落地**，随 **6.23.0** 发版（2026-11-02）。⚠️ **2026-11-02 复核：6.23.0 公开产物里既无默认端点常量也无默认 `ingest_key`** → 全新用户无 `telemetry.json` → 按 §2.3「零采集」→ **不会有真实上报**。需补 bootstrap 默认配置或配置下发通道（计划书 §6 工作项 1b） |
| C. 验收（§7 判据全绿） | 实施 agent（接收端侧已过黑盒验收，见 §3） |
| D. 发版 6.23.0（含统计生效） | 客户端团队 —— 6.23.0 已发版（2026-11-02），但**默认配置 bootstrap 未进产物**，真实流量尚未进来（见 B 行） |

**完成定义（DoD）**：A+B+C+D 全部达成，看板能数出「今日新用户/7 日 DAU」，
且 opt-out 后零上报。

---

## 1. 背景速览（30 秒版）

产品 = 机器人程序检查&转换工具（Tauri v1 + React + Rust，Windows 桌面），
面向**全球**用户公开分发（GitHub Releases 公开下载 + 自动更新）。要统计新用户
使用率。**采集端已全部内建于 v6.22.2+**（匿名 UUID、首启/日心跳、12 事件白名单、
离线补发、opt-out），唯缺接收端与默认配置投放——这就是本次要做的全部。

---

## 2. 接口契约（核心交付，逐字段）

### 2.1 上报 HTTP 契约

- **`POST {endpoint}`**（endpoint = 客户端配置里的完整 URL，约定以 `/api/send` 结尾）
- 头：`Content-Type: application/json`；`User-Agent: robot-backup-checker-telemetry`
- 报文（Umami `/api/send` 兼容格式，应用端已实现，**不可更改字段语义**）：

```json
{
  "type": "event",
  "payload": {
    "website":  "<website_id，见 §3 配置>",
    "hostname": "app",
    "language": "zh-CN",
    "screen":   "",
    "title":    "机器人程序检查&转换工具",
    "url":      "app://telemetry",
    "name":     "<事件名，见 §2.2>",
    "id":       "<device_id：匿名 UUID（v1–v8，大小写不敏感）>",
    "timestamp":"<客户端 Unix 秒，幂等/时窗校验用>",
    "event_id": "<幂等键：每次上报唯一，重发同一条用它去重>",
    "data": {
      "version": "<应用版本号，如 6.22.2>",
      "os":      "windows",
      "tag":     "<聚合键，见 §2.2 规则>",
      "stale_exe": "<v1.6 新增，可选：'1' = 该事件来自一个更旧的 exe 副本>"
    }
  }
}
```

- **响应语义（应用端重试逻辑依赖，必须遵守）**：
  - `2xx` = 已收妥（应用端从队列移除）
  - `4xx` = 报文非法（应用端**丢弃且不重试**）——校验不过就返 400
  - `5xx` = 服务端故障（应用端**重试并入离线队列**，上限后丢最旧）
  - **超时 / 连接错误 / 空响应 = 结果未知**（应用端**重试并入离线队列**，同 5xx）——
    ⚠️ **绝不可按 4xx 丢弃**，详见下面的「超时语义」专条
  - **401 / 403 = 上报端鉴权失败**（缺/错 `X-Ingest-Key`；403 多来自 zone 级 WAF / Bot 规则）—— 归类 `auth`：
    **不当 5xx 无限重试**，**也不静默丢弃**：打明确错误日志，事件保留在队列（上限内），
    密钥修好后自动补发（详见「鉴权与限流语义」专条）
  - **413 = 报文过大**（> 4096 字节）—— 归类 `validation`（毒报文）：**丢弃且不重试**
  - **429 = 超出单 isolate 速率**（报文本身合法）—— 归类 `rate_limited`：
    ⚠️ **唯一可重试的 4xx**，读 `Retry-After` 头退避后重试（详见「鉴权与限流语义」专条）
- 流量形态：1 台 ≈ 2 请求/天（`app_installed` 一次 + `app_opened` 每日一次）
  + 少量功能事件；单报文 < 1KB。

> #### ⚠️ 超时语义（B 工作项必读，v1.2 新增）
>
> **超时 = 结果未知，不是失败**。服务端可能**已经收到并入库**，只是响应没回来。
>
> **实测证据（2026-10-29）**：企业网出口 → Cloudflare 存在**间歇性超时**，
> 且**与 IPv4/IPv6 无关**（同批 30 次：默认双栈 0 失败、`-4` 3 失败、`-6` 2 失败，均为超时）。
> 决定性证据：客户端只收到 25 个 `200`，而服务端闸门计数 `req_count=47` 且固定 `event_id`
> 的事件确实入库 → **请求已落地、响应丢失**。
>
> **客户端必须这么写**：
> 1. **超时 / 连接错误 / 读到空响应 → 一律按 5xx 处理**：入队、按 `event_id` 重发；
> 2. **绝不可按 4xx 丢弃** —— 4xx 只表示"报文非法"，超时不是报文非法；
> 3. **重发必须靠 `event_id` 幂等兜底**（服务端 `INSERT OR IGNORE` 去重）——
>    没有幂等键就不能重发，超时只能丢；
> 4. **必须设客户端超时上限**（建议 10s）+ 指数退避，避免一次挂起卡住整条上报链；
> 5. 别把超时当成 204 的反面 —— **204 = 服务端主动放弃（已收妥，丢弃不重试）**，
>    **超时 = 不知道（重试）**，两者语义相反。

> #### ⚠️ 鉴权与限流语义（B 工作项必读，v1.3 新增）
>
> 服务端已加**上报端共享密钥**：每次 `POST {endpoint}` 必须带头 `X-Ingest-Key: <值>`。
> 值由部署方通过 CF secret `INGEST_KEY` 下发，**线下渠道**给客户端，随 §2.3 的
> `telemetry.json` 的 `ingest_key` 字段下发（**不内嵌进二进制**）。
>
> | 状态码 | 触发条件 | 应用端行为 |
> |---|---|---|
> | **401** | 缺 `X-Ingest-Key` 头，或值不匹配 | 归类 `auth`：**不当 5xx 无限重试**（会变风暴），**也不静默丢弃**（密钥是外部配置、会变）→ 打明确错误日志，事件**保留在队列**（上限内），密钥修好后自动补发 |
> | **403** | 多来自 zone 级 WAF / Bot 规则拦下 | **同样归 `auth`**：保留事件 + 报警，**不当毒报文丢掉** |
> | **413** | 报文体 > 4096 字节 | 归类 `validation`（毒报文）：**丢弃且不重试** |
> | **429** | 单 isolate 每分钟请求数超限（当前 120） | 归类 `rate_limited`：**唯一可重试的 4xx**。读 `Retry-After`（秒）记退避截止，退避期内整队保留不打，到期自动补发 |
>
> **为什么 401 / 403 不能当普通 4xx 丢**：401 是**配置错误**（密钥没配/配错），
> 403 多来自 zone 级 WAF / Bot 规则——**两者都不是报文非法**。
> 丢掉 = 遥测静默归零；无限重试 = 队列膨胀 + 付费模式下的重试风暴。
> 正解是**保留事件 + 响亮报警**，等人工把密钥修好，队列自然补齐。
>
> **为什么 429 是唯一例外**：报文本身**合法**，只是来得太密。丢弃 = 静默丢数据；
> 当普通 4xx 处理 = 还是静默丢数据。**必须退避后重试**。
>
> **服务端未配 `INGEST_KEY` 时返 500**（fail closed，绝不放行）—— 应用端按 5xx 重试，
> 等服务端配好即可恢复，不会出现"没配就放行"的静默无鉴权窗口。
>
> **上线顺序（纪律，不可颠倒）**：**先发客户端**（带上 `X-Ingest-Key`）→ 确认在用
> → **再部署服务端**（`wrangler secret put INGEST_KEY` + `wrangler deploy`）。
> 反过来做：服务端先上 → 老客户端全部 401 → 按 4xx 丢 → **遥测静默零数据**，
> 且现场看起来像"网络故障"，极难排查。详见 issue #2。

### 2.2 事件字典（白名单，收到之外一律 400）

**生命周期（系统自动发）**：
| name | 含义 | 统计用途 |
|---|---|---|
| `app_installed` | 该 device_id **首次启动**（仅一次） | **新用户数** |
| `app_opened` | 每日首次启动 | **日活 DAU / 留存** |

**使用事件（FEAT-20，12 项白名单）**：
| name | 含义 | tag 约定 |
|---|---|---|
| `feature_single` | 单台检查入口 | — |
| `feature_batch` | 批量检查入口 | — |
| `feature_tp2ls` | TP转LS 入口 | — |
| `feature_compare` | 程序对比入口 | — |
| `feature_feedback` | 提交反馈 | — |
| `check_hit` | 检查项命中 | 检查项 ID（如 `MOVE-01`） |
| `err_network` / `err_auth` / `err_validation` / `err_server` | 错误码计数 | — |
| `perf_batch` | 批量性能档位 | `sec` / `min` / `tenmin` |
| `update_result` | 更新结果 | `downloaded` / `installed` |

**tag 规则**：`[A-Za-z0-9_-]{1,32}`（应用端已收敛；服务端同规则复验，越界返 400）。
**device_id**：客户端生成 UUID v4 小写带横线；**服务端只做格式校验**（实现已放宽到 v1–v8、大小写不敏感），**不做任何指纹/追踪**。

### 2.3 客户端配置文件契约

- 路径：`%APPDATA%\robot-backup-checker\telemetry.json`
  （测试口：进程级环境变量 `ROBOT_CHECKER_CONFIG_DIR` 可重定向）
- **两套配置**（v1.7 新增测试环境，与生产**完全隔离**）：

| | 生产 | 测试（验收/压测链专用） |
|---|---|---|
| endpoint | `https://telemetry.misakanet.org/api/send` | `https://rbc-telemetry-test.misakanet.org/api/send`（**推荐**，与生产同款；`rbc-telemetry-test.eric-jia1920.workers.dev` 保留但其部分 IP 在客户端企业网被掐）|
| `website_id` | `robot-backup-checker` | `robot-checker-test` |
| `INGEST_KEY` | 生产那把（实施方线下交付） | **独立的一把**（指纹 `1913d2e868c16af8`），实施方线下交付 |
| `device_id` | 客户端生成 UUID v4 | **首段全零**：`00000000-xxxx-4xxx-xxxx-xxxxxxxxxxxx`（测试流量双标记） |
| 模板 | 客户端 bootstrap 内置 | 公开仓 `telemetry-receiver/telemetry.test.template.json` |

- 内容：

```json
{
  "enabled": true,
  "endpoint": "https://<接收端域名>/api/send",
  "website_id": "robot-backup-checker",
  "usage_enabled": true,
  "ingest_key": "<上报端共享密钥（v1.3 新增），由部署方线下下发；缺失/不匹配 → 每次上报 401>"
}
```

- **语义**：
  - 文件不存在 → **零采集零足迹**（现状行为，已测锁）
  - `enabled: false` → 零采集（总开关 = 界面「使用统计」开关写这个字段）
  - `usage_enabled: false` → 只关 12 项使用事件，保留首启/心跳
  - `website_id` 固定用 `robot-backup-checker`（v1.4：与客户端 6.23.1 模板一致；原为 `robot-checker`，不匹配 → 400 静默丢数）
  - `ingest_key` = 上报端共享密钥；客户端**每次 `POST {endpoint}` 都要带
    `X-Ingest-Key: <这个值>` 头**。**不内嵌进二进制**，由部署方线下下发、随配置下发。
    客户端没拿到 key 时**照发**（不静默停采）→ 服务端 401 → 客户端响亮报错
- **本次要新增**：首启无配置时**写入上述默认文件**（端点常量由实施方部署
  接收端后填入；建议代码里单点常量 `TELEMETRY_DEFAULT_ENDPOINT`）。已有配置
  **绝不覆盖**（用户 opt-out 后不能被写回）。

### 2.4 隐私红线（实现与评审的硬约束）

1. `hostname` 恒为 `"app"`——真实主机名/用户名/路径绝不进报文
2. 事件名与 tag 双层白名单；**禁止**把文件名/机器人名/自由文本塞进 name/tag
3. 服务端**不落 IP 入库**（CF 边缘日志除外，见计划书 §7 保留期）
4. 传输全链 HTTPS
5. 可关闭（见 §2.3）；发布页/README 明示（见工作项 B-3）

---

## 3. 工作项 A · Cloudflare Worker 接收端

**技术栈**：Cloudflare Workers（TypeScript）+ D1（SQLite）。
⚠️ **账号已升级 Workers Paid（$5/月档）** → "免费额度足够"的说法已作废，
现在无日上限，头号风险是**账单失控**，成本闸门是唯一的刹车。详见计划书 §5.3。

> ⚠️ **以下端点表 / schema / SQL 是 v1 契约草案，已被实现取代（2026-10-28）**。
> 接收端**已实现并上线**，代码在本仓 `telemetry-receiver/`，
> **实施时以那里的实际代码与 `telemetry-receiver/schema.sql` 为准**。
> 与本草案的差异（勿照抄）：
> - 表从 2 张增到 4 张：多 `daily_rollup`（看板唯一读源）与 `gate`（成本闸门状态）
> - `events` 增 `event_id`（幂等键，唯一索引）、`recv_ts`（接收时间）两列
> - **删掉 `idx_events_device` 索引**（每条 INSERT 多 1 行写，写额度直接省 33%）
> - 端点多一个 `GET /healthz`（存活 + 今日闸门用量，监控用）
> - `POST /api/send` 多一个 **204** 语义（闸门触发时主动丢弃，2xx，客户端不重试）
> - `GET /api/export` 属第二阶段，**当前未实现**

**端点**：
| 端点 | 行为 |
|---|---|
| `POST /api/send` | 鉴权（`X-Ingest-Key`）→ 校验（§2.1/2.2）→ INSERT `events` + upsert `first_seen` → 200 `{ok:true}`；闸门触发 → **204**；非法 400；鉴权失败 **401**；报文过大 **413**；限流 **429**（唯一可重试 4xx）；D1 失败 503 |
| `GET /dashboard?token=<口令>` | 单页看板：今日新增 / 昨日新增 / 7日DAU / 7日留存 / 功能事件 Top / 版本分布 |
| `GET /healthz` | 存活 + 今日闸门用量（req/evt/dropped/paused/over_budget） |
| `GET /api/export?from=&to=&token=<口令>` | CSV 导出（远期接飞书用，**第二阶段，当前未实现**） |

**D1 schema**（v1 草案，以 `telemetry-receiver/schema.sql` 为准）：
```sql
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name_ts ON events(name, ts);
CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);
CREATE TABLE IF NOT EXISTS first_seen (
  device_id TEXT PRIMARY KEY,
  first_ts INTEGER NOT NULL
);
```

**关键 SQL**（看板即用）：
```sql
SELECT COUNT(*) FROM first_seen WHERE first_ts >= strftime('%s','now','start of day');
SELECT COUNT(DISTINCT device_id) FROM events WHERE name='app_opened' AND ts >= strftime('%s','now','-7 days');
SELECT name, COUNT(*) c FROM events WHERE name LIKE 'feature_%' AND ts >= strftime('%s','now','-30 days') GROUP BY name ORDER BY c DESC;
```

**部署骨架**：
```bash
npm create cloudflare@latest -- telemetry-receiver   # Worker + TypeScript
wrangler d1 create telemetry-db                      # database_id → wrangler.toml
wrangler d1 execute telemetry-db --file schema.sql
npx wrangler deploy                                  # → https://telemetry-receiver.<子域>.workers.dev
```

> ⚠️ **本节已被实现取代（2026-10-28）**：接收端**已实现并上线**，
> 代码在本仓 `telemetry-receiver/`（TypeScript + D1，含成本闸门、cron 聚合、
> 幂等键、4 张表、看板与 `/healthz`）。
> **实施时以 `telemetry-receiver/` 的实际代码为准，不要照上面这份 v1 骨架重搭** ——
> 它的 schema 缺 `event_id` / `recv_ts` / `daily_rollup` / `gate`，
> 且 `wrangler d1 execute` **必须加 `--remote`**（不加会建到本地库，线上表根本没建）。
> 完整契约与口径见 `docs/telemetry-launch-plan.md`（v3.3）。

**防刷底线**：website 校验 + UUID 格式校验 +（可选）CF Rate Limiting 同 IP 10 次/分。
**部署后**：把最终 `/api/send` 端点写回软件端常量（工作项 B-1）。

---

## 4. 工作项 B · 软件端（v6.23.0）

| # | 改动 | 行为规格 | 代码落点提示 |
|---|---|---|---|
| B-1 | **首启默认配置 bootstrap** | 应用启动时若 `%APPDATA%/robot-backup-checker/telemetry.json` 不存在 → 写入 §2.3 默认内容（endpoint 用单点常量 `TELEMETRY_DEFAULT_ENDPOINT`）。**存在则绝不覆盖**（保护 opt-out） | `src-tauri/src/commands/telemetry.rs`（`config_dir()`/`load_config()` 附近）或 `main.rs` setup；注意测试口 `ROBOT_CHECKER_CONFIG_DIR` 与 `config_dir_lock`（见该文件测试段） |
| B-2 | **界面「使用统计」开关** | 一个常驻可见的开关（建议：应用标题栏/关于区）。开 → 写 `enabled:true`；关 → `enabled:false`（即零采集）。切换即时生效，toast 提示「已开启/已关闭使用统计」 | 前端任何常驻区域；写配置走一个新的 Tauri command 或复用 `history.rs` 风格的 fs 写；runtime.js 加包装（invoke 参数对象里**不能写注释**——ipcContract 测试用正则抽参数名） |
| B-3 | **隐私声明** | README + GitHub Release 模板加一段：收集「匿名设备 ID + 版本 + 操作系统 + 事件计数」，不含任何身份/文件/主机名；关闭方法（界面开关/删配置文件） | `README.md`、发版 notes 模板 |
| B-4 | 发版 **6.23.0** | 版本号三处同步（package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json）→ 全链门禁 → 签名产物 → GitHub Release 五件（ASCII 资产名） | 流程见 §5 |

**测试要求**：bootstrap 单测（无配置→写入；已有→不覆盖）+ 开关写配置单测 + 真机验收（§7）。

---

## 5. 仓库 / 构建 / 发版速查

- **仓库**：内网 GitLab `<内网GitLab仓 ai-robot-backup-checker>`（master 受保护，
  走分支 + MR；合并时**不要勾 Squash**）
- **常用命令**（Windows，Node 22 + Rust + pnpm/npm）：
  - `npm run test:quick`（vitest 单测）/ `npm run test:release`（发版门禁 14 步）
  - `npx tauri build`（构建产物，**必须带签名环境变量**，见 §6 坑 1）
  - `node scripts/build-update-artifacts.mjs --skip-build`（组装更新清单，最后一次生成包之后跑）
- **发版检查单摘要**：三处版本号 → `test:release` 14 步全绿 → 签名三件同批
  （zip/.sig/清单签名逐字节一致）→ 发版前全量三入口（`entry-consistency-sweep.mjs`
  不带 limit）→ 桌面固定文件名覆盖（验 FileVersion/MD5）→ 发版记录写进 PROGRESS.md
  → GitHub Release（资产名 ASCII：`robot-backup-checker_<版本>_x64-setup.nsis.zip` 等五件）
  + 匿名下载实测（HTTP 200 + 大小逐字节一致）

---

## 6. 已知坑（前人踩过，直接绕开）

1. **签名构建必须显式 `TAURI_KEY_PASSWORD=''`**（连同 `TAURI_PRIVATE_KEY`）——
   否则签名器在无 TTY 环境打口令提示**永久阻塞**，构建挂着零报错。密钥本身无口令。
2. **构建成功 ≠ 产物含新代码**：改完代码必须重跑 `npx tauri build`，并用
   MD5/FileVersion/行为实测核对产物（曾出过「exe 里没编译进新代码」）。
3. **签名时序**：签名组装（build-update-artifacts）必须是**最后一次生成包**之后——
   之后再跑任何 tauri build 都会甩掉伴生签名，验签必败且目录零报错。
4. **测试环境 ≠ 真实环境**：真机冒烟脚本统一用**中性 CWD**（`os.tmpdir()`）拉起 exe
   （曾因 CWD 相对路径查找工具导致「测试全绿、用户 N/A」的假绿）。
5. **静默吞错是大敌**：N/A/失败必须带原因返回给界面（`{verdict:'N/A', detail:<原因>}`），
   不能 `catch { return null }`。
6. IPC 契约：Tauri invoke 参数名 snake_case；参数对象字面量里**不能写注释**
   （ipcContract 测试用正则抽参数名）。
7. 相对 `--exe` 传参在中性 CWD 下会 ENOENT——一律 `path.resolve`。

---

## 7. 验收判据（全绿 = 上线）

1. `curl -X POST /api/send`（合法报文 + **正确的 `X-Ingest-Key` 头**）→ 200，D1 查得到
   （**v1.3 起必须带头**；无鉴权的 2026-10-28 实测矩阵已过期，不再作基线）
2. 非法报文 → 400，应用端不重试
3. 新机器首启 → 看板 `app_installed` +1（新用户）
4. 次日再开 → `app_opened` +1
5. 断网期间操作 → 恢复后队列冲出、数据齐全
6. 关闭「使用统计」→ D1 零新增
7. 看板数字与 SQL 手查一致（今日新增 / 7日DAU）
   > ⚠️ **各指标去重口径不同，别当成互相矛盾**（2026-10-29 复验实测）：
   > `dau` = `COUNT(DISTINCT device_id) WHERE name='app_opened'`（**只**算发过 app_opened 的设备）；
   > `version` 维度 = `COUNT(DISTINCT device_id)`（**所有事件**的设备）；
   > `new_users` = `COUNT(*) FROM first_seen`（只由 app_installed 建立）；
   > `events` = 按 `event_id` 去重的事件数。
   > → **`version` 的值可以大于 `dau`**（设备发了功能事件但没发 app_opened）。
   > 另：`gate.req_count`（受理的 HTTP 请求数，含幂等重放）与 `events`（去重事件数）
   > 是**不同口径**，数值不可直接相减比较。
8. 不同地区探测点 curl 均 200
9. **超时语义（v1.2 新增）**：把端点指向一个**会超时但仍会入库**的地址
   （或临时断网/掐断链路）→ 客户端应**入队重发**（不得当 4xx 丢弃），
   恢复后数据齐全且**不重复计数**（`event_id` 幂等生效）
10. **204 与超时不混淆（v1.2 新增）**：闸门触发返 204 时客户端**直接丢弃不重试**；
    超时则**重试**。两者处理方式必须相反，可各测一次确认
11. **401 / 403 语义（v1.3 新增）**：不带 `X-Ingest-Key` → 401，客户端应**打明确错误日志**
    （如「上报鉴权失败：X-Ingest-Key 缺失或不正确」）且**不把事件静默丢掉**（保留队列，
    待密钥修好后补发），**不得**当作 5xx 无限重试；带对密钥 → 200。
    **403**（zone 级 WAF / Bot 规则拦下）**同样归 `auth`**，不得当毒报文丢弃
12. **413 语义（v1.3 新增）**：报文 > 4096 字节 → 413，客户端**丢弃不重试**
13. **429 语义（v1.3 新增）**：超过单 isolate 速率 → 429 + `Retry-After` 头，
    客户端**读该头退避后重试**（**唯一可重试的 4xx**），到期补发且靠 `event_id` 不重复计数
14. **真实客户端首启能落库（v1.4 新增）**：在**干净机器**上装发行版 → 首次启动 →
    服务端 D1 能查到该设备的 `app_installed` + `app_opened`。
    ⚠️ 本条曾长期红：**`website_id` 不匹配 → 400 → 客户端丢弃 → 队列排空但零入库**，
    看起来像"客户端没发"。排查手法：抓服务端 tail 的**响应状态码** + 抓客户端真实报文，
    两边对不上就是值不一致（字节级比，别靠眼睛）。
    ✅ 2026-11-02 修正 `website_id` 后实测通过
15. **单设备限流（v1.5 新增）**：同一 `device_id` 1 小时内发 > **60** 次请求 →
    **429** + `Retry-After` 头 + `{"error":"rate_limited","scope":"per-device"}`。
    ⚠️ 与速率限流（`scope":"per-isolate"`）**scope 要能区分**（两者的处置不同）。
    ✅ 2026-11-02 实测通过：第 61 次触发
16. **服务端版本推断（v1.8 新增，v1.10 修正语义）**：同一 `device_id` 下，**`app_version` 低于该设备见过的
    最高版本** ⇒ 服务端把它标进 **`version_below_max`** 列（**不是** `stale_exe`！）。
    ⚠️ **两个语义别混**：`stale_exe` = **客户端的标记**（「该事件由一个更旧的 exe 副本创建」，权威语义，
    服务端**原样存、不改写**）；`version_below_max` = 服务端推断（「版本低于该设备最高版本」，
    ⚠️ **含用户升级前的正常历史事件**，所以**不能**当「旧副本」用，否则会误伤历史数据）。
    服务端只有最终状态，**认不出**「旧副本」语义（≤6.25.1 那类事件无法可靠区分）。
    ✅ 2026-11-11 实测通过：同设备先报 6.26.0 再报 6.20.0 → 后者落库 `stale_exe=1`；
    另测 `6.9.0`（字符串比会判反的版本）同样正确判为 stale。
17. **版本维度归并（v1.9 新增，**待激活**）**：同一 `device_id` 在同一天只应出现在**一个**版本桶里
    （=「该设备当前在用的版本」）。
    ⚠️ 语义提醒：该口径下，设备升级会**回溯**改写它过去那几天的版本归属（8 天窗口内）。
    两种口径都**不丢事件**（stale 事件照旧计入功能维度 / events 总数）。
    ✅ 2026-11-11 实现并实测：线上真实数据 15 桶 / 21 设备-天 → **9 桶 / 13 设备-天**；
    **当前默认 `raw`（口径未变）**，等 #6 的 B 组结论拍板后由维护方一个变量 + 一次 deploy 启用。

---

## 8. 文档落位

- 本文件与计划书在**内网 GitLab 分支 `docs/telemetry-handoff`**（原文，含仓地址）
  与**公开仓 `Ikalus1988/ai-robot-backup-checker-feedback` 的 `docs/`**（内网域名已泛化）
- 实施方 clone 内网仓的地址请向发起方索取（公开仓不留内网域名）

## 9. 联系与决策口径

- 默认开关口径已定：**默认开 + 界面可关 + 明示**（勿改）
- `website_id` = `robot-backup-checker`（v1.4，与客户端发行版一致）；endpoint 部署后由实施方填入软件常量
- 若 CF 路线受阻：备选 B（VPS+Umami）**应用端零改动**（协议同 Umami `/api/send`），
  只改配置端点即可，见计划书附录 D
