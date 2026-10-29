import '../styles/desktop.css';
import { createTopBar } from '../components/topbar';
import { clearLastUser, getLastUserName } from '../lib/storage';
import { navigate } from '../router';

/** Рабочий стол: верхняя панель + заглушка под будущие проекты пользователя. */
export function renderDesktopPage(app: HTMLElement): void {
  const userName = getLastUserName();
  if (!userName) {
    // Нет сессии — на вход
    navigate('login');
    return;
  }

  const page = document.createElement('div');
  page.className = 'desktop-screen';

  page.appendChild(
    createTopBar({
      userName,
      onLogout: () => {
        clearLastUser();
        navigate('login');
      },
    }),
  );

  const area = document.createElement('main');
  area.className = 'desktop-area';
  area.innerHTML = `
    <div class="desktop-placeholder">
      <h2>Рабочий стол</h2>
      <p>здесь появятся проекты пользователя</p>
    </div>
  `;
  page.appendChild(area);

  app.appendChild(page);
}
