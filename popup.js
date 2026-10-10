// popup.js — интерфейс настроек расширения Chrome

let statusTimer = null;
let approvedInsecureOrigin = '';

function sendMessage(request) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(request, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response);
        });
    });
}

function normalizeApiUrl(value) {
    let url;
    try {
        url = new URL(String(value || '').trim());
    } catch (error) {
        throw new Error('Неверный формат адреса подключения');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Адрес подключения должен начинаться с HTTP или HTTPS');
    }
    if (url.username || url.password) {
        throw new Error('Адрес подключения не должен содержать логин или пароль');
    }
    url.hash = '';
    url.search = '';
    if (!url.pathname || url.pathname === '/') {
        url.pathname = '/api/plugin/update-token';
    }
    return url.toString();
}

function insecureRemoteOrigin(value) {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '[::1]';
    return url.protocol === 'http:' && !loopback ? url.origin : '';
}

function getFormConfig() {
    const apiUrl = normalizeApiUrl(document.getElementById('apiUrl').value);
    const connectionToken = document.getElementById('connectionToken').value.trim();
    const loginAccount = document.getElementById('loginAccount').value.trim().toLowerCase();
    const refreshInterval = Number.parseInt(
        document.getElementById('refreshInterval').value,
        10
    );

    if (!connectionToken) {
        throw new Error('Введите токен подключения');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginAccount)) {
        throw new Error('Укажите действительный адрес электронной почты аккаунта Google');
    }
    if (!Number.isInteger(refreshInterval) || refreshInterval < 1 || refreshInterval > 1440) {
        throw new Error('Интервал должен быть от 1 до 1440 минут');
    }

    return { apiUrl, connectionToken, loginAccount, refreshInterval };
}

function setBusy(busy) {
    document.getElementById('saveBtn').disabled = busy;
    document.getElementById('testBtn').disabled = busy;
}

function renderLastSync(lastSync) {
    const state = document.getElementById('lastSync');
    if (!lastSync || !lastSync.timestamp) {
        state.textContent = 'Синхронизация ещё не выполнялась';
        state.className = 'sync-state';
        return;
    }
    const date = new Date(lastSync.timestamp);
    const time = Number.isNaN(date.getTime()) ? 'Время неизвестно' : date.toLocaleString('ru-RU');
    state.textContent = `${lastSync.success ? 'Последняя синхронизация успешна' : 'Последняя синхронизация не удалась'} · ${time}\n${lastSync.message || ''}`.trim();
    state.className = `sync-state ${lastSync.success ? 'success' : 'error'}`;
}

async function requestApiPermission(apiUrl) {
    const url = new URL(apiUrl);
    const originPattern = `${url.protocol}//${url.hostname}/*`;
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) {
        throw new Error('Разрешите расширению доступ к адресу сервера Flow2API');
    }
}

async function saveCurrentConfig() {
    const config = getFormConfig();
    const insecureOrigin = insecureRemoteOrigin(config.apiUrl);
    if (insecureOrigin && approvedInsecureOrigin !== insecureOrigin) {
        const approved = confirm(
            'Вы используете удалённый сервер по HTTP. Cookie Google и токен подключения передаются без шифрования. Рекомендуется настроить HTTPS.\n\nВсё равно продолжить?'
        );
        if (!approved) {
            throw new Error('Сохранение отменено. Укажите адрес HTTPS');
        }
    }
    approvedInsecureOrigin = insecureOrigin;
    config.insecureHttpOrigin = insecureOrigin;
    await requestApiPermission(config.apiUrl);
    const response = await sendMessage({ action: 'saveConfig', config });
    if (!response || !response.success) {
        throw new Error(response && response.error || 'Не удалось сохранить настройки');
    }
    document.getElementById('apiUrl').value = response.config.apiUrl;
    document.getElementById('loginAccount').value = response.config.loginAccount;
    return response.config;
}

async function loadConfig() {
    const response = await sendMessage({ action: 'getConfig' });
    if (!response || !response.success) {
        throw new Error(response && response.error || 'Не удалось загрузить настройки');
    }
    const config = response.config || {};
    document.getElementById('apiUrl').value = config.apiUrl || '';
    document.getElementById('connectionToken').value = config.connectionToken || '';
    document.getElementById('loginAccount').value = config.loginAccount || '';
    document.getElementById('refreshInterval').value = config.refreshInterval || 60;
    approvedInsecureOrigin = response.config.insecureHttpOrigin || '';
    renderLastSync(response.lastSync);
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadConfig();
    } catch (error) {
        showStatus(`Не удалось загрузить настройки：${error.message}`, 'error', false);
    }

    document.getElementById('saveBtn').addEventListener('click', async () => {
        setBusy(true);
        showStatus('Сохраняем настройки...', 'info', false);
        try {
            await saveCurrentConfig();
            showStatus('Настройки сохранены', 'success');
        } catch (error) {
            showStatus(error.message, 'error', false);
        } finally {
            setBusy(false);
        }
    });

    document.getElementById('testBtn').addEventListener('click', async () => {
        setBusy(true);
        showStatus('Сохраняем настройки и отправляем Cookie...', 'info', false);
        try {
            await saveCurrentConfig();
            const response = await sendMessage({ action: 'testNow' });
            if (!response || !response.success) {
                throw new Error(response && response.error || 'Синхронизация не удалась');
            }
            const actionText = response.action === 'added' ? 'Аккаунт добавлен' : 'Аккаунт обновлён';
            showStatus(`Синхронизация успешна：${actionText}\n${response.message || ''}`.trim(), 'success', false);
            renderLastSync({
                timestamp: new Date().toISOString(),
                success: true,
                message: response.message || actionText
            });
        } catch (error) {
            showStatus(`Ошибка синхронизации：${error.message}`, 'error', false);
            renderLastSync({
                timestamp: new Date().toISOString(),
                success: false,
                message: error.message
            });
        } finally {
            setBusy(false);
        }
    });

    document.getElementById('logsBtn').addEventListener('click', () => {
        window.location.href = 'logs.html';
    });
});

function showStatus(message, type, autoHide = true) {
    const statusEl = document.getElementById('status');
    if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
    }
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    statusEl.style.display = 'block';

    if (autoHide) {
        statusTimer = setTimeout(() => {
            statusEl.style.display = 'none';
            statusTimer = null;
        }, 5000);
    }
}
