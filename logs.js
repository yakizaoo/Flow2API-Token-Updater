// logs.js — просмотр журнала событий

let loading = false;

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

function formatTime(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
        return 'Время неизвестно';
    }
    const now = new Date();

    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
        return `Вчера ${date.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit'
        })}`;
    }

    return date.toLocaleString('ru-RU', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function renderEmptyState(container, icon, message) {
    container.replaceChildren();
    const wrapper = document.createElement('div');
    wrapper.className = 'empty-state';
    const iconElement = document.createElement('div');
    iconElement.className = 'empty-state-icon';
    iconElement.textContent = icon;
    const messageElement = document.createElement('div');
    messageElement.textContent = message;
    wrapper.append(iconElement, messageElement);
    container.appendChild(wrapper);
}

function renderLogs(logs) {
    const container = document.getElementById('logsContainer');
    container.replaceChildren();

    if (!Array.isArray(logs) || logs.length === 0) {
        renderEmptyState(container, '📝', 'Журнал пока пуст');
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const log of logs) {
        const level = ['INFO', 'SUCCESS', 'ERROR'].includes(log.level) ? log.level : 'INFO';
        const entry = document.createElement('div');
        entry.className = `log-entry ${level}`;

        const header = document.createElement('div');
        header.className = 'log-header';
        const levelElement = document.createElement('span');
        levelElement.className = `log-level ${level}`;
        levelElement.textContent = ({ INFO: 'ИНФО', SUCCESS: 'УСПЕХ', ERROR: 'ОШИБКА' })[level];
        const timeElement = document.createElement('span');
        timeElement.className = 'log-time';
        timeElement.textContent = formatTime(log.timestamp);
        header.append(levelElement, timeElement);

        const message = document.createElement('div');
        message.className = 'log-message';
        message.textContent = String(log.message || '');
        entry.append(header, message);

        if (log.details !== null && log.details !== undefined) {
            const details = document.createElement('div');
            details.className = 'log-details';
            details.textContent = JSON.stringify(log.details, null, 2);
            entry.appendChild(details);
        }
        fragment.appendChild(entry);
    }
    container.appendChild(fragment);
}

async function loadLogs() {
    if (loading || document.hidden) {
        return;
    }
    loading = true;
    try {
        const response = await sendMessage({ action: 'getLogs' });
        if (!response || !response.success) {
            throw new Error(response && response.error || 'Не удалось загрузить журнал');
        }
        renderLogs(response.logs);
    } catch (error) {
        renderEmptyState(document.getElementById('logsContainer'), '❌', error.message);
    } finally {
        loading = false;
    }
}

async function clearLogs() {
    if (!confirm('Удалить все записи журнала?')) {
        return;
    }
    try {
        const response = await sendMessage({ action: 'clearLogs' });
        if (!response || !response.success) {
            throw new Error(response && response.error || 'Не удалось очистить журнал');
        }
        await loadLogs();
    } catch (error) {
        renderEmptyState(document.getElementById('logsContainer'), '❌', error.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadLogs();
    document.getElementById('refreshBtn').addEventListener('click', loadLogs);
    document.getElementById('clearBtn').addEventListener('click', clearLogs);
    document.getElementById('backBtn').addEventListener('click', () => {
        window.location.href = 'popup.html';
    });
    setInterval(loadLogs, 5000);
});
