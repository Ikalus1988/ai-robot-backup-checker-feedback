# 新用户使用率统计 · 上线计划书（C 方案：Cloudflare Workers · 挂靠 misakanet.org）

> **v3 · 2026-10-28**（v1/v2 同日定稿，v3 因套餐升级改写容量与成本章节）
> 决策：用户范围**全球** → 接收端必须公网可达 → **C 方案（Cloudflare Workers 自建接收器）**
> **v2 决策（2026-10-28）：接收端挂靠 misakanet.org**，形态 = **同账号 + 独立子域 `telemetry.misakanet.org`（custom domain）+ 独立 Worker + 独立 D1 库 + 自限流降级**。
> **v3 变更（2026-10-28）：账号已升级 Workers Paid（$5/月档）** → 容量与成本模型整节重写：免费档的"日配额争用"消失，**风险从"配额打穿主服务"转为"无上限的账单暴露"**；自限流从"生存预算"升级为"**成本闸门**"，且必须加显式 `limits.cpu_ms`。
> **v3.1 · 2026-10-28**（同日补充：交叉运行边界）
> **v3.1 新增**：§5.9「与 MisakaNet 的交叉运行边界」——把"能隔离的"与"隔离不了的"分开；**新发现 zone 级安全规则（Bot Fight Mode / WAF / IP 限流）会连坐子域**，客户端 UA `robot-backup-checker-telemetry` 极易被判为机器人 → 被拦返 4xx → 按契约丢弃 → **遥测静默零数据**。新增验收判据 14（真实 UA 实测）与部署纪律一条。
> 实施由**另一台电脑的 agent** 按 `docs/telemetry-handoff.md` 完成。
> ⚠️ **取本文档请用 `git clone` 或 `gh api repos/.../contents/docs/telemetry-launch-plan.md`，不要用 `raw.githubusercontent.com`** —— 2026-10-28 实测：本次推送后 raw 仍返回旧版（其 CDN 缓存未刷新），照旧版实现会沿用已作废的免费档假设（30 天保留期、3,000–5,000 台设备上限、缺 `limits.cpu_ms` 刹车）。
> ⚠️ **交接书 `docs/telemetry-handoff.md` 已同步至 v1.1（2026-10-28）** —— 附录 F 的 8 处差异中，**§3 接收端部分**已按实际实现改写并标注"被实现取代"，其余（软件端相关）仍待同步。
> **工作项 A（Worker 接收端）已完成并上线**，代码在本仓 `telemetry-receiver/`；**软件端（工作项 B）尚未开始**。
> ⚠️ **实施前仍需核对附录 F 的剩余条目**（尤其软件端契约），避免拿到两份互相矛盾的契约。
> 配套调研《2026-10-28-misakanet挂靠可行性与风险.md》**仅本地留存、未入本仓**；本计划书已内联其全部结论与数字，无需另找。
>
> **版本改动速览（评审必读）**
> | 版本 | 相对上一版的关键改动 |
> |---|---|
> | v2 | 挂靠形态定案（子域 custom domain）；**修正 v1 的容量估算错误**——CF 免费配额是账号级而非单服务可用；新增配额切片、204 降级、幂等键、客户端时间戳；§5 整章重写 |
> | **v3** | **套餐升级为 Workers Paid** → §5.3 从"配额切片生存预算"改为"**容量与成本模型**"；保留期 30 天 → **90 天明细 + 聚合长期**（存储不再受限）；**新增 `limits.cpu_ms` 硬刹车**；新增成本闸门与账单告警；H1/H2/H3 的定性全部改写 |
| **v3.1** | 新增 §5.9 交叉运行边界；**新发现 zone 级 Bot/WAF 规则连坐子域**（真实 UA 被拦 → 4xx → 静默丢数据）；新增验收判据 14 |
| **v3.3** | **Worker 接收端已实现并上线**，代码进本仓 `telemetry-receiver/`（§5.6 部署纪律的"禁止推进公开仓"改为带脱敏边界的"允许"）；交接书同步至 v1.1，§3 标注"被实现取代" |

---

## 0. 决策摘要

| 项 | 决策 | 理由 |
|---|---|---|
| 接收端形态 | CF Worker + D1 | 零成本、免运维、全球边缘可达 |
| **套餐档位** | **Workers Paid（$5/月）**（2026-10-28 已升级） | 10M 请求/月 + 25B D1 读/月 + 50M D1 写/月 + 5GB 存储**包含**，足以覆盖本产品现实规模 |
| 挂靠位置 | **misakanet.org 账号，子域 `telemetry.misakanet.org`** | 不新增账号/域名管理成本；同账号已具备运维流水线与监控习惯 |
| 挂靠形态 | **custom domain（子域）**，非 `misakanet.org/telemetry/*` 路径 route | 路由语义与主站解耦；该 zone 历史上因 zone route 指向错 worker 出过 404 事故 |
| Worker 边界 | **独立 Worker + 独立 D1 库**，绝不并入 `misakanet-register-proxy` | 遥测的写风暴/死循环不得波及 MCP 主服务，也不得污染其账单与部署门禁 |
| **成本闸门** | 保留每日预算 + `device_id` 限流 + **超预算返 204** | 付费档**没有日上限** → 失控流量 = 直接烧钱；闸门从"防配额打穿"变成"防账单失控" |
| **CPU 硬刹车** | `limits.cpu_ms = 50_000`（显式配置） | 付费档单次请求 CPU 上限从免费版的 10ms 变 30 秒默认；不设限则一个 bug 可烧出天价账单 |
| 超额行为 | **返回 204**（2xx）而非 4xx/5xx → 客户端直接丢弃、不入队、不重试 | 避免端点持续 5xx 时客户端无限重试 + 补发风暴（付费模式下风暴 = 真金白银） |
| 看板实现 | **只读预聚合表 `daily_rollup`**，禁止直扫明细 | 降低看板延迟与读成本；也让读放大不成为主服务的噪声源 |
| 保留期 | **明细 90 天 + 聚合长期**（180 天现在也可负担） | 付费档单库 10GB、存储 $0.75/GB-月，存储不再是约束；90 天兼顾隐私最小化 |
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
数据可控（自己的库）、成本≈0、免专人运维，且**不得对 MisakaNet 主服务造成任何可用性影响，也不因其产生不可控账单**。

