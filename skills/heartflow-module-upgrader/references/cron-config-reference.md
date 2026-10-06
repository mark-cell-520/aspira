# 新愿 cron 配置记录（2026-06-05 更新）

## 当前 cron 架构（2层分离）

```
升级 cron (2h)  ──→ 找薄弱模块 → 升级 → 微信通知
   │                    ↑
   └── 带 web-search-plus skill ─┘ (可搜索最新代码模式)

审计 cron (12h) ──→ 6维度全库审计 → 存本地(local)
                      (只有发现问题才输出报告)
```

## Cron 1: 新愿硬核代码升级

| 参数 | 值 |
|------|-----|
| job_id | `34c15eb4730b` |
| model | deepseek-v4-flash |
| provider | custom |
| base_url | `https://by.53hk.cn/v1` |
| schedule | **every 2h** |
| workdir | `~/Pictures/aspira` （技能名 `aspira-engine`；旧值 `~/.hermes/skills/heartflow` 在本机不存在，属 CURRENT_STATE.md 记录的路径漂移） |
| toolsets | `["terminal","file","skills","web"]` |
| skills | `["web-search-plus"]` |
| deliver | weixin |

> ⚠️ 2026-10-06 修复：旧配方依赖的 `src/core/code-engine.js` / `src/core/self-audit.js` 与 `scripts/lightweight-audit.js` / `scripts/manual-audit.sh` **均已删除**（见 heartflow-audit-upgrade-push/SKILL.md 2026-09-17 核实）。照旧方跑只会在缺失引擎上空转，升级从不真实发生。改用现存链路：

**升级规则（已修复）**：
1. `node scripts/autonomous-upgrade.js`（决策引擎自主选片，stdout 输出 chosen 切片 JSON）
2. 针对 chosen 做一次真实、最小、零回归改动
3. 零回归门禁：`node bin/verify.js`（应 15/15）+ `node test/run-all.js`（基线 10 项已知失败源于 `src/benchmark/` 被 `.gitignore:39 benchmark/` 漏锚定，与升级无关；只接受“不新增失败”）
4. 版本 +0.0.1 并四处同步：`VERSION` / `SKILL.md`(front-matter name+version+title) / `package.json` / `src/core/version.js`
5. `git commit`（不自动 push）

## Cron 2: 新愿代码审计

| 参数 | 值 |
|------|-----|
| job_id | `8ab98fa62748` |
| model | deepseek-v4-flash |
| provider | custom:https://by.53hk.cn/v1 |
| schedule | **every 12h** |
| workdir | `~/.hermes/skills/heartflow` |
| toolsets | `["terminal","file","skills"]` |
| deliver | local（存本地，不推微信） |

**审计规则**：调用 self-audit.js 的 6维度全库审计 → 只有 CRITICAL/HIGH 才输出详细报告 → 健康状态不超过3行

## 当前模型/endpoint 配置（2026-06-05 有效）

- **model**: `deepseek-v4-flash`
- **provider**: `custom`
- **base_url**: `https://by.53hk.cn/v1`
- 旧模型名 (MiniMax-M2.7, MiniMax-M2.7-highspeed) 和旧 endpoint (copilot.tencent.com, url.53hk.cn, ai.53hk.cn) 已不再使用

## 注意事项
- 创建 cron 后用户可能纠正模型——确认后再创建
- cron 的 base_url 和主配置可能不同，需要单独设置
- 审计 cron 用 `local` 交付，不推微信——避免每12小时微信消息轰炸
- 升级 cron 带 `web` 工具集 + `web-search-plus` skill，可以在升级时搜索最新代码模式
