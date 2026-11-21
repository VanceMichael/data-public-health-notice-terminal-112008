import { createHash } from 'node:crypto';

// 公告解析与合并。
//
// 市级公告的段落形如：
//   W6-N，联系段 R1，全部服务点，办公时间联系服务台分机 702。
//   W6-H，原文 H1，北桥点，12月8日 09:00 至 16:00 开放。
//   U4，原文 H3，北桥点，12月8日 12:10 生效，北桥点当天停办，请联系分机 702。
// 字段依次为：段号、原文版号、适用点位、正文。日期按东八区处理。
//
// 通知标识前缀表示处理方式（这是演练来源的业务约定）：
//   W  常规换版（含迁移）
//   U  紧急停办
//   R  原公告复行
//   C  错字校正（正文变化、适用范围不变，但旧译文不得沿用）

export const ZONE = 'Asia/Shanghai';
export const CURRENT_YEAR = 2026;

const NOTICE_KIND_BY_PREFIX = {
  W: 'revision',
  U: 'closure',
  R: 'reopen',
  C: 'correction',
};

const VERSION = /^(?:原文|联系段)\s*([A-Z]{1,3}\d+)$/;

export function decodeEntities(value) {
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

export function noticeKind(id) {
  const match = /^([A-Z]+)/.exec(id ?? '');
  return (match && NOTICE_KIND_BY_PREFIX[match[1]]) || 'revision';
}

function paragraphsOf(html) {
  return [...String(html).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => decodeEntities(match[1]));
}

function headingOf(html, fallback = '') {
  const match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return match ? decodeEntities(match[1]) : fallback;
}

function langOf(html) {
  const match = /<html\b[^>]*\blang="([^"]+)"/i.exec(html);
  return match ? match[1] : 'zh-CN';
}

function publishedAtOf(html) {
  const text = decodeEntities(html);
  const match =
    /(?:发布(?:时间|日期|于)?|更新(?:时间|日期|于)?)[：:\s]*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:\s*\d{1,2}:\d{2})?)/.exec(
      text,
    );
  if (!match) return null;
  return parseLocalDateTime(match[1]);
}

function parseLocalDateTime(value) {
  const match = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:\s*(\d{1,2}):(\d{2}))?/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour = '0', minute = '0'] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute))).toISOString();
}

/** 解析“12月8日 12:10 生效 / 12:00 起”一类生效时刻，忽略“09:00 至 16:00 开放”。 */
export function effectiveAtFromText(text, year = CURRENT_YEAR) {
  const match = /(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})\s*(?:起|生效)/.exec(text ?? '');
  if (!match) return null;
  const [, month, day, hour, minute] = match;
  // 东八区时间换算成 UTC：12月8日 12:10 +08:00 == 2026-12-08T04:10:00.000Z。
  return new Date(Date.UTC(year, Number(month) - 1, Number(day), Number(hour) - 8, Number(minute))).toISOString();
}

export function parseScope(scopeText) {
  const clean = String(scopeText ?? '')
    .replace(/^适用(?:范围|点位)?[：:\s]*/, '')
    .trim();
  if (!clean || /全部|所有/.test(clean)) return { all: true, sites: [] };
  const sites = clean
    .split(/[、,，/／]/)
    .map((site) => site.trim())
    .filter(Boolean);
  return { all: sites.length === 0, sites };
}

/** 解析一段公告卡片；不是“段号，版号，范围，正文”结构时返回 freeform 段落。 */
export function parseParagraph(text, index = 0) {
  const clean = decodeEntities(text);
  if (!clean) return null;
  const parts = clean.split(/[，,]/).map((part) => part.trim());
  if (parts.length < 4) {
    return { kind: 'freeform', index, id: `free-${index}`, text: clean, raw: clean };
  }
  const [id, versionPart, scopePart, ...rest] = parts;
  const versionMatch = VERSION.exec(versionPart);
  const version = versionMatch ? versionMatch[1] : versionPart.trim();
  const body = rest.join('，').trim();
  return {
    kind: 'paragraph',
    index,
    id,
    noticeKind: noticeKind(id),
    version,
    scope: parseScope(scopePart),
    scopeText: parseScope(scopePart).all ? '全部服务点' : parseScope(scopePart).sites.join('、'),
    text: body,
    effectiveAt: effectiveAtFromText(body),
    raw: clean,
  };
}

export function parseBulletin(html, { noticeId = null } = {}) {
  const paragraphs = paragraphsOf(html);
  const blocks = paragraphs.map((text, index) => parseParagraph(text, index)).filter(Boolean);
  return {
    noticeId,
    title: headingOf(html),
    url: null,
    lang: langOf(html),
    publishedAt: publishedAtOf(html),
    blocks,
  };
}

