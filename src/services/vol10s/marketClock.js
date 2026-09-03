'use strict';

/** America/New_York clock helpers. Shared by the desk and options engine. */

function etNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t).value;
  const date = `${g('year')}-${g('month')}-${g('day')}`;
  const h = Number(g('hour'));
  const m = Number(g('minute'));
  const s = Number(g('second'));
  return { date, h, m, s, mins: h * 60 + m, dow: new Date(`${date}T12:00:00Z`).getUTCDay(), iso: `${date} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` };
}

function cashClock(et = etNow()) {
  const { mins, dow } = et;
  if (dow === 0 || dow === 6) return { id: 'closed', label: 'Weekend' };
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return { id: 'market', label: 'Regular' };
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return { id: 'am', label: 'Premarket' };
  if (mins >= 16 * 60 && mins < 20 * 60) return { id: 'post', label: 'After hours' };
  return { id: 'overnight', label: 'Overnight' };
}

module.exports = { etNow, cashClock };
