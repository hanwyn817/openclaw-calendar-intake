# OpenClaw Calendar Intake

这是一个面向 OpenClaw 的日历插件，用来把你从邮件、微信、IM 等渠道收到的原始会议通知，直接解析并写入 Google Calendar。

目标工作流：

- 用户把原始通知直接发给 OpenClaw
- 可以直接说 `添加日程`、`帮我加到日历`、`把这段通知加到日历`
- OpenClaw 对话层先抽取标题、地点、备注和最终结构化时间字段
- 插件只负责校验结构化事件、确认冻结、去重、冲突检查和创建
- 高置信度时直接创建日程，低置信度时只追问一个最短问题
- 支持查看日程、查找候选事项、删除事项
- 创建前会检查疑似重复和时间冲突，删除前默认只在精确匹配时自动删除

## 安装

安装前提：

- OpenClaw CLI 版本不低于 `2026.3.0`
- Node.js 版本不低于 `22`

### 方式一：一步安装并初始化

推荐在 OpenClaw 所在机器上直接用 Git 安装：

```bash
git clone https://github.com/hanwyn817/openclaw-calendar-intake /opt/openclaw-calendar-intake
cd /opt/openclaw-calendar-intake
npm install
npm run build
openclaw plugins install -l /opt/openclaw-calendar-intake
openclaw calendar-intake setup
openclaw gateway restart
```

这种方式的特点是：

- 不依赖 npm registry 发布
- 插件直接从 Git 工作树本地目录加载
- 后续更新只需要 `git pull + npm install + npm run build + openclaw gateway restart`

### 方式二：在仓库内使用安装脚本

如果你已经把仓库 clone 到本机，也可以在仓库根目录执行：

```bash
npm install
npm run build
node dist/install.js install
```

如果你希望 setup 全程接受默认值，可使用：

```bash
node dist/install.js install --yes
```

如果你希望安装完成后顺手重启网关：

```bash
node dist/install.js install --yes --restart
```

这个包装命令会依次执行：

1. `openclaw plugins install -l <repo-root>`
2. `openclaw calendar-intake setup`
3. 提示或执行 `openclaw gateway restart`

脚本会优先把当前工作目录视为插件仓库根目录；如果当前目录不是仓库根目录，则回退到脚本文件所在包目录的上一级。

如果你想直接使用 OpenClaw 原生命令，也可以在已构建好的本地仓库目录执行：

```bash
openclaw plugins install -l /opt/openclaw-calendar-intake
openclaw calendar-intake setup
openclaw gateway restart
```

## 更新

后续更新插件的推荐方式：

```bash
cd /opt/openclaw-calendar-intake
git pull
npm install
npm run build
openclaw gateway restart
```

`openclaw plugins update` 不再作为默认更新路径；Git 本地安装的更新责任由仓库自身的 `git pull + build + restart` 负责。

## 首次初始化

安装后运行：

```bash
openclaw calendar-intake setup
```

初始化向导的默认值如下：

- `credentialsPath`: `~/.openclaw/secrets/google-calendar-credentials.json`
- `tokenPath`: `~/.openclaw/secrets/google-calendar-token.json`
- `calendarId`: `primary`
- `timezone`: `Asia/Shanghai`
- `lookaheadDays`: `30`
- `lookbackDays`: `7`
- `autoDeleteMode`: `exact_only`
- `dedupeWindowMinutes`: `30`

所有问题都支持直接回车接受默认值。

如果你想无交互直接写入默认配置：

```bash
openclaw calendar-intake setup --yes
```

## 准备 OAuth 凭据文件

在执行 `calendar_intake_auth_init` 之前，先准备 Google OAuth Desktop app 的 `credentials.json`。

### 第一步：在 Google Cloud Console 创建客户端

1. 打开 Google Cloud Console，并确认当前项目已启用 Google Calendar API。
2. 进入 `Google Auth Platform`。
3. 如果系统先要求创建“品牌信息”或“OAuth 同意屏幕”，按向导完成即可。
   如果只是你自己使用，通常选择“外部”即可。
