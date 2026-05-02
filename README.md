# WhatsApp AI Browser Bot

Bot WhatsApp yang mengambil jawaban dari AI web lewat browser otomatis. Bot ini memakai WhatsApp via Baileys dan mengontrol halaman Gemini atau ChatGPT lewat Playwright.

Project ini tidak memakai OpenAI API key, Gemini API key, atau model lokal. Semua jawaban diambil dari akun Gemini/ChatGPT yang sudah login di browser profile server.

## Status Implementasi

- WhatsApp bot via Baileys.
- AI browser: Gemini dan ChatGPT.
- Switch Gemini/ChatGPT per chat dari WhatsApp.
- Default AI browser disimpan lintas restart di `ai-services.json`.
- Mode jawaban per chat disimpan di `ai-modes.json`.
- Browser profile Gemini dan ChatGPT dipisah agar tidak bentrok.
- ChatGPT memakai login manual di browser profile, tanpa import cookie.
- Remote login AI dari HP lewat panel screenshot browser.
- Retry otomatis saat web AI timeout atau selector tidak muncul.
- Backup runtime dan profile AI bisa dibuat lokal, tetapi tidak boleh di-upload ke GitHub.

## Cara Kerja Singkat

1. Bot login ke WhatsApp memakai session Baileys di `AUTH_DIR`, default `./session`.
2. Bot membuka browser AI default, default project ini adalah Gemini.
3. User bertanya lewat WhatsApp.
4. Bot menentukan AI browser untuk chat tersebut:
   - pilihan chat dari `.ai mode gemini` atau `.ai mode chatgpt`, atau
   - default dari `ai-services.json` / `WEB_AI_SERVICE`.
5. Bot memakai profile browser yang sesuai:
   - Gemini: `./browser-profile-gemini`
   - ChatGPT: `./browser-profile`
6. Bot mengetik pertanyaan ke web AI, menunggu jawaban selesai, lalu mengirim balasan ke WhatsApp.

## Requirement

- Node.js 20 atau lebih baru.
- `npm`.
- Chromium Playwright.
- `xvfb` untuk VPS/headless.
- Akun Gemini dan/atau ChatGPT yang bisa login manual.
- Akun WhatsApp untuk pairing bot.
- PM2 opsional, tetapi disarankan untuk production.

## Install Dari Nol

Clone repo:

```bash
git clone https://github.com/fajarsecid/whatsapp-ai-browser-bot.git
cd whatsapp-ai-browser-bot
```

Install dependency:

```bash
npm install
```

Install Chromium Playwright:

```bash
npx playwright install chromium
```

Jika VPS belum punya dependency sistem Chromium:

```bash
npx playwright install-deps chromium
```

Install `xvfb` jika belum ada:

```bash
sudo apt-get update
sudo apt-get install -y xvfb
```

Salin config:

```bash
cp .env.example .env
```

Edit `.env` minimal:

```env
WEB_AI_SERVICE=gemini
AUTH_DIR=./session
USE_PAIRING_CODE=true
PAIRING_PHONE_NUMBER=6281234567890
BROWSER_PROFILE=
GEMINI_BROWSER_PROFILE=./browser-profile-gemini
CHATGPT_BROWSER_PROFILE=./browser-profile
WEB_AI_HEADLESS=false
CHATGPT_USER_AGENT=
```

`PAIRING_PHONE_NUMBER` wajib format internasional tanpa `+`, spasi, atau awalan `0`.

## Konfigurasi

Contoh konfigurasi utama:

```env
# AI default saat bot start: gemini atau chatgpt.
WEB_AI_SERVICE=gemini

# WhatsApp/Baileys session.
AUTH_DIR=./session
USE_PAIRING_CODE=true
PAIRING_PHONE_NUMBER=6281234567890

# Browser profile.
# Kosongkan BROWSER_PROFILE agar bot memakai profile otomatis per service.
BROWSER_PROFILE=
GEMINI_BROWSER_PROFILE=./browser-profile-gemini
CHATGPT_BROWSER_PROFILE=./browser-profile
BROWSER_USER_AGENT=
WEB_AI_HEADLESS=false

# Mode jawaban default: auto, instant, thinking, atau pro.
AI_MODE=auto
AI_MODE_FILE=./ai-modes.json
AI_SERVICE_FILE=./ai-services.json

# Remote login panel.
REMOTE_LOGIN_HOST=0.0.0.0
REMOTE_LOGIN_PORT=8787
REMOTE_LOGIN_TOKEN=
REMOTE_LOGIN_PUBLIC_URL=

# ChatGPT browser options.
CHATGPT_USER_AGENT=
CHATGPT_HEADLESS=false

# Browser session behavior.
WEB_AI_SESSION_IDLE_MS=300000
WEB_AI_MAX_ATTEMPTS=2
MAX_QUEUE_PER_CHAT=2

# Deteksi jawaban selesai.
ANSWER_STABLE_INTERVAL_MS=300
ANSWER_STABLE_CHECKS=2
LOG_LEVEL=silent
```

Catatan profile browser:

