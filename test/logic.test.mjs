import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseBulletin, parsePendingLine, parseTranslationPage, parseTranslationParagraph } from '../app/parse.mjs';
import { classifyAll, versionFamily } from '../app/notices.mjs';
import {
  composeSitePage,
  findReviewedTranslation,
  mergeTranslationHistory,
  renderPageText,
} from '../app/translation.mjs';
import { createClock } from '../app/clock.mjs';

const config = JSON.parse(readFileSync(new URL('../app/config.example.json', import.meta.url)));
const desk = JSON.parse(readFileSync(new URL('../fixtures/desk.json', import.meta.url)));
const source = JSON.parse(readFileSync(new URL('../fixtures/source.json', import.meta.url)));

function stripHtml(html) {
  return html.match(/<p>(.*?)<\/p>/g).map((line) => line.replace(/<\/?p>/g, ''));
}

// 公告时间按东八区解释，取小时也要按东八区，避免受运行环境时区影响。
function shanghaiHour(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false,
  }).formatToParts(date);
  return Number(parts.find((part) => part.type === 'hour').value);
}

const paragraphsAt = (step) => parseBulletin(
  stripHtml(source.routes[step]['GET /bulletins/W6'].body),
  { sites: Object.keys(desk.sites), year: config.bulletinYear },
);

test('公告段落解析出识别码、原文版号、适用点位与生效时间', () => {
  const paragraphs = parseBulletin(
    stripHtml(source.routes.urgent['GET /bulletins/W6'].body),
    { sites: Object.keys(desk.sites), year: config.bulletinYear },
  );
  const migration = paragraphs.find((item) => item.text.includes('改到北桥新址'));
  assert.equal(migration.refVersion, 'H2');
  assert.equal(migration.site, '北桥点');
  assert.equal(shanghaiHour(migration.effectiveAt), 12);

  const contact = paragraphs.find((item) => item.kind === 'contact');
  assert.equal(contact.allSites, true);
  assert.equal(contact.refVersion, 'R1');

  const urgent = paragraphs.find((item) => item.id === 'U4');
  assert.equal(urgent.site, '北桥点');
});

test('通知按类型分类：迁移、停办、复行、更正', () => {
  const classified = classifyAll(paragraphsAt('urgent'), config.noticeKeywords);
  const urgent = classified.find((item) => item.id === 'U4');
  assert.equal(urgent.noticeType, 'suspension');
  const migration = classified.find((item) => item.refVersion === 'H2');
  assert.equal(migration.noticeType, 'migration');

  const made = classifyAll([
    { id: 'X1', text: 'W6-H，原文 H4，北桥点，原公告复行，按 09:00 至 16:00 开放。' },
    { id: 'X2', text: 'W6-S，原文 S3，南站点，更正错字，时间不变。' },
  ], config.noticeKeywords);
  assert.deepEqual(made.map((item) => item.noticeType), ['resumption', 'correction']);
});

test('语言页解析区分已审与待审，待审条目不得被复用', () => {
  const entries = stripHtml(source.routes.common['GET /translation/en'].body)
    .map(parseTranslationParagraph);
  assert.equal(entries.length, 4);
  const h2 = entries.find((item) => item.refVersion === 'H2');
  assert.equal(h2.status, 'pending');
  const history = mergeTranslationHistory([], entries);
  assert.equal(findReviewedTranslation(history, { id: 'W6-H', refVersion: 'H2' }), null);
  assert.ok(findReviewedTranslation(history, { id: 'W6-H', refVersion: 'H1' }));
});

test('译文历史跨快照累积，display 阶段补齐 H3 已审译文', () => {
  const early = stripHtml(source.routes.common['GET /translation/en'].body)
    .map(parseTranslationParagraph);
  const later = stripHtml(source.routes.display['GET /translation/en'].body)
    .map(parseTranslationParagraph);
  const history = mergeTranslationHistory(mergeTranslationHistory([], early), later);
  const h3 = findReviewedTranslation(history, { id: 'W6-H', refVersion: 'H3' });
  assert.equal(h3.status, 'reviewed');
  // 早期已审的联系段与南站段在新快照缺行时仍可沿用。
  assert.ok(findReviewedTranslation(history, { id: 'W6-N', refVersion: 'R1' }));
  assert.ok(findReviewedTranslation(history, { id: 'W6-S', refVersion: 'S2' }));
});

test('stale 阶段 H2 无英语译文：使用配置应急文字并标记替代，待审译文不上屏', () => {
  const clock = createClock(config, 'stale');
  const history = mergeTranslationHistory([],
    stripHtml(source.routes.common['GET /translation/en'].body).map(parseTranslationParagraph));
  const page = composeSitePage({
    site: '北桥点', locale: 'en',
    paragraphs: classifyAll(paragraphsAt('stale'), config.noticeKeywords),
    history, desk, clock,
  });
  const h2 = page.blocks.find((block) => block.refVersion === 'H2');
  assert.equal(h2.status, 'fallback-config');
  assert.equal(h2.text, desk.fallback.en);
  assert.ok(!page.blocks.some((block) => block.text.includes('New North Bridge desk from noon')));
  assert.equal(page.usesSubstitute, true);
  // H1 旧版已被同家族 H2 替代，不应同时上屏。
  assert.ok(!page.blocks.some((block) => block.refVersion === 'H1'));
});

