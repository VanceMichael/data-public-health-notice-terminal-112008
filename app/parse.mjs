// 解析市级公告页与地方语言页。
// 输入是浏览器层从 DOM 取出的纯文本段落，解析逻辑不依赖浏览器，便于单测。

// 段落首段是公告/通知识别码，例如 W6-H、W6-N、U4。
function splitParagraph(raw) {
  const parts = raw.split('，').map((part) => part.trim()).filter(Boolean);
  return { id: parts[0] ?? '', parts, raw };
}

// 从段落文字里找出适用的服务点；“全部服务点”表示通用段落。
function resolveScope(parts, sites) {
  if (parts.some((part) => part.includes('全部服务点'))) {
    return { site: null, allSites: true };
  }
  const site = sites.find((name) => parts.some((part) => part.includes(name)));
  return { site: site ?? null, allSites: false };
}

// 解析一条市级公告段落。
export function parseBulletinParagraph(raw, { sites, year }) {
  const { id, parts } = splitParagraph(raw);
  const contactPart = parts.find((part) => part.startsWith('联系段'));
  const sourcePart = parts.find((part) => part.startsWith('原文'));
  const { site, allSites } = resolveScope(parts, sites);

  const base = {
    id,
    site,
    allSites,
    text: raw,
    effectiveAt: parseEffectiveTime(raw, year),
  };

  if (contactPart) {
    return { ...base, kind: 'contact', refVersion: contactPart.replace('联系段', '').trim() };
  }
  return {
    ...base,
    kind: 'service',
    refVersion: sourcePart ? sourcePart.replace('原文', '').trim() : null,
  };
}

function parseEffectiveTime(raw, year) {
  const match = raw.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const [, month, day, hour, minute] = match;
  const padded = (value) => String(value).padStart(2, '0');
  return new Date(`${year}-${padded(month)}-${padded(day)}T${padded(hour)}:${padded(minute)}:00+08:00`);
}

export function parseBulletin(paragraphs, context) {
  return paragraphs.map((raw) => parseBulletinParagraph(raw, context));
}

// 解析一条语言页段落：
// “W6-H，H3，已审。 North Bridge desk closed today...”
// “W6-H，H2，待审。 New North Bridge desk from noon.”
export function parseTranslationParagraph(raw) {
  const headMatch = raw.match(/^([A-Za-z0-9-]+)，([A-Za-z0-9]+)，(已审|待审)。?\s*(.*)$/);
  if (!headMatch) return null;
  const [, id, refVersion, statusText, text] = headMatch;
  return {
    id,
    refVersion,
    status: statusText === '已审' ? 'reviewed' : 'pending',
    text: text.trim(),
    raw,
  };
}

export function parseTranslationPage(paragraphs) {
  return paragraphs.map(parseTranslationParagraph).filter(Boolean);
}

// 从待办页段落解析换页单，例如：
// “P41，N1，H1，英语，待执行。”
// “P41，N1，H1，英语，设备已接收未显示。”
// “P55，N1，H3，英语，已显示。”
// “P41，撤销已确认。”
export function parsePendingLine(raw, localeLabels) {
  const cancelMatch = raw.match(/^(P\d+)，撤销已确认/);
  if (cancelMatch) {
    return { operationId: cancelMatch[1], cancelled: true, confirmed: true, raw };
  }
  const match = raw.match(/^(P\d+)，([A-Za-z0-9]+)，([A-Za-z0-9]+)，([^，]+)，(.+?)。?$/);
  if (!match) return null;
  const [, operationId, terminal, version, localeLabel, stateText] = match;
  const state = stateText.includes('已显示')
    ? 'displayed'
    : stateText.includes('已接收')
      ? 'received'
      : 'pending';
  return {
    operationId,
    terminal,
    version,
    locale: localeLabels[localeLabel] ?? localeLabel,
    state,
    cancelled: stateText.includes('撤销'),
    confirmed: state === 'displayed',
    raw,
  };
}

// 解析设备组页上的一行设备说明，例如：
// “N1 在线，当前显示旧版 H1” / “N1 离线，挂起旧换页 P41”
// “N1 已重连，待办仍有 P41” / “N1 已显示 H3，N2 等待换页确认”
// 能力说明行（“N1 仅支持单页换页，N2 支持整组启用”）不是状态行，返回 null。
export function parseDeviceLine(raw) {
  const idMatch = raw.match(/^(N\d+|S\d+)/);
  if (!idMatch) return null;
  const isStateLine = /在线|离线|重连|已显示|等待换页确认/.test(raw);
  if (!isStateLine) return null;
  const terminal = idMatch[1];
  return {
    terminal,
    offline: raw.includes('离线'),
    reconnected: raw.includes('重连'),
    displayedVersion: extractVersion(raw, /显示(?:旧版)?\s*([A-Za-z0-9]+)/),
    pendingOperation: raw.match(/(?:挂起旧换页|待办仍有)\s*(P\d+)/)?.[1] ?? null,
    awaitingConfirmation: raw.includes('等待换页确认'),
    raw,
  };
}

function extractVersion(raw, pattern) {
  return raw.match(pattern)?.[1] ?? null;
}

// 从回执/预览页文本里提取换页单号（P 开头），登记后用来和待办回执对账。
export function extractOperationId(text) {
  return text.match(/\bP\d+\b/)?.[0] ?? null;
}
