import '../styles/page.css';
import '../styles/desktop.css';
import '../styles/sidebar.css';
import '../styles/wizard.css';
import '../styles/projects.css';
import designerIconUrl from '../assets/designer.png';
import enterpriseIconUrl from '../assets/enterprise.png';
import { createTopBar } from '../components/topbar';
import { renderIbSourcePicker } from '../components/ibSourcePicker';
import { clearLastUser, getLastUserName } from '../lib/storage';
import { apiGet, apiPost, type ProjectInfo, type ProjectRecord } from '../api/client';
import { navigate } from '../router';
import { showToast } from '../components/toast';

const TRASH_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>';

/** Значок VS Code для кнопки открытия проекта (упрощенная эмблема редактора). */
const VSCODE_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .325 8.74L3.899 12 .325 15.26a1 1 0 0 0 .002 1.479L1.65 17.94c.34.29.84.33 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zM17.998 17.448 10.826 12l7.178-5.448v10.896z"/></svg>';

type TabId = 'projects' | 'new' | 'glasha' | 'rework';

interface SideTab {
  id: TabId;
  title: string;
  badge?: string;
  disabled?: boolean;
  note?: string;
}

const SIDEBAR_TABS: SideTab[] = [
  { id: 'projects', title: 'Мои проекты' },
  { id: 'new', title: 'Добавить новый проект', badge: '+' },
  { id: 'glasha', title: 'Глаша' },
  { id: 'rework', title: 'База доработок', disabled: true, note: '*в разработке' },
];

/** Адрес сервиса «Глаша» (внешний по отношению к кабинету). */
const GLASHA_URL = 'http://glasha.fortlab.local/';

