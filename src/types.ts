/**
 * Общие типы кабинета.
 * Контракты повторяют схему данных из docs/decisions.md (D7) — при изменении
 * схемы синхронизировать оба места.
 */

/** Пользователь кабинета (реестр пользователей). */
export interface CabinetUser {
  name: string;
  /** ISO-строка даты создания профиля */
  createdAt: string;
  /** ISO-строка последнего входа */
  lastLoginAt: string;
}

/** Имена маршрутов приложения (hash-роутер). */
export type RouteName = 'login' | 'desktop';
