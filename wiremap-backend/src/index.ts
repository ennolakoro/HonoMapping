import { Hono } from 'hono'
import crypto from 'crypto'
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

type Variables = {
  user: any
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()


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
  const validSessions = await db.select()
    .from(sessionTable)
    .innerJoin(userTable, eq(sessionTable.userId, userTable.id))
    .where(eq(sessionTable.token, token))
    
  const validSession = validSessions[0]
    
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
    const adminUserResult = await db.insert(userTable).values({
      id: 'admin-id-1',
      name: 'Admin User',
      email: 'admin@wiremap.local',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date()
    }).onConflictDoUpdate({
      target: userTable.email,
      set: { updatedAt: new Date() }
    }).returning()
    
    const adminUser = adminUserResult[0]
    
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
import { createInformResponse, createGetParameterValues, createGetParameterNames, parseInform, parseGetParameterValuesResponse } from './cwmp'
import { clients, settings } from './db/schema'

// Global state sederhana untuk tracking CWMP session (karena single-user Mini ACS)
let waitingForEmptyPost = false;
let currentModemSN = '';
let currentCwmpId = '';
let currentCwmpNamespace = '';
let currentParamsToRequest: string[] = [];
let currentTriggeredClientId: number | null = null;
let gponFaultRetried = false; // Tandai sudah retry tanpa GPON param

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
      gponFaultRetried = false; // Reset retry flag untuk sesi baru
      waitingForEmptyPost = true; // Tandai bahwa kita menunggu empty POST
      
      // Deteksi vendor berdasarkan OUI
      const isHuawei = informData.OUI === '00259E' || (informData.OUI && informData.OUI.toUpperCase().includes('HW'));
      const isZte = informData.OUI === '00200A' || (informData.OUI && informData.OUI.toUpperCase().includes('ZTE'));
      
      // Minta parameter satu per satu per vendor - hindari 9005 karena request batched
      if (isHuawei) {
        currentParamsToRequest = [
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.Status',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MaxBitRate',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.2.Status',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.2.MaxBitRate',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.3.Status',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.3.MaxBitRate',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.4.Status',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.4.MaxBitRate',
          'InternetGatewayDevice.DeviceInfo.Manufacturer',
          'InternetGatewayDevice.DeviceInfo.ModelName',
          'InternetGatewayDevice.DeviceInfo.HardwareVersion',
          'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
          'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower',
          'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.TXPower',
          'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.TransceiverTemperature',
          'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.SupplyVoltage',
        ];
      } else if (isZte) {
        currentParamsToRequest = [
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.PreSharedKey',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.Status',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MaxBitRate',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.2.Status',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.2.MaxBitRate',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.3.Status',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.3.MaxBitRate',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.4.Status',
          'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.4.MaxBitRate',
          'InternetGatewayDevice.DeviceInfo.Manufacturer',
          'InternetGatewayDevice.DeviceInfo.ModelName',
          'InternetGatewayDevice.DeviceInfo.HardwareVersion',
          'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.RxOpticalPower',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.TxOpticalPower',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.Temperature',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.SupplyVoltage',
        ];
      } else {
        // Unknown vendor - minta SSID/Password saja
        currentParamsToRequest = [
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey',
        ];
      }
      
      try {
        await db.update(clients)
          .set({
            isOnline: true,
            brand: informData.manufacturer || undefined,
            modelName: informData.modelName || undefined,
            hardwareVersion: informData.hardwareVersion || undefined,
            softwareVersion: informData.softwareVersion || undefined
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

  // Hapus Handler GetParameterNamesResponse karena discovery sudah selesai
  
  if (bodyText.includes('GetParameterValuesResponse')) {
    // 1. Terima jawaban dari modem (WLAN/LAN/SSID)
    const params = parseGetParameterValuesResponse(bodyText)
    console.log("Mini ACS Menerima Parameter Modem:", params)
    
    // 2. Simpan ke database
    if (currentModemSN) {
      try {
        const modemParams = {
          snModem: currentModemSN || undefined,
          wifiSsid: params.ssid ?? null,
          wifiPassword: params.password ?? null,
          wifiSsid5g: params.ssid5g ?? null,
          wifiPassword5g: params.password5g ?? null,
          lanStatus: params.lanStatus ?? null,
          associatedDevices: params.associatedDevices ?? null,
          brand: params.brand ?? null,
          modelName: params.modelName ?? null,
          hardwareVersion: params.hardwareVersion ?? null,
          softwareVersion: params.softwareVersion ?? null,
          macAddress: params.macAddress ?? null,
          wanIp: params.wanIp ?? null,
          rxPower: params.rxPower ?? null,
          txPower: params.txPower ?? null,
          temperature: params.temperature ?? null,
          voltage: params.voltage ?? null
        }

        let updatedRows: { id: number }[] = []
        if (currentTriggeredClientId) {
          updatedRows = await db.update(clients)
            .set(modemParams)
            .where(eq(clients.id, currentTriggeredClientId))
            .returning({ id: clients.id })
        }

        if (updatedRows.length === 0) {
          updatedRows = await db.update(clients)
            .set(modemParams)
            .where(eq(clients.snModem, currentModemSN))
            .returning({ id: clients.id })
        }

        if (updatedRows.length === 0) {
          console.warn(`[DB] Tidak ada client yang cocok untuk SN ${currentModemSN}. Data inform diterima tetapi belum masuk ke row client.`)
        } else {
          console.log(`[DB] Data modem ${currentModemSN} berhasil diupdate pada client id ${updatedRows.map(row => row.id).join(', ')}: SSID=${params.ssid}, RxPower=${params.rxPower}, Temp=${params.temperature}, Volt=${params.voltage}`)
        }
      } catch (e) {
        console.error("Gagal update parameter ke DB:", e)
      }
    }
    
    currentTriggeredClientId = null
    currentModemSN = ''
    waitingForEmptyPost = false
    gponFaultRetried = false

    // Akhiri sesi dengan HTTP 200 kosong (204 tidak didukung @hono/node-server di Node v20)
    return new Response('', { status: 200, headers: { 'Content-Length': '0' } })
  }

  // Jika modem mengirim Fault 9005 (parameter tidak valid)
  if (bodyText.includes('Fault') || bodyText.includes('fault')) {
    const faultCode = (bodyText.match(/<FaultCode>(\d+)<\/FaultCode>/) || [])[1] || '?';
    console.log(`[CWMP] Modem mengirim Fault ${faultCode}`)
    
    // Jika 9005 (invalid param) dan belum pernah retry → coba lagi tanpa parameter GPON
    if (faultCode === '9005' && !gponFaultRetried && currentModemSN) {
      gponFaultRetried = true;
      const baseParams = [
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey',
      ];
      console.log(`[CWMP] Retry tanpa parameter GPON - minta SSID+Password saja`);
      const retryXml = createGetParameterValues(currentCwmpId, currentCwmpNamespace, baseParams);
      return new Response(retryXml, {
        headers: {
          'Content-Type': 'text/xml',
          'Server': 'Hono-MiniACS',
          'Set-Cookie': 'session=1; Path=/; HttpOnly'
        }
      })
    }
    
    // Fault lain atau sudah retry → akhiri sesi
    console.log(`[CWMP] Sesi diakhiri karena Fault.`)
    currentModemSN = ''
    currentTriggeredClientId = null
    waitingForEmptyPost = false
    gponFaultRetried = false
    return new Response('', { status: 200, headers: { 'Content-Length': '0' } })
  }
  
  // Jika format lain atau empty POST di luar sesi
  return new Response('', { status: 200, headers: { 'Content-Length': '0' } })
}

app.post('/cwmp', cwmpHandler)
app.post('/c', cwmpHandler)
app.post('/cw', cwmpHandler)

// Helper untuk membaca environment bindings baik di Cloudflare Workers maupun Node.js (VPS)
async function getEnv(c: any, db: any) {
  const dbSettings: Record<string, string> = {};
  try {
    const rows = await db.select().from(settings);
    rows.forEach((r: any) => {
      dbSettings[r.key] = r.value;
    });
  } catch (e) {
    console.error("Gagal membaca settings dari DB:", e);
  }
  
  const env = c.env || {};
  return {
    MIKROTIK_IP: dbSettings.MIKROTIK_IP || env.MIKROTIK_IP || (typeof process !== 'undefined' ? process.env.MIKROTIK_IP : ''),
    MIKROTIK_USER: dbSettings.MIKROTIK_USER || env.MIKROTIK_USER || (typeof process !== 'undefined' ? process.env.MIKROTIK_USER : ''),
    MIKROTIK_PASS: dbSettings.MIKROTIK_PASS || env.MIKROTIK_PASS || (typeof process !== 'undefined' ? process.env.MIKROTIK_PASS : ''),
    MIKROTIK_BRIDGE_URL: dbSettings.MIKROTIK_BRIDGE_URL || env.MIKROTIK_BRIDGE_URL || (typeof process !== 'undefined' ? process.env.MIKROTIK_BRIDGE_URL : '')
  };
}

// Endpoint untuk Vue 3 (Memicu Modem secara Real-time)
app.post('/api/protected/modem/:ip/sync', async (c) => {
  const modemIp = c.req.param('ip')
  const db = getDb(c.env)
  const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = await getEnv(c, db)
  
  try {
    let body: any = {}
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }
    const pseudoDeviceId = body?.deviceId ? parseInt(body.deviceId, 10) : null
    currentTriggeredClientId = pseudoDeviceId && pseudoDeviceId >= 1000000 ? pseudoDeviceId - 1000000 : null

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
    wifiSsid5g: client.wifiSsid5g,
    wifiPassword5g: client.wifiPassword5g,
    lanStatus: client.lanStatus,
    associatedDevices: client.associatedDevices,
    brand: client.brand,
    modelName: client.modelName,
    hardwareVersion: client.hardwareVersion,
    softwareVersion: client.softwareVersion,
    macAddress: client.macAddress,
    wanIp: client.wanIp,
    rxPower: client.rxPower,
    txPower: client.txPower,
    temperature: client.temperature,
    voltage: client.voltage,
    isOnline: client.isOnline
  }))

  return c.json([...allDevices, ...mappedClients])
})

