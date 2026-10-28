# 新用户使用率统计 · 上线计划书（C 方案：Cloudflare Workers）

> 版本：v1（2026-10-28）
> 决策：用户范围**全球**（不限员工、大多不在公司内网）→ 接收端必须公网可达 → 选 **C 方案（Cloudflare Workers 自建接收器）**
> 状态：计划已定。**已拍板（2026-10-28）**：默认开 + 界面可关 + 明示；
> 实施由**另一台电脑的 agent** 按 `docs/telemetry-handoff.md`（接口与交接书）完成

---

## 1. 背景与目标

**现状**：软件端统计能力已全部内建（v6.22.x 就在）——
- 匿名 `device_id`（UUID v4，本机生成，不含任何身份信息）
- 生命周期事件：`app_installed`（首启）/ `app_opened`（每日首开）
- 使用事件 **12 项白名单**（白名单外事件名一律拒收）
- 离线补发队列（断网/宕机不丢数据，4xx 毒化丢弃、5xx/网络错误重试）
- opt-out（不配置 / `enabled:false` / `usage_enabled:false` = 零采集零足迹）

**缺口**：接收端（统计服务器）未部署、配置未投放 → **一个数据点都没收到**。

**目标**：全球新用户的装机量、新增、日活/留存、功能使用率可统计、可看板、可导出；
数据可控（自己的库）、成本≈0、免专人运维。

---

## 2. 总体架构

```
全球用户电脑（Windows 桌面版）
   │  HTTPS POST /api/send（Umami 兼容 JSON，几 KB/天·台）
   ▼
Cloudflare Worker（公网边缘，全球就近接入）
   │  校验：website_id / 事件名白名单 / 字段收敛
   ▼
Cloudflare D1（SQLite，数据留在自己账号里）
   │
   ├── GET /dashboard  → 关键指标看板（新增/日活/功能使用）
   └── wrangler d1 execute → 任意 SQL 导出 CSV / 推送飞书
```

要点：
- **公网可达**：CF 边缘全球节点，任何地区用户直连，无需域名备案/内网映射/端口转发；
- **协议零改动**：应用端已按 Umami `/api/send` 协议发包，Worker 只需兼容该格式（§4）；
- **数据主权**：D1 存在自己的 CF 账号下，可随时导出/删除。

---

## 3. 指标口径（「新用户使用率」怎么算）

| 指标 | 口径 | 数据来源 |
|---|---|---|
| **新用户数**（按日/周） | `device_id` **首次出现**当天计 1 | 事件 `app_installed` |
| **日活 DAU** | 当日去重 `device_id` | 事件 `app_opened` |
| **留存率** | 第 N 天仍出现 `app_opened` 的新用户占比 | 两事件联查 |
| **总装机量** | 累计去重 `device_id` | 全部事件 |
| **功能使用率** | 各功能事件计数 / 活跃用户数 | 12 项白名单 |
| **升级率** | `update_result` 的 downloaded/installed 计数 | 同上 |

**12 项事件白名单**（应用端已实现，名字以此为准）：

