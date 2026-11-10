# dsh-media-log

DeepSeek Harness 插件：把「手机一句话入库」变成一次工具调用。记录/更新/搜索/读取你
看过、玩过、在看、在玩的电影、剧集、动画和游戏。

| 工具 | 作用 |
| --- | --- |
| `media_log_mark` | 记录/更新一条：状态（在看/看完）、评分（0-10，五星制×2）、绝对进度、短评 |
| `media_log_search` | 搜索候选（含已归档），返回白名单摘要与 `assetId` |
| `media_log_get` | 按 UUID 读取详情与当前 revision |

资料库是**插件自己的一个 SQLite 文件**，直接开在 Host 进程里——不调外部 CLI、不过任
何机器契约。工具返回 `{ok:true, data}` 或 `{ok:false, error:{code, message, ...}}`。

## 为什么是独立的

上一个版本（`dsh-asset-mesh`）是「薄客户端」：插件 → `assetmesh` CLI 子进程 → SQLite。
那个边界让 1742 行里约 710 行只为了「隔着一个进程」而存在，而且让「这次写入到底落库
没有」只能推测——子进程可能在任何时刻死掉，于是有 `WRITE_OUTCOME_UNKNOWN` 和「请先查
询再决定是否重试」这种要把用户拉进来的说法。

直连 SQLite 之后：**事务提交即回执**。已提交的行是事实，回滚的行从未发生，没有未知状
态可言。顺带消失的还有 CLI 版本门槛、机器契约同步、argv 注入面、跨进程写队列、输出上
限与 kill 升级。

代价是丢掉 AssetMesh 桌面端互通，以及活动历史（评分/状态的变更时间线）——两者都是刻
意不做，不是遗漏。

## 前置条件

- DSH **0.2.2-rc.1**、Node ≥ 24 < 25（用内置的 `node:sqlite`）。
- 本机 macOS：插件只在运行 DSH Host 的 Mac 上生效。

## 配置

| 字段 | 说明 |
| --- | --- |
| `databasePath` | **可留空**。留空则用 `~/.dsh/media-log/media.db`，首次使用自动创建（目录 0o700、文件 0o600） |
| `writeEnabled` | **默认 false**。打开后 `media_log_mark` 才能写入 |

`databasePath` 填了就必须是**绝对路径**，而且只能指向本地盘——放到 iCloud/Dropbox/网络
存储上会损坏库。

## 从 AssetMesh 迁移

```bash
# 在旧库的副本上先跑，核对数字，再对真库跑
node scripts/import-assetmesh.mjs --from "/Users/me/Library/Application Support/com.assetmesh.desktop/assetmesh.db"
# 输出：读到 N 条媒体记录，插入 N，跳过 0，目标库现有 N 条
```

源库**只读打开，绝不写入**；可重跑（`INSERT OR IGNORE`）。只搬三个工具用得到的字段，
AssetMesh 的活动事件、FTS 索引、标签、关系、Info 键值都不搬——那些是这个插件刻意没有
的域层。`lifecycle_state` 的 `merged` 映射为 `archived`。

## 安全边界

- 工具参数只接受媒体数据；**没有 argv、没有 shell、没有子进程**，模型无法注入命令。
- 单连接 + 同步 API，写入在本 Host 内天然串行，不需要队列。
- 读-比对-写在**同一个事务**里完成，并发写入插不进来。
- 更新带 `expectedRevision`：读到之后被改过会得到 `STALE_REVISION` 并告知当前 revision，
  不会被静默覆盖。
- 新建前先搜一次同名候选，命中就停下返回 `TARGET_CONFLICT` 和可操作的 `assetId`。
- 新短评和已有短评不同、且未显式 `replaceNotes` 时，整次提交停在 `CONFIRMATION_REQUIRED`。
- `exec.signal` 在入口检查一次：已取消就直接不开始，资料库不会有半点改动。

## 错误码

`CONFIG_REQUIRED` `WRITE_DISABLED` `INVALID_ARGUMENT` `NOT_FOUND` `TARGET_CONFLICT`
`STALE_REVISION` `CONFIRMATION_REQUIRED` `DB_BUSY` `LIBRARY_UNAVAILABLE` `CANCELLED`

`CLI_*`、`QUEUE_BUSY`、`PROTOCOL_ERROR`、`TIMEOUT`、`WRITE_OUTCOME_UNKNOWN` 全部不再
存在——它们的成因（子进程、跨进程排队、机器信封）已经没有了。

## 安装

```bash
npm pack
dsh plugin --profile dsh-medialog-test add /绝对路径/dsh-media-log-<版本>.tgz
# 验证通过后
dsh plugin --profile desktop add --save-exact dsh-media-log@<已验证版本>
```

## 开发

```bash
npm install     # 拉取 devDependencies（测试需要本机的 @deepseek-ai/dsh-tools）
npm test        # node --test：34 项，全部打真实 SQLite 临时库，无 mock、无子进程
npm run build   # 复制 src → dist（纯 ESM，无转译）
npm pack        # 预 pack 钩子自动构建
```

测试直接走插件自己的 `openLibrary()`，所以测的是生产 schema 而不是一份可能漂移的副本。

## 隔离 profile 验收（模型驱动）

`npm test` 只证明工具本身对；「模型会不会正确用这三个工具」要另跑一轮。已用
`dsh headless` 验过五个样本：更新既有条目（search→get→mark）、新建、进度更新、同会话
续接、对已有条目表达新建意图（应停在 `TARGET_CONFLICT` 并列出可操作的 assetId）。

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

## 明确不做

音乐（上游 AssetMesh 的 `MediaType` 本来就没有，需要先有音乐域模块）、活动历史、软件与
订阅、桌面端互通、标签/关系/重复审查。`status` 在 schema 里收 5 个值
（planned/in_progress/completed/paused/dropped），导入的 planned 等记录能原样读回，但
`media_log_mark` 只接受 `in_progress` 和 `completed`。
