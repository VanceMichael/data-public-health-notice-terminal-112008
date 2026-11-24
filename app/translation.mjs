// 译文核对与页面合成。
// 铁律：只复用“原文未变且适用范围未变”的已审译文；待审译文绝不进入发布页；
// 译文缺口用配置的应急文字或官方原文暂代，并在记录中标注替代状态。

import { versionFamily } from './notices.mjs';

// 合并历次语言页快照。同一 (识别码, 原文版号) 以较新的已审条目覆盖。
export function mergeTranslationHistory(history, entries) {
  const map = new Map(history.map((entry) => [`${entry.id}|${entry.refVersion}`, entry]));
  for (const entry of entries) {
    const key = `${entry.id}|${entry.refVersion}`;
    const previous = map.get(key);
    if (!previous || (entry.status === 'reviewed' && previous.status !== 'reviewed')) {
      map.set(key, entry);
    }
  }
  return [...map.values()];
}

// 为一条公告段落查找可复用译文。
// 停办/迁移等通知段落（如 U4）沿用所替代服务段落（W6-H）的版号家族，
// 语言页把译文挂在服务段落识别码下，因此先按本段落 id 查，查不到再按同版号家族查。
export function findReviewedTranslation(history, paragraph, familyParagraphIds = []) {
  const wantedVersion = paragraph.refVersion;
  const acceptableIds = [paragraph.id, ...familyParagraphIds];
  const candidates = history.filter(
    (entry) => acceptableIds.includes(entry.id) && entry.refVersion === wantedVersion,
  );
  return candidates.find((entry) => entry.status === 'reviewed') ?? null;
}

// 单段核对：返回该语言下要上屏的文字块及来源凭据。
export function reconcileBlock({ paragraph, history, locale, desk, familyParagraphIds = [] }) {
  // 中文屏直接使用官方原文，原文本身就是已发布口径。
  if (locale === 'zh') {
    return {
      id: paragraph.id,
      refVersion: paragraph.refVersion,
      text: paragraph.text,
      status: 'source',
      translationStatus: 'not-required',
      noticeType: paragraph.noticeType,
    };
  }

  const reviewed = findReviewedTranslation(history, paragraph, familyParagraphIds);
  if (reviewed) {
    return {
      id: paragraph.id,
      refVersion: paragraph.refVersion,
      text: reviewed.text,
      status: 'reviewed',
      translationStatus: 'reviewed',
      translationParagraphId: reviewed.id,
      noticeType: paragraph.noticeType,
    };
  }

  // 待审译文存在时只记录缺口，绝不上屏（含同家族服务段落下的待审条目）。
  const acceptableIds = [paragraph.id, ...familyParagraphIds];
  const pending = history.some(
    (entry) => acceptableIds.includes(entry.id) && entry.refVersion === paragraph.refVersion
      && entry.status === 'pending',
  );

  // 译文待补：优先使用配置注明的应急文字，其次以官方原文暂代。
  const fallbackText = desk.fallback?.[locale];
  if (fallbackText) {
    return {
      id: paragraph.id,
      refVersion: paragraph.refVersion,
      text: fallbackText,
      status: 'fallback-config',
      translationStatus: pending ? 'pending-review' : 'missing',
      noticeType: paragraph.noticeType,
    };
  }
  return {
    id: paragraph.id,
    refVersion: paragraph.refVersion,
    text: paragraph.text,
    status: 'source-original',
    translationStatus: pending ? 'pending-review' : 'missing',
    noticeType: paragraph.noticeType,
  };
}

// 同一段落家族只保留当前最新且已生效的版号；新版尚未生效时继续显示旧版。
function latestEffectiveByFamily(paragraphs, clock) {
  const families = new Map();
  for (const paragraph of paragraphs) {
    if (paragraph.effectiveAt && paragraph.effectiveAt > clock.now) continue;
    const family = versionFamily(paragraph.refVersion ?? paragraph.id);
    const current = families.get(family);
    if (!current || compareVersion(paragraph.refVersion, current.refVersion) > 0) {
      families.set(family, paragraph);
    }
  }
  return [...families.values()];
}

function compareVersion(a, b) {
  const numOf = (value) => Number(String(value).match(/\d+$/)) || 0;
  return numOf(a) - numOf(b);
}

