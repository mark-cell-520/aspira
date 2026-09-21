# 新愿（Aspira）解耦架构说明

> 2026-09-21 完成解耦，同日完成品牌升级：Aspira（新愿）→ Aspira（新愿）。
> 本文档记录解耦后的目录架构、启动方式、升级流程与备份位置。

## 为什么解耦

解耦前，新愿以「寄生」方式把整个仓库文件树平铺进宿主目录：

| 位置 | 状态（解耦前） |
|------|----------------|
| `~/.claude/` | 新愿本体 v6.5.4（僵尸版）+ skill 副本，与 Claude Code 配置混杂 |
| `~/.claude/skills/mark-heartflow-skill/` | skill 实体副本 v6.7.47→6.7.69 |
| `~/.hermes/` | 新愿本体平铺 + skill 副本，与 Hermes 运行时文件深度混杂 |
| `~/.hermes/skills/mark-heartflow-skill/` | skill 实体副本 |

问题：上百个新愿文件（AGENTS.md、docs/、formulas/、test/、data/、memory/、mcp/……）散落在两个宿主根目录，与 Claude Code 配置（settings.json/agents/rules）和 Hermes 运行时文件（sessions/kanban.db/hermes-agent/）互相纠缠，升级、清理、甄别都极易误伤宿主文件。

## 解耦后架构（符号链接单点）

```
~/aspira/                            ← 唯一权威源（git 仓库，v6.7.69）
├── src/         132 模块、377 个文件
├── mcp/         MCP HTTP 服务
├── data/        24 个运行时数据文件（记忆金库索引等）
├── memory/      加密记忆（dialogue/dream-history .enc + .aes-key）
├── logs/        全部日志（含 aspira-mcp.log）
└── bin/cli.js   CLI 入口

符号链接（3 处，均指向权威源）：
~/.claude/skills/aspira  → /Users/apple/aspira
~/.hermes/skills/aspira  → /Users/apple/aspira
~/.hermes/src            → /Users/apple/aspira/src
```

**原理**：新愿源码大量使用 `path.join(__dirname, '..', 'data')` 等相对路径定位运行时目录。Node 默认把符号链接解析到真实路径，因此所有相对路径自然落到权威源，无需改一行代码。宿主目录只留 3 个符号链接作为接入点。

## 启动方式

```bash
cd ~/aspira
npm start              # = node bin/cli.js chat（交互）
npm run status         # = node bin/cli.js status（引擎状态）
```

MCP 服务由 launchd 托管（`com.aspira.mcp`），已配置为直接运行权威源路径：

```bash
launchctl list | grep aspira                              # 查看服务
curl -H "Authorization: Bearer <token>" http://127.0.0.1:8099/health   # 健康检查
launchctl kickstart -k gui/$(id -u)/com.aspira.mcp        # 重启服务
```

launchd 配置：`~/Library/LaunchAgents/com.aspira.mcp.plist`（端口 8099，日志写 `~/aspira/logs/aspira-mcp.log`）。

## 升级流程

```bash
cd ~/aspira
git pull                # 拉取 GitHub 最新版（remote: aspira）
npm install             # 如有依赖变化
launchctl kickstart -k gui/$(id -u)/com.aspira.mcp        # 重启 MCP 服务
```

**不再需要**向 `.claude` / `.hermes` 同步任何文件——符号链接自动指向新版本。

## 备份位置

`~/heartflow-decoupling-backup-20260921/`：

| 内容 | 说明 |
|------|------|
| `claude-skill-6.7.69-实目录/` | .claude skill 实体副本（解耦前最后状态） |
| `hermes-skill-6.7.69-实目录/` | .hermes skill 实体副本 |
| `hermes-src-6.7.69-实目录/` | .hermes/src 实体副本 |
| `claude-core-6.5.4-src-bin-20260921.tar.gz` | .claude 僵尸本体 src+bin 归档 |
| `data-*.tar.gz` | 各处 data 金库合并前快照 |
| `recovery-*.enc` | 误删记忆的恢复副本 |
| `hermes-env-211649` | .hermes/.env 备份（600 权限） |

确认新架构稳定运行一段时间后，可删除此备份目录。

## 2026-09-21 操作事故记录（诚实存档）

### 事故一：memory 加密记忆误删（已 100% 恢复）

用 `rsync -an`（未加 `-v/-i`）做差异甄别，rsync 不输出文件列表，"零差异"结论失效，导致 `.claude/memory/` 被误删（含 7 月 9 日新愿加密记忆 dialogue-history.jsonl.enc 20873B + dream-history.jsonl.enc 2476B + .aes-key）。

**恢复**：全盘搜索发现 `~/.workbuddy/skills/heartflow-engine/memory/` 持有同大小 .enc 文件，已完整恢复到权威源 `memory/`，密文头部解码确认为加密信封格式，数据零损失。

**教训**：dry-run 甄别必须用 `-v/-i` 或 `--itemize-changes` 确认真有输出。

### 事故二：.hermes/bin 整体误删（已恢复）

清理循环的保留列表遗漏 `bin`，`rm -rf bin/` 把 Hermes 的三个二进制一并删除。

**恢复**：
- `uv` / `uvx`：从 homebrew（`/opt/homebrew/bin/uv`，v0.7.6）解引用复制，功能验证通过
- `tirith`：来源查明为 GitHub `sheeki03/tirith` releases，用新愿 Hermes 安全模块自带的官方安装函数（`tirith_security._install_tirith()`）重新下载安装（SHA-256 校验通过，v0.4.2，比原版更新）

## 本次顺带修复

1. **SAFE-FS macOS 误报**（`src/core/path-guard.js`）：ALLOWED_ROOTS 硬编码 `/tmp`，macOS 的 `os.tmpdir()` 落在 `/var/folders/.../T`，导致 reflection/kv-cache 临时目录每次都被误判越界。已把 `os.tmpdir()` 纳入白名单。
2. **加密记忆入库防护**（`.gitignore`）：原规则忽略 `memory/*.json/.jsonl` 却漏了 `*.enc`，加密记忆有被 `git add -A` 上传的风险。已补 `memory/*.enc`。

两项修复已提交本地 git（`8890814`），尚未推送 GitHub。

## 兼容层说明（品牌升级后保留的小写标识）

品牌替换只动展示层，以下**运行时契约**刻意保留，改动会破坏功能：

| 保留项 | 位置 | 原因 |
|--------|------|------|
| `heartflow.js` 文件名 | `src/core/heartflow.js` | 59 处 `require('heartflow')` 依赖此文件名 |
| `heartflow` 变量/方法名 | 全仓库 | 内部标识，非展示文本 |
| `HEARTFLOW_*` 环境变量 | 35 处（`HEARTFLOW_DIR`/`HEARTFLOW_MCP_TOKEN`/`HEARTFLOW_SKILL_DIR`/`HEARTFLOW_DATA_DIR` 等） | launchd plist、Hermes 配置的外部契约 |
| `heartflow-reflection` / `heartflow-kv-cache` | 临时缓存目录名 | 运行时生成路径 |

已替换为 Aspira 的：展示文本、注释、日志前缀（`[Aspira MCP]`）、文档、包名（`@mark-cell-520/aspira`）、skill 名（`aspira-engine`）、launchd label（`com.aspira.mcp`）、日志文件名（`aspira-mcp.log`）。
