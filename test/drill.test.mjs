import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import { runCycle } from '../agent/run.mjs';

const desk = JSON.parse(readFileSync(new URL('../fixtures/desk.json', import.meta.url)));
const config = {
  portal: { approvalCode: 'DRILL-SUPERVISOR-0417' },
  terminals: { N1: { locale: 'en' }, N2: { locale: 'en' }, S1: { locale: 'zh' } },
};

async function harness(context) {
  const server = createSource();
  context.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const outDir = await mkdtemp(join(tmpdir(), 'notice-drill-'));
  context.after(() => rm(outDir, { recursive: true, force: true }));
  const calls = async () => (await fetch(baseUrl + '/_source_calls')).json();
  return { baseUrl, outDir, statePath: join(outDir, 'state.json'), calls };
}

test('从公开页面到门户登记：预览确认后才登记，并留下出处与截图', async (context) => {
  const { baseUrl, outDir, statePath, calls } = await harness(context);
  const report = await runCycle({ baseUrl, config, desk, outDir, statePath, step: 'primary' });

  const north = report.sites.find((site) => site.site === '北桥点');
  const register = report.actions.find((action) => action.kind === 'register');
  assert.ok(register, '应有一次登记');
  assert.equal(register.device, 'N2');
  assert.equal(register.result, 'accepted');
  assert.match(register.content, /North Bridge desk open from 09:00 to 16:00/);
  assert.equal(register.preview.confirmed, true);
  assert.ok(register.source.url.endsWith('/bulletins/W6'));
  assert.ok(register.translations.some((entry) => entry.version === 'H1'));

  // 预览截图与 HTML 留档确实写入磁盘。
  const screenshot = await readFile(register.preview.screenshotPath);
  assert.ok(screenshot.length > 0);
  const archived = await readFile(register.preview.htmlPath, 'utf8');
  assert.match(archived, /公告 W6，设备 N2，语言 en/);

  // 门户收到的是可见表单提交，而不是脚本直连。
  const log = await calls();
  const previewPost = log.find((call) => call.path === '/screens/preview');
  const registerPost = log.find((call) => call.path === '/screens/register');
  assert.ok(previewPost.body.includes('terminal=N2'));
  assert.ok(previewPost.body.includes('locale=en'));
  assert.ok(registerPost.body.includes('approval='));

  // 登记之前一定先出预览。
  assert.ok(log.indexOf(previewPost) < log.indexOf(registerPost));

  // 北桥设备组按服务点汇总：门户已接收、设备已显示、替代文案、需人工上屏。
  assert.equal(north.devices.find((device) => device.device === 'N2').status, 'accepted');
  assert.equal(north.provenance.lastRegisteredContentHash, register.contentHash);
  assert.equal(north.provenance.lastRegisteredNoticeCode, 'W6');

  const status = JSON.parse(await readFile(join(outDir, 'status.json'), 'utf8'));
  assert.equal(status.sites.length, 2);
  assert.ok((await readFile(statePath, 'utf8')).includes('"cache"'));
});

test('停办生效时单页离线设备先清理旧换页，再显示应急联系', async (context) => {
  const { baseUrl, outDir, statePath, calls } = await harness(context);
  const report = await runCycle({ baseUrl, config, desk, outDir, statePath, step: 'reconnect' });

  const cancelled = report.actions.find((action) => action.kind === 'cancel');
  assert.ok(cancelled, '应清理挂起的旧换页 P41');
  assert.equal(cancelled.pendingId, 'P41');
  // 门户只回“仍待设备确认撤销”时应如实记为“撤销待确认”，不能写成已完成。
  assert.equal(cancelled.result, 'cancel-requested');
  assert.equal(cancelled.receipt.deviceConfirmed, false);
  assert.match(cancelled.reason, /停办/);

  const log = await calls();
  const cancelIndex = log.findIndex((call) => call.path === '/screens/cancel/P41');
  const firstRegister = log.findIndex((call) => call.path === '/screens/register');
  assert.ok(cancelIndex !== -1 && cancelIndex < firstRegister, '失效清理必须先于新登记');

  const register = report.actions.find((action) => action.kind === 'register' && action.device === 'N1');
  assert.ok(register.content.includes('Contact the service desk at extension 702.'));
  assert.equal(register.blocked, true);
  assert.equal(register.fallbackInUse, true);
  assert.equal(register.content.includes('09:00 to 16:00'), false);

  // 单页设备一次只登记一页，保证一个公告版本不被拼在一起。
  const north = report.sites.find((site) => site.site === '北桥点');
  assert.equal(north.devices.find((device) => device.device === 'N1').capability, 'single');
});

