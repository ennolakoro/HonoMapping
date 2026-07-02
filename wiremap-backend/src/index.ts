import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getDb } from './db'
import { devices, session as sessionTable, user as userTable } from './db/schema'
import { eq } from 'drizzle-orm'

// Environment bindings untuk Cloudflare Workers
type Bindings = {
  TURSO_DATABASE_URL: string
  TURSO_AUTH_TOKEN: string
  MIKROTIK_IP: string
  MIKROTIK_USER: string
  MIKROTIK_PASS: string
  MIKROTIK_BRIDGE_URL?: string
}

const app = new Hono<{ Bindings: Bindings }>()


app.use('*', cors())

app.get('/', (c) => {
  return c.text('WireMap GIS API Server (Hono + Turso) is Running!')
})

// Middleware proteksi endpoint
app.use('/api/protected/*', async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  
  const token = authHeader.split(' ')[1]
  const db = getDb(c.env)
  
  // Verifikasi token dari database
  const validSession = await db.select()
    .from(sessionTable)
    .innerJoin(userTable, eq(sessionTable.userId, userTable.id))
    .where(eq(sessionTable.token, token))
    .get()
    
  if (!validSession) {
    return c.json({ error: 'Invalid or expired session' }, 401)
  }
  
  c.set('user', validSession.user)
  await next()
})

