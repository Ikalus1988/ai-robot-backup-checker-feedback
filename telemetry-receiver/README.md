# rbc-telemetry · 遥测接收端

「机器人程序检查&转换工具」的匿名使用统计接收端。Cloudflare Worker + D1，部署在
`telemetry.misakanet.org`（misakanet.org 账号下的**独立子域 custom domain**）。

> **契约与口径以 `docs/telemetry-launch-plan.md` v3.1 为准**（在
> `Ikalus1988/ai-robot-backup-checker-feedback` 的 main 分支，仓名见计划书附录）。
> 本 README 只讲"怎么跑起来"与"哪些还没做完"。

## ⚠️ 这个仓现在只是本地仓

- **代码不推进 `ai-robot-backup-checker-feedback`**（公开仓，其 README 明写"只放发布产物，不含源码"）。
- **代码不推进 MisakaNet 仓**（会连带 schema 应用/备份/诊断/部署新鲜度等 7 处交叉，见计划书 §5.9）。
- 内网 GitLab 到位后整体迁过去（纯 git 操作，无需改代码）。

## 文件

| 文件 | 作用 |
|---|---|
| `wrangler.toml` | 部署配置：`cpu_ms` 刹车、每日 cron、D1 绑定、**每日成本闸门阈值** |
| `schema.sql` | 4 张表：`events` / `first_seen` / `daily_rollup` / `gate` |
| `src/index.ts` | 唯一入口：3 个端点 + 1 个 cron，零依赖（无框架、无 zod） |

## 端点

```
POST /api/send                 200 收妥 | 204 闸门主动丢弃 | 400 毒报文 | 429 限流 | 503 故障
GET  /dashboard?token=         看板（今日实时算 + 历史读 daily_rollup + gate 实时行）
GET  /healthz                  存活 + 今日闸门用量（req/evt/dropped/paused/over_budget）
```

`GET /api/export`（CSV）属于**第二阶段**，当前未实现。

**401 / 404 都带提示文案**（不是裸字符串）：会直接说明「正确地址是什么」、
「是缺 token 还是 token 不对」，省掉一轮排障。

### `/healthz` 字段

| 字段 | 含义 |
|---|---|
| `req_count` / `evt_count` | 今日已受理的请求数 / 事件数（**D1 全局精确**，跨 isolate 一致） |
| `dropped` | 今日因闸门丢弃数（已落库部分；未落库的见 `pending_dropped`） |
| `paused` | 存储闸门：cron 清理跟不上写入时置 1 |
| `over_budget` | 今日是否已触顶（`true` 时后续请求一律 204） |
| `pending_dropped` | 本 isolate 尚未落库的丢弃数（节流窗口内） |

### 看板指标的**去重口径各不相同**（别当成互相矛盾）

| 指标 | 去重口径 | 说明 |
|---|---|---|
| `dau` | `COUNT(DISTINCT device_id) WHERE name='app_opened'` | **只**统计发过 `app_opened` 的设备 |
| `new_users` | `COUNT(*) FROM first_seen` | 只由 `app_installed` 建立，一条设备一行 |
| `events` | `COUNT(*)` 去重事件数 | 按 `event_id` 去重（幂等键） |
| `version` 维度 | `COUNT(DISTINCT device_id)` **所有事件** | 发过**任意**事件的设备数 |

> ⚠️ **`version` 的值可以大于 `dau`** —— 一台设备发了 `feature_batch` 但没发 `app_opened`
> → 计入 `version`、不计入 `dau`。这不是矛盾，是两个指标定义不同。
> （实测同一批数据：version 157 / dau 136。）

## 部署步骤

```bash
# 0) 授权（二选一）
wrangler login                          # 交互式，需在浏览器确认
# 或 export CLOUDFLARE_API_TOKEN=...     # 需含 Account Workers Scripts Edit + D1 Edit

# 1) 建 D1 并回填 database_id
wrangler d1 create telemetry-db
#    → 把返回的 database_id 填进 wrangler.toml

# 2) 建表
wrangler d1 execute telemetry-db --file schema.sql --remote   # ⚠️ 必须加 --remote

# 3) 设置看板口令（不进 vars）
wrangler secret put DASHBOARD_TOKEN

# 4) 部署
npx wrangler deploy

# 5) 挂自定义域（Dashboard → rbc-telemetry → Settings → Domains & Routes
#    → Add Custom Domain → telemetry.misakanet.org）
#    或：POST /accounts/{acct}/workers/domains

# 6) 回填软件端常量
#    TELEMETRY_DEFAULT_ENDPOINT = "https://telemetry.misakanet.org/api/send"
```

**部署后必做**（不做不算部署完成，见计划书 §5.6）：

1. `curl /api/send` 合法报文 → 200；非法报文 → 400。
2. **用真实客户端 UA 打一次**：`User-Agent: robot-backup-checker-telemetry` → 必须 **200，不能 403/503**
   （zone 级 Bot Fight Mode / WAF 会连坐子域，被拦即静默丢数据）。
3. 闸门演练：把当日 `gate.req_count` 打满 → 再发 → 期望 **204**。
4. `curl /healthz` → 能看到 req/evt/dropped/paused，且 `req_count` **与实际受理请求数一致**
   （计数没落库 = 看板与告警线全部失灵，是最容易漏掉的静默故障）。
5. 登记进 MisakaNet 的 worker 清单与 `test_worker_compat_dates.py`（compat_date 需 < 1 年）。

## 还没做完的

- [ ] `/api/export` CSV（第二阶段）
- [ ] 看板卡片细分（当前是通用表格，可按 metric/dim 渲染成卡片）
- [ ] 单测（当前靠 curl 验收；计划书 §9 的 15 条判据）
- [ ] zone 级 Bot/WAF 例外配置（若第 2 条检测到 403）
- [ ] 内网 GitLab 仓库 + 独立 CI/Environment

## 五个容易踩的点

1. **闸门计数必须每请求落库**：曾用「isolate 内攒够 100 条再落库」省写行，实测请求分散在多个
   isolate，谁都攒不到 100 条 → D1 计数永远为空 → 看板与告警线读到的永远是 0。
   现在计数与事件写入放进**同一个 batch**：不增加往返次数，只多 1 行写，换来全局精确。
2. **`INSERT OR IGNORE` + 唯一索引 = 幂等**：补发风暴重放不重复计数、不重复计费。
3. **删除也计写额度**：稳态下每日删除量 ≈ 每日插入量，写成本约为"事件数 × 4 行"。
4. **丢弃路径不能每条都写 D1**：洪峰期那会让账单暴涨（违背判据 8「账单不增长」）。
   计数在内存累加、按 2s 窗口批量落库；且写失败**必须吞掉**——抛错会变成 503，
   客户端就会重试入队，正好和降级目的相反。
5. **CF 的 Bot 规则会连坐子域**（2026-10-28 实测）：`User-Agent: Python-urllib/3.12` 被
   Browser Integrity Check 拦成 **403 / 错误码 1010**；真实客户端 UA、curl、浏览器 UA、
   python-requests、Wget、Java、无 UA 均 200。**1010 说明请求根本没到 Worker**，
   不是 Worker 的问题。运维脚本用 urllib 时要显式带 UA。
