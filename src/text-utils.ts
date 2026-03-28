/**
 * 规范化换行和部分标点，降低后续解析难度。
 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[：]/g, ":")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .trim();
}

/**
 * 去掉消息前导命令词，例如“添加日程”。
 */
export function stripLeadingCommand(input: string): string {
  return input.replace(/^\s*(?:添加日程|把这段通知加到日历|帮我加到日历|加入日历|记到日历)\s*/u, "").trim();
}

/**
 * 返回第一条非空文本行。
 */
export function firstNonEmptyLine(input: string): string | undefined {
  return input
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
}

export function extractUrls(input: string): string[] {
  return Array.from(input.matchAll(/https?:\/\/[^\s)>]+/g)).map((match) => match[0]);
}

/**
 * 提取带标签前缀的值，例如“主题:xxx”。
 * 匹配时不区分大小写，并允许标签与值之间存在空白。
 */
export function extractLabeledValue(text: string, labels: string[]): string | undefined {
  const pattern = new RegExp(
    `^(?:${labels.map(escapeRegExp).join("|")})\\s*:\\s*(.+)$`,
    "imu"
  );
  const match = text.match(pattern);
  return match?.[1]?.trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