4. 进入 `客户端`，点击“创建客户端”。
5. `应用类型` 选择“桌面应用（Desktop app）”。
6. 创建完成后下载 JSON 文件。

注意：

- 本项目要求的是 OAuth Desktop app 客户端，不是 service account。
- 下载下来的 JSON 文件里应包含 `installed` 和 `redirect_uris` 字段。

### 第二步：重命名并放到 credentialsPath

推荐直接使用默认路径：

```bash
~/.openclaw/secrets/google-calendar-credentials.json
```

如果你在当前机器上操作，可以直接重命名并移动：

```bash
mkdir -p ~/.openclaw/secrets
mv ~/Downloads/credentials.json ~/.openclaw/secrets/google-calendar-credentials.json
chmod 600 ~/.openclaw/secrets/google-calendar-credentials.json
```

如果下载后的文件名不是 `credentials.json`，把它重命名为 `google-calendar-credentials.json` 再放到上述路径即可。

如果你不想用默认路径，也可以在 `openclaw calendar-intake setup` 时把实际绝对路径填给 `credentialsPath`。

### 第三步：如果 OpenClaw 跑在 VPS 上，上传到 VPS

`credentialsPath` 是 OpenClaw 运行机器上的本地文件路径。

这意味着：

- 如果 OpenClaw 跑在你的本机，文件就放在本机
- 如果 OpenClaw 跑在 VPS，文件必须上传到 VPS，对话里授权时读取的也是 VPS 上的文件

示例：

```bash
scp ~/Downloads/credentials.json user@your-vps:~/.openclaw/secrets/google-calendar-credentials.json
ssh user@your-vps 'chmod 600 ~/.openclaw/secrets/google-calendar-credentials.json'
```

如果目标目录还不存在，可以先在 VPS 上创建：

```bash
ssh user@your-vps 'mkdir -p ~/.openclaw/secrets && chmod 700 ~/.openclaw/secrets'
```

## Google OAuth 授权

首次 setup 完成后，还需要做一次 Google OAuth 授权。

注意：

- `setup` 完成只表示基础配置已写入
- 插件配置里的 `tokenReady` 表示本地 token 文件已保存且格式可读
- 插件配置里的 `authReady` 会作为技能加载开关，只在目标 `calendarId` 已验证可访问后才会写成 `true`
- 建议每次授权完成后立刻执行一次 `openclaw calendar-intake doctor`，让插件继续校验目标 `calendarId` 是否真实可访问
- 也可以在 OpenClaw 对话中调用 `calendar_intake_auth_status` 查看当前授权状态

### 第一步：生成授权链接

在 OpenClaw 对话中调用：

- `calendar_intake_auth_init`

它会返回一个 Google 授权链接。

### 第二步：交换 token

1. 在本地浏览器打开授权链接
2. 完成 Google 授权
3. 复制回调 URL 中的 `code` 参数，或直接复制整段回调 URL
4. 在 OpenClaw 对话中调用：

- `calendar_intake_auth_exchange`

并把 `code` 或完整回调 URL 作为参数传入

成功后，插件会把 token 保存到 `tokenPath`。
同时插件配置里的 `tokenReady` 会被写成 `true`，而 `authReady` 会保持为 `false`，直到 `doctor` / `calendar_intake_auth_status` 验证目标日历真实可访问。

### 第三步：执行健康检查

```bash
openclaw calendar-intake doctor
```

或者在 OpenClaw 对话中调用：

- `calendar_intake_auth_status`

如果输出里 `authReady: true`，说明插件已经可以安全加载技能。

## 配置项

- `configured`：是否已完成首次 setup 初始化
- `tokenReady`：本地 token 文件是否已存在且格式可读
- `authReady`：插件当前用于控制技能加载的授权状态位；只有目标日历真实可访问时才会写成 `true`
- `calendarId`：目标 Google Calendar ID，通常用 `primary`
- `timezone`：默认时区，建议固定为 `Asia/Shanghai`
- `credentialsPath`：Google OAuth 客户端凭据文件绝对路径
- `tokenPath`：Google OAuth token 保存路径
- `lookaheadDays`：删除/查找时向未来搜索的天数
- `lookbackDays`：删除/查找时向过去搜索的天数
- `autoDeleteMode`：自动删除策略，默认 `exact_only`
- `dedupeWindowMinutes`：创建前识别重复事项的时间窗口

