/** Верхняя панель рабочего стола: логотип, заголовок, чип пользователя, выход. */
import '../styles/topbar.css';

export interface TopBarOptions {
  userName: string;
  onLogout: () => void;
}

export function createTopBar({ userName, onLogout }: TopBarOptions): HTMLElement {
  const bar = document.createElement('header');
  bar.className = 'topbar';
  bar.innerHTML = `
    <div class="logo-badge">1С</div>
    <div class="topbar-title">Личный кабинет</div>
    <div class="topbar-spacer"></div>
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

  return bar;
}
