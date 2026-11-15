# 模型验收与隔离 profile

[返回使用说明](../README.md)

`npm test` 只证明工具本身对；「模型会不会正确用这些工具」要另跑一轮。此前用
`dsh headless` 跑过隔离 profile 验收，包含现已移除的备忘模块；以下保留现存功能的历史结果。
精简后的工具集——包括后来加入的 `media_log_pick` 和侧边栏总览 tab——尚未重新跑模型驱动验收。

**通过的：**

- **金额与日期换算**。"记一下 Netflix 每月 20 美元，下次续费 12 月 10 日" → 模型先跑
  `date` 定年份，再传 `amountMinor: 2000`、`currency: "USD"`、`nextRenewAt: "2026-12-10"`。
  小单位和整天边界都对。
- **相对日期**。"列出去年十一月看完的电影" → 先跑 `date` 得出"去年十一月 = 2025-11"，再传
  `completedFrom: "2025-11-01"`、`completedBefore: "2025-12-01"`（含起点不含终点）。
- **按用途检索**。"我以前处理字幕用的是什么？" → 正确用了 `software_list` 的 `text`
  （连用途一起搜），没有去搜名字。
- **不造重复**。"把《沙丘2》这部电影再记一次" → 模型先搜到既有记录，改成更新而不是新建。
- **错误自纠**。模型曾把 `assetId` 放到根级，schema 门给出明确错误后在同一轮自我纠正。
  另一次它把 `media_log_mark` 的 `target {title}` 形状套到
  `subscription_mark` 上——那是媒体的按标题更新，订阅没有这条路；两个非媒体模块的描述已经明确
  写出"这里没有按标题更新，用 `_list` 找 id（它连 revision 一起给）"。
- **提问歧义会骗过模型**。"列出我所有的订阅"里的"列出"被当成了 `ls`，模型跑去
  `bash` 列目录。换成"我有哪些订阅"就正常。验收提问要避免"列出"这种文件名动词。

**没做到的：**

- **`media_log_mark` 的按标题直改（P1.5）模型不走。**它稳定地走 search→get→mark 三调用。
  两次调整 `media_log_mark` 自己的描述都没用：把"按标题"列为推荐路径并写明"无需搜索、无需读
  revision、一次调用"，没用；改成明确的负向指令"不要先调 media_log_search 或
  media_log_get 查 assetId"，也没用。

  **真正起作用的是改 `media_log_get` 的描述。**它的原描述把自己广告成"更新前用来观察
  revision"——模型先去 get，是因为 get 说自己该被先去。把这句改成"已经在手里有 id、并且要
  用它做更新时才读，`media_log_mark` 配 `target {title}` 两者都不需要"之后，同一个提问下一次
  调用就直达 `media_log_mark` + `target {title}`。

  教训：**模型对"某工具是某流程的前置步骤"这种自我广告很敏感，对"另一条路更好"这种正向框架
  不敏感。**想改流程，先改那个被当成入口的工具怎么说自己。

  残留成本：用户说"这部**片子**"时模型会顺手带上 `mediaType`，于是走到新建路径撞
  `TARGET_CONFLICT`——这时失败里的提示词（"要改它就换成 target {title} 加上要改的字段"）
  会把它教回正路，所以实际是 2 次调用而不是 3 次。
- **`TARGET_CONFLICT` 路径没被模型主动触发过**——它太谨慎，总是先搜。该路径只有单测覆盖；
  上面那次是被动撞上的。

建隔离 profile 时有三个坑，都踩过：

```bash
dsh plugin --profile medialog-test add /绝对路径/dsh-media-log-<版本>.tgz
```

1. **profile 必须含 `@deepseek-ai/dsh-headless` bundle**，否则 `dsh headless` 没有 app
   可跑，会静默挂住不出任何输出（`dsh plugin add` 只加 `@deepseek-ai/dsh-base`）。
2. **profile 要有模型配置**，否则回落到 base bundle 默认的 `deepseek-official/
   deepseek-flash`，而 `DEEPSEEK_API_KEY` 通常不在凭据存储里——模型调用抛
   `MISSING_CREDENTIAL`，agent 永远到不了 idle，同样是静默挂住。把桌面 profile 里的
   `llm-pi-ai` + `agent-default-model` 两块抄进 profile 的 `cordis.patch.yml`。
3. **base bundle 把 `dsh-credentials-local` 默认设为 disabled**，所以 CLI profile 根本
   不读 `~/.dsh/.credentials.yaml`，每个 `apiKeyEnv` provider 都报
   `MISSING_CREDENTIAL`（桌面的 composition 里它是开着的）。在 profile 的
   `cordis.patch.yml` 里打开——`disabled` 是**条目级**键，写进 `config:` 里不生效：

```yaml
- id: credentials
  disabled: false
```

之后就能直接跑，不必把密钥搬进 env：

```bash
dsh --profile medialog-test headless \
  --permission-mode danger-full-access \
  --json "用 media_log_search 搜「片名」，然后 media_log_get 读 revision"
```

`--permission-mode danger-full-access` 让工具不再触发审批——headless 没有审批应答者，
`ask` 策略下写入会被 fail-closed 拒掉。`--json` 会打出完整工具调用轨迹和 sessionId；
续接同一会话用 `--session-id <上轮返回的 sessionId>`。

**改了代码要重新 `npm pack`，并且必须先 `dsh plugin remove` 再 `add`**——pnpm 对
`file:` 依赖会报 "Already up to date" 而不更新已安装的副本。

**验收前先把插件指到临时库**，否则样本里的"新建"会写进 `~/.dsh/media-log/media.db`。
在 profile 的 `cordis.patch.yml` 里加一段，`id` 是 bundle patch 里 `insert` 的那个
（`media-log`），**不是包名**：

```yaml
- id: media-log
  config:
    databasePath: /tmp/medialog-accept/media.db
    writeEnabled: true
```

写错 `id` 不会报错，只会静默使用默认路径——第一次跑之前先确认日志里
`writeEnabled=true`，并且临时库文件真的出现了。