// Endpoint Auth Sederhana (Login/Mock)
app.post('/api/auth/login', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.json()
  
  // Untuk keperluan demo/development:
  if (body.email === 'admin@wiremap.local' && body.password === 'admin123') {
    // Upsert user admin
    const adminUser = await db.insert(userTable).values({
      id: 'admin-id-1',
      name: 'Admin User',
      email: 'admin@wiremap.local',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date()
    }).onConflictDoUpdate({
      target: userTable.email,
      set: { updatedAt: new Date() }
    }).returning().get()
    
    // Create token
    const token = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    
    await db.insert(sessionTable).values({
      id: crypto.randomUUID(),
      userId: adminUser.id,
      token,
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    
    return c.json({ user: adminUser, token })
  }
  
  return c.json({ error: 'Invalid credentials' }, 401)
})

import { getPppoeActive, triggerModemCWMP } from './mikrotik'
import { createInformResponse, createGetParameterValues, parseInform, parseGetParameterValuesResponse } from './cwmp'
import { clients } from './db/schema'

// Global state sederhana untuk tracking CWMP session (karena single-user Mini ACS)
let waitingForEmptyPost = false;
let currentModemSN = '';
let currentCwmpId = '';
let currentCwmpNamespace = '';
let currentParamsToRequest: string[] = [];

// Endpoint Mini ACS (Terbuka untuk Modem / CPE)
const cwmpHandler = async (c: any) => {
  const bodyText = await c.req.text()
  const db = getDb(c.env)
  
  console.log(`\n=============================================================`)
  console.log(`[DEBUG TR-069] Menerima request baru di: ${c.req.url}`)
  console.log(`[DEBUG TR-069] Method: ${c.req.method}`)
  console.log(`[DEBUG TR-069] Headers:`, Object.fromEntries(c.req.raw.headers.entries()))
  console.log(`[DEBUG TR-069] Body Length: ${bodyText.length} karakter`)
  console.log(`[DEBUG TR-069] Body Content:\n${bodyText || '(Body Kosong / Empty POST)'}`)
  console.log(`[DEBUG TR-069] State saat ini -> menungguEmptyPost: ${waitingForEmptyPost}, SN: ${currentModemSN}`)
  console.log(`=============================================================\n`)

  if (bodyText.includes('Inform')) {
    // 1. Terima event Inform dari Modem
    const informData = parseInform(bodyText)
    console.log("Mini ACS Menerima Inform dari Modem:", informData)
    
    // 2. Simpan data awal ke DB jika SN cocok
    if (informData.SerialNumber) {
      currentModemSN = informData.SerialNumber;
      currentCwmpId = informData.cwmpId || '';
      currentCwmpNamespace = informData.cwmpNamespace || 'urn:dslforum-org:cwmp-1-0';
      waitingForEmptyPost = true; // Tandai bahwa kita menunggu empty POST
      
      // Deteksi vendor berdasarkan OUI
      const isHuawei = informData.OUI === '00259E' || (informData.OUI && informData.OUI.toUpperCase().includes('HW'));
      const isZte = informData.OUI === '00200A' || (informData.OUI && informData.OUI.toUpperCase().includes('ZTE'));
      
      currentParamsToRequest = [
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey'
      ];
      
      if (isHuawei) {
        currentParamsToRequest.push('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_HW_GponInterface.RxOpticalPower');
      } else if (isZte) {
        currentParamsToRequest.push('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.RxOpticalPower');
      }
      
      try {
        await db.update(clients)
          .set({
            isOnline: true
          })
          .where(eq(clients.snModem, informData.SerialNumber))
      } catch (e) {
        console.error("Gagal update ACS info ke DB:", e)
      }
    }
    
    // 3. Balas dengan InformResponse agar modem tenang dan Set-Cookie agar sesi tetap hidup
    const responseXml = createInformResponse(informData.cwmpId, informData.cwmpNamespace)
    return new Response(responseXml, {
      headers: {
        'Content-Type': 'text/xml',
        'Server': 'Hono-MiniACS',
        'Set-Cookie': 'session=1; Path=/; HttpOnly'
      }
    })
  }

  // Jika modem mengirim body kosong dan kita sedang menunggunya
  if (bodyText.trim() === '' && waitingForEmptyPost) {
    console.log(`Menerima Empty POST, mengirim GetParameterValues dengan ID: ${currentCwmpId}...`)
    waitingForEmptyPost = false; // Reset agar tidak infinite loop
    const responseXml = createGetParameterValues(currentCwmpId, currentCwmpNamespace, currentParamsToRequest);
    return new Response(responseXml, {
      headers: {
        'Content-Type': 'text/xml',
        'Server': 'Hono-MiniACS',
        'Set-Cookie': 'session=1; Path=/; HttpOnly'
      }
    })
  }
  
  if (bodyText.includes('GetParameterValuesResponse')) {
    // 1. Terima jawaban dari modem (WLAN/LAN/SSID)
    const params = parseGetParameterValuesResponse(bodyText)
    console.log("Mini ACS Menerima Parameter Modem:", params)
    
    // 2. Simpan ke database
    if (currentModemSN) {
      try {
        await db.update(clients)
          .set({
            wifiSsid: params.ssid || undefined,
            wifiPassword: params.password || undefined,
            rxPower: params.rxPower || undefined
          })
          .where(eq(clients.snModem, currentModemSN))
      } catch (e) {
        console.error("Gagal update parameter ke DB:", e)
      }
    }
    
    // Akhiri sesi dengan empty response 204
    return new Response('', { status: 204 }) 
  }
  
  // Jika format lain atau empty POST di luar sesi
  return new Response('', { status: 204 })
}

app.post('/cwmp', cwmpHandler)
app.post('/c', cwmpHandler)
app.post('/cw', cwmpHandler)

// Helper untuk membaca environment bindings baik di Cloudflare Workers maupun Node.js (VPS)
function getEnv(c: any) {
  const env = c.env || {};
  return {
    MIKROTIK_IP: env.MIKROTIK_IP || (typeof process !== 'undefined' ? process.env.MIKROTIK_IP : ''),
    MIKROTIK_USER: env.MIKROTIK_USER || (typeof process !== 'undefined' ? process.env.MIKROTIK_USER : ''),
    MIKROTIK_PASS: env.MIKROTIK_PASS || (typeof process !== 'undefined' ? process.env.MIKROTIK_PASS : ''),
    MIKROTIK_BRIDGE_URL: env.MIKROTIK_BRIDGE_URL || (typeof process !== 'undefined' ? process.env.MIKROTIK_BRIDGE_URL : '')
  };
}

// Endpoint untuk Vue 3 (Memicu Modem secara Real-time)
app.post('/api/protected/modem/:ip/sync', async (c) => {
  const modemIp = c.req.param('ip')
  const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = getEnv(c)
  
  try {
    // Menyuruh Mikrotik "mencolek" modem
    await triggerModemCWMP(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, modemIp, MIKROTIK_BRIDGE_URL)
    return c.json({ message: `Sinyal trigger dikirim ke modem ${modemIp} via Mikrotik Lokal` })
  } catch (err: any) {
    return c.json({ error: 'Gagal men-trigger modem', details: err.message }, 502)
  }
})

// Endpoint Topologi
app.get('/api/protected/devices', async (c) => {
  const db = getDb(c.env)
  const allDevices = await db.select().from(devices)
  const allClients = await db.select().from(clients)

  // Mapping client agar kompatibel dengan data topology (node tree map)
  const mappedClients = allClients.map(client => ({
    id: client.id + 1000000, // Pseudo-ID agar tidak bentrok dengan ID device
    type: 'CLIENT',
    name: client.name,
    parentId: client.odpId,
    lat: client.lat,
    lng: client.lng,
    pppoeUsername: client.pppoeUsername,
    snModem: client.snModem,
    wifiSsid: client.wifiSsid,
    wifiPassword: client.wifiPassword,
    rxPower: client.rxPower,
    isOnline: client.isOnline
  }))

  return c.json([...allDevices, ...mappedClients])
})

// Endpoint Mikrotik Real-Time
app.get('/api/protected/mikrotik/pppoe-status', async (c) => {
  try {
    const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = getEnv(c)
    
    if (!MIKROTIK_IP || !MIKROTIK_USER || !MIKROTIK_PASS) {
      return c.json({ error: 'Kredensial Mikrotik belum dikonfigurasi di server' }, 500)
    }
    
    const activeClients = await getPppoeActive(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL)
    return c.json(activeClients)
  } catch (err: any) {
    return c.json({ error: 'Gagal menghubungi Mikrotik', details: err.message }, 502)
  }
})

app.post('/api/protected/devices', async (c) => {
  try {
    const db = getDb(c.env)
    const body = await c.req.json()
    
    // Konversi string kosong ke null, dan pastikan tipe data sesuai skema
    const parentId = body.induk ? parseInt(body.induk, 10) : null
    
    if (body.type === 'CLIENT') {
      // Masukkan ke tabel clients khusus
      const result = await db.insert(clients).values({
        name: body.nama || body.name,
        odpId: parentId, // Karena induk dari client adalah ODP
        lat: parseFloat(body.lat),
        lng: parseFloat(body.lng),
        pppoeUsername: body.pppoeUsername || null,
        snModem: body.snModem || null
      }).returning()
      return c.json(result[0], 201)
    } else {
      // Masukkan ke tabel devices (OLT/ODC/ODP)
      const capacity = body.kapasitas ? parseInt(body.kapasitas, 10) : null
      const portsCount = body.jumlahPort ? parseInt(body.jumlahPort, 10) : null
      
      const result = await db.insert(devices).values({
        type: body.type,
        name: body.nama || body.name,
        parentId: parentId,
        lat: parseFloat(body.lat),
        lng: parseFloat(body.lng),
        capacity: capacity,
        portsCount: portsCount
      }).returning()
      
      return c.json(result[0], 201)
    }
  } catch (err: any) {
    console.error("Gagal insert device/client:", err)
    return c.json({ error: 'Gagal menyimpan perangkat ke database', details: err.message }, 500)
  }
})

// Mock data endpoint (sebelum login diintegrasikan)
app.get('/api/network-topology', (c) => {
  return c.json([
    { id: 1, type: 'OLT', name: 'OLT-PUSAT' },
    { id: 2, type: 'ODC', name: 'ODC-TES-1', parentId: 1 },
    { id: 3, type: 'ODP', name: 'ODP-TES1/2', parentId: 2 }
  ])
})

// Endpoint Auto-Discovery: Tarik data ASLI dari Mikrotik ke Peta
app.post('/api/sync-real-mikrotik', async (c) => {
  try {
    const db = getDb(c.env)
    const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = getEnv(c)
    
    if (!MIKROTIK_IP || !MIKROTIK_USER || !MIKROTIK_PASS) {
      return c.json({ error: 'Kredensial Mikrotik belum dikonfigurasi di .dev.vars' }, 500)
    }

    // 1. Tarik Data ASLI dari Mikrotik
    const activeClients = await getPppoeActive(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL)
    if (!activeClients || activeClients.length === 0) {
      return c.json({ error: 'Tidak ada client PPPoE aktif yang ditemukan di Mikrotik.' }, 404)
    }

    // 2. Bersihkan DB agar bersih dari dummy
    await db.delete(clients)
    await db.delete(devices)

    // 3. Buat 1 OLT Pusat Utama sebagai Induk
    const centerLat = -7.250445
    const centerLng = 112.768845
    
    const oltResult = await db.insert(devices).values({
      type: 'OLT',
      name: 'OLT Mikrotik (Real)',
      lat: centerLat,
      lng: centerLng,
      capacity: 1024
    }).returning()
    const olt = oltResult[0]

    // 4. Masukkan semua client asli ke database, sebar posisinya melingkar di sekitar OLT
    const radius = 0.005; // radius sebaran peta
    
    for (let i = 0; i < activeClients.length; i++) {
      const pppoe = activeClients[i];
      const angle = (i / activeClients.length) * Math.PI * 2;
      
      await db.insert(clients).values({
        name: pppoe.name || `Client-${i}`,
        odpId: olt.id, // Bypass ODC/ODP sementara, langsung tembak OLT
        lat: centerLat + (Math.sin(angle) * radius),
        lng: centerLng + (Math.cos(angle) * radius),
        pppoeUsername: pppoe.name,
        isOnline: true
      })
    }

    return c.json({ 
      success: true, 
      message: `Berhasil menarik ${activeClients.length} data asli dari Mikrotik dan menyebarkannya di peta!` 
    })
  } catch (err: any) {
    return c.json({ error: 'Gagal auto-sync data asli', details: err.message }, 500)
  }
})

// Endpoint Seeder (Generate Data Otomatis untuk Testing)
app.post('/api/seed', async (c) => {
  try {
    const db = getDb(c.env)
    
    // Hapus semua data yang ada
    await db.delete(clients)
    await db.delete(devices)

    // 1. OLT (Pusat) - Misal di tengah Surabaya
    const olt = (await db.insert(devices).values({
      type: 'OLT',
      name: 'OLT-PUSAT-SBY',
      lat: -7.250445,
      lng: 112.768845,
      capacity: 1024
    }).returning())[0]

    // 2. ODC (Optical Distribution Cabinet)
    const odc1 = (await db.insert(devices).values({
      type: 'ODC',
      name: 'ODC-UTARA',
      parentId: olt.id,
      lat: -7.245000,
      lng: 112.770000,
      capacity: 144
    }).returning())[0]

    const odc2 = (await db.insert(devices).values({
      type: 'ODC',
      name: 'ODC-SELATAN',
      parentId: olt.id,
      lat: -7.258000,
      lng: 112.765000,
      capacity: 144
    }).returning())[0]

    // 3. ODP (Optical Distribution Point)
    const odp1 = (await db.insert(devices).values({
      type: 'ODP',
      name: 'ODP-UTARA-01',
      parentId: odc1.id,
      lat: -7.242000,
      lng: 112.773000,
      portsCount: 8
    }).returning())[0]

    const odp2 = (await db.insert(devices).values({
      type: 'ODP',
      name: 'ODP-SELATAN-01',
      parentId: odc2.id,
      lat: -7.260000,
      lng: 112.762000,
      portsCount: 8
    }).returning())[0]

    // 4. Clients
    await db.insert(clients).values([
      {
        name: 'Client A (Budi)',
        odpId: odp1.id,
        lat: -7.241500,
        lng: 112.774000,
        pppoeUsername: 'budi@mikrotik',
        snModem: 'ZTEGC1234567',
        wifiSsid: 'Budi_Home',
        rxPower: '-22.5',
        isOnline: true
      },
      {
        name: 'Client B (Siti)',
        odpId: odp1.id,
        lat: -7.241000,
        lng: 112.772500,
        pppoeUsername: 'siti@mikrotik',
        snModem: 'HWTC98765432',
        wifiSsid: 'Siti_WIFI',
        rxPower: '-20.1',
        isOnline: true
      },
      {
        name: 'Client C (Agus)',
        odpId: odp2.id,
        lat: -7.262000,
        lng: 112.761000,
        pppoeUsername: 'agus@mikrotik',
        snModem: 'FHTT00001111',
        wifiSsid: 'Agus_Net',
        rxPower: '-26.8', // Redaman tinggi
        isOnline: true
      }
    ])

    return c.json({ success: true, message: "Data dummy berhasil digenerate mengikuti rute kabel OLT -> ODC -> ODP -> Client!" })
  } catch (err: any) {
    return c.json({ error: 'Gagal seeding', details: err.message }, 500)
  }
})

// Endpoint Kosongkan Data Peta
app.post('/api/clear', async (c) => {
  try {
    const db = getDb(c.env)
    await db.delete(clients)
    await db.delete(devices)
    return c.json({ success: true, message: "Semua data perangkat dan client berhasil dihapus dari Peta." })
  } catch (err: any) {
    return c.json({ error: 'Gagal menghapus data', details: err.message }, 500)
  }
})

export default app