// Endpoint Mikrotik Real-Time
app.get('/api/protected/mikrotik/pppoe-status', async (c) => {
  try {
    const db = getDb(c.env)
    const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = await getEnv(c, db)
    
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
    const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = await getEnv(c, db)
    
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

// GET Router Settings
app.get('/api/protected/settings', async (c) => {
  const db = getDb(c.env)
  try {
    const rows = await db.select().from(settings)
    const config: Record<string, string> = {}
    rows.forEach((r: any) => {
      config[r.key] = r.value
    })
    return c.json(config)
  } catch (e: any) {
    return c.json({ error: 'Gagal mengambil konfigurasi', details: e.message }, 500)
  }
})

// POST Router Settings (Save/Update)
app.post('/api/protected/settings', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.json()
  
  try {
    const keys = ['MIKROTIK_IP', 'MIKROTIK_USER', 'MIKROTIK_PASS', 'MIKROTIK_BRIDGE_URL']
    for (const key of keys) {
      if (body[key] !== undefined) {
        await db.insert(settings).values({
          key,
          value: String(body[key])
        }).onConflictDoUpdate({
          target: settings.key,
          set: { value: String(body[key]) }
        })
      }
    }
    return c.json({ success: true, message: 'Konfigurasi Mikrotik berhasil disimpan' })
  } catch (e: any) {
    return c.json({ error: 'Gagal menyimpan konfigurasi', details: e.message }, 500)
  }
})

// POST Update Parent (Edit Jalur Kabel)
app.post('/api/protected/devices/:id/update-parent', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  const body = await c.req.json()
  const parentId = body.parentId ? parseInt(body.parentId, 10) : null
  const type = body.type
  const db = getDb(c.env)
  
  try {
    if (type === 'CLIENT') {
      const dbId = id >= 1000000 ? id - 1000000 : id
      await db.update(clients)
        .set({ odpId: parentId })
        .where(eq(clients.id, dbId))
    } else {
      await db.update(devices)
        .set({ parentId: parentId })
        .where(eq(devices.id, id))
    }
    return c.json({ success: true, message: 'Jalur kabel berhasil diperbarui' })
  } catch (e: any) {
    return c.json({ error: 'Gagal merubah jalur kabel', details: e.message }, 500)
  }
})

// POST Update Device/Client Details
app.post('/api/protected/devices/:id/update', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  const body = await c.req.json()
  const db = getDb(c.env)
  
  try {
    if (body.type === 'CLIENT') {
      const dbId = id >= 1000000 ? id - 1000000 : id
      await db.update(clients)
        .set({
          name: body.name,
          pppoeUsername: body.pppoeUsername || null,
          snModem: body.snModem || null,
          wifiSsid: body.wifiSsid || null,
          wifiPassword: body.wifiPassword || null,
          wifiSsid5g: body.wifiSsid5g || null,
          wifiPassword5g: body.wifiPassword5g || null,
          rxPower: body.rxPower || null,
          lat: body.lat ? parseFloat(body.lat) : null,
          lng: body.lng ? parseFloat(body.lng) : null,
        })
        .where(eq(clients.id, dbId))
    } else {
      await db.update(devices)
        .set({
          name: body.name,
          lat: body.lat ? parseFloat(body.lat) : null,
          lng: body.lng ? parseFloat(body.lng) : null,
          capacity: body.capacity ? parseInt(body.capacity, 10) : null,
          portsCount: body.portsCount ? parseInt(body.portsCount, 10) : null,
        })
        .where(eq(devices.id, id))
    }
    return c.json({ success: true, message: 'Detail perangkat berhasil diperbarui' })
  } catch (e: any) {
    return c.json({ error: 'Gagal memperbarui detail perangkat', details: e.message }, 500)
  }
})

export default app

