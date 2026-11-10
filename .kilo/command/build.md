---
description: Сборка и проверки проекта 1c-deploy-cabinet (фронтенд + Electron exe)
---

Выполни сборку и проверки проекта `C:\1C_Bases\AI\cabinet` по шагам. Ничего не скачивать сверх указанного, не коммитить и не пушить.

## 1. Фронтенд + Electron exe

- В PATH сессии добавить портативный Node (системный PATH не менять):
  `C:\Users\Н_Вадим\Desktop\НаумовЗадания\полезные обработки\ai\nodejs`
- Перед запуском electron убрать переменную окружения `ELECTRON_RUN_AS_NODE`
  (терминалы VS Code ее прокидывают — из-за нее Electron стартует как голый Node).
- В workdir корня проекта выполнить `npm.cmd run app:build` (именно `npm.cmd`):
  это `tsc --noEmit` (strict) + `vite build` + `electron-builder --win`.
- Требование: ноль ошибок TS, сборка заканчивается созданием
  `build/exe/1C Cabinet <версия>.exe` и `build/exe/win-unpacked/1C Cabinet.exe`.
  Если tsc выдал ошибки — исправить и повторить. Если electron-builder упал с
  EBUSY/EPERM на файлах в папке вывода — повторить (антивирус/VS Code держат
  хэндлы; вывод уже в `build/exe`, отличной от `release/` — там застрявшие хэндлы
  от старых сборок, папку не трогать).

## 2. Отчет

Кратко: статус tsc/vite (ОК/ошибки), версия Electron из `node_modules/electron/package.json`,
путь и размер собранного exe, что было исправлено. Ничего не коммитить и не пушить.
