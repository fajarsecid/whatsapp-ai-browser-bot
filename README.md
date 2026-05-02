# WhatsApp AI Browser Bot

Bot WhatsApp yang mengambil jawaban dari AI web lewat browser otomatis. Bot ini memakai WhatsApp via Baileys dan mengontrol halaman Gemini atau ChatGPT lewat Playwright.

Bot ini tidak memakai OpenAI API key, Gemini API key, atau model lokal. Semua jawaban diambil dari akun Gemini/ChatGPT yang sudah login di browser profile server.

## Fitur

- WhatsApp bot via Baileys.
- AI browser: Gemini dan ChatGPT.
- Login AI disimpan di browser profile lokal server.
- Switch Gemini/ChatGPT per chat dari WhatsApp.
- Default AI browser disimpan lintas restart di `ai-services.json`.
- Mode jawaban per chat: `auto`, `cepat/instant`, `penalaran/thinking`, `pro`.
- Command `.ai status` untuk melihat AI aktif, mode, antrean, dan status browser.
- Batas antrean per chat agar spam pesan tidak menumpuk terlalu panjang.
- Retry otomatis saat browser AI timeout atau macet: browser di-reload lalu request dicoba ulang.
- Remote login dari HP lewat panel screenshot browser.
- ChatGPT memakai login manual di browser profile, tanpa import cookie.
- Session, `.env`, browser profile, dan backup sudah di-ignore dari Git.

## Cara Kerja

1. Bot start dan login ke WhatsApp memakai session Baileys di `AUTH_DIR`, default `./session`.
2. Saat WhatsApp tersambung, bot warmup AI browser default.
3. Private chat bisa langsung bertanya tanpa prefix.
4. Group wajib memakai prefix `.ai`.
5. Untuk setiap chat, bot menentukan AI browser yang dipakai:
   - pilihan per chat dari `.ai mode gemini/chatgpt`, atau
   - default dari `ai-services.json` / `WEB_AI_SERVICE`.
6. Bot membuka browser profile AI yang sesuai:
   - Gemini: `./browser-profile-gemini`
   - ChatGPT: `./browser-profile`
7. Bot memilih mode AI sesuai command chat atau auto-classifier.
8. Bot mengetik pertanyaan ke web AI, menunggu jawaban final, lalu mengirim balasan ke WhatsApp.
9. Kalau web AI timeout, bot reload browser AI tersebut dan mencoba ulang sesuai `WEB_AI_MAX_ATTEMPTS`.

## Requirement

- Node.js 20 atau lebih baru.
- `npm`.
- Chromium dari Playwright.
- Linux VPS disarankan memakai `xvfb-run` karena Gemini/ChatGPT sering lebih stabil dalam mode non-headless.
- Akun Gemini dan/atau ChatGPT yang bisa login manual.
- WhatsApp aktif untuk pairing bot.

## Install Dari Nol

Clone repo:

```bash
git clone https://github.com/fajarsecid/whatsapp-ai-browser-bot.git
cd whatsapp-ai-browser-bot
```

Install dependency Node.js:

```bash
npm install
```

Install browser Chromium Playwright:

```bash
npx playwright install chromium
```

Jika VPS belum punya dependency sistem Chromium:

```bash
npx playwright install-deps chromium
```

Install tool runtime untuk VPS headless jika belum ada:

```bash
sudo apt-get update
sudo apt-get install -y xvfb
```

Salin konfigurasi:

```bash
cp .env.example .env
```

Edit `.env`:

```env
WEB_AI_SERVICE=gemini
AUTH_DIR=./session
USE_PAIRING_CODE=true
PAIRING_PHONE_NUMBER=6281234567890
WEB_AI_HEADLESS=false
```

`PAIRING_PHONE_NUMBER` wajib format internasional tanpa `+`, spasi, atau awalan `0`.

## Konfigurasi Penting

```env
# AI default saat bot pertama kali start.
WEB_AI_SERVICE=gemini

# Session WhatsApp.
AUTH_DIR=./session
USE_PAIRING_CODE=true
PAIRING_PHONE_NUMBER=6281234567890

# Browser profile. Kosongkan agar otomatis per service.
BROWSER_PROFILE=
GEMINI_BROWSER_PROFILE=./browser-profile-gemini
CHATGPT_BROWSER_PROFILE=./browser-profile
WEB_AI_HEADLESS=false

# File penyimpanan mode dan pilihan AI per chat.
AI_MODE_FILE=./ai-modes.json
AI_SERVICE_FILE=./ai-services.json

# Mode jawaban default.
AI_MODE=auto

# Session dan retry.
WEB_AI_SESSION_IDLE_MS=300000
WEB_AI_MAX_ATTEMPTS=2
MAX_QUEUE_PER_CHAT=2

# Deteksi jawaban selesai.
ANSWER_STABLE_INTERVAL_MS=300
ANSWER_STABLE_CHECKS=2
```

