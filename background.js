// background.js — фоновый скрипт расширения Chrome

// Имя периодического задания
const ALARM_NAME = 'tokenRefresh';
const DEFAULT_REFRESH_INTERVAL = 60;
const MIN_REFRESH_INTERVAL = 1;
const MAX_REFRESH_INTERVAL = 1440;
const REQUEST_TIMEOUT_MS = 30000;
const RETRY_DELAYS_MS = [1500, 4000];

const FLOW_URL = 'https://flow.google.com/projects';
let activeSyncPromise = null;
// Lives only while an extension-owned Flow tab is loading; never persisted or logged.
let activeRequestCookieCapture = null;

// Read the exact Cookie request header, just like DevTools > Network > Request Headers.
// onSendHeaders exposes the final headers; extraHeaders is required for Cookie in Chrome.
// Only the main document request from OUR temporary tab to flow.google.com is observed.
chrome.webRequest.onSendHeaders.addListener((details) => {
    if (!activeRequestCookieCapture || details.tabId !== activeRequestCookieCapture.tabId) {
        return;
    }
    const cookieHeader = (details.requestHeaders || []).find(
        header => String(header.name || '').toLowerCase() === 'cookie'
    );
    if (cookieHeader && typeof cookieHeader.value === 'string' && cookieHeader.value.trim()) {
        activeRequestCookieCapture.header = cookieHeader.value;
    }
}, {
    urls: ['https://flow.google.com/*'],
    types: ['main_frame']
}, ['requestHeaders', 'extraHeaders']);
let logWriteQueue = Promise.resolve();

// Журнал событий
const Logger = {
    log(level, message, details = null) {
        const timestamp = new Date().toISOString();
        const safeDetails = sanitizeLogDetails(details);
        const logEntry = {
            timestamp,
            level,
            message,
            details: safeDetails
        };

        console.log(`[${level}] ${message}`, safeDetails || '');

        logWriteQueue = logWriteQueue.then(async () => {
            const { logs = [] } = await chrome.storage.local.get(['logs']);
            const updatedLogs = [logEntry, ...logs].slice(0, 50);
            await chrome.storage.local.set({ logs: updatedLogs });
        }).catch((error) => {
            console.error('Failed to persist extension log', error);
        });
        return logWriteQueue;
    },

    info(message, details) {
        return this.log('INFO', message, details);
    },

    error(message, details) {
        return this.log('ERROR', message, details);
    },

    success(message, details) {
        return this.log('SUCCESS', message, details);
    },

    async getLogs() {
        await logWriteQueue;
        const { logs = [] } = await chrome.storage.local.get(['logs']);
        return logs;
    },

    async clearLogs() {
        await logWriteQueue;
        await chrome.storage.local.set({ logs: [] });
    }
};

function sanitizeLogDetails(value, key = '') {
    if (value === null || value === undefined) {
        return value;
    }
    if (/^(authorization|connectionToken|google_cookies|session_token|password|secret)$/i.test(key)) {
        return '[REDACTED]';
    }
    if (Array.isArray(value)) {
        return value.map(item => sanitizeLogDetails(item));
    }
    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([entryKey, entryValue]) => [
                entryKey,
                sanitizeLogDetails(entryValue, entryKey)
            ])
        );
    }
    if (typeof value === 'string') {
        return value
            .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
            .replace(
                /("(?:google_cookies|session_token|connectionToken|password|secret)"\s*:\s*")[^"]*/gi,
                '$1[REDACTED]'
            )
            .replace(
                /((?:^|[;\s])(?:__Secure-)?(?:OSID|SID|HSID|SSID|APISID|SAPISID)=)[^;\s]+/gi,
                '$1[REDACTED]'
            );
    }
    return value;
}

async function initializeExtension() {
    await migrateLegacyConfig();
    await setupAlarm();
    await restoreSyncBadge();
}

chrome.runtime.onInstalled.addListener(() => {
    initializeExtension().then(() => {
        return Logger.info('Расширение инициализировано');
    }).catch((error) => {
        Logger.error('Не удалось инициализировать расширение', { error: error.message });
    });
});

