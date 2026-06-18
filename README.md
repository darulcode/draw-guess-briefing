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

1. Buka `/admin`, isi nama sesi, ronde, dan durasi.
2. Bagikan QR atau Room ID dari dashboard host.
3. Buka projector melalui tombol **Buka Projector**.
4. Pilih penggambar dan kata, lalu mulai ronde.
5. Setelah hasil tampil, klik **Ronde Berikutnya**. Pada ronde terakhir tombol ini menampilkan podium final.

Token host dan sesi pemain disimpan di `localStorage`. Dashboard host hanya dapat dikendalikan dari browser pembuat room. Data game tersimpan di `data/db.json`.

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
- Tombol **Skip** membatalkan seluruh poin ronde tersebut. Tombol **Stop** mempertahankan poin dan menghitung bonus penggambar.
