# WhatsApp AI Browser Bot

Bot WhatsApp yang mengambil jawaban dari AI web lewat browser otomatis. Bot ini bisa memakai Gemini atau ChatGPT yang sudah login di browser profile lokal server.

Bot ini tidak memakai OpenAI API key, Gemini API key, atau model lokal. Semua jawaban diambil dari halaman web AI yang dibuka Playwright.

## Fitur

- WhatsApp bot via Baileys.
- AI browser: Gemini atau ChatGPT.
- Login AI disimpan di browser profile, jadi tidak perlu login ulang setiap start.
- Mode jawaban per chat.
- Remote login dari HP lewat panel browser screenshot.
- ChatGPT bisa login manual tanpa cookie. Cookie hanya opsi cadangan.
- Session, cookie, `.env`, browser profile, dan backup sudah di-ignore dari Git.

## Cara Kerja

1. Bot start dengan service AI yang dipilih: `gemini` atau `chatgpt`.
2. Bot login ke WhatsApp memakai session Baileys di folder `session/`.
3. User mengirim pesan WhatsApp.
4. Bot membuka browser profile AI yang sudah login.
5. Bot memilih mode AI, mengetik pertanyaan, menunggu jawaban, lalu mengirim jawaban balik ke WhatsApp.

## Requirement

- Node.js 20 atau lebih baru.
- `npm`.
- Browser Chromium dari Playwright.
- Linux VPS disarankan memakai `xvfb-run` karena browser berjalan non-headless untuk menjaga kompatibilitas web AI.
- Akun Gemini dan/atau ChatGPT yang bisa login manual.
- WhatsApp aktif untuk pairing bot.

Install dependency:

```bash
npm install
```

Kalau Playwright browser belum ada:

```bash
npx playwright install chromium
```

Di beberapa VPS, dependency Chromium juga perlu dipasang:

```bash
npx playwright install-deps chromium
```

## File Penting

- `index.js`: main bot WhatsApp dan otomasi browser Gemini/ChatGPT.
- `login.js`: login manual kalau server punya GUI/browser yang bisa dibuka.
- `scripts/remote-login.js`: login dari HP lewat panel remote.
- `src/chatgpt-cookies.js`: helper import cookie ChatGPT opsional.
- `.env.example`: contoh konfigurasi.
- `package.json`: daftar script.

## File Yang Tidak Boleh Diupload

File berikut berisi data sensitif dan sudah masuk `.gitignore`:

- `.env`
- `cookie.js`
- `ai-modes.json`
- `session/`
- `auth_info_baileys*/`
- `browser-profile/`
- `browser-profile-gemini/`
- `.wwebjs_auth/`
- `backups/`
- `node_modules/`

Jangan upload folder atau file tersebut ke GitHub. Kalau repo dipindah ke server baru, login WhatsApp, Gemini, dan ChatGPT harus dibuat ulang di server baru.

## Konfigurasi

Buat `.env` dari contoh:

```bash
cp .env.example .env
```

Variabel yang paling sering dipakai:

```env
WEB_AI_SERVICE=gemini
AUTH_DIR=./session
USE_PAIRING_CODE=true
PAIRING_PHONE_NUMBER=
BROWSER_PROFILE=./browser-profile-gemini
WEB_AI_HEADLESS=false
```

Service yang valid:

```env
WEB_AI_SERVICE=gemini
WEB_AI_SERVICE=chatgpt
```

Profile default:

- Gemini: `./browser-profile-gemini`
- ChatGPT: `./browser-profile`

Kalau `BROWSER_PROFILE` diisi manual, nilai itu akan dipakai untuk service apa pun. Kalau ingin profile otomatis sesuai service, kosongkan `BROWSER_PROFILE`.

## Login WhatsApp

Saat bot pertama kali start, bot akan meminta pairing code jika session belum ada. Gunakan nomor WhatsApp format internasional tanpa `+`.

Contoh:

```env
PAIRING_PHONE_NUMBER=6281234567890
USE_PAIRING_CODE=true
```

Lalu start bot. Masukkan pairing code di WhatsApp:

```text
WhatsApp -> Perangkat tertaut -> Tautkan perangkat -> Tautkan dengan nomor telepon
```

Session WhatsApp akan tersimpan di `AUTH_DIR`, default-nya `./session`.

## Login AI Browser

Ada dua cara login AI:

1. Login lokal, kalau server punya tampilan browser yang bisa dibuka.
2. Remote login, untuk VPS/headless. Ini yang biasanya dipakai.

### Login Lokal

Gemini:

```bash
npm run login:gemini
```

ChatGPT:

```bash
npm run login:chatgpt
```

Setelah halaman AI terbuka, login sampai halaman chat bisa dipakai. Lalu tekan `ENTER` di terminal untuk menyimpan session.

### Remote Login Dari HP

Untuk VPS, jangan mengandalkan URL `http://IP-VPS:8787`. Login Gemini/ChatGPT sering bermasalah lewat IP VPS langsung, terutama karena origin tidak HTTPS, firewall, atau proteksi login web AI.

Pakai domain HTTPS dari tunnel/public preview, seperti:

```text
https://subdomain.lhr.life/?token=<token>
```

Contoh bentuk URL:

```text
https://b1a308a406f358.lhr.life/?token=xxxxxxxxxxxxxxxxxxxxxxxx
```

URL di atas hanya contoh. Pakai URL domain HTTPS yang muncul dari tunnel/session kamu sendiri.

Jalankan remote login Gemini:

```bash
npm run remote-login:gemini
```

Jalankan remote login ChatGPT:

```bash
npm run remote-login:chatgpt
```

Script akan membuka browser di VPS dan menyediakan panel remote di port `8787`. Panel itu menampilkan screenshot browser, lalu HP mengirim click dan text input ke browser VPS.

Alur login remote:

1. Jalankan `npm run remote-login:gemini` atau `npm run remote-login:chatgpt`.
2. Buka URL domain HTTPS tunnel dari HP, bukan IP VPS mentah.
3. URL harus membawa query `token`, contoh `?token=...`.
4. Tap field email/password di screenshot.
5. Ketik email/password/kode OTP di textarea panel.
6. Tekan `Send Text`, `Send + Enter`, atau tombol keyboard lain sesuai kebutuhan.
7. Tunggu sampai halaman chat Gemini/ChatGPT terbuka.
8. Tekan tombol `Done` di panel.
9. Browser profile akan tersimpan di server.

Kalau ingin log script menampilkan URL domain langsung, set:

```bash
REMOTE_LOGIN_PUBLIC_URL="https://subdomain.lhr.life" npm run remote-login:chatgpt
```

Nanti buka:

```text
https://subdomain.lhr.life/?token=<token-yang-muncul-di-terminal>
```

Catatan penting:

- Token remote login dibuat random setiap run, kecuali `REMOTE_LOGIN_TOKEN` diset manual.
- Jangan share URL remote login ke orang lain.
- Setelah login selesai, tutup remote login dengan tombol `Done`.
- Jika session AI expired, ulangi remote login.

## ChatGPT Cookie

ChatGPT tidak wajib memakai `cookie.js`.

Cara utama yang disarankan:

```bash
npm run login:chatgpt
```

atau di VPS:

```bash
npm run remote-login:chatgpt
```

Session login akan tersimpan di `./browser-profile`.

`cookie.js` hanya opsi cadangan kalau sudah punya export cookie ChatGPT. Jika ingin import cookie:

```bash
npm run import:cookies
```

Saat service ChatGPT aktif, bot akan mencoba load `cookie.js` kalau file itu ada. Kalau file tidak ada, bot tetap lanjut memakai browser profile manual login.

## Start Bot

Mode interaktif:

```bash
npm start
```

Langsung Gemini:

```bash
npm run start:gemini
```

Langsung ChatGPT:

```bash
npm run start:chatgpt
```

Atau pakai environment:

```bash
WEB_AI_SERVICE=gemini npm start
WEB_AI_SERVICE=chatgpt npm start
```

## Start Dengan PM2

Gemini:

```bash
pm2 start npm --name whatsapp-ai-bot-gemini -- run start:gemini
```

ChatGPT:

```bash
pm2 start npm --name whatsapp-ai-bot-chatgpt -- run start:chatgpt
```

Cek status:

```bash
pm2 list
pm2 logs whatsapp-ai-bot-gemini
```

Switch dari ChatGPT ke Gemini:

```bash
pm2 stop whatsapp-ai-bot-chatgpt
pm2 start npm --name whatsapp-ai-bot-gemini -- run start:gemini
```

Switch dari Gemini ke ChatGPT:

```bash
pm2 stop whatsapp-ai-bot-gemini
pm2 start npm --name whatsapp-ai-bot-chatgpt -- run start:chatgpt
```