---

## 2. 总体架构

```
全球用户电脑（Windows 桌面版）
   │  HTTPS POST /api/send（Umami 兼容 JSON，<1KB/次）
   ▼
telemetry.misakanet.org  ── CF 边缘（独立 custom domain，独立 Worker：rbc-telemetry）
   │  校验：website_id / 事件名白名单 / tag 字符集+值域 / device_id UUID 格式
   │  成本闸门：device_id 限流 + 每日预算（超预算 → 204 主动丢弃）
   │  CPU 刹车：limits.cpu_ms = 50_000
   ▼
D1 库：telemetry-db（独立库，账号内第 3 个）
   ├── events        明细，保留 90 天，Cron 清理
   ├── first_seen    设备首现（新用户口径依据）
   └── daily_rollup  日粒度聚合（看板唯一读源）
   │
   ├── GET /dashboard   → 读 daily_rollup（延迟与成本都低）
   └── GET /api/export  → 导出明细（受 token 保护）

【同账号但不共享】misakanet.org 主站 / misakanet-register-proxy / MISAKANET_D1
   —— 共享的是账号级账单与域名，故遥测必须自带成本闸门（§5.3/§5.7）
```

要点：
- **公网可达**：CF 边缘全球节点，任何地区用户直连，无需域名备案/端口转发；
- **协议零改动**：应用端已按 Umami `/api/send` 协议发包，Worker 只需兼容该格式（§4）；
- **数据主权**：D1 存在自己的 CF 账号下，可随时导出/删除；
- **隔离优先于便利**：能并进主 Worker 的本方案也并——但遥测**不并**（爆炸半径与账单归因都不对等）。

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

> **204 的语义（v2 新增，务必写进客户端）**：当 Worker 因**自身预算/闸门触发**而主动放弃记录时，返回 **204**。
> 因为 2xx = 已收妥，客户端会直接丢弃该条、**不入队、不重试** → 端点持续不可用时既不会撑爆客户端队列，也不会产生补发风暴（付费模式下风暴 = 真金白银）。
> 若改成 400 → 数据被当毒报文丢弃且不可观测；改成 503 → 队列膨胀 + 恢复时风暴。

**v2 新增的两个字段（客户端需配合，见 §6 工作项 B-1/B-5）**：

1. **`timestamp`（客户端 Unix 秒）** —— **不是可选项**。
   若只有服务端打点：断网 3 天的设备恢复后补发 `app_installed`，会被记成"今天"→ **新用户数、DAU、留存三项核心指标同时失真**。
   服务端取值优先级：`payload.timestamp`（合法区间校验：|now − ts| ≤ 30 天）→ 否则用服务端时间，并标记为"接收口径"计数。
2. **`event_id`（幂等键）** —— 建议客户端生成 UUID v4，或服务端按 `id + name + timestamp` 派生。
   服务端 `INSERT OR IGNORE` 去重 → 补发风暴不会重复计数 → 这是"允许 5xx 重试"的必要配套。

隐私红线（应用端已保证，Worker 侧也应照此不收集额外信息）：
- `hostname` 恒为 `"app"`（真实主机名绝不进报文）——**Worker 侧要校验而非信任**：若收到非 `"app"` 直接 400。
- `id` 仅为随机 UUID；不收 IP 入库（CF 边缘日志层面有 IP，见 §7 保留期）
- `tag` 已在应用端收敛为 `[A-Za-z0-9_-]{≤32}`；**Worker 侧在字符集之外，再对有固定取值域的 tag 做枚举校验**（越界 400）

---

## 5. Cloudflare 侧设计

### 5.1 挂靠账号现状（2026-10-28 实读 + 用户告知）

挂靠到 misakanet.org = 挂到**同一个 CF 账号**。

| 资源 | 账号现状 | Workers Paid 额度（$5/月档） | 遥测占用后 |
|---|---|---|---|
| Workers | `misakanet-web`、`misakanet-register-proxy`、`email-register`（3 个） | 500 个 | 4 个 ✅ |
| **Cron Triggers** | register-proxy 已用 **2**（`*/15 * * * *`、`17 3 * * *`） | **250 个** | 3 个 ✅（免费档时这条曾是硬约束，现已解除） |
| **D1 数据库** | 已用 **2**（`MISAKANET_D1`、`MISAKANET_OPS_D1`） | 50,000 个 | 3 个 ✅ |
| **Workers 请求** | register-proxy 实测 **≈14,000/天**；**静态资源请求免费且无限** | **10,000,000/月 包含**，+$0.30/百万 | 遥测按 75 请求/台/月 计 |
| **D1 读行** | 主服务曾在免费档实测 624 万/天（已超 500 万上限） | **25,000,000,000/月 包含**，+$0.001/百万行 | 不构成约束 |
| **D1 写行** | 主服务语料同步 + counters + 缓存写入 | **50,000,000/月 包含**，+$1.00/百万行 | 遥测按 225 行/台/月 计 |
| **D1 存储** | 与语料库共享 | 5 GB 包含，+$0.75/GB-月；**单库上限 10 GB**，账号上限 1 TB | 遥测 ≤1GB（90 天明细） |
| **CPU 时间** | — | 30,000,000 ms/月 包含，+$0.02/百万 ms；**单次上限 5 分钟（默认 30 秒）** | 遥测远低于上限，但**必须显式设 `limits.cpu_ms`** |
| Workers Logs | 已开 | 20,000,000 events/月 包含，+$0.60/百万 | 遥测仅异常日志 |

