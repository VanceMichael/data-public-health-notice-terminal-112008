import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createSource } from '../sources/source.mjs';

const navigation = JSON.parse(readFileSync(new URL('../fixtures/browser.json', import.meta.url)));

test('在 Chromium 中查看页面并操作门户表单', async (context) => {
  const server = createSource();
  context.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base + navigation.home);
  await page.getByRole('link', { name: navigation.link, exact: true }).click();
  await page.getByRole('heading', { name: navigation.heading, exact: true }).waitFor();
  await page.getByLabel(navigation.label, { exact: true }).fill(navigation.input);
  await page.getByRole('button', { name: navigation.submit, exact: true }).click();
  await page.getByText(navigation.confirmation, { exact: true }).waitFor();
  await page.getByText(navigation.entered, { exact: true }).waitFor();

  const phase = await fetch(`${base}/_source_clock?step=${navigation.next}`, { method: 'PUT' });
  await phase.json();
  await page.goto(base + navigation.home);
  await page.getByRole('link', { name: navigation.link, exact: true }).click();
  await page.getByText(navigation.changed, { exact: true }).waitFor();
  assert.equal((await page.locator('html').getAttribute('lang')), 'zh-CN');
});
