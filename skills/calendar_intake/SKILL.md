---
name: calendar_intake
description: 解析粘贴的会议通知，并在 Google Calendar 中添加、查看、查找和删除日程。
metadata: {"openclaw":{"requires":{"config":["plugins.entries.openclaw-calendar-intake.config.configured","plugins.entries.openclaw-calendar-intake.config.authReady"]}}}
---

# 日历收件箱

当用户要求添加、查看、查找或删除日程时，使用这个技能。

## 触发语句

主要触发词：
- 添加日程
- 帮我加到日历
- 把这段通知加到日历
- 查看今日日程
- 查看明日日程
- 查看本周日程
- 查看下周日程
- 查看本月日程
- 删除日程
- 把明天下午那个会删掉

## 规则

### 1. 添加日程

如果用户要求把会议通知加入日历，或消息明显是在贴会议通知并要求“加到日历”：
1. 先调用 `calendar_intake_create_from_text`，并传入 `dryRun=true`。
2. 如果返回结果中的 `shouldAutoCreate=true`，优先把 dryRun 返回的 `previewToken` 传回 `calendar_intake_create_from_text` 正式创建；只有在没有 token 时才回退到同样的原始文本。
3. 如果 `shouldAutoCreate=false`，简要展示解析结果，并只针对缺失字段追问一个最短问题。
4. 用户确认继续创建时，必须复用 dryRun 返回的 `previewToken`；不要把用户的“对 / 是 / 没问题”回复当作 `text` 再解析。
5. 除了去掉前导命令词外，不要改写用户原始通知。

### 2. 查看日程

- `查看今日日程`：调用 `calendar_intake_list_events`，参数 `range=today`
- `查看明日日程`：调用 `calendar_intake_list_events`，参数 `range=tomorrow`
- `查看本周日程`：调用 `calendar_intake_list_events`，参数 `range=week`
- `查看下周日程`：调用 `calendar_intake_list_events`，参数 `range=next_week`
- `查看本月日程`：调用 `calendar_intake_list_events`，参数 `range=month`
- 如果用户说“查看某天/某个时间段的日程”，调用 `calendar_intake_list_events` 并传入 `queryText`

### 3. 删除日程

如果用户要求删除某个日程，哪怕没有使用精确前缀 `删除日程`：
1. 直接调用 `calendar_intake_delete_event`，优先传 `queryText=用户原话`。
2. 如果工具直接删除成功，直接告诉用户结果。
3. 如果返回多个候选项，先展示 `choiceId` 编号列表，再让用户选择。
4. 用户选择后，再次调用 `calendar_intake_delete_event`，传入相同 `queryText` 和对应 `choiceId`。

## 备注

- 默认时区是 `Asia/Shanghai`。
- 原始会议通知需要完整保存在日程 description 中。
