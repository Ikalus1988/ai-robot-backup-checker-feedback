-- 遥测接收端 · D1 schema
-- 口径见 docs/telemetry-launch-plan.md v3.1（时间统一为 UTC 自然日）

-- 明细：保留 RETENTION_DAYS 天（Cron 分批清理；删除同样计入写额度）
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL DEFAULT '',   -- 幂等键（客户端给或服务端派生）
  device_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  tag         TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  os          TEXT NOT NULL DEFAULT '',
  ts          INTEGER NOT NULL,           -- 事件发生时间（优先取客户端 timestamp）
  recv_ts     INTEGER NOT NULL            -- 服务端接收时间（回退统计用）
);
-- 幂等：部分唯一索引，补发风暴重放不会重复计数、也不重复计费
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id) WHERE event_id <> '';
-- 看板聚合用
CREATE INDEX IF NOT EXISTS idx_events_name_ts ON events(name, ts);
-- 时间索引：看板的「今日实时算」按 ts 过滤，没有它会全表扫。
-- 实测（2026-10-28，50 万行跨 90 天分布、今日占 1.1%）：
--   有此索引 → rows_read=5,670 / 3.9ms；无 → rows_read=500,171 / 36.8ms（88 倍差距）。
-- 代价：每条 INSERT 多 1 行写（写额度 +1 行/事件）。
--   写侧代价 ≈ 3M 行/月（D1 付费档 50M/月包含额度的 6%），
--   读侧收益是看板从 O(全表) 降到 O(当日量) —— 量越大越划算，故建。
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
-- 刻意不建 idx_events_device：看板的设备去重改走 rollup 聚合表，
--   不在明细上做 COUNT(DISTINCT)（否则每次开看板都是全表去重）

-- 新用户口径依据：只由 app_installed 建立
CREATE TABLE IF NOT EXISTS first_seen (
  device_id  TEXT PRIMARY KEY,
  first_ts   INTEGER NOT NULL
);

-- 看板唯一读源：日粒度聚合（行数极小，读延迟与成本都低）
CREATE TABLE IF NOT EXISTS daily_rollup (
  day        TEXT NOT NULL,   -- UTC 自然日 YYYY-MM-DD
  metric     TEXT NOT NULL,   -- dau / new_users / events / feature_* / version
  dim        TEXT NOT NULL DEFAULT '',
  value      INTEGER NOT NULL,
  PRIMARY KEY (day, metric, dim)
);

-- 成本闸门状态：每天一行
CREATE TABLE IF NOT EXISTS gate (
  day        TEXT PRIMARY KEY,
  req_count  INTEGER NOT NULL DEFAULT 0,
  evt_count  INTEGER NOT NULL DEFAULT 0,
  dropped    INTEGER NOT NULL DEFAULT 0,
  paused     INTEGER NOT NULL DEFAULT 0   -- 存储闸门：清理跟不上写入时置 1
);
