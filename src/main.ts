import './styles/base.css';
import { registerRoute, startRouter } from './router';
import { renderLoginPage } from './pages/login';
import { renderDesktopPage } from './pages/desktop';
import { getLastUserName } from './lib/storage';

const app = document.querySelector<HTMLElement>('#app');
if (!app) {
  throw new Error('Контейнер #app не найден');
}

registerRoute('login', renderLoginPage);
registerRoute('desktop', renderDesktopPage);

// Автологин последнего пользователя: если сессия есть — сразу рабочий стол
location.hash = getLastUserName() ? '#/desktop' : '#/login';
startRouter(app);
