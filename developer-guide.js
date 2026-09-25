(() => {
  'use strict';
  const sessionKey = 'sklad_mvp_v2_owner_session';
  const body = document.getElementById('guideBody');
  const contents = document.getElementById('guideContents');
  const status = document.getElementById('guideStatus');
  const errorBox = document.getElementById('guideError');
  const layout = document.getElementById('guideLayout');
  const search = document.getElementById('guideSearch');
  const download = document.getElementById('downloadGuide');
  const retry = document.getElementById('retryGuide');
  let markdown = '', sections = [], loading = false, controller;

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Deliberately limited Markdown. Raw HTML and links are always plain text.
  // All document text goes through textContent, never HTML interpolation.
  function inline(node, text) {
    for (const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
      if (part.startsWith('`') && part.endsWith('`')) node.append(element('code', part.slice(1, -1)));
      else if (part.startsWith('**') && part.endsWith('**')) node.append(element('strong', part.slice(2, -2)));
      else node.append(document.createTextNode(part));
    }
    return node;
  }

  function render(source) {
    body.replaceChildren(); contents.replaceChildren(); sections = [];
    let section, list = null, paragraph = null, table = null, code = null;
    function newSection(title) {
      section = element('section'); section.id = 'passport-' + sections.length;
      const link = element('a', title); link.href = '#' + section.id;
      contents.append(link); body.append(section); sections.push({ section, link });
    }
    newSection('О паспорте');
    for (const line of source.replace(/\r/g, '').split('\n')) {
      if (line.startsWith('```')) {
        list = paragraph = table = null;
        if (code) code = null;
        else { const pre = element('pre'); code = element('code'); pre.append(code); section.append(pre); }
        continue;
      }
      if (code) { code.textContent += line + '\n'; continue; }
      if (!line.trim()) { list = paragraph = table = null; continue; }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        list = paragraph = table = null;
        if (heading[1].length === 2) newSection(heading[2]);
        section.append(inline(element('h' + heading[1].length), heading[2]));
        continue;
      }
      if (line.startsWith('|') && line.endsWith('|')) {
        list = paragraph = null;
        if (/^\|[\s:|\-]+\|$/.test(line)) continue;
        const first = !table;
        if (first) { const wrap = element('div'); wrap.className = 'table-scroll'; table = element('table'); wrap.append(table); section.append(wrap); }
        const row = element('tr');
        for (const cell of line.slice(1, -1).split('|')) {
          const node = inline(element(first ? 'th' : 'td'), cell.trim());
          if (first) node.scope = 'col';
          row.append(node);
        }
        table.append(row); continue;
      }
      table = null;
      const item = line.match(/^(?:([-*])|\d+\.)\s+(.+)$/);
      if (item) {
        paragraph = null;
        const tag = item[1] ? 'UL' : 'OL';
        if (!list || list.tagName !== tag) { list = element(tag.toLowerCase()); section.append(list); }
        list.append(inline(element('li'), item[2])); continue;
      }
      list = null;
      if (!paragraph) { paragraph = element('p'); section.append(paragraph); }
      else paragraph.append(document.createTextNode(' '));
      inline(paragraph, line);
    }
    for (const item of sections) item.text = item.section.textContent.toLocaleLowerCase('ru');
  }

  function filter() {
    const words = search.value.trim().toLocaleLowerCase('ru').split(/\s+/).filter(Boolean);
    let visible = 0;
    for (const item of sections) {
      const match = words.every(word => item.text.includes(word));
      item.section.hidden = item.link.hidden = !match;
      if (match) visible++;
    }
    status.textContent = words.length ? (visible ? 'Найдено разделов: ' + visible : 'Совпадений нет. Попробуйте другое слово.') : 'Паспорт загружен. Можно искать по тексту и скачать инструкцию для ИИ.';
  }

  function clear() {
    controller?.abort(); markdown = ''; sections = [];
    body.replaceChildren(); contents.replaceChildren(); layout.hidden = true;
    search.disabled = download.disabled = true;
  }

  function showError(message) {
    clear(); status.textContent = '';
    document.getElementById('guideErrorText').textContent = message;
    errorBox.hidden = false;
  }

  async function load() {
    if (loading) return;
    loading = true; retry.disabled = true; errorBox.hidden = true;
    status.textContent = 'Загружаю паспорт…';
    try {
      let token = '';
      try { token = localStorage.getItem(sessionKey) || ''; } catch {}
      if (!token) { try { token = sessionStorage.getItem(sessionKey) || ''; } catch {} }
      if (!token) { showError('Для просмотра войдите в склад, затем откройте этот раздел снова.'); return; }
      controller = new AbortController();
      const response = await fetch('/api/developer-guide', {
        headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) { showError('Сеанс закончился или доступ недоступен. Войдите в склад снова.'); return; }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const source = await response.text();
      if (controller.signal.aborted) return;
      markdown = source; render(markdown);
      layout.hidden = false; search.disabled = download.disabled = false; filter();
    } catch (error) {
      if (error.name !== 'AbortError') showError('Не удалось загрузить паспорт. Проверьте соединение и нажмите «Повторить».');
    } finally { loading = false; retry.disabled = false; }
  }

  search.addEventListener('input', filter);
  retry.addEventListener('click', load);
  download.addEventListener('click', () => {
    if (!markdown) return;
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = element('a'); link.href = url; link.download = 'SITE-PASSPORT.md';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener('storage', event => {
    if (event.key === sessionKey || event.key === null) showError('Сеанс изменился. Откройте паспорт снова после входа в склад.');
  });
  window.addEventListener('pagehide', () => controller?.abort());
  load();
})();