- `GEMINI_BROWSER_PROFILE` dan `CHATGPT_BROWSER_PROFILE` adalah pilihan utama.
- `BROWSER_PROFILE` adalah opsi lama. Kosongkan untuk bot yang bisa switch Gemini/ChatGPT.
- Jangan pakai profile yang sama untuk Gemini dan ChatGPT.
- Jangan buka profile yang sama dari dua proses Chromium sekaligus.
- Jika muncul `ProcessSingleton` atau `SingletonLock`, ada proses browser lain yang masih memakai profile itu, atau lock lama tertinggal setelah crash.

## Login WhatsApp

Start bot:

```bash
npm run start:gemini
```

Jika `session/` belum ada, bot menampilkan pairing code:

```text
Pairing code: ABCD-1234
```

Buka WhatsApp di HP:

```text
WhatsApp -> Perangkat tertaut -> Tautkan perangkat -> Tautkan dengan nomor telepon
```

Masukkan pairing code. Setelah berhasil, session tersimpan di `./session`.

## Ganti Akun WhatsApp

Jangan hapus session lama tanpa backup. Langkah aman:

```bash
pm2 stop whatsapp-ai-bot-gemini
mkdir -p backups
stamp=$(date -u +%Y%m%d-%H%M%S)
tar -czf backups/wa-session-before-switch-$stamp.tar.gz session
mv session backups/session-before-switch-$stamp
mkdir session
```

Edit `.env`:

```env
PAIRING_PHONE_NUMBER=628xxxxxxxxxx
```

Start lagi:

```bash
pm2 start whatsapp-ai-bot-gemini --update-env
```

Lihat pairing code:

```bash
pm2 logs whatsapp-ai-bot-gemini --lines 80 --nostream
```

Setelah akun baru tersambung, log akan berisi:

```text
WhatsApp bot ready: 628xxxxxxxxxx:1@s.whatsapp.net
```

## Login Gemini Dan ChatGPT

Bot perlu browser profile yang sudah login. Login dilakukan sekali per AI browser.

### Login Lokal

Jika server punya GUI:

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

Penting:

- Jangan pakai `http://IP-VPS:8787` untuk ChatGPT kalau gagal.
- Pakai domain HTTPS/tunnel yang mengarah ke port `8787`.
- Jangan jalankan bot yang sedang memakai profile AI yang sama saat remote login.
- Tekan `Done` di panel hanya setelah halaman chat AI benar-benar terbuka.

### Remote Login Dengan `localhost.run` / `lhr.life`

Terminal pertama:

```bash
npm run remote-login:chatgpt
```

Catat token yang muncul, contoh:

```text
http://127.0.0.1:8787/?token=TOKEN_LOGIN
```

Terminal kedua, buat tunnel HTTPS:

```bash
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/tmp/known_hosts_localhost_run -R 80:127.0.0.1:8787 nokey@localhost.run
```

Command itu akan menampilkan domain seperti:

```text
abc123example.lhr.life tunneled with tls termination, https://abc123example.lhr.life
```

Buka dari HP:

```text
https://abc123example.lhr.life/?token=TOKEN_LOGIN
```

Login sampai halaman ChatGPT/Gemini chat terbuka, lalu tekan `Done` di panel. Setelah selesai, stop tunnel dengan `Ctrl+C`.

### ChatGPT Tanpa Cookie

Project ini tidak lagi memakai import cookie ChatGPT.

Yang dipakai:

- `browser-profile/`
- login manual ChatGPT
- session browser yang tersimpan di profile tersebut

Jika ChatGPT tertahan di `Just a moment...`, buka remote-login lewat domain HTTPS dan tunggu/verifikasi sampai halaman ChatGPT terbuka.

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

Restart setelah update kode atau `.env`:

