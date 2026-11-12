import '../styles/page.css';
import '../styles/wizard.css';
import { apiGet, apiPost, type DeployResult, type DeployStatusResult, type PlatformsResult, type ToolBrowseResult } from '../api/client';
import { navigate } from '../router';
import { showToast } from '../components/toast';
import { deployDraft, type DeployIbSource } from '../lib/deployDraft';

interface WizardState {
  name: string;
  projectDir: string;
  templateDir: string;
  /** Источник базы: файл выгрузки .dt или установленный шаблон конфигурации (D13). */
  ibSource: DeployIbSource;
  dtPath: string;
  /** Каталог версии выбранного шаблона (…\Разработчик\Имя\Версия). */
  templatePath: string;
  /** Источник в шаблоне: имя .dt или «1Cv8.cf» (конфигурация без данных). */
  templateSourceFile: string;
  platformVersion: string;
  platformBinPath: string;
  ibcmdPath: string;
  dbUser: string;
  dbPassword: string;
  prefix: string;
  publishPort: string;
  apacheDir: string;
  rulesAi: boolean;
  bslAnalyzer: boolean;
  platformContext: boolean;
  noUsers: boolean;
}

const STEP_TITLES = ['Проект', 'Платформа', 'Доступ и публикация', 'Компоненты и запуск'];

/** Типовые конфигурации: логин/пароль ИБ для быстрой подстановки. */
const IB_PRESETS = [
  { user: 'Admin', password: '', note: 'Управление торговлей' },
  { user: 'АбрамовГС (директор)', password: '', note: 'Бухгалтерия предприятия' },
  { user: 'Савинская З.Ю. (Системный программист)', password: '', note: 'Зарплата и управление персоналом' },
  { user: 'Администратор', password: '', note: 'Розница 3.0, УНФ' },
  { user: 'Администратор узла', password: '', note: 'Розница 2.3' },
];

/** Мастер новой развертки: шаги с валидацией, «Предыдущий/Следующий шаг».
 * Источник ИБ выбирается до мастера — на вкладке «Добавить новый проект»
 * (src/components/ibSourcePicker.ts), сюда приходит готовый выбор из deployDraft. */
export function renderNewProjectPage(app: HTMLElement): void {
  // Прямой переход по хэшу без выбора источника — назад на рабочий стол
  if (!deployDraft.ready) {
    navigate('desktop');
    return;
  }
  const state: WizardState = {
    name: '',
    projectDir: '',
    templateDir: '',
    ibSource: deployDraft.ibSource,
    dtPath: deployDraft.dtPath,
    templatePath: deployDraft.templatePath,
    templateSourceFile: deployDraft.templateSourceFile,
    platformVersion: '',
    platformBinPath: '',
    ibcmdPath: '',
    dbUser: 'Admin',
    dbPassword: '',
    prefix: 'ФК_',
    publishPort: '8080',
    apacheDir: '',
    rulesAi: true,
    bslAnalyzer: true,
    platformContext: true,
    noUsers: false,
  };

  // Сначала подтягиваем настройки (дефолты путей из кабинета), потом строим мастер —
  // так поля шага 1 сразу создаются с правильными значениями.
  const loading = document.createElement('div');
  loading.className = 'wizard-screen';
  loading.innerHTML = '<div class="wizard-card"><div class="wizard-loading">Загрузка настроек…</div></div>';
  app.appendChild(loading);

  void apiGet<{ tools?: Record<string, { path?: string }> }>('/api/settings')
    .then((s) => {
      const tools = s.tools ?? {};
      const apache = tools.apache?.path ?? '';
      if (apache && !state.apacheDir) {
        state.apacheDir = apache.replace(/[\\/]+bin[\\/]+httpd\.exe$/i, '');
      }
      const root = tools.projectsRoot?.path ?? '';
      if (root && !state.projectDir) state.projectDir = root;
      const template = tools.templateDir?.path ?? '';
      if (template && !state.templateDir) state.templateDir = template;
    })
    .catch(() => { /* бэкенд недоступен — поля останутся пустыми */ })
    .finally(() => {
      loading.remove();
      buildWizard(app, state);
    });
}

