// 编排：抓取公开公告与语言页 -> 组出各点位/语言的待发布页 -> 在门户可见界面上
// 先做失效清理，再预览、由主管确认后登记 -> 记录状态与出处。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  TranslationCache,
  composeEdition,
  editionKeyOf,
  parseBulletin,
  parseTranslation,
} from './notice.mjs';
import { PortalDriver, STATUS_LABELS, parsePendingPage } from './portal.mjs';

export const DEFAULT_CONFIG = {
  portal: { approvalCode: '' },
  terminals: {},
  localeFallbackOrder: ['zh', 'en'],
};

export async function loadJSON(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== null) return fallback;
    throw error;
  }
}

export async function saveJSON(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'manual' });
  if (!response.ok) throw new Error(`GET ${url} 返回 ${response.status}`);
  return response.text();
}

export async function setStep(baseUrl, step) {
  if (!step) return null;
  const response = await fetch(`${baseUrl}/_source_clock?step=${encodeURIComponent(step)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`无法把演练时钟推进到 ${step}：${response.status}`);
  return response.json();
}

function anchors(html, prefix) {
  return [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({ href: match[1], text: match[2].replace(/<[^>]*>/g, '').trim() }))
    .filter((link) => link.href.startsWith(prefix));
}

/** 从 /bulletins 首页找到各公告链接，抓取并解析。 */
export async function fetchBulletins(baseUrl) {
  const index = await fetchText(baseUrl + '/bulletins');
  const bulletins = [];
  for (const link of anchors(index, '/bulletins/')) {
    const html = await fetchText(baseUrl + link.href);
    const noticeId = link.href.split('/').filter(Boolean).at(-1) ?? link.text;
    bulletins.push({
      ...parseBulletin(html, { noticeId }),
      url: baseUrl + link.href,
      path: link.href,
      indexText: link.text,
      retrievedAt: new Date().toISOString(),
    });
  }
  return bulletins;
}

/** 从 /translation 首页找到各语言页，抓取并解析。 */
export async function fetchTranslations(baseUrl) {
  const index = await fetchText(baseUrl + '/translation');
  const translations = {};
  for (const link of anchors(index, '/translation/')) {
    const locale = link.href.split('/').filter(Boolean).at(-1);
    const html = await fetchText(baseUrl + link.href);
    translations[locale] = {
      ...parseTranslation(html),
      url: baseUrl + link.href,
      path: link.href,
      retrievedAt: new Date().toISOString(),
    };
  }
  return translations;
}

function siteOfDevice(desk, device) {
  for (const [site, roster] of Object.entries(desk.sites ?? {})) {
    if (roster.includes(device)) return site;
  }
  return null;
}

function devicesForSite(state, desk, site) {
  const roster = new Set(desk.sites?.[site] ?? []);
  const found = [];
  for (const group of state.groups) {
    for (const device of Object.keys(group.devices)) {
      if (roster.has(device) && !found.includes(device)) found.push(device);
    }
  }
  return found.length > 0 ? found : [...roster];
}

function localesForDevice(config, state, device) {
  const configured = config.terminals?.[device]?.locale;
  if (configured) return [configured];
  const inferred = state.pending.rows.find((row) => row.device === device && row.locale)?.locale;
  if (inferred) return [inferred];
  return ['zh'];
}

/**
 * 演练时钟。
 *
 * 合成上游用阶段推进而不是真实日历：`urgent` 阶段才出现 12:10 生效的停办段。
 * 本机演练日期（11 月）早于公告里的 12 月，若直接用系统时间，停办永远不会到点。
 * 因此默认把“上游已发布的最新生效时刻”当作演练的当前时刻——上游既然已经发布
 * 该段，演练就处在它生效之后。可用 config.clock = { mode: "real" } 改回系统时间，
 * 或用 config.clock = { now: "<ISO>" } 固定时刻。
 */
export function drillNow(bulletin, { config = {}, realNow = new Date() } = {}) {
  const fixed = config.clock?.now;
  if (fixed) return new Date(fixed);
  if (config.clock?.mode === 'real') return realNow;
  const times = (bulletin?.blocks ?? [])
    .filter((block) => block.effectiveAt)
    .map((block) => Date.parse(block.effectiveAt))
    .filter((value) => Number.isFinite(value));
  if (times.length === 0) return realNow;
  return new Date(Math.max(...times));
}

function rowsForDevice(state, device) {
  return state.pending.rows.filter((row) => row.device === device);
}

function rowIsStale(row, edition) {
  if (!row.version) return false;
  return row.version !== edition.markerVersion;
}

function groupPathForDevice(state, device) {
  for (const group of state.groups) {
    if (group.devices[device] && group.path) return group.path;
  }
  return null;
}

function groupForDevice(state, device) {
  return state.groups.find((group) => group.devices[device]) ?? null;
}

/**
 * 运行一次完整换页周期。
 *
 * 可选 onBeforeRegister：在“预览通过之后、主管登记之前”改变上游，用于演练另一
 * 条同范围通知在门户处理中途生效。预览与登记之间会重新抓取上游并核对画面。
 */
export async function runCycle({
  baseUrl,
  config = DEFAULT_CONFIG,
  desk,
  statePath = 'var/state.json',
  outDir = 'var',
  step = null,
  dryRun = false,
  headed = false,
  logger = () => {},
  onBeforeRegister = null,
  now = () => new Date(),
  portalFactory = PortalDriver,
} = {}) {
  await setStep(baseUrl, step);
  const startedAt = now().toISOString();
  const stored = await loadJSON(statePath, { cache: { entries: [] }, journal: [], lastEditions: {} });
  const cache = TranslationCache.fromJSON(stored.cache).beginSession();
  const journal = stored.journal ?? [];
  const fullConfig = { ...DEFAULT_CONFIG, ...config, desk };

  const bulletins = await fetchBulletins(baseUrl);
  const translations = await fetchTranslations(baseUrl);
  for (const bulletin of bulletins) {
    for (const translation of Object.values(translations)) {
      cache.ingest(bulletin, translation, startedAt);
    }
  }

  const primary = bulletins[0];
  if (!primary) throw new Error('市级公开页没有公告链接');
  const fallback = desk?.fallback ?? {};
  const sites = Object.keys(desk?.sites ?? {});

  const portal = await new portalFactory({ baseUrl, config: fullConfig, outDir, headed, logger }).open();
  const actions = [];
  const events = [];
  const previews = [];
  const discardedPreviews = [];
  let previewCount = 0;

  try {
    let portalState = await portal.readState();
    await saveJSON(join(outDir, 'portal-before.json'), portalState);

    const editions = new Map();
    const composeFor = (site, locale, bulletin = primary) =>
      composeEdition({
        bulletin,
        cache,
        locale,
        fallback,
        now: drillNow(bulletin, { config: fullConfig, realNow: now() }),
        site,
        sourceUrl: bulletin.url,
      });

    for (const site of sites) {
      const devices = devicesForSite(portalState, desk, site);
      for (const device of devices) {
        for (const locale of localesForDevice(fullConfig, portalState, device)) {
          editions.set(`${site}\u0000${device}\u0000${locale}`, composeFor(site, locale));
        }
      }
    }

    // 1) 失效清理优先：撤掉版本已不在当前公告内、或停办后仍挂着的旧换页。
    const cancelled = new Set();
    for (const [key, edition] of editions) {
      const [, device] = key.split('\u0000');
      if (cancelled.has(device)) continue;
      // 停办生效时，即使版本相同也要先清掉挂着旧服务地点的待办。
      const stale = rowsForDevice(portalState, device).filter(
        (row) => row.cancelAction && (rowIsStale(row, edition) || edition.blocked),
      );
      for (const row of stale) {
        const record = {
          kind: 'cancel',
          pendingId: row.id,
          device,
          reason: edition.blocked
            ? '停办已生效，先清理挂起的旧换页'
            : `待办版本 ${row.version ?? '未知'} 已不在当前版本 ${edition.versions.join('/')} 内`,
          at: now().toISOString(),
        };
        if (dryRun) {
          record.result = 'dry-run';
        } else {
          try {
            const receipt = await portal.cancel(row.id);
            record.receipt = receipt;
            record.result = receipt.result ?? (receipt.confirmed ? 'cancel-requested' : 'unconfirmed');
          } catch (error) {
            record.result = 'error';
            record.error = error.message;
          }
        }
        journal.push(record);
        events.push(record);
        actions.push(record);
      }
      cancelled.add(device);
    }
    if (!dryRun && cancelled.size > 0) {
      await portal.goto('/screens/pending');
      portalState = { ...portalState, pending: parsePendingPage(await portal.content()) };
    }

    // 2) 逐设备、逐语言预览并由主管登记。单页设备一次只换一页：
    //    本轮已给某台单页设备登记后，同设备其他语言留到下一轮。
    const results = [];
    const busySingle = new Set();
    for (const [key] of editions) {
      const [site, device, locale] = key.split('\u0000');
      const group = groupForDevice(portalState, device);
      const groupPath = groupPathForDevice(portalState, device);
      const capability = group?.devices?.[device]?.capability ?? 'single';
      if (capability === 'single' && busySingle.has(device)) {
        results.push({
          site,
          device,
          locale,
          action: 'none',
          reason: `单页设备 ${device} 本轮已登记一页，其余语言留待下一轮`,
        });
        continue;
      }
      const deviceRows = rowsForDevice(portalState, device);
      const liveRow = deviceRows.find((row) => row.status === 'accepted' || row.status === 'displayed');
      const displayedVersion = group?.devices?.[device]?.displayedVersion ?? null;

      let edition = composeFor(site, locale);
      // 页面以“最新版号”为代表版本；设备或待办只有在这个版号上才算对齐，
      // 不能因为页面里恰好含有某个旧版号就当作已经更新。
      if (
        displayedVersion &&
        displayedVersion === edition.markerVersion &&
        !group?.devices?.[device]?.displayedOld
      ) {
        results.push({ site, device, locale, action: 'none', reason: `设备已显示当前版本 ${displayedVersion}` });
        continue;
      }
      if (group?.devices?.[device]?.note === '等待换页确认') {
        results.push({
          site,
          device,
          locale,
          action: 'none',
          reason: `门户显示设备 ${device} 正在等待换页确认，不再叠加上一版`,
        });
        continue;
      }
      if (liveRow && liveRow.status === 'accepted' && liveRow.version === edition.markerVersion) {
        results.push({
          site,
          device,
          locale,
          action: 'none',
          reason: `待办 ${liveRow.id} 已在门户接收，版本 ${liveRow.version} 与当前版本一致`,
        });
        continue;
      }
      if (capability === 'single' && liveRow && liveRow.status === 'accepted' && !liveRow.cancelAction) {
        results.push({
          site,
          device,
          locale,
          action: 'manual',
          reason: `单页设备 ${device} 仍有待执行换页 ${liveRow.id}，不能并行再登记`,
        });
        continue;
      }
      if (!groupPath) {
        results.push({ site, device, locale, action: 'manual', reason: '门户里找不到该设备所属组' });
        continue;
      }

      if (dryRun) {
        const record = {
          kind: 'preview',
          site,
          device,
          locale,
          noticeCode: edition.noticeCode,
          versions: edition.versions,
          contentHash: edition.contentHash,
          content: edition.content,
          blocked: edition.blocked,
          fallbackInUse: edition.fallbackInUse,
          source: edition.source,
          status: 'dry-run',
          at: now().toISOString(),
        };
        previews.push(record);
        actions.push(record);
        results.push({ site, device, locale, action: 'preview', reason: 'dry-run 不登记', record });
        continue;
      }

      let receipt = null;
      let drift = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const preview = await portal.preview({
          groupPath,
          notice: edition.noticeCode ?? '公告',
          device,
          locale,
          content: edition.content,
        });
        previewCount += 1;
        if (!preview.confirmed) {
          results.push({ site, device, locale, action: 'manual', reason: '预览页未确认公告、设备与语言' });
          break;
        }

        if (onBeforeRegister) {
          await onBeforeRegister({ device, site, locale, edition, attempts: attempt });
        }

        // 预览之后重新抓取上游，防止另一条同范围通知在门户处理中途生效。
        const freshBulletins = await fetchBulletins(baseUrl);
        const freshTranslations = await fetchTranslations(baseUrl);
        const freshPrimary = freshBulletins[0] ?? primary;
        for (const bulletin of freshBulletins) {
          for (const translation of Object.values(freshTranslations)) {
            cache.ingest(bulletin, translation, now().toISOString());
          }
        }
        const freshEdition = composeFor(site, locale, freshPrimary);
        if (freshEdition.contentHash !== edition.contentHash || freshEdition.blocked !== edition.blocked) {
          drift = true;
          const discarded = {
            kind: 'superseded-preview',
            site,
            device,
            locale,
            reason: '预览后上游出现同范围紧急变化，等待画面需重新核对',
            noticeCode: edition.noticeCode,
            versions: edition.versions,
            contentHash: edition.contentHash,
            previousContent: preview.fields?.content ?? null,
            previousVersions: edition.versions,
            previousBlocked: edition.blocked,
            preview: {
              status: preview.status,
              text: preview.text,
              screenshotPath: preview.screenshotPath,
              htmlPath: preview.htmlPath,
              at: preview.submittedAt,
            },
            supersededBy: {
              versions: freshEdition.versions,
              contentHash: freshEdition.contentHash,
              blocked: freshEdition.blocked,
            },
            at: now().toISOString(),
          };
          events.push(discarded);
          actions.push(discarded);
          discardedPreviews.push(discarded);
          edition = freshEdition;
          editions.set(key, freshEdition);
          continue;
        }

        receipt = await portal.register({ approval: fullConfig.portal?.approvalCode ?? '' });
        const record = {
          kind: 'register',
          site,
          device,
          locale,
          capability,
          scope: capability === 'group' ? 'group' : 'single',
          noticeCode: edition.noticeCode,
          versions: edition.versions,
          content: edition.content,
          contentHash: edition.contentHash,
          blocked: edition.blocked,
          fallbackInUse: edition.fallbackInUse,
          source: edition.source,
          translations: edition.translations,
          preview: {
            status: preview.status,
            confirmed: preview.confirmed,
            text: preview.text,
            screenshotPath: preview.screenshotPath,
            htmlPath: preview.htmlPath,
            at: preview.submittedAt,
          },
          receipt,
          drift,
          result: receipt.confirmed ? 'accepted' : 'unconfirmed',
          at: now().toISOString(),
        };
        journal.push(record);
        events.push(record);
        actions.push(record);
        if (capability === 'single') busySingle.add(device);
        results.push({
          site,
          device,
          locale,
          action: 'register',
          reason: drift ? '上游变化后重新预览并登记' : '已登记，等待设备确认',
          record,
        });
        break;
      }
      if (drift && !receipt) {
        const record = {
          kind: 'blocked',
          site,
          device,
          locale,
          reason: '预览后上游持续变化，旧画面不得上线',
          at: now().toISOString(),
        };
        journal.push(record);
        events.push(record);
        results.push({ site, device, locale, action: 'manual', reason: record.reason });
      }
    }

    // 3) 结束后重新读取门户，按服务点汇总状态与出处。
    portalState = await portal.readState();
    await saveJSON(join(outDir, 'portal-after.json'), portalState);

    const siteReports = buildSiteReports({
      sites,
      desk,
      config: fullConfig,
      portalState,
      editions,
      journal,
      primary,
    });

    await saveJSON(statePath, {
      cache: cache.toJSON(),
      journal,
      lastEditions: Object.fromEntries(
        [...editions].map(([key, edition]) => [
          key,
          {
            site: edition.site,
            locale: edition.locale,
            versions: edition.versions,
            contentHash: edition.contentHash,
            noticeCode: edition.noticeCode,
            blocked: edition.blocked,
            fallbackInUse: edition.fallbackInUse,
            source: edition.source,
          },
        ]),
      ),
      updatedAt: now().toISOString(),
    });

    const report = {
      generatedAt: now().toISOString(),
      step: step ?? null,
      region: desk?.region ?? null,
      dryRun,
      bulletins: bulletins.map((bulletin) => ({
        noticeId: bulletin.noticeId,
        title: bulletin.title,
        path: bulletin.path,
        publishedAt: bulletin.publishedAt,
        retrievedAt: bulletin.retrievedAt ?? null,
        editionKey: editionKeyOf(bulletin),
        blocks: bulletin.blocks.map((block) => ({
          id: block.id,
          version: block.version,
          scope: block.scopeText,
          noticeKind: block.noticeKind,
          effectiveAt: block.effectiveAt,
        })),
      })),
      translations: Object.fromEntries(
        Object.entries(translations).map(([locale, translation]) => [
          locale,
          {
            path: translation.path,
            publishedAt: translation.publishedAt,
            retrievedAt: translation.retrievedAt ?? null,
            entries: translation.entries.map((entry) => ({
              sourceId: entry.sourceId,
              version: entry.version,
              status: entry.status,
            })),
          },
        ]),
      ),
      sites: siteReports,
      actions,
      events,
      previews,
      discardedPreviews,
      previewCount,
      results,
    };
    await saveJSON(join(outDir, 'status.json'), report);
    return report;
  } finally {
    await portal.close();
  }
}

function statusForSite({ site, devices, config, state, editions, journal }) {
  const deviceReports = devices.map((device) => {
    const locale = localesForDevice(config, state, device)[0];
    const edition = editions.get(`${site}\u0000${device}\u0000${locale}`);
    const group = groupForDevice(state, device);
    const groupDevice = group?.devices?.[device] ?? {};
    const rows = rowsForDevice(state, device);
    const acceptedRow = rows.find((row) => row.status === 'accepted');
    const displayedRow = rows.find((row) => row.status === 'displayed');
    // 设备登记显示的是当前页面；待办里“已显示某版”也可以佐证。两者都以“当前版本”为准。
    const displayedVersion = groupDevice.displayedVersion ?? displayedRow?.version ?? null;
    const online = groupDevice.online ?? null;
    const desired = edition?.versions ?? [];
    // 只有屏幕登记显示“已显示/已确认”，且显示的是当前版本，才算完成。
    // “当前显示旧版 X”只是设备上还挂着旧画面，不能当作完成。
    const shown =
      Boolean(displayedVersion) &&
      displayedVersion === edition?.markerVersion &&
      !groupDevice.displayedOld;
    const registered = [...journal]
      .reverse()
      .find((entry) => entry.kind === 'register' && entry.device === device && entry.receipt?.confirmed);
    let status;
    if (shown) status = 'displayed';
    // 离线设备即使门户已接收，也不能当作完成——区域值班要拿记录去线下终端核对。
    else if (online === false) status = 'manual';
    else if (acceptedRow || groupDevice.note === '等待换页确认' || registered) status = 'accepted';
    else if (edition?.fallbackInUse) status = 'fallback';
    else status = 'manual';
    return {
      device,
      locale,
      capability: groupDevice.capability ?? null,
      online,
      status,
      statusLabel:
        status === 'displayed'
          ? STATUS_LABELS.displayed
          : status === 'accepted'
            ? STATUS_LABELS.accepted
            : status === 'fallback'
              ? '替代文案仍在使用'
              : '需要人工上屏',
      fallbackInUse: Boolean(edition?.fallbackInUse),
      displayedVersion,
      desiredVersions: desired,
      pendingId: acceptedRow?.id ?? null,
      pendingStatus: acceptedRow?.statusLabel ?? null,
      lastRegisteredVersions: registered?.versions ?? [],
      lastRegisteredAt: registered?.at ?? null,
      lastRegisteredContentHash: registered?.contentHash ?? null,
      lastRegisteredSource: registered?.source ?? null,
      lastRegisteredTranslations: registered?.translations ?? [],
      previewScreenshot: registered?.preview?.screenshotPath ?? null,
    };
  });

  const accepted = state.pending.rows.filter(
    (row) => devices.includes(row.device) && (row.status === 'accepted' || row.status === 'cancel_pending'),
  );

  return {
    site,
    summary: {
      portalAccepted: accepted.filter((row) => row.status === 'accepted').length,
      deviceDisplayed: deviceReports.filter((device) => device.status === 'displayed').length,
      // 替代文案仍在用：该点位的待发布页面调用了应急文字（与“是否已被接收”正交）。
      fallbackInUse: deviceReports.some((device) => device.fallbackInUse),
      manualNeeded: deviceReports.some((device) => device.status === 'manual'),
    },
    devices: deviceReports,
    pending: devices.flatMap((device) =>
      rowsForDevice(state, device).map((row) => ({
        id: row.id,
        device: row.device,
        version: row.version,
        locale: row.locale,
        status: row.status,
        statusLabel: STATUS_LABELS[row.status] ?? row.status,
        text: row.text,
      })),
    ),
    editions: devices.map((device) => {
      const locale = localesForDevice(config, state, device)[0];
      const edition = editions.get(`${site}\u0000${device}\u0000${locale}`);
      if (!edition) return null;
      return {
        device,
        locale: edition.locale,
        noticeCode: edition.noticeCode,
        markerVersion: edition.markerVersion,
        blocked: edition.blocked,
        fallbackInUse: edition.fallbackInUse,
        versions: edition.versions,
        content: edition.content,
        source: edition.source,
        translations: edition.translations,
        blocks: edition.blocks.map((block) => ({
          id: block.id,
          version: block.version,
          origin: block.origin,
          content: block.content,
          sourceText: block.sourceText,
          translationPublishedAt: block.translationPublishedAt,
          translationRetrievedAt: block.translationRetrievedAt,
          translationCarried: block.translationCarried,
        })),
      };
    }),
  };
}

function buildSiteReports({ sites, desk, config, portalState, editions, journal, primary }) {
  return sites.map((site) => {
    const devices = devicesForSite(portalState, desk, site);
    const report = statusForSite({ site, devices, config, state: portalState, editions, journal });
    const registered = [...journal]
      .reverse()
      .find((entry) => entry.kind === 'register' && entry.site === site && entry.receipt?.confirmed);
    return {
      ...report,
      provenance: {
        noticeTitle: primary.title,
        noticeId: primary.noticeId,
        sourcePublishedAt: primary.publishedAt,
        sourceUrl: primary.url,
        sourceRetrievedAt: primary.retrievedAt ?? null,
        lastRegisteredAt: registered?.at ?? null,
        lastRegisteredNoticeCode: registered?.noticeCode ?? null,
        lastRegisteredContentHash: registered?.contentHash ?? null,
        lastRegisteredTranslations: registered?.translations ?? [],
        lastPreviewScreenshot: registered?.preview?.screenshotPath ?? null,
      },
    };
  });
}
