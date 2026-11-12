/**
 * Черновик выбора источника информационной базы: заполняется на вкладке
 * «Добавить новый проект» (компонент src/components/ibSourcePicker.ts),
 * читается мастером развертки (src/pages/newProject.ts).
 * Модуль-синглтон: hash-роутер не перезагружает страницу, состояние живет
 * между переходами. ready=true — источник выбран полностью, мастер открыт.
 */

export type DeployIbSource = 'dt' | 'template';

export interface DeployDraft {
  ready: boolean;
  ibSource: DeployIbSource;
  dtPath: string;
  /** Каталог версии выбранного шаблона (…\Разработчик\Имя\Версия). */
  templatePath: string;
  /** Источник в шаблоне: имя .dt или «1Cv8.cf» (конфигурация без данных). */
  templateSourceFile: string;
}

export const deployDraft: DeployDraft = {
  ready: false,
  ibSource: 'dt',
  dtPath: '',
  templatePath: '',
  templateSourceFile: '',
};
