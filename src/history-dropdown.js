export function setupHistoryDropdown(input, { getValues, onDelete }) {
  const control = document.createElement('div');
  control.className = 'history-field-control';
  input.before(control);
  control.append(input);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'history-toggle';
  toggle.textContent = '▾';
  const label = input.labels?.[0]?.textContent.trim() || input.id;
  toggle.setAttribute('aria-label', `${label}历史记录`);
  control.append(toggle);

  const panel = document.createElement('div');
  panel.id = `${input.id}History`;
  panel.className = 'history-dropdown';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `${label}历史记录`);
  document.body.append(panel);
  for (const element of [input, toggle]) {
    element.setAttribute('aria-controls', panel.id);
    element.setAttribute('aria-expanded', 'false');
    element.setAttribute('aria-haspopup', 'dialog');
  }
  let query = '';

  function close() {
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-expanded', 'false');
  }

  function position() {
    if (panel.hidden) return;
    const rect = control.getBoundingClientRect();
    if (!rect.width || rect.bottom < 0 || rect.top > window.innerHeight) {
      close();
      return;
    }
    const width = Math.min(Math.max(rect.width, 200), window.innerWidth - 16);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const upwards = below < 160 && above > below;
    panel.style.maxHeight = `${Math.max(60, Math.min(240, upwards ? above : below))}px`;
    panel.style.top = `${upwards ? Math.max(8, rect.top - panel.offsetHeight - 4) : rect.bottom + 4}px`;
  }

  function render() {
    const focusedIndex = [...panel.querySelectorAll('button')].indexOf(document.activeElement);
    panel.replaceChildren();
    const values = getValues().filter((value) => value.toLowerCase().includes(query.toLowerCase()));
    for (const value of values) {
      const row = document.createElement('div');
      row.className = 'history-row';
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'history-value';
      select.textContent = value;
      select.title = value;
      select.addEventListener('click', () => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.focus();
        close();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'history-delete';
      remove.textContent = '❌';
      remove.title = `删除历史记录：${value}`;
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => onDelete(value));
      row.append(select, remove);
      panel.append(row);
    }
    if (!values.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = query ? '没有匹配的历史记录' : '暂无历史记录';
      panel.append(empty);
    }
    if (focusedIndex >= 0) {
      const buttons = panel.querySelectorAll('button');
      if (buttons.length) buttons[Math.min(focusedIndex, buttons.length - 1)].focus();
      else {
        toggle.focus();
      }
    }
    position();
  }

  function open(filter = '') {
    if (input.disabled) return;
    query = filter;
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-expanded', 'true');
    render();
  }

  input.addEventListener('focus', () => open());
  input.addEventListener('click', () => open());
  input.addEventListener('input', () => open(input.value));
  toggle.addEventListener('click', () => panel.hidden ? open() : close());
  function onKeyDown(event) {
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault();
      input.focus();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (panel.hidden) open();
      const buttons = [...panel.querySelectorAll('button')];
      const current = buttons.indexOf(document.activeElement);
      const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }
  control.addEventListener('keydown', onKeyDown);
  panel.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointerdown', (event) => {
    if (!control.contains(event.target) && !panel.contains(event.target)) close();
  });
  document.addEventListener('focusin', (event) => {
    if (!control.contains(event.target) && !panel.contains(event.target)) close();
  });
  window.addEventListener('resize', position);
  document.addEventListener('scroll', position, true);
  return { refresh: render, close, setDisabled(disabled) {
    toggle.disabled = disabled;
    if (disabled) close();
  } };
}
