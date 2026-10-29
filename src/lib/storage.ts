/**
 * Хранилище прототипа: localStorage браузера.
 * ЗАМЕНИТЬ на API-вызовы к Pode-бэкенду (docs/decisions.md, D4/D7):
 *   loadUsers()  -> GET /api/users
 *   findUser()   -> GET /api/users?prefix=<ввод>
 *   upsertUserLogin() -> POST /api/login { name }
 * Контракт функций сохранён специально, чтобы замена прошла без правки страниц.
 */
import type { CabinetUser } from '../types';

const USERS_KEY = 'cabinet_users';
const LAST_USER_KEY = 'cabinet_lastUser';

function isCabinetUser(value: unknown): value is CabinetUser {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.lastLoginAt === 'string'
  );
}

export function loadUsers(): CabinetUser[] {
  try {
    const raw = localStorage.getItem(USERS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isCabinetUser) : [];
  } catch {
    return [];
  }
}

export function saveUsers(users: CabinetUser[]): void {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

export function findUser(name: string): CabinetUser | undefined {
  const needle = name.toLowerCase();
  return loadUsers().find((user) => user.name.toLowerCase() === needle);
}

/** Регистрирует вход: существующий пользователь обновляется, новый — создаётся. */
export function upsertUserLogin(name: string): { isNew: boolean } {
  const users = loadUsers();
  const now = new Date().toISOString();
  const existing = users.find((user) => user.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.lastLoginAt = now;
    saveUsers(users);
    return { isNew: false };
  }
  users.push({ name, createdAt: now, lastLoginAt: now });
  saveUsers(users);
  return { isNew: true };
}

export function getLastUserName(): string | null {
  return localStorage.getItem(LAST_USER_KEY);
}

export function setLastUserName(name: string): void {
  localStorage.setItem(LAST_USER_KEY, name);
}

export function clearLastUser(): void {
  localStorage.removeItem(LAST_USER_KEY);
}
