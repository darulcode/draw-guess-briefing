# Draw & Guess Briefing Game

Game menggambar dan menebak realtime untuk briefing pagi. Host membuat room, peserta bergabung lewat QR atau Room ID, lalu bermain dari HP tanpa akun.

## Menjalankan

Persyaratan: Node.js 20 atau lebih baru.

```bash
npm install
npm start
```

Buka `http://localhost:3000`. Server mendengarkan di `0.0.0.0:3000`, sehingga perangkat lain dalam Wi-Fi yang sama dapat membuka alamat IP laptop, misalnya `http://192.168.1.7:3000`.

Jika QR memilih adaptor jaringan yang salah, gunakan `.env.example` sebagai referensi lalu jalankan dengan environment variable yang sesuai:

```powershell
$env:PUBLIC_BASE_URL='http://192.168.1.7:3000'
npm start
```

## Alur Penggunaan

1. Buka `/admin`, isi nama sesi, ronde, durasi, dan mode penggambar.
2. Setelah room dibuat, browser langsung masuk ke layar Host + Projector.
3. Bagikan QR, Room ID, atau salin link dari layar tersebut.
4. Tekan **Start Ronde**. Server mengambil kata dari word bank dan menentukan penggambar sesuai mode room.
5. Setelah setiap ronde, layar menampilkan hasil dan **Leaderboard Terbaru**. Klik **Ronde Berikutnya** untuk melanjutkan; pada ronde terakhir tombol ini menampilkan podium final.

Browser pembuat room menyimpan token host dan langsung menampilkan satu tombol kontrol di pojok kanan atas halaman `/screen/:roomId`. Tombol tersebut bertuliskan **Start Ronde** saat game belum dimulai, disembunyikan ketika ronde berlangsung, lalu berubah menjadi **Ronde Berikutnya** atau **Tampilkan Juara** setelah hasil ronde. Perangkat lain yang membuka URL screen akan melihat tombol **Aktifkan Kontrol Host** dan dapat memasukkan PIN admin room (`1234` secara default). Sebelum PIN benar, perangkat tersebut tetap menjadi projector publik tanpa akses kontrol atau data rahasia. URL lama `/admin/room/:roomId` otomatis dialihkan ke halaman screen terpadu.

### Mode Penggambar

- **Manual**: host menekan Start lalu server memilih satu peserta online secara acak. Jika memungkinkan, penggambar tidak sama dengan ronde sebelumnya.
- **Admin**: peserta dengan username `admin` selalu menjadi penggambar. Username ini wajib memakai PIN room; PIN default adalah `1234`.
- Kata rahasia selalu dipilih otomatis dari `data/words.json` dan tidak diulang sampai seluruh word bank telah digunakan.
- Poin penggambar adalah persentase penebak yang benar dikali 100. Contoh: 2 dari 4 benar menghasilkan 50 poin, dan semua benar menghasilkan 100 poin.

Token host dan sesi pemain disimpan di `localStorage`. Dashboard host hanya dapat dikendalikan dari browser pembuat room. Data runtime tersimpan lokal di `data/db.json` dan tidak ikut Git; server membuat file tersebut otomatis bila belum ada.

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