> ⚠️ **v1 的估算错在哪**：v1 §5.1 写"Workers ≈10 万请求/天，按 2 请求/天·台 ≈ 数万用户冗余"——把**免费档账号级**的日额度当成了遥测独占额度。
> ⚠️ **v2 的估算也已被套餐升级改写**：v2 按免费档算出"遥测只配 3,000–5,000 台设备"——那是**免费档生存预算**，不是本产品的真实天花板。付费档下这个数字要重算（见 §5.3）。

### 5.2 方案对比与选定

| 方案 | 隔离度 | 风险 | 结论 |
|---|---|---|---|
| **A. 同账号 + 子域 custom domain `telemetry.misakanet.org`** | 代码/部署/回滚/路由/数据全隔离；**仅账单与域名信誉共享** | 低 | ✅ **选定** |
| B. 同账号 + 路径 route `misakanet.org/telemetry/*` | 路由与主站 catch-all 耦合 | 中 | 备选。该 zone 历史上因 route 指向错 worker 造成 `/mcp` 404 事故；且改 route 必须 `PUT`（`PATCH` → 10405 Method not allowed） |
| C. 并进 `misakanet-register-proxy` | 无隔离 | 高 | ❌ 遥测的写风暴/死循环会拖垮 MCP 主服务，并污染其部署新鲜度门禁与**账单归因** |
| D. 独立 CF 账号 | 完全隔离 | 低但**用不了 misakanet.org 域名** | 🔵 保留为迁移路径（附录 D） |

**选 A 的理由**：同账号下 A 与 B 的隔离差异不在账单（都共享），而在**路由语义解耦**——主站是"catch-all 静态站 + 若干精确 route"，遥测是"另一个域名的独立 worker"，两者不共享路径匹配规则，不会出现"A 改 route 踩到 B 的路径"。

### 5.3 容量与成本模型（v3 整节重写：套餐升级为 Workers Paid）

**遥测能吃多少（按 2.5 事件/台/天、每事件 3 行写、1 次请求、90 天明细）**：

| 维度 | 每台每月 | 包含额度可支撑 | 超出后单价 | 现实判断 |
|---|---|---|---|---|
| Workers 请求 | 75 | 10M ÷ 75 ≈ **13.3 万台** | $0.30/百万 | 10 万台 ≈ 750 万请求/月，仍在包含额度内 |
| D1 写行 | 225（75 事件 × 3 行） | 50M ÷ 225 ≈ **22.2 万台** | $1.00/百万行 | 不构成约束 |
| D1 读行 | 看板读 rollup ≈ 几千行/月 | 25B → 不构成约束 | $0.001/百万行 | 不构成约束 |
| 存储（90 天明细） | ≈ 79 KB/台 | 5GB ≈ **6.5 万台** | $0.75/GB-月 | 10 万台 ≈ 7.9GB ≈ $2.2/月 |
| CPU | 每请求 < 5ms | 30M ms/月 | $0.02/百万 ms | 不构成约束 |

→ **结论：$5 档足以覆盖本产品现实规模的全部活跃设备（10 万台级），额外成本个位数美元。**
→ **原先"3,000–5,000 台设备"的生存预算是免费档的产物，不是本产品的真实天花板**（v2 §5.3 的数字随套餐升级作废）。

**每日闸门（成本闸门）——v3.1 统一口径，闸门以「事件数/请求数」计，不以「行数」计**

> 口径统一说明：闸门是应用层的，按**事件数**与**请求数**计；**行数**是账单侧的派生量（行数 ≈ 事件数 × 4，含插入 3 行 + 稳态清理 1 行）。§附录 E 的告警线一律取**闸门线的 80%**——否则会出现"告警线低于闸门线 → 闸门先截断 → 告警永远不响"的死锁。

| 闸门项 | 阈值 | 折合 | 对应活跃设备 | 占账号额度 |
|---|---|---|---|---|
| **请求** | ≤ **100,000/天** | 3M/月 | ≈ 4 万台/天（2.5 事件/台） | 10M 包含额度的 30% |
| **事件** | ≤ **100,000/天** | 3M/月 | 同上 | 写行 12M/月 ≈ 50M 的 24% |
| **存储** | ≤ **4 GB**（90 天明细 ≈ 3.6GB） | — | ≈ 4 万台/天 | 5GB 包含额度内 |
| **单设备** | ≤ **20 次/小时** | — | — | 防单个客户端失控 |
| **CPU** | `cpu_ms = 50_000` | — | — | 跑飞账单刹车 |

- 存储闸门**必须真实现**（不能只写进文档）：cron 清理后若仍存在 `ts` 超期未删的行 → 说明清理跟不上写入速度 → 置 `gate.paused=1` → 之后请求返 204。
- 闸门命中时返回 **204**（2xx）：客户端视为已收妥 → 直接丢弃、不入队、不重试 → 不产生补发风暴、不产生账单。

**主服务同样受益**：2026-10-19 那次 D1 读 624 万/天撞免费档 500 万上限的**硬故障，在付费档下不复存在**（25B/月包含额度）→ "读放大打死整站"的故障形态在主服务侧消失。

**但付费档把风险换了个形状：从"配额打穿"变成"无上限的账单暴露"。**

