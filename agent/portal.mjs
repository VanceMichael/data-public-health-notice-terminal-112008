// 屏控门户读取与操作。
//
// 所有会改变门户状态的动作都通过 Playwright 在“可见界面”上完成：填表、点击
// 预览、填写主管确认码、登记、取消旧换页。本模块不做任何直接 POST。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { decodeEntities, escapeHtml } from './notice.mjs';

const LOCALES = {
  中文: 'zh',
  汉语: 'zh',
  英语: 'en',
  英文: 'en',
  zh: 'zh',
  en: 'en',
};

export const STATUS_LABELS = {
  displayed: '设备已显示',
  accepted: '门户已接收',
  cancelled: '撤销已确认',
  cancel_pending: '等待设备确认撤销',
  unknown: '状态不明',
};

function paragraphsOf(html) {
  return [...String(html).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => decodeEntities(match[1]));
}

export function classifyStatus(text) {
  const value = String(text ?? '');
  if (/撤销已确认/.test(value)) return 'cancelled';
  if (/待设备确认撤销|撤销中/.test(value)) return 'cancel_pending';
  if (/(?<!未)已显示|已生效/.test(value)) return 'displayed';
  if (/设备已接收|已登记|待执行|已接收|待确认|排队/.test(value)) return 'accepted';
  return 'unknown';
}

/** 解析“换页待办”页。行格式：P41，N1，H1，英语，设备已接收未显示。 */
export function parsePendingPage(html) {
  const rows = [];
  for (const text of paragraphsOf(html)) {
    const match = /^(P\d+)[，,]\s*(.*)$/.exec(text);
    if (!match) continue;
    const [, id, rest] = match;
    const fields = rest
      .split(/[，,]/)
      .map((field) => field.trim())
      .filter(Boolean);
    const localeEntry = fields.find((field) => LOCALES[field]);
    const locale = localeEntry ? LOCALES[localeEntry] : null;
    const withoutLocale = fields.filter((field) => field !== localeEntry);
    const device = withoutLocale.find((field) => /^[A-Z]{1,3}\d+$/.test(field)) ?? null;
    const version =
      withoutLocale.filter((field) => /^[A-Z]{1,3}\d+$/.test(field)).find((field) => field !== device) ?? null;
    const statusText = fields.at(-1) ?? '';
    rows.push({
      id,
      device,
      version,
      locale,
      status: classifyStatus(statusText),
      statusText,
      text,
      cancelAction: null,
    });
  }
  const cancelActions = [...String(html).matchAll(/action="(\/screens\/cancel\/(P\d+))"/g)].map((match) => ({
    action: match[1],
    pendingId: match[2],
  }));
  for (const entry of cancelActions) {
    const row = rows.find((candidate) => candidate.id === entry.pendingId);
    if (row) row.cancelAction = entry.action;
  }
  return { rows, cancelActions };
}

