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
-- 刻意不建 idx_events_device：每个索引 = 每条 INSERT 多 1 行写
--   （3 行/事件 → 2 行/事件，写额度直接省 33%）

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
