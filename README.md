# 机器人程序检查&转换工具 — 发布产物

本仓**只放发布产物**（安装包 / 更新签名 / `latest.json`），不含源码。

- 源码仓：内网 GitLab（`internal`，不公开）
- 本仓：产物公开分发，供**自动更新**拉取

## 自动更新怎么用到本仓

应用启动时按顺序请求下列端点取 `latest.json`，再按其中的 `url` 下载安装包：

```
https://github.com/Ikalus1988/ai-robot-backup-checker-feedback/releases/latest/download/latest.json
```

`latest.json` 里的 `url` 指向同名 release 的安装包：

```
https://github.com/Ikalus1988/ai-robot-backup-checker-feedback/releases/latest/download/robot-backup-checker_<版本>_x64-setup.nsis.zip
```

**要求**：`latest.json` 与它描述的安装包必须在**同一个 release** 里，
这样 `/releases/latest/` 永远指向自洽的一组，不会出现「清单说 A 包却是 B」。

## 为什么资产文件名是 ASCII

产品名是中文，但**发布资产名必须 ASCII**（`robot-backup-checker_<版本>_…`）：
实测内网前置代理对含中文字符的 multipart 文件名直接 `400 Bad Request`，
URL 里的中文/`&` 也容易被各层网关改写。本地构建产物仍叫中文名（用户可读），
只是上传时改用 ASCII 名。

## 安全：二进制不含任何内嵌凭据

自 v6.21.1 起，安装包**不内嵌任何 token**。
（此前版本内嵌过一枚 GitLab PAT —— 拆两半只是混淆，`strings` 仍可抽出。
公开分发的二进制里只要留着活凭据就等于泄露，故已清空。）

要用「我要反馈」通道，请自行提供 token（不必重编）：
1. `%APPDATA%/robot-backup-checker/gitlab_token.txt`
2. 环境变量 `CHECKER_GITLAB_TOKEN`

两者皆无时，提交会**明报 `auth` 错**，不静默降级。

## 完整性校验

每个 release 附 `.sig`（minisign 签名，对应 `latest.json` 里的 `signature` 字段）。
应用更新前会校验签名，签名不匹配则拒绝安装。
