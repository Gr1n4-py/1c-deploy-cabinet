import '../styles/login.css';
import { findUser, setLastUserName, upsertUserLogin } from '../lib/storage';
import { navigate } from '../router';
import { showToast } from '../components/toast';

/** Экран входа: логин + подсказка «найден / будет создан», вход или автосоздание. */
export function renderLoginPage(app: HTMLElement): void {
  const page = document.createElement('div');
  page.className = 'login-screen';
  page.innerHTML = `
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
        Прототип: данные хранятся локально в браузере.
      </div>
    </div>
  `;
  app.appendChild(page);

  const input = page.querySelector<HTMLInputElement>('[data-ref="login-input"]')!;
  const hint = page.querySelector<HTMLElement>('[data-ref="login-hint"]')!;
  const hintText = page.querySelector<HTMLElement>('[data-ref="login-hint-text"]')!;

  function updateHint(): void {
    const value = input.value.trim();
    if (!value) {
      hint.className = 'hint';
      hintText.textContent = '';
      return;
    }
    if (findUser(value)) {
      hint.className = 'hint found show';
      hintText.textContent = `Пользователь «${value}» уже есть на этом компьютере — вход в существующий профиль.`;
    } else {
      hint.className = 'hint new show';
      hintText.textContent = `Пользователь «${value}» не найден — при входе будет создан новый профиль.`;
    }
  }

  function submit(): void {
    const name = input.value.trim();
    if (!name) {
      hint.className = 'hint new show';
      hintText.textContent = 'Введите имя пользователя.';
      input.focus();
      return;
    }
    const { isNew } = upsertUserLogin(name);
    setLastUserName(name);
    showToast(isNew ? `Создан новый профиль: ${name}` : `Вы вошли как ${name}`);
    navigate('desktop');
  }

  input.addEventListener('input', updateHint);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  page.querySelector('[data-ref="login-btn"]')!.addEventListener('click', submit);
  input.focus();
}