// 合成某服务点、某语言要显示的整页内容。
// suspendedSites：已生效停办的服务点集合。
export function composeSitePage({ site, locale, paragraphs, history, desk, clock }) {
  const suspended = activeSuspensionFor(site, paragraphs, clock);
  const blocks = [];

  // 通用联系段对全部服务点持续有效（停办期间仍可使用的常规段落）。
  const contacts = paragraphs.filter((paragraph) => paragraph.allSites && paragraph.kind === 'contact');
  for (const paragraph of contacts) {
    blocks.push(reconcileBlock({ paragraph, history, locale, desk }));
  }

  if (!suspended) {
    // 场所服务段：同家族只显示最新已生效版号；停办段在未生效前不预上屏。
    // 迁移/复行/更正都属于服务段，是否上屏只看生效时间与版号新旧。
    const siteParagraphs = paragraphs.filter(
      (paragraph) => paragraph.site === site && paragraph.kind === 'service'
        && paragraph.noticeType !== 'suspension',
    );
    for (const paragraph of latestEffectiveByFamily(siteParagraphs, clock)) {
      blocks.push(reconcileBlock({ paragraph, history, locale, desk }));
    }
  } else {
    // 停办生效：涉及该地点、时间的服务段落一律不得作为有效服务出现，
    // 只允许停办通知本身（应急口径）与联系信息上屏。
    // 停办通知的版号与被停服务段落同家族（H3 对 W6-H），语言页译文挂在服务段 id 下。
    const family = versionFamily(suspended.refVersion ?? suspended.id);
    const familyParagraphIds = [...new Set(paragraphs
      .filter((paragraph) => paragraph.site === site
        && versionFamily(paragraph.refVersion ?? paragraph.id) === family)
      .map((paragraph) => paragraph.id))];
    blocks.push(reconcileBlock({
      paragraph: suspended, history, locale, desk, familyParagraphIds,
    }));
  }

  // 最少应留可用的应急联系信息。
  const hasContact = blocks.some((block) => block.noticeType === 'suspension'
    || paragraphs.some((paragraph) => paragraph.kind === 'contact' && paragraph.allSites));
  if (!hasContact && desk.fallback?.[locale]) {
    blocks.push({
      id: 'emergency-contact',
      refVersion: null,
      text: desk.fallback[locale],
      status: 'fallback-config',
      translationStatus: 'missing',
      noticeType: 'contact',
    });
  }

  return {
    site,
    locale,
    suspended: Boolean(suspended),
    blocks,
    usesSubstitute: blocks.some((block) => block.status === 'fallback-config'
      || block.status === 'source-original'),
    sourceBulletinTime: clock.iso,
  };
}

function activeSuspensionFor(site, paragraphs, clock) {
  return paragraphs.find((paragraph) => {
    if (paragraph.noticeType !== 'suspension' || paragraph.site !== site) return false;
    const noTime = paragraph.effectiveAt === null || paragraph.effectiveAt === undefined;
    return noTime || paragraph.effectiveAt.getTime() <= clock.now.getTime();
  }) ?? null;
}

// 把页面块渲染为门户文本域可提交的纯文本预览。
// 头部带公告来源与生成时间，主管可凭此核对每条内容来自哪份原文/译文。
export function renderPageText(page, source = {}) {
  const header = page.suspended ? `【${page.site}｜${page.locale}｜当日停办应急页】`
    : `【${page.site}｜${page.locale}｜服务公告】`;
  const meta = [
    `公告来源：${source.bulletin ?? '市级公开公告页'}`,
    `译文来源：${source.translation ?? '地方语言页（已审条目）'}`,
    `生成时间（东八区）：${source.generatedAt ?? page.sourceBulletinTime}`,
  ];
  const lines = page.blocks.map((block) => {
    const tag = block.status === 'reviewed' ? '[已审译文]'
      : block.status === 'source' ? '[官方原文]'
        : block.status === 'fallback-config' ? '[应急替代·译文待补]'
          : '[官方原文暂代·译文待补]';
    return `${tag} ${block.id}${block.refVersion ? `/${block.refVersion}` : ''}：${block.text}`;
  });
  return [header, ...meta, ...lines].join('\n');
}