| 新风险 | 量级 | 对策 |
|---|---|---|
| **Denial-of-wallet / 跑飞账单** | 单台设备每秒重试 = 8.6 万请求/天 ≈ 260 万请求/月 ≈ **$0.78 请求费 + D1 写 780 万行 ≈ $7.8 → 约 $8.6/月/台**；100 台失控设备 ≈ **$860/月** | ① `device_id` 限流（≤20 次/小时）② 每日预算闸门 → 超预算返 **204** ③ **显式 `limits.cpu_ms = 50_000`**（CF 官方推荐：用于"prevent accidental runaway bills or denial-of-wallet attacks"）④ 账单告警（附录 E） |
| **CPU 单次上限放大 1800 倍** | 免费档超 10ms 即被杀（1102）；付费档默认 30 秒 → 一个 bug 请求可烧 30 秒 CPU | 显式 `limits.cpu_ms` + 所有查询走 rollup（读放大也是 CPU） |
| **日志额度被遥测吃掉** | 付费档 20M events/月包含（免费档是 200k/天） | 遥测只在异常/采样时打日志；正常 204/200 不打日志 |
| **账单归因困难** | CF 账单是账号级，遥测与主服务混在一起 | 按 worker 看 usage/dashboard；记录上线前后基线；附录 E 监控项按 worker 拆分 |

### 5.4 D1 表结构（rollup 必备，索引按成本取舍）

```sql
-- 明细：保留 90 天（Cron 清理；付费档单库 10GB，90 天远未触顶）
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
-- idx_events_device 默认不建：每个索引 = 每条 INSERT 多 1 行写（3 行/事件 → 2 行/事件），
--   写行直接省 33%；需要按设备查时再开。

-- 新用户口径依据：只由 app_installed 建立
CREATE TABLE IF NOT EXISTS first_seen (
  device_id  TEXT PRIMARY KEY,
  first_ts   INTEGER NOT NULL
);

-- 看板唯一读源：日粒度聚合（行数极小，读延迟与成本都低）
CREATE TABLE IF NOT EXISTS daily_rollup (
  day        TEXT NOT NULL,        -- UTC 自然日 YYYY-MM-DD
  metric     TEXT NOT NULL,        -- new_users / dau / retained / feature_* / update_*
  dim        TEXT NOT NULL DEFAULT '',
  value      INTEGER NOT NULL,
  PRIMARY KEY (day, metric, dim)
);
```

> **`daily_rollup` 的理由变了**：免费档时它是"防看板读放大打死整站"的硬需求；付费档下它不再关乎可用性，但仍然值得做——① 看板延迟（`COUNT(DISTINCT)` 扫 90 天明细会很慢）；② 读成本与 CPU（读也是计费的：$0.001/百万行 + CPU 时间）；③ 不给主服务的 D1 制造噪声。

### 5.5 Worker 职责（`rbc-telemetry`）

| 端点 | 行为 | 状态码 |
|---|---|---|
| `POST /api/send` | 校验（§4）→ 幂等去重 → INSERT `events` +（`app_installed` 时）`INSERT OR IGNORE first_seen` → 200 `{ok:true}` | 200 / 204 / 400 / 429 / 503 |
| `GET /dashboard?token=` | 读 `daily_rollup`，渲染：今日新增 / 昨日新增 / 7 日 DAU / 7 日留存 / 功能 Top / 错误 Top / 版本分布 / 更新结果 / **今日因闸门丢弃数** | 200 / 401 |
| `GET /api/export?from=&to=&token=` | CSV 导出明细（含 device_id → 按个人数据对待，落盘位置与保留期写进隐私声明）——**第二阶段再做**，最小实现可先只留 `/api/send` + `/dashboard` + `/healthz` | 200 / 401 |
| `GET /healthz` | 存活 + 今日闸门用量（请求/写行/存储）+ 最近错误计数（给监控与排障用） | 200 |
| **Cron（1 个）** | 每日：① 聚合 `daily_rollup` 刷新 ② 删除 `ts` 超 90 天的 `events` ③ 清理超期的 `first_seen` | — |

**校验清单（任一不过 → 400，客户端丢弃）**：
`type == "event"` · `payload.website == "robot-checker"` · `payload.hostname == "app"` ·
`payload.name ∈ 14 个白名单常量` · `payload.id` 匹配 UUID v4 小写带横线 ·
`payload.data.tag` 匹配 `[A-Za-z0-9_-]{1,32}` **且**（若该事件有固定取值域）tag ∈ 枚举 ·
`payload.timestamp` 若存在则 |now − ts| ≤ 30 天 · 报文体长 < 4KB。

**降级与闸门语义（核心）**：

```
请求进来
 ├── 校验不过 → 400（毒报文，客户端丢弃）
 ├── 超过单设备限流（device_id > 20 次/小时） → 429（可重试；客户端退避）
 ├── 今日预算已耗尽（请求/写行任一） → 204（2xx：客户端视为已收妥，直接丢弃，不入队）
 │      + dropped++ 计数（看板可见"今日因闸门丢弃 N 条"）✅ 可观测
 ├── D1 瞬时失败 → 503（客户端重试入队）
 └── 成功 → 200 {ok:true}
```

**`wrangler.toml` 必须显式配置（v3 新增，付费档的关键刹车）**：

```toml
name = "rbc-telemetry"
compatibility_date = "<近 90 天内>"
[limits]
cpu_ms = 50_000        # 付费档默认 30 秒；显式压到 50 秒，限制单请求烧钱上限
[triggers]
crons = ["23 4 * * *"] # 账号 Cron 250 个上限，已用 2，此处占第 3
```

### 5.6 部署形态与步骤

**形态**：custom domain `telemetry.misakanet.org`（CF 自动创建该子域 DNS → 指向 Worker），**不使用 zone route**。
若最终改走路径 route：必须用 `PUT /zones/{zone_id}/workers/routes/{route_id}`（`PATCH` → 10405），改完立即 curl 验证。

