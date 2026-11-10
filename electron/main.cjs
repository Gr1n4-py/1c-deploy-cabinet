/**
 * 1C Deploy Cabinet — Electron main-процесс.
 * Внутри приложения работает HTTP-сервер (127.0.0.1:8181): тот же API,
 * что был в backend/server.ps1 (decisions.md, D8), + раздача dist/.
 * Диалог выбора пути — нативный Electron (возвращает реальные пути,
 * открывается поверх окон).
 */
const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const http = require('http');
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawn } = require('child_process');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const PORT = 8181;
const APP_ORIGIN = `http://${HOST}:${PORT}`;
const DATA_DIR = path.join(process.env.LOCALAPPDATA, '1c-deploy-cabinet');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const REGISTRY_PATH = 'C:\\1C_Bases\\AI\\registry.json';
const DEPLOY_ROOT = 'C:\\1C_Bases\\AI';
const PLATFORM_ROOT = 'C:\\Program Files\\1cv8';
// Каталог установленных шаблонов конфигураций 1С (D13) — дефолт настройки tools.templatesRoot
const DEFAULT_TEMPLATES_ROOT = 'C:\\1C_Bases\\SHABLONI';

const DIST_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'dist')
  : path.join(__dirname, '..', 'dist');
// Runner развертки (этап 0): в пакете — resources/runner, в dev — runner/ проекта
const RUNNER_SCRIPT = app.isPackaged
  ? path.join(process.resourcesPath, 'runner', 'runner.ps1')
  : path.join(__dirname, '..', 'runner', 'runner.ps1');
// Иконка окна/панели задач (в собранном приложении лежит в resources/dist)
const ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'dist', 'icon.png')
  : path.join(__dirname, '..', 'dist', 'icon.png');

let mainWindow = null;
// true, пока в окне открыт внешний сайт (например, Глаша)
let externalMode = false;

// ---------- утилиты ----------

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); }
    });
  });
}

// ---------- обнаружение ПО ----------

function platformDirs() {
  if (!fs.existsSync(PLATFORM_ROOT)) return [];
  return fs.readdirSync(PLATFORM_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PLATFORM_ROOT, d.name, 'bin', '1cv8.exe')))
    .map((d) => ({ name: d.name, ver: d.name.split('.').map((n) => parseInt(n, 10) || 0) }))
    .sort((a, b) => {
      for (let i = 0; i < 4; i++) {
        const ai = a.ver[i] || 0;
        const bi = b.ver[i] || 0;
        if (ai !== bi) return bi - ai;
      }
      return 0;
    })
    .map((d) => d.name);
}

function scanBsl(root, depth = 0, out = []) {
  if (depth > 2 || !fs.existsSync(root)) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) scanBsl(full, depth + 1, out);
    else if (/\.exe$/i.test(e.name) && /bsl/i.test(e.name)) out.push(full);
  }
  return out;
}

function findTool(id) {
  const localAppData = process.env.LOCALAPPDATA || '';
  const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates = [];
  switch (id) {
    case 'projectsRoot':
      candidates.push('C:\\1C_Bases\\AI\\projects');
      break;
    case 'templateDir':
      candidates.push('C:\\1C_Bases\\AI\\1c-deploy_new\\template');
      break;
    case 'templatesRoot':
      candidates.push(DEFAULT_TEMPLATES_ROOT);
      break;
    case 'vscode':
      candidates.push(path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'));
      break;
    case 'git': {
      const w = spawnSync('where', ['git.exe'], { encoding: 'utf8' });
      if (w.status === 0) candidates.push(...w.stdout.split(/\r?\n/).filter(Boolean));
      candidates.push(path.join(progFiles, 'Git', 'bin', 'git.exe'));
      break;
    }
    case 'platform1c': {
      const dirs = platformDirs();
      if (dirs.length > 0) candidates.push(path.join(PLATFORM_ROOT, dirs[0], 'bin', '1cv8.exe'));
      break;
    }
    case 'ibcmd': {
      const dirs = platformDirs();
      if (dirs.length > 0) candidates.push(path.join(PLATFORM_ROOT, dirs[0], 'bin', 'ibcmd.exe'));
      break;
    }
    case 'apache':
      candidates.push('C:\\1C_Bases\\AI\\tools\\apache_portable\\Apache24\\bin\\httpd.exe');
      break;
    case 'java': {
      const w = spawnSync('where', ['java.exe'], { encoding: 'utf8' });
      if (w.status === 0) candidates.push(...w.stdout.split(/\r?\n/).filter(Boolean));
      if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
      break;
    }
    case 'bslAnalyzer':
      candidates.push(...scanBsl(path.join(localAppData, 'Programs')));
      break;
    default:
      break;
  }
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return { found: true, path: p };
  }
  return { found: false, path: '' };
}

// ---------- встроенный браузер внешних сайтов (Глаша) ----------

function injectBackButton() {
  const js = [
    '(function () {',
    "  if (document.getElementById('cabinet-back-btn')) return;",
    "  var b = document.createElement('button');",
    "  b.id = 'cabinet-back-btn';",
    "  b.textContent = '\\u2190 Вернуться в личный кабинет';",
    "  b.style.cssText = 'position:fixed;top:14px;left:14px;z-index:2147483647;padding:10px 18px;background:#4f8cff;color:#fff;border:none;border-radius:8px;font:600 14px Segoe UI,Arial,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)';",
    `  b.onclick = function () { location.href = '${APP_ORIGIN}/#/desktop'; };`,
    "  document.body.appendChild(b);",
    '})();',
  ].join('\n');
  mainWindow.webContents.executeJavaScript(js).catch(() => {});
}

