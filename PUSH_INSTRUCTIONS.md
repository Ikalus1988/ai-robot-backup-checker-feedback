# 推送与发布步骤（照做即可）

暂存目录：`D:\Downloads\_gh_release_<版本>\`（例：`_gh_release_6.23.0\`）

里面已备好：

```
assets/
  robot-backup-checker_<版本>_x64-setup.nsis.zip      (3.4 MB)
  robot-backup-checker_<版本>_x64-setup.nsis.zip.sig  (460 B)
  latest.json                                          (version 字段 = v<版本>，指向上面那个 zip)
.github/workflows/release.yml                          (发布 workflow）
README.md
```

> ⚠️ **`latest.json` 的 `version` 字段必须等于本次版本号**——workflow 的发布前闸会校验它，
> 不一致直接 fail（这是为了防"发出去的包和清单对不上"这种静默错误）。

---

## 你要做的 4 步

### 1. 把本次产物提交进仓（**顺序不能颠倒**）

```bash
cd D:\Downloads\_gh_release_<版本>
git init
git add .
git commit -m "v<版本> release assets"
git remote add origin https://github.com/Ikalus1988/ai-robot-backup-checker-feedback.git
git push -u origin main
```

（若仓里已有 `main` 分支，先 `git pull --rebase origin main` 再推。）

> ⚠️ **这一步必须真的把本版本的 zip / .sig / latest.json 推上去**。
> 旧版流程的坑就在这里：产物没提交（或提交的是旧版），workflow 照样把仓里**旧版本**的资产
> 挂到新 tag 下面，**全程零报错**，自动更新链路静默停在旧版本。
> 现在 workflow 会在发布前拦（Preflight），并在发布后撤销不合格的 Release（Postflight）。

### 2. 确认 Environment 名

`.github/workflows/release.yml` 里写的是 `environment: hp`。
**请确认你建的那个 GitHub Environment 就叫 `hp`**（secret `AI` 挂在它下面）。
若名字不同，改 workflow 里那一行即可。

### 3. 跑 workflow 建 Release

仓库页 → **Actions** → 左侧 **Publish release assets** → **Run workflow**

- `tag` 填：`v<版本>`（例：`v6.23.0`）
- `notes` 可留空（默认用 tag）

workflow 会跑三段：

| 段 | 做什么 | 不过会怎样 |
|---|---|---|
| **Preflight** | 校验 `latest.json` 版本 == tag、zip/.sig 存在、资产名 ASCII、有 minisign 就验签 | 直接 fail，**不发布** |
| **Publish** | 建 Release 并上传 `assets/*` | — |
| **Postflight** | 匿名下载 `latest.json`（版本要对）+ 更新包（要能下且非空） | **删掉该 Release** 并 fail |

跑完即得 Release，资产挂在上面。

### 4. 验收自动更新链路

浏览器匿名访问下面两条，都应能下载（不能跳登录页）：

```
https://github.com/Ikalus1988/ai-robot-backup-checker-feedback/releases/latest/download/latest.json
https://github.com/Ikalus1988/ai-robot-backup-checker-feedback/releases/latest/download/robot-backup-checker_<版本>_x64-setup.nsis.zip
```

并确认 `latest.json` 里的 `version` 是 `v<版本>`。

---

## 做完之后告诉我

我把主仓的 `tauri.conf.json` 端点切到这个 GitHub 地址（改动已备好，等 Release 真的在了再提交），
然后重编 + 复验，自动更新就通了。

## ⚠️ 别忘了

**吊销那枚旧的 GitLab PAT** —— 进过聊天记录，且明文留在内网仓的 git 历史里。
