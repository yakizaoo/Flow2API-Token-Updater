# Flow2API Token Updater RU

**Русский** | [English](#english)

расширение для автоматического обновления Google Cookies в [Flow2API](https://github.com/TheSmallHanCat/flow2api).

оригинальное расширение почему-то собирало куки из хранилища браузера и отправляло их в JSON. у меня такой способ не работал, сервер возвращал ошибку `Flow frontend bootstrap XSRF token is unavailable`.

при этом обычная строка `Cookie`, скопированная через F12 → Network, прекрасно работала. поэтому переделал получение куков. теперь расширение перехватывает реальный заголовок `Cookie` из запроса к `flow.google.com` и отправляет его на сервер в том же формате.

за основу взято [Flow2API-Token-Updater](https://github.com/TheSmallHanCat/Flow2API-Token-Updater). интерфейс полностью переведён на русский.

### функционал

- автоматическое обновление Google Cookies через API Flow2API
- получение Cookie напрямую из сетевых запросов браузера, как в F12 → Network
- привязка к Google-аккаунту по почте
- автоматическая синхронизация каждые 60 минут, интервал можно изменить
- ручная синхронизация для проверки
- журнал событий с ошибками и результатами
- повторные попытки при временных сетевых ошибках
- русский интерфейс

### установка

1. скачать архив и распаковать в любую папку
2. открыть `chrome://extensions/`
3. включить режим разработчика
4. нажать «Загрузить распакованное расширение» и выбрать папку с файлами

![Установка](image.png)

![Расширение](image-1.png)

### настройка

1. открыть расширение
2. указать адрес Flow2API, Connection Token и почту Google-аккаунта
3. выставить интервал обновления, по умолчанию 60 минут
4. сохранить настройки и нажать «Тестировать»

![Настройки](image-2.png)

Connection URL и Connection Token берутся из настроек Flow2API, в разделе подключения расширения.

![Настройки Flow2API](image-3.png)

перед синхронизацией нужно авторизоваться в Google и убедиться, что `https://flow.google.com/projects` нормально открывается.

расширение использует текущий профиль Chrome. если аккаунтов несколько, для каждого лучше использовать отдельный профиль браузера с собственными настройками расширения.

после успешной синхронизации аккаунт добавится или обновится в Flow2API. существующий аккаунт определяется по указанной почте.

### нюансы

- Chrome должен быть запущен для автоматической синхронизации
- если Google полностью сбросит сессию, придётся авторизоваться заново
- обновление cookies не гарантирует, что Google примет каждый запрос генерации
- Cookie и Connection Token не записываются в журнал расширения
- Connection Token хранится локально в браузере
- для публичного VPS лучше использовать HTTPS, потому что через обычный HTTP куки и токен передаются без шифрования

в целом на этом всё. один раз настроил, нажал «Тестировать», убедился, что аккаунт обновился, дальше расширение работает по заданному интервалу.

---

<a id="english"></a>

# English

a Chrome extension for automatically updating Google Cookies in [Flow2API](https://github.com/TheSmallHanCat/flow2api).

the original extension collected cookies from browser storage and sent them as JSON. for some reason, that didn't work with my Flow2API installation. the server kept returning `Flow frontend bootstrap XSRF token is unavailable`.

meanwhile, manually copying the `Cookie` header from F12 → Network worked perfectly fine. so I changed how cookies are collected. the extension now captures the actual `Cookie` header from requests to `flow.google.com` and sends it to the server in the same format.

based on [Flow2API-Token-Updater](https://github.com/TheSmallHanCat/Flow2API-Token-Updater), with modified cookie extraction and a fully translated Russian interface.

### features

- automatic Google Cookie updates through the Flow2API API
- captures the actual Cookie header from browser network requests
- links updates to a Google account using its email
- automatic synchronization every 60 minutes by default
- manual synchronization for testing
- event logs with errors and results
- retries for temporary network errors
- Russian interface

### installation

1. download and extract the archive
2. open `chrome://extensions/`
3. enable Developer mode
4. click "Load unpacked" and select the extracted extension folder

![Installation](image.png)

![Extension](image-1.png)

### configuration

1. open the extension
2. enter your Flow2API URL, Connection Token and Google account email
3. set the synchronization interval, 60 minutes by default
4. save the settings and click "Test"

![Settings](image-2.png)

you can find the Connection URL and Connection Token in your Flow2API settings, under the extension connection section.

![Flow2API settings](image-3.png)

make sure you're logged into Google and `https://flow.google.com/projects` opens correctly before synchronizing.

the extension uses your current Chrome profile. if you have multiple Google accounts, it's better to use separate browser profiles with their own extension settings.

after successful synchronization, the account will be added or updated in Flow2API. existing accounts are matched by email.

### notes

- Chrome must be running for scheduled synchronization
- if Google invalidates your session, you'll need to log in again
- updating cookies doesn't guarantee successful video or image generation
- cookies and Connection Tokens are not written to extension logs
- the Connection Token is stored locally in your browser
- use HTTPS for public VPS deployments, since plain HTTP sends cookies and tokens without encryption

that's pretty much it. configure the extension once, run a test, check that your account was updated and leave it to synchronize at the selected interval.
