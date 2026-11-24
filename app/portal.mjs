// 屏控门户操作层：只通过演练门户的可见界面办理，不直接打内部接口。
// 每次换页都必须先取得主管可核对的预览，再凭确认码登记；
// 登记/生效/撤销都保留页面凭据，便于值班人员事后核对。

import { readPage } from './browser.mjs';

export class Portal {
  constructor({ browser, config, evidence, baseUrl }) {
    this.browser = browser;
    this.config = config;
    this.evidence = evidence;
    this.baseUrl = baseUrl;
  }

  async #openPage() {
    const page = await this.browser.newPage();
    return page;
  }

  // 若门户配置了演练登录信息，先在可见登录表单上完成登录。
  async loginIfNeeded(page) {
    if (!this.config.login) return;
    await page.goto(this.baseUrl + this.config.screensHome, { waitUntil: 'domcontentloaded' });
    const user = page.getByLabel(this.config.login.userLabel);
    if (await user.count()) {
      await user.fill(this.config.login.username);
      await page.getByLabel(this.config.login.passwordLabel).fill(this.config.login.password);
      await page.getByRole('button', { name: this.config.login.submit }).click();
      await page.waitForLoadState('domcontentloaded');
    }
  }

  async readHome() {
    const page = await this.#openPage();
    try {
      await this.loginIfNeeded(page);
      return await readPage(page, this.baseUrl + this.config.screensHome);
    } finally {
      await page.close();
    }
  }

  async readGroup(path) {
    const page = await this.#openPage();
    try {
      return await readPage(page, this.baseUrl + path);
    } finally {
      await page.close();
    }
  }

  async readPending() {
    const page = await this.#openPage();
    try {
      return await readPage(page, this.baseUrl + this.config.pendingPath);
    } finally {
      await page.close();
    }
  }

  // 演练门户的 label 有的包着控件（文字会混入选项），定位先按可见标签，
  // 失败再回退到表单字段名，始终只操作页面上真实存在的可见控件。
  async #byLabelOrName(page, label, name) {
    const byLabel = page.getByLabel(label, { exact: true });
    if (await byLabel.count()) return byLabel;
    const byName = page.locator(`[name="${name}"]`);
    if (await byName.count()) return byName;
    throw new Error(`门户表单里找不到字段：${label}（name=${name}）`);
  }

  // 走完“填表单 → 查看预览 → 主管确认码 → 登记”的可见流程。
  // 返回预览凭据与登记凭据；任何一步缺少确认信号都会抛错，避免误登记。
  async registerChange({ groupPath, notice, terminal, locale, content, labelMap, evidenceName }) {
    const page = await this.#openPage();
    try {
      await page.goto(this.baseUrl + groupPath, { waitUntil: 'domcontentloaded' });

      await (await this.#byLabelOrName(page, labelMap.notice ?? '公告识别码', 'notice')).fill(notice);
      const terminalField = page.getByLabel(labelMap.terminal ?? '设备', { exact: true });
      if (await terminalField.count()) await terminalField.fill(terminal);
      const localeField = await this.#byLabelOrName(page, labelMap.locale ?? '语言', 'locale');
      await localeField.selectOption(locale);
      await (await this.#byLabelOrName(page, labelMap.content ?? '页面文字', 'content')).fill(content);
      await page.getByRole('button', { name: labelMap.submit ?? '查看换页预览', exact: true }).click();

      await page.getByText('请核对本次公告、语言与设备页面。', { exact: true }).waitFor();
      const preview = await readPage(page, page.url());
      this.evidence.save(`${evidenceName}-preview.html`, await page.content());

      await (await this.#byLabelOrName(page, labelMap.approval ?? '主管确认码', 'approval'))
        .fill(this.config.approvalCode);
      await page.getByRole('button', { name: labelMap.register ?? '登记换页', exact: true }).click();
      await page.getByRole('heading', { name: '已登记', exact: true }).waitFor();

      const receipt = await readPage(page, page.url());
      this.evidence.save(`${evidenceName}-registered.html`, await page.content());
      return { preview, receipt, registeredAt: new Date().toISOString() };
    } finally {
      await page.close();
    }
  }

  // 通过待办页上的可见撤销按钮取消旧换页单。
  async cancelOperation({ operationId, evidenceName }) {
    const page = await this.#openPage();
    try {
      await page.goto(this.baseUrl + this.config.pendingPath, { waitUntil: 'domcontentloaded' });
      const button = page.getByRole('button', { name: `取消旧换页 ${operationId}`, exact: true });
      if (!(await button.count())) {
        return { cancelled: false, reason: '门户上没有可见的撤销入口' };
      }
      await button.click();
      await page.getByRole('heading', { name: '旧换页已撤', exact: true }).waitFor();
      this.evidence.save(`${evidenceName}-cancel.html`, await page.content());
      return { cancelled: true, cancelledAt: new Date().toISOString() };
    } finally {
      await page.close();
    }
  }
}
