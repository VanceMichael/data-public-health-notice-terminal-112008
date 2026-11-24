// 代办编排：抓取 → 核对译文 → 合成各服务点页面 → 门户换页 → 记录凭据。
// 关键顺序：离线设备重连时，先执行到点的失效清理（撤销旧换页），再上新页；
// 处理中途若出现同范围新通知，整页按最新公告重建，绝不混拼不同版本。

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPage, withPage } from './browser.mjs';
import { parseBulletin, parseDeviceLine, parsePendingLine, parseTranslationPage } from './parse.mjs';
import { activeSuspendedSites, classifyAll, versionFamily } from './notices.mjs';
import {
  composeSitePage,
  findReviewedTranslation,
  mergeTranslationHistory,
  renderPageText,
} from './translation.mjs';
import { bulletinSignature, loadState, saveState } from './state.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadDesk(config) {
  const path = config.deskFile.startsWith('/')
    ? config.deskFile
    : resolve(ROOT, config.deskFile);
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function discoverBulletins(browser, baseUrl, config) {
  return withPage(browser, baseUrl + config.bulletinsHome, async (page) => {
    const index = await readPage(page, baseUrl + config.bulletinsHome);
    const links = index.links.filter((link) => link.href.startsWith('/bulletins/'));
    const pages = [];
    for (const link of links) {
      pages.push(await readPage(page, new URL(link.href, baseUrl).href));
    }
    return pages;
  });
}

async function discoverTranslations(browser, baseUrl, config) {
  return withPage(browser, baseUrl + config.translationHome, async (page) => {
    const index = await readPage(page, baseUrl + config.translationHome);
    const links = index.links.filter((link) => link.href.startsWith('/translation/'));
    const pages = [];
    for (const link of links) {
      pages.push(await readPage(page, new URL(link.href, baseUrl).href));
    }
    return pages;
  });
}

// 换页决策：返回“应显示目标”与“是否需要向门户登记新换页”。
function decideTarget({ terminal, locale, site, pages, groupPage, pending }) {
  const target = pages.find((page) => page.site === site && page.locale === locale);
  const targetSignature = target.blocks.map((block) => `${block.id}/${block.refVersion}`).join('|');

  const device = groupPage.devices.find((item) => item.terminal === terminal);
  const pendingOp = pending.operations.find((item) => item.terminal === terminal && !item.cancelled);
  const displayedVersions = device?.displayedVersion ? [device.displayedVersion] : [];
  const hasDisplayEvidence = Boolean(device?.displayedVersion || device?.pendingOperation
    || device?.awaitingConfirmation || pendingOp);

  // 门户没有任何该设备的显示/待办证据时，不臆断它需要换页（避免对未知设备反复登记）。
  if (!hasDisplayEvidence) {
    return {
      target, targetSignature, pendingOperation: pendingOp ?? null, device: device ?? null,
      needsChange: false, hasPendingConflict: false, noEvidence: true,
    };
  }

  // 设备已显示版号是否覆盖目标里每个非联系段的版号家族。
  const coversTarget = target.blocks
    .filter((block) => block.noticeType !== 'contact')
    .every((block) => displayedVersions.some((version) =>
      versionFamily(version) === versionFamily(block.refVersion)));

  // 需要换页：版号未覆盖、仍挂替代文案、或站点处于停办应急状态。
  const needsChange = !coversTarget || target.usesSubstitute || target.suspended;

  // 待办里的旧换页与目标版号同家族但版号不同（例如 H1 对 H3），必须先撤销。
  const hasPendingConflict = Boolean(pendingOp?.version
    && target.blocks.some((block) => block.refVersion
      && versionFamily(pendingOp.version) === versionFamily(block.refVersion)
      && pendingOp.version !== block.refVersion));

  return {
    target,
    targetSignature,
    pendingOperation: pendingOp ?? null,
    device: device ?? null,
    needsChange,
    hasPendingConflict,
  };
}