```bash
# 0) 前置：CF API Token（权限：Account Workers Scripts Edit + D1 Edit + Zone Workers Routes Edit）
#    注意：本机 ~/.config/.wrangler 的 OAuth 令牌已过期，实施机必须重新登录或用 API Token
wrangler login            # 或 export CLOUDFLARE_API_TOKEN=...

# 1) 取代码（本仓 telemetry-receiver/ 目录；部署配置用本地副本填真实 ID）
cp -r telemetry-receiver /tmp/telemetry-receiver && cd /tmp/telemetry-receiver
cp wrangler.toml.example wrangler.local.toml   # 填入真实 account_id / database_id

# 2) 建 D1 库（独立库）
wrangler d1 create telemetry-db      # database_id 写入 wrangler.local.toml

# 3) 建表（schema.sql 见 §5.4）
wrangler d1 execute telemetry-db --file schema.sql --remote   # ⚠️ 必须 --remote

# 4) wrangler.local.toml 要点（见 §5.5）
#    name = "rbc-telemetry"
#    compatibility_date = "<近 90 天内>"      # zone 审计会查这个
#    [limits] cpu_ms = 50_000                  # 跑飞账单刹车
#    [triggers] crons = ["23 4 * * *"]
#    [[d1_databases]] binding = "DB" / database_id = "<id>"
#    [vars] WEBSITE_ID = "robot-checker"
#    # dashboard token 走 secret，不进 vars
#    wrangler secret put DASHBOARD_TOKEN

# 5) 部署 + 挂自定义域
npx wrangler deploy --config wrangler.local.toml
#    然后在 Dashboard: Workers & Pages → rbc-telemetry → Settings → Domains & Routes
#    → Add Custom Domain → telemetry.misakanet.org
#    （或用 API POST /accounts/{acct}/workers/domains）

# 6) 登记进主服务的 zone 审计（否则 CI 会漏检新 worker）
#    MisakaNet 仓：tests/test_worker_compat_dates.py 与 workers 清单需登记 rbc-telemetry

# 7) 回填软件端常量
#    TELEMETRY_DEFAULT_ENDPOINT = "https://telemetry.misakanet.org/api/send"
```

**部署纪律**：
- 部署后**必须 curl 验证三个地址**：`/api/send`（合法→200 / 非法→400）、`/dashboard?token=`（200）、`/healthz`（200 且闸门用量可见）；
- **必须用真实客户端 UA 测一次**（`User-Agent: robot-backup-checker-telemetry` + 真实报文）→ 期望 200，**不能是 403/503**：
  zone 级的 WAF / Rate Limiting / **Bot Fight Mode** 规则会**连坐子域**，而本客户端的 UA 极易被判为机器人；一旦被拦返回 4xx，按契约即"毒报文丢弃" → **遥测静默零数据且看板无报错**（详见 §5.9）；
- **不验证不算部署完成**（对应交接书坑 2「构建成功 ≠ 产物含新代码」）；
- Worker 代码放在**本仓 `telemetry-receiver/` 目录**（v3.3 修订）：
  它是本产品的服务端组件，公开以便审计与复现；
  **但仓内不含任何真实 CF 资源标识符或密钥** —— `wrangler.toml` 用占位符，
  真实 `account_id` / `database_id` 走不入仓的 `wrangler.local.toml`，
  `DASHBOARD_TOKEN` 走 `wrangler secret put`。
  （原禁令是"Worker 代码不进公开仓"，现按上述边界修订；
  **客户端**源码仍只在内网 GitLab，不进本仓。）

### 5.7 防刷与成本闸门

| 层 | 措施 | 理由 |
|---|---|---|
| 报文 | website 常量校验 + 事件名白名单 + tag 值域枚举 + UUID 格式 | 挡住随手构造的垃圾报文 |
| 单设备 | `device_id` 限流 **≤20 次/小时** | 挡住单个客户端的重试 bug / 死循环（付费档下这是**账单事故**的典型形态） |
| 全局 | **每日预算闸门**（请求数 / 写行数 / 存储三条），超预算 → **204 降级** | 付费档无日顶 → 闸门是唯一的账单刹车 |
| CPU | **`limits.cpu_ms = 50_000`** | CF 官方推荐：用于防止跑飞账单与 denial-of-wallet |
| 异常 | 单台设备日请求数 top 榜 + 突增检测 → 告警 | 发现刷量或客户端 bug |
| 账单 | 账号级账单告警（阈值见附录 E） | 遥测与主服务共用账号，必须能早于月底发现异常 |
| 路由 | 超限时 fail **closed** | 避免客户端在 Worker 未生效时收到 404 而被当毒报文丢弃 |

> **为什么限流主键用 device_id 而不是 IP**：工业用户同一车间/同一出口 IP 下几十台设备，2 请求/天·台 × 30 人 = 60 次/天；按 IP 限流会把整家公司用户误挡在门外。IP 限流只作兜底，阈值放宽（如 120 次/分）。

### 5.8 故障模式与隔离

| 故障 | 表现 | 客户端行为 | 处置 |
|---|---|---|---|
| **账单跑飞**（客户端 bug / 刷量） | 请求与写行量异常上升 | — | device_id 限流 + 每日闸门 → 204 + `cpu_ms` 上限 + 账单告警（附录 E） |
| **CPU 超限** | 错误 1102（Worker exceeded resource limits） | 503 → 入队 | `limits.cpu_ms` 截断；查慢查询（看板直扫明细是典型元凶） |
| 端点长时间 5xx | 客户端队列增长 | 重试入队 | 客户端指数退避 + 队列上限（上限后丢最旧）；服务端幂等；闸门触发时改返 204 避免队列膨胀 |
| D1 写/读异常 | D1 报错 | 503 | Worker 立即 204 降级（不再打 D1） |
| 主服务流量突增 | 账号级用量上升 | — | 遥测闸门独立计数且**遥测先让**；账单按 worker 分开看 |
| Worker 部署出错 / 崩溃 | 端点 5xx | 客户端入队 | 客户端队列兜底；服务端 `wrangler versions deploy` 回滚上一版 |
| 套餐降级回 Free | 单库 500MB / 库数 10 / 日请求 10 万 | — | 保留期策略可一键切到 30 天（附录 D） |

### 5.9 与 MisakaNet 的交叉运行边界（v3.1 新增）