| 事件名 | 含义 |
|---|---|
| `feature_single` / `feature_batch` / `feature_tp2ls` / `feature_compare` | 四大功能入口 |
| `feature_feedback` | 提交反馈 |
| `check_hit` | 检查项命中（tag=检查项 ID，如 MOVE-01） |
| `err_network` / `err_auth` / `err_validation` / `err_server` | 错误码计数 |
| `perf_batch` | 批量性能档位（tag=sec/min/tenmin） |
| `update_result` | 自动更新结果（tag=downloaded/installed） |

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
    "data": {
      "version": "<应用版本，如 6.22.2>",
      "os": "windows",
      "tag": "<聚合键，字母数字-_，≤32 字符>"
    }
  }
}
```

**响应语义**（应用端重试逻辑依赖，必须遵守）：
- 成功 → **2xx**（应用端视为已送达）
- 报文非法 → **4xx**（应用端视为毒报文**丢弃**，不重试）
- 过载/内部错误 → **5xx**（应用端**重试并入队**补发）

隐私红线（应用端已保证，Worker 侧也应照此不收集额外信息）：
- `hostname` 恒为 `"app"`（真实主机名绝不进报文）
- `id` 仅为随机 UUID；不收 IP 入库（CF 日志层面有 IP，见 §8 保留期）
- `tag` 已在应用端收敛为 `[A-Za-z0-9_-]{≤32}`

---

## 5. Cloudflare 侧设计

### 5.1 资源清单

| 资源 | 用途 | 免费额度（以官网为准） |
|---|---|---|
| Worker | 接收 `/api/send` + 校验 + 入库 + 看板 | 10 万请求/天 |
| D1 数据库 | 事件存储 | 5GB 存储、500 万读/天、10 万写/天 |
| 域名 | 默认 `xxx.workers.dev` 免费子域即可 | 免费 |

容量估算：1 台 = 2 次请求/天（心跳+事件），10 万请求/天 ≈ **数万用户**冗余；
存储按每事件 ~200B、每天每用户 5 条计，5GB ≈ **百万级用户月级**数据。超出再升
付费（约 $5/月起），路线不变。

### 5.2 D1 表结构

```sql
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL,           -- 匿名 UUID
  name        TEXT NOT NULL,           -- app_installed/app_opened/白名单事件
  tag         TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  os          TEXT NOT NULL DEFAULT '',
  ts          INTEGER NOT NULL         -- epoch 秒（服务端打点）
);
CREATE INDEX IF NOT EXISTS idx_events_name_ts ON events(name, ts);
CREATE INDEX IF NOT EXISTS idx_events_device  ON events(device_id);

