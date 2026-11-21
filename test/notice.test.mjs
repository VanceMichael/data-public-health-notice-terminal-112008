import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  TranslationCache,
  composeEdition,
  coversSite,
  latestRevisions,
  parseBulletin,
  parseTranslation,
} from '../agent/notice.mjs';

const data = JSON.parse(readFileSync(new URL('../fixtures/source.json', import.meta.url)));
const desk = JSON.parse(readFileSync(new URL('../fixtures/desk.json', import.meta.url)));

const bulletin = (step, id = 'W6') => {
  const html = data.routes[step]?.[`GET /bulletins/${id}`]?.body ?? data.routes.common[`GET /bulletins/${id}`].body;
  return parseBulletin(html, { noticeId: id });
};
const english = (step) =>
  parseTranslation(data.routes[step]?.['GET /translation/en']?.body ?? data.routes.common['GET /translation/en'].body);

test('公告段落拆出段号、版号、适用范围与生效时刻', () => {
  const parsed = bulletin('urgent');
  assert.equal(parsed.blocks.length, 5);
  const contact = parsed.blocks[0];
  assert.equal(contact.id, 'W6-N');
  assert.equal(contact.version, 'R1');
  assert.deepEqual(contact.scope.sites, []);
  assert.ok(contact.scope.all);
  const closure = parsed.blocks.at(-1);
  assert.equal(closure.id, 'U4');
  assert.equal(closure.version, 'H3');
  assert.equal(closure.noticeKind, 'closure');
  // 12:10 +08:00 == 04:10Z
  assert.equal(closure.effectiveAt, '2026-12-08T04:10:00.000Z');
  // “09:00 至 16:00 开放”不是生效时刻。
  assert.equal(parsed.blocks[1].effectiveAt, null);
});

test('语言页保留版号与审译状态，待审条目不进已审缓存', () => {
  const translation = english('primary');
  const byVersion = Object.fromEntries(translation.entries.map((entry) => [entry.version, entry]));
  assert.equal(byVersion.H1.status, 'approved');
  assert.equal(byVersion.H2.status, 'draft');

  const cache = new TranslationCache().beginSession();
  cache.ingest(bulletin('urgent'), translation, '2026-11-21T00:00:00Z');
  assert.deepEqual(cache.approvedVersions(), ['H1', 'R1', 'S2']);
  assert.equal(cache.entries.some((entry) => entry.version === 'H2'), false);
});

test('适用范围决定段落是否出现在某点位', () => {
  const parsed = bulletin('primary');
  const [contact, north, south] = parsed.blocks;
  assert.equal(coversSite(contact, '南站点'), true);
  assert.equal(coversSite(north, '北桥点'), true);
  assert.equal(coversSite(north, '南站点'), false);
  assert.equal(coversSite(south, '南站点'), true);
});

test('同段号多版本时只发布最新版', () => {
  const blocks = latestRevisions(bulletin('stale').blocks);
  const ids = blocks.map((block) => `${block.id}@${block.version}`);
  assert.deepEqual(ids, ['W6-N@R1', 'W6-H@H2', 'W6-S@S2']);
  // 紧急停办是另一则通知（版号 H3），替代同一范围的 H2。
  const urgent = latestRevisions(bulletin('urgent').blocks);
  // 停办通知沿用 H 系列的位置，顺序仍按公告阅读顺序。
  assert.deepEqual(
    urgent.map((block) => `${block.id}@${block.version}`),
    ['W6-N@R1', 'U4@H3', 'W6-S@S2'],
  );
});

test('只复用原文与范围均未变的已审译文，未变段落可沿用早先快照', () => {
  const cache = new TranslationCache().beginSession();
  cache.ingest(bulletin('primary'), english('primary'), '2026-11-20T00:00:00Z');
  // 新一轮运行：语言页只列出变更段落，未列出的 R1/H1/S2 应作为“沿用”继续可用。
  cache.beginSession();
  const partial = parseTranslation(
    '<html lang="zh-CN"><h1>北桥英语页</h1><main><p>W6-H，H2，待审。 New North Bridge desk from noon.</p></main></html>',
  );
  const stale = bulletin('stale');
  cache.ingest(stale, partial, '2026-11-21T00:00:00Z');
  const edition = composeEdition({
    bulletin: stale,
    cache,
    locale: 'en',
    fallback: desk.fallback,
    site: '北桥点',
    now: new Date('2026-12-08T04:00:00Z'),
  });
  const byId = Object.fromEntries(edition.blocks.map((block) => [block.id, block]));
  assert.equal(byId['W6-N'].origin, 'translation');
  assert.equal(byId['W6-N'].translationCarried, true);
  // H2 尚未有已审译文：用应急文字，而不是 H1 的旧译文。
  assert.equal(byId['W6-H'].version, 'H2');
  assert.equal(byId['W6-H'].origin, 'fallback');
  assert.equal(byId['W6-H'].content, desk.fallback.en);
  assert.equal(edition.content.includes('North Bridge desk open'), false);
});

