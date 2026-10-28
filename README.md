# 机器人程序检查&转换工具 — 发布产物

本仓**主要放发布产物**，不含**客户端**源码。客户端源码在内网 GitLab（`internal`，不公开）。

> **例外：`telemetry-receiver/`** —— 遥测接收端（Cloudflare Worker + D1）的源码**在本仓**。
> 它是本产品的服务端组件，与客户端源码不同源，公开以便审计与复现。
> 仓库里**不含**任何真实 CF 资源标识符或密钥（部署用 `telemetry-receiver/wrangler.toml.example` 填值）。

---

## 两种用法，按你的场景选

| | **免安装版（绿色）** | **安装版** |
|---|---|---|
| 文件 | `robot-backup-checker_<版本>_portable.exe` | `robot-backup-checker_<版本>_x64-setup.exe` |
| 怎么用 | 下载后**双击即用**，拷 U 盘/桌面都行 | 双击安装 → 快捷方式启动 |
| 适合 | 工位机不方便装软件、临时用、随身带 | 固定工位长期用 |
| 卸载 | 删掉那个 exe 即可 | 控制面板卸载 |
| **版本更新** | 启动时提示「有新版」+ 下载链接，**手动换** | 启动时**自动更新**，静默装完重启 |

> **一句话**：想省事长期用 → 装机版；想拷着走 → 绿色版。
> 两者功能完全一致，只是更新方式不同。

---

## 下载

到 [Releases](https://github.com/Ikalus1988/ai-robot-backup-checker-feedback/releases/latest) 取最新版：

| 文件 | 用途 |
|---|---|
| `…_portable.exe` | **免安装版**，下载即用 |
| `…_x64-setup.exe` | **安装版**，双击安装 |
| `…_x64-setup.nsis.zip` + `.sig` | 自动更新用的包（用户不用管） |
| `latest.json` | 自动更新清单（用户不用管） |

---

## 自动更新怎么工作（装机版）

应用启动时请求：

```
https://github.com/Ikalus1988/ai-robot-backup-checker-feedback/releases/latest/download/latest.json
```

按其中的 `url` 下载更新包，**校验 minisign 签名**通过后静默安装。

**要求**：`latest.json` 与它描述的更新包必须在**同一个 release** 里，
这样 `/releases/latest/` 永远指向自洽的一组，不会出现「清单说 A 包却是 B」。

---

## 为什么资产文件名是 ASCII

产品名是中文，但**发布资产名必须 ASCII**（`robot-backup-checker_<版本>_…`）：
实测内网前置代理对含中文字符的 multipart 文件名直接 `400 Bad Request`，
URL 里的中文/`&` 也容易被各层网关改写。**下载后你可以随意改名**（比如改回中文名放桌面）。

---

## 安全：二进制不含任何内嵌凭据

自 v6.21.1 起，安装包与绿色版都**不内嵌任何 token**。
（此前版本内嵌过一枚 GitLab PAT —— 拆两半只是混淆，`strings` 仍可抽出。
公开分发的二进制里只要留着活凭据就等于泄露，故已清空。）

要用「我要反馈」通道，请自行提供 token（不必重编）：
1. `%APPDATA%/robot-backup-checker/gitlab_token.txt`
2. 环境变量 `CHECKER_GITLAB_TOKEN`

两者皆无时，提交会**明报 `auth` 错**，不静默降级。

---

## 完整性校验

更新包附 `.sig`（minisign 签名，对应 `latest.json` 的 `signature` 字段）。
应用更新前会校验签名，签名不匹配则拒绝安装。