export async function runAgent({ browser, portal, config, desk, clock, state, evidence }) {
  const baseUrl = config.baseUrl;
  const runRecord = { phase: clock.phase, at: clock.iso, actions: [], warnings: [] };

  // 1. 抓取市级公告（公开页面）。
  const bulletinPages = await discoverBulletins(browser, baseUrl, config);
  const allParagraphs = bulletinPages.flatMap((page) =>
    parseBulletin(page.paragraphs, { sites: Object.keys(desk.sites), year: config.bulletinYear }));
  const classified = classifyAll(allParagraphs, config.noticeKeywords);
  const signature = bulletinSignature(classified);

  // 中途紧急通知：签名变化时，本阶段所有待登记动作都按最新公告重算。
  if (state.lastBulletinSignature && state.lastBulletinSignature !== signature) {
    runRecord.warnings.push('检测到同范围公告新版本，已按最新原文重建全部待上屏页面，禁止版本混拼');
  }
  state.lastBulletinSignature = signature;
  state.latestClassified = classified;
  state.bulletins.push({ phase: clock.phase, at: clock.iso, paragraphs: classified });

  // 2. 抓取地方语言页并累积译文历史（只缓存已审条目，待审仅标记缺口）。
  const translationPages = await discoverTranslations(browser, baseUrl, config);
  const entries = translationPages.flatMap((page) => parseTranslationPage(page.paragraphs));
  state.translations = mergeTranslationHistory(state.translations, entries);

  const suspendedSites = activeSuspendedSites(classified, clock);

  // 3. 读取门户待办与设备组（可见界面）。
  const pendingPage = await portal.readPending();
  const pending = {
    operations: pendingPage.paragraphs
      .map((line) => parsePendingLine(line, config.localeLabels))
      .filter(Boolean),
    forms: pendingPage.forms,
  };

  // 4. 逐设备组处理。
  const currentTargets = [];
  const deviceSnapshot = [];
  for (const [groupPath, groupInfo] of Object.entries(config.groups)) {
    const groupRaw = await portal.readGroup(groupPath);
    const groupPage = {
      ...groupRaw,
      devices: groupRaw.paragraphs.map(parseDeviceLine).filter(Boolean),
    };
    for (const device of groupPage.devices) {
      deviceSnapshot.push({ ...device, site: groupInfo.site, groupPath });
    }

    for (const terminal of desk.sites[groupInfo.site]) {
      const locale = config.terminalLocale[terminal] ?? 'zh';
      const pages = [composeSitePage({
        site: groupInfo.site,
        locale,
        paragraphs: classified,
        history: state.translations,
        desk,
        clock,
      })];
      const decision = decideTarget({
        terminal, locale, site: groupInfo.site, pages, groupPage, pending,
      });
      currentTargets.push({
        terminal,
        locale,
        signature: decision.targetSignature,
        versions: decision.target.blocks.map((block) => block.refVersion),
      });

      const terminalState = state.terminals[terminal] ?? {
        terminal, site: groupInfo.site, locale, history: [],
      };

      // 4a. 离线设备挂着的旧换页：日期到点时失效清理优先。
      const staleOp = decision.pendingOperation;
      let cancelledThisRun = false;
      const mustCancel = staleOp && (decision.hasPendingConflict
        || (decision.target.suspended && staleOp.version
          && !decision.target.blocks.some((block) => block.refVersion === staleOp.version))
        || (staleOp.state !== 'displayed' && decision.target.suspended));
      if (staleOp && decision.device && (decision.device.offline || decision.device.reconnected)) {
        const cancellation = await portal.cancelOperation({
          operationId: staleOp.operationId,
          evidenceName: `${clock.phase}-${terminal}-${staleOp.operationId}`,
        });
        if (cancellation.cancelled) {
          cancelledThisRun = true;
          state.cancellations.push({
            operationId: staleOp.operationId, terminal, phase: clock.phase, ...cancellation,
          });
          runRecord.actions.push({ type: 'cancel', terminal, operationId: staleOp.operationId });
        }
      } else if (mustCancel) {
        runRecord.warnings.push(`终端 ${terminal} 的旧换页 ${staleOp.operationId} 需撤销但门户暂无入口，转人工`);
      }

      // 4b. 需要换页才登记；离线时门户仍可接收，设备回来后按待办执行。
      // 幂等：同一目标已有待确认登记、且门户待办里仍有该设备未撤销在途单时才跳过。
      // 本轮刚撤销旧单后待办已无在途单，必须补登记，不能被历史同签名登记挡住。
      const pendingStillActive = Boolean(decision.pendingOperation
        && !decision.pendingOperation.cancelled && !cancelledThisRun);
      const alreadyRegistered = state.registrations.some((item) =>
        item.terminal === terminal && item.targetSignature === decision.targetSignature
        && item.confirmed === false)
        && pendingStillActive;
      if (decision.needsChange && !alreadyRegistered) {
        const content = renderPageText(decision.target, {
          bulletin: config.bulletinsHome,
          translation: config.translationHome,
          generatedAt: clock.iso,
        });
        const noticeId = decision.target.blocks.find((block) => block.noticeType !== 'contact')?.id
          ?? decision.target.blocks[0]?.id
          ?? 'W6';
        const evidenceName = `${clock.phase}-${terminal}-${noticeId}`;
        const result = await portal.registerChange({
          groupPath,
          notice: noticeId,
          terminal,
          locale,
          content,
          evidenceName,
          labelMap: config.portalLabels ?? {},
        });

        const registration = {
          terminal,
          site: groupInfo.site,
          locale,
          phase: clock.phase,
          noticeId,
          targetSignature: decision.targetSignature,
          blocks: decision.target.blocks,
          usesSubstitute: decision.target.usesSubstitute,
          suspended: decision.target.suspended,
          content,
          // 登记时门户已存在的换页单号基线；确认只认基线之后新出现的已显示单，
          // 避免把预置回执（演练门户静态数据）误当成我们动作的结果。
          pendingBaseline: pending.operations.map((op) => op.operationId),
          previewEvidence: evidenceName + '-preview.html',
          receiptEvidence: evidenceName + '-registered.html',
          registeredAt: result.registeredAt,
          confirmed: false,
        };
        state.registrations.push(registration);
        terminalState.history.push({ at: clock.iso, action: 'register', noticeId });
        runRecord.actions.push({ type: 'register', terminal, noticeId, evidence: evidenceName });
      }

      state.terminals[terminal] = terminalState;
    }
  }

  // 5. 回读待办，用门户可见状态确认哪些换页已被设备接收/显示。
  // 确认是“当前门户状态”而非持久历史：每轮先清空旧确认标记，按本轮回读重新判定，
  // 这样上一阶段的“已显示”不会让本阶段的新登记被误认为已完成。
  for (const registration of state.registrations) registration.confirmed = false;
  for (const cancellation of state.cancellations) cancellation.confirmed = false;
  const refreshed = await portal.readPending();
  const refreshedOps = refreshed.paragraphs
    .map((line) => parsePendingLine(line, config.localeLabels))
    .filter(Boolean);
  state.lastPending = refreshedOps;
  state.lastDevices = deviceSnapshot;
  runRecord.currentTargets = currentTargets;
  reconcileConfirmations(state, refreshedOps, currentTargets);

  state.phases.push(runRecord);
  return { state, runRecord, suspendedSites: [...suspendedSites] };
}