```bash
pm2 restart whatsapp-ai-bot-gemini --update-env
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

Cek status:

```text
.ai status
```

Status menampilkan:

- AI browser chat ini.
- Default AI browser.
- Mode chat ini.
- Status browser AI.
- Jumlah session aktif.
- Antrean chat ini.
- Antrean total.
- Jumlah retry otomatis.

Switch AI untuk chat saat ini:

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

Pilihan AI browser disimpan di `ai-services.json`, jadi tetap berlaku setelah restart.

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
- `pro`: diarahkan ke `thinking`.

Catatan: nama model/mode ChatGPT di prompt adalah instruksi gaya jawaban untuk UI ChatGPT. Jika UI model switcher tidak tersedia, bot tetap lanjut lewat instruksi prompt.

## Antrean Dan Retry

`MAX_QUEUE_PER_CHAT` membatasi jumlah pesan yang boleh menunggu per chat.

```env
MAX_QUEUE_PER_CHAT=2
```

Jika chat mengirim terlalu banyak pertanyaan saat bot masih memproses, bot akan membalas bahwa antrean chat penuh.

`WEB_AI_MAX_ATTEMPTS` mengatur retry saat AI web timeout atau selector tidak muncul.

```env
WEB_AI_MAX_ATTEMPTS=2
```

Saat retry, bot mengirim pesan bahwa browser AI lambat atau macet, lalu reload browser AI tersebut dan mencoba lagi.

`WEB_AI_SESSION_IDLE_MS` mengatur berapa lama session page AI dibiarkan idle sebelum ditutup.

```env
WEB_AI_SESSION_IDLE_MS=300000
```

## File Runtime

File/folder yang dibuat saat bot berjalan:

- `session/`: session WhatsApp Baileys.
- `browser-profile-gemini/`: login Gemini.
- `browser-profile/`: login ChatGPT.
- `ai-modes.json`: mode jawaban per chat.
- `ai-services.json`: pilihan Gemini/ChatGPT per chat dan default.
- `backups/`: backup lokal manual.

File tersebut sensitif dan sudah di-ignore dari Git.

## Cek Session AI

Cek Gemini:

```bash
npm run check:gemini:xvfb
```

Cek ChatGPT:

```bash
npm run check:chatgpt:xvfb
```

Output ChatGPT yang sehat biasanya memuat:

```json
{
  "title": "ChatGPT",
  "promptTextarea": true,
  "cloudflareGate": false
}
```

Jika `cloudflareGate: true` atau title `Just a moment...`, lakukan login ulang ChatGPT lewat domain HTTPS/tunnel.

## Test Dan Validasi

Jalankan test bawaan:

```bash
npm test
```

Check syntax file utama:

```bash
node --check index.js
```

## Backup Dan Restore

Backup lengkap runtime lokal:

```bash
mkdir -p backups
tar --exclude=./node_modules --exclude=./backups --exclude=./.git-data -czf backups/ai-backup-$(date -u +%Y%m%d-%H%M%S).tgz .
```

Backup session WhatsApp saja:

```bash
tar -czf backups/wa-session-$(date -u +%Y%m%d-%H%M%S).tar.gz session
```

Backup profile AI saja:

```bash
tar -czf backups/ai-browser-profiles-$(date -u +%Y%m%d-%H%M%S).tar.gz browser-profile browser-profile-gemini
```

Sebelum restore profile/session, stop bot:

```bash
pm2 stop whatsapp-ai-bot-gemini
```

Jangan upload backup ke GitHub karena berisi session login.

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

Penyebab umum:

- Security verification belum lewat.
- Profile ChatGPT lama/expired.
- Remote login dibuka lewat IP/HTTP, bukan HTTPS domain.
- User-agent berubah drastis dari session login sebelumnya.

Solusi:

1. Stop bot agar `browser-profile/` tidak terkunci.
2. Jalankan `npm run remote-login:chatgpt`.
3. Buat tunnel HTTPS, misalnya `localhost.run`.
4. Login sampai halaman ChatGPT chat terbuka.
5. Tekan `Done`.
6. Jalankan `npm run check:chatgpt:xvfb`.
7. Start/restart bot.

### Error `ProcessSingleton` Atau `SingletonLock`

Artinya profile browser sedang dipakai proses Chromium lain, atau lock lama tertinggal.

Cek proses:

```bash
pgrep -af "chrome.*browser-profile|node index.js|remote-login"
```

Stop proses yang memakai profile, lalu hapus lock stale jika tidak ada proses aktif:

```bash
rm -f browser-profile/SingletonLock browser-profile/SingletonSocket browser-profile/SingletonCookie
rm -f browser-profile-gemini/SingletonLock browser-profile-gemini/SingletonSocket browser-profile-gemini/SingletonCookie
```

Jangan hapus lock saat browser masih aktif.

### Remote Login Tidak Bisa Dibuka Dari HP

Pastikan:

- Script remote login masih berjalan.
- URL membawa query `?token=...`.
- Domain HTTPS mengarah ke port `8787`.
- Jika memakai `localhost.run`, domain yang dipakai adalah domain yang baru muncul di terminal.
- Domain lama seperti `xxxx.lhr.life` bisa mati kapan saja.

### Mode Atau AI Tidak Sesuai

Cek dari WhatsApp:

```text
.ai status
```

Cek log:

```bash
pm2 logs whatsapp-ai-bot-gemini --lines 50 --nostream
```

Reset pilihan chat ke default:

```text
.ai mode default
```

### Bersihkan Session

Hanya lakukan jika memang ingin login ulang.

WhatsApp:

```bash
pm2 stop whatsapp-ai-bot-gemini
mv session session.backup
mkdir session
pm2 start whatsapp-ai-bot-gemini --update-env
```

Gemini:

```bash
pm2 stop whatsapp-ai-bot-gemini
mv browser-profile-gemini browser-profile-gemini.backup
npm run remote-login:gemini
pm2 start whatsapp-ai-bot-gemini --update-env
```

ChatGPT:

```bash
pm2 stop whatsapp-ai-bot-gemini
mv browser-profile browser-profile.backup
npm run remote-login:chatgpt
pm2 start whatsapp-ai-bot-gemini --update-env
```

## Publish Ke GitHub

Yang aman di-commit:

- Source code.
- `package.json`.
- `package-lock.json`.
- `.env.example`.
- `.gitignore`.
- `README.md`.
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
npm test
git status
git diff --cached --name-only
```

Commit dan push:

```bash
git add README.md src scripts test package.json package-lock.json .env.example .gitignore index.js login.js
git commit -m "Update documentation"
git push origin main
```