-- 每设备首次出现时间（新用户口径的物化依据，可由查询派生也可定时写入）
CREATE TABLE IF NOT EXISTS first_seen (
  device_id  TEXT PRIMARY KEY,
  first_ts   INTEGER NOT NULL
);
```

### 5.3 Worker 职责（接收器）

1. `POST /api/send`：解析 §4 校验 `type/event`、`website`（等于约定站点 ID）、`name`（生命周期 ∪ 12 白名单）、`id`（UUID 格式）→ INSERT `events` + upsert `first_seen` → 200 `{ok:true}`；
   校验失败 → 400（应用端会丢弃）；D1 瞬时失败 → 503（应用端重试）。
2. `GET /dashboard`：渲染单页看板——今日/昨日新增、7 日 DAU、7/30 日留存、功能事件 Top、版本分布。带一个简单访问口令（query token）即可，不建账号系统。
3. `GET /api/export?from=&to=&token=`：CSV 导出（接飞书/本地留档用）。
4. 防刷底线：校验 `website` + UUID 格式 + 可选的 CF 免费 Rate Limiting（同 IP 10 次/分钟）。

### 5.4 实施命令（骨架）

```bash
npm create cloudflare@latest -- telemetry-receiver   # 选 Worker + TypeScript
cd telemetry-receiver
wrangler d1 create telemetry-db                      # 记下 database_id 写入 wrangler.toml
wrangler d1 execute telemetry-db --file schema.sql
npx wrangler deploy                                  # 得到 https://telemetry-receiver.xxx.workers.dev
```

（Worker 代码含接收/校验/入库/看板四段，由实施 agent 写好提交仓库 `telemetry-receiver/`——
接口规格见 `docs/telemetry-handoff.md`，实施方按该文档即可独立完成。）

---

## 6. 软件侧改动清单（随 6.23.0 发版）

| # | 改动 | 说明 | 量 |
|---|---|---|---|
| 1 | **首启默认配置 bootstrap** | 若 `%APPDATA%/robot-backup-checker/telemetry.json` 不存在 → 写入内置默认（官方端点 + 站点 ID）；用户删之即回到零采集 | 0.5 天 |
| 2 | **界面 opt-out 开关** | 设置区「使用统计」开关 → 写 `usage_enabled:false`（保留手改配置等价） | 含上 |
| 3 | **隐私声明** | README/发布页/GitHub Release 说明：匿名统计收集什么（上表 12 事件+版本+OS）、如何关闭 | 文档 |
| 4 | 发版 | 6.23.0 全链门禁 + 签名 + 发布 | 常规 |

✅ **已拍板（2026-10-28）：默认开 + 界面可关 + 明示**——开箱即报（散装用户
不会手动开配置）；软件内可见开关一键关闭；发布页/README 写明统计项。
（备选「默认关」已否决：统计不到新用户，与目标冲突。）

---

## 7. 隐私与合规

- **匿名**：随机 UUID，无用户名/主机名/路径/机器人名/文件名入报文（事件名与 tag 白名单双层拦截）
- **明示**：发布页与 README 声明统计项；软件内开关可见
- **可控**：一键关闭；关闭后零上报
- **最少留存**：D1 滚动清理 >180 天的明细（月度 SQL 一行）；CF 日志不主动收集 IP 入库
- **传输**：全链 HTTPS（workers.dev 自带证书）
- 全球用户场景按 GDPR「匿名使用数据 + 明示 + opt-out」通行口径执行；如需更严（默认关），见 §6 拍板项

---

## 8. 实施步骤与分工

| 阶段 | 内容 | 谁 | 预估 |
|---|---|---|---|
| 0 拍板 | 默认开/关口径；CF 账号（给我 API Token 或你执行 deploy） | 你 | — |
| 1 CF 侧 | Worker 代码 + D1 schema + 看板 + 部署 | 实施 agent | 0.5 天 |
| 2 软件侧 | bootstrap + opt-out 开关 + 隐私声明 | 实施 agent | 0.5–1 天 |
| 3 验收 | §9 判据全绿 | 实施 agent | 0.5 天 |
| 4 发版 | 6.23.0 门禁 + 签名 + 发布（统计随包生效） | 实施 agent | 常规 |
| 5 运营 | 看板日常看；月度导出/推飞书（可选） | 你 | — |

---

## 9. 验收判据（全绿才算上线）

1. **收数通**：匿名 `curl -X POST /api/send`（合法报文）→ 200，D1 可查到该事件
2. **毒报文丢弃**：非法报文 → 4xx，且应用端不重试（对拍应用队列）
3. **真机首启**：新机器首次启动 → 看板出现 `app_installed`（新用户 +1）
4. **日活**：次日再开 → `app_opened` +1
5. **断网补发**：离线期间操作 → 恢复网络后队列冲出、数据齐全
6. **opt-out**：关闭开关后 → 零上报（D1 无新增）
7. **口径核对**：看板「今日新增/7日 DAU」与 SQL 手查一致
8. **全球可达**：不同地区探测点 curl 均 200（CF 边缘天然满足，抽测 2-3 地）

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 恶意刷量污染统计 | website 校验 + UUID 格式校验 + CF Rate Limiting（可选 WAF 免费规则） |
| 免费额度耗尽 | 看板加量级提示；超限升付费（$5/月级，路线不变） |
| 隐私质疑 | 匿名+明示+可关+最少留存（§7）；发布页可查 |
| CF 账号/服务不可用 | 应用端队列自动补发；接收端可整体迁移到 B 方案（VPS+Umami，协议同为 Umami，**应用端零改动**） |
| 数据看不过来 | 看板只放 6 个关键数；需要深挖走 CSV 导出/飞书 |

---

## 附录 A · telemetry.json 模板（内置默认值）

```json
{
  "enabled": true,
  "endpoint": "https://telemetry-receiver.<你的子域>.workers.dev/api/send",
  "website_id": "robot-checker",
  "usage_enabled": true
}
```

## 附录 B · Worker 接口骨架

```
POST /api/send          200 {ok:true} | 400 毒报文 | 503 入库失败(应用端重试)
GET  /dashboard?token=  指标卡：今日新增 / 昨日新增 / 7日DAU / 7日留存 / 功能Top / 版本分布
GET  /api/export?from=&to=&token=   CSV 下载
```

## 附录 C · 关键 SQL

```sql
-- 今日新用户
SELECT COUNT(*) FROM first_seen WHERE first_ts >= strftime('%s','now','start of day');
-- 7 日 DAU
SELECT COUNT(DISTINCT device_id) FROM events
 WHERE name='app_opened' AND ts >= strftime('%s','now','-7 days');
-- 功能使用 Top
SELECT name, COUNT(*) c FROM events
 WHERE name LIKE 'feature_%' AND ts >= strftime('%s','now','-30 days')
 GROUP BY name ORDER BY c DESC;
```

## 附录 D · 与备选方案的切换成本

C（本方案）→ B（VPS+Umami）：仅改 `telemetry.json` 的 endpoint（应用端零改动），
Umami 原生支持本协议。C → A（Umami Cloud）：同理只换端点。**应用端永不锁死在某个接收端。**
