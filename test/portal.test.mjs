import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classifyStatus, parseGroupPage, parseIndexLinks, parsePendingPage } from '../agent/portal.mjs';

const data = JSON.parse(readFileSync(new URL('../fixtures/source.json', import.meta.url)));

const route = (step, key) => data.routes[step]?.[key]?.body ?? data.routes.common[key].body;

test('换页待办区分已接收、已显示与撤销', () => {
  const primary = parsePendingPage(route('primary', 'GET /screens/pending'));
  assert.equal(primary.rows.length, 1);
  assert.deepEqual(
    { id: primary.rows[0].id, device: primary.rows[0].device, version: primary.rows[0].version, locale: primary.rows[0].locale },
    { id: 'P41', device: 'N1', version: 'H1', locale: 'en' },
  );
  assert.equal(primary.rows[0].status, 'accepted');
  assert.equal(primary.rows[0].cancelAction, null);

  const reconnect = parsePendingPage(route('reconnect', 'GET /screens/pending'));
  assert.equal(reconnect.rows[0].cancelAction, '/screens/cancel/P41');
  assert.equal(reconnect.rows[0].status, 'accepted');

  const display = parsePendingPage(route('display', 'GET /screens/pending'));
  assert.deepEqual(
    display.rows.map((row) => [row.id, row.status]),
    [
      ['P41', 'cancelled'],
      ['P55', 'displayed'],
    ],
  );
  assert.equal(display.cancelActions.length, 0);
});

test('状态文字不会被“未显示”误判为已完成', () => {
  assert.equal(classifyStatus('设备已接收未显示。'), 'accepted');
  assert.equal(classifyStatus('已显示。'), 'displayed');
  assert.equal(classifyStatus('P41 仍待设备确认撤销。'), 'cancel_pending');
  assert.equal(classifyStatus('撤销已确认。'), 'cancelled');
});

test('设备组页读出设备能力、在线状态与当前画面', () => {
  const north = parseGroupPage(route('primary', 'GET /screens/north'));
  assert.equal(north.devices.N1.capability, 'single');
  assert.equal(north.devices.N1.displayedVersion, 'H1');
  assert.equal(north.devices.N1.displayedOld, true);
  assert.equal(north.devices.N2.capability, 'group');
  assert.equal(north.hasPreviewForm, true);
  assert.equal(north.closureSignaled, false);

  const offline = parseGroupPage(route('stale', 'GET /screens/north'));
  assert.equal(offline.devices.N1.online, false);
  assert.equal(offline.devices.N1.pendingId, 'P41');

  const urgent = parseGroupPage(route('urgent', 'GET /screens/north'));
  assert.equal(urgent.closureSignaled, true);

  const display = parseGroupPage(route('display', 'GET /screens/north'));
  assert.equal(display.devices.N1.displayedVersion, 'H3');
  assert.equal(display.devices.N1.displayedOld, false);
  assert.equal(display.devices.N1.online, true);
  assert.equal(display.devices.N2.note, '等待换页确认');

  const south = parseGroupPage(route('primary', 'GET /screens/south'));
  assert.equal(south.devices.S1.displayedVersion, 'S2');
  assert.equal(south.hasPreviewForm, false);
});

test('门户首页只取屏控站内链接', () => {
  const links = parseIndexLinks(route('primary', 'GET /screens'), '/screens');
  assert.deepEqual(
    links.map((link) => link.href),
    ['/screens/north', '/screens/south', '/screens/pending'],
  );
});
