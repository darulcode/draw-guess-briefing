# Draw & Guess Briefing Game

Game menggambar dan menebak realtime untuk briefing pagi. Host login untuk membuat room, sedangkan peserta tetap dapat bergabung cepat lewat QR atau Room ID tanpa akun.

## Menjalankan

Persyaratan: Node.js 20 atau lebih baru.

```bash
npm install
npm start
```

Buka `http://localhost:3000`. Server mendengarkan di `0.0.0.0:3000`, sehingga perangkat lain dalam Wi-Fi yang sama dapat membuka alamat IP laptop, misalnya `http://192.168.1.7:3000`.

Login dan signup menggunakan email/password langsung tersedia. Password disimpan sebagai hash dan sesi menggunakan cookie `HttpOnly`.

Jika QR memilih adaptor jaringan yang salah, gunakan `.env.example` sebagai referensi lalu jalankan dengan environment variable yang sesuai:

```powershell
$env:PUBLIC_BASE_URL='http://192.168.1.7:3000'
npm start
```

## Login Google

1. Buka Google Cloud Console dan buat **OAuth client ID** bertipe **Web application**.
2. Tambahkan `http://localhost:3000/auth/google/callback` ke **Authorized redirect URIs**.
3. Salin `.env.example` menjadi `.env`, lalu isi:

```env
GOOGLE_CLIENT_ID=client-id-dari-google
GOOGLE_CLIENT_SECRET=client-secret-dari-google
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
```

4. Restart server. Tombol **Lanjutkan dengan Google** akan aktif otomatis.

Nilai `GOOGLE_CALLBACK_URL` harus sama persis dengan redirect URI di Google Cloud. Untuk deployment publik, gunakan domain HTTPS milik aplikasi. Jangan commit file `.env` atau client secret ke Git.

## Alur Penggunaan

1. Login atau buat akun, lalu buka `/admin` untuk mengisi nama sesi, ronde, durasi, dan mode penggambar.
2. Setelah room dibuat, browser langsung masuk ke layar Host + Projector.
3. Bagikan QR, Room ID, atau salin link dari layar tersebut.
4. Tekan **Start Ronde**. Server mengambil kata dari word bank dan menentukan penggambar sesuai mode room.
5. Setelah setiap ronde, layar menampilkan hasil dan **Leaderboard Terbaru**. Klik **Ronde Berikutnya** untuk melanjutkan; pada ronde terakhir tombol ini menampilkan podium final.

Browser pembuat room menyimpan token host dan langsung menampilkan satu tombol kontrol di pojok kanan atas halaman `/screen/:roomId`. Tombol tersebut bertuliskan **Start Ronde** saat game belum dimulai, disembunyikan ketika ronde berlangsung, lalu berubah menjadi **Ronde Berikutnya** atau **Tampilkan Juara** setelah hasil ronde. **Ronde Berikutnya** langsung menjalankan countdown dan membuka canvas baru tanpa kembali ke tampilan QR. Perangkat lain yang membuka URL screen akan melihat tombol **Aktifkan Kontrol Host** dan dapat memasukkan PIN admin room (`1234` secara default). Sebelum PIN benar, perangkat tersebut tetap menjadi projector publik tanpa akses kontrol atau data rahasia. URL lama `/admin/room/:roomId` otomatis dialihkan ke halaman screen terpadu.

### Mode Penggambar

- **Manual**: host menekan Start lalu server memilih satu peserta online secara acak. Jika memungkinkan, penggambar tidak sama dengan ronde sebelumnya.
- **Admin**: peserta dengan username `admin` selalu menjadi penggambar. Username ini wajib memakai PIN room; PIN default adalah `1234`.
- Kata rahasia selalu dipilih otomatis dari `data/words.json` dan tidak diulang sampai seluruh word bank telah digunakan.
- Poin penggambar adalah persentase penebak yang benar dikali 100. Contoh: 2 dari 4 benar menghasilkan 50 poin, dan semua benar menghasilkan 100 poin.

Token host dan sesi pemain disimpan di `localStorage`. Sesi akun memakai cookie `HttpOnly`, sedangkan password hanya disimpan sebagai hash. Dashboard host hanya dapat dikendalikan dari browser pembuat room. Data akun dan runtime tersimpan lokal di `data/db.json` dan tidak ikut Git; server membuat serta memigrasikan struktur file tersebut otomatis bila belum ada.

## Perintah

```bash
npm start        # server produksi lokal
npm run dev      # restart otomatis saat file berubah
npm test         # unit dan integration test
```

## Catatan Privasi Game

- Kata rahasia hanya dikirim ke socket penggambar.
- Leaderboard tidak dikirim ke pemain atau projector selama ronde aktif.
- Semua event host, pemain, jawaban, dan gambar divalidasi lagi oleh server.
- Ronde berakhir otomatis ketika waktu habis atau semua penebak menjawab benar, lalu host melanjutkan menggunakan satu tombol di pojok kanan atas.