Catatan profile browser:

- Pakai `GEMINI_BROWSER_PROFILE` dan `CHATGPT_BROWSER_PROFILE` jika ingin path eksplisit per service.
- Kosongkan `BROWSER_PROFILE` untuk memakai profile otomatis atau profile per service di atas.
- Gemini otomatis memakai `./browser-profile-gemini`.
- ChatGPT otomatis memakai `./browser-profile`.
- `BROWSER_PROFILE` adalah opsi lama. Di bot utama, nilai ini hanya dipakai untuk service default saat start agar switch Gemini/ChatGPT tidak berbenturan.

## Login WhatsApp

Start bot:

```bash
npm run start:gemini
```

Jika session WhatsApp belum ada, bot akan menampilkan pairing code.

Buka WhatsApp di HP:

```text
WhatsApp -> Perangkat tertaut -> Tautkan perangkat -> Tautkan dengan nomor telepon
```

Masukkan pairing code dari terminal. Setelah berhasil, session tersimpan di `./session`.

## Login Gemini Dan ChatGPT

Bot perlu browser profile yang sudah login. Login dilakukan sekali per AI browser, lalu session tersimpan di server.

### Login Lokal

Jika server punya GUI atau browser bisa dibuka:

```bash
npm run login:gemini
npm run login:chatgpt
```

Login sampai halaman chat AI terbuka, lalu tekan `ENTER` di terminal script login.

### Remote Login Dari HP

Untuk VPS/headless:

```bash
npm run remote-login:gemini
npm run remote-login:chatgpt
```

Script membuka browser di VPS dan panel remote di port `8787`. Panel ini menampilkan screenshot browser, lalu HP mengirim click dan text input ke browser VPS.

Gunakan URL HTTPS dari tunnel/public preview, bukan IP VPS mentah, misalnya:

```text
https://subdomain.lhr.life/?token=<token>
```

Jika ingin terminal menampilkan URL public:

```bash
REMOTE_LOGIN_PUBLIC_URL="https://subdomain.lhr.life" npm run remote-login:gemini
```

Alur remote login:

1. Jalankan `npm run remote-login:gemini` atau `npm run remote-login:chatgpt`.
2. Buka URL HTTPS yang membawa query `?token=...`.
3. Tap field email/password di screenshot.
4. Ketik email/password/kode OTP di textarea panel.
5. Pakai tombol `Send Text`, `Send + Enter`, atau tombol keyboard lain.
6. Tunggu sampai halaman chat Gemini/ChatGPT terbuka.
7. Tekan `Done` di panel.

Catatan:

- Token remote login dibuat random setiap run, kecuali `REMOTE_LOGIN_TOKEN` diisi.
- Jangan share URL remote login.
- Jika session AI expired, ulangi login untuk AI tersebut.

## Login ChatGPT

ChatGPT memakai session browser profile dari login manual:

```bash
npm run login:chatgpt
```

atau:

```bash
npm run remote-login:chatgpt
```

Tunggu sampai halaman chat terbuka sebelum menutup login.

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

Dengan environment:

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

Restart setelah update kode:

```bash
pm2 restart whatsapp-ai-bot-gemini
```

Stop bot:

```bash
pm2 stop whatsapp-ai-bot-gemini
```

Jangan jalankan dua proses untuk nomor WhatsApp yang sama secara bersamaan.

## Cara Pakai Di WhatsApp

### Private Chat

Di private chat, kirim pertanyaan langsung:

```text
buatkan caption promosi produk kopi
```

Command tetap memakai prefix `.ai`:

```text
.ai status
.ai mode chatgpt
```

### Group

Di group, pertanyaan harus memakai prefix `.ai`:

```text
.ai ringkas artikel ini jadi 5 poin
```

Jika `.ai` dikirim tanpa pertanyaan, bot menampilkan bantuan mode dan switch AI.

## Command WhatsApp

Cek status chat dan bot:

```text
.ai status
```

Status berisi:

- AI browser chat ini.
- Default AI browser.
- Mode chat ini.
- Status browser AI.
- Jumlah session aktif.
- Antrean chat ini.
- Antrean total.
- Jumlah retry otomatis.

Switch AI browser untuk chat saat ini:

```text
.ai mode gemini
.ai mode chatgpt
```

Alias typo yang diterima:

```text
.ai modr gemini
.ai modr chatgpt
```

Balikkan chat ke AI default:

```text
.ai mode default
```

Ubah default untuk semua chat yang belum punya pilihan sendiri:

```text
.ai mode global gemini
.ai mode global chatgpt
```

Pilihan AI browser disimpan di `ai-services.json`, jadi tetap berlaku setelah PM2 restart.

## Mode Jawaban

Mode disimpan per chat di `ai-modes.json`.

Command:

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

