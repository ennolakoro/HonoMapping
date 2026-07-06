import 'dotenv/config'
import { serve } from '@hono/node-server'
import app from './src/index.ts'

const port = Number(process.env.PORT || 8787)
const hostname = process.env.HOST || '0.0.0.0'

const server = serve({
  fetch: app.fetch,
  port,
  hostname
}, (info) => {
  console.log(`Server Hono berjalan di http://localhost:${info.port}`)
})

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[BOOT] Port ${hostname}:${port} sudah dipakai proses lain. Hentikan proses duplikat atau set PORT berbeda.`)
    process.exit(1)
  }
  console.error('[BOOT] Gagal menjalankan server Hono:', err)
  process.exit(1)
})