function buildWizard(app: HTMLElement, state: WizardState): void {
  let step = 0;
  let platforms: PlatformsResult['platforms'] = [];
  let platformsError = '';
  let platformsLoadedOnce = false;
  let deploying = false;
  let deployErrors: string[] = [];
  let done: DeployResult | null = null;
  let pollTimer: number | undefined;

  function stopPoll(): void {
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  const page = document.createElement('div');
  page.className = 'wizard-screen';
  page.innerHTML = `
    <div class="wizard-card">
      <div class="wizard-head">
        <h2 class="wizard-title">Новая развертка</h2>
        <button class="wizard-close" data-ref="close" type="button" title="Закрыть помощник (данные не сохраняются)">×</button>
      </div>
      <div class="wizard-steps" data-ref="steps-indicator"></div>
      <div class="wizard-body" data-ref="body"></div>
      <div class="wizard-errors" data-ref="deploy-errors"></div>
      <div class="wizard-footer">
        <button class="wbtn" data-ref="prev" type="button">← Предыдущий шаг</button>
        <button class="wbtn wbtn-primary" data-ref="next" type="button">Следующий шаг →</button>
      </div>
    </div>
  `;
  app.appendChild(page);

  const closeBtn = page.querySelector<HTMLButtonElement>('[data-ref="close"]')!;
  closeBtn.addEventListener('click', () => navigate('desktop'));

  const body = page.querySelector<HTMLElement>('[data-ref="body"]')!;
  const indicator = page.querySelector<HTMLElement>('[data-ref="steps-indicator"]')!;
  const prevBtn = page.querySelector<HTMLButtonElement>('[data-ref="prev"]')!;
  const nextBtn = page.querySelector<HTMLButtonElement>('[data-ref="next"]')!;
  const deployErrorsEl = page.querySelector<HTMLElement>('[data-ref="deploy-errors"]')!;

  // ---------- валидация ----------

  type FieldCheck = { check: () => string | null; errorEl: HTMLElement; input?: HTMLInputElement };
  let fieldChecks: FieldCheck[] = [];

  function required(value: string, message: string): string | null {
    return value.trim() ? null : message;
  }

  function updateErrors(): void {
    for (const f of fieldChecks) {
      const message = f.check();
      if (f.errorEl) f.errorEl.textContent = message ?? '';
      if (f.input) f.input.classList.toggle('invalid', message !== null);
    }
    updateFooter();
  }

  function updateFooter(): void {
    prevBtn.disabled = done !== null;
    prevBtn.textContent = step === 0 && done === null ? '← Выбрать другой источник' : '← Предыдущий шаг';
    if (done !== null) {
      nextBtn.style.display = 'none';
      return;
    }
    nextBtn.style.display = '';
    const stepErrors = fieldChecks.some((f) => f.check() !== null);
    if (step < STEP_TITLES.length - 1) {
      nextBtn.textContent = 'Следующий шаг →';
      nextBtn.disabled = stepErrors;
    } else {
      nextBtn.textContent = deploying ? 'Создание…' : 'Развернуть';
      nextBtn.disabled = stepErrors || deploying;
    }
  }

  // ---------- элементы формы ----------

  function textField(
    labelText: string,
    key: keyof WizardState,
    opts: { required?: boolean; placeholder?: string; hint?: string; browse?: 'dir' | 'dt'; exempt?: () => boolean } = {},
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'wfield';
    const label = document.createElement('label');
    label.className = 'wfield-label';
    const span = document.createElement('span');
    span.textContent = opts.required ? `${labelText} *` : labelText;
    label.appendChild(span);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'wfield-input';
    input.placeholder = opts.placeholder ?? '';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = String(state[key] ?? '');

    if (opts.browse) {
      // Поле + кнопка проводника рядом; проводник стартует с текущего пути поля
      const row = document.createElement('div');
      row.className = 'wfield-input-row';
      const browseBtn = document.createElement('button');
      browseBtn.type = 'button';
      browseBtn.className = 'wfield-browse';
      browseBtn.title = opts.browse === 'dt' ? 'Выбрать файл (.dt)' : 'Выбрать папку';
      browseBtn.setAttribute('aria-label', `Выбрать: ${labelText}`);
      browseBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
      browseBtn.addEventListener('click', () => {
        if (browseBtn.disabled) return;
        browseBtn.disabled = true;
        const kind = opts.browse === 'dt' ? 'file' : 'dir';
        const filter = opts.browse === 'dt' ? 'dt' : '';
        void apiPost<ToolBrowseResult>('/api/tools/browse', { kind, filter, defaultPath: String(state[key] ?? '') }, 150000)
          .then((r) => {
            if (r.found && r.path) {
              (state[key] as string) = r.path;
              input.value = r.path;
              touched.set(key, true);
              updateErrors();
              showToast(`Выбрано: ${r.path}`);
            }
          })
          .catch(() => showToast('Проводник недоступен — запустите приложение кабинета', 'warn'))
          .finally(() => { browseBtn.disabled = false; });
      });
      row.appendChild(input);
      row.appendChild(browseBtn);
      label.appendChild(row);
    } else {
      label.appendChild(input);
    }
    wrap.appendChild(label);

    const error = document.createElement('div');
    error.className = 'wfield-error';
    wrap.appendChild(error);
    if (opts.hint) {
      const hint = document.createElement('div');
      hint.className = 'wfield-hint';
      hint.textContent = opts.hint;
      wrap.appendChild(hint);
    }
    input.addEventListener('input', () => {
      (state[key] as string) = input.value;
      touched.set(key, true);
      updateErrors();
    });
    fieldInputs.set(key, input);
    fieldChecks.push({
      input,
      errorEl: error,
      check: opts.required
        ? () => (opts.exempt?.() ? null : required(input.value, `Заполните поле «${labelText}»`))
        : () => null,
    });
    return wrap;
  }

  // Поля, правленые пользователем вручную, — автозаполнение их не перетирает
  const touched = new Map<string, boolean>();
  const fieldInputs = new Map<string, HTMLInputElement>();

  function checkboxField(labelText: string, key: 'rulesAi' | 'bslAnalyzer' | 'platformContext' | 'noUsers'): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'wcheck';
    wrap.dataset.ref = key;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state[key];
    const text = document.createElement('span');
    text.textContent = labelText;
    wrap.appendChild(input);
    wrap.appendChild(text);
    input.addEventListener('change', () => {
      state[key] = input.checked;
    });
    return wrap;
  }

  // ---------- шаги ----------

  function renderStep(): void {
    fieldChecks = [];
    deployErrorsEl.textContent = '';
    body.replaceChildren();
    indicator.textContent = done !== null
      ? 'Выполняется развертка'
      : `Шаг ${step + 1} из ${STEP_TITLES.length} · ${STEP_TITLES[step]}`;
    if (done !== null) {
      renderMonitor();
      updateFooter();
      return;
    }
    if (step === 0) renderStepProject();
    if (step === 1) renderStepPlatform();
    if (step === 2) renderStepAccess();
    if (step === 3) renderStepFeatures();
    updateErrors();
  }

  function renderStepProject(): void {
    // Выбранный источник ИБ — напоминание (меняется на вкладке рабочего стола)
    const srcNote = document.createElement('div');
    srcNote.className = 'wizard-source-note';
    srcNote.textContent = state.ibSource === 'dt'
      ? `Источник ИБ: файл выгрузки ${state.dtPath}`
      : `Источник ИБ: шаблон конфигурации ${state.templatePath}${state.templateSourceFile ? ` (${state.templateSourceFile})` : ''}`;
    body.appendChild(srcNote);

    body.appendChild(textField('Имя проекта', 'name', { required: true, placeholder: 'например, МойПроект' }));
    body.appendChild(textField('Папка проекта', 'projectDir', {
      required: true,
      placeholder: 'C:\\1C_Bases\\AI\\projects\\МойПроект',
      hint: 'Будет создана при развертке, если ее еще нет.',
      browse: 'dir',
    }));
    body.appendChild(textField('Шаблон проекта', 'templateDir', {
      placeholder: 'C:\\1C_Bases\\AI\\1c-deploy_new\\template',
      hint: 'Необязательно: env.json, packagedef, .kilo, tools/mcp-1c.',
      browse: 'dir',
    }));
  }

  function renderStepPlatform(): void {
    const wrap = document.createElement('div');
    wrap.className = 'wfield';

    const label = document.createElement('div');
    label.className = 'wfield-label';
    label.textContent = 'Установленная платформа 1С *';
    wrap.appendChild(label);

    const list = document.createElement('div');
    list.className = 'wplatform-list';
    wrap.appendChild(list);

    const error = document.createElement('div');
    error.className = 'wfield-error';
    wrap.appendChild(error);
    body.appendChild(wrap);

    const refresh = document.createElement('button');
    refresh.className = 'wbtn';
    refresh.type = 'button';
    refresh.textContent = 'Обновить список';
    refresh.addEventListener('click', () => {
      void loadPlatforms().then(() => renderPlatformList(list, error));
    });
    body.appendChild(refresh);

    const hint = document.createElement('div');
    hint.className = 'wfield-hint';
    hint.textContent = 'Поиск выполняет приложение кабинета: каталог C:\\Program Files\\1cv8.';
    body.appendChild(hint);

    fieldChecks.push({
      errorEl: error,
      check: () => (state.platformVersion ? null : 'Выберите платформу'),
    });

    if (!platformsLoadedOnce) {
      void loadPlatforms().then(() => renderPlatformList(list, error));
    } else {
      renderPlatformList(list, error);
    }
  }

  async function loadPlatforms(): Promise<void> {
    platformsError = '';
    try {
      const r = await apiGet<PlatformsResult>('/api/platforms');
      platforms = r.platforms;
      platformsLoadedOnce = true;
      // По умолчанию — самая свежая платформа (список отсортирован по убыванию версий)
      if (!state.platformVersion && platforms.length > 0) {
        const p = platforms[0];
        state.platformVersion = p.version;
        state.platformBinPath = p.binPath;
        state.ibcmdPath = p.ibcmdPath;
      }
      // По умолчанию — самая свежая платформа (список отсортирован по убыванию версий)
      if (!state.platformVersion && platforms.length > 0) {
        const p = platforms[0];
        state.platformVersion = p.version;
        state.platformBinPath = p.binPath;
        state.ibcmdPath = p.ibcmdPath;
      }
    } catch {
      platforms = [];
      platformsError = 'Не удалось получить список — запустите приложение кабинета';
    }
  }

  function renderPlatformList(list: HTMLElement, error: HTMLElement): void {
    list.replaceChildren();
    if (platformsError) {
      error.textContent = platformsError;
      return;
    }
    if (platforms.length === 0) {
      error.textContent = 'Установленные платформы 1С не найдены';
      return;
    }
    for (const p of platforms) {
      const item = document.createElement('label');
      item.className = 'wplatform-item';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'platform';
      radio.value = p.version;
      radio.checked = state.platformVersion === p.version;
      const text = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = p.version;
      text.appendChild(strong);
      const mono = document.createElement('div');
      mono.className = 'wplatform-path';
      mono.textContent = p.binPath;
      text.appendChild(mono);
      item.appendChild(radio);
      item.appendChild(text);
      radio.addEventListener('change', () => {
        state.platformVersion = p.version;
        state.platformBinPath = p.binPath;
        state.ibcmdPath = p.ibcmdPath;
        updateErrors();
      });
      list.appendChild(item);
    }
    // Дефолтный выбор платформы активирует кнопку «Следующий шаг»
    updateErrors();
  }

  function renderStepAccess(): void {
    // Флаг «без пользователей»: пользователь и пароль становятся необязательными
    body.appendChild(checkboxField('Информационная база без пользователей', 'noUsers'));

    // Выбор логина из списка типовых конфигураций: подставляет логин и пароль
    const selWrap = document.createElement('div');
    selWrap.className = 'wfield';
    const selLabel = document.createElement('label');
    selLabel.className = 'wfield-label';
    selLabel.textContent = 'Выберите логин\\пароль из списка типовых баз или укажите произвольный';
    const sel = document.createElement('select');
    sel.className = 'wfield-input';
    const optNone = document.createElement('option');
    optNone.value = '';
    optNone.textContent = '— выбрать из списка —';
    sel.appendChild(optNone);
    IB_PRESETS.forEach((preset, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${preset.user} — ${preset.note}`;
      sel.appendChild(o);
    });
    selLabel.appendChild(sel);
    selWrap.appendChild(selLabel);
    const selNote = document.createElement('div');
    selNote.className = 'wfield-hint';
    selNote.textContent = 'Нужен пользователь с полными правами.';
    selWrap.appendChild(selNote);
    body.appendChild(selWrap);

    sel.addEventListener('change', () => {
      if (state.noUsers) return;
      const idx = parseInt(sel.value, 10);
      if (Number.isNaN(idx) || !IB_PRESETS[idx]) return;
      const preset = IB_PRESETS[idx];
      state.dbUser = preset.user;
      state.dbPassword = preset.password;
      const userInput = fieldInputs.get('dbUser');
      if (userInput) userInput.value = preset.user;
      const pwdInput = fieldInputs.get('dbPassword');
      if (pwdInput && preset.password) pwdInput.value = preset.password;
      selNote.textContent = `Типовая база: ${preset.note}.`;
      updateErrors();
    });

    body.appendChild(textField('Пользователь ИБ', 'dbUser', {
      required: true,
      placeholder: 'Admin',
      exempt: () => state.noUsers,
    }));

    body.appendChild(textField('Пароль ИБ', 'dbPassword', {
      hint: 'Не сохраняется в файлах кабинета — существует только в памяти мастера, пока не нажато «Развернуть». Шифрованное хранение (DPAPI) появится на этапе 0.',
    }));
    body.appendChild(textField('Префикс объектов', 'prefix', { required: true, placeholder: 'ФК_' }));
    body.appendChild(textField('Порт публикации', 'publishPort', {
      required: true,
      placeholder: '8080',
      hint: 'Порт portable Apache, больше 1024.',
    }));
    body.appendChild(textField('Каталог Apache', 'apacheDir', {
      required: true,
      placeholder: 'C:\\1C_Bases\\AI\\tools\\apache_portable\\Apache24',
      browse: 'dir',
    }));

    // Ручной ввод логина сбрасывает выбор из списка
    const userInput = fieldInputs.get('dbUser');
    if (userInput) {
      userInput.addEventListener('input', () => {
        sel.value = '';
        selNote.textContent = state.noUsers ? 'Информационная база без пользователей.' : 'Нужен пользователь с полными правами.';
      });
    }

    function applyNoUsers(): void {
      const disabled = state.noUsers;
      if (disabled) {
        // Логин и пароль очищаются — базе пользователи не нужны
        state.dbUser = '';
        state.dbPassword = '';
        sel.value = '';
      }
      const userInput = fieldInputs.get('dbUser');
      if (userInput) {
        userInput.disabled = disabled;
        userInput.value = state.dbUser;
      }
      const pwdInput = fieldInputs.get('dbPassword');
      if (pwdInput) {
        pwdInput.disabled = disabled;
        pwdInput.value = state.dbPassword;
      }
      sel.disabled = disabled;
      selNote.textContent = disabled
        ? 'Информационная база без пользователей — логин и пароль не требуются.'
        : 'Нужен пользователь с полными правами.';
    }
    const noUsersInput = body.querySelector<HTMLInputElement>('[data-ref="noUsers"] input');
    if (noUsersInput) noUsersInput.addEventListener('change', () => {
      state.noUsers = noUsersInput.checked;
      applyNoUsers();
      updateErrors();
    });
  }

  function renderStepFeatures(): void {
    const label = document.createElement('div');
    label.className = 'wfield-label';
    label.textContent = 'Дополнительные компоненты (можно включить позже)';
    body.appendChild(label);

    body.appendChild(checkboxField('Правила AI-агента (ai_rules_1c) — Git нужен только для обновления с GitHub, иначе из шаблона', 'rulesAi'));
    body.appendChild(checkboxField('BSL Analyzer — анализ кода 1С для AI', 'bslAnalyzer'));
    body.appendChild(checkboxField('Справочник платформы (mcp-bsl-platform-context) — требуется Java 17+', 'platformContext'));

    const previewLabel = document.createElement('div');
    previewLabel.className = 'wfield-label';
    previewLabel.style.marginTop = '16px';
    previewLabel.textContent = 'Манифест развертки';
    body.appendChild(previewLabel);

    const pre = document.createElement('pre');
    pre.className = 'wizard-preview';
    const manifest = {
      ...buildManifest(),
      platformPath: state.platformBinPath
        ? state.platformBinPath.replace(/[\\/]+bin[\\/]+1cv8\.exe$/i, '')
        : '',
      dbPassword: state.dbPassword ? '(введен, не сохраняется)' : '(не задан)',
    };
    pre.textContent = JSON.stringify(manifest, null, 2);
    body.appendChild(pre);
  }

  function buildManifest() {
    // Источник базы: .dt (файл или выгрузка из шаблона) либо 1Cv8.cf шаблона (D13)
    let dtPath = '';
    let templateCfPath = '';
    if (state.ibSource === 'dt') {
      dtPath = state.dtPath;
    } else if (state.templatePath && state.templateSourceFile) {
      if (/\.dt$/i.test(state.templateSourceFile)) {
        dtPath = `${state.templatePath}\\${state.templateSourceFile}`;
      } else if (state.templateSourceFile.toLowerCase() === '1cv8.cf') {
        templateCfPath = `${state.templatePath}\\1Cv8.cf`;
      }
    }
    return {
      name: state.name,
      projectDir: state.projectDir,
      templateDir: state.templateDir,
      ibSource: state.ibSource,
      dtPath,
      templateCfPath,
      platformVersion: state.platformVersion,
      platformBinPath: state.platformBinPath,
      platformPath: state.platformBinPath
        ? state.platformBinPath.replace(/[\\/]+bin[\\/]+1cv8\.exe$/i, '')
        : '',
      ibcmdPath: state.ibcmdPath,
      dbUser: state.dbUser,
      prefix: state.prefix,
      publishPort: Number(state.publishPort),
      apacheDir: state.apacheDir,
      features: {
        rulesAi: state.rulesAi,
        bslAnalyzer: state.bslAnalyzer,
        platformContext: state.platformContext,
      },
      noUsers: state.noUsers,
    };
  }

  function renderMonitor(): void {
    if (!done) return;
    stopPoll();
    body.replaceChildren();
    const box = document.createElement('div');
    box.className = 'wizard-done';
    const h = document.createElement('h3');
    h.textContent = 'Выполняется развертка';
    box.appendChild(h);

    const monitorWrap = document.createElement('div');
    monitorWrap.className = 'monitor-steps';
    box.appendChild(monitorWrap);

    const curLine = document.createElement('div');
    curLine.className = 'wfield-hint';
    box.appendChild(curLine);

    const errBox = document.createElement('div');
    errBox.className = 'wizard-errors';
    box.appendChild(errBox);

    const doneWrap = document.createElement('div');
    box.appendChild(doneWrap);

    body.appendChild(box);

    // Список шагов runner (id должны совпадать с runner.ps1)
    const STEP_LIST: [string, string][] = [
      ['00-validate', 'Проверка манифеста'],
      ['01-platform', 'Платформа и ibcmd'],
      ['02-project', 'Создание проекта и копирование эталона'],
      ['03-config', 'Конфигурация .dev.env / env.json'],
      ['04-ib-create', 'Создание ИБ (источник базы)'],
      ['05-locks', 'Проверка блокировок'],
      ['06-mcp-ext', 'Установка расширения MCP_HTTPService'],
      ['07-cf-dump', 'Выгрузка конфигурации (src/cf)'],
      ['08-cfe-dump', 'Выгрузка расширений (src/cfe)'],
      ['09-publish', 'Публикация (Apache)'],
      ['10-rules', 'Правила AI-агента (ai_rules_1c)'],
      ['11-bsl-analyzer', 'bsl-analyzer'],
      ['12-platform-context', 'Справочник платформы'],
      ['13-mcp-config', 'MCP-конфиг проекта'],
    ];

    function renderRows(latest: Record<string, { phase: string; detail: string }>): void {
      monitorWrap.replaceChildren();
      for (const [id, title] of STEP_LIST) {
        const st = latest[id]?.phase ?? 'pending';
        const row = document.createElement('div');
        row.className = 'monitor-step ' + st;
        const dot = document.createElement('span');
        dot.className = 'monitor-dot';
        dot.textContent = st === 'success' ? '✓' : st === 'error' ? '✕' : st === 'start' ? '▸' : '·';
        const label = document.createElement('span');
        label.textContent = st === 'success'
          ? title
          : latest[id]?.detail
            ? `${title} — ${latest[id].detail}`
            : title;
        row.appendChild(dot);
        row.appendChild(label);
        monitorWrap.appendChild(row);
      }
    }

  function renderFinal(status: 'success' | 'error', detail = ''): void {
    if (doneWrap.childElementCount > 0) return;
    const sep = document.createElement('hr');
    sep.className = 'monitor-sep';
    doneWrap.appendChild(sep);
    const msg = document.createElement('p');
    if (status === 'success') {
      msg.textContent = 'Развертка выполнена полностью. Откройте папку проекта в VS Code (полный перезапуск VS Code — для MCP-серверов).';
    } else {
      msg.textContent = 'Развертка прервана с ошибкой — подробности выше и в журнале прогона.';
    }
    doneWrap.appendChild(msg);
    if (detail) {
      const d = document.createElement('p');
      d.textContent = detail;
      doneWrap.appendChild(d);
    }
    const btn = document.createElement('button');
    btn.className = 'wbtn wbtn-primary';
    btn.type = 'button';
    btn.textContent = '← На рабочий стол';
    btn.addEventListener('click', () => navigate('desktop'));
    doneWrap.appendChild(btn);
  }

    async function poll(): Promise<void> {
      if (!done) return;
      if (!page.isConnected) { stopPoll(); return; }
      try {
        const s = await apiGet<DeployStatusResult>(`/api/deploy/status?runId=${encodeURIComponent(done.runId)}`);
        const latest: Record<string, { phase: string; detail: string }> = {};
        for (const e of s.events) latest[e.step] = { phase: e.phase, detail: e.detail };
        renderRows(latest);
        curLine.textContent = s.currentStep
          ? `Текущий шаг: ${s.currentStep} — ${latest[s.currentStep]?.detail ?? ''}`.trimEnd()
          : '';
        if (s.status === 'success') {
          stopPoll();
          h.textContent = 'Развертка выполнена';
          let duration = '';
          const startMs = Date.parse(s.startedAt);
          const endMs = Date.parse(s.finishedAt);
          if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
            const totalSec = Math.round((endMs - startMs) / 1000);
            const min = Math.floor(totalSec / 60);
            const sec = totalSec % 60;
            duration = `Общее время развертки: ${min} мин ${sec} с.`;
          }
          renderFinal('success', duration);
        } else if (s.status === 'error') {
          stopPoll();
          h.textContent = 'Развертка прервана';
          errBox.textContent = s.error || 'Ошибка выполнения';
          renderFinal('error', s.error || '');
        }
      } catch {
        // повторим на следующем тике
      }
    }

    pollTimer = window.setInterval(() => void poll(), 1500);
    void poll();
  }

  // ---------- навигация по шагам ----------

  function goPrev(): void {
    // С первого шага — назад к выбору источника ИБ на рабочем столе
    if (step === 0) {
      navigate('desktop');
      return;
    }
    step -= 1;
    renderStep();
  }

  function goNext(): void {
    const invalid = fieldChecks.some((f) => f.check() !== null);
    if (invalid) return;
    if (step < STEP_TITLES.length - 1) {
      step += 1;
      renderStep();
      return;
    }
    void deploy();
  }

  async function deploy(): Promise<void> {
    deploying = true;
    deployErrors = [];
    updateFooter();
    try {
      done = await apiPost<DeployResult>('/api/deploy', buildManifest());
      showToast('Развертка создана');
    } catch (err) {
      const data = (err as { data?: { errors?: string[] } }).data;
      deployErrors = data?.errors ?? ['Не удалось связаться с бэкендом — запустите приложение кабинета'];
    }
    deploying = false;
    renderStep();
    if (deployErrors.length > 0) {
      deployErrorsEl.textContent = deployErrors.join(' · ');
    }
  }

  prevBtn.addEventListener('click', goPrev);
  nextBtn.addEventListener('click', goNext);
  renderStep();
}