test('停办生效后旧服务地点时间不得作为有效服务出现，只留停办口径与联系段', () => {
  const clock = createClock(config, 'urgent');
  const history = mergeTranslationHistory([],
    stripHtml(source.routes.common['GET /translation/en'].body).map(parseTranslationParagraph));
  const page = composeSitePage({
    site: '北桥点', locale: 'en',
    paragraphs: classifyAll(paragraphsAt('urgent'), config.noticeKeywords),
    history, desk, clock,
  });
  assert.equal(page.suspended, true);
  assert.ok(!page.blocks.some((block) => block.refVersion === 'H1' || block.refVersion === 'H2'));
  const serviceText = page.blocks.map((block) => block.text).join(' ');
  assert.ok(!serviceText.includes('09:00 to 16:00'));
  assert.ok(page.blocks.some((block) => block.id === 'W6-N'));
  assert.ok(page.blocks.some((block) => block.id === 'U4'));
});

test('停办页即使缺少联系段也至少保留可用的应急联系信息', () => {
  const clock = createClock(config, 'urgent');
  const onlySuspension = classifyAll(
    parseBulletin(
      ['U4，原文 H3，北桥点，12月8日 12:10 生效，北桥点当天停办，请联系分机 702。'],
      { sites: Object.keys(desk.sites), year: config.bulletinYear },
    ),
    config.noticeKeywords,
  );
  const page = composeSitePage({
    site: '北桥点', locale: 'en',
    paragraphs: onlySuspension, history: [], desk, clock,
  });
  assert.equal(page.suspended, true);
  assert.ok(page.blocks.some((block) => block.text === desk.fallback.en
    || block.text.includes('702')), '停办页必须保留应急联系信息');
});

test('复行通知在停办之后恢复服务段，并沿用同家族最新已审译文', () => {
  const clock = createClock(config, 'display');
  const paragraphs = parseBulletin([
    'W6-N，联系段 R1，全部服务点，办公时间联系服务台分机 702。',
    'W6-H，原文 H3，北桥点，12月8日 12:30 起原公告复行，恢复开放。',
  ], { sites: Object.keys(desk.sites), year: config.bulletinYear });
  const history = parseTranslationPage(
    stripHtml(source.routes.display['GET /translation/en'].body),
  );
  const page = composeSitePage({
    site: '北桥点', locale: 'en',
    paragraphs: classifyAll(paragraphs, config.noticeKeywords),
    history, desk, clock,
  });
  assert.equal(page.suspended, false);
  const h3 = page.blocks.find((block) => block.refVersion === 'H3');
  assert.equal(h3.noticeType, 'resumption');
  assert.equal(h3.status, 'reviewed', '复行段沿用同家族 H3 的已审译文');
});

test('未到生效时间的段落不预上屏；版号家族按数字比较', () => {
  assert.equal(versionFamily('H12'), 'H');
  const clock = createClock(config, 'primary');
  const page = composeSitePage({
    site: '北桥点', locale: 'zh',
    paragraphs: classifyAll(paragraphsAt('stale'), config.noticeKeywords),
    history: [], desk, clock,
  });
  assert.ok(!page.blocks.some((block) => block.refVersion === 'H2'));
  assert.ok(page.blocks.some((block) => block.refVersion === 'H1'));
});

test('渲染的页面文本带替代标记，预览中可区分已审译文与应急文字', () => {
  const clock = createClock(config, 'stale');
  const history = mergeTranslationHistory([],
    stripHtml(source.routes.common['GET /translation/en'].body).map(parseTranslationParagraph));
  const page = composeSitePage({
    site: '北桥点', locale: 'en',
    paragraphs: classifyAll(paragraphsAt('stale'), config.noticeKeywords),
    history, desk, clock,
  });
  const text = renderPageText(page);
  assert.ok(text.includes('[已审译文] W6-N/R1'));
  assert.ok(text.includes('[应急替代·译文待补] W6-H/H2'));
});

test('待办行解析出换页单状态与撤销确认', () => {
  const ops = [
    'P41，N1，H1，英语，设备已接收未显示。',
    'P55，N1，H3，英语，已显示。',
    'P41，撤销已确认。',
  ].map((line) => parsePendingLine(line, config.localeLabels));
  assert.equal(ops[0].state, 'received');
  assert.equal(ops[1].state, 'displayed');
  assert.equal(ops[1].locale, 'en');
  assert.equal(ops[2].cancelled, true);
  assert.equal(ops[2].confirmed, true);
});