chrome.runtime.onStartup.addListener(() => {
    initializeExtension().catch((error) => {
        Logger.error('Ошибка запуска расширения', { error: error.message });
    });
});

// Сообщения от окна настроек
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getConfig') {
        Promise.all([
            getConfig(),
            chrome.storage.local.get(['lastSync'])
        ]).then(([config, state]) => {
            sendResponse({ success: true, config, lastSync: state.lastSync || null });
        }).catch((error) => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    } else if (request.action === 'saveConfig') {
        saveConfig(request.config).then(async (config) => {
            await setupAlarm();
            await Logger.info('Настройки сохранены, расписание обновлено', {
                apiUrl: config.apiUrl,
                loginAccount: config.loginAccount,
                refreshInterval: config.refreshInterval
            });
            sendResponse({ success: true, config });
        }).catch((error) => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    } else if (request.action === 'testNow') {
        runTokenSync().then((result) => {
            sendResponse(result);
        }).catch((error) => {
            sendResponse({ success: false, error: error.message });
        });
        return true; // Оставляем канал сообщений открытым
    } else if (request.action === 'getLogs') {
        Logger.getLogs().then((logs) => {
            sendResponse({ success: true, logs });
        }).catch((error) => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    } else if (request.action === 'clearLogs') {
        Logger.clearLogs().then(() => {
            sendResponse({ success: true });
        }).catch((error) => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }
});

// Запуск по расписанию
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
        await Logger.info('Запущена синхронизация по расписанию');
        const result = await runTokenSync();

        // Уведомления браузера
        if (result.success) {
            const title = result.action === 'updated' ? '✅ Токен обновлён' : '✅ Токен добавлен';
            const message = result.displayMessage || result.message || 'Токен успешно синхронизирован с Flow2API';

            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icon48.png',
                title: title,
                message: String(message).slice(0, 240)
            });
        } else {
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icon48.png',
                title: '❌ Не удалось синхронизировать токен',
                message: String(result.error || 'Неизвестная ошибка').slice(0, 240)
            });
        }
    }
});

// Настройка расписания
async function setupAlarm() {
    await chrome.alarms.clear(ALARM_NAME);
    const config = await getConfig();
    if (!config.apiUrl || !config.connectionToken || !config.loginAccount) {
        await Logger.info('Настройки заполнены не полностью: синхронизация по расписанию выключена');
        return;
    }
    let validatedConfig;
    try {
        validatedConfig = validateConfig(config);
    } catch (error) {
        await Logger.error('Проверьте настройки: синхронизация по расписанию выключена', {
            error: error.message
        });
        return;
    }
    const intervalMinutes = validatedConfig.refreshInterval;
    chrome.alarms.create(ALARM_NAME, {
        delayInMinutes: intervalMinutes,
        periodInMinutes: intervalMinutes
    });
    await Logger.info(`Интервал синхронизации: ${intervalMinutes} мин.`);
}

function normalizeRefreshInterval(value) {
    const interval = Number.parseInt(value, 10);
    if (!Number.isInteger(interval) || interval < MIN_REFRESH_INTERVAL || interval > MAX_REFRESH_INTERVAL) {
        return DEFAULT_REFRESH_INTERVAL;
    }
    return interval;
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

function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        throw new Error('Укажите действительный адрес электронной почты аккаунта Google');
    }
    return email;
}

