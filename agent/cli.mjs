#!/usr/bin/env node
// 演练命令行：取公告、组页面、在屏控门户可见界面上取消/预览/登记，并输出按服务点的
// 状态与出处。所有数据都是合成演练资料，不接触真实人员信息。
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadJSON, runCycle } from './run.mjs';

const USAGE = `用法：
  node agent/cli.mjs run [选项]
  node agent/cli.mjs report [--out var]

选项：
  --step=<primary|stale|urgent|reconnect|display>  推进演练时钟
  --base-url=http://127.0.0.1:4173                 来源与门户地址（默认读 SOURCE_PORT/PORT）
  --config=agent/config.json                       演练配置
  --desk=fixtures/desk.json                        值班资料（点位与设备、应急文字）
  --state=var/state.json                           译文快照与操作流水
  --out=var                                       预览截图与状态报告目录
  --dry-run                                        只预览，不登记
  --headed                                         以有头浏览器运行
  --json                                           把状态报告打印为 JSON
`;

const DEFAULTS = {
  baseUrl: `http://127.0.0.1:${process.env.SOURCE_PORT ?? process.env.PORT ?? 4173}`,
  config: 'agent/config.json',
  desk: 'fixtures/desk.json',
  state: 'var/state.json',
  out: 'var',
};

async function main(argv) {
  const [first = 'run', ...rest] = argv;
  const command = first.startsWith('-') ? 'run' : first;
  const args = first.startsWith('-') ? argv : rest;
  const { values } = parseArgs({
    args,
    options: {
      step: { type: 'string' },
      'base-url': { type: 'string' },
      config: { type: 'string' },
      desk: { type: 'string' },
      state: { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (command === 'report') return report(values);
  if (command !== 'run') throw new Error(`未知命令：${command}\n\n${USAGE}`);

  const config = await loadJSON(resolve(values.config ?? DEFAULTS.config), {});
  const desk = await loadJSON(resolve(values.desk ?? DEFAULTS.desk));
  const baseUrl = (values['base-url'] ?? config.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, '');
  const out = resolve(values.out ?? DEFAULTS.out);

  const result = await runCycle({
    baseUrl,
    config,
    desk,
    statePath: resolve(values.state ?? DEFAULTS.state),
    outDir: out,
    step: values.step ?? null,
    dryRun: Boolean(values['dry-run']),
    headed: Boolean(values.headed),
    logger: (line) => process.stderr.write(line + '\n'),
  });

  if (values.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    printReport(result);
    process.stdout.write(`\n状态报告：${join(out, 'status.json')}\n`);
  }
}

async function report(values) {
  const out = resolve(values.out ?? DEFAULTS.out);
  const status = await loadJSON(join(out, 'status.json'), null);
  if (!status) throw new Error(`${join(out, 'status.json')} 不存在，请先执行 run`);
  if (values.json) process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  else printReport(status);
}

export function printReport(status) {
  const lines = [];
  lines.push(`演练阶段：${status.step ?? '（不推进）'}    区域：${status.region ?? '—'}`);
  if (status.dryRun) lines.push('模式：dry-run（未登记任何换页）');
  for (const site of status.sites ?? []) {
    lines.push('');
    lines.push(`服务点 ${site.site}`);
    lines.push(
      `  门户已接收 ${site.summary.portalAccepted} · 设备已显示 ${site.summary.deviceDisplayed} · ` +
        `替代文案在用 ${site.summary.fallbackInUse ? '是' : '否'} · 需人工上屏 ${site.summary.manualNeeded ? '是' : '否'}`,
    );
    for (const device of site.devices) {
      lines.push(
        `  - ${device.device}（${device.locale}，${device.capability === 'group' ? '整组启用' : '单页'}）` +
          `：${device.statusLabel}${device.fallbackInUse ? '（含应急文字）' : ''}；` +
          `期望版本 ${device.desiredVersions.join('/') || '—'}；实际显示 ${device.displayedVersion ?? '—'}`,
      );
    }
    for (const pending of site.pending) {
      lines.push(`  · 待办 ${pending.id} → ${pending.device} ${pending.version ?? ''} ${pending.locale ?? ''}：${pending.statusLabel}`);
    }
    if (site.provenance?.lastRegisteredAt) {
      lines.push(
        `  出处：${site.provenance.noticeTitle}（${site.provenance.noticeId}，发布 ` +
          `${site.provenance.sourcePublishedAt ?? '未注明'}，登记 ${site.provenance.lastRegisteredAt}）`,
      );
      for (const translation of site.provenance.lastRegisteredTranslations ?? []) {
        lines.push(
          `  译文：版号 ${translation.version ?? '—'}，发布 ${translation.publishedAt ?? '未注明'}，` +
            `抓取 ${translation.retrievedAt ?? '—'}`,
        );
      }
    }
    for (const edition of site.editions.filter(Boolean)) {
      const flags = [edition.blocked ? '停办生效' : null, edition.fallbackInUse ? '含应急文字' : null]
        .filter(Boolean)
        .join('，');
      lines.push(`  页面（${edition.locale}${flags ? '，' + flags : ''}）：${edition.content.replace(/\n/g, ' / ')}`);
    }
  }
  const cancelled = (status.actions ?? []).filter((action) => action.kind === 'cancel');
  if (cancelled.length > 0) {
    lines.push('');
    for (const action of cancelled) {
      lines.push(`失效清理：${action.pendingId}（${action.device}）→ ${action.result}，${action.reason}`);
    }
  }
  const blocked = (status.events ?? []).filter((event) => event.kind === 'blocked' || event.kind === 'superseded-preview');
  for (const event of blocked) {
    lines.push(`画面拦截：${event.device} ${event.locale}——${event.reason}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`演练失败：${error.message}\n`);
    if (process.env.DEBUG) process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}

export { main, DEFAULTS };