- `auto`: bot memilih mode dari isi pertanyaan.
- `cepat` atau `instant`: mode cepat untuk respons ringan.
- `penalaran` atau `thinking`: mode reasoning/penalaran.
- `pro`: mode Gemini Pro untuk pertanyaan berat.

ChatGPT:

- `auto`: bot memilih `instant` atau `thinking`.
- `instant`: GPT-5.3 Instant.
- `thinking`: GPT-5.5 Thinking.
- `cepat`: alias ke `instant`.
- `penalaran`: alias ke `thinking`.
- `pro`: diarahkan ke `thinking`, karena ChatGPT di bot ini hanya memakai dua mode.

## Antrean Dan Retry

`MAX_QUEUE_PER_CHAT` membatasi jumlah pesan yang boleh menunggu per chat. Default:

```env
MAX_QUEUE_PER_CHAT=2
```

Jika chat mengirim terlalu banyak pertanyaan saat bot masih memproses, bot akan membalas bahwa antrean chat penuh.

`WEB_AI_MAX_ATTEMPTS` mengatur retry saat AI web timeout atau selector tidak muncul. Default:

```env
WEB_AI_MAX_ATTEMPTS=2
```

Saat retry, bot mengirim pesan singkat bahwa browser AI lambat atau macet, lalu reload browser AI tersebut dan mencoba lagi.

## File Runtime Yang Dibuat Bot

- `session/`: session WhatsApp Baileys.
- `browser-profile-gemini/`: login Gemini.
- `browser-profile/`: login ChatGPT.
- `ai-modes.json`: mode jawaban per chat.
- `ai-services.json`: pilihan Gemini/ChatGPT per chat dan default.

File-file ini sensitif dan sudah masuk `.gitignore`.

## Cek Session AI

Cek Gemini:

```bash
npm run check:gemini:xvfb
```

Cek ChatGPT:

```bash
npm run check:chatgpt:xvfb
```

Jika check gagal karena login expired, ulangi login AI browser.

## Test Dan Validasi

Syntax check dan test bawaan:

```bash
npm test
```

Check `index.js` saja:

```bash
node --check index.js
```

## Troubleshooting

### Bot Lambat Menjawab

Bot ini mengontrol web UI, bukan API. Kecepatan tergantung web Gemini/ChatGPT, koneksi VPS, kondisi browser profile, panjang jawaban, dan mode yang dipilih.

Untuk respons cepat:

```text
.ai mode cepat
```

atau saat ChatGPT:

```text
.ai mode instant
```

### ChatGPT Atau Gemini Login Expired

Login ulang AI yang bermasalah:

```bash
npm run remote-login:gemini
npm run remote-login:chatgpt
```

### ChatGPT Berhenti Di `Just a moment...`

Tunggu beberapa saat. Jika tetap berhenti, login ulang manual/remote sampai halaman chat terbuka.

### Remote Login Tidak Bisa Dibuka Dari HP

Jangan pakai `http://IP-VPS:8787` jika gagal. Pakai domain HTTPS dari tunnel/public preview.

Pastikan:

- Script remote login masih berjalan.
- URL membawa query `token`.
- Domain HTTPS mengarah ke port `8787`.
- Firewall VPS tidak memblokir port jika memakai akses langsung.

### Mode Atau AI Tidak Sesuai

Cek dari WhatsApp:

```text
.ai status
```

Cek log PM2:

```bash
pm2 logs whatsapp-ai-bot-gemini --lines 50
```

### Reset Pilihan AI Chat

Jika chat terlanjur dipaksa ke Gemini/ChatGPT dan ingin ikut default lagi:

```text
.ai mode default
```

### Bersihkan Session

Hanya lakukan jika memang ingin login ulang.

WhatsApp:

```bash
pm2 stop whatsapp-ai-bot-gemini
mv session session.backup
npm run start:gemini
```

Gemini:

```bash
pm2 stop whatsapp-ai-bot-gemini
mv browser-profile-gemini browser-profile-gemini.backup
npm run remote-login:gemini
```

ChatGPT:

```bash
pm2 stop whatsapp-ai-bot-gemini
mv browser-profile browser-profile.backup
npm run remote-login:chatgpt
```

## Backup

Backup lokal:

```bash
mkdir -p backups
tar --exclude=./node_modules --exclude=./backups --exclude=./.git-data -czf backups/ai-backup.tgz .
```

Jangan upload backup ke GitHub karena berisi session login.

## Publish Ke GitHub

Yang aman di-commit:

- Source code.
- `package.json`.
- `package-lock.json`.
- `.env.example`.
- `.gitignore`.
- README.
- Folder `src/`, `scripts/`, dan `test/`.

Yang tidak boleh di-commit:

- `.env`
- `ai-modes.json`
- `ai-services.json`
- `session/`
- `auth_info_baileys*/`
- `browser-profile/`
- `browser-profile-gemini/`
- `backups/`
- `node_modules/`

Sebelum push:

```bash
git status
git diff --cached --name-only
```
