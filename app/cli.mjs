#!/usr/bin/env node
// 命令行入口：
//   node app/cli.mjs run --phase urgent --config app/config.example.json
//   node app/cli.mjs report --phase display
//   node app/cli.mjs run-all            # 依次跑完全部演练阶段并生成最终报告
// 全程只使用演练门户的可见界面，不使用真实人员数据。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { Portal } from './portal.mjs';
import { createClock } from './clock.mjs';
import { loadDesk, runWithState, composeCurrentTargets } from './agent.mjs';
import { buildReport, renderReportMarkdown } from './report.mjs';
import { EvidenceStore, loadState } from './state.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[index + 1];
      if (next === undefined || next.startsWith('--')) options[key] = true;
      else {
        options[key] = next;
        index += 1;
      }
    } else {
      options._.push(token);
    }
  }
  return { command: command ?? 'run', options };
}

function loadConfig(path) {
  const configPath = resolve(ROOT, path);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config._configDir = dirname(configPath);
  return config;
}

// 仅在显式开启时推进来源服务的演练时钟。代办核心逻辑不依赖这个内部接口，
// 真实部署里阶段推进由外部调度负责，关闭开关即可完全只走公开/可见界面。
async function advanceSourceClock(config, phase) {
  if (!config.sourceClockControl?.enabled) return;
  const url = new URL(config.sourceClockControl.path, config.baseUrl);
  url.searchParams.set('step', phase);
  const response = await fetch(url, { method: 'PUT' });
  if (!response.ok) throw new Error(`来源时钟推进失败：${phase}（${response.status}）`);
}

async function runOnce({ phase, config, runDir }) {
  await advanceSourceClock(config, phase);
  const clock = createClock(config, phase);
  const desk = loadDesk(config);
  const evidence = new EvidenceStore(join(runDir, 'evidence'));
  const statePath = join(runDir, 'state.json');

  const browser = await launchBrowser();
  try {
    const portal = new Portal({ browser, config, evidence, baseUrl: config.baseUrl });
    const { runRecord, suspendedSites } = await runWithState({
      browser, portal, config, desk, clock, statePath, evidence,
    });
    return { runRecord, suspendedSites, statePath };
  } finally {
    await browser.close();
  }
}

function writeReport({ phase, config, runDir }) {
  const desk = loadDesk(config);
  const state = loadState(join(runDir, 'state.json'));
  const clock = createClock(config, phase);
  const currentTargets = composeCurrentTargets({
    state, desk, config, clock, classified: state.latestClassified ?? [],
  });
  const report = buildReport(state, desk, clock, currentTargets);
  const reportJson = join(runDir, `report-${phase}.json`);
  const reportMd = join(runDir, `report-${phase}.md`);
  writeFileSync(reportJson, JSON.stringify(report, null, 2));
  writeFileSync(reportMd, renderReportMarkdown(report));
  return { reportJson, reportMd, report };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const config = loadConfig(options.config ?? 'app/config.example.json');
  const runDir = resolve(ROOT, options.out ?? 'runs/latest');
  mkdirSync(runDir, { recursive: true });

  if (command === 'run') {
    const phase = options.phase ?? 'primary';
    const result = await runOnce({ phase, config, runDir });
    const paths = writeReport({ phase, config, runDir });
    process.stdout.write(JSON.stringify({
      ok: true, phase, actions: result.runRecord.actions,
      warnings: result.runRecord.warnings, reports: paths,
    }, null, 2) + '\n');
    return;
  }

  if (command === 'report') {
    const phase = options.phase ?? config.phaseTimes ? Object.keys(config.phaseTimes).at(-1) : 'primary';
    if (!existsSync(join(runDir, 'state.json'))) {
      throw new Error('还没有运行记录，先执行 run');
    }
    const paths = writeReport({ phase, config, runDir });
    process.stdout.write(`报告已写出：${paths.reportMd}\n`);
    return;
  }

  if (command === 'run-all') {
    const all = [];
    for (const phase of Object.keys(config.phaseTimes)) {
      const result = await runOnce({ phase, config, runDir });
      writeReport({ phase, config, runDir });
      all.push({ phase, ...result.runRecord });
    }
    const lastPhase = Object.keys(config.phaseTimes).at(-1);
    const paths = writeReport({ phase: lastPhase, config, runDir });
    process.stdout.write(JSON.stringify({ ok: true, phases: all, finalReport: paths.reportMd }, null, 2) + '\n');
    return;
  }

  throw new Error(`未知命令：${command}（可用 run / report / run-all）`);
}

main().catch((error) => {
  process.stderr.write(`代办运行失败：${error.message}\n`);
  process.exitCode = 1;
});
