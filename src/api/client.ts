/**
 * Клиент API кабинета (бэкенд — backend/server.ps1, docs/decisions.md, D8).
 * В дев-режиме /api проксируется Vite на 127.0.0.1:8180; в проде API и статика
 * на одном origin. Ошибки не глотаются: страницы решают, как показать сбой.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, data: unknown) {
    const detail =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : '';
    super(detail || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = 30000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try { data = JSON.parse(text) as unknown; } catch { data = text; }
    }
    if (!res.ok) {
      throw new ApiError(res.status, data);
    }
    return data as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(0, { error: 'Бэкенд не отвечает (превышено время ожидания)' });
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

export const apiGet = <T>(path: string, timeoutMs?: number): Promise<T> => request<T>('GET', path, undefined, timeoutMs);
export const apiPost = <T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> => request<T>('POST', path, body, timeoutMs);
export const apiPut = <T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> => request<T>('PUT', path, body, timeoutMs);

// ---------- типы ответов бэкенда ----------

export interface ToolCheckResult {
  exists: boolean;
}

export interface ToolDetectResult {
  found: boolean;
  path: string;
}

export interface ToolBrowseResult {
  found: boolean;
  path: string;
}

export interface PlatformInfo {
  version: string;
  binPath: string;
  ibcmdPath: string;
}

export interface PlatformsResult {
  platforms: PlatformInfo[];
}

/** Источник базы в шаблоне конфигурации: выгрузка (.dt) из секции [ConfigN] 1cv8.mft. */
export interface TemplateSourceInfo {
  /** Имя файла в каталоге версии шаблона. */
  file: string;
  /** true — демонстрационная выгрузка (из Catalog «...демонстрационная база»). */
  demo: boolean;
  label: string;
}

/** Установленный шаблон конфигурации: <каталог шаблонов>\Разработчик\Имя\Версия (D13). */
export interface TemplateInfo {
  vendor: string;
  name: string;
  version: string;
  dir: string;
  /** Путь к 1Cv8.cf; пустая строка — конфигурации в шаблоне нет. */
  cfPath: string;
  mft: { vendor: string; name: string; version: string; appVersion: string } | null;
  sources: TemplateSourceInfo[];
}

export interface TemplatesResult {
  root: string;
  templates: TemplateInfo[];
}

export interface TemplateInstallResult {
  ok: boolean;
  installed: string[];
  /** true — вместо тихой установки открыт установщик setup.exe (обычное окно). */
  installer?: boolean;
  /** Пояснение для пользователя (путь установки, про «Обновить список»). */
  message?: string;
}

export interface DeployResult {
  runId: string;
  runDir: string;
  manifestPath: string;
}

export interface DeployStatusEvent {
  ts: string;
  step: string;
  phase: string;
  detail: string;
}

export interface DeployStatusResult {
  status: string;
  currentStep: string;
  error: string;
  startedAt: string;
  finishedAt: string;
  steps: Record<string, string>;
  events: DeployStatusEvent[];
}

export interface ProjectExtensionInfo {
  name: string;
  synonym: string;
  version: string;
  /** Назначение из Configuration.xml: AddOn | Patch | Customization. */
  purpose: string;
}

/** Детали проекта, собранные бэкендом из выгрузки исходников (src/cf, src/cfe, .dev.env). */
export interface ProjectInfo {
  configName: string;
  configSynonym: string;
  configVersion: string;
  configVendor: string;
  compatibilityMode: string;
  ibKind: 'file' | 'server';
  ibPath: string;
  ibServer: string;
  ibRef: string;
  dbUser: string;
  platformVersion: string;
  platformPath: string;
  publishUrl: string;
  extensions: ProjectExtensionInfo[];
  /** Имена расширений с назначением Patch — объединяются одной строкой. */
  patches: string[];
}

export interface ProjectInfoResult {
  ok: boolean;
  info: ProjectInfo;
  infoUpdatedAt: string;
}

export interface ProjectRecord {
  name: string;
  projectDir: string;
  createdAt?: string;
  lastDeployAt?: string;
  publishUrl?: string;
  info?: ProjectInfo | null;
  infoUpdatedAt?: string;
}

export interface ProjectsResult {
  projects: ProjectRecord[];
}

export interface DeployManifest {
  name: string;
  projectDir: string;
  templateDir: string;
  /** Источник базы: файл выгрузки .dt или 1Cv8.cf шаблона конфигурации (D13). */
  dtPath: string;
  templateCfPath?: string;
  platformVersion: string;
  platformBinPath: string;
  ibcmdPath: string;
  dbUser: string;
  prefix: string;
  publishPort: number;
  apacheDir: string;
  features: {
    rulesAi: boolean;
    bslAnalyzer: boolean;
    platformContext: boolean;
  };
}