挂靠同一个账号、同一个域名 zone，**必然共享三类东西**。本节把"能隔离的"和"隔离不了的"分开写清楚，避免实施时误以为"上了子域就万事大吉"。

**能隔离（靠选型，已在本方案内）**：Worker 代码与部署流水线、D1 库、cron、路由与路径匹配、DNS/证书、domain 级日志。

**隔离不了（必须靠闸门与自律）**：

| 共享物 | 风险 | 对策 |
|---|---|---|
| **Zone 级安全规则**（WAF / Rate Limiting / **Bot Fight Mode** / 缓存 / Origin Rules） | ⚠️ **连坐子域**。客户端 UA `robot-backup-checker-telemetry` 极易被判为机器人 → 被 challenge/拦返回 4xx → 按契约"毒报文丢弃" → **遥测静默零数据，看板空白也无报错**；zone 级按 IP 的限流还会误伤同出口 IP 的工业用户 | ① 上线前用**真实 UA + 真实报文**测一次（§5.6 部署纪律、§9 判据 14）② 为该子域建"跳过 Bot 挑战"的 WAF 例外 ③ 必要时改 UA（要进 6.23.0） |
| **账号级账单**（Workers / D1 / Logs / KV） | 遥测成本计入主服务账单；主服务流量尖峰也会影响账号级判断 | 成本闸门（§5.3/§5.7）+ 按 worker 分账 + 账单告警（附录 E） |
| **账号级处置**（滥用审查 / 令牌泄漏 / 欠费） | 两者同命；MisakaNet 是有外部贡献者 PR 的公开项目，停服代价远高于遥测 | 迁移路径（附录 D）；遥测不可用**不影响主业务功能** |
| **D1 账号级读写额度** | 遥测的写行（事件 + 索引 + 清理删除）消耗账号 50M/月 包含额度 | 索引做减法；保留期与闸门联合控制 |

**代码层面：绝不进 MisakaNet 仓**。若把遥测代码放进 MisakaNet 仓，会连带 7 处交叉（`apply-d1-schema.yml` 跨库污染 schema、`d1-backup.yml` 把遥测明细纳入主服务备份、`cf-diagnostics.yml` 把遥测错误算进主服务故障噪音、`deploy-freshness.yml` 混淆 COMMIT_SHA 健康语义、`test_worker_compat_dates.py` 需登记、GitHub Environment `hp` 的 PAT 权限共用与审批排队、该仓"PR 列表给贡献者看 / 交接件不入仓"的规矩被破坏）。

**因此**：
- 遥测代码 → **本仓 `telemetry-receiver/` 目录**（v3.3 修订，原为"内网 GitLab 新建仓"），
  独立 CI，**独立 GitHub Environment + 独立 PAT**；
- **不并进 `misakanet-register-proxy` worker**；
- **不复用 MisakaNet 的 D1 库，尤其不复用 `MISAKANET_KV`**（它存着主服务的节点注册与限流计数，复用即等于把一个产品的数据落进另一个产品的存储边界）；
- 只在 MisakaNet 仓做**两处登记**：① worker 清单 / `test_worker_compat_dates.py` 里登记 `rbc-telemetry` 及其 compat_date；② 文档加一行"账号内另有一个独立 Worker（遥测接收端），与本仓无代码耦合，仅共享 CF 账号与域名"。

**上线后 24 小时内的 6 项检查**：① 真实客户端 UA 打 `/api/send` 非 403；② 遥测 worker 请求数 ≈ 装机量 × 2/天；③ `daily_rollup` 的 dau 随天推进；④ `gate.dropped` 为 0；⑤ 遥测的请求与写行在阈值内、账单符合预期；⑤ 主服务错误率与 D1 用量与上线前基线一致。

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
- **最少留存**：明细 `events` **保留 90 天**（Cron 清理）；`first_seen` 按同周期清理；聚合表长期保留（行数极小）
- **传输**：全链 HTTPS（CF 自动证书）
- **不落 IP**：D1 不入库 IP（CF 边缘日志层面有 IP，见 §7 保留期）

### 7.1 挂靠 misakanet.org 的专项合规义务

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
| 0 拍板 | §0 的决策（尤其：挂靠形态、保留期、幂等键、隐私披露、闸门阈值、存量用户口径） | 你 | — | — |
| 1 契约修订 | 把 §3/§4 的口径与新字段回写进交接书 v2（§附录 F 同步清单） | 本机 agent | 阶段 0 | 0.5 天 |
| 2 CF 侧 | Worker + D1 schema + rollup + 闸门 + `cpu_ms` + 部署 + 自定义域 | 实施 agent | **CF API Token** + 阶段 0/1 | 1 天 |
| 3 软件侧 | bootstrap（含 device_id）+ opt-out 开关 + 契约配合（timestamp/event_id/204/退避）+ 隐私声明 | 实施 agent | 阶段 1 | 1 天 |
| 4 验收 | §9 判据全绿（含国内探测点 + 闸门演练 + 真实 UA 实测） | 实施 agent | 阶段 2/3 | 0.5 天 |
| 5 发版 | 6.23.0 门禁 + 签名 + 发布（统计随包生效） | 实施 agent | 阶段 4 + **发版流水线已修** | 常规 |
| 6 运营 | 看板日常看；月度导出/推飞书；**账单与闸门周检**（附录 E） | 你 | — | — |

### 8.1 上线顺序与不可拆分的组合（v3.1 自查新增）

**可以先行的**：阶段 2（CF 侧）**可以早于**阶段 3（客户端）上线——客户端后加的 `timestamp` / `event_id` 字段，Worker 侧对未知字段必须**忽略而非报错**（否则客户端先发新字段会被 400 毒化丢弃）。反过来若客户端先上而 Worker 没上，客户端发的 `timestamp`/`event_id` 会撞上未知的严格校验 → 400 → 丢数据。
→ **顺序铁律：Worker 先上（宽松校验），客户端后上。**

