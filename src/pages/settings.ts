import '../styles/page.css';
import '../styles/settings.css';
import type { ToolId, ToolInfo } from '../lib/settings';
import { TOOL_CATALOG, getToolPath, saveToolPaths } from '../lib/settings';
import { getLastUserName } from '../lib/storage';
import { apiGet, apiPost, apiPut, type ToolBrowseResult, type ToolCheckResult, type ToolDetectResult } from '../api/client';
import { navigate } from '../router';
import { showToast } from '../components/toast';

interface ServerSettings {
  version?: number;
  tools?: Partial<Record<string, { path?: string }>>;
}

/** Состояние строки инструмента: элементы и дебаунс проверки пути. */
interface RowState {
  input: HTMLInputElement;
  dot: HTMLElement;
  kind: 'file' | 'dir';
  timer?: number;
  seq: number;
}

/** Настройки: пути к обязательному ПО; проверку путей выполняет бэкенд. */
export function renderSettingsPage(app: HTMLElement): void {
  const page = document.createElement('div');
  page.className = 'settings-screen';
  page.innerHTML = `
    <div class="settings-card">
      <h2 class="settings-title">Настройки</h2>
      <p class="settings-hint">
        Пути к обязательному ПО для деплоя 1С-проектов. Проверку пути выполняет бэкенд
        (server.ps1): зеленая точка — файл найден, красная — не найден или не задан.
        Изменения применяются кнопкой «Сохранить настройки».
      </p>
      <div data-ref="sections"></div>
      <div class="settings-footer">
        <button class="back-btn" data-ref="settings-back" type="button">Закрыть</button>
        <button class="save-btn" data-ref="settings-save" type="button" disabled>Сохранить настройки</button>
      </div>
    </div>
  `;
  app.appendChild(page);

  const backTo = getLastUserName() ? 'desktop' : 'login';
  page.querySelector('[data-ref="settings-back"]')!.addEventListener('click', () => navigate(backTo));

  const saveBtn = page.querySelector<HTMLButtonElement>('[data-ref="settings-save"]')!;

  let backendOnline = false;

  // Черновик правок; в хранилище попадает только по «Сохранить настройки»
  const draft = new Map<ToolId, string>();
  for (const tool of TOOL_CATALOG) {
    draft.set(tool.id, getToolPath(tool.id));
  }

  const rows = new Map<ToolId, RowState>();
  const inputs = new Map<ToolId, HTMLInputElement>();

  function wrapPaths(paths: Partial<Record<ToolId, string>>): { tools: Record<string, { path: string }> } {
    const tools: Record<string, { path: string }> = {};
    (Object.keys(paths) as string[]).forEach((id) => {
      const p = paths[id as ToolId] ?? '';
      if (p) tools[id] = { path: p };
    });
    return { tools };
  }

  function markDirty(): void {
    saveBtn.disabled = false;
  }

  // ---------- статус-точка: проверка пути бэкендом ----------

  function setDot(row: RowState, state: 'ok' | 'unset' | 'unknown', title: string): void {
    row.dot.classList.toggle('ok', state === 'ok');
    row.dot.classList.toggle('unset', state === 'unset');
    row.dot.title = title;
  }

  function scheduleDotCheck(id: ToolId): void {
    const row = rows.get(id);
    if (!row) return;
    const value = draft.get(id) ?? '';
    window.clearTimeout(row.timer);
    if (!value) {
      setDot(row, 'unset', 'Путь не задан');
      return;
    }
    if (!backendOnline) {
      setDot(row, 'ok', 'Путь задан (бэкенд недоступен — проверка позже)');
      return;
    }
    setDot(row, 'unknown', 'Проверяется…');
    const seq = ++row.seq;
    row.timer = window.setTimeout(async () => {
      try {
        const r = await apiPost<ToolCheckResult>('/api/tools/check', { path: value, kind: row.kind });
        if (seq === row.seq) {
          setDot(row, r.exists ? 'ok' : 'unset', r.exists ? 'Путь найден (проверено бэкендом)' : 'Файл не найден по этому пути');
        }
      } catch {
        if (seq === row.seq) setDot(row, 'ok', 'Путь задан (бэкенд недоступен — проверка позже)');
      }
    }, 350);
  }

  function applyEdit(id: ToolId): void {
    const row = rows.get(id);
    if (!row) return;
    draft.set(id, row.input.value.trim());
    markDirty();
    scheduleDotCheck(id);
  }

  function setToolValue(id: ToolId, value: string): void {
    const row = rows.get(id);
    draft.set(id, value);
    if (row) row.input.value = value;
    markDirty();
    scheduleDotCheck(id);
  }

  // ---------- сохранение ----------

  async function save(): Promise<void> {
    const paths: Partial<Record<ToolId, string>> = {};
    draft.forEach((path, id) => {
      paths[id] = path;
    });
    if (backendOnline) {
      try {
        await apiPut('/api/settings', { version: 1, ...wrapPaths(paths) });
      } catch {
        saveToolPaths(paths);
        showToast('Сохранено локально — бэкенд недоступен', 'warn');
        navigate('desktop');
        return;
      }
    } else {
      saveToolPaths(paths);
    }
    showToast('Настройки сохранены');
    // Сохранение завершает работу с настройками — на рабочее пространство
    navigate('desktop');
  }

  saveBtn.addEventListener('click', () => {
    void save();
  });

  // ---------- загрузка с бэкенда ----------

  async function initFromBackend(): Promise<void> {
    try {
      const server = await apiGet<ServerSettings>('/api/settings');
      backendOnline = true;

      const serverTools = server.tools ?? {};
      const serverIds = Object.keys(serverTools);
      if (serverIds.length === 0) {
        // миграция: переносим пути из localStorage (черновик уже засеян ими) в файл настроек бэкенда
        const localPaths: Partial<Record<ToolId, string>> = {};
        draft.forEach((p, id) => {
          if (p) localPaths[id] = p;
        });
        if (Object.keys(localPaths).length > 0) {
          try {
            await apiPut('/api/settings', { version: 1, ...wrapPaths(localPaths) });
          } catch { /* не критично: продолжаем с локальными значениями */ }
        }
      } else {
        TOOL_CATALOG.forEach((tool) => {
          const path = serverTools[tool.id]?.path;
          draft.set(tool.id, typeof path === 'string' ? path : '');
        });
        inputs.forEach((input, id) => {
          input.value = draft.get(id) ?? '';
        });
      }
      TOOL_CATALOG.forEach((tool) => scheduleDotCheck(tool.id));
    } catch {
      showToast('Бэкенд не запущен — настройки из localStorage', 'warn');
    }
  }

  // ---------- построение формы ----------

  function buildToolRow(tool: ToolInfo): HTMLElement {
    const row = document.createElement('div');
    row.className = 'tool-row';

    const dot = document.createElement('span');
    dot.className = 'status-dot';

    const info = document.createElement('div');
    info.className = 'tool-info';
    const title = document.createElement('div');
    title.className = 'tool-title';
    title.textContent = tool.title;
    const desc = document.createElement('div');
    desc.className = 'tool-desc';
    desc.textContent = tool.description;
    info.appendChild(title);
    info.appendChild(desc);

    const inputWrap = document.createElement('div');
    inputWrap.className = 'tool-path';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tool-input';
    input.placeholder = tool.placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = draft.get(tool.id) ?? '';
    inputWrap.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'tool-actions';

    const browseBtn = document.createElement('button');
    browseBtn.className = 'tool-btn tool-btn-icon';
    browseBtn.type = 'button';
    browseBtn.title = 'Указать путь через проводник';
    browseBtn.setAttribute('aria-label', `Указать путь: ${tool.title}`);
    browseBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
    browseBtn.addEventListener('click', () => {
      if (!backendOnline) {
        showToast('Проводник работает только при запущенном бэкенде', 'warn');
        return;
      }
      browseBtn.disabled = true;
      // Диалог в бэкенде ждет пользователя до 2 минут — таймаут с запасом
      void apiPost<ToolBrowseResult>('/api/tools/browse', { kind: tool.kind, filter: 'exe', defaultPath: draft.get(tool.id) ?? '' }, 150000)
        .then((r) => {
          if (r.found && r.path) {
            setToolValue(tool.id, r.path);
            showToast(`Выбрано: ${r.path}`);
          }
        })
        .catch(() => showToast('Не удалось открыть проводник', 'warn'))
        .finally(() => {
          browseBtn.disabled = false;
        });
    });

    const detectBtn = document.createElement('button');
    detectBtn.className = 'tool-btn';
    detectBtn.type = 'button';
    detectBtn.title = `Автопоиск: ${tool.detectHint}`;
    detectBtn.textContent = 'Автопоиск';
    detectBtn.addEventListener('click', () => {
      if (!backendOnline) {
        showToast('Автопоиск работает только при запущенном бэкенде', 'warn');
        return;
      }
      void apiPost<ToolDetectResult>('/api/tools/detect', { id: tool.id })
        .then((r) => {
          if (r.found && r.path) {
            setToolValue(tool.id, r.path);
            showToast(`Найдено: ${r.path}`);
          } else {
            showToast('Автопоиск ничего не нашел — укажите путь вручную', 'warn');
          }
        })
        .catch(() => showToast('Автопоиск недоступен — бэкенд не отвечает', 'warn'));
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'tool-btn tool-btn-clear';
    clearBtn.type = 'button';
    clearBtn.title = 'Очистить путь';
    clearBtn.setAttribute('aria-label', `Очистить путь: ${tool.title}`);
    clearBtn.textContent = '×';
    clearBtn.addEventListener('click', () => {
      setToolValue(tool.id, '');
      input.focus();
    });

    actions.appendChild(browseBtn);
    actions.appendChild(detectBtn);
    actions.appendChild(clearBtn);

    input.addEventListener('input', () => applyEdit(tool.id));

    rows.set(tool.id, { input, dot, kind: tool.kind, seq: 0 });
    inputs.set(tool.id, input);
    scheduleDotCheck(tool.id);

    row.appendChild(dot);
    row.appendChild(info);
    row.appendChild(inputWrap);
    row.appendChild(actions);
    return row;
  }

  const sectionsHost = page.querySelector<HTMLElement>('[data-ref="sections"]')!;

  const groups = new Map<string, ToolInfo[]>();
  for (const tool of TOOL_CATALOG) {
    const list = groups.get(tool.section) ?? [];
    list.push(tool);
    groups.set(tool.section, list);
  }

  for (const [section, tools] of groups) {
    const sectionEl = document.createElement('div');
    sectionEl.className = 'settings-section';
    const title = document.createElement('h3');
    title.className = 'settings-section-title';
    title.textContent = section;
    sectionEl.appendChild(title);
    for (const tool of tools) {
      sectionEl.appendChild(buildToolRow(tool));
    }
    sectionsHost.appendChild(sectionEl);
  }

  void initFromBackend();
}
