/**
 * Настройки кабинета: каталог обязательного ПО и пути к нему.
 * Хранение — localStorage (`cabinet_settings`); на этапе 1 заменяется на
 * Pode-API: GET/PUT /api/settings (docs/decisions.md, D8/D10).
 * Реальную проверку путей и автопоиск (PATH, стандартные каталоги) выполняет
 * бэкенд — браузер не видит файловую систему.
 */

export type ToolId =
  | 'projectsRoot'
  | 'templateDir'
  | 'templatesRoot'
  | 'vscode'
  | 'git'
  | 'platform1c'
  | 'ibcmd'
  | 'apache'
  | 'java'
  | 'bslAnalyzer';

export interface ToolInfo {
  id: ToolId;
  /** Раздел страницы настроек. */
  section: string;
  title: string;
  description: string;
  /** Пример корректного пути (placeholder поля ввода). */
  placeholder: string;
  /** Где бэкенд будет искать инструмент автоматически (подсказка на кнопке «Найти»). */
  detectHint: string;
  /** Что выбирается/проверяется: файл или каталог. */
  kind: 'file' | 'dir';
}

export interface ToolSettings {
  path: string;
}

export interface CabinetSettings {
  tools: Partial<Record<ToolId, ToolSettings>>;
}

const SETTINGS_KEY = 'cabinet_settings';

export const TOOL_CATALOG: ToolInfo[] = [
  {
    id: 'projectsRoot',
    section: 'Каталоги развертки',
    title: 'Корневой каталог проектов',
    description: 'Папка, в которой создаются развернутые проекты',
    placeholder: 'C:\\1C_Bases\\AI\\projects',
    detectHint: 'C:\\1C_Bases\\AI\\projects',
    kind: 'dir',
  },
  {
    id: 'templateDir',
    section: 'Каталоги развертки',
    title: 'Шаблон проекта',
    description: 'Правила AI-агента, MCP и т.д. — копируется в новый проект',
    placeholder: 'C:\\1C_Bases\\AI\\1c-deploy_new\\template',
    detectHint: 'C:\\1C_Bases\\AI\\1c-deploy_new\\template',
    kind: 'dir',
  },
  {
    id: 'templatesRoot',
    section: 'Каталоги развертки',
    title: 'Каталог шаблонов конфигураций',
    description: 'Установленные шаблоны 1С (Разработчик\\Имя\\Версия) — источник базы в мастере развертки',
    placeholder: 'C:\\1C_Bases\\SHABLONI',
    detectHint: 'C:\\1C_Bases\\SHABLONI',
    kind: 'dir',
  },
  {
    id: 'vscode',
    section: 'Инструменты разработчика',
    title: 'VS Code',
    description: 'IDE среда разработки',
    placeholder: 'C:\\Users\\<имя>\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    detectHint: 'PATH, %LOCALAPPDATA%\\Programs\\Microsoft VS Code',
    kind: 'file',
  },
  {
    id: 'git',
    section: 'Инструменты разработчика',
    title: 'Git',
    description: 'Установка/обновление правил AI-агента (ai_rules_1c). Необязателен, если правила уже в кэше',
    placeholder: 'C:\\tools\\PortableGit\\bin\\git.exe',
    detectHint: 'PATH (git --version), PortableGit',
    kind: 'file',
  },
  {
    id: 'platform1c',
    section: 'Платформа 1С',
    title: 'Платформа 1С:Предприятие (1cv8.exe)',
    description: 'Создание ИБ, Конфигуратор, установка расширений',
    placeholder: 'C:\\Program Files\\1cv8\\8.3.25.xxxx\\bin\\1cv8.exe',
    detectHint: 'C:\\Program Files\\1cv8\\<версия>\\bin',
    kind: 'file',
  },
  {
    id: 'ibcmd',
    section: 'Платформа 1С',
    title: 'ibcmd.exe',
    description: 'Консольная утилита платформы: деплой ИБ без Конфигуратора',
    placeholder: 'C:\\Program Files\\1cv8\\8.3.25.xxxx\\bin\\ibcmd.exe',
    detectHint: 'каталог bin установленной платформы',
    kind: 'file',
  },
  {
    id: 'apache',
    section: 'Публикация и AI-инструменты',
    title: 'Apache HTTP Server (portable)',
    description: 'Веб-публикации информационных баз',
    placeholder: 'C:\\1C_Bases\\AI\\tools\\apache_portable\\Apache24\\bin\\httpd.exe',
    detectHint: 'каталог tools кабинета',
    kind: 'file',
  },
  {
    id: 'java',
    section: 'Публикация и AI-инструменты',
    title: 'Java 17+',
    description: 'mcp-bsl-platform-context (справочник платформы для AI)',
    placeholder: 'C:\\tools\\jdk-17\\bin\\java.exe',
    detectHint: 'JAVA_HOME, PATH (java -version)',
    kind: 'file',
  },
  {
    id: 'bslAnalyzer',
    section: 'Публикация и AI-инструменты',
    title: 'BSL Analyzer',
    description: 'Анализ кода 1С для AI-агентов',
    placeholder: 'C:\\Users\\<имя>\\AppData\\Local\\Programs\\bsl-analyzer\\bsl-analyzer.exe',
    detectHint: '%LOCALAPPDATA%\\Programs',
    kind: 'file',
  },
];

export function loadSettings(): CabinetSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== 'object' || parsed === null) {
      return { tools: {} };
    }
    const tools = (parsed as { tools?: unknown }).tools;
    return { tools: (typeof tools === 'object' && tools !== null ? tools : {}) as CabinetSettings['tools'] };
  } catch {
    return { tools: {} };
  }
}

export function saveSettings(settings: CabinetSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function getToolPath(id: ToolId): string {
  return loadSettings().tools[id]?.path ?? '';
}

export function setToolPath(id: ToolId, path: string): void {
  const settings = loadSettings();
  if (path) {
    settings.tools[id] = { path };
  } else {
    delete settings.tools[id];
  }
  saveSettings(settings);
}

/** Сохраняет пути сразу по всем инструментам (кнопка «Сохранить настройки»). */
export function saveToolPaths(paths: Partial<Record<ToolId, string>>): void {
  const settings = loadSettings();
  for (const id of Object.keys(paths) as ToolId[]) {
    const path = paths[id] ?? '';
    if (path) {
      settings.tools[id] = { path };
    } else {
      delete settings.tools[id];
    }
  }
  saveSettings(settings);
}

/**
 * Статус инструмента. Пока бэкенда нет: «ok» = путь задан.
 * На этапе 1 добавится «invalid» (задан, но Test-Path не нашел файл).
 */
export function toolStatus(id: ToolId): 'ok' | 'unset' {
  return getToolPath(id) ? 'ok' : 'unset';
}