**必须同批、不可拆分的四件事**（拆开任一件都会造成实质问题）：

| 四件事 | 拆开的后果 |
|---|---|
| **bootstrap 写默认配置** + **`device_id` 持久化** | 没有配置 → 零采集 → 统计不到任何人；`device_id` 不持久化 → 每次启动重生成 → 新用户数虚高、DAU 去重失效 |
| **界面 opt-out 开关** | 默认开却**无法关闭** → 直接违反"默认开 + 界面可关 + 明示"的拍板口径，且构成合规问题 |
| **隐私声明**（README / Release 模板 / 软件内） | 默认开但未明示 → 违规；这是三条拍板口径里唯一不能后补的 |
| **契约配合**（timestamp / event_id / 204 / 退避） | 拆开 → 补发事件时间戳错、风暴重复计数、端点抖动时队列膨胀 |

### 8.2 存量用户口径缺口（v3.1 自查新增，**需拍板**）

**问题**：6.22.x 的采集逻辑已内建（`TelemetryState{installed_sent, last_opened_day}`），但**配置文件是 6.23.0 的 bootstrap 才写的**。于是 6.22.x 的存量用户升级到 6.23.0 时：此前从未成功上报（无配置 → 零采集 → `installed_sent` 应仍为 false）→ 升级后首次启动会被记为 **`app_installed` = 新用户**。
→ **"新用户数"会一次性虚高一个 6.22.x 存量用户的量**，且这些人在统计上是"新用户"、实际是老用户。

**三个处置选项（请选一个）**：

| 选项 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 口径改为"**首次成功上报**即记为新用户"，并在看板/README 明示该口径 | 数字含 6.22.x 存量用户，但口径自洽、可复现、可解释 |
| B | bootstrap 检测"是否为升级安装"（如存在 `telemetry-state.json` 或旧版本安装记录）→ 存量用户不发 `app_installed`，只发 `app_opened` | 数字干净，但**依赖源码里 state 文件在无配置时是否会被写**（需查源码，见 §4 核对项 9） |
| C | 接受虚高但**记录基线**：上线时先记一份 6.22.x 装机量估算，看板标注"上线首月含存量升级用户" | 最省事，但长期无法解释口径 |

> 无论选哪个，**都必须在 §9 判据 3（真机首启）里加一条对照**：用一台已装 6.22.x 的机器升级到 6.23.0，观察它是否被记为新用户。

### 8.3 两个容易漏的既有事实（来自 v6.22.2 二进制取证）

1. **`ROBOT_CHECKER_TELEMETRY_URL` 环境变量存在**（v6.22.2 二进制内有此字面量，紧邻 `telemetry.json`）→ 它是**端点覆盖口**。必须写进契约：① 生产不使用；② 验收/测试时用它把上报指到本地抓包服务；③ **它是绕过"文件不存在=零采集"的开关** → 必须在隐私说明里注明"仅测试用"。
2. **配置解析失败时的行为**未定义 → 必须规定：**解析失败 → 重写默认配置 + 记日志**（不能静默沿用坏配置，也不能静默零采集）。

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
| 8 | **闸门降级** | 把日预算调成 0 后再发 | 返回 **204**、不入表、**不入客户端队列**、看板"丢弃数" +1、**账单不增长** |
| 9 | **CPU 刹车生效** | `wrangler.toml` 含 `limits.cpu_ms`；构造慢请求 | 被截断（1102）而非烧满 30 秒 |
| 10 | 口径核对 | 看板数字 vs 手写 SQL（同一 UTC 口径） | 完全一致 |
| 11 | 留存可算 | rollup 里留存卡片有数 | 按 cohort 定义可复现（附录 C） |
| 12 | 全球可达 | 2–3 地探测点，**含中国大陆至少 1 个** | 均 200（自定义域在大陆链路不稳，需实测） |
| 13 | 主服务无影响 | 遥测满负荷跑 24h 后 | MisakaNet 主站请求成功率与 D1 用量**无异常上升**；账单增量符合预期 |
| 14 | **真实客户端 UA 可达** | 用 `User-Agent: robot-backup-checker-telemetry` + 真实报文打一次 | **200**，不是 403/503（验 zone 级 Bot/WAF 未连坐子域，§5.9） |
| 15 | **存量用户升级不算新用户**（或口径已声明） | 用一台已装 6.22.x 的机器升级到 6.23.0 | 按 §8.2 选定口径：新用户数**不含**存量升级用户，或看板/README 已明示"首次成功上报"口径 |

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| **账单跑飞**（客户端 bug / 刷量，付费档无日顶） | device_id 限流 + 每日闸门 → 204 + `limits.cpu_ms` + 账单告警（§5.3/5.7） |
| **zone 级安全规则连坐子域**（Bot Fight Mode / WAF / IP 限流） | 上线前用真实 UA 实测；为子域建 Bot 挑战例外；必要时改 UA（§5.9） |
| **滥用审查牵连 misakanet.org** | 独立子域 + 端点公开透明 + 明确 opt-out + 提供停用联系人；不混用主域路径（§7.1） |
| **隐私质疑（未披露 / 数据关联）** | 隐私政策增补 + 独立 D1 库 + 禁止跨库关联 + 采集项最小化（§7.1） |
| **看板读放大**（延迟 + 读成本 + CPU + 给主服务制造噪声） | 看板只读 `daily_rollup`；明细仅导出（§5.4） |
| **CPU 超限烧钱** | 显式 `limits.cpu_ms`；所有查询走 rollup（§5.5） |
| **日志额度被吃** | 遥测仅异常日志，正常路径不打日志 |
| **route 配错 / zone 审计漏登** | 优先用 custom domain 不手改 route；若用 route 须 PUT + 立即 curl 验证；新 worker 登记进 compat-date 审计（§5.6） |
| **CF 账号/服务不可用** | 客户端队列自动补发；接收端可整体迁移（附录 D）；遥测不可用**不影响主业务功能** |
| **国内可达性** | 自定义域 + 国内探测点实测；不可达则切附录 D 阶段 2/3（仅改 endpoint） |
| **套餐降级 / 成本策略变化** | 保留期与聚合方案可一键切换（附录 D） |
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
POST /api/send                 200 {ok:true} | 204 闸门触发主动丢弃 | 400 毒报文 | 429 限流 | 503 服务故障(重试)
GET  /dashboard?token=         指标卡：今日新增/昨日新增/7日DAU/7日留存/功能Top/错误Top/版本分布/更新结果/今日丢弃数
GET  /api/export?from=&to=&token=   CSV 下载（明细，含 device_id → 按个人数据对待）
GET  /healthz                  存活 + 今日闸门用量 + 最近错误计数
Cron (每日)                     刷新 daily_rollup + 清理 90 天前的 events/first_seen
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
        ↓ 若遥测量超出预期成本，或账号被 CF 处置
