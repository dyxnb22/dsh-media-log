# dsh-media-log

DeepSeek Harness 插件：把「手机一句话入库」变成一次工具调用。记录/更新/搜索/列表/读取你
看过、玩过、在看、想看、搁置或弃了的电影、剧集、动画和游戏；也记你付着的订阅、装过的软件
及其用途。

| 工具 | 作用 |
| --- | --- |
| `media_log_mark` | 记录/更新一条：状态（想看/在看/看完/搁置/弃了）、评分（0-10，五星制×2）、绝对进度、短评，以及标题/类型/年份纠正与字段清空。可按 UUID、按标题或新建三种方式指定目标 |
| `media_log_pick` | 今晚看什么：从**你自己记下的**想看（或搁置）清单里等概率随机挑几部，报告池子大小；不造标题、不查外部数据，挑中后一句"标成在看"就入库 |
| `media_log_search` | 搜索候选（含已归档），返回白名单摘要与 `assetId` |
| `media_log_get` | 按 UUID 读取详情与当前 revision |
| `media_log_list` | 无片名列表：类型/状态/归档、完成日期范围、分页，返回带评分进度的可操作摘要 |
| `subscription_mark` | 记录/更新一条订阅：金额（整数小单位）、币种、计费周期、下次续费日、到期日、是否自动续费 |
| `subscription_list` | 无片名列表：续费日期窗口、周期/币种/自动续费筛选，附按月均估算 |
| `subscription_get` | 按 UUID 读取订阅详情与当前 revision |
| `software_mark` | 记录/更新一条软件：**为什么装**（用途）、类别、来源、版本、平台；停用后用途和备注仍在 |
| `software_list` | 按名称/类别/**用途**检索在用或已停用的软件 |
| `software_get` | 按 UUID 读取软件详情与当前 revision |
| `media_log_changes` | 跨模块的最近改动：三个模块写入时各记一行，含动了哪些字段；只保留最近 500 条 |

后续未触发功能的候选与实施约定见[功能迁移开发计划](docs/feature-migration-plan.md)。计划项不代表当前版本已经支持。

资料库是**插件自己的一个 SQLite 文件**，直接开在 Host 进程里——不调外部 CLI、不过任
何机器契约。工具返回 `{ok:true, data}` 或 `{ok:false, error:{code, message, ...}}`。

## 为什么是独立的

上一个版本（`dsh-asset-mesh`）是「薄客户端」：插件 → `assetmesh` CLI 子进程 → SQLite。
约一半代码只为隔着这个进程而存在，而且子进程可能在任何时刻死掉，「这次写入到底落库没有」
只能推测（`WRITE_OUTCOME_UNKNOWN`）。直连 SQLite 之后，**工具在事务提交成功后返回回执**，
Host 存活时能直接判断提交结果；Host 在提交后、回执送达前退出的极端情况，重试前仍需查询记录。
代价是丢掉 AssetMesh 桌面端互通和完整的活动历史（评分/状态的变更时间线）。

## 前置条件

- DSH **0.2.2-rc.1+**（rc.3 实测）、Node ≥ 24 < 25（用内置的 `node:sqlite`）。
- 本机 macOS：插件只在运行 DSH Host 的 Mac 上生效。

## 配置

| 字段 | 说明 |
| --- | --- |
| `databasePath` | **可留空**。留空则用 `~/.dsh/media-log/media.db`，首次使用自动创建（目录 0o700、文件 0o600） |
| `writeEnabled` | **默认 false**。打开后三个模块的 `*_mark` 工具才能写入 |

`databasePath` 填了就必须是**绝对路径**，而且只能指向本地盘——放到 iCloud/Dropbox/网络
存储上会损坏库。

## 从 AssetMesh 迁移

```bash
# 在旧库的副本上先跑，核对数字，再对真库跑
node scripts/import-assetmesh.mjs --from "/Users/me/Library/Application Support/com.assetmesh.desktop/assetmesh.db"
# 输出：读到 N 条媒体记录，插入 N，跳过 0，目标库现有 N 条
```

源库**只读打开，绝不写入**；源目标指向同一文件时拒绝执行。可重跑：仅跳过重复 UUID，
其他约束错误会回滚本轮导入；已有目标记录不覆盖。此导入器只搬媒体字段，
不搬 AssetMesh 的活动事件、FTS 索引、标签、关系或非媒体记录。
`lifecycle_state` 的 `merged` 映射为 `archived`。

## 安全边界

- 工具只读写资料字段，**没有 argv、没有 shell、没有子进程**，这些工具不会执行存下来的命令。
- 单连接 + 同步 API，写入在本 Host 内天然串行；读-比对-写在**同一个事务**里完成，并发写入
  插不进来。
- 更新带 `expectedRevision`：读到之后被改过会得到 `STALE_REVISION` 并告知当前 revision，
  不会被静默覆盖；同值重提得到 `unchanged`，revision 不动。**按标题更新不需要它**——工具
  在同一个事务里自己定位并读取 revision，这条路不可能过期。
- 三种指定目标的方式：`target {assetId, expectedRevision}` 按 UUID 改；`target {title}` 加上
  要改的字段按标题改（拼写不一致时返回最接近的记录，不猜）；`target {title, mediaType}` 新建。
  `mediaType` 是"这是新作品"的信号，所以它在不在 target 里就是新建和更新的分界。
- 新建或改名撞上别的同名记录（**含已归档**）都会停下返回 `TARGET_CONFLICT` 和可操作的
  `assetId`，不会悄悄造出同名重复；当前不支持同名新建，需选择已有条目更新。
- 更新可以纠正标题/类型/年份（`metadata`）和清空评分/年份/短评/进度（`clear`）：标题和类型
  不接受清空，进度作为整体清空、不留下只有单位的残值。新短评和已有短评不同、且未显式
  `replaceNotes` 时，整次提交停在 `CONFIRMATION_REQUIRED`，清空已有短评走同一个门。
- `exec.signal` 在入口检查一次：已取消就直接不开始，资料库不会有半点改动。

## 错误码

`CONFIG_REQUIRED` `WRITE_DISABLED` `INVALID_ARGUMENT` `NOT_FOUND` `TARGET_CONFLICT`
`STALE_REVISION` `CONFIRMATION_REQUIRED` `DB_BUSY` `LIBRARY_UNAVAILABLE` `CANCELLED`

三个模块共用同一套错误码——同一个失败原因，无论撞在哪个工具上，读起来都一样。

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
npm test        # node --test：真实 SQLite 临时库，无 mock；含导入 CLI 参数回归
npm run build   # 复制 src → dist（纯 ESM，无转译）
npm pack        # 预 pack 钩子自动构建
```

测试直接走插件自己的 `openLibrary()`，所以测的是生产 schema 而不是一份可能漂移的副本。

## 导出

资料库就是一个 SQLite 文件，但要做完整、别人能读的备份时：

```bash
node scripts/export-library.mjs --out 备份.json          # 默认导出 ~/.dsh/media-log/media.db
node scripts/export-library.mjs --from <media.db> --out 备份.json
node scripts/export-library.mjs | jq .                   # 不带 --out 打到 stdout
```

导出以**只读**方式打开源库，不迁移、不建表；SQLite 可能创建或使用 WAL 辅助文件。
旧版本资料库导出它有的表，
缺的表在结果里点名而不是造假补空。JSON 保留原始列名和 `user_version`，长字段不截断（这是
档案，不是渲染）。`--out` 只新建 `0600` 文件，已有文件（包括链接）一律拒绝覆盖；重复导出
请换一个文件名。不带 `--out` 时 stdout 只输出 JSON，运行提示输出到 stderr。恢复需求出现之前不配导入。

独立备忘及其兼容逻辑已移除。新库只创建 `media`、`subscriptions`、`software`、`changes`
四张表，导出也只包含这四张表；`media_log_changes` 只接受三个业务模块。
数据库 `user_version` 为 7。

## 侧边栏总览（桌面端，可选）

装了社区插件 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（≥ 0.25.0）
的桌面上，侧边栏的「+」菜单里会出现「资料库总览」：一行总览数字（在看 / 想看 / 本月看完 /
在用软件 / 订阅月均估算）加四类待办（**续费日已过**、**7 天内续费**、**搁置久了**、**在看中**）。
tab 变为可见时拉取一次数据，也可以手动刷新；没有轮询、没有缓存。有逾期的续费时，tab 图标上会
亮出条数徽标（在 tab 可见和侧栏状态变化时节流刷新）。「搁置久了」按记录最后一次改动算——
搁置满 30 天没动过才出现，问的是"捡回来还是弃了"。

- **只读**。tab 里没有任何写操作——对待办的回应走对话里的正常工具（比如一句“Netflix 续费了”）。
- **依赖是可选的**。没装 better-sidebar、或在 headless profile 里，这个 tab 和它的
  `GET /media-log/api/overview` 路由都不注册，12 个工具照常工作；插件也没有对 better-sidebar
  的 npm 依赖（tab 描述符是纯对象）。
- **续费日已过只说明登记的日期已过**，不代表已扣款——tab 把它作为提问呈现（“这次续了吗？”），
  和工具的渲染口径一致。
- “本月看完”按**完成日期**口径（同 `media_log_list` 的完成日期窗口），与当前状态无关。
- 路由经桌面网关的同一条鉴权链（connection admission）逐请求校验，只返回白名单字段。

## 模型验收

隔离 profile 的配置步骤、历史模型验收结果和排坑记录见仓库中的
[模型验收文档](docs/model-acceptance.md)。精简后的 12 个工具尚未重新跑模型驱动验收。

## 当前版本的能力边界

当前未提供通用备忘、音乐、完整活动历史、非媒体导入、桌面端互通、标签/关系/重复审查。
后续迁移按上面的计划逐项取舍，当前版本行为保持不变。`status` 收 5 个值
（planned/in_progress/completed/paused/dropped），`media_log_mark` 全部接受，新建不带
`status` 时记为 `planned`，`media_log_list` 也能按这 5 个状态筛选。

改动日志（`media_log_changes`）从装上这一版才开始记，**不回填**之前的任何历史；只保留
最近 500 条；同值重提不记。它是"我上次改了什么"的答案，不是事件溯源——
没有回放、没有撤销、没有逐字段历史。

两个非媒体模块都是**手工清单**，不是系统状态的镜子：

- 订阅是记账，不是账单系统。金额是整数小单位（分/美分），**没记金额不等于 0**；"续费了"只记
  你说的事实和你给的下一日期，**不按旧日期顺延**；取消自动续费不动已付的到期日；日期过去只说
  明登记日期已过，不推断已扣款或服务已失效。月均估算是本插件自己算的便利数字（年付按 12 个
  月摊，按量付费和未记金额单列），不是服务方的账。列表日期窗口按下次续费日筛选，
  尚未提供按到期日筛选。
- 软件清单的价值在"为什么装"。`software_list` 的 `text` 会连用途一起搜——"以前处理字幕用的
  是什么"答案在用途里，不在名字里。停用保留用途和备注。清单**只反映你记下来的内容，不代表
  本机装了什么**，也从不扫描、安装或卸载。

**只有 `media_log_mark` 能按标题直接改。**另外两个模块的更新必须按 UUID——名字不是唯一键
（一个服务名可以有多条订阅，一个工具名可以装过不同版本）。
这两个模块的 `_list` 都返回 revision，所以流程是 `_list` → `_mark` 两次，不需要再 `_get`。

日期只由说得清它的那个状态补：进入 `in_progress` 补 `started_at`，进入 `completed` 补
`completed_at`，`paused`/`dropped` 两个都不动。"什么时候开始看的"没法从"看完了"推出来，
所以缺着比造假好；已有日期一律保留，重看不改写历史。

已知边界：归档一条记录**不会**释放它的标题——`classifyCandidates` 对"仅归档的同名"也返回
ambiguous 挡住新建，所以归档重复录入之后仍然不能重建同名条目。要真删得先导出再手工处理库。