// 只有门户/设备登记显示“已显示/撤销已确认”才当作完成；否则保持待人工跟进。
// 确认条件全部满足才算数：同设备、同语言、版号属于当前目标、单号在该登记的基线之后出现。
function reconcileConfirmations(state, operations, currentTargets) {
  for (const op of operations) {
    if (op.cancelled && op.confirmed) {
      const record = state.cancellations.find((item) => item.operationId === op.operationId);
      if (record) record.confirmed = true;
    }
    if (op.state === 'displayed') {
      const target = currentTargets.find((item) => item.terminal === op.terminal && item.locale === op.locale);
      if (!target || !target.versions.includes(op.version)) continue;
      const registration = [...state.registrations]
        .reverse()
        .find((item) => item.terminal === op.terminal && item.locale === op.locale
          && item.targetSignature === target.signature
          && item.confirmed === false
          && !item.pendingBaseline.includes(op.operationId));
      if (registration) registration.confirmed = true;
    }
  }
}

export async function runWithState({ browser, portal, config, desk, clock, statePath, evidence }) {
  const state = loadState(statePath);
  const result = await runAgent({ browser, portal, config, desk, clock, state, evidence });
  saveState(statePath, state);
  return result;
}

// 按最新公告与译文历史，为每台终端重新合成当前目标页面，供报告实时判断替代状态。
export function composeCurrentTargets({ state, desk, config, clock, classified }) {
  const targets = {};
  for (const [site, terminals] of Object.entries(desk.sites)) {
    for (const terminal of terminals) {
      const locale = config.terminalLocale[terminal] ?? 'zh';
      targets[terminal] = composeSitePage({
        site, locale, paragraphs: classified, history: state.translations, desk, clock,
      });
    }
  }
  return targets;
}
export function translationGaps(target, history) {
  return target.blocks
    .filter((block) => block.translationStatus === 'pending-review' || block.translationStatus === 'missing')
    .map((block) => ({
      id: block.id,
      refVersion: block.refVersion,
      reason: block.translationStatus,
      pendingTranslationExists: Boolean(findReviewedTranslation(history, {
        id: block.id, refVersion: block.refVersion,
      })) === false && block.translationStatus === 'pending-review',
    }));
}