/** 解析设备组页：设备在线状态、当前显示版本、设备能力、停办提示与可用表单。 */
export function parseGroupPage(html, url = null) {
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const paragraphs = paragraphsOf(html);
  const text = paragraphs.join('\n');
  const devices = {};

  const ensure = (id) =>
    (devices[id] ??= {
      id,
      online: null,
      displayedVersion: null,
      displayedOld: false,
      pendingId: null,
      capability: null,
      note: null,
    });

  for (const paragraph of paragraphs) {
    // 设备号出现的每一段都建立设备条目，便于捕捉只在对能力说明里出现的设备。
    for (const match of paragraph.matchAll(/\b([A-Z]{1,3}\d+)\b/g)) ensure(match[1]);

    // 段落里点名了离线就不再推断成在线（“北桥停办已生效，N1 仍离线”这类写法）。
    if (/离线/.test(paragraph)) {
      for (const match of paragraph.matchAll(/\b([A-Z]{1,3}\d+)\b/g)) ensure(match[1]).online = false;
    }

    const displayed = /([A-Z]{1,3}\d+)[^。]*?当前显示(旧版)?\s*([A-Z]{1,3}\d+)/.exec(paragraph);
    if (displayed) {
      const entry = ensure(displayed[1]);
      entry.displayedVersion = displayed[3];
      entry.displayedOld = Boolean(displayed[2]);
      if (/离线/.test(paragraph)) entry.online = false;
      else if (/在线|已重连/.test(paragraph)) entry.online = true;
    }
    const shown = /([A-Z]{1,3}\d+)\s*已显示\s*([A-Z]{1,3}\d+)/.exec(paragraph);
    if (shown && !displayed) {
      const entry = ensure(shown[1]);
      entry.displayedVersion = shown[2];
      if (!/旧版/.test(paragraph)) entry.displayedOld = false;
      entry.online ??= true;
    }
    const pending = /([A-Z]{1,3}\d+)[^。]*?挂起旧换页\s*(P\d+)/.exec(paragraph);
    if (pending) {
      const entry = ensure(pending[1]);
      entry.pendingId = pending[2];
      entry.online = false;
    }
    // 能力说明常在同一个句子里列出多台设备：逐个设备读取紧随其后的描述。
    for (const match of paragraph.matchAll(/([A-Z]{1,3}\d+)\s*(仅支持单页换页|支持整组启用)/g)) {
      ensure(match[1]).capability = match[2] === '支持整组启用' ? 'group' : 'single';
    }
    const waiting = /([A-Z]{1,3}\d+)\s*等待换页确认/.exec(paragraph);
    if (waiting) ensure(waiting[1]).note = '等待换页确认';
    const connected = /([A-Z]{1,3}\d+)\s*已重连/.exec(paragraph);
    if (connected) ensure(connected[1]).online = true;
  }
  // 没写“在线/离线”的设备默认按在线处理，但仍以页面文字为准记录能力。
  for (const entry of Object.values(devices)) {
    if (!/离线/.test(text)) entry.online ??= true;
  }

  const forms = [...String(html).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((match) => {
    const action = /action="([^"]*)"/.exec(match[1])?.[1] ?? '';
    const body = match[2];
    const fields = [...body.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)].map((field) => {
      const attrs = field[2];
      return {
        tag: field[1].toLowerCase(),
        name: /name="([^"]*)"/.exec(attrs)?.[1] ?? null,
        value: /value="([^"]*)"/.exec(attrs)?.[1] ?? '',
      };
    });
    const options = [...body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((option) => ({
      value: /value="([^"]*)"/.exec(option[1])?.[1] ?? decodeEntities(option[2]),
      label: decodeEntities(option[2]),
    }));
    const buttons = [...body.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map((button) => decodeEntities(button[1]));
    return { action, method: /method="([^"]*)"/i.exec(match[1])?.[1]?.toUpperCase() ?? 'GET', fields, options, buttons };
  });

  return {
    url,
    heading: heading ? decodeEntities(heading[1]) : '',
    text,
    paragraphs,
    devices,
    closureSignaled: /停办已生效|停办生效/.test(text),
    forms,
    hasPreviewForm: forms.some((form) => form.action.includes('/screens/preview')),
    hasGroupControl: forms.some(
      (form) =>
        form.fields.some((field) => /group|整组|all/i.test(field.name ?? '')) ||
        form.buttons.some((button) => /整组启用/.test(button)),
    ),
  };
}

export function parseIndexLinks(html, root) {
  return [...String(html).matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({ href: match[1], text: decodeEntities(match[2]) }))
    .filter((link) => link.href.startsWith(root));
}

export class PortalDriver {
  constructor({ baseUrl, config = {}, outDir = 'var', headed = false, logger = () => {} }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.config = config;
    this.outDir = outDir;
    this.headed = headed;
    this.logger = logger;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async open() {
    this.browser = await chromium.launch({ headless: !this.headed });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    await this.page.goto(this.baseUrl + '/screens');
    await this.loginIfNeeded();
    return this;
  }

  async close() {
    await this.context?.close();
    await this.browser?.close();
  }

  async loginIfNeeded() {
    const password = this.page.locator('input[type="password"]');
    if ((await password.count()) === 0) return { loggedIn: false, reason: '门户未要求登录' };
    const credentials = this.config.credentials;
    if (!credentials?.username || !credentials?.password) {
      throw new Error('门户要求登录，但配置中没有演练凭据');
    }
    const user = this.page.locator('input[name="username"], input[name="user"], input[type="text"]').first();
    if ((await user.count()) > 0) await user.fill(credentials.username);
    await password.first().fill(credentials.password);
    const submit = this.page.getByRole('button', { name: /登录|登入/ }).first();
    await submit.click();
    await this.page.waitForLoadState('load');
    return { loggedIn: true };
  }

  async goto(path) {
    await this.page.goto(this.baseUrl + path, { waitUntil: 'load' });
  }

  async content() {
    return this.page.content();
  }

  /** 读取门户首页、各设备组与换页待办，返回结构化状态。 */
  async readState() {
    await this.goto('/screens');
    const home = await this.content();
    const links = parseIndexLinks(home, '/screens');
    const pendingLink = links.find((link) => link.href === '/screens/pending');
    const groupLinks = links.filter((link) => link.href !== '/screens/pending');

    const groups = [];
    for (const link of groupLinks) {
      await this.goto(link.href);
      groups.push({ ...parseGroupPage(await this.content(), link.href), path: link.href, linkText: link.text });
    }

    let pending = { rows: [], cancelActions: [] };
    if (pendingLink) {
      await this.goto(pendingLink.href);
      pending = parsePendingPage(await this.content());
    }
    return { home, groups, pending, groupLinks, pendingLink };
  }

  /** 打开预览页并截图留档；不提交登记。 */
  async preview({ groupPath, notice, device, locale, content }) {
    await this.goto(groupPath);
    const previewButton = this.page.getByRole('button', { name: '查看换页预览', exact: true });
    if ((await previewButton.count()) === 0) throw new Error('该设备组页面没有可见的换页表单');

    await this.fillField('公告识别码', 'notice', notice);
    await this.fillField('设备', 'terminal', device);
    await this.selectLocale(locale);
    await this.fillField('页面文字', 'content', content);

    const responsePromise = this.page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().includes('/screens/preview'),
    );
    await previewButton.click();
    const response = await responsePromise;
    await this.page.getByRole('heading', { name: '换页预览', exact: true }).waitFor();

    const text = await this.page.locator('main').innerText();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = `${device}-${locale}-${stamp}`;
    await mkdir(join(this.outDir, 'previews'), { recursive: true });
    const screenshotPath = join(this.outDir, 'previews', `${slug}.png`);
    const htmlPath = join(this.outDir, 'previews', `${slug}.html`);
    await this.page.screenshot({ path: screenshotPath, fullPage: true });
    await writeFile(
      htmlPath,
      `<!doctype html><meta charset="utf-8"><title>换页预览留档 ${escapeHtml(device)}</title>` +
        `<h1>换页预览留档</h1><p>设备 ${escapeHtml(device)}，语言 ${escapeHtml(locale)}。</p>` +
        `<pre>${escapeHtml(text)}</pre>`,
      'utf8',
    );

    // 预览页会回显表单收到的字段值；语言既可能是代码也可能是中文名称。
    const confirmed =
      text.includes(notice) &&
      text.includes(device) &&
      (text.includes(locale) || text.includes(localeLabel(locale)));
    return {
      status: response.status(),
      text,
      confirmed,
      screenshotPath,
      htmlPath,
      submittedAt: new Date().toISOString(),
      fields: { notice, device, locale, content },
    };
  }

