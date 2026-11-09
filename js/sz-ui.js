import { STR } from './sz-strings.js';

const METRO_STATE_KEY = 'sz-metro-lines';

function localizeInterface() {
  const lookup = key => key.split('.').reduce((value, part) => value[part], STR);
  for (const element of document.querySelectorAll('[data-text]')) {
    element.textContent = lookup(element.dataset.text);
  }
  for (const [data, attribute] of [['data-label', 'aria-label'], ['data-tip', 'title'], ['data-content-text', 'content']]) {
    for (const element of document.querySelectorAll(`[${data}]`)) {
      element.setAttribute(attribute, lookup(element.getAttribute(data)));
    }
  }
  for (const button of document.querySelectorAll('[data-time]')) {
    const label = STR.timeNames[button.dataset.time];
    button.title = label;
    button.setAttribute('aria-label', label);
    button.querySelector('.seg-label').textContent = label;
  }
  for (const button of document.querySelectorAll('[data-mode]')) {
    const mode = button.dataset.mode;
    button.title = STR.shortcut(STR.modeNames[mode], button.querySelector('kbd').textContent);
    button.setAttribute('aria-label', STR.modeNames[mode]);
    button.querySelector('.mode-label').textContent = STR.modeButtons[mode];
  }
  for (const button of document.querySelectorAll('[data-camera]')) {
    button.querySelector('.pop-name').textContent = STR.cameraNames[button.dataset.camera];
  }
}

if (typeof document !== 'undefined') localizeInterface();

export function populateTeleportMenu(locations, locationLabel) {
  const menu = document.getElementById('teleport-popover');
  const feedback = document.getElementById('teleport-feedback');
  const existing = new Map([...menu.querySelectorAll('[data-teleport]')].map(button => [button.dataset.teleport, button]));
  for (const button of existing.values()) button.hidden = !locations[button.dataset.teleport];
  return Object.entries(locations).map(([key, location]) => {
    let button = existing.get(key);
    if (!button) {
      button = document.createElement('button');
      button.id = `tp-${key}`;
      button.className = 'pop-item tp-btn';
      button.dataset.teleport = key;
      button.type = 'button';
      for (const className of ['pop-name', 'pop-sub']) {
        const part = document.createElement('span');
        part.className = className;
        button.appendChild(part);
      }
      menu.insertBefore(button, feedback);
    }
    button.querySelector('.pop-name').textContent = location.name;
    const detail = locationLabel(location.x, location.z);
    button.querySelector('.pop-sub').textContent = detail === location.name ? '' : detail;
    return button;
  });
}

export function wireMetroMenu(mapSystem, sourceLines) {
  const list = document.getElementById('metro-lines');
  const lines = sourceLines.filter(line => line.hasCoverage);
  const refs = new Set(lines.map(line => line.ref));
  let selected = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(METRO_STATE_KEY));
    if (Array.isArray(saved)) selected = new Set(saved.filter(ref => refs.has(ref)));
  } catch { /* 存储不可用时仍能操作地图。 */ }

  const inputs = new Map();
  function apply(save) {
    for (const [ref, input] of inputs) input.checked = selected.has(ref);
    mapSystem.setMetroLines(selected);
    if (save) {
      try { localStorage.setItem(METRO_STATE_KEY, JSON.stringify([...selected])); } catch { /* 存储可选。 */ }
    }
  }
  for (const line of lines) {
    const row = document.createElement('label');
    row.className = 'pop-item metro-line';
    const name = document.createElement('span');
    name.textContent = STR.metro.line(line.ref);
    const swatch = document.createElement('span');
    swatch.className = 'metro-swatch';
    swatch.style.backgroundColor = line.colour || '';
    swatch.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.metroLine = line.ref;
    input.addEventListener('change', () => {
      if (input.checked) selected.add(line.ref);
      else selected.delete(line.ref);
      apply(true);
    });
    row.append(swatch, name, input);
    list.appendChild(row);
    inputs.set(line.ref, input);
  }
  document.getElementById('metro-show-all').addEventListener('click', () => {
    selected = new Set(refs);
    apply(true);
  });
  document.getElementById('metro-hide-all').addEventListener('click', () => {
    selected.clear();
    apply(true);
  });
  apply(false);
}