function validateConfig(config) {
    const connectionToken = String(config && config.connectionToken || '').trim();
    if (!connectionToken || connectionToken.length > 4096) {
        throw new Error('Неверный токен подключения');
    }
    const refreshInterval = Number.parseInt(config && config.refreshInterval, 10);
    if (
        !Number.isInteger(refreshInterval)
        || refreshInterval < MIN_REFRESH_INTERVAL
        || refreshInterval > MAX_REFRESH_INTERVAL
    ) {
        throw new Error(`Интервал должен быть от ${MIN_REFRESH_INTERVAL} до ${MAX_REFRESH_INTERVAL} минут`);
    }
    const apiUrl = normalizeApiUrl(config && config.apiUrl);
    const requiredApprovalOrigin = insecureRemoteOrigin(apiUrl);
    const insecureHttpOrigin = String(config && config.insecureHttpOrigin || '').trim();
    if (requiredApprovalOrigin && insecureHttpOrigin !== requiredApprovalOrigin) {
        throw new Error('Подтвердите небезопасный HTTP-адрес в настройках расширения');
    }
    return {
        apiUrl,
        connectionToken,
        loginAccount: normalizeEmail(config && config.loginAccount),
        refreshInterval,
        insecureHttpOrigin: requiredApprovalOrigin
    };
}

async function migrateLegacyConfig() {
    const [synced, local] = await Promise.all([
        chrome.storage.sync.get(['connectionToken']),
        chrome.storage.local.get(['connectionToken'])
    ]);
    if (!local.connectionToken && synced.connectionToken) {
        await chrome.storage.local.set({ connectionToken: synced.connectionToken });
    }
    if (synced.connectionToken) {
        await chrome.storage.sync.remove(['connectionToken']);
    }
}

async function getConfig() {
    await migrateLegacyConfig();
    const [synced, local] = await Promise.all([
        chrome.storage.sync.get(['apiUrl', 'loginAccount', 'refreshInterval']),
        chrome.storage.local.get(['connectionToken', 'insecureHttpOrigin'])
    ]);
    return {
        apiUrl: synced.apiUrl || '',
        connectionToken: local.connectionToken || '',
        loginAccount: synced.loginAccount || '',
        refreshInterval: normalizeRefreshInterval(synced.refreshInterval),
        insecureHttpOrigin: local.insecureHttpOrigin || ''
    };
}

async function saveConfig(input) {
    const config = validateConfig(input || {});
    await Promise.all([
        chrome.storage.sync.set({
            apiUrl: config.apiUrl,
            loginAccount: config.loginAccount,
            refreshInterval: config.refreshInterval
        }),
        chrome.storage.local.set({
            connectionToken: config.connectionToken,
            insecureHttpOrigin: config.insecureHttpOrigin
        })
    ]);
    await chrome.storage.sync.remove(['connectionToken']);
    return config;
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function waitForTabReady(tabId, timeoutMs = 15000) {
    return new Promise((resolve) => {
        let settled = false;

        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
        };

        const onUpdated = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                finish();
            }
        };

        const timer = setTimeout(finish, timeoutMs);
        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.get(tabId).then((currentTab) => {
            if (currentTab && currentTab.status === 'complete') {
                finish();
            }
        }).catch(finish);
    });
}

function cookieNamesFromRequestHeader(header) {
    return String(header || '')
        .split(';')
        .map(pair => pair.trim().split('=', 1)[0])
        .filter(Boolean);
}

async function closeTemporaryTab(tab) {
    if (!tab || typeof tab.id !== 'number') {
        return;
    }

    try {
        await chrome.tabs.remove(tab.id);
        await Logger.info('Временная вкладка закрыта');
    } catch (error) {
        await Logger.info('Временная вкладка уже закрыта');
    }
}

function parseServerErrorMessage(responseText) {
    const raw = String(responseText || '').trim();
    if (!raw) {
        return '';
    }

    try {
        const payload = JSON.parse(raw);
        const message = payload.detail || payload.message || payload.error;
        if (typeof message === 'string') {
            return message.slice(0, 300);
        }
    } catch (error) {
        // Если ответ не JSON, показываем сокращённый текст
    }

    return raw.slice(0, 300);
}

// Переводим только известные сообщения сервера для интерфейса. Незнакомые оставляем как есть.
function localizeServerMessage(value) {
    const text = String(value || '').trim();
    let match = /^Token added for (.+)$/i.exec(text);
    if (match) return `Аккаунт добавлен: ${match[1]}`;
    match = /^Token updated for (.+)$/i.exec(text);
    if (match) return `Аккаунт обновлён: ${match[1]}`;
    return text;
}

