// 区域值班记录：按服务点区分
// 门户已接收 / 设备已显示 / 替代文案仍在使用 / 需要人工上屏，
// 并说明已显示内容来自何时发布的原文与译文。

import { versionFamily } from './notices.mjs';

function latestRegistration(state, terminal) {
  return [...state.registrations].reverse().find((item) => item.terminal === terminal) ?? null;
}

function latestBulletinForBlock(state, block) {
  for (const snapshot of [...state.bulletins].reverse()) {
    const found = snapshot.paragraphs.find((paragraph) => paragraph.id === block.id
      && paragraph.refVersion === block.refVersion);
    if (found) return { snapshot, paragraph: found };
  }
  return null;
}

function translationLineage(state, block) {
  // 通知段落（如 U4）的译文挂在所替代服务段落（W6-H）名下，
  // 优先按核对时记录的译文段落 id 找，再退回同版号家族匹配。
  const family = versionFamily(block.refVersion ?? block.id);
  const entry = state.translations.find((item) =>
    (item.id === block.id || item.id === block.translationParagraphId
      || versionFamily(item.refVersion ?? item.id) === family)
    && item.refVersion === block.refVersion);
  if (!entry) return null;
  return {
    paragraphId: entry.id,
    refVersion: entry.refVersion,
    status: entry.status,
    raw: entry.raw,
  };
}

function terminalStatus({ state, terminal, pendingOperations, currentTarget }) {
  const registration = latestRegistration(state, terminal);
  const pending = pendingOperations.find((op) => op.terminal === terminal);
  const device = (state.lastDevices ?? []).find((item) => item.terminal === terminal);

  // 设备已显示：门户待办明确“已显示”、设备组页写明当前显示版号、或我们登记的换页已确认。
  const displayedVersions = [
    ...(pending?.state === 'displayed' ? [pending.version] : []),
    ...(device?.displayedVersion ? [device.displayedVersion] : []),
  ];
  const deviceDisplayed = Boolean(registration?.confirmed
    || pending?.state === 'displayed' || device?.displayedVersion);
  const portalReceived = Boolean(registration || pending || device);

  // 设备当前显示版号是否已覆盖目标里的服务段（按版号家族比较）。
  // 通用联系段常驻所有页面、不参与版号覆盖判断；停办页只要求停办口径已上屏。
  const serviceBlocks = (currentTarget?.blocks ?? [])
    .filter((block) => block.noticeType !== 'contact');
  const targetSatisfied = Boolean(currentTarget && serviceBlocks.length > 0
    && serviceBlocks.every((block) => displayedVersions
      .some((version) => versionFamily(version) === versionFamily(block.refVersion)))
    && !currentTarget.usesSubstitute);

  // 需要人工上屏：目标未满足、且没有任何已确认显示。
  const needsManual = !deviceDisplayed || !targetSatisfied;

  // “替代文案仍在使用”按当前目标实时判断，不看登记当时的历史状态。
  const substituteInUse = Boolean(deviceDisplayed && currentTarget?.usesSubstitute);

  return {
    terminal,
    site: registration?.site ?? state.terminals[terminal]?.site ?? null,
    locale: registration?.locale ?? state.terminals[terminal]?.locale ?? null,
    portalReceived,
    deviceDisplayed,
    substituteInUse,
    needsManual,
    pending: pending ?? null,
    registration: registration ? summarizeRegistration(registration) : null,
  };
}

function summarizeRegistration(registration) {
  return {
    phase: registration.phase,
    noticeId: registration.noticeId,
    registeredAt: registration.registeredAt,
    confirmed: registration.confirmed,
    suspended: registration.suspended,
    usesSubstitute: registration.usesSubstitute,
    content: registration.content,
    evidence: {
      preview: registration.previewEvidence,
      receipt: registration.receiptEvidence,
    },
  };
}

export function buildReport(state, desk, clock, currentTargets = {}) {
  const pendingOperations = state.lastPending ?? [];
  const bySite = {};
  for (const [site, terminals] of Object.entries(desk.sites)) {
    bySite[site] = terminals.map((terminal) => {
      const status = terminalStatus({
        state, terminal, pendingOperations, currentTarget: currentTargets[terminal],
      });
      const registration = latestRegistration(state, terminal);
      status.lineage = registration?.blocks.map((block) => {
        const bulletin = latestBulletinForBlock(state, block);
        return {
          id: block.id,
          refVersion: block.refVersion,
          displayStatus: block.status,
          sourcePublishedAt: bulletin?.snapshot?.at ?? null,
          sourceEffectiveAt: bulletin?.paragraph?.effectiveAt?.toISOString?.() ?? null,
          translation: translationLineage(state, block),
        };
      }) ?? [];
      return status;
    });
  }

  const summary = {
    generatedAt: clock.iso,
    phase: clock.phase,
    sites: Object.fromEntries(Object.entries(bySite).map(([site, rows]) => [site, {
      portalReceived: rows.filter((row) => row.portalReceived).map((row) => row.terminal),
      deviceDisplayed: rows.filter((row) => row.deviceDisplayed).map((row) => row.terminal),
      substituteInUse: rows.filter((row) => row.substituteInUse).map((row) => row.terminal),
      needsManual: rows.filter((row) => row.needsManual).map((row) => row.terminal),
    }])),
  };

  return { summary, bySite, warnings: state.phases.flatMap((phase) => phase.warnings) };
}

// 统一按东八区显示时间，避免出现 UTC 的 Z 字尾让值班人员误读。
function formatShanghai(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date).replace(' ', 'T') + '+08:00';
}

export function renderReportMarkdown(report) {
  const lines = [`# 区域值班换页记录（${report.summary.phase} / ${report.summary.generatedAt}）`, ''];
  for (const [site, bucket] of Object.entries(report.summary.sites)) {
    lines.push(`## ${site}`);
    lines.push(`- 门户已接收：${bucket.portalReceived.join('、') || '无'}`);
    lines.push(`- 设备已显示：${bucket.deviceDisplayed.join('、') || '无'}`);
    lines.push(`- 替代文案仍在使用：${bucket.substituteInUse.join('、') || '无'}`);
    lines.push(`- 需要人工上屏：${bucket.needsManual.join('、') || '无'}`);
    lines.push('');
  }
  for (const [site, rows] of Object.entries(report.bySite)) {
    lines.push(`### ${site} 明细`);
    for (const row of rows) {
      lines.push(`- ${row.terminal}（${row.locale}）：${row.deviceDisplayed ? '设备已显示' : row.portalReceived ? '门户已接收待显示' : '需人工上屏'}`
        + `${row.substituteInUse ? '；含应急替代文案' : ''}`);
      for (const lineage of row.lineage) {
        const translation = lineage.translation
          ? `${lineage.translation.status === 'reviewed' ? '已审译文' : '待审（未上屏）'}`
          : '官方原文/应急文字';
        lines.push(`  - ${lineage.id}/${lineage.refVersion ?? '-'}：原文发布 ${formatShanghai(lineage.sourcePublishedAt) ?? '未知'}`
          + `，生效 ${formatShanghai(lineage.sourceEffectiveAt) ?? '持续有效'}，译文来源：${translation}`);
      }
    }
    lines.push('');
  }
  if (report.warnings.length) {
    lines.push('## 过程告警');
    for (const warning of [...new Set(report.warnings)]) lines.push(`- ${warning}`);
  }
  return lines.join('\n');
}
