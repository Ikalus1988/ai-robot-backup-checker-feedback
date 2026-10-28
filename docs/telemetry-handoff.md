# 统计上线 · 实施交接书（给另一台电脑上的实施 agent）

> v1 · 2026-10-28 · 配套计划书：`docs/telemetry-launch-plan.md`
> **本文件自包含**：实施所需的一切接口/规格/命令/判据都在这里，不依赖任何对话背景。
> 已拍板口径：**默认开 + 界面可关 + 明示**（选项见计划书 §6）。

---

## 0. 交接范围

| 项 | 归属 |
|---|---|
| 计划与接口（本文件 + 计划书） | ✅ 已完成（本机 agent） |
| **A. Cloudflare Worker 接收端**（代码 + D1 + 看板 + 部署） | 实施 agent |
| **B. 软件端小改**（默认配置 bootstrap + 界面开关 + 隐私声明） | 实施 agent |
| C. 验收（§7 判据全绿） | 实施 agent |
| D. 发版 6.23.0（含统计生效） | 实施 agent |

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
    "id":       "<device_id：匿名 UUID v4>",
    "data": {
      "version": "<应用版本号，如 6.22.2>",
      "os":      "windows",
      "tag":     "<聚合键，见 §2.2 规则>"
    }
  }
}
```

- **响应语义（应用端重试逻辑依赖，必须遵守）**：
  - `2xx` = 已收妥（应用端从队列移除）
  - `4xx` = 报文非法（应用端**丢弃且不重试**）——校验不过就返 400
  - `5xx` = 服务端故障（应用端**重试并入离线队列**，上限后丢最旧）
- 流量形态：1 台 ≈ 2 请求/天（`app_installed` 一次 + `app_opened` 每日一次）
  + 少量功能事件；单报文 < 1KB。

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
**device_id**：UUID v4 小写带横线；服务端只做格式校验，**不做任何指纹/追踪**。

### 2.3 客户端配置文件契约

- 路径：`%APPDATA%\robot-backup-checker\telemetry.json`
  （测试口：进程级环境变量 `ROBOT_CHECKER_CONFIG_DIR` 可重定向）
- 内容：

```json
{
  "enabled": true,
  "endpoint": "https://<接收端域名>/api/send",
  "website_id": "robot-checker",
  "usage_enabled": true
}
```

- **语义**：
  - 文件不存在 → **零采集零足迹**（现状行为，已测锁）
  - `enabled: false` → 零采集（总开关 = 界面「使用统计」开关写这个字段）
  - `usage_enabled: false` → 只关 12 项使用事件，保留首启/心跳
  - `website_id` 固定用 `robot-checker`
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

**技术栈**：Cloudflare Workers（TypeScript）+ D1（SQLite）。免费额度足够
（Workers ≈10 万请求/天、D1 5GB/500 万读/天——按 2 请求/天·台 ≈ 数万用户冗余）。

**端点**：
| 端点 | 行为 |
|---|---|
| `POST /api/send` | 校验（§2.1/2.2）→ INSERT `events` + upsert `first_seen` → 200 `{ok:true}`；非法 400；D1 失败 503 |
| `GET /dashboard?token=<口令>` | 单页看板：今日新增 / 昨日新增 / 7日DAU / 7日留存 / 功能事件 Top / 版本分布 |
| `GET /api/export?from=&to=&token=<口令>` | CSV 导出（远期接飞书用） |

**D1 schema**：
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

1. 匿名 `curl -X POST /api/send`（合法报文）→ 200，D1 查得到
2. 非法报文 → 400，应用端不重试
3. 新机器首启 → 看板 `app_installed` +1（新用户）
4. 次日再开 → `app_opened` +1
5. 断网期间操作 → 恢复后队列冲出、数据齐全
6. 关闭「使用统计」→ D1 零新增
7. 看板数字与 SQL 手查一致（今日新增 / 7日DAU）
8. 不同地区探测点 curl 均 200

---

## 8. 联系与决策口径

- 默认开关口径已定：**默认开 + 界面可关 + 明示**（勿改）
- `website_id` = `robot-checker`；endpoint 部署后由实施方填入软件常量
- 若 CF 路线受阻：备选 B（VPS+Umami）**应用端零改动**（协议同 Umami `/api/send`），
  只改配置端点即可，见计划书附录 D
