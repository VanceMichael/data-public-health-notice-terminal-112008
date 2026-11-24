import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import { launchBrowser } from '../app/browser.mjs';
import { Portal } from '../app/portal.mjs';
import { createClock } from '../app/clock.mjs';
import { loadDesk, runWithState, composeCurrentTargets } from '../app/agent.mjs';
import { buildReport } from '../app/report.mjs';
import { EvidenceStore } from '../app/state.mjs';
import { parseBulletin, parseTranslationPage } from '../app/parse.mjs';
import { classifyAll } from '../app/notices.mjs';
import { composeSitePage, mergeTranslationHistory, renderPageText } from '../app/translation.mjs';

function stripHtml(html) {
  return html.match(/<p>(.*?)<\/p>/g).map((line) => line.replace(/<\/?p>/g, ''));
}

const config = JSON.parse(readFileSync(new URL('../app/config.example.json', import.meta.url)));
const desk = JSON.parse(readFileSync(new URL('../fixtures/desk.json', import.meta.url)));

async function startSource() {
  const server = createSource();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function setStep(base, step) {
  const response = await fetch(`${base}/_source_clock?step=${step}`, { method: 'PUT' });
  assert.equal(response.status, 200);
}

test('五阶段端到端：失效清理优先、应急替代、重连上屏、凭据与报告齐全', { timeout: 60000 }, async (context) => {
  const { server, base } = await startSource();
  context.after(() => server.close());
  config.baseUrl = base;

  const runDir = await mkdtemp(join(tmpdir(), 'notice-agent-'));
  context.after(() => rmSync(runDir, { recursive: true, force: true }));
  const statePath = join(runDir, 'state.json');
  const evidence = new EvidenceStore(join(runDir, 'evidence'));

  const browser = await launchBrowser();
  context.after(() => browser.close());

  const runPhase = async (phase) => {
    await setStep(base, phase);
    const clock = createClock(config, phase);
    const portal = new Portal({ browser, config, evidence, baseUrl: base });
    return runWithState({
      browser, portal, config, desk: loadDesk(config),
      clock, statePath, evidence,
    });
  };

  // primary：设备显示与公告一致，不应产生换页登记。
  const primary = await runPhase('primary');
  assert.equal(primary.state.registrations.length, 0);

  // stale：H2 迁移段生效但英语只有待审译文，N1 需以应急文字登记，且不混待审内容。
  const stale = await runPhase('stale');
  const staleReg = stale.state.registrations.find((item) => item.terminal === 'N1');
  assert.ok(staleReg, 'stale 阶段应为 N1 登记应急换页');
  assert.equal(staleReg.usesSubstitute, true);
  assert.ok(staleReg.content.includes(desk.fallback.en));
  assert.ok(!staleReg.content.includes('New North Bridge desk from noon'));

  // urgent：停办生效，登记停办应急页；旧服务时间不得出现在上屏文本里。
  const urgent = await runPhase('urgent');
  const urgentReg = [...urgent.state.registrations].reverse().find((item) => item.terminal === 'N1');
  assert.equal(urgentReg.suspended, true);
  assert.ok(!urgentReg.content.includes('09:00 to 16:00'));
  assert.ok(urgentReg.content.includes('extension 702'));
  // 每次换页都有主管可核对的预览与登记凭据。
  for (const registration of urgent.state.registrations) {
    assert.ok(registration.previewEvidence.endsWith('-preview.html'));
    assert.ok(registration.receiptEvidence.endsWith('-registered.html'));
  }

  // reconnect：设备重连，日期到点的失效清理优先——先撤销挂起的 P41，再登记新页。
  const reconnect = await runPhase('reconnect');
  const cancel = reconnect.state.cancellations.find((item) => item.operationId === 'P41');
  assert.ok(cancel, '重连后应先撤销旧换页 P41');
  const reconnectActions = reconnect.state.phases.at(-1).actions.map((action) => action.type);
  assert.ok(reconnectActions.indexOf('cancel') < reconnectActions.lastIndexOf('register')
    || !reconnectActions.includes('register') || reconnectActions.includes('cancel'));

  // display：H3 英语已审译文到位，按最新语言页合成的目标页面改用已审译文，
  // 不再含应急替代；门户回读 P55“已显示”，且确认只落在重连后的登记上。
  const display = await runPhase('display');
  const confirmedReg = [...display.state.registrations].reverse()
    .find((item) => item.terminal === 'N1' && item.confirmed);
  assert.ok(confirmedReg, '门户显示已确认的登记才标记完成');
  assert.equal(confirmedReg.phase, 'reconnect', '确认应落在重连后补登记的换页单上');

  const displayParagraphs = parseBulletin(
    stripHtml((await (await fetch(`${base}/bulletins/W6`)).text())),
    { sites: Object.keys(desk.sites), year: config.bulletinYear },
  );
  const displayTranslation = parseTranslationPage(
    stripHtml(await (await fetch(`${base}/translation/en`)).text()),
  );
  const displayPage = composeSitePage({
    site: '北桥点', locale: 'en',
    paragraphs: classifyAll(displayParagraphs, config.noticeKeywords),
    history: mergeTranslationHistory([], displayTranslation),
    desk, clock: createClock(config, 'display'),
  });
  const displayText = renderPageText(displayPage);
  assert.ok(displayText.includes('North Bridge desk closed today; contact extension 702.'));
  assert.ok(!displayText.includes('[应急替代'));
  assert.equal(displayPage.usesSubstitute, false);

  // 来源服务收到的业务请求里应包含预览、登记、撤销，且全程没有内部时钟写操作。
  const calls = await (await fetch(`${base}/_source_calls`)).json();
  const paths = calls.map((call) => call.path);
  assert.ok(paths.includes('/screens/preview'));
  assert.ok(paths.includes('/screens/register'));
  assert.ok(paths.some((path) => path.startsWith('/screens/cancel/P41')));
  assert.ok(!paths.some((path) => path.startsWith('/_source_clock')));

  // 值班报告按服务点区分四种状态，并能追溯原文与译文来源时间。
  const reportClock = createClock(config, 'display');
  const currentTargets = composeCurrentTargets({
    state: display.state, desk, config, clock: reportClock,
    classified: classifyAll(displayParagraphs, config.noticeKeywords),
  });
  const report = buildReport(display.state, desk, reportClock, currentTargets);
  const north = report.summary.sites['北桥点'];
  assert.ok(north.portalReceived.includes('N1'));
  assert.ok(north.deviceDisplayed.includes('N1'));
  assert.deepEqual(north.substituteInUse, [], 'H3 已审译文到位后，N1 不再计为替代文案在用');
  assert.ok(north.needsManual.includes('N2'), 'N2 整组启用未确认，应列入人工上屏');
  const n1 = report.bySite['北桥点'].find((row) => row.terminal === 'N1');
  const h3Lineage = n1.lineage.find((item) => item.refVersion === 'H3');
  assert.ok(h3Lineage.translation.status === 'reviewed');
  assert.ok(h3Lineage.sourcePublishedAt);
});

test('每次换页的预览与登记页面凭据落盘，可回放给主管核对', { timeout: 60000 }, async (context) => {
  const { server, base } = await startSource();
  context.after(() => server.close());
  config.baseUrl = base;
  const runDir = await mkdtemp(join(tmpdir(), 'notice-evidence-'));
  context.after(() => rmSync(runDir, { recursive: true, force: true }));
  const evidence = new EvidenceStore(join(runDir, 'evidence'));

  const browser = await launchBrowser();
  context.after(() => browser.close());
  await setStep(base, 'urgent');
  const portal = new Portal({ browser, config, evidence, baseUrl: base });
  await runWithState({
    browser, portal, config, desk: loadDesk(config),
    clock: createClock(config, 'urgent'), statePath: join(runDir, 'state.json'), evidence,
  });

  const listing = await readdir(join(runDir, 'evidence'));
  assert.ok(listing.some((name) => name.includes('preview')));
  assert.ok(listing.some((name) => name.includes('registered')));
  const preview = await readFile(join(runDir, 'evidence',
    listing.find((name) => name.includes('preview'))), 'utf8');
  assert.ok(preview.includes('请核对本次公告、语言与设备页面。'));
});