// ---------- API-обработчики ----------

async function handleSettingsGet(res) {
  const s = await readJson(SETTINGS_PATH);
  send(res, 200, s ?? { version: 1, tools: {} });
}

async function handleSettingsPut(req, res) {
  const body = await readBody(req);
  if (!body) {
    send(res, 400, { error: 'Ожидался JSON' });
    return;
  }
  await writeJson(SETTINGS_PATH, body);
  send(res, 200, { ok: true });
}

async function handleToolsCheck(req, res) {
  const body = await readBody(req);
  const p = String(body?.path ?? '');
  if (!p.trim()) {
    send(res, 200, { exists: false });
    return;
  }
  const kind = String(body?.kind ?? 'file') === 'dir' ? 'directory' : 'file';
  let exists = false;
  try {
    const st = fs.statSync(p);
    exists = kind === 'directory' ? st.isDirectory() : st.isFile();
  } catch {
    exists = false;
  }
  send(res, 200, { exists });
}

async function handleToolsDetect(req, res) {
  const body = await readBody(req);
  send(res, 200, findTool(String(body?.id ?? '')));
}

async function handleToolsBrowse(req, res) {
  const body = await readBody(req);
  const kind = String(body?.kind ?? 'file');
  const filter = String(body?.filter ?? '');
  const defaultPath = String(body?.defaultPath ?? '');
  let properties = ['openFile'];
  let filters = [{ name: 'Все файлы', extensions: ['*'] }];
  if (kind === 'dir') {
    properties = ['openDirectory', 'createDirectory'];
  } else if (filter === 'dt') {
    filters = [
      { name: 'Файлы выгрузки 1С (.dt)', extensions: ['dt'] },
      { name: 'Все файлы', extensions: ['*'] },
    ];
  } else if (filter === 'zip') {
    filters = [
      { name: 'Архивы ZIP', extensions: ['zip'] },
      { name: 'Все файлы', extensions: ['*'] },
    ];
  } else if (filter === 'exe') {
    filters = [
      { name: 'Исполняемые файлы', extensions: ['exe'] },
      { name: 'Все файлы', extensions: ['*'] },
    ];
  }
  const title = kind === 'dir' ? 'Выберите папку' : filter === 'dt' ? 'Выберите файл выгрузки (.dt)' : filter === 'zip' ? 'Выберите архив шаблона (.zip)' : 'Укажите путь';
  const options = { title, properties, filters };
  // Диалог открывается в каталоге текущего значения поля (если путь существует)
  if (defaultPath && fs.existsSync(defaultPath)) options.defaultPath = defaultPath;
  const result = await dialog.showOpenDialog(mainWindow, options);
  if (mainWindow) mainWindow.focus();
  if (!result.canceled && result.filePaths.length > 0) {
    send(res, 200, { found: true, path: result.filePaths[0] });
  } else {
    send(res, 200, { found: false, path: '' });
  }
}

async function handlePlatforms(res) {
  const platforms = platformDirs().map((name) => ({
    version: name,
    binPath: path.join(PLATFORM_ROOT, name, 'bin', '1cv8.exe'),
    ibcmdPath: path.join(PLATFORM_ROOT, name, 'bin', 'ibcmd.exe'),
  }));
  send(res, 200, { platforms });
}

async function handleUsers(req, res, query) {
  const users = await readJson(USERS_PATH).then((u) => (Array.isArray(u) ? u : []));
  const prefix = String(query.get('prefix') ?? '').trim().toLowerCase();
  const filtered = prefix
    ? users.filter((u) => typeof u.name === 'string' && u.name.toLowerCase().includes(prefix))
    : users;
  send(res, 200, { users: filtered });
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  const name = String(body?.name ?? '').trim();
  if (!name) {
    send(res, 400, { error: 'Не указано имя пользователя' });
    return;
  }
  const users = await readJson(USERS_PATH).then((u) => (Array.isArray(u) ? u : []));
  const now = new Date().toISOString();
  const existing = users.find((u) => typeof u.name === 'string' && u.name.toLowerCase() === name.toLowerCase());
  let isNew = true;
  if (existing) {
    isNew = false;
    existing.lastLoginAt = now;
  } else {
    users.push({ name, createdAt: now, lastLoginAt: now });
  }
  await writeJson(USERS_PATH, users);
  send(res, 200, { isNew });
}

