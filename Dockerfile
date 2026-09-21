# Keyway jalan di atas Bun, bukan Node: server/index.ts memakai Bun.serve +
# WebSocket bawaan Bun, dan TS dieksekusi langsung tanpa transpile step.
FROM oven/bun:1.3-slim

WORKDIR /app

# Dependency di-install saat build, bukan diambil dari node_modules host:
# folder host berisi hasil install campuran (ada @esbuild/win32-x64 di sana,
# sisa install dari Windows). docker-compose.yml memasang named volume di
# /app/node_modules supaya hasil install ini tidak tertimpa bind mount source.
#
# devDependencies sengaja ikut: vite dipakai untuk build UI (lihat CMD), jadi
# jangan tambahkan --production di sini.
COPY package.json bun.lock ./
RUN bun install --no-progress

# Source ikut masuk image supaya image bisa jalan sendiri tanpa bind mount.
# Saat runtime file-file ini ditimpa bind mount dari host (lihat compose) —
# Bun menjalankan TS langsung, jadi edit kode di host cukup
# `docker compose restart`, tanpa rebuild.
COPY tsconfig.json ./
COPY shared/ ./shared/
COPY server/ ./server/
COPY ui/ ./ui/

ENV NODE_ENV=production \
    PORT=8788 \
    HOST=0.0.0.0

EXPOSE 8788

# UI di-build saat start, bukan saat build image: ui/dist ada di dalam bind
# mount, jadi hasil build apa pun dari image akan tertutup folder host.
#
# Build jalan kalau ui/dist belum ada ATAU ada file sumber yang lebih baru dari
# ui/dist/index.html — tanpa cek "lebih baru" itu, dist lama (mis. sisa build
# bulan lalu) akan terus disajikan diam-diam padahal ui/src sudah berubah.
# Kalau sumber tidak berubah, start berikutnya instan.
#
# vite.config.ts ada di ui/, bukan di root, makanya build dijalankan dari ui/.
CMD ["sh", "-c", "if [ ! -f ui/dist/index.html ] || [ -n \"$(find ui/src ui/index.html ui/vite.config.ts ui/tailwind.config.js shared -newer ui/dist/index.html -print -quit 2>/dev/null)\" ]; then echo '[docker] ui/dist kosong atau basi -> vite build'; (cd ui && bun x vite build); fi; exec bun server/index.ts"]