function isRetryableStatus(status) {
    return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function requestError(message, retryable = false) {
    const error = new Error(message);
    error.retryable = retryable;
    return error;
}

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function sendTokenPayload(config, payload) {
    let lastError = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            const response = await fetchWithTimeout(config.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.connectionToken}`
                },
                body: JSON.stringify(payload)
            });
            const responseText = await response.text();

            if (response.ok) {
                let result;
                try {
                    result = JSON.parse(responseText);
                } catch (error) {
                    throw requestError('Сервер вернул некорректный JSON');
                }
                if (!result || typeof result !== 'object') {
                    throw requestError('Сервер вернул ответ неверного формата');
                }
                if (result.success === false) {
                    throw requestError(
                        String(result.error || result.message || 'Сервер отклонил запрос синхронизации')
                    );
                }
                return result;
            }

            const serverError = parseServerErrorMessage(responseText);
            if (!isRetryableStatus(response.status) || attempt >= RETRY_DELAYS_MS.length) {
                throw requestError(
                    serverError
                        ? `Ошибка сервера ${response.status}: ${serverError}`
                        : `Ошибка сервера: ${response.status}`
                );
            }
            lastError = new Error(serverError || `HTTP ${response.status}`);
        } catch (error) {
            lastError = error && error.name === 'AbortError'
                ? new Error('Истекло время ожидания ответа от Flow2API')
                : error;
            const retryableNetworkError = error && error.retryable !== false && (
                error.name === 'AbortError'
                || error instanceof TypeError
                || /fetch|network|timeout/i.test(String(error.message || ''))
            );
            if (!retryableNetworkError || attempt >= RETRY_DELAYS_MS.length) {
                throw lastError;
            }
        }

        const delay = RETRY_DELAYS_MS[attempt];
        await Logger.info(`Ошибка отправки. Повтор через ${delay} мс`, {
            attempt: attempt + 1,
            error: lastError ? lastError.message : 'unknown'
        });
        await sleep(delay);
    }

    throw lastError || new Error('Не удалось отправить токен');
}

function runTokenSync() {
    if (activeSyncPromise) {
        return activeSyncPromise;
    }
    activeSyncPromise = extractAndSendToken()
        .then(async (result) => {
            try {
                await recordSyncResult(result);
            } catch (error) {
                await Logger.error('Не удалось сохранить состояние синхронизации', { error: error.message });
            }
            return result;
        })
        .finally(() => {
            activeSyncPromise = null;
        });
    return activeSyncPromise;
}

async function recordSyncResult(result) {
    const success = Boolean(result && result.success);
    const lastSync = {
        timestamp: new Date().toISOString(),
        success,
        action: String(result && result.action || ''),
        message: sanitizeLogDetails(String(
            success
                ? result && result.message || 'Синхронизация успешна'
                : result && result.error || 'Синхронизация не удалась'
        )).slice(0, 300)
    };
    await chrome.storage.local.set({ lastSync });
    await updateSyncBadge(lastSync);
}

async function restoreSyncBadge() {
    const { lastSync } = await chrome.storage.local.get(['lastSync']);
    if (lastSync) {
        await updateSyncBadge(lastSync);
    }
}

async function updateSyncBadge(lastSync) {
    const success = Boolean(lastSync && lastSync.success);
    await chrome.action.setBadgeBackgroundColor({ color: success ? '#137333' : '#c5221f' });
    await chrome.action.setBadgeText({ text: success ? '✓' : '!' });
    await chrome.action.setTitle({
        title: success ? 'Flow2API: последняя синхронизация успешна' : 'Flow2API: последняя синхронизация не удалась'
    });
}

// Получение Cookie и отправка на сервер
async function extractAndSendToken() {
    let tab = null;

    try {
        await Logger.info('Начинаем синхронизацию...');

        const config = validateConfig(await getConfig());

        await Logger.info('Настройки загружены', { apiUrl: config.apiUrl });

        // 1. Открываем страницу Flow в фоне для обновления текущей сессии
        await Logger.info('Открываем Google Flow...');
        // Create a blank tab first to avoid missing the initial main_frame request.
        tab = await chrome.tabs.create({ url: 'about:blank', active: false });
        activeRequestCookieCapture = { tabId: tab.id, header: '' };
        await chrome.tabs.update(tab.id, { url: FLOW_URL });

        await Logger.info('Вкладка создана, ожидаем загрузку...', { tabId: tab.id });

        await waitForTabReady(tab.id);

        await Logger.info('Страница загружена, ожидаем выполнения JavaScript...');

        await sleep(5000);

        const loadedTab = await chrome.tabs.get(tab.id);
        let loadedHost = '';
        try {
            loadedHost = new URL(loadedTab.url || '').hostname.toLowerCase();
        } catch (error) {
            loadedHost = '';
        }
        if (loadedHost !== 'flow.google.com') {
            await closeTemporaryTab(tab);
            tab = null;
            return {
                success: false,
                error: 'В этом профиле Chrome нет активного входа в Google Flow. Войдите в аккаунт и повторите попытку.'
            };
        }

        await Logger.info('Получаем Cookie из запроса...');

        // 2. Берём Cookie из исходящего запроса Chrome к flow.google.com без изменений.
        // Never serialize the cookie store to JSON or re-order/remove cookies.
        const googleCookies = activeRequestCookieCapture?.header || '';
        const cookieNames = cookieNamesFromRequestHeader(googleCookies);
        const hasFlowSession = cookieNames.some(name => name === 'OSID' || name === '__Secure-OSID');
        const hasGoogleSession = cookieNames.some(name => [
            'SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'
        ].includes(name));

        // The temporary tab is no longer needed after its request header is captured.
        await closeTemporaryTab(tab);
        tab = null;

        if (!googleCookies) {
            return {
                success: false,
                error: 'Chrome не передал заголовок Cookie для flow.google.com. Войдите в Flow и убедитесь, что в Network у запроса страницы есть Cookie.'
            };
        }
        if (!hasFlowSession || !hasGoogleSession) {
            await Logger.info('В запросе отсутствуют необходимые Cookie авторизации', {
                hasFlowSession, hasGoogleSession, cookieCount: cookieNames.length
            });
            return {
                success: false,
                error: 'В запросе Flow не хватает Cookie сессии Google (OSID/SID). Войдите в Google Flow заново в этом профиле Chrome.'
            };
        }

        await Logger.info('Cookie Google Flow получены', {
            mode: 'network-request-cookie-header',
            cookieCount: cookieNames.length
        });

        // 3. Отправка на сервер
        await Logger.info('Отправляем данные на сервер...');

        const payload = {
            google_cookies: googleCookies,
            protocol_mode: 'protocol'
        };
        payload.login_account = String(config.loginAccount).trim();

        const result = await sendTokenPayload(config, payload);

        // Разные сообщения для добавленного и обновлённого аккаунта
        if (result.action === 'updated') {
            await Logger.success('✅ Токен аккаунта обновлён на сервере', {
                action: 'Обновление существующего токена',
                message: localizeServerMessage(result.message)
            });
        } else if (result.action === 'added') {
            await Logger.success('✅ Токен аккаунта добавлен на сервер', {
                action: 'Добавление нового токена',
                message: localizeServerMessage(result.message)
            });
        } else {
            await Logger.success('✅ Токен аккаунта синхронизирован', result);
        }

        return {
            success: true,
            message: localizeServerMessage(result.message) || 'Токен успешно обновлён',
            action: result.action,
            displayMessage: result.action === 'updated'
                ? `✅ Данные аккаунта обновлены на сервере\n${localizeServerMessage(result.message) || 'Токен успешно обновлён'}`
                : `✅ Аккаунт добавлен на сервер\n${localizeServerMessage(result.message) || 'Токен успешно синхронизирован'}`
        };

    } catch (error) {
        await Logger.error('Ошибка синхронизации', { error: error.message });

        await closeTemporaryTab(tab);

        return { success: false, error: error.message };
    } finally {
        // Never retain auth cookies in the service worker after this sync.
        activeRequestCookieCapture = null;
    }
}
