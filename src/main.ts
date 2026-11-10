import './styles/base.css';
import './styles/toast.css';
import { registerRoute, startRouter } from './router';
import { renderLoginPage } from './pages/login';
import { renderDesktopPage } from './pages/desktop';
import { renderSettingsPage } from './pages/settings';
import { renderNewProjectPage } from './pages/newProject';
import { getLastUserName } from './lib/storage';

const app = document.querySelector<HTMLElement>('#app');
if (!app) {
  throw new Error('Контейнер #app не найден');
}

registerRoute('login', renderLoginPage);
registerRoute('desktop', renderDesktopPage);
registerRoute('settings', renderSettingsPage);
registerRoute('new-project', renderNewProjectPage);

// Автологин последнего пользователя: если сессия есть — сразу рабочий стол
location.hash = getLastUserName() ? '#/desktop' : '#/login';
startRouter(app);