插件技能会在 `configured=true` 且 `authReady=true` 后加载。当前实现里，`auth_exchange` 只负责保存 token 并把 `tokenReady` 设为 `true`；`doctor` / `calendar_intake_auth_status` 会继续根据目标日历是否可访问来更新 `authReady`。

## 使用方式

### 添加日程

把原始通知直接贴给 OpenClaw，可以在最前面加一句 `添加日程`，也可以用更自然的话说“帮我加到日历”。对话层模型会先抽取结构化字段，再调用插件工具创建。

创建工具 `calendar_intake_create_event` 期望对话层直接提供：

- `sourceText`
- `title`
- `allDay`
- `start`
- `end`
- 可选：`location`、`description`、`confidence`、`issues`

时间字段约定：

- 定时事件：`start/end` 使用带时区偏移的 RFC3339，例如 `2026-03-28T15:00:00+08:00`
- 全天事件：`start/end` 使用 `YYYY-MM-DD`，其中 `end` 为 Google Calendar 的 exclusive end date

示例：

```text
添加日程

主题：供应商会议
时间：明天下午3点到4点
地点：腾讯会议
备注：讨论审计安排
```

也可以直接粘贴非结构化原文，例如邮件通知、群消息、会议邀请等。插件会把原始通知完整保存在 `sourceText`，并写入 Google Calendar 的 description 字段。

创建前的行为：

- 会回显已校验的最终时间，例如 `2026-03-28 15:00 - 16:00 (Asia/Shanghai)`
- 如果对话层给出的 `confidence` 缺失或偏低，或 `issues` 非空，不会直接创建
- 会检查同日近似标题的疑似重复事项
- 会检查时间冲突
- 用户确认后的正式创建只会复用预览快照，不会再次从确认回复重新理解原文

### 查看日程

支持以下自然语言触发：

```text
查看今日日程
查看明日日程
查看本周日程
查看下周日程
查看本月日程
查看 4 月 1 日日程
查看 下周三到下周五的日程
```

### 删除日程

示例：

```text
删除日程 供应商会议 明天下午3点
```

删除流程规则：

- 删除工具支持直接接收自然语言查询，内部会先搜索候选事项
- 默认策略 `exact_only` 下，标题必须精确匹配；如果查询里带了日期/时间，还要求日期/时间也足够精确
- 如果查询里没有日期/时间，但标题精确匹配且只命中一个高分候选，当前实现也可能直接自动删除
- 如果有多个候选，会先展示 `choiceId` 编号，并在结构化结果里附带每个候选自己的 `deletePreviewToken`
- 删除确认优先使用 `deletePreviewToken`，避免第二次确认时因重新检索导致候选漂移；`choiceId` 仅保留兼容路径

## 默认时间语义

插件仍然按中国北京时间 `Asia/Shanghai` 解释如下自然语言查询：

- `明天下午3点`
- `下周一 10:30`
- `本周五晚上7点`

这部分只用于查看、查找、删除等自然语言查询；创建链路不再把自然语言时间隐式解析后写入 Google Calendar。即使 OpenClaw 跑在海外 VPS 上，只要插件配置仍为 `Asia/Shanghai`，这些查询时间也会按北京时间解释，而不是按服务器本地时区解释。

## 本地验证

```bash
npm test
npm run build
```

## 已知边界

- 当前版本只支持单个 Google Calendar 写入
- 不做双向同步
- 不处理复杂重复日程的完整编辑能力
- Telegram 到 OpenClaw 的消息转发链路需要你自己的 OpenClaw 部署侧已经具备
- 默认运维方式已经切换为 Git 本地目录安装，而不是依赖 npm registry 分发