/** 解析语言页。每段列出原文段号、所译版号与审译状态。 */
export function parseTranslation(html) {
  return {
    title: headingOf(html),
    lang: langOf(html),
    publishedAt: publishedAtOf(html),
    entries: paragraphsOf(html)
      .map((text) => {
        const parts = text.split(/[，,]/).map((part) => part.trim());
        if (parts.length < 3) return null;
        const [sourceId, version, ...rest] = parts;
        const statusPart = rest.join('，');
        const status = /^(已审|审校通过|审译完成|已翻译)/.test(statusPart)
          ? 'approved'
          : /^(待审|未审|草稿|待译)/.test(statusPart)
            ? 'draft'
            : 'unknown';
        const translation = statusPart
          .replace(/^(已审|审校通过|审译完成|已翻译|待审|未审|草稿|待译)\s*[。.]?\s*/, '')
          .trim();
        return { sourceId, version, status, translation, raw: text };
      })
      .filter(Boolean),
  };
}

/** 该段落是否适用于某点位。 */
export function coversSite(block, site) {
  if (!block || !site) return false;
  if (block.scope.all) return true;
  return block.scope.sites.includes(site);
}

/**
 * 同一“段落主题”只保留最新版。
 *
 * 公告里的版号（H1、H2、H3）才是一段内容的主线；段落开头的 W6-H / U4 等是每次
 * 通知的识别码，会变。因此按“版号系列 + 适用范围”归并，例如北桥点的 H1 → H2 →
 * H3 依次替代，只发布最新一版。保留该系列首次出现的位置，维持公告原有顺序。
 */
export function latestRevisions(blocks) {
  const winner = new Map();
  for (const block of blocks) {
    if (block.kind !== 'paragraph') continue;
    const key = revisionKey(block);
    const current = winner.get(key);
    if (!current || versionNumber(block.version) >= versionNumber(current.version)) {
      winner.set(key, block);
    }
  }
  // 在该系列首次出现的位置放最新一版，保持公告的阅读顺序（联系段、点位段）。
  const emitted = new Set();
  const result = [];
  for (const block of blocks) {
    if (block.kind !== 'paragraph') {
      result.push(block);
      continue;
    }
    const key = revisionKey(block);
    if (emitted.has(key)) continue;
    emitted.add(key);
    result.push(winner.get(key));
  }
  return result;
}

function revisionKey(block) {
  const series = /^([A-Z]{1,3})\d*$/.exec(String(block.version ?? ''))?.[1] ?? String(block.version ?? '');
  return `${series}\u0000${block.scopeText}`;
}

function versionNumber(version) {
  const match = /(\d+)$/.exec(String(version ?? ''));
  return match ? Number(match[1]) : 0;
}

export function isContactBlock(block) {
  return /联系|分机|服务台|contact|extension/i.test(block.text ?? block.content ?? '');
}

/** 段落是否在描述具体的服务地点与时段（停办后这类内容不许再以有效服务出现）。 */
export function isServiceDetails(block) {
  const text = block?.text ?? block?.content ?? '';
  return /开放|服务时段|办公时段|\d{1,2}\s*[:：]\s*\d{2}/.test(text);
}

export function isLive(block, now) {
  if (!block.effectiveAt) return true;
  return new Date(block.effectiveAt).getTime() <= new Date(now).getTime();
}

export function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export function editionKeyOf(bulletin) {
  return hash(
    JSON.stringify(
      bulletin.blocks.map((block) => [
        block.id,
        block.version,
        block.scopeText,
        block.text,
        block.noticeKind,
        block.effectiveAt,
      ]),
    ),
  );
}

/**
 * 已审译文的快照缓存。
 *
 * 语言页可能只列出本轮改动过的段落，因此未改动的段落要从早先抓取并绑定到
 * “原文文字 + 适用范围”的已审译文里沿用。缓存只收已审条目；待审译文永不入库。
 */
export class TranslationCache {
  constructor(entries = []) {
    this.entries = entries.map((entry) => ({ ...entry }));
    // 本轮抓取更新过的键。其余条目就是“沿用旧译文”，供值班记录区分。
    this.refreshed = new Set();
  }

  static fromJSON(value) {
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    return new TranslationCache(data?.entries ?? []);
  }

  toJSON() {
    return { entries: this.entries };
  }

  /** 每次运行开始时调用：之后的 ingest 会被标记为本轮刷新。 */
  beginSession() {
    this.refreshed.clear();
    return this;
  }