async function handleDeploy(req, res) {
  const m = await readBody(req);
  if (!m) {
    send(res, 400, { errors: ['Тело запроса должно быть JSON-манифестом'] });
    return;
  }
  const errors = [];
  const name = String(m.name ?? '');
  const projectDir = String(m.projectDir ?? '');
  const dtPath = String(m.dtPath ?? '');
  const templateCfPath = String(m.templateCfPath ?? '');
  const platform = String(m.platformVersion ?? '');
  const dbUser = String(m.dbUser ?? '');
  const prefix = String(m.prefix ?? '');
  const apacheDir = String(m.apacheDir ?? '');

  if (!name.trim()) errors.push('Не указано имя проекта');
  if (!projectDir.trim()) errors.push('Не указана папка проекта');
  // Источник базы: файл выгрузки .dt или 1Cv8.cf шаблона конфигурации (D13)
  if (!dtPath.trim() && !templateCfPath.trim()) errors.push('Не указан источник базы: файл .dt или шаблон конфигурации');
  if (dtPath.trim() && (!fs.existsSync(dtPath) || !fs.statSync(dtPath).isFile())) errors.push(`Файл .dt не найден: ${dtPath}`);
  if (templateCfPath.trim() && (!fs.existsSync(templateCfPath) || !fs.statSync(templateCfPath).isFile())) errors.push(`Файл конфигурации шаблона 1Cv8.cf не найден: ${templateCfPath}`);
  if (dtPath.trim() && templateCfPath.trim()) errors.push('Укажите только один источник базы: .dt или шаблон конфигурации');
  if (!platform.trim()) errors.push('Не выбрана платформа');
  const noUsers = Boolean(m.noUsers);
  if (!noUsers && !dbUser.trim()) errors.push('Не указан пользователь ИБ');
  if (!prefix.trim()) errors.push('Не указан префикс');

  const port = parseInt(String(m.publishPort ?? ''), 10);
  if (!Number.isFinite(port)) errors.push('Порт публикации должен быть числом');
  else if (port <= 1024 || port > 65535) errors.push('Порт публикации должен быть в диапазоне 1025–65535');

  if (!apacheDir.trim()) errors.push('Не указан каталог Apache');
  else if (!fs.existsSync(apacheDir) || !fs.statSync(apacheDir).isDirectory()) errors.push(`Каталог Apache не найден: ${apacheDir}`);

  if (errors.length > 0) {
    send(res, 400, { errors });
    return;
  }

  const runId = crypto.randomUUID().replace(/-/g, '');
  const runDir = path.join(DEPLOY_ROOT, 'runs', runId);
  await fsp.mkdir(runDir, { recursive: true });

  // Пароль ИБ в манифест не попадает (D7: секреты в открытом виде не храним, DPAPI — этап 0)
  const manifest = {
    runId,
    runDir,
    name,
    projectDir,
    templateDir: String(m.templateDir ?? ''),
    ibSource: templateCfPath ? 'template-cf' : 'dt',
    dtPath,
    templateCfPath,
    platformVersion: platform,
    platformBinPath: String(m.platformBinPath ?? ''),
    platformPath: String(m.platformPath ?? String(m.platformBinPath ?? '').replace(/[\\/]+bin[\\/]+1cv8\.exe$/i, '')),
    ibcmdPath: String(m.ibcmdPath ?? ''),
    dbUser: noUsers ? '' : dbUser,
    dbPassword: String(m.dbPassword ?? ''),
    dbPasswordStored: 'нет — пароль сохраняется отдельно (DPAPI, этап 0)',
    noUsers,
    prefix,
    publishPort: port,
    apacheDir,
    features: {
      rulesAi: Boolean(m.features?.rulesAi),
      bslAnalyzer: Boolean(m.features?.bslAnalyzer),
      platformContext: Boolean(m.features?.platformContext),
    },
    createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(runDir, 'manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const evt = JSON.stringify({ ts: new Date().toISOString(), step: 'prepare', phase: 'manifest-saved', detail: manifestPath });
  await fsp.appendFile(path.join(runDir, 'steps.jsonl'), evt + '\r\n', 'utf8');

  // Запускаем runner.ps1 (этап 0) отдельным скрытым процессом:
  // он исполняет шаги и сам пишет события в steps.jsonl + state.json.
  // Консольный вывод runner — в runDir\runner-console.log (диагностика запуска).
  const psArgs = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', RUNNER_SCRIPT,
    '-Manifest', manifestPath,
  ];
  const runnerConsoleLog = path.join(runDir, 'runner-console.log');
  const consoleFd = fs.openSync(runnerConsoleLog, 'a');
  fs.writeSync(consoleFd, `\r\n=== runner запущен ${new Date().toISOString()} ===\r\n`);
  // NB: detached+windowsHide вместе ломают запуск powershell из Electron
  // (молчаый выход без выполнения скрипта) — используется только windowsHide
  const child = spawn('powershell.exe', psArgs, { stdio: ['ignore', consoleFd, consoleFd], windowsHide: true });
  const pid = child.pid;
  child.unref();
  fs.closeSync(consoleFd);
  console.log(`[cabinet] runner запущен: PID ${pid}, прогон ${runId}`);

  send(res, 200, { runId, runDir, manifestPath });
}

// Реестр проектов (D7): registry.json в корне разверток
async function readRegistry() {
  const r = await readJson(REGISTRY_PATH);
  const projects = r?.projects;
  return Array.isArray(projects) ? projects : [];
}

async function handleProjects(res) {
  send(res, 200, { projects: await readRegistry() });
}

async function handleProjectsDelete(req, res) {
  const body = await readBody(req);
  const projectDir = String(body?.projectDir ?? '').trim();
  const deleteFiles = Boolean(body?.deleteFiles);
  if (!projectDir) {
    send(res, 400, { error: 'Не указан projectDir' });
    return;
  }
  // Защита от удаления критичных каталогов
  const normalized = path.resolve(projectDir).toLowerCase();
  const forbidden = [
    path.parse(normalized).root,
    'c:\\1c_bases\\ai',
    DATA_DIR.toLowerCase(),
    path.resolve('C:\\1C_Bases\\AI\\runs').toLowerCase(),
  ];
  if (forbidden.includes(normalized.replace(/\\+$/, ''))) {
    send(res, 400, { error: 'Удаление этого каталога запрещено' });
    return;
  }

  // 1. Удалить из реестра
  const registry = await readJson(REGISTRY_PATH);
  const projects = Array.isArray(registry?.projects) ? registry.projects : [];
  const kept = projects.filter((p) => path.resolve(String(p.projectDir ?? '')).toLowerCase() !== normalized);
  await writeJson(REGISTRY_PATH, { version: 1, projects: kept });

  // 2. Удалить файлы проекта (по флагу)
  let filesDeleted = false;
  if (deleteFiles && fs.existsSync(normalized)) {
    try {
      await fsp.rm(normalized, { recursive: true, force: true });
      filesDeleted = true;
    } catch (err) {
      send(res, 500, { error: `Не удалось удалить папку проекта: ${err.message}` });
      return;
    }
  }
  send(res, 200, { ok: true, filesDeleted });
}

// ---------- шаблоны конфигураций 1С (D13) ----------

// Разбор 1cv8.mft шаблона: Vendor/Name/Version/AppVersion + секции [ConfigN]
// (Catalog/Destination/Source). Секция с «демонстраци*» в Catalog — демо-выгрузка.
function parseMft(text) {
  const out = { vendor: '', name: '', version: '', appVersion: '', configs: [] };
  let current = null;
  for (const line of String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (/^\[Config\d+\]$/i.test(t)) {
      current = { catalog: '', destination: '', source: '', demo: false };
      out.configs.push(current);
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(t);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();
    if (current) {
      if (key === 'Catalog') { current.catalog = val; current.demo = /демо/i.test(val); }
      else if (key === 'Source') current.source = val;
      else if (key === 'Destination') current.destination = val;
    } else {
      if (key === 'Vendor') out.vendor = val;
      else if (key === 'Name') out.name = val;
      else if (key === 'Version') out.version = val;
      else if (key === 'AppVersion') out.appVersion = val;
    }
  }
  return out;
}

// Реестр установленных шаблонов: сканирование <root>\<разработчик>\<имя>\<версия>.
// Шаблон = каталог с 1Cv8.cf или хотя бы одним *.dt. Источники — секции mft
// (новая база / демо) либо все *.dt без mft.
function scanTemplates(root) {
  const out = [];
  let vendors;
  try { vendors = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const vendor of vendors) {
    if (!vendor.isDirectory()) continue;
    let names;
    try { names = fs.readdirSync(path.join(root, vendor.name), { withFileTypes: true }); } catch { continue; }
    for (const name of names) {
      if (!name.isDirectory()) continue;
      let versions;
      try { versions = fs.readdirSync(path.join(root, vendor.name, name.name), { withFileTypes: true }); } catch { continue; }
      for (const ver of versions) {
        if (!ver.isDirectory()) continue;
        const dir = path.join(root, vendor.name, name.name, ver.name);
        const cfPath = path.join(dir, '1Cv8.cf');
        const mftPath = path.join(dir, '1cv8.mft');
        let files;
        try { files = fs.readdirSync(dir); } catch { continue; }
        const hasCf = files.some((f) => f.toLowerCase() === '1cv8.cf');
        const dts = files.filter((f) => /\.dt$/i.test(f));
        if (!hasCf && dts.length === 0) continue;
        const mft = files.some((f) => f.toLowerCase() === '1cv8.mft')
          ? parseMft(fs.readFileSync(mftPath, 'utf8'))
          : null;
        let sources = mft && mft.configs.length > 0
          ? mft.configs.filter((c) => c.source).map((c) => ({
              file: c.source,
              demo: c.demo,
              label: c.catalog || c.source,
            }))
          : dts.map((f) => ({ file: f, demo: true, label: f }));
        sources = sources.filter((s) => fs.existsSync(path.join(dir, s.file)));
        if (sources.length === 0 && !hasCf) continue;
        out.push({
          vendor: vendor.name,
          name: name.name,
          version: ver.name,
          dir,
          cfPath: hasCf ? cfPath : '',
          mft: mft ? { vendor: mft.vendor, name: mft.name, version: mft.version, appVersion: mft.appVersion } : null,
          sources,
        });
      }
    }
  }
  out.sort((a, b) => (a.vendor + '\\' + a.name + '\\' + a.version).localeCompare(b.vendor + '\\' + b.name + '\\' + b.version, 'ru'));
  return out;
}

async function handleTemplates(res) {
  const root = (await resolveToolPath('templatesRoot')) || DEFAULT_TEMPLATES_ROOT;
  send(res, 200, { root, templates: scanTemplates(root) });
}

// Установка шаблона из скачанного zip (D13): распаковка во временную папку
// (Expand-Archive — в Node нет встроенного zip), поиск файлов шаблона
// (1cv8.mft / 1Cv8.cf) в корне архива или на 2 уровнях ниже, копирование в
// дерево каталога шаблонов. Если в архиве только setup.exe — тихая установка
// не поддерживается (ключ не определен эмпирически), сообщаем пользователю.
function sanitizeName(s) {
  return String(s ?? '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'Без имени';
}

function findTemplateRoots(base) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const hasMft = entries.some((e) => e.isFile() && /^1cv8\.mft$/i.test(e.name));
    const hasCf = entries.some((e) => e.isFile() && /^1cv8\.cf$/i.test(e.name));
    if (hasMft || hasCf) {
      const mft = hasMft ? parseMft(fs.readFileSync(path.join(dir, '1cv8.mft'), 'utf8')) : null;
      const rel = path.relative(base, dir).split(/[\\/]/).filter(Boolean);
      found.push({
        dir,
        vendor: sanitizeName(mft?.vendor || rel[rel.length - 3] || 'Импорт'),
        name: sanitizeName(mft?.name || rel[rel.length - 2] || rel[rel.length - 1] || 'Шаблон'),
        version: sanitizeName(mft?.version || rel[rel.length - 1] || '1.0'),
      });
      return;
    }
    if (depth >= 3) return;
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(base, 0);
  return found;
}

async function copyDirContents(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDirContents(s, d);
    else await fsp.copyFile(s, d);
  }
}

async function handleTemplatesInstall(req, res) {
  const body = await readBody(req);
  const zipPath = String(body?.zipPath ?? '').trim();
  if (!zipPath) {
    send(res, 400, { error: 'Не указан zipPath архива шаблона' });
    return;
  }
  if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile() || !/\.zip$/i.test(zipPath)) {
    send(res, 400, { error: `Файл .zip не найден: ${zipPath}` });
    return;
  }
  const root = (await resolveToolPath('templatesRoot')) || DEFAULT_TEMPLATES_ROOT;
  const tmp = path.join(process.env.TEMP || path.join(process.env.LOCALAPPDATA, 'Temp'), `cabinet-template-${Date.now()}`);
  try {
    await fsp.mkdir(tmp, { recursive: true });
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${tmp}" -Force`,
    ], { encoding: 'utf8', timeout: 180000, windowsHide: true });
    if (r.error) throw r.error;
    if (r.status !== 0) {
      throw new Error('не удалось распаковать архив: ' + ((r.stderr || r.stdout || '').trim() || 'код ' + r.status));
    }
    const found = findTemplateRoots(tmp);
    if (found.length === 0) {
      const hasSetup = (function walk(dir, depth) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
        if (entries.some((e) => e.isFile() && /^setup\.exe$/i.test(e.name))) return true;
        if (depth >= 3) return false;
        for (const e of entries) {
          if (e.isDirectory() && walk(path.join(dir, e.name), depth + 1)) return true;
        }
        return false;
      })(tmp, 0);
      send(res, 400, {
        error: hasSetup
          ? `В архиве только установщик setup.exe без файлов шаблона — автоматическая установка не поддерживается (тихий ключ не определен). Установите шаблон вручную, файлы должны оказаться в: ${root}`
          : 'В архиве не найдены файлы шаблона (1cv8.mft или 1Cv8.cf)',
      });
      return;
    }
    const installed = [];
    for (const t of found) {
      const target = path.join(root, t.vendor, t.name, t.version);
      await copyDirContents(t.dir, target);
      installed.push(target);
    }
    console.log(`[cabinet] шаблон установлен: ${installed.join(', ')}`);
    send(res, 200, { ok: true, installed });
  } catch (err) {
    send(res, 500, { error: `Не удалось установить шаблон: ${err.message}` });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- Apache portable: проверка и автозапуск при старте кабинета ----------

const DEFAULT_APACHE_HTTPD = 'C:\\1C_Bases\\AI\\tools\\apache_portable\\Apache24\\bin\\httpd.exe';

function probeTcpPort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// Порт Listen из conf\httpd.conf (первая незакомментированная директива;
// поддерживаются формы "Listen 8080" и "Listen 127.0.0.1:8080")
async function apacheListenPort(httpdPath) {
  const conf = path.join(path.dirname(path.dirname(httpdPath)), 'conf', 'httpd.conf');
  try {
    const text = await fsp.readFile(conf, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*Listen\s+[A-Za-z0-9.\[\]:]*?(\d+)\s*$/.exec(line);
      if (m) return parseInt(m[1], 10);
    }
  } catch {
    // нет конфига — порт неизвестен
  }
  return 0;
}

// Если Apache portable еще не работает — запустить httpd.exe скрыто
async function ensureApacheRunning() {
  const settings = await readJson(SETTINGS_PATH);
  const fromSettings = settings?.tools?.apache?.path;
  const httpdPath = fromSettings && fs.existsSync(fromSettings) ? fromSettings : DEFAULT_APACHE_HTTPD;
  if (!fs.existsSync(httpdPath)) {
    console.log('[cabinet] Apache portable не найден — автозапуск пропущен');
    return;
  }
  const port = await apacheListenPort(httpdPath);
  if (port > 0 && await probeTcpPort(port)) {
    console.log(`[cabinet] Apache portable уже работает на порту ${port}`);
    return;
  }
  spawn(httpdPath, [], { cwd: path.dirname(httpdPath), detached: true, stdio: 'ignore', windowsHide: true }).unref();
  console.log(`[cabinet] Apache portable запущен (порт ${port > 0 ? port : '?'}), проверка через 3 с…`);
  setTimeout(() => {
    void probeTcpPort(port > 0 ? port : 8080).then((ok) => {
      console.log(ok ? '[cabinet] Apache portable отвечает' : '[cabinet] Apache пока не отвечает (см. лог Apache)');
    });
  }, 3000);
}

// ---------- детали проекта (инфо из выгрузки исходников) ----------

function decodeXmlEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlTag(text, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(text);
  return m ? decodeXmlEntities(m[1]).trim() : '';
}

function xmlSynonym(text) {
  const m = /<Synonym>[\s\S]*?<v8:content>([^<]*)<\/v8:content>/.exec(text);
  return m ? decodeXmlEntities(m[1]).trim() : '';
}

// Свойства (Name/Version/Vendor/...) лежат в начале XML — хватает «головы» файла
function parseMetadataHead(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(262144);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, bytes).replace(/^\uFEFF/, '');
  } finally {
    fs.closeSync(fd);
  }
}

