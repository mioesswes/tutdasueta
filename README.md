# 🎮 Stream Alert System

Система уведомлений для стримов через OBS Browser Source.

## ⚡ Быстрый старт

### 1. Установка зависимостей
```bash
npm install
```

### 2. Запуск сервера
```bash
npm start
```

Сервер поднимется на `http://localhost:3000`

---

## 🔧 Настройка OBS

1. В OBS: Источники → "+" → **Browser Source**
2. URL: `http://ВАШ_IP:3000/widget/streamer1`
3. Ширина: `600`, Высота: `200`
4. ✅ Галочка "Control audio via OBS"
5. ✅ Галочка "Shutdown source when not visible"

> Каждый стример = свой URL:
> - `http://IP:3000/widget/streamer1`
> - `http://IP:3000/widget/streamer2`
> и т.д.

---

## 🛡️ Панель администратора

Открой в браузере: `http://ВАШ_IP:3000/`

Пароль: **5493**

### Что можно делать:
- Выбирать стримера из списка
- Редактировать имя и slug стримера
- Загружать аудио (mp3/wav/ogg)
- Настраивать стили текста (цвет, размер, тень, обводка)
- Отправлять уведомления прямо на стрим
- Видеть превью уведомления в реальном времени

---

## 📁 Структура проекта

```
stream-alerts/
├── server.js          # Основной сервер
├── package.json       # Зависимости
├── data.json          # Данные стримеров (создаётся автоматически)
├── public/
│   ├── admin/         # Панель администратора
│   │   └── index.html
│   ├── widget/        # OBS виджет
│   │   └── index.html
│   └── uploads/       # Загруженные аудио файлы
```

---

## 🖥️ Запуск на дедике (systemd)

Создай файл `/etc/systemd/system/stream-alerts.service`:

```ini
[Unit]
Description=Stream Alert Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/stream-alerts
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

Затем:
```bash
systemctl daemon-reload
systemctl enable stream-alerts
systemctl start stream-alerts
systemctl status stream-alerts
```

---

## 🌐 Nginx (если нужен домен)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## 🔒 Безопасность

- Пароль хранится только на сервере в `server.js` (строка `ADMIN_CODE`)
- Сессионные токены в памяти, истекают через 8 часов
- Токен передаётся через заголовок `x-admin-token`
- Чтобы сменить пароль — измени `ADMIN_CODE` в `server.js` и перезапусти

---

## ⚙️ Настройки (переменные окружения)

| Переменная | Значение по умолчанию | Описание |
|------------|----------------------|----------|
| `PORT`     | `3000`               | Порт сервера |

```bash
PORT=8080 npm start
```
