# WhatsApp AI Browser Bot

Bot WhatsApp ini mengambil jawaban dari sesi browser AI web yang sudah login. Saat start, bot bisa memakai Gemini atau ChatGPT.

## Flow

1. Jalankan bot dan pilih mode AI browser: Gemini atau ChatGPT.
2. Bot terhubung ke WhatsApp lewat Baileys.
3. User mengirim pesan WhatsApp.
4. Bot membuka sesi browser sesuai mode yang dipilih.
5. Bot mengetik pertanyaan, menunggu jawaban, lalu mengirim hasilnya kembali ke WhatsApp.

Bot ini tidak memakai OpenAI API key, Gemini API key, atau model lokal.

## File Penting

- `index.js`: main WhatsApp bot, queue processor, dan otomasi browser Gemini/ChatGPT.
- `login.js`: helper login manual untuk menyimpan sesi browser.
- `src/chatgpt-cookies.js`: helper import cookie ChatGPT.
- `package.json`: daftar script.

## Install

```bash
npm install
```

## Login AI Browser

Login Gemini:

```bash
npm run login:gemini
```

Login ChatGPT:

```bash
npm run login:chatgpt
```

Profile default Gemini tersimpan di `./browser-profile-gemini`. Profile default ChatGPT tersimpan di `./browser-profile`.

## Import Cookie ChatGPT

Jika sudah punya export cookie ChatGPT, taruh JSON cookie array di `./cookie.js`, lalu jalankan:

```bash
npm run import:cookies
```

`npm start` akan load `./cookie.js` otomatis saat mode ChatGPT dipilih. File ini harus tetap private karena berisi session login.

## Run Bot

Mode interaktif, pilih Gemini atau ChatGPT saat start:

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
WEB_AI_SERVICE=chatgpt npm start
WEB_AI_SERVICE=gemini npm start
```

Di private chat, kirim pertanyaan langsung. Di group, pakai prefix:

```text
.ai tulis ringkasan singkat tentang DNS
```

## Mode Jawaban

Bot juga punya mode kualitas jawaban per chat:

```text
.ai mode
.ai mode cepat
.ai mode penalaran
.ai mode pro
.ai mode instant
.ai mode thinking
.ai mode auto
```

Di Gemini, mode yang dipakai adalah `cepat`, `penalaran`, dan `pro`. Alias `instant` tetap diterima untuk `cepat`, dan `thinking` tetap diterima untuk `penalaran`.

Di ChatGPT, mode yang dipakai hanya `instant` dan `thinking`: `instant` memilih GPT-5.3 Instant, sedangkan `thinking` memilih GPT-5.5 Thinking. Alias Gemini seperti `cepat`, `penalaran`, dan `pro` tetap diterima, tapi `pro` diarahkan ke `thinking` saat ChatGPT aktif.

## Catatan

- Request diproses lewat queue satu per satu.
- Jika sesi AI expired, jalankan lagi `npm run login:gemini` atau `npm run login:chatgpt`.
- Jika ChatGPT berhenti di halaman `Just a moment...`, refresh cookie/login manual ulang sampai halaman chat terbuka.