test('错字校正后旧译文不得沿用', () => {
  const corrected = parseBulletin(
    '<html lang="zh-CN"><h1>W6</h1><main><p>W6-H，原文 H1，北桥点，12月8日 09:00 至 16:00 开放（更正常用错字）。</p></main></html>',
    { noticeId: 'W6' },
  );
  const cache = new TranslationCache().beginSession();
  cache.ingest(bulletin('primary'), english('primary'), '2026-11-20T00:00:00Z');
  const edition = composeEdition({
    bulletin: corrected,
    cache,
    locale: 'en',
    fallback: desk.fallback,
    site: '北桥点',
    now: new Date('2026-12-08T03:00:00Z'),
  });
  assert.equal(edition.blocks[0].origin, 'fallback');
  assert.equal(edition.blocks[0].content, desk.fallback.en);
});

test('停办生效时撤下地点与时间，仍保留通用联系段与应急文字', () => {
  const cache = new TranslationCache().beginSession();
  cache.ingest(bulletin('primary'), english('primary'), '2026-11-20T00:00:00Z');
  const edition = composeEdition({
    bulletin: bulletin('urgent'),
    cache,
    locale: 'en',
    fallback: desk.fallback,
    site: '北桥点',
    now: new Date('2026-12-08T05:00:00Z'),
  });
  assert.equal(edition.blocked, true);
  assert.equal(edition.fallbackInUse, true);
  assert.equal(edition.content.includes('09:00 to 16:00'), false);
  assert.equal(edition.content.includes('Desk extension 702.'), true);
  assert.equal(edition.content.includes(desk.fallback.en), true);
  // 页面上实际存在的官方版号：通用联系段 R1 与停办段 H3。
  assert.deepEqual(edition.versions, ['H3', 'R1']);
});

test('停办生效前不撤地点，其他点位不受影响', () => {
  const early = composeEdition({
    bulletin: bulletin('urgent'),
    cache: new TranslationCache(),
    locale: 'zh',
    fallback: desk.fallback,
    site: '北桥点',
    // 11:00（东八区）：H2 的 12:00 迁移还没到，H1 仍在服务。
    now: new Date('2026-12-08T03:00:00Z'),
  });
  assert.equal(early.blocked, false);
  assert.equal(early.content.includes('09:00 至 16:00'), true);

  const south = composeEdition({
    bulletin: bulletin('urgent'),
    cache: new TranslationCache(),
    locale: 'zh',
    fallback: desk.fallback,
    site: '南站点',
    now: new Date('2026-12-08T05:00:00Z'),
  });
  assert.equal(south.blocked, false);
  assert.equal(south.content.includes('10:00 至 15:00'), true);
});

test('复行通知把已停办段落恢复为有效', () => {
  const reopened = parseBulletin(
    `<html lang="zh-CN"><h1>W6</h1><main>
      <p>W6-H，原文 H1，北桥点，12月8日 09:00 至 16:00 开放。</p>
      <p>U4，原文 H3，北桥点，12月8日 12:10 生效，北桥点当天停办，请联系分机 702。</p>
      <p>R7，原文 H4，北桥点，12月8日 14:00 起恢复服务，办公时间联系服务台分机 702。</p>
    </main></html>`,
    { noticeId: 'W6' },
  );
  const edition = composeEdition({
    bulletin: reopened,
    cache: new TranslationCache(),
    locale: 'zh',
    fallback: desk.fallback,
    site: '北桥点',
    now: new Date('2026-12-08T06:00:00Z'),
  });
  // 14:00（东八区）之后复行段生效，北桥点不再处于停办状态。
  assert.equal(edition.blocked, false);
  assert.equal(edition.content.includes('恢复服务'), true);
  assert.equal(edition.blocks.some((block) => block.synthetic), false);
});

test('待审译文不会进入已发布页', () => {
  // 语言页把 H2 从待审改为已审，但原文已换成 H3 -> 仍不能复用 H2 的译文。
  const cache = new TranslationCache().beginSession();
  const draftOnly = parseTranslation(
    '<html lang="zh-CN"><h1>北桥英语页</h1><main><p>W6-H，H3，待审。 Bridge desk closed today.</p></main></html>',
  );
  cache.ingest(bulletin('urgent'), draftOnly, '2026-11-21T00:00:00Z');
  const edition = composeEdition({
    bulletin: bulletin('urgent'),
    cache,
    locale: 'en',
    fallback: desk.fallback,
    site: '北桥点',
    now: new Date('2026-12-08T05:00:00Z'),
  });
  assert.equal(edition.content.includes('Bridge desk closed today'), false);
});

test('译文出处记录发布与抓取时刻', () => {
  const cache = new TranslationCache().beginSession();
  cache.ingest(bulletin('primary'), english('primary'), '2026-11-20T08:00:00Z');
  // 下一次运行的语言页没有重列 H1，说明沿用的是早先抓取的快照。
  cache.beginSession();
  const edition = composeEdition({
    bulletin: bulletin('primary'),
    cache,
    locale: 'en',
    fallback: desk.fallback,
    site: '北桥点',
    now: new Date('2026-12-08T03:00:00Z'),
  });
  assert.ok(edition.source.url === null);
  const h1 = edition.translations.find((entry) => entry.version === 'H1');
  assert.equal(h1.retrievedAt, '2026-11-20T08:00:00Z');
  assert.equal(h1.carried, true);
  assert.match(edition.contentHash, /^[0-9a-f]{16}$/);
});
