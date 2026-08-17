# План улучшения SFTP Plugin

## Цель
Сделать плагин кроссплатформенным (Windows, macOS, Linux) и убрать обязательные внешние бинарники, кроме `tsh` для Teleport. Работаем над нашим кодом, не копируем reference.

## Текущие проблемы
- `src/sync.ts` спавнит `rsync`, `lftp`, `ssh` через `child_process`. На Windows этих утилит нет, на macOS/Linux их надо ставить отдельно.
- Синхронизация только целой папки, нет загрузки/скачивания отдельных файлов.
- Нет поддержки приватных ключей, passphrase, SSH agent, ignore-шаблонов, очереди передач.
- Webview не содержит полей для новых опций.
- Тесты завязаны на `child_process`.

## Этапы

### 1. Зависимости
Добавить в `package.json` `dependencies`:
- `ssh2` — SFTP/SSH
- `basic-ftp` — FTP (современная замена пакета `ftp`)
- `p-queue` — очередь параллельных трансферов
- `ignore` — фильтрация файлов
- `upath` — нормализация путей
- `@types/ssh2`, `@types/basic-ftp` — devDependencies

Убрать из README и сообщений об ошибках ссылки на `rsync`/`lftp`.

### 2. Новый transport layer (`src/sync.ts` / `src/remote/`)
Создать абстракцию `RemoteClient`:
- `list(dir): Promise<RemoteItem[]>`
- `put(localPath, remotePath): Promise<void>`
- `get(remotePath, localPath): Promise<void>`
- `mkdir(remotePath): Promise<void>`
- `delete(remotePath): Promise<void>`
- `test(): Promise<void>`
- `close(): Promise<void>`

Реализации:
- `SftpClient` — поверх `ssh2.SFTP`
- `FtpClient` — поверх `basic-ftp`
- `TeleportClient` — `tsh` только для логина и `tsh proxy ssh`, затем передача через `ssh2`

`SyncEngine`:
- Читает списки локальных и удалённых файлов.
- Сравнивает по размеру и времени.
- Строит план: upload, download, delete.
- Выполняет через `p-queue` с контролем concurrency.
- `dryRun` — печатает план без выполнения.

Удалить `child_process` из `src/sync.ts`.

### 3. Конфигурация (`src/config.ts` + webview)
Добавить поля:
- `privateKey`
- `passphrase`
- `agent`
- `ignore` (массив строк)
- `concurrency`
- `ftpPassive`
- `ftpSecure`

Удалить/пометить deprecated:
- `useRsync`
- `rsyncFlags`
- `sshFlags` (заменить на `ssh2` опции)

Обновить `src/webview/config.html` и `src/webview/config.js`:
- новые поля
- валидация

Обновить `package.json` `contributes.configuration`.

### 4. Утилиты (`src/utils.ts`)
- `normalizeRemotePath(path)` — `path.posix`, без лишних слэшей
- `isIgnored(path, patterns)` — `ignore`
- `resolvePrivateKey(keyPath)` — раскрытие `~` и `~/.ssh`
- `joinLocal(...)`, `joinRemote(...)`

### 5. Watcher (`src/watcher.ts`)
- Оставить `vscode.FileSystemWatcher`.
- Добавить `p-queue` на `doSync`, чтобы не запускать параллельные синхронизации.
- При изменении одного файла вызывать `uploadActiveFile` вместо полной папки (по желанию).

### 6. Extension (`src/extension.ts`)
Новые команды:
- `sftpPluggin.uploadActiveFile`
- `sftpPluggin.downloadActiveFile`
- `sftpPluggin.syncFile`
- `sftpPluggin.deleteRemote`
- расширенный `sftpPluggin.testConnection`

Контекстные меню:
- `explorer/context`: Upload, Download, Sync
- `editor/title`: Upload/Download

Зарегистрировать в `package.json`.

### 7. Статус и прогресс
- `src/status.ts`, `src/progress.ts`
- состояния: `connecting`, `uploading`, `error`
- прогресс per file от `SyncEngine`

### 8. Тесты
- Переписать `src/test/*.test.ts`:
  - мокаем `ssh2` и `basic-ftp`
  - проверяем `SyncEngine`, `SftpClient`, `FtpClient`
  - убираем `child_process` моки

### 9. Сборка и документация
- Проверить `tsconfig.json`.
- Убедиться, что `ssh2` не ломается при webpack-сборке (optional/native deps).
- Обновить `README.md`.
- Подготовить `vsce package`.

## Порядок выполнения
1. Зависимости + `src/sync.ts` transport layer.
2. `src/config.ts` + webview.
3. `src/utils.ts` + `src/watcher.ts`.
4. `src/extension.ts` + `package.json` commands.
5. Статус/прогресс.
6. Тесты.
7. Сборка + README.

## Критерий готовности
- `npm run compile` проходит без ошибок.
- SFTP работает без `rsync`/`ssh`/`lftp` на Windows, macOS, Linux.
- FTP работает без `lftp`.
- Teleport работает с установленным `tsh` и `ssh2`.