Jangan jalankan dua proses untuk nomor WhatsApp yang sama secara bersamaan.

## Cara Pakai Di WhatsApp

Private chat:

```text
Tanya langsung tanpa prefix
```

Group:

```text
.ai tulis ringkasan singkat tentang DNS
```

Kalau `.ai` dikirim tanpa pertanyaan, bot akan menampilkan bantuan mode.

## Mode Jawaban

Mode disimpan per chat. Command:

```text
.ai mode
.ai mode auto
.ai mode cepat
.ai mode penalaran
.ai mode pro
.ai mode instant
.ai mode thinking
```

Gemini:

- `cepat` atau `instant`: mode cepat untuk respons ringan.
- `penalaran` atau `thinking`: mode reasoning/penalaran.
- `pro`: mode Gemini Pro untuk pertanyaan berat.
- `auto`: bot memilih mode dari isi pertanyaan.

ChatGPT:

- `instant`: GPT-5.3 Instant.
- `thinking`: GPT-5.5 Thinking.
- `cepat`: alias ke `instant`.
- `penalaran`: alias ke `thinking`.
- `pro`: diarahkan ke `thinking`, karena ChatGPT di bot ini hanya memakai dua mode.
- `auto`: bot memilih `instant` atau `thinking`.

## Cek Session

Cek Gemini:

```bash
npm run check:gemini:xvfb
```

Cek ChatGPT:

```bash
npm run check:chatgpt:xvfb
```

Kalau check gagal karena login expired, ulangi login AI browser.

## Troubleshooting

### Remote Login Tidak Bisa Dibuka Dari HP

Jangan pakai `http://IP-VPS:8787` kalau gagal. Pakai domain HTTPS dari tunnel/public preview, misalnya:

```text
https://subdomain.lhr.life/?token=<token>
```

Pastikan:

- Remote login script masih berjalan.
- URL membawa query `token`.
- Domain HTTPS mengarah ke port remote login `8787`.
- Firewall VPS tidak memblokir port jika memang memakai akses langsung.

### ChatGPT Masuk Halaman Login Lagi

Session `./browser-profile` expired. Jalankan:

```bash
npm run remote-login:chatgpt
```

Login ulang sampai halaman chat terbuka, lalu tekan `Done`.

### Gemini Masuk Halaman Login Lagi

Session `./browser-profile-gemini` expired. Jalankan:

```bash
npm run remote-login:gemini
```

### ChatGPT Berhenti Di `Just a moment...`

Tunggu beberapa saat. Kalau tetap berhenti, login ulang manual/remote sampai halaman chat terbuka. Cookie tidak wajib, tapi jika memakai cookie, pastikan cookie belum expired dan user-agent cocok.

### Mode Tidak Sesuai

Pastikan service yang sedang jalan benar:

```bash
pm2 logs whatsapp-ai-bot-gemini --lines 30
pm2 logs whatsapp-ai-bot-chatgpt --lines 30
```

Log startup akan menampilkan:

```text
Mode AI browser: Gemini
```

atau:

```text
Mode AI browser: ChatGPT
```

### Bot Lambat Menjawab

Bot ini mengontrol web UI, bukan API. Kecepatan tergantung:

- kecepatan web Gemini/ChatGPT,
- kondisi browser profile,
- koneksi VPS,
- panjang konteks chat,
- mode yang dipilih.

Untuk respons cepat, pakai:

```text
.ai mode cepat
```

di Gemini, atau:

```text
.ai mode instant
```

di ChatGPT.

## Backup

Backup source dan session bisa dibuat dengan `tar`. Jangan upload hasil backup ke GitHub karena berisi session login.

Contoh backup lokal:

```bash
tar --exclude=./node_modules --exclude=./backups --exclude=./.git-data -czf backups/ai-backup.tgz .
```

## Publish Ke GitHub

Yang aman di-commit:

- source code,
- `package.json`,
- `package-lock.json`,
- `.env.example`,
- README,
- test dan script.

Yang tidak boleh di-commit:

- `.env`,
- `cookie.js`,
- `session/`,
- `browser-profile/`,
- `browser-profile-gemini/`,
- backup.

Sebelum push:

```bash
git status
git diff --cached --name-only
```

Pastikan file rahasia tidak muncul di daftar commit.

## Test

Jalankan:

```bash
npm test
```

Test ini melakukan syntax check file utama dan menjalankan unit test yang tersedia.
