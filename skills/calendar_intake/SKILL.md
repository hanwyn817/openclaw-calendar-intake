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
1. 先从原文抽取结构化字段，再调用 `calendar_intake_create_event`，必须传：
   - `sourceText=用户原始通知`
   - `title`
   - `allDay`
   - `start`
   - `end`
   - 可选：`location`、`description`、`confidence`、`issues`
   - `dryRun=true`
2. 不要把原始通知直接塞给工具让它自己理解；工具现在只负责校验结构化字段、去重、冲突检查和创建。
3. 定时事件的 `start/end` 必须是带时区偏移的 RFC3339，例如 `2026-03-31T15:30:00+08:00`；全天事件的 `start/end` 必须是 `YYYY-MM-DD`，且 `end` 要使用 Google Calendar 的 exclusive end date 语义。
4. 如果返回结果中的 `shouldAutoCreate=true`，优先把 dryRun 返回的 `previewToken` 传回 `calendar_intake_create_event` 正式创建。
5. 如果你发现抽取结果和原文明显不一致，即使 `shouldAutoCreate=true`，也要先展示差异并确认，再用 `previewToken` 加显式覆盖参数（如 `titleOverride`、`locationOverride`、`startOverride`、`endOverride`、`allDayOverride`）创建。
6. 如果 `shouldAutoCreate=false`，简要展示解析结果，并只针对缺失字段或 `issues` 追问一个最短问题。
7. 缺字段时直接追问最终结构化结果，不要再把自然语言时间交给插件兜底解析。
8. 对时间纠正不要问含糊的是/否题。要直接确认最终 `start/end`，例如“按 `start=2026-03-31T15:30:00+08:00`、`end=2026-03-31T16:00:00+08:00` 创建，对吗？”
9. 用户确认继续创建时，必须复用 dryRun 返回的 `previewToken`；不要把用户的“对 / 是 / 没问题”回复当作新一轮抽取输入。需要改字段时，显式传 override 参数。
10. 原始会议通知需要完整传入 `sourceText`，并写入日程 description。

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