  /**
   * 把语言页条目绑定到同版号的公告段落。只有唯一匹配才收下，避免把不同范围的
   * 同版号译文混在一起。语言页的发布时刻只作为出处记录。
   */
  ingest(bulletin, translation, retrievedAt = new Date().toISOString()) {
    if (!translation) return this;
    for (const entry of translation.entries) {
      if (entry.status !== 'approved') {
        // 同一版号被语言页标为待审/未审时，撤掉此前收下的已审快照，绝不沿用。
        const candidates = bulletin.blocks.filter(
          (block) => block.kind === 'paragraph' && block.version === entry.version,
        );
        for (const block of candidates) {
          this.entries = this.entries.filter(
            (item) => !(item.version === entry.version && item.scopeText === block.scopeText),
          );
        }
        continue;
      }
      const candidates = bulletin.blocks.filter(
        (block) => block.kind === 'paragraph' && block.version === entry.version,
      );
      const block = candidates.length === 1 ? candidates[0] : this.pickCandidate(candidates, entry);
      if (!block) continue;
      const record = {
        version: entry.version,
        sourceId: block.id,
        sourceText: block.text,
        scopeText: block.scopeText,
        translation: entry.translation,
        status: entry.status,
        translationTitle: translation.title,
        translationPublishedAt: translation.publishedAt ?? null,
        retrievedAt,
      };
      const key = `${record.version}\u0000${record.scopeText}`;
      const existing = this.entries.findIndex(
        (item) => item.version === record.version && item.scopeText === record.scopeText,
      );
      if (existing === -1) this.entries.push(record);
      else this.entries[existing] = { ...this.entries[existing], ...record };
      this.refreshed.add(key);
    }
    return this;
  }

  pickCandidate(candidates, entry) {
    if (candidates.length === 0) return null;
    // 段号相同者优先；仍不唯一则不收，留给人工核对。
    const byId = candidates.filter((block) => block.id === entry.sourceId);
    return byId.length === 1 ? byId[0] : null;
  }

  /**
   * 只在“原文未变且适用范围未变”时复用：版号、原文文字、适用范围三者全等。
   * 待审或未审条目不在缓存中，因此不可能被复用。
   */
  lookup(block) {
    const entry =
      this.entries.find(
        (item) =>
          item.status === 'approved' &&
          item.version === block.version &&
          item.sourceText === block.text &&
          item.scopeText === block.scopeText,
      ) ?? null;
    if (!entry) return null;
    // 本轮语言页没有重新列出该条目 => 沿用早先抓取的旧译文。
    return { ...entry, carried: !this.refreshed.has(`${entry.version}\u0000${entry.scopeText}`) };
  }

  approvedVersions() {
    return [...new Set(this.entries.map((entry) => entry.version))].sort();
  }
}

function closureActive(blocks, site, now) {
  const ordered = blocks
    .filter((block) => block.kind === 'paragraph' && isLive(block, now) && coversSite(block, site))
    .map((block, order) => ({ block, order }))
    .sort((left, right) => {
      const leftTime = left.block.effectiveAt ? Date.parse(left.block.effectiveAt) : -Infinity;
      const rightTime = right.block.effectiveAt ? Date.parse(right.block.effectiveAt) : -Infinity;
      return leftTime - rightTime || left.order - right.order;
    });
  let closed = false;
  for (const { block } of ordered) {
    if (block.noticeKind === 'closure') closed = true;
    else if (block.noticeKind === 'reopen') closed = false;
  }
  return closed;
}

/**
 * 组出某点位、某语言的待发布页面。
 *
 * - 只取适用于该点位且已到生效时刻的段落；
 * - 停办生效后撤下涉及该点位的地点和时间段落，但保留联系/停办信息；
 * - 译文只复用缓存中原文与范围均未变的已审条目；
 * - 译文待补时用配置的应急文字，没有配置则用官方原文暂代；
 * - 未审译文不会进入结果。
 */
