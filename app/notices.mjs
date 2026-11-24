// 通知分类：服务点迁移、停办、原公告复行、错字更正以不同通知标识出现。
// 分类结合识别码约定与正文关键词；关键词按配置可调，识别码只作辅助。

const ID_PATTERNS = {
  suspension: /^U\d+$/, // 紧急通知标识（演练数据中 U4 为停办）
};

export function classifyNotice(paragraph, noticeKeywords) {
  // 联系段不属于任何服务变更通知，保持 contact 类型不被关键词覆盖。
  if (paragraph.kind === 'contact') return 'contact';
  const text = paragraph.text ?? '';
  const hit = (words) => words.some((word) => text.includes(word));

  if (hit(noticeKeywords.suspension) || ID_PATTERNS.suspension.test(paragraph.id)) {
    return 'suspension';
  }
  if (hit(noticeKeywords.resumption)) return 'resumption';
  if (hit(noticeKeywords.migration)) return 'migration';
  if (hit(noticeKeywords.correction)) return 'correction';
  return 'regular';
}

export function classifyAll(paragraphs, noticeKeywords) {
  return paragraphs.map((paragraph) => ({
    ...paragraph,
    noticeType: classifyNotice(paragraph, noticeKeywords),
  }));
}

// 已生效的停办段落涉及哪些服务点。
export function activeSuspendedSites(paragraphs, clock) {
  const sites = new Set();
  for (const paragraph of paragraphs) {
    if (paragraph.noticeType !== 'suspension') continue;
    const noTime = paragraph.effectiveAt === null || paragraph.effectiveAt === undefined;
    const due = noTime || paragraph.effectiveAt.getTime() <= clock.now.getTime();
    if (due && paragraph.site) sites.add(paragraph.site);
  }
  return sites;
}

// 同一原文版号家族（例如 H1/H2/H3 同属 H 段）的最新版号。
export function versionFamily(version) {
  const match = String(version).match(/^([A-Za-z]+)\d+$/);
  return match ? match[1] : String(version);
}