  /** 在已打开的预览页上填写主管确认码并登记。 */
  async register({ approval }) {
    const button = this.page.getByRole('button', { name: '登记换页', exact: true });
    if ((await button.count()) === 0) throw new Error('预览页没有登记按钮，不能代替主管登记');
    await this.fillField('主管确认码', 'approval', approval);
    const responsePromise = this.page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().includes('/screens/register'),
    );
    await button.click();
    const response = await responsePromise;
    await this.page.getByRole('heading', { name: '已登记', exact: true }).waitFor();
    const text = await this.page.locator('main').innerText();
    return {
      status: response.status(),
      text,
      confirmed: /已登记|等待设备确认|已接收/.test(text),
      registeredAt: new Date().toISOString(),
    };
  }

  /** 从换页待办上取消指定旧换页（失效清理优先于新登记）。 */
  async cancel(pendingId) {
    await this.goto('/screens/pending');
    const button = this.page.getByRole('button', { name: new RegExp(`取消旧换页\\s*${pendingId}`) });
    if ((await button.count()) === 0) throw new Error(`待办 ${pendingId} 没有可见的取消按钮`);
    const responsePromise = this.page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes(`/screens/cancel/${pendingId}`),
    );
    await button.click();
    const response = await responsePromise;
    await this.page.waitForLoadState('load');
    const text = await this.page.locator('main').innerText();
    // 门户接收撤销 ≠ 设备已确认撤销；两者必须分开记录，值班才知道下一步要做什么。
    const deviceConfirmed = /撤销已确认/.test(text);
    const requested = /已撤|撤销/.test(text);
    return {
      status: response.status(),
      text,
      confirmed: requested,
      deviceConfirmed,
      result: deviceConfirmed ? 'cancelled' : requested ? 'cancel-requested' : 'unconfirmed',
      cancelledAt: new Date().toISOString(),
    };
  }

  async fillField(label, name, value) {
    const byLabel = this.page.getByLabel(label, { exact: true });
    if ((await byLabel.count()) > 0) {
      await byLabel.fill(value);
      return;
    }
    const byName = this.page.locator(`[name="${name}"]`);
    if ((await byName.count()) === 0) throw new Error(`表单缺少字段：${label}`);
    await byName.fill(value);
  }

  async selectLocale(locale) {
    const byName = this.page.locator('select[name="locale"]');
    const select = (await byName.count()) > 0 ? byName : this.page.getByLabel('语言');
    if ((await select.count()) === 0) throw new Error('门户的换页表单没有语言字段');
    try {
      await select.first().selectOption(locale);
    } catch {
      await select.first().selectOption({ label: localeLabel(locale) });
    }
    const chosen = await select.first().inputValue();
    if (chosen && chosen !== locale) throw new Error(`语言未能切换为 ${locale}（实际 ${chosen}）`);
  }
}

export function localeLabel(locale) {
  return locale === 'en' ? '英语' : '中文';
}
