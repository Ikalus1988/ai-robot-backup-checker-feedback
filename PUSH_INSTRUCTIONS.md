# 推送与发布步骤（照做即可）

暂存目录：`D:\Downloads\_gh_release_6.21.1\`

里面已备好：

```
assets/
  robot-backup-checker_6.21.1_x64-setup.nsis.zip      (3.4 MB)
  robot-backup-checker_6.21.1_x64-setup.nsis.zip.sig  (460 B)
  latest.json                                          (指向上面那个 zip)
.github/workflows/release.yml                          (发布 workflow)
README.md
```

---

## 你要做的 4 步

### 1. 推到 GitHub 仓

```bash
cd D:\Downloads\_gh_release_6.21.1
git init
git add .
git commit -m "v6.21.1 release assets"
git remote add origin https://github.com/Ikalus1988/ai-robot-backup-checker-feedback.git
git push -u origin main
```

（若仓里已有 `main` 分支和 README，先 `git pull --rebase origin main` 再推。）

### 2. 确认 Environment 名

`.github/workflows/release.yml` 里写的是 `environment: hp`。
**请确认你建的那个 GitHub Environment 就叫 `hp`**（secret `AI` 挂在它下面）。
若名字不同，改 workflow 里那一行即可。

### 3. 跑 workflow 建 Release

仓库页 → **Actions** → 左侧 **Publish release assets** → **Run workflow**

- `tag` 填：`v6.21.1`
- `notes` 可留空（默认用 tag）

跑完即得 Release，资产挂在上面。

### 4. 验收自动更新链路

浏览器匿名访问下面两条，都应能下载（不能跳登录页）：

```
https://github.com/Ikalus1988/ai-robot-backup-checker-feedback/releases/latest/download/latest.json
https://github.com/Ikalus1988/ai-robot-backup-checker-feedback/releases/latest/download/robot-backup-checker_6.21.1_x64-setup.nsis.zip
```

---

## 做完之后告诉我

我把主仓的 `tauri.conf.json` 端点切到这个 GitHub 地址（改动已备好，等 Release 真的在了再提交），
然后重编 + 复验，自动更新就通了。

## ⚠️ 别忘了

**吊销那枚旧的 GitLab PAT** —— 进过聊天记录，且明文留在内网仓的 git 历史里。
