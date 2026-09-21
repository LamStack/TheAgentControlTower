// Tiny DOM toolkit. Nothing here ever touches innerHTML: agent-controlled strings are always
// rendered as text nodes, so the console cannot be XSS'd by what an agent says or does.

const PROPS = new Set(['value', 'disabled', 'checked', 'hidden', 'open']);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

export const setText = (el, s) => {
  s = String(s);
  if (el.textContent !== s) el.textContent = s;
};
export const setClass = (el, cls) => {
  if (el.className !== cls) el.className = cls;
};
export const setHidden = (el, hidden) => {
  if (el.hidden !== hidden) el.hidden = hidden;
};
export const clear = (el) => el.replaceChildren();

/** Persistent keyed list: nodes are created once and updated in place, so buttons never vanish under the cursor. */
export function keyedList(container, create) {
  const nodes = new Map();
  return (items, keyFn) => {
    const seen = new Set();
    let prev = null;
    for (const item of items) {
      const k = keyFn(item);
      seen.add(k);
      let rec = nodes.get(k);
      if (!rec) {
        rec = create(item);
        nodes.set(k, rec);
      }
      rec.update(item);
      const want = prev ? prev.el.nextSibling : container.firstChild;
      if (rec.el !== want) container.insertBefore(rec.el, want);
      prev = rec;
    }
    for (const [k, rec] of nodes) {
      if (!seen.has(k)) {
        rec.el.remove();
        nodes.delete(k);
      }
    }
    return nodes;
  };
}

export const usd = (n) => `$${Number(n).toFixed(n < 1 ? 3 : 2)}`;
export const num = (n) => Number(n).toLocaleString('en-US');
export const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
export const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`;
