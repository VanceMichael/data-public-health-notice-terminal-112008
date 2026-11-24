// 运行状态与凭据持久化。
// 状态里保存公告/译文历史、每次登记的换页凭据、撤销凭据与设备确认情况，
// 让代办可在多次运行（含离线重连）之间保持幂等并可追溯。

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class EvidenceStore {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
  }

  save(name, content) {
    const path = join(this.directory, name.replace(/[^\w.-]+/g, '_'));
    writeFileSync(path, content);
    return path;
  }
}

const EMPTY_STATE = {
  phases: [],
  bulletins: [],
  translations: [],
  registrations: [],
  cancellations: [],
  terminals: {},
  lastBulletinSignature: null,
  lastPending: [],
  latestClassified: [],
  lastDevices: [],
};

export function loadState(path) {
  if (!existsSync(path)) return structuredClone(EMPTY_STATE);
  const state = { ...structuredClone(EMPTY_STATE), ...JSON.parse(readFileSync(path, 'utf8')) };
  // JSON 序列化后 Date 变成字符串，这里把公告段落的生效时间还原回 Date。
  for (const snapshot of state.bulletins ?? []) {
    for (const paragraph of snapshot.paragraphs ?? []) {
      if (typeof paragraph.effectiveAt === 'string') {
        paragraph.effectiveAt = new Date(paragraph.effectiveAt);
      }
    }
  }
  for (const paragraph of state.latestClassified ?? []) {
    if (typeof paragraph.effectiveAt === 'string') {
      paragraph.effectiveAt = new Date(paragraph.effectiveAt);
    }
  }
  return state;
}

export function saveState(path, state) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// 一次公告快照的签名：内容变化时签名变化，用于识别“门户处理中途的新版通知”。
export function bulletinSignature(paragraphs) {
  return paragraphs.map((paragraph) => paragraph.text).join('\n');
}