/** Рабочий стол: верхняя панель, левая панель вкладок, центральная область. */
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
      onSettings: () => navigate('settings'),
    }),
  );

  const body = document.createElement('div');
  body.className = 'desktop-body';

  const sidebar = document.createElement('nav');
  sidebar.className = 'sidebar';
  sidebar.dataset.ref = 'sidebar';

  const content = document.createElement('main');
  content.className = 'desktop-content';
  content.dataset.ref = 'tab-content';

  body.appendChild(sidebar);
  body.appendChild(content);
  page.appendChild(body);
  app.appendChild(page);

  function renderTabContent(tabId: TabId): void {
    content.replaceChildren();
    const box = document.createElement('div');
    box.className = 'content-placeholder';

    const title = document.createElement('h2');
    const text = document.createElement('p');
    box.appendChild(title);
    box.appendChild(text);

    switch (tabId) {
      case 'projects': {
        // NB: box еще не в DOM — replaceWith здесь молча не сработал бы
        content.appendChild(renderProjectsTab());
        return;
      }
      case 'new': {
        // Выбор источника ИБ прямо в центральной области; мастер открывается
        // по «Следующий шаг» (см. src/components/ibSourcePicker.ts)
        const panel = document.createElement('div');
        panel.className = 'new-source-panel';
        const head = document.createElement('h2');
        head.textContent = 'Добавить новый проект';
        const sub = document.createElement('p');
        sub.textContent = 'Шаг 1. Выберите источник информационной базы.';
        panel.appendChild(head);
        panel.appendChild(sub);
        renderIbSourcePicker(panel, () => navigate('new-project'));
        content.appendChild(panel);
        return;
      }
      case 'glasha': {
        title.textContent = 'Глаша';
        text.textContent = 'Ассистент кабинета.';
        const go = document.createElement('button');
        go.className = 'accent-btn';
        go.type = 'button';
        go.textContent = 'Перейти в Глашу';
        go.addEventListener('click', () => {
          window.location.href = GLASHA_URL;
        });
        box.appendChild(go);
        break;
      }
      case 'rework':
        // Вкладка неактивна — сюда попасть нельзя
        break;
    }

    content.appendChild(box);
  }

  /** Вкладка «Мои проекты»: карточки из реестра (registry.json) + удаление. */
  function renderProjectsTab(): HTMLElement {
    const tab = document.createElement('div');
    tab.className = 'projects-tab';

    const list = document.createElement('div');
    list.className = 'projects-list';
    const msg = document.createElement('div');
    msg.className = 'projects-msg';
    msg.textContent = 'Загрузка проектов…';
    tab.appendChild(list);
    tab.appendChild(msg);

    function load(): void {
      void apiGet<{ projects?: ProjectRecord[] }>('/api/projects')
        .then((r) => {
          list.replaceChildren();
          const projects = r.projects ?? [];
          msg.textContent = projects.length
            ? ''
            : 'Развернутых проектов пока нет. Создайте первый через «Добавить новый проект».';
          for (const p of projects) list.appendChild(projectCard(p));
        })
        .catch(() => {
          msg.textContent = 'Не удалось загрузить список проектов.';
          showToast('Не удалось загрузить список проектов', 'warn');
        });
    }

    /** Строка описания «название: значение» в карточке. */
    function infoRow(label: string, value: string): HTMLElement {
      const row = document.createElement('div');
      row.className = 'project-info-row';
      const l = document.createElement('span');
      l.className = 'project-info-label';
      l.textContent = `${label}: `;
      const v = document.createElement('span');
      v.className = 'project-info-value';
      v.textContent = value;
      row.appendChild(l);
      row.appendChild(v);
      return row;
    }

    /** Детальный блок карточки из info (src/cf/Configuration.xml + src/cfe + .dev.env). */
    function projectInfoBlock(info: ProjectInfo, projectDir: string, publishUrl: string, infoUpdatedAt: string): HTMLElement {
      const box = document.createElement('div');
      box.className = 'project-info';
      // Конфигурация крупно под наименованием проекта, релиз — отдельной строкой
      const config = document.createElement('div');
      config.className = 'project-config';
      config.textContent = info.configSynonym || info.configName || 'Конфигурация не определена';
      box.appendChild(config);
      if (info.configVersion) {
        const release = document.createElement('div');
        release.className = 'project-release';
        release.textContent = `Релиз ${info.configVersion}`;
        box.appendChild(release);
      }
      box.appendChild(infoRow('База', info.ibKind === 'server' ? 'Серверная' : 'Файловая'));
      if (info.platformVersion) box.appendChild(infoRow('Платформа', info.platformVersion));
      // Пути проекта и публикация — под строкой «База»
      const pathEl = document.createElement('div');
      pathEl.className = 'project-path';
      pathEl.textContent = projectDir;
      box.appendChild(pathEl);
      if (publishUrl) {
        box.appendChild(publishRow(publishUrl));
      }
      // Расширения: без указания типа; патчи — одной строкой
      if (info.extensions.length > 0) {
        const label = document.createElement('div');
        label.className = 'project-extensions-label';
        label.textContent = 'Расширения:';
        box.appendChild(label);
        for (const e of info.extensions) {
          const row = document.createElement('div');
          row.className = 'project-ext-row';
          const ver = e.version ? ` (${e.version})` : '';
          row.textContent = `${e.synonym || e.name}${ver}`;
          box.appendChild(row);
        }
      }
      if (info.patches.length > 0) {
        box.appendChild(infoRow('Патчи', info.patches.join(', ')));
      }
      if (infoUpdatedAt) {
        const upd = document.createElement('div');
        upd.className = 'project-updated';
        const d = new Date(infoUpdatedAt);
        upd.textContent = `Обновлено: ${isNaN(d.getTime()) ? infoUpdatedAt : d.toLocaleString('ru-RU')}`;
        box.appendChild(upd);
      }
      return box;
    }

    /** Строка публикации с точкой статуса (заполняется проверкой доступности). */
    function publishRow(publishUrl: string): HTMLElement {
      const pub = document.createElement('div');
      pub.className = 'project-pub';
      pub.textContent = `Публикация: ${publishUrl}`;
      const dot = document.createElement('span');
      dot.className = 'pub-dot pub-dot-check';
      dot.dataset.ref = 'pub-dot';
      dot.title = 'Проверка доступности публикации';
      const st = document.createElement('span');
      st.className = 'pub-status-text';
      st.dataset.ref = 'pub-status';
      st.textContent = 'проверяется…';
      pub.appendChild(dot);
      pub.appendChild(st);
      return pub;
    }

    /** Проверка публикации: один локальный HTTP-запрос к publishUrl. */
    function checkPublish(publishUrl: string, dot: HTMLElement, label: HTMLElement): void {
      void apiPost<{ online: boolean }>('/api/projects/check-publish', { publishUrl }, 8000)
        .then((r) => {
          dot.classList.remove('pub-dot-check');
          if (r.online) {
            dot.classList.add('pub-dot-ok');
            label.textContent = 'доступна';
          } else {
            dot.classList.add('pub-dot-fail');
            label.textContent = 'недоступна';
          }
        })
        .catch(() => {
          dot.classList.remove('pub-dot-check');
          dot.classList.add('pub-dot-fail');
          label.textContent = 'недоступна';
        });
    }

    function projectCard(p: ProjectRecord): HTMLElement {
      const card = document.createElement('div');
      card.className = 'project-card';
      const main = document.createElement('div');
      main.className = 'project-card-main';
      const name = document.createElement('div');
      name.className = 'project-name';
      name.textContent = p.name || p.projectDir;
      main.appendChild(name);
      const publishUrl = p.info?.publishUrl || p.publishUrl || '';
      if (p.info) {
        main.appendChild(projectInfoBlock(p.info, p.projectDir, publishUrl, p.infoUpdatedAt ?? ''));
      } else {
        const pathEl = document.createElement('div');
        pathEl.className = 'project-path';
        pathEl.textContent = p.projectDir;
        main.appendChild(pathEl);
        if (publishUrl) main.appendChild(publishRow(publishUrl));
        const empty = document.createElement('div');
        empty.className = 'project-info-empty';
        empty.textContent = 'Данные по проекту не заполнены — нажмите «Обновить информацию».';
        main.appendChild(empty);
      }
      // Проверка доступности публикации (один локальный HTTP-запрос)
      const pubDot = main.querySelector<HTMLElement>('[data-ref="pub-dot"]');
      const pubStatus = main.querySelector<HTMLElement>('[data-ref="pub-status"]');
      if (publishUrl && pubDot && pubStatus) checkPublish(publishUrl, pubDot, pubStatus);

      // Действия: обновить информацию, открыть VS Code / Конфигуратор / Предприятие, удалить
      const actions = document.createElement('div');
      actions.className = 'project-actions';

      const refresh = document.createElement('button');
      refresh.className = 'project-btn project-btn-accent';
      refresh.type = 'button';
      refresh.textContent = 'Обновить информацию';
      refresh.addEventListener('click', () => {
        refresh.disabled = true;
        refresh.textContent = 'Обновление…';
        void apiPost<{ ok: boolean }>('/api/projects/info', { projectDir: p.projectDir }, 60000)
          .then(() => {
            showToast('Данные по проекту обновлены');
            load();
          })
          .catch((err) => {
            // Транзакционность: старые данные остаются — карточку не перерисовываем
            const msg = (err as { data?: { error?: string } })?.data?.error ?? 'Не удалось обновить данные по проекту';
            showToast(msg, 'warn');
            refresh.disabled = false;
            refresh.textContent = 'Обновить информацию';
          });
      });
      actions.appendChild(refresh);

      const openActions: Array<{ target: string; label: string; svg?: string; img?: string }> = [
        { target: 'vscode', label: 'Открыть в VS Code', svg: VSCODE_SVG },
        { target: 'designer', label: 'Открыть конфигуратор', img: designerIconUrl },
        { target: 'enterprise', label: 'Открыть Предприятие', img: enterpriseIconUrl },
      ];
      for (const a of openActions) {
        const btn = document.createElement('button');
        btn.className = 'project-btn';
        btn.type = 'button';
        if (a.svg) {
          const ico = document.createElement('span');
          ico.className = 'project-btn-ico';
          ico.innerHTML = a.svg;
          btn.appendChild(ico);
        }
        if (a.img) {
          const ico = document.createElement('img');
          ico.className = 'project-btn-ico';
          ico.src = a.img;
          ico.alt = '';
          btn.appendChild(ico);
        }
        btn.appendChild(document.createTextNode(a.label));
        btn.addEventListener('click', () => {
          btn.disabled = true;
          void apiPost<{ ok: boolean; arch?: string }>('/api/projects/open', { projectDir: p.projectDir, target: a.target }, 30000)
            .then((r) => {
              const arch = r.arch ? ` (${r.arch})` : '';
              showToast(`${a.label}: запущено${arch}`);
            })
            .catch((err) => {
              const msg = (err as { data?: { error?: string } })?.data?.error ?? 'Не удалось открыть';
              showToast(msg, 'warn');
            })
            .finally(() => { try { btn.disabled = false; } catch { /* карточка перерисована */ } });
        });
        actions.appendChild(btn);
      }

      const del = document.createElement('button');
      del.className = 'project-delete';
      del.type = 'button';
      del.title = 'Удалить проект';
      del.setAttribute('aria-label', `Удалить проект: ${p.name || p.projectDir}`);
      del.innerHTML = TRASH_SVG;
      del.addEventListener('click', () => {
        confirmDelete(p, () => {
          showToast('Проект удален');
          load();
        });
      });
      actions.appendChild(del);

      card.appendChild(main);
      card.appendChild(actions);
      return card;
    }

    function confirmDelete(p: ProjectRecord, onDone: () => void): void {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const card = document.createElement('div');
      card.className = 'modal-card';
      const h = document.createElement('h3');
      h.textContent = 'Точно ли вы хотите удалить проект?';
      const text = document.createElement('p');
      text.textContent = `Проект «${p.name || p.projectDir}» (${p.projectDir})`;
      const label = document.createElement('label');
      label.className = 'wcheck';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      const cbText = document.createElement('span');
      cbText.textContent = `Удалить все файлы проекта с диска по пути ${p.projectDir}`;
      label.appendChild(cb);
      label.appendChild(cbText);
      const buttons = document.createElement('div');
      buttons.className = 'modal-buttons';
      const cancel = document.createElement('button');
      cancel.className = 'wbtn';
      cancel.type = 'button';
      cancel.textContent = 'Отмена';
      const confirm = document.createElement('button');
      confirm.className = 'wbtn wbtn-danger';
      confirm.type = 'button';
      confirm.textContent = 'Уверен, удалить';
      buttons.appendChild(cancel);
      buttons.appendChild(confirm);
      card.appendChild(h);
      card.appendChild(text);
      card.appendChild(label);
      card.appendChild(buttons);
      overlay.appendChild(card);
      page.appendChild(overlay);

      const close = (): void => overlay.remove();
      cancel.addEventListener('click', close);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });
      confirm.addEventListener('click', () => {
        // Окно ожидания: спиннер вместо содержимого модала
        card.replaceChildren();
        const wrap = document.createElement('div');
        wrap.className = 'modal-spinner-wrap';
        const sp = document.createElement('div');
        sp.className = 'modal-spinner';
        const tx = document.createElement('div');
        tx.className = 'modal-spinner-text';
        tx.textContent = 'Удаление проекта…';
        wrap.appendChild(sp);
        wrap.appendChild(tx);
        card.appendChild(wrap);
        void apiPost<{ ok: boolean; filesDeleted: boolean }>(
          '/api/projects/delete',
          { projectDir: p.projectDir, deleteFiles: cb.checked },
          120000,
        )
          .then(() => {
            showToast(cb.checked ? 'Проект удален вместе с файлами' : 'Проект удален из списка');
            overlay.remove();
            onDone();
          })
          .catch((err) => {
            const msg = (err as { data?: { error?: string } })?.data?.error ?? 'Не удалось удалить проект';
            showToast(msg, 'warn');
            overlay.remove();
          });
      });
    }

    load();
    return tab;
  }

  function setActive(tabId: TabId): void {
    for (const tab of SIDEBAR_TABS) {
      sidebar
        .querySelector<HTMLElement>(`[data-ref="tab-${tab.id}"]`)!
        .classList.toggle('active', tab.id === tabId);
    }
    renderTabContent(tabId);
  }

  for (const tab of SIDEBAR_TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'side-tab';
    btn.dataset.ref = `tab-${tab.id}`;
    if (tab.disabled) {
      btn.disabled = true;
      btn.classList.add('disabled');
    }

    if (tab.badge) {
      const badge = document.createElement('span');
      badge.className = 'side-tab-badge';
      badge.textContent = tab.badge;
      btn.appendChild(badge);
    }

    const textWrap = document.createElement('span');
    textWrap.className = 'side-tab-text';
    const title = document.createElement('span');
    title.className = 'side-tab-title';
    title.textContent = tab.title;
    textWrap.appendChild(title);
    if (tab.note) {
      const note = document.createElement('span');
      note.className = 'side-tab-note';
      note.textContent = tab.note;
      textWrap.appendChild(note);
    }
    btn.appendChild(textWrap);

    if (!tab.disabled) {
      btn.addEventListener('click', () => setActive(tab.id));
    }
    sidebar.appendChild(btn);
  }

  setActive('projects');

  // Статус бэкенда показываем сразу при входе: без него недоступны
  // автопоиск/проводник в настройках и мастер развертки
  void apiGet('/api/settings', 4000).catch(() => {
    showToast('Бэкенд не запущен — мастер развертки и проверка путей недоступны', 'warn');
  });
}