// .dev.env проекта: строки KEY=VALUE (без внешних модулей)
function parseDevEnvMap(projectDir) {
  const out = {};
  try {
    const text = fs.readFileSync(path.join(projectDir, '.dev.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {
    // нет файла — пустая карта
  }
  return out;
}

const PURPOSE_RU = { AddOn: 'добавление', Patch: 'патч', Customization: 'доработка' };

function collectProjectInfo(projectDir) {
  const devEnv = parseDevEnvMap(projectDir);

  const cfgPath = path.join(projectDir, 'src', 'cf', 'Configuration.xml');
  if (!fs.existsSync(cfgPath)) {
    throw new Error('не найдена выгрузка конфигурации src\\cf\\Configuration.xml (сначала выполните дамп конфигурации)');
  }
  const cfg = parseMetadataHead(cfgPath);

  const extensions = [];
  const extRoot = path.join(projectDir, 'src', 'cfe');
  let extEntries;
  try {
    extEntries = fs.readdirSync(extRoot, { withFileTypes: true });
  } catch {
    extEntries = [];
  }
  for (const e of extEntries) {
    if (!e.isDirectory()) continue;
    const extCfg = path.join(extRoot, e.name, 'Configuration.xml');
    if (!fs.existsSync(extCfg)) continue;
    const x = parseMetadataHead(extCfg);
    const purpose = xmlTag(x, 'ConfigurationExtensionPurpose');
    extensions.push({
      name: xmlTag(x, 'Name') || e.name,
      synonym: xmlSynonym(x),
      version: xmlTag(x, 'Version'),
      purpose,
    });
  }
  extensions.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const patches = extensions.filter((x) => x.purpose === 'Patch').map((x) => x.synonym || x.name);
  const otherExts = extensions.filter((x) => x.purpose !== 'Patch');

  const ibKind = String(devEnv.INFOBASE_KIND ?? 'file') === 'server' ? 'server' : 'file';
  return {
    configName: xmlTag(cfg, 'Name'),
    configSynonym: xmlSynonym(cfg),
    configVersion: xmlTag(cfg, 'Version'),
    configVendor: xmlTag(cfg, 'Vendor'),
    compatibilityMode: xmlTag(cfg, 'ConfigurationExtensionCompatibilityMode'),
    ibKind,
    ibPath: ibKind === 'file' ? String(devEnv.INFOBASE_PATH ?? '') : '',
    ibServer: ibKind === 'server' ? String(devEnv.INFOBASE_SRVR ?? '') : '',
    ibRef: ibKind === 'server' ? String(devEnv.INFOBASE_REF ?? '') : '',
    dbUser: String(devEnv.IB_USER ?? ''),
    platformVersion: String(devEnv.PLATFORM_VERSION ?? ''),
    platformPath: String(devEnv.PLATFORM_PATH ?? ''),
    publishUrl: String(devEnv.INFOBASE_PUBLISH_URL ?? ''),
    extensions: otherExts,
    patches,
  };
}

// «Обновить информацию по проекту»: транзакционно — старые данные в реестре
// остаются, пока новая информация не собрана полностью
async function handleProjectsInfo(req, res) {
  const body = await readBody(req);
  const projectDir = String(body?.projectDir ?? '').trim();
  if (!projectDir) {
    send(res, 400, { error: 'Не указан projectDir' });
    return;
  }
  try {
    const info = collectProjectInfo(projectDir);
    const registry = await readJson(REGISTRY_PATH);
    const projects = Array.isArray(registry?.projects) ? registry.projects : [];
    const normalized = path.resolve(projectDir).toLowerCase();
    const entry = projects.find((p) => path.resolve(String(p.projectDir ?? '')).toLowerCase() === normalized);
    if (!entry) throw new Error('проект не найден в реестре');
    if (!info.publishUrl && entry.publishUrl) info.publishUrl = String(entry.publishUrl);
    const now = new Date().toISOString();
    entry.info = info;
    entry.infoUpdatedAt = now;
    await writeJson(REGISTRY_PATH, registry ?? { version: 1, projects });
    send(res, 200, { ok: true, info, infoUpdatedAt: now });
  } catch (err) {
    send(res, 500, { error: `Не удалось обновить данные по проекту по причине: ${err.message}` });
  }
}

// Путь к инструменту из настроек кабинета, фолбэк — автопоиск
async function resolveToolPath(id) {
  const settings = await readJson(SETTINGS_PATH);
  const fromSettings = settings?.tools?.[id]?.path;
  if (fromSettings && fs.existsSync(fromSettings)) return fromSettings;
  const detected = findTool(id);
  return detected.found ? detected.path : '';
}

function findProjectEntry(projects, projectDir) {
  const normalized = path.resolve(projectDir).toLowerCase();
  return projects.find((p) => path.resolve(String(p.projectDir ?? '')).toLowerCase() === normalized);
}

// Открыть проект: vscode (Code.exe), designer/enterprise (1cv8.exe DESIGNER|ENTERPRISE).
// Подключение — из .dev.env проекта: file → /F"путь", server → /S"сервер\база",
// пользователь/пароль ИБ — IB_USER/IB_PASSWORD из .dev.env.
async function handleProjectsOpen(req, res) {
  const body = await readBody(req);
  const projectDir = String(body?.projectDir ?? '').trim();
  const target = String(body?.target ?? '').trim();
  if (!['vscode', 'designer', 'enterprise'].includes(target)) {
    send(res, 400, { error: 'Неизвестное действие открытия (vscode | designer | enterprise)' });
    return;
  }
  const registry = await readJson(REGISTRY_PATH);
  const projects = Array.isArray(registry?.projects) ? registry.projects : [];
  const entry = projectDir ? findProjectEntry(projects, projectDir) : null;
  if (!entry) {
    send(res, 400, { error: 'Проект не найден в реестре' });
    return;
  }

  const devEnv = parseDevEnvMap(entry.projectDir);

  if (target === 'vscode') {
    const codePath = await resolveToolPath('vscode');
    if (!codePath) {
      send(res, 400, { error: 'VS Code не найден — укажите путь к Code.exe в настройках кабинета' });
      return;
    }
    // -r: если VS Code уже запущен, проект открывается в последнем активном окне
    // вместо нового окна/экземпляра
    spawn(codePath, ['-r', entry.projectDir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    send(res, 200, { ok: true });
    return;
  }

  const mode = target === 'designer' ? 'DESIGNER' : 'ENTERPRISE';
  // Платформа — та же, что в карточке проекта (.dev.env: PLATFORM_VERSION/
  // PLATFORM_PATH). Нюансы запуска:
  // - Конфигуратор (DESIGNER): только через ЛАУНЧЕР 1cv8.exe — толстый клиент
  //   1cv8c.exe ключ DESIGNER не распознает и молча открывает Предприятие;
  // - Предприятие (ENTERPRISE): толстый клиент 1cv8c.exe НАПРЯМУЮ из 64-битной
  //   установки — лаунчер иначе сам выбирает per-user x86-клиент
  //   (%LOCALAPPDATA%\Programs\1cv8_x86), даже если 64-бит установлена.
  const ver = String(devEnv.PLATFORM_VERSION ?? '');
  const exeName = target === 'designer' ? '1cv8.exe' : '1cv8c.exe';
  const candidates = [];
  if (ver) candidates.push(path.join('C:\\Program Files\\1cv8', ver, 'bin', exeName));
  if (devEnv.PLATFORM_PATH) {
    candidates.push(path.join(devEnv.PLATFORM_PATH, 'bin', exeName));
    if (target !== 'designer') {
      // Предприятие: фолбэк на лаунчер, если толстого клиента нет
      candidates.push(path.join(devEnv.PLATFORM_PATH, 'bin', '1cv8.exe'));
    }
  }
  const fromSettings = await resolveToolPath('platform1c');
  if (fromSettings) candidates.push(fromSettings);
  const binPath = candidates.find((c) => c && fs.existsSync(c));
  if (!binPath) {
    send(res, 400, { error: 'Не найден клиент 1С (1cv8c.exe/1cv8.exe) — задайте платформу в .dev.env проекта (PLATFORM_PATH) или в настройках кабинета' });
    return;
  }
  // 32-битные установки: Program Files (x86) и per-user 1cv8_x86.
  // Разрядность честно показываем только для прямого запуска 1cv8c.exe —
  // лаунчер 1cv8.exe сам выбирает клиента (может запустить x86).
  const arch = /1cv8c\.exe$/i.test(binPath)
    ? (/program files \(x86\)|1cv8_x86/i.test(binPath) ? 'x86' : 'x64')
    : '';

  // Ключ и значение — РАЗНЫЕ аргументы: склеенный токен /F"путь" Node
  // экранирует кавычками и 1cv8 его не распознает (ошибка «C:\1Cv8.1CD»)
  const kind = String(devEnv.INFOBASE_KIND ?? 'file') === 'server' ? 'server' : 'file';
  const args = [mode];
  if (kind === 'file') {
    const ibPath = String(devEnv.INFOBASE_PATH ?? '');
    if (!ibPath || !fs.existsSync(ibPath)) {
      send(res, 400, { error: `Каталог файловой ИБ не найден: ${ibPath || '(не задан в .dev.env)'}` });
      return;
    }
    args.push('/F', ibPath);
  } else {
    const srvr = String(devEnv.INFOBASE_SRVR ?? '');
    const ref = String(devEnv.INFOBASE_REF ?? '');
    if (!srvr || !ref) {
      send(res, 400, { error: 'Для серверной ИБ не заданы сервер/имя базы в .dev.env (INFOBASE_SRVR, INFOBASE_REF)' });
      return;
    }
    args.push('/S', `${srvr}\\${ref}`);
  }
  const user = String(devEnv.IB_USER ?? '');
  if (user) args.push('/N', user);
  const pwd = String(devEnv.IB_PASSWORD ?? '');
  if (pwd) args.push('/P', pwd);

  // cwd — каталог проекта: crash-dump'ы 1cv8 пишутся в рабочий каталог
  // процесса и не должны засорять папку exe кабинета
  spawn(binPath, args, { cwd: entry.projectDir, detached: true, stdio: 'ignore', windowsHide: false }).unref();
  console.log(`[cabinet] ${mode}: ${binPath} (${arch})`);
  send(res, 200, { ok: true, mode, binPath, arch });
}

// Проверка доступности публикации проекта: GET на publishUrl (веб-клиент).
// Ресурсоемкость — один локальный HTTP-запрос (миллисекунды); ответ 4xx
// (например, страница входа) считается «доступна», 5xx/таймаут/обрыв — нет.
async function handleProjectsCheckPublish(req, res) {
  const body = await readBody(req);
  const url = String(body?.publishUrl ?? '').trim();
  if (!/^https?:\/\//i.test(url)) {
    send(res, 200, { online: false, reason: 'no-url' });
    return;
  }
  const started = Date.now();
  const online = await new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const u = new URL(url);
      const rq = http.request(
        { host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET', timeout: 4000 },
        (resp) => {
          resp.resume(); // тело не нужно
          done(resp.statusCode > 0 && resp.statusCode < 500);
          rq.destroy();
        },
      );
      rq.on('timeout', () => { rq.destroy(); done(false); });
      rq.on('error', () => done(false));
      rq.end();
    } catch {
      done(false);
    }
  });
  send(res, 200, { online, ms: Date.now() - started });
}

// Статус прогона для монитора мастера: state.json + события steps.jsonl
async function handleDeployStatus(res, query) {
  const runId = String(query.get('runId') ?? '').trim();
  if (!/^[a-f0-9]{32}$/.test(runId)) {
    send(res, 400, { error: 'Некорректный runId' });
    return;
  }
  const runDir = path.join(DEPLOY_ROOT, 'runs', runId);
  const state = await readJson(path.join(runDir, 'state.json'));
  let events = [];
  try {
    const text = await fsp.readFile(path.join(runDir, 'steps.jsonl'), 'utf8');
    events = text.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { }
  send(res, 200, {
    status: state?.status ?? 'unknown',
    currentStep: state?.currentStep ?? '',
    error: state?.error ?? '',
    startedAt: state?.startedAt ?? '',
    finishedAt: state?.finishedAt ?? '',
    steps: state?.steps ?? {},
    events,
  });
}

// ---------- статика ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(res, urlPath) {
  const rel = !urlPath || urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const distFull = path.resolve(DIST_DIR);
  let full = path.resolve(path.join(DIST_DIR, rel));
  if (!full.toLowerCase().startsWith(distFull.toLowerCase())) {
    send(res, 404, { error: 'not found' });
    return;
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    // SPA-фолбэк: путь без расширения отдаем как index.html
    if (!/\.[A-Za-z0-9]+$/.test(rel)) full = path.join(DIST_DIR, 'index.html');
    if (!fs.existsSync(full)) {
      send(res, 404, { error: 'dist не собран: npm.cmd run build' });
      return;
    }
  }
  const ext = path.extname(full).toLowerCase();
  const body = await fsp.readFile(full);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(body);
}

// ---------- HTTP-сервер ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  console.log(`[cabinet] ${req.method} ${p}`);
  try {
    if (p === '/api/settings' && req.method === 'GET') return await handleSettingsGet(res);
    if (p === '/api/settings' && req.method === 'PUT') return await handleSettingsPut(req, res);
    if (p === '/api/tools/check' && req.method === 'POST') return await handleToolsCheck(req, res);
    if (p === '/api/tools/detect' && req.method === 'POST') return await handleToolsDetect(req, res);
    if (p === '/api/tools/browse' && req.method === 'POST') return await handleToolsBrowse(req, res);
    if (p === '/api/platforms' && req.method === 'GET') return await handlePlatforms(res);
    if (p === '/api/templates' && req.method === 'GET') return await handleTemplates(res);
    if (p === '/api/templates/install' && req.method === 'POST') return await handleTemplatesInstall(req, res);
    if (p === '/api/users' && req.method === 'GET') return await handleUsers(req, res, url.searchParams);
    if (p === '/api/login' && req.method === 'POST') return await handleLogin(req, res);
    if (p === '/api/deploy' && req.method === 'POST') return await handleDeploy(req, res);
    if (p === '/api/deploy/status' && req.method === 'GET') return await handleDeployStatus(res, url.searchParams);
    if (p === '/api/projects' && req.method === 'GET') return await handleProjects(res);
    if (p === '/api/projects/delete' && req.method === 'POST') return await handleProjectsDelete(req, res);
    if (p === '/api/projects/info' && req.method === 'POST') return await handleProjectsInfo(req, res);
    if (p === '/api/projects/open' && req.method === 'POST') return await handleProjectsOpen(req, res);
    if (p === '/api/projects/check-publish' && req.method === 'POST') return await handleProjectsCheckPublish(req, res);
    if (p.startsWith('/api')) return send(res, 404, { error: `unknown endpoint: ${req.method} ${p}` });
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(res, p);
    return send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error(`[cabinet] ошибка запроса: ${err.message}`);
    send(res, 500, { error: 'internal' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('[cabinet] Кабинет уже запущен — открываю существующий в браузере.');
    shell.openExternal(`http://${HOST}:${PORT}/`);
    app.exit(0);
  } else {
    console.error(`[cabinet] ошибка сервера: ${err.message}`);
    app.exit(1);
  }
});

// ---------- запуск ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Второй экземпляр: сервер уже занят, первый экземпляр покажет окно
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`[cabinet] API и статика: http://${HOST}:${PORT}/  (dist: ${DIST_DIR})`);
      Menu.setApplicationMenu(null);
      mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        title: 'Личный кабинет — 1С Deploy',
        autoHideMenuBar: true,
        icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      // Запуск развернутым; настоящий полный экран — F11
      mainWindow.maximize();
      mainWindow.show();

      // Внешние ссылки (Глаша и т.п.) открываем в нашем окне,
      // добавляя кнопку «Вернуться в личный кабинет»
      mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith(APP_ORIGIN)) {
          if (externalMode) externalMode = false; // возврат из внешнего сайта — пропускаем
          return;
        }
        event.preventDefault();
        externalMode = true;
        mainWindow.loadURL(url).then(() => injectBackButton()).catch(() => {});
      });
      mainWindow.webContents.on('did-finish-load', () => {
        if (externalMode) injectBackButton();
      });
      // target=_blank и popup'ы внешнего сайта — в системный браузер
      mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith(APP_ORIGIN)) return { action: 'allow' };
        shell.openExternal(url);
        return { action: 'deny' };
      });
      // F11 — переключение настоящего полного экрана
      mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'F11') {
          mainWindow.setFullScreen(!mainWindow.isFullScreen());
        }
      });

      mainWindow.loadURL(`http://${HOST}:${PORT}/`);
      mainWindow.on('closed', () => { mainWindow = null; });

      // Apache portable: если не запущен — стартовать при открытии кабинета
      void ensureApacheRunning().catch((err) => {
        console.error(`[cabinet] автозапуск Apache не удался: ${err.message}`);
      });
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
