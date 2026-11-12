/**
 * Выбор источника информационной базы — содержимое вкладки
 * «Добавить новый проект» (рабочий стол): файл выгрузки .dt |
 * шаблон конфигурации (дерево установленных шаблонов + установка из zip)
 * | существующая ИБ (в разработке, D12). По «Следующий шаг» выбор
 * сохраняется в deployDraft и открывается мастер (src/pages/newProject.ts).
 */
import {
  apiGet,
  apiPost,
  type TemplateInfo,
  type TemplateInstallResult,
  type TemplatesResult,
  type ToolBrowseResult,
} from '../api/client';
import { deployDraft, type DeployIbSource } from '../lib/deployDraft';
import { showToast } from './toast';

/** Значок папки для кнопки проводника (статический SVG). */
const FOLDER_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';

/** Кэш списка шаблонов: переживает переключение вкладок рабочего стола. */
interface TemplateCache {
  root: string;
  templates: TemplateInfo[];
  loaded: boolean;
}

let cache: TemplateCache = { root: '', templates: [], loaded: false };

export function renderIbSourcePicker(root: HTMLElement, onNext: () => void): void {
  // Локальное состояние сеется из черновика: возврат на вкладку не сбрасывает выбор
  let ibSource: DeployIbSource = deployDraft.ibSource;
  let dtPath = deployDraft.dtPath;
  let templatePath = deployDraft.templatePath;
  let templateSourceFile = deployDraft.templateSourceFile;
  let installingZip = false;
  // true — дерево показывает шаблоны из папки, указанной пользователем вручную
  let manualActive = false;

  // ---------- шапка: переключатель источника ----------

  const srcWrap = document.createElement('div');
  srcWrap.className = 'wfield';
  const srcLabel = document.createElement('div');
  srcLabel.className = 'wfield-label';
  srcLabel.textContent = 'Источник информационной базы *';
  srcWrap.appendChild(srcLabel);
  const toggle = document.createElement('div');
  toggle.className = 'wsource-toggle wsource-toggle-stack';
  const modes: { value: DeployIbSource | 'existing'; label: string; note?: string }[] = [
    { value: 'dt', label: 'Файл выгрузки .dt' },
    { value: 'template', label: 'Из шаблона конфигурации' },
    { value: 'existing', label: 'Добавить проект к уже существующей ИБ', note: '*в разработке' },
  ];
  for (const mode of modes) {
    const item = document.createElement('label');
    item.className = 'wsource-item';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'ib-source-pick';
    const disabled = mode.value === 'existing';
    radio.disabled = disabled;
    if (!disabled) radio.checked = ibSource === mode.value;
    const text = document.createElement('span');
    text.textContent = mode.label;
    item.appendChild(radio);
    item.appendChild(text);
    if (mode.note) {
      const note = document.createElement('span');
      note.className = 'wsource-note';
      note.textContent = mode.note;
      item.appendChild(note);
      item.classList.add('wsource-item-disabled');
    }
    radio.addEventListener('change', () => {
      if (mode.value === 'existing' || ibSource === mode.value) return;
      ibSource = mode.value;
      syncDraft();
      applyVisibility();
      refresh();
    });
    toggle.appendChild(item);
  }
  srcWrap.appendChild(toggle);
  root.appendChild(srcWrap);

  // ---------- вариант а): файл выгрузки .dt ----------

  const dtWrap = document.createElement('div');
  dtWrap.className = 'wfield';
  const dtLabel = document.createElement('label');
  dtLabel.className = 'wfield-label';
  const dtSpan = document.createElement('span');
  dtSpan.textContent = 'Файл выгрузки .dt *';
  dtLabel.appendChild(dtSpan);
  const dtRow = document.createElement('div');
  dtRow.className = 'wfield-input-row';
  const dtInput = document.createElement('input');
  dtInput.type = 'text';
  dtInput.className = 'wfield-input';
  dtInput.placeholder = 'C:\\dumps\\МойПроект.dt';
  dtInput.spellcheck = false;
  dtInput.autocomplete = 'off';
  dtInput.value = dtPath;
  const dtBrowse = document.createElement('button');
  dtBrowse.type = 'button';
  dtBrowse.className = 'wfield-browse';
  dtBrowse.title = 'Выбрать файл (.dt)';
  dtBrowse.setAttribute('aria-label', 'Выбрать файл выгрузки .dt');
  dtBrowse.innerHTML = FOLDER_SVG;
  dtBrowse.addEventListener('click', () => {
    if (dtBrowse.disabled) return;
    dtBrowse.disabled = true;
    void apiPost<ToolBrowseResult>('/api/tools/browse', { kind: 'file', filter: 'dt', defaultPath: dtPath }, 150000)
      .then((r) => {
        if (r.found && r.path) {
          dtPath = r.path;
          dtInput.value = r.path;
          syncDraft();
          refresh();
          showToast(`Выбрано: ${r.path}`);
        }
      })
      .catch(() => showToast('Проводник недоступен — запустите приложение кабинета', 'warn'))
      .finally(() => { dtBrowse.disabled = false; });
  });
  dtRow.appendChild(dtInput);
  dtRow.appendChild(dtBrowse);
  dtLabel.appendChild(dtRow);
  dtWrap.appendChild(dtLabel);
  const dtHint = document.createElement('div');
  dtHint.className = 'wfield-hint';
  dtHint.textContent = 'Существующая выгрузка информационной базы.';
  dtWrap.appendChild(dtHint);
  const dtError = document.createElement('div');
  dtError.className = 'wfield-error';
  dtWrap.appendChild(dtError);
  dtInput.addEventListener('input', () => {
    dtPath = dtInput.value;
    syncDraft();
    refresh();
  });
  root.appendChild(dtWrap);

  // ---------- вариант б): шаблон конфигурации ----------

  const tplWrap = document.createElement('div');
  tplWrap.className = 'wfield';
  const tplLabel = document.createElement('div');
  tplLabel.className = 'wfield-label';
  tplLabel.textContent = 'Установленный шаблон конфигурации *';
  tplWrap.appendChild(tplLabel);

  const tree = document.createElement('div');
  tree.className = 'wtree';
  tplWrap.appendChild(tree);

  const status = document.createElement('div');
  status.className = 'wfield-hint';
  tplWrap.appendChild(status);

  const tplError = document.createElement('div');
  tplError.className = 'wfield-error';
  tplWrap.appendChild(tplError);
  root.appendChild(tplWrap);

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'wtemplate-actions';
  const installBtn = document.createElement('button');
  installBtn.className = 'wbtn';
  installBtn.type = 'button';
  installBtn.textContent = installingZip ? 'Установка…' : 'Установить из zip архива, скачанного с releases.1c.ru…';
  installBtn.disabled = installingZip;
  installBtn.addEventListener('click', () => {
    if (installBtn.disabled) return;
    void apiPost<ToolBrowseResult>('/api/tools/browse', { kind: 'file', filter: 'zip', defaultPath: '' }, 150000)
      .then(async (r) => {
        if (!r.found || !r.path) return;
        installingZip = true;
        installBtn.disabled = true;
        installBtn.textContent = 'Установка…';
        try {
          // До 7 минут: распаковка архива + тихая установка setup.exe (до 150 с)
          const res = await apiPost<TemplateInstallResult>('/api/templates/install', { zipPath: r.path }, 420000);
          if (res.installer) {
            // Тихая установка не сработала — открыт установщик в обычном окне
            showToast(
              res.message ?? 'Установщик шаблона открыт — укажите в нем путь каталога шаблонов, после установки нажмите «Обновить список»',
              'warn',
              12000,
            );
          } else {
            showToast(`Шаблон установлен: ${res.installed.join(', ')}`);
            await loadTemplates(true);
            renderTemplates();
          }
        } catch (err) {
          const data = (err as { data?: { error?: string } }).data;
          showToast(data?.error ?? 'Не удалось установить шаблон из архива', 'warn');
        } finally {
          installingZip = false;
          installBtn.disabled = false;
          installBtn.textContent = 'Установить из zip архива, скачанного с releases.1c.ru…';
        }
      })
      .catch(() => showToast('Проводник недоступен — запустите приложение кабинета', 'warn'));
  });
  const manualBtn = document.createElement('button');
  manualBtn.className = 'wbtn';
  manualBtn.type = 'button';
  manualBtn.title = 'Показать шаблоны из произвольной папки — если шаблон установлен не в каталог шаблонов из настроек';
  manualBtn.textContent = 'Указать папку с шаблоном…';
  manualBtn.addEventListener('click', () => {
    if (manualBtn.disabled) return;
    manualBtn.disabled = true;
    void apiPost<ToolBrowseResult>('/api/tools/browse', { kind: 'dir', filter: '', defaultPath: cache.root }, 150000)
      .then(async (r) => {
        if (!r.found || !r.path) return;
        try {
          const res = await apiGet<TemplatesResult>(`/api/templates?dir=${encodeURIComponent(r.path)}`);
          cache = { root: res.root, templates: res.templates, loaded: true };
          manualActive = true;
          renderTemplates();
          showToast(
            res.templates.length > 0 ? `Найдено шаблонов: ${res.templates.length}` : 'В указанной папке шаблонов не найдено',
            res.templates.length > 0 ? 'ok' : 'warn',
          );
        } catch (err) {
          const data = (err as { data?: { error?: string } }).data;
          showToast(data?.error ?? 'Не удалось просканировать папку', 'warn');
        }
      })
      .catch(() => showToast('Проводник недоступен — запустите приложение кабинета', 'warn'))
      .finally(() => { manualBtn.disabled = false; });
  });
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'wbtn';
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Обновить список';
  refreshBtn.addEventListener('click', () => {
    void loadTemplates(true).then(renderTemplates);
  });
  buttonsRow.appendChild(installBtn);
  buttonsRow.appendChild(manualBtn);
  buttonsRow.appendChild(refreshBtn);
  root.appendChild(buttonsRow);

  const tplHint = document.createElement('div');
  tplHint.className = 'wfield-hint';
  tplHint.textContent = 'Шаблоны сканирует приложение кабинета: каталог шаблонов из настроек (по умолчанию C:\\1C_Bases\\SHABLONI). Скачивание с releases.1c.ru — вручную; здесь — установка скачанного zip.';
  root.appendChild(tplHint);

  // Источник базы из шаблона — появляется после выбора шаблона в дереве
  const sourceWrap = document.createElement('div');
  sourceWrap.className = 'wfield';
  const sourceLabel = document.createElement('label');
  sourceLabel.className = 'wfield-label';
  const sourceSpan = document.createElement('span');
  sourceSpan.textContent = 'Источник базы из шаблона *';
  sourceLabel.appendChild(sourceSpan);
  const sourceSel = document.createElement('select');
  sourceSel.className = 'wfield-input';
  sourceLabel.appendChild(sourceSel);
  sourceWrap.appendChild(sourceLabel);
  const sourceHint = document.createElement('div');
  sourceHint.className = 'wfield-hint';
  sourceHint.textContent = 'По умолчанию — выгрузка с демо-данными (база с данными для тестирования). «Только конфигурация (1Cv8.cf)» — абсолютно пустая база, без данных.';
  sourceWrap.appendChild(sourceHint);
  sourceSel.addEventListener('change', () => {
    templateSourceFile = sourceSel.value;
    syncDraft();
    refresh();
  });
  root.appendChild(sourceWrap);

  // ---------- «Следующий шаг» ----------

  const nextBtn = document.createElement('button');
  nextBtn.className = 'accent-btn wsource-next';
  nextBtn.type = 'button';
  nextBtn.textContent = 'Следующий шаг →';
  nextBtn.addEventListener('click', () => {
    if (nextBtn.disabled) return;
    syncDraft();
    deployDraft.ready = true;
    onNext();
  });
  root.appendChild(nextBtn);

  // ---------- логика ----------

  function syncDraft(): void {
    deployDraft.ibSource = ibSource;
    deployDraft.dtPath = dtPath;
    deployDraft.templatePath = templatePath;
    deployDraft.templateSourceFile = templateSourceFile;
  }

  function applyVisibility(): void {
    const template = ibSource === 'template';
    dtWrap.style.display = template ? 'none' : '';
    tplWrap.style.display = template ? '' : 'none';
    buttonsRow.style.display = template ? '' : 'none';
    tplHint.style.display = template ? '' : 'none';
    const sourceVisible = template && Boolean(templatePath);
    sourceWrap.style.display = sourceVisible ? '' : 'none';
    if (template && !cache.loaded) {
      void loadTemplates().then(renderTemplates);
    }
  }

  function refresh(): void {
    const dtErr = ibSource === 'dt' && !dtPath.trim() ? 'Выберите файл выгрузки .dt' : '';
    const tplErr = ibSource === 'template' && !templatePath ? 'Выберите шаблон конфигурации в дереве' : '';
    const srcErr = ibSource === 'template' && templatePath && !templateSourceFile ? 'Выберите источник базы из шаблона' : '';
    dtError.textContent = dtErr;
    tplError.textContent = tplErr || srcErr;
    nextBtn.disabled = Boolean(dtErr || tplErr || srcErr);
    const sourceVisible = ibSource === 'template' && Boolean(templatePath);
    sourceWrap.style.display = sourceVisible ? '' : 'none';
  }

  async function loadTemplates(force = false): Promise<void> {
    if (!force && cache.loaded) return;
    status.textContent = 'Загрузка шаблонов…';
    try {
      const r = await apiGet<TemplatesResult>('/api/templates');
      cache = { root: r.root, templates: r.templates, loaded: true };
      manualActive = false;
      status.textContent = '';
    } catch {
      cache = { root: '', templates: [], loaded: false };
      manualActive = false;
      status.textContent = 'Не удалось получить список шаблонов — запустите приложение кабинета';
    }
  }

  function renderTemplates(): void {
    tplHint.textContent = manualActive
      ? 'Показаны шаблоны из указанной вручную папки. «Обновить список» вернет каталог шаблонов из настроек.'
      : 'Шаблоны сканирует приложение кабинета: каталог шаблонов из настроек (по умолчанию C:\\1C_Bases\\SHABLONI). Скачивание с releases.1c.ru — вручную; здесь — установка скачанного zip.';
    tree.replaceChildren();
    if (!cache.loaded) {
      if (!status.textContent) status.textContent = 'Шаблоны не загружены';
      return;
    }
    if (cache.templates.length === 0) {
      status.textContent = cache.root
        ? `В каталоге шаблонов не найдено установленных шаблонов: ${cache.root}`
        : 'Каталог шаблонов не задан — укажите его в настройках кабинета (Каталог шаблонов конфигураций)';
      return;
    }
    status.textContent = cache.root ? `Каталог шаблонов: ${cache.root}` : '';
    // Дерево: поставщик → конфигурация → версии (листья с выбором)
    const vendors = new Map<string, Map<string, TemplateInfo[]>>();
    for (const t of cache.templates) {
      const names = vendors.get(t.vendor) ?? new Map<string, TemplateInfo[]>();
      const versions = names.get(t.name) ?? [];
      versions.push(t);
      names.set(t.name, versions);
      vendors.set(t.vendor, names);
    }
    for (const [vendor, names] of vendors) {
      const vendorChildren = document.createElement('div');
      vendorChildren.className = 'wtree-children';
      for (const [name, versions] of names) {
        const nameChildren = document.createElement('div');
        nameChildren.className = 'wtree-children';
        for (const t of versions) nameChildren.appendChild(leafNode(t));
        vendorChildren.appendChild(branchNode(name, nameChildren, 'name'));
      }
      tree.appendChild(branchNode(vendor, vendorChildren, 'vendor'));
    }
  }

  /** Ветка дерева: строка с кареткой + свернутый контейнер дочерних узлов. */
  function branchNode(labelText: string, children: HTMLElement, level: 'vendor' | 'name'): HTMLElement {
    const node = document.createElement('div');
    node.className = `wtree-node wtree-branch-${level}`;
    const row = document.createElement('div');
    row.className = `wtree-row wtree-${level}`;
    const caret = document.createElement('span');
    caret.className = 'wtree-caret';
    caret.textContent = '▾';
    const label = document.createElement('span');
    label.textContent = labelText;
    row.appendChild(caret);
    row.appendChild(label);
    row.addEventListener('click', () => {
      const hidden = children.classList.toggle('wtree-collapsed');
      caret.textContent = hidden ? '▸' : '▾';
    });
    node.appendChild(row);
    node.appendChild(children);
    return node;
  }

  /** Лист дерева — версия шаблона с радио-выбором. */
  function leafNode(t: TemplateInfo): HTMLElement {
    const item = document.createElement('label');
    item.className = 'wtree-leaf';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'wtree-template';
    radio.checked = templatePath === t.dir;
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = t.version;
    text.appendChild(strong);
    const mono = document.createElement('div');
    mono.className = 'wplatform-path';
    const parts: string[] = [];
    if (t.cfPath) parts.push('конфигурация (1Cv8.cf)');
    for (const s of t.sources) parts.push(s.demo ? `демо-выгрузка (${s.file})` : `выгрузка (${s.file})`);
    mono.textContent = parts.join(' · ') || t.dir;
    text.appendChild(mono);
    item.appendChild(radio);
    item.appendChild(text);
    radio.addEventListener('change', () => {
      templatePath = t.dir;
      // Источник по умолчанию — выгрузка с демо-данными (для тестирования),
      // иначе любая .dt; «только конфигурация» (cf, пустая база) — не дефолт
      const preferred = t.sources.find((s) => s.demo) ?? t.sources[0] ?? (t.cfPath ? { file: '1Cv8.cf' } : null);
      templateSourceFile = preferred ? preferred.file : '';
      syncDraft();
      fillSourceSelect(t);
      refresh();
    });
    return item;
  }

  function fillSourceSelect(t: TemplateInfo): void {
    sourceSel.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '— выбрать —';
    sourceSel.appendChild(empty);
    for (const s of t.sources) {
      const o = document.createElement('option');
      o.value = s.file;
      o.textContent = `${s.label} (${s.file})`;
      sourceSel.appendChild(o);
    }
    if (t.cfPath) {
      const o = document.createElement('option');
      o.value = '1Cv8.cf';
      o.textContent = 'Только конфигурация (1Cv8.cf) — база без данных';
      sourceSel.appendChild(o);
    }
    sourceSel.value = templateSourceFile;
  }

  applyVisibility();
  if (ibSource === 'template') {
    const selected = cache.templates.find((t) => t.dir === templatePath);
    if (selected) fillSourceSelect(selected);
  }
  void loadTemplates().then(renderTemplates);
  refresh();
}
