// 演练时钟：来源服务使用进程内演练时钟，应用不直接操纵来源时钟，
// 只通过配置的阶段时间线判断“现在是几点”。日期一律按东八区处理。

const ZONE = 'Asia/Shanghai';

export function createClock(config, phase = 'primary') {
  const nowIso = config.phaseTimes?.[phase] ?? new Date().toISOString();
  const now = new Date(nowIso);
  return {
    phase,
    zone: ZONE,
    now,
    iso: nowIso,
  };
}

// 把公告正文里的“12月8日 09:00”解析为带东八区偏移的 Date。
export function parseBulletinTime(text, year) {
  const match = text.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const [, month, day, hour, minute] = match;
  const padded = (value) => String(value).padStart(2, '0');
  const iso = `${year}-${padded(month)}-${padded(day)}T${padded(hour)}:${padded(minute)}:00+08:00`;
  return new Date(iso);
}

// 段落是否已到生效时间。没有可解析时间的常规段落视为持续有效。
export function isEffectiveAt(paragraph, clock) {
  const effective = paragraph.effectiveAt;
  if (!effective) return true;
  return effective.getTime() <= clock.now.getTime();
}

// 找出某一刻已经生效的段落。
export function effectiveParagraphs(paragraphs, clock) {
  return paragraphs.filter((paragraph) => isEffectiveAt(paragraph, clock));
}
