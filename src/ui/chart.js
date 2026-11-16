// A small chart of values over a row of days, drawn in SVG: columns for one
// series, lines for several. Hovering, touching or the arrow keys read out
// the values of a day; every value is also in the table on the Stats tab.

import { h } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v);
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

/** A round step for an axis, so its ticks land on clean numbers. */
export function niceStep(rough, whole = true) {
  if (!(rough > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const f = rough / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  return whole ? Math.max(1, step) : step;
}

/** The ticks of an axis from 0 that covers `max`: [0, step, ..., top]. */
export function ticksFor(max, whole = true) {
  const step = niceStep((max || 1) / 3, whole);
  const top = Math.max(step, Math.ceil((max || 0) / step - 1e-9) * step);
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

const compact = (v) => (v >= 10_000 ? `${Math.round(v / 1000)}K` : v.toLocaleString('en'));

// Charts on screen, so that a tap elsewhere can put their readouts away.
const live = new Set();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener('pointerdown', (e) => {
    for (const chart of live) {
      if (!chart.el.isConnected) live.delete(chart);
      else if (!chart.el.contains(e.target)) chart.clear();
    }
  });
}

/**
 * @param {object} o
 * @param {string} o.title
 * @param {'column'|'line'} [o.kind]
 * @param {{label:string, long:string}[]} o.points   one per day (or week), oldest first
 * @param {{name:string, color:string, values:(number|null)[]}[]} o.series
 * @param {{value:number, label:string}} [o.goal]    a level to draw across the plot
 * @param {(v:number) => string} [o.format]          how a value reads in the readout and legend
 * @param {boolean} [o.whole]                        whether the values are whole numbers
 * @param {number} [o.height]
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function timeChart({
  title,
  kind = 'column',
  points,
  series,
  goal,
  format = compact,
  whole = true,
  height = 150,
}) {
  const n = points.length;
  const tip = h('div', { class: 'viz-tip', role: 'status', 'aria-live': 'polite', hidden: true });
  const plot = h('div', {
    class: 'viz-plot',
    tabindex: '0',
    role: 'group',
    'aria-label': `${title}. Use the left and right arrow keys to read the values.`,
  });
  const latest = (values) => values.findLast((v) => v != null);
  const legend =
    series.length > 1 &&
    h(
      'ul',
      { class: 'viz-legend' },
      series.map((x) =>
        h(
          'li',
          null,
          h('span', { class: 'viz-key', style: `background:${x.color}` }),
          x.name,
          latest(x.values) != null && h('b', null, format(latest(x.values))),
        ),
      ),
    );
  const el = h('figure', { class: 'viz' }, h('figcaption', { class: 'viz-title' }, title), legend, plot);

  let active = -1;
  let geo = null; // set by draw(): the plot's geometry
  let marks = null; // the layer that shows the active day

  function draw() {
    const width = Math.floor(plot.clientWidth);
    if (width < 40) return;
    const all = series.flatMap((x) => x.values).filter((v) => v != null);
    const ticks = ticksFor(Math.max(0, ...all, goal ? goal.value : 0), whole);
    const top = ticks.at(-1);
    const m = { l: 14 + 7 * compact(top).length, r: 12, t: 12, b: 24 };
    const w = width - m.l - m.r;
    const hh = height - m.t - m.b;
    const band = w / n;
    const x = (i) => m.l + band * (i + 0.5);
    const y = (v) => m.t + hh * (1 - v / top);
    geo = { m, w, hh, band, x, y, width };

    const grid = ticks.map((v) =>
      s(
        'g',
        null,
        s('line', { class: v === 0 ? 'viz-axis' : 'viz-grid', x1: m.l, x2: m.l + w, y1: y(v), y2: y(v) }),
        s('text', { class: 'viz-tick', x: m.l - 6, y: y(v), dy: '0.32em', 'text-anchor': 'end' }, compact(v)),
      ),
    );

    // Label as many days as fit, counted back from the most recent one.
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 58))));
    const xLabels = points.map(
      (p, i) =>
        (n - 1 - i) % every === 0 &&
        s('text', { class: 'viz-tick', x: x(i), y: m.t + hh + 16, 'text-anchor': 'middle' }, p.label),
    );

    const data = [];
    if (kind === 'column') {
      const bw = Math.max(1, Math.min(24, band - 2));
      const { values, color } = series[0];
      values.forEach((v, i) => {
        if (!(v > 0)) return;
        const bh = Math.max(1, hh * (v / top));
        const r = Math.min(4, bw / 2, bh);
        const [x0, y0, yb] = [x(i) - bw / 2, y(v), m.t + hh];
        // Rounded at the value end, square on the baseline.
        const d = `M${x0},${yb}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + bw - r}Q${x0 + bw},${y0} ${x0 + bw},${y0 + r}V${yb}Z`;
        data.push(s('path', { d, fill: color, 'data-i': i }));
      });
    } else {
      for (const { values, color } of series) {
        let run = [];
        const flush = () => {
          if (run.length > 1) {
            data.push(s('polyline', { class: 'viz-line', points: run.join(' '), stroke: color }));
          }
          run = [];
        };
        values.forEach((v, i) => {
          if (v == null) flush();
          else run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
        });
        flush();
        const end = values.findLastIndex((v) => v != null);
        if (end >= 0) data.push(s('circle', { class: 'viz-dot', cx: x(end), cy: y(values[end]), r: 4, fill: color }));
      }
    }

    const goalMark =
      goal &&
      goal.value > 0 &&
      s(
        'g',
        null,
        s('line', { class: 'viz-goal', x1: m.l, x2: m.l + w, y1: y(goal.value), y2: y(goal.value) }),
        s('text', { class: 'viz-tick', x: m.l + w, y: y(goal.value) - 5, 'text-anchor': 'end' }, goal.label),
      );

    marks = s('g', { class: 'viz-marks' });
    const hit = s('rect', { class: 'viz-hit', x: m.l, y: m.t, width: w, height: hh + m.b });
    const pick = (e) => {
      const box = plot.getBoundingClientRect();
      show(Math.max(0, Math.min(n - 1, Math.floor((e.clientX - box.left - m.l) / band))));
    };
    hit.addEventListener('pointermove', pick);
    hit.addEventListener('pointerdown', pick);
    hit.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && clear());

    plot.replaceChildren(
      s(
        'svg',
        { width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' },
        grid,
        marks,
        data,
        goalMark,
        xLabels,
        hit,
      ),
      tip,
    );
    if (active >= 0) show(active);
  }

  function show(i) {
    if (!geo) return;
    // One readout at a time across the page.
    for (const other of live) if (other.el !== el) other.clear();
    active = i;
    const { m, hh, band, x, y, width } = geo;
    const shapes = [];
    if (kind === 'column') {
      shapes.push(s('rect', { class: 'viz-band', x: x(i) - band / 2, y: m.t, width: band, height: hh }));
    } else {
      shapes.push(s('line', { class: 'viz-cross', x1: x(i), x2: x(i), y1: m.t, y2: m.t + hh }));
      for (const { values, color } of series) {
        if (values[i] != null)
          shapes.push(s('circle', { class: 'viz-dot', cx: x(i), cy: y(values[i]), r: 4, fill: color }));
      }
    }
    marks.replaceChildren(...shapes);

    const rows = series.map((x) =>
      h(
        'div',
        { class: 'viz-tip-row' },
        series.length > 1 && h('span', { class: 'viz-key', style: `background:${x.color}` }),
        h('b', null, x.values[i] == null ? 'no number' : format(x.values[i])),
        h('span', null, x.name),
      ),
    );
    tip.replaceChildren(h('div', { class: 'viz-tip-day' }, points[i].long), ...rows);
    tip.hidden = false;
    // Beside the day, on whichever side has room.
    const left = x(i) > width / 2;
    tip.style.left = left ? '' : `${x(i) + 10}px`;
    tip.style.right = left ? `${width - x(i) + 10}px` : '';
  }

  function clear() {
    active = -1;
    marks?.replaceChildren();
    tip.hidden = true;
  }

  plot.addEventListener('keydown', (e) => {
    const to = {
      ArrowLeft: active < 0 ? n - 1 : active - 1,
      ArrowRight: active < 0 ? n - 1 : active + 1,
      Home: 0,
      End: n - 1,
    }[e.key];
    if (e.key === 'Escape') clear();
    if (to == null) return;
    e.preventDefault();
    show(Math.max(0, Math.min(n - 1, to)));
  });
  plot.addEventListener('blur', clear);

  // Drawn at the size it is shown, and again whenever that changes.
  const watcher = new ResizeObserver(draw);
  watcher.observe(plot);
  const chart = { el, clear };
  live.add(chart);
  listen();

  return {
    el,
    destroy() {
      watcher.disconnect();
      live.delete(chart);
    },
  };
}