export function composeEdition({
  bulletin,
  cache = new TranslationCache(),
  locale = 'zh',
  fallback = {},
  now = new Date(),
  site,
  sourceUrl = null,
}) {
  const at = now instanceof Date ? now : new Date(now);
  const liveBlocks = latestRevisions(
    bulletin.blocks.filter((block) => block.kind === 'paragraph' && isLive(block, at)),
  );
  const siteBlocks = liveBlocks.filter((block) => coversSite(block, site));
  const blocked = closureActive(bulletin.blocks, site, at);
  const kept = blocked
    ? siteBlocks.filter((block) => {
        // 停办/复行本身必须留下。
        if (block.noticeKind === 'closure' || block.noticeKind === 'reopen') return true;
        // 具体地点/时段段落在停办后一律撤下——哪怕句尾顺带写了联系电话，
        // 也不能让旧服务时间继续以有效服务出现。
        if (isServiceDetails(block)) return false;
        // 应急联系必须留下；适用于全部点位的通用段落（如服务台联系方式）仍有效。
        return isContactBlock(block) || block.scopeText === '全部服务点';
      })
    : siteBlocks;

  const blocks = kept.map((block) => {
    const cached = locale === 'zh' ? null : cache.lookup(block);
    const origin = locale === 'zh' ? 'source' : cached ? 'translation' : fallback[locale] ? 'fallback' : 'source';
    const content =
      origin === 'translation' ? cached.translation : origin === 'fallback' ? fallback[locale] : block.text;
    return {
      id: block.id,
      version: block.version,
      noticeKind: block.noticeKind,
      scopeText: block.scopeText,
      effectiveAt: block.effectiveAt,
      sourceText: block.text,
      content,
      origin,
      translationVersion: cached?.version ?? null,
      translationSourceId: cached?.sourceId ?? null,
      translationPublishedAt: cached?.translationPublishedAt ?? null,
      translationRetrievedAt: cached?.retrievedAt ?? null,
      translationCarried: cached?.carried ?? null,
      synthetic: false,
    };
  });

  // 最少保留一条可用的应急联系信息。
  if (blocked && !blocks.some((block) => isContactBlock(block))) {
    blocks.push({
      id: 'emergency-contact',
      version: null,
      noticeKind: 'emergency',
      scopeText: '全部服务点',
      sourceText: '',
      content: fallback[locale] ?? '服务信息调整中，请联系服务台。',
      origin: 'fallback',
      translationVersion: null,
      translationSourceId: null,
      synthetic: true,
    });
  }

  // 页面“版本”= 页面上所有来自官方公告的段落版号（含用应急文字暂代的段落）。
  // 联系段的 R1 等通用版号也算，用来判断设备/待办是不是当前版本。
  const versions = [
    ...new Set(
      blocks
        .filter((block) => !block.synthetic && block.version)
        .map((block) => block.version),
    ),
  ].sort();
  // 页面的“代表版本”：
  //   1. 有生效时刻的最新一段（停办/复行/迁移）最优先；
  //   2. 否则用本点位的具体段落（而非“全部服务点”的通用联系段）；
  //   3. 再否则取最后一段。
  const versionBlocks = blocks.filter((block) => !block.synthetic && block.version);
  const timed = versionBlocks
    .filter((block) => block.effectiveAt)
    .sort((left, right) => Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt));
  const markerBlock =
    timed[0] ??
    versionBlocks.find((block) => block.scopeText !== '全部服务点') ??
    versionBlocks.at(-1);
  const content = blocks.map((block) => block.content).join('\n');
  // 指纹覆盖版号与译文来源，而不只是显示文字：同样一句话可能来自不同版号，
  // 不能让“停办前的旧版”和“停办后的应急文字”撞成同一个指纹。
  const contentHash = hash(
    JSON.stringify({
      site,
      locale,
      blocked,
      blocks: blocks.map((block) => [
        block.id,
        block.version,
        block.noticeKind,
        block.origin,
        block.translationVersion,
        block.content,
      ]),
    }),
  );
  const fallbackInUse =
    blocks.some((block) => block.origin === 'fallback') || (blocked && blocks.every((block) => block.synthetic));

  return {
    site,
    locale,
    noticeId: bulletin.noticeId,
    noticeCode: bulletin.noticeId,
    title: bulletin.title,
    blocked,
    blocks,
    content,
    contentHash,
    versions: versions.length > 0 ? versions : markerBlock ? [markerBlock.version] : [],
    markerVersion: markerBlock?.version ?? null,
    fallbackInUse,
    source: {
      url: sourceUrl,
      noticeId: bulletin.noticeId,
      title: bulletin.title,
      publishedAt: bulletin.publishedAt ?? null,
      retrievedAt: at.toISOString(),
      editionKey: editionKeyOf(bulletin),
    },
    translations: blocks
      .filter((block) => block.origin === 'translation')
      .map((block) => ({
        version: block.translationVersion,
        sourceId: block.translationSourceId,
        publishedAt: block.translationPublishedAt,
        retrievedAt: block.translationRetrievedAt,
        carried: block.translationCarried,
      })),
  };
}

export function sameVersions(left = [], right = []) {
  return [...left].sort().join('|') === [...right].sort().join('|');
}