test('同范围通知在门户处理中途生效时重新核对等待画面，旧预览留凭据', async (context) => {
  const { baseUrl, outDir, statePath } = await harness(context);
  let fired = false;
  const report = await runCycle({
    baseUrl,
    config,
    desk,
    outDir,
    statePath,
    step: 'stale',
    onBeforeRegister: async () => {
      if (fired) return;
      fired = true;
      const response = await fetch(`${baseUrl}/_source_clock?step=urgent`, { method: 'PUT' });
      await response.json();
    },
  });

  assert.equal(fired, true);
  const discarded = report.discardedPreviews;
  assert.equal(discarded.length >= 1, true, '应留下被作废的预览');
  const first = discarded[0];
  assert.equal(first.kind, 'superseded-preview');
  assert.ok(first.preview.screenshotPath, '被作废的预览也要有截图凭据');
  assert.notEqual(first.contentHash, first.supersededBy.contentHash);
  assert.ok(first.supersededBy.versions.includes('H3'));

  // 最终登记的是核对后的新版本，而不是旧预览的画面。
  const registers = report.actions.filter((action) => action.kind === 'register');
  assert.ok(registers.length >= 1);
  for (const action of registers) {
    assert.ok(action.versions.includes('H3'), `${action.device} 仍登记了旧版本 ${action.versions}`);
    assert.equal(action.content.includes('North Bridge desk open'), false);
  }
});

test('dry-run 只预览不登记', async (context) => {
  const { baseUrl, outDir, statePath, calls } = await harness(context);
  const report = await runCycle({ baseUrl, config, desk, outDir, statePath, step: 'primary', dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.actions.some((action) => action.kind === 'register'), false);
  const log = await calls();
  assert.equal(log.some((call) => call.path === '/screens/register'), false);
  assert.ok(report.actions.some((action) => action.kind === 'preview'));
});

test('状态报告能按服务点区分四种情况并追到原文与译文出处', async (context) => {
  const { baseUrl, outDir, statePath } = await harness(context);
  // 先用 reconnect 登记新版本，再由 display 阶段核对设备实际显示与出处追溯。
  await runCycle({ baseUrl, config, desk, outDir, statePath, step: 'reconnect' });
  await runCycle({ baseUrl, config, desk, outDir, statePath, step: 'display' });
  const status = JSON.parse(await readFile(join(outDir, 'status.json'), 'utf8'));

  for (const site of status.sites) {
    assert.ok(site.summary);
    assert.equal(typeof site.summary.portalAccepted, 'number');
    assert.equal(typeof site.summary.deviceDisplayed, 'number');
    assert.equal(typeof site.summary.fallbackInUse, 'boolean');
    assert.equal(typeof site.summary.manualNeeded, 'boolean');
    for (const device of site.devices) {
      assert.ok(['displayed', 'accepted', 'fallback', 'manual'].includes(device.status));
      assert.ok(Array.isArray(device.desiredVersions));
    }
  }

  const north = status.sites.find((site) => site.site === '北桥点');
  const n1 = north.devices.find((device) => device.device === 'N1');
  assert.equal(n1.displayedVersion, 'H3');
  assert.equal(n1.status, 'displayed');
  assert.equal(north.provenance.noticeTitle, '北桥冬季服务 W6');
  assert.ok(north.provenance.sourceUrl.endsWith('/bulletins/W6'));
  assert.ok(north.provenance.lastRegisteredTranslations.length >= 1);
  for (const translation of north.provenance.lastRegisteredTranslations) {
    assert.ok(translation.version);
    assert.ok(translation.retrievedAt);
  }
});

test('设备实际显示旧版时不算完成', async (context) => {
  const { baseUrl, outDir, statePath } = await harness(context);
  const report = await runCycle({ baseUrl, config, desk, outDir, statePath, step: 'stale' });
  const north = report.sites.find((site) => site.site === '北桥点');
  const n1 = north.devices.find((device) => device.device === 'N1');
  // N1 离线且仍挂着旧画面，不能被记成“设备已显示”。
  assert.equal(n1.status, 'manual');
  assert.equal(n1.statusLabel, '需要人工上屏');
});
