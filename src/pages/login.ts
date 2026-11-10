import '../styles/login.css';
import { findUser, setLastUserName, upsertUserLogin } from '../lib/storage';
import { apiGet, apiPost } from '../api/client';
import { navigate } from '../router';
import { showToast } from '../components/toast';

interface UsersResult {
  users: { name?: string }[];
}

interface LoginResult {
  isNew: boolean;
}

/**
 * Экран входа: логин + подсказка «найден / будет создан», вход или автосоздание.
 * Профили хранит бэкенд (users.json — общий для любых адресов/портов);
 * если бэкенд недоступен — фолбэк на localStorage этого браузера.
 */
export function renderLoginPage(app: HTMLElement): void {
  const page = document.createElement('div');
  page.className = 'login-screen';
  page.innerHTML = `
    <button class="settings-gear" data-ref="settings-btn" type="button" title="Настройки">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3.2"></circle>
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.87z"></path>
      </svg>
    </button>
    <div class="login-card">
      <div class="logo">
        <div class="logo-badge">1С</div>
        <h1>Личный кабинет</h1>
      </div>
      <div class="subtitle">Развертка и управление 1С-проектами</div>
      <label class="field-label">
        <span>Имя пользователя</span>
        <input class="login-input" data-ref="login-input" type="text"
               autocomplete="off" spellcheck="false" placeholder="например, vadim" />
      </label>
      <div class="hint" data-ref="login-hint">
        <span class="dot"></span>
        <span data-ref="login-hint-text"></span>
      </div>
      <button class="login-btn" data-ref="login-btn" type="button">Войти</button>
      <div class="login-note">
        Если пользователь ещё не зарегистрирован — профиль будет создан автоматически.<br>
        Профили хранятся локально на этом компьютере (users.json).
      </div>
    </div>
  `;
  app.appendChild(page);

  const input = page.querySelector<HTMLInputElement>('[data-ref="login-input"]')!;
  const hint = page.querySelector<HTMLElement>('[data-ref="login-hint"]')!;
  const hintText = page.querySelector<HTMLElement>('[data-ref="login-hint-text"]')!;
  const loginBtn = page.querySelector<HTMLButtonElement>('[data-ref="login-btn"]')!;

  let hintTimer: number | undefined;
  let hintSeq = 0;
  let loggingIn = false;

  function setHint(kind: '' | 'found' | 'new', text: string): void {
    hint.className = kind ? `hint ${kind} show` : 'hint';
    hintText.textContent = text;
  }

  // Подсказка: точное совпадение имени ищем через бэкенд (users.json),
  // при недоступном бэкенде — в localStorage этого браузера
  function updateHint(): void {
    const value = input.value.trim();
    window.clearTimeout(hintTimer);
    if (!value) {
      setHint('', '');
      return;
    }
    const seq = ++hintSeq;
    setHint('new', 'Проверяю…');
    hintTimer = window.setTimeout(async () => {
      let exists: boolean | null = null;
      try {
        const r = await apiGet<UsersResult>(`/api/users?prefix=${encodeURIComponent(value)}`, 5000);
        exists = r.users.some((u) => typeof u.name === 'string' && u.name.toLowerCase() === value.toLowerCase());
      } catch {
        exists = null; // бэкенд недоступен
      }
      if (seq !== hintSeq) return; // ввод уже изменился
      if (exists === null) {
        exists = !!findUser(value);
      }
      if (exists) {
        setHint('found', `Пользователь «${value}» уже есть на этом компьютере — вход в существующий профиль.`);
      } else {
        setHint('new', `Пользователь «${value}» не найден — при входе будет создан новый профиль.`);
      }
    }, 250);
  }

  async function submit(): Promise<void> {
    if (loggingIn) return;
    const name = input.value.trim();
    if (!name) {
      setHint('new', 'Введите имя пользователя.');
      input.focus();
      return;
    }
    loggingIn = true;
    loginBtn.disabled = true;
    let isNew = false;
    try {
      const r = await apiPost<LoginResult>('/api/login', { name }, 8000);
      isNew = r.isNew;
    } catch {
      // бэкенд недоступен — создаем/обновляем профиль локально
      isNew = upsertUserLogin(name).isNew;
      showToast('Бэкенд недоступен — профиль сохранен локально', 'warn');
    }
    setLastUserName(name);
    showToast(isNew ? `Создан новый профиль: ${name}` : `Вы вошли как ${name}`);
    loggingIn = false;
    loginBtn.disabled = false;
    navigate('desktop');
  }

  input.addEventListener('input', updateHint);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });
  loginBtn.addEventListener('click', () => void submit());
  page.querySelector('[data-ref="settings-btn"]')!.addEventListener('click', () => navigate('settings'));
  input.focus();
}
