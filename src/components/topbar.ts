/** Верхняя панель рабочего стола: логотип, заголовок, настройки, чип пользователя, выход. */
import '../styles/topbar.css';

export interface TopBarOptions {
  userName: string;
  onLogout: () => void;
  onSettings?: () => void;
}

export function createTopBar({ userName, onLogout, onSettings }: TopBarOptions): HTMLElement {
  const bar = document.createElement('header');
  bar.className = 'topbar';
  bar.innerHTML = `
    <div class="logo-badge">1С</div>
    <div class="topbar-title">Личный кабинет</div>
    <div class="topbar-spacer"></div>
    <button class="icon-btn" data-ref="settings-btn" type="button" title="Настройки">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3.2"></circle>
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.87z"></path>
      </svg>
    </button>
    <div class="user-chip">
      <div class="avatar" data-ref="user-avatar"></div>
      <span data-ref="user-name"></span>
    </div>
    <button class="logout-btn" data-ref="logout-btn" type="button">Выйти</button>
  `;

  // Пользовательский ввод вставляем только через textContent (не innerHTML)
  bar.querySelector<HTMLElement>('[data-ref="user-avatar"]')!.textContent = userName.charAt(0);
  bar.querySelector<HTMLElement>('[data-ref="user-name"]')!.textContent = userName;
  bar.querySelector<HTMLButtonElement>('[data-ref="logout-btn"]')!.addEventListener('click', onLogout);
  if (onSettings) {
    bar.querySelector<HTMLButtonElement>('[data-ref="settings-btn"]')!.addEventListener('click', onSettings);
  }

  return bar;
}