阶段 2：换独立 CF 账号 + workers.dev / 自有第二域名
        → 客户端改动 = 改 telemetry.json 的 endpoint（0 代码改动，因端点是单点常量）
        → 服务端改动 = 换 endpoint 指向 + 数据迁移
阶段 3（可选）：换 VPS + Umami（协议同为 Umami /api/send，仍 0 代码改动）

【套餐降级路径】若 Workers 套餐降回 Free：
  → 单库 500MB、库数 10、日请求 10 万 → 保留期从 90 天切到 30 天、闸门阈值从"成本"切回"配额"
  → 聚合表方案天然支持：明细缩短不影响日粒度指标与留存曲线
```
> 前提：**软件端必须把 endpoint 做成单点常量 `TELEMETRY_DEFAULT_ENDPOINT`**，任何逻辑不得硬编码域名/路径。

## 附录 E · 成本与运行监控项（周检 + 告警）

| 指标 | 阈值 | 动作 |
|---|---|---|
| **账号月度账单** | > $10 | 告警（先分清是遥测还是主服务） |
| **遥测请求量** | > **2,400,000/月**（=闸门 3M/月 的 80%） | 告警（检查是否有客户端 bug 在循环上报） |
| **单台设备日请求数 top** | > 100 | 告警（失控客户端的直接信号） |
| **遥测写行** | > **9,600,000/月**（= 写行预算 12M/月 的 80%） | 告警（事件过密或索引冗余） |
| **遥测存储** | > **2.9 GB**（= 4GB 闸门的 80%） | 告警（超出 5GB 包含额度后按 $0.75/GB-月 计费） |
| **遥测 CPU 用量** | > 5,000,000 ms/月 | 告警（说明有慢查询，典型是看板直扫明细） |
| 今日丢弃数（204 闸门触发） | > 0 | 周报中说明原因 |
| `gate.paused = 1`（存储闸门触发） | 出现即告警 | 立即查清理 cron |
| `daily_rollup` 与明细手查一致性 | 不一致 | 立即排查聚合 Cron |

> **告警线一律取闸门线的 80%**：闸门先截断，量永远到不了 100%，所以告警必须比闸门早响，否则等于没设告警。

## 附录 F · 与交接书（`docs/telemetry-handoff.md`）的同步清单

计划书 v3 落地后，**交接书必须同步以下章节**，否则实施 agent 拿到的是两份互相矛盾的契约：

| 交接书章节 | 需要同步的内容 |
|---|---|
| §2.1 上报 HTTP 契约 | 报文加 `timestamp` / `event_id`；**新增 204 语义**（服务端主动丢弃）；5xx 语义不变 |
| §2.2 事件字典 | tag 值域枚举（perf_batch / update_result / check_hit）；白名单用显式常量 |
| §2.3 客户端配置契约 | **新增 `device_id` 字段**；`enabled` vs `usage_enabled` 语义定案；endpoint 默认值改为 `https://telemetry.misakanet.org/api/send` |
| §3 工作项 A | 端点主机名改子域；schema 加 `daily_rollup`/`event_id`/`recv_ts`/`gate`、索引做减法；**新增 §5.3 容量与成本模型 + 成本闸门（204）+ `limits.cpu_ms`**；新增 Cron（聚合+清理）；部署步骤含 custom domain + zone 审计登记 + **zone 级 Bot/WAF 例外**；**新增 §5.9 交叉运行边界（代码不进 MisakaNet 仓、独立 Environment、不复用 MISAKANET_KV）** |
| §4 工作项 B | B-1 bootstrap 必须写 `device_id` 且不覆盖已有；B-2 开关写 `enabled`；**新增 B-5 契约配合**（timestamp/event_id/204/退避） |
| §5 发版速查 | 无需改；但发版链路须先修 `release.yml` 的 checkout ref（见复核报告 §7） |
| §6 已知坑 | **新增第 8 条：发版后必须匿名下载校验产物版本**（现有 7 条坑全在构建期，发版链路是裸奔的） |
| §7 验收判据 | 14 条（新增：幂等、闸门 204、CPU 刹车、留存可算、主服务无影响、**真实客户端 UA 可达（zone Bot 规则）**、国内探测点） |
| §8 联系与决策口径 | 补：挂靠形态、保留期 90 天、幂等键进 6.23.0、隐私政策增补、闸门阈值（请求/事件 ≤100,000/天、存储 ≤4GB、`cpu_ms=50s`）、**存量用户口径（§8.2 三选一）**、`ROBOT_CHECKER_TELEMETRY_URL` 语义（§8.3） |
| **新增 §8.1 / §8.2 / §8.3** | 交接书必须写清：① **Worker 先上、客户端后上**的顺序铁律与"未知字段必须忽略而非报错"② **存量用户升级的口径三选一** ③ `ROBOT_CHECKER_TELEMETRY_URL` 是测试口且是"零采集"开关的例外，必须在隐私说明里注明 |
