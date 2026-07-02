import 'dotenv/config'
import { serve } from '@hono/node-server'
import app from './src/index.ts'

serve({
  fetch: app.fetch,
  port: 8787,
  hostname: '0.0.0.0'
}, (info) => {
  console.log(`Server Hono berjalan di http://localhost:${info.port}`)
})
