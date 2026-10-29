/**
 * Минимальный hash-роутер без зависимостей.
 * Маршрут — имя после '#/' (например '#/desktop'). Страницы регистрируются
 * в main.ts. Новая страница = новый модуль в src/pages + registerRoute.
 */

export type PageRenderer = (app: HTMLElement) => void;

const routes = new Map<string, PageRenderer>();

function currentRouteName(): string {
  return location.hash.replace(/^#\/?/, '') || 'login';
}

export function registerRoute(name: string, renderer: PageRenderer): void {
  routes.set(name, renderer);
}

export function navigate(name: string): void {
  location.hash = `#/${name}`;
}

export function startRouter(app: HTMLElement): void {
  const render = (): void => {
    const renderer = routes.get(currentRouteName()) ?? routes.get('login');
    if (!renderer) return;
    app.replaceChildren();
    renderer(app);
  };
  window.addEventListener('hashchange', render);
  render();
}
