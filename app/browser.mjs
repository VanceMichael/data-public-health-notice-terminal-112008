// Playwright 浏览器层：所有信息都通过渲染后的可见页面取得，
// 不调用来源服务的演练时钟等内部接口。

import { chromium } from 'playwright';

export async function launchBrowser() {
  const browser = await chromium.launch();
  return browser;
}

// 读取一个页面的结构化内容：标题、链接、段落与表单。
// 注意：传入当前页 URL 时不得重新 goto——表单 POST 后的结果页再导航会变成 GET。
export async function readPage(page, url) {
  if (url && new URL(url, page.url()).href !== page.url()) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const links = [...document.querySelectorAll('a[href]')].filter(visible)
      .map((anchor) => ({ text: anchor.textContent.trim(), href: anchor.getAttribute('href') }));
    const paragraphs = [...document.querySelectorAll('main p')].filter(visible)
      .map((element) => element.textContent.trim()).filter(Boolean);
    const headings = [...document.querySelectorAll('h1,h2,h3')].filter(visible)
      .map((element) => element.textContent.trim());
    const forms = [...document.querySelectorAll('form')].filter(visible).map((form) => ({
      action: form.getAttribute('action'),
      method: (form.getAttribute('method') || 'get').toLowerCase(),
      fields: [...form.querySelectorAll('input,textarea,select,button')].map((field) => ({
        tag: field.tagName.toLowerCase(),
        type: field.getAttribute('type'),
        name: field.getAttribute('name'),
        value: field.value ?? '',
        label: field.labels?.[0]?.textContent?.trim() ?? '',
        text: field.textContent?.trim() ?? '',
      })),
    }));
    return {
      url: window.location.href,
      title: document.title,
      lang: document.documentElement.getAttribute('lang'),
      headings,
      links,
      paragraphs,
      forms,
    };
  });
}

export async function withPage(browser, url, task) {
  const page = await browser.newPage();
  try {
    return await task(page);
  } finally {
    await page.close();
  }
}
