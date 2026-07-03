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

import { getPppoeActive, triggerModemCWMP, getDhcpLeases } from './mikrotik'
import { createInformResponse, createGetParameterValues, createGetParameterNames, parseInform, parseGetParameterValuesResponse } from './cwmp'
import { clients, settings } from './db/schema'
// Helper untuk mendapatkan IP client CPE secara akurat secara agnostik platform
const getClientIp = (c: any) => {
  const cfIp = c.req.header('cf-connecting-ip')
  if (cfIp) return cfIp.trim()

  const xForwardedFor = c.req.header('x-forwarded-for')
  if (xForwardedFor) {
    const parts = xForwardedFor.split(',')
    return parts[0].trim()
  }

  const xRealIp = c.req.header('x-real-ip')
  if (xRealIp) return xRealIp.trim()

  // Fallback ke socket remoteAddress (jika ada di node server)
  if (c.env?.incoming?.socket?.remoteAddress) {
    return c.env.incoming.socket.remoteAddress
  }
  if (c.req.raw?.socket?.remoteAddress) {
    return c.req.raw.socket.remoteAddress
  }

  return '127.0.0.1'
}

// Global state untuk tracking CWMP session per IP client (multi-session)
interface CwmpSession {
  waitingForEmptyPost: boolean;
  currentModemSN: string;
  currentCwmpId: string;
  currentCwmpNamespace: string;
  currentParamsToRequest: string[];
  currentTriggeredClientId: number | null;
  gponFaultRetried: boolean;
  updatedAt: number;
}

const cwmpSessions = new Map<string, CwmpSession>();

interface SyncProgress {
  id: number | null;
  username: string;
  progress: number;
  status: 'idle' | 'triggered' | 'connected' | 'fetching' | 'success' | 'failed';
  error?: string | null;
  updatedAt: number;
}

const syncProgress = new Map<string, SyncProgress>();

// Membersihkan sesi & progress kedaluwarsa secara berkala
const cleanExpiredSessions = () => {
  const now = Date.now()
  for (const [ip, session] of cwmpSessions.entries()) {
    if (now - session.updatedAt > 90000) { // 90 detik timeout
      cwmpSessions.delete(ip)
    }
  }
  for (const [ip, progress] of syncProgress.entries()) {
    const timeout = (progress.status === 'success' || progress.status === 'failed') ? 60000 : 30000
    if (now - progress.updatedAt > timeout) {
      syncProgress.delete(ip)
    }
  }
}

// Endpoint Mini ACS (Terbuka untuk Modem / CPE)
const cwmpHandler = async (c: any) => {
  const bodyText = await c.req.text()
  const db = getDb(c.env)
  const clientIp = getClientIp(c)
  
  cleanExpiredSessions()

  console.log(`\n=============================================================`)
  console.log(`[DEBUG TR-069] Menerima request baru dari IP: ${clientIp}`)
  console.log(`[DEBUG TR-069] Method: ${c.req.method} | URL: ${c.req.url}`)
  console.log(`[DEBUG TR-069] Body Length: ${bodyText.length} karakter`)
  console.log(`=============================================================\n`)

  let session = cwmpSessions.get(clientIp)

  if (bodyText.includes('Inform')) {
    // 1. Terima event Inform dari Modem
    const informData = parseInform(bodyText)
    console.log(`Mini ACS Menerima Inform dari Modem [${clientIp}]:`, informData)
    
    if (informData.SerialNumber) {
      // Cari apakah client dengan serial number ini sudah terdaftar
      const existing = await db.select()
        .from(clients)
        .where(eq(clients.snModem, informData.SerialNumber))
        .limit(1)
      
      let clientId: number | null = null
      let clientName = `ONT-${informData.SerialNumber}`

      if (existing[0]) {
        clientId = existing[0].id
        clientName = existing[0].name
        // Update status online & basic info
        await db.update(clients)
          .set({
            isOnline: true,
            brand: informData.manufacturer || undefined,
            modelName: informData.modelName || undefined,
            hardwareVersion: informData.hardwareVersion || undefined,
            softwareVersion: informData.softwareVersion || undefined,
            wanIp: informData.ipAddress || clientIp
          })
          .where(eq(clients.id, clientId))
      } else {
        // Auto-Discovery: CPE belum terdaftar! Auto insert ke tabel clients!
        const inserted = await db.insert(clients).values({
          name: clientName,
          snModem: informData.SerialNumber,
          wanIp: informData.ipAddress || clientIp,
          isOnline: true,
          brand: informData.manufacturer || null,
          modelName: informData.modelName || null,
          hardwareVersion: informData.hardwareVersion || null,
          softwareVersion: informData.softwareVersion || null,
          lat: null,
          lng: null,
          odpId: null
        }).returning()
        
        clientId = inserted[0].id
        console.log(`[MiniACS] Auto-created client record for unknown Serial Number: ${informData.SerialNumber}`)
      }
      
      const isHuawei = informData.OUI === '00259E' || (informData.OUI && informData.OUI.toUpperCase().includes('HW')) || (informData.manufacturer && informData.manufacturer.toUpperCase().includes('HUA'));
      const isZte = informData.OUI === '00200A' || (informData.OUI && informData.OUI.toUpperCase().includes('ZTE')) || (informData.manufacturer && informData.manufacturer.toUpperCase().includes('ZTE'));
      
      let paramsToReq: string[] = []
      if (isHuawei) {
        paramsToReq = [
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
        paramsToReq = [
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
        paramsToReq = [
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey',
        ];
      }

      session = {
        waitingForEmptyPost: true,
        currentModemSN: informData.SerialNumber,
        currentCwmpId: informData.cwmpId || '',
        currentCwmpNamespace: informData.cwmpNamespace || 'urn:dslforum-org:cwmp-1-0',
        currentParamsToRequest: paramsToReq,
        currentTriggeredClientId: clientId,
        gponFaultRetried: false,
        updatedAt: Date.now()
      }
      cwmpSessions.set(clientIp, session)

      // Set progress tracker status
      const existingProgress = syncProgress.get(clientIp)
      syncProgress.set(clientIp, {
        id: clientId,
        username: existingProgress?.username || clientName,
        progress: 40,
        status: 'connected',
        updatedAt: Date.now()
      })
    }

    const responseXml = createInformResponse(session ? session.currentCwmpId : '', session ? session.currentCwmpNamespace : undefined)
    return new Response(responseXml, {
      headers: {
        'Content-Type': 'text/xml',
        'Server': 'Hono-MiniACS',
        'Set-Cookie': `session=${clientIp}; Path=/; HttpOnly`
      }
    })
  }

  if (session) {
    // Jika modem mengirim body kosong dan kita sedang menunggunya
    if (bodyText.trim() === '' && session.waitingForEmptyPost) {
      console.log(`Menerima Empty POST dari ${clientIp}, mengirim GetParameterValues dengan ID: ${session.currentCwmpId}...`)
      
      session.waitingForEmptyPost = false;
      session.updatedAt = Date.now()
      cwmpSessions.set(clientIp, session)

      // Update progress tracker
      const prog = syncProgress.get(clientIp)
      if (prog) {
        syncProgress.set(clientIp, {
          ...prog,
          progress: 70,
          status: 'fetching',
          updatedAt: Date.now()
        })
      }

      const responseXml = createGetParameterValues(session.currentCwmpId, session.currentCwmpNamespace, session.currentParamsToRequest);
      return new Response(responseXml, {
        headers: {
          'Content-Type': 'text/xml',
          'Server': 'Hono-MiniACS',
          'Set-Cookie': `session=${clientIp}; Path=/; HttpOnly`
        }
      })
    }
    
    if (bodyText.includes('GetParameterValuesResponse')) {
      // 1. Terima jawaban dari modem (WLAN/LAN/SSID)
      const params = parseGetParameterValuesResponse(bodyText)
      console.log(`Mini ACS Menerima Parameter Modem dari [${clientIp}]:`, params)
      
      // 2. Simpan ke database
      if (session.currentModemSN) {
        try {
          const modemParams = {
            snModem: session.currentModemSN || undefined,
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
            wanIp: params.wanIp ?? clientIp ?? null,
            rxPower: params.rxPower ?? null,
            txPower: params.txPower ?? null,
            temperature: params.temperature ?? null,
            voltage: params.voltage ?? null
          }

          let updatedRows: { id: number }[] = []
          if (session.currentTriggeredClientId) {
            updatedRows = await db.update(clients)
              .set(modemParams)
              .where(eq(clients.id, session.currentTriggeredClientId))
              .returning({ id: clients.id })
          }

          if (updatedRows.length === 0) {
            updatedRows = await db.update(clients)
              .set(modemParams)
              .where(eq(clients.snModem, session.currentModemSN))
              .returning({ id: clients.id })
          }

          if (updatedRows.length === 0) {
            console.warn(`[DB] Tidak ada client yang cocok untuk SN ${session.currentModemSN}`)
            const prog = syncProgress.get(clientIp)
            if (prog) {
              syncProgress.set(clientIp, {
                ...prog,
                progress: 100,
                status: 'failed',
                error: 'CPE tidak ditemukan di database',
                updatedAt: Date.now()
              })
            }
          } else {
            console.log(`[DB] Data modem ${session.currentModemSN} berhasil diupdate untuk client id: ${updatedRows.map(r=>r.id).join(',')}`)
            const prog = syncProgress.get(clientIp)
            if (prog) {
              syncProgress.set(clientIp, {
                ...prog,
                progress: 100,
                status: 'success',
                updatedAt: Date.now()
              })
            }
          }
        } catch (e: any) {
          console.error("Gagal update parameter ke DB:", e)
          const prog = syncProgress.get(clientIp)
          if (prog) {
            syncProgress.set(clientIp, {
              ...prog,
              progress: 100,
              status: 'failed',
              error: e.message || 'Gagal menyimpan ke database',
              updatedAt: Date.now()
            })
          }
        }
      }
      
      cwmpSessions.delete(clientIp)
      return new Response('', { status: 200, headers: { 'Content-Length': '0' } })
    }

    // Jika modem mengirim Fault 9005 (parameter tidak valid)
    if (bodyText.includes('Fault') || bodyText.includes('fault')) {
      const faultCode = (bodyText.match(/<FaultCode>(\d+)<\/FaultCode>/) || [])[1] || '?';
      console.log(`[CWMP] Modem ${clientIp} mengirim Fault ${faultCode}`)
      
      if (faultCode === '9005' && !session.gponFaultRetried && session.currentModemSN) {
        session.gponFaultRetried = true;
        session.updatedAt = Date.now()
        cwmpSessions.set(clientIp, session)
        
        const baseParams = [
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey',
        ];
        console.log(`[CWMP] Retry tanpa parameter GPON untuk ${clientIp}`);
        const retryXml = createGetParameterValues(session.currentCwmpId, session.currentCwmpNamespace, baseParams);
        return new Response(retryXml, {
          headers: {
            'Content-Type': 'text/xml',
            'Server': 'Hono-MiniACS',
            'Set-Cookie': `session=${clientIp}; Path=/; HttpOnly`
          }
        })
      }
      
      console.log(`[CWMP] Sesi ${clientIp} diakhiri karena Fault.`)
      const prog = syncProgress.get(clientIp)
      if (prog) {
        syncProgress.set(clientIp, {
          ...prog,
          progress: 100,
          status: 'failed',
          error: `Fault ${faultCode} dari modem`,
          updatedAt: Date.now()
        })
      }
      cwmpSessions.delete(clientIp)
      return new Response('', { status: 200, headers: { 'Content-Length': '0' } })
    }
  }

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

// Endpoint untuk memeriksa progress sinkronisasi modem secara real-time
app.get('/api/protected/modem/sync-status', async (c) => {
  cleanExpiredSessions()
  const data: Record<string, any> = {}
  for (const [ip, progress] of syncProgress.entries()) {
    data[ip] = {
      id: progress.id,
      username: progress.username,
      progress: progress.progress,
      status: progress.status,
      error: progress.error,
      updatedAt: progress.updatedAt
    }
  }
  return c.json(data)
})

// Endpoint untuk Vue 3 (Memicu Modem secara Real-time)
app.post('/api/protected/modem/:ip/sync', async (c) => {
  const modemIp = c.req.param('ip')
  const db = getDb(c.env)
  const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = await getEnv(c, db)
  
  cleanExpiredSessions()

  try {
    let body: any = {}
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }
    const pseudoDeviceId = body?.deviceId ? parseInt(body.deviceId, 10) : null
    const clientId = pseudoDeviceId && pseudoDeviceId >= 1000000 ? pseudoDeviceId - 1000000 : null

    let clientName = `ONT-${modemIp}`
    if (clientId) {
      const client = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1)
      if (client[0]) {
        clientName = client[0].name
      }
    }

    // Set progress awal (10%)
    syncProgress.set(modemIp, {
      id: clientId,
      username: clientName,
      progress: 10,
      status: 'triggered',
      updatedAt: Date.now()
    })

    // Menyuruh Mikrotik "mencolek" modem
    await triggerModemCWMP(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, modemIp, MIKROTIK_BRIDGE_URL)
    return c.json({ message: `Sinyal trigger dikirim ke modem ${modemIp} via Mikrotik Lokal` })
  } catch (err: any) {
    syncProgress.set(modemIp, {
      id: null,
      username: `ONT-${modemIp}`,
      progress: 100,
      status: 'failed',
      error: err.message || 'Gagal mengirim trigger',
      updatedAt: Date.now()
    })
    return c.json({ error: 'Gagal men-trigger modem', details: err.message }, 502)
  }
})

// Endpoint Topologi
app.get('/api/protected/devices', async (c) => {
  try {
    const db = getDb(c.env)
    const allDevices = await db.select().from(devices)
    const allClients = await db.select().from(clients)

    // Mapping client agar kompatibel dengan data topology (node tree map)
    const mappedClients = allClients.map(client => {
      const cType = client.clientType || 'PPPOE'
      // triggerIp: IP yang dipakai untuk trigger CWMP
      // Modem HOTSPOT tidak punya wanIp (PPPoE), pakai lanIp
      const triggerIp = (cType === 'HOTSPOT' || !client.wanIp)
        ? (client.lanIp || client.wanIp)
        : client.wanIp
      return {
        id: client.id + 1000000, // Pseudo-ID agar tidak bentrok dengan ID device
        type: 'CLIENT',
        name: client.name,
        phone: client.phone,
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
        lanIp: client.lanIp,
        clientType: cType,
        triggerIp,
        rxPower: client.rxPower,
        txPower: client.txPower,
        temperature: client.temperature,
        voltage: client.voltage,
        isOnline: client.isOnline,
        cablePath: client.cablePath
      }
    })

    return c.json([...allDevices, ...mappedClients])
  } catch (err: any) {
    console.error('Error fetching topology devices:', err)
    return c.json({ error: 'Gagal mengambil data topologi', details: err.message }, 500)
  }
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
    const lat = body.lat !== undefined && body.lat !== null && body.lat !== '' ? parseFloat(body.lat) : null
    const lng = body.lng !== undefined && body.lng !== null && body.lng !== '' ? parseFloat(body.lng) : null
    
    if (body.type === 'CLIENT') {
      // Masukkan ke tabel clients khusus
      const result = await db.insert(clients).values({
        name: body.nama || body.name,
        phone: body.phone || null,
        odpId: parentId, // Karena induk dari client adalah ODP
        lat,
        lng,
        pppoeUsername: body.pppoeUsername || null,
        snModem: body.snModem || null,
        cablePath: body.cablePath || null
      }).returning()
      return c.json(result[0], 201)
    } else {
      // Masukkan ke tabel devices (OLT/ODC/ODP)
      const portValue = body.jumlahPort ? parseInt(body.jumlahPort, 10) : null
      const capacity = body.type === 'ODC' ? portValue : (body.kapasitas ? parseInt(body.kapasitas, 10) : null)
      const portsCount = body.type === 'ODP' ? portValue : null
      
      const result = await db.insert(devices).values({
        type: body.type,
        name: body.nama || body.name,
        parentId: parentId,
        lat,
        lng,
        capacity: capacity,
        portsCount: portsCount,
        cablePath: body.cablePath || null
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

// Endpoint Auto-Discovery: tarik data PPPoE ke daftar tunggu plotting.
// Sync ini non-destruktif: topology OLT/ODC/ODP dan koordinat client yang sudah diplot tidak dihapus.
// ============================================================
// Endpoint Sync DHCP Leases - Deteksi Modem Non-PPPoE (HOTSPOT)
// Cara kerja:
// 1. Tarik PPPoE active dari Mikrotik (via bridge) → kumpulkan semua MAC
// 2. Tarik DHCP leases dari Mikrotik (via bridge)
// 3. Setiap DHCP lease dicek MAC-nya:
//    - MAC ada di PPPoE → update client PPPoE yang sudah ada, tambahkan lanIp
//    - MAC tidak ada di PPPoE → ini modem HOTSPOT → insert/update sebagai HOTSPOT
// ============================================================
app.post('/api/protected/sync-dhcp-leases', async (c) => {
  try {
    const db = getDb(c.env)
    const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = await getEnv(c, db)

    if (!MIKROTIK_IP || !MIKROTIK_USER || !MIKROTIK_PASS) {
      return c.json({ error: 'Kredensial Mikrotik belum dikonfigurasi' }, 500)
    }

    // === Langkah 1: Kumpulkan semua MAC Address dari PPPoE Active ===
    let pppoeMacs = new Set<string>()
    try {
      const pppoeList = await getPppoeActive(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL)
      for (const p of pppoeList) {
        const mac = (p['caller-id'] || p.callerId || p.macAddress || p.mac || '').toLowerCase().trim()
        if (mac) pppoeMacs.add(mac)
      }
      console.log(`[DHCP Sync] PPPoE MACs terkumpul: ${pppoeMacs.size}`)
    } catch (err) {
      console.warn('[DHCP Sync] Gagal mengambil PPPoE active (lanjut tanpa cross-ref):', err)
    }

    // === Langkah 2: Ambil semua DHCP Leases aktif ===
    const leases = await getDhcpLeases(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL)
    if (!leases || leases.length === 0) {
      return c.json({ message: 'Tidak ada DHCP lease aktif.', total: 0, created: 0, updated: 0, skipped: 0 })
    }

    console.log(`[DHCP Sync] Total DHCP lease aktif: ${leases.length}`)

    let created = 0, updated = 0, skipped = 0

    for (const lease of leases) {
      const mac = (lease['mac-address'] || '').toLowerCase().trim()
      const ip = lease.address
      const hostName = lease['host-name'] || ''
      const serverName = lease.server || ''

      if (!mac || !ip) {
        skipped++
        continue
      }

      // === Langkah 3: Klasifikasi berdasarkan cross-reference MAC vs PPPoE ===
      if (pppoeMacs.has(mac)) {
        // MAC ini milik PPPoE user → update client PPPoE yang sudah ada
        // Cari client dengan MAC atau PPPoE username yang cocok
        const existingByMac = await db.select()
          .from(clients)
          .where(eq(clients.macAddress, mac))
          .limit(1)

        if (existingByMac[0]) {
          // Update lanIp untuk client PPPoE yang sudah ada
          await db.update(clients)
            .set({ lanIp: ip, isOnline: true })
            .where(eq(clients.id, existingByMac[0].id))
          updated++
          console.log(`[DHCP Sync] PPPoE client updated lanIp: ${existingByMac[0].name} → ${ip}`)
        } else {
          // Client PPPoE belum ada entri MAC tapi sudah ada sebagai PPPoE
          skipped++
        }
        continue
      }

      // === MAC tidak ada di PPPoE → ini modem HOTSPOT (non-PPPoE) ===
      const clientName = hostName
        ? hostName.replace(/[^a-zA-Z0-9\-_. ]/g, '').trim()
        : `HOTSPOT-${mac.toUpperCase().replace(/:/g, '').slice(-6)}`

      // Cek apakah sudah ada berdasarkan MAC address
      const existingByMac = await db.select()
        .from(clients)
        .where(eq(clients.macAddress, mac))
        .limit(1)

      if (existingByMac[0]) {
        // Update data yang sudah ada
        await db.update(clients)
          .set({
            lanIp: ip,
            clientType: 'HOTSPOT',
            isOnline: true
          })
          .where(eq(clients.id, existingByMac[0].id))
        updated++
        console.log(`[DHCP Sync] HOTSPOT updated: ${existingByMac[0].name} → ${ip}`)
      } else {
        // Insert client HOTSPOT baru ke antrian
        await db.insert(clients).values({
          name: clientName,
          lanIp: ip,
          macAddress: mac,
          clientType: 'HOTSPOT',
          isOnline: true,
          lat: null,
          lng: null,
          odpId: null
        })
        created++
        console.log(`[DHCP Sync] HOTSPOT baru masuk antrian: ${clientName} (${ip})`)
      }
    }

    return c.json({
      success: true,
      message: `Sync DHCP selesai: ${created} modem hotspot baru, ${updated} diperbarui, ${skipped} di-skip.`,
      total: leases.length,
      created,
      updated,
      skipped
    })
  } catch (err: any) {
    console.error('[DHCP Sync] Error:', err)
    return c.json({ error: 'Gagal sync DHCP lease', details: err.message }, 500)
  }
})

app.post('/api/sync-real-mikrotik', async (c) => {
  return c.json({
    error: 'Endpoint sync lama sudah dipindahkan',
    details: 'Gunakan /api/protected/sync-real-mikrotik melalui frontend yang sudah login, lalu restart backend jika endpoint protected belum tersedia.'
  }, 410)
})

app.post('/api/protected/sync-real-mikrotik', async (c) => {
  try {
    const db = getDb(c.env)
    const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = await getEnv(c, db)
    
    if (!MIKROTIK_IP || !MIKROTIK_USER || !MIKROTIK_PASS) {
      return c.json({ error: 'Kredensial Mikrotik belum dikonfigurasi' }, 500)
    }

    const activeClients = await getPppoeActive(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL)
    if (!activeClients || activeClients.length === 0) {
      return c.json({ error: 'Tidak ada client PPPoE aktif yang ditemukan di Mikrotik.' }, 404)
    }

    let created = 0
    let updated = 0

    for (let i = 0; i < activeClients.length; i++) {
      const pppoe = activeClients[i]
      const username = pppoe.name || pppoe.user || pppoe.username || `Client-${i + 1}`
      const wanIp = pppoe.address || pppoe['remote-address'] || pppoe.remoteAddress || null
      const macAddress = pppoe['caller-id'] || pppoe.callerId || pppoe.macAddress || pppoe.mac || null

      const existing = await db.select()
        .from(clients)
        .where(eq(clients.pppoeUsername, username))
        .limit(1)

      if (existing[0]) {
        await db.update(clients)
          .set({
            wanIp,
            macAddress,
            isOnline: true
          })
          .where(eq(clients.id, existing[0].id))
        updated++
      } else {
        await db.insert(clients).values({
          name: username,
          pppoeUsername: username,
          wanIp,
          macAddress,
          lat: null,
          lng: null,
          odpId: null,
          isOnline: true
        })
        created++
      }
    }

    return c.json({ 
      success: true, 
      message: `Sync selesai: ${created} client baru masuk daftar tunggu, ${updated} client diperbarui.`,
      total: activeClients.length,
      created,
      updated
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
        .set({ 
          odpId: parentId,
          ...(parentId === null ? { cablePath: null } : {})
        })
        .where(eq(clients.id, dbId))
    } else {
      await db.update(devices)
        .set({ 
          parentId: parentId,
          ...(parentId === null ? { cablePath: null } : {})
        })
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
      const clientUpdate: Record<string, any> = {}
      if (body.name !== undefined) clientUpdate.name = body.name
      if (body.phone !== undefined) clientUpdate.phone = body.phone || null
      if (body.pppoeUsername !== undefined) clientUpdate.pppoeUsername = body.pppoeUsername || null
      if (body.snModem !== undefined) clientUpdate.snModem = body.snModem || null
      if (body.wifiSsid !== undefined) clientUpdate.wifiSsid = body.wifiSsid || null
      if (body.wifiPassword !== undefined) clientUpdate.wifiPassword = body.wifiPassword || null
      if (body.wifiSsid5g !== undefined) clientUpdate.wifiSsid5g = body.wifiSsid5g || null
      if (body.wifiPassword5g !== undefined) clientUpdate.wifiPassword5g = body.wifiPassword5g || null
      if (body.rxPower !== undefined) clientUpdate.rxPower = body.rxPower || null
      if (body.txPower !== undefined) clientUpdate.txPower = body.txPower || null
      if (body.temperature !== undefined) clientUpdate.temperature = body.temperature || null
      if (body.voltage !== undefined) clientUpdate.voltage = body.voltage || null
      if (body.wanIp !== undefined) clientUpdate.wanIp = body.wanIp || null
      if (body.macAddress !== undefined) clientUpdate.macAddress = body.macAddress || null
      if (body.lat !== undefined) clientUpdate.lat = body.lat !== null && body.lat !== '' ? parseFloat(body.lat) : null
      if (body.lng !== undefined) clientUpdate.lng = body.lng !== null && body.lng !== '' ? parseFloat(body.lng) : null
      if (body.cablePath !== undefined) clientUpdate.cablePath = body.cablePath || null

      await db.update(clients)
        .set(clientUpdate)
        .where(eq(clients.id, dbId))
    } else {
      await db.update(devices)
        .set({
          name: body.name,
          lat: body.lat ? parseFloat(body.lat) : null,
          lng: body.lng ? parseFloat(body.lng) : null,
          capacity: body.capacity ? parseInt(body.capacity, 10) : null,
          portsCount: body.portsCount ? parseInt(body.portsCount, 10) : null,
          cablePath: body.cablePath !== undefined ? (body.cablePath || null) : undefined
        })
        .where(eq(devices.id, id))
    }
    return c.json({ success: true, message: 'Detail perangkat berhasil diperbarui' })
  } catch (e: any) {
    return c.json({ error: 'Gagal memperbarui detail perangkat', details: e.message }, 500)
  }
})

// DELETE Device/Client
app.delete('/api/protected/devices/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  const db = getDb(c.env)
  let body: any = {}
  try {
    body = await c.req.json()
  } catch {
    body = {}
  }
  const type = body.type

  try {
    if (type === 'CLIENT' || id >= 1000000) {
      const dbId = id >= 1000000 ? id - 1000000 : id
      await db.update(clients)
        .set({ odpId: null, odpPort: null, lat: null, lng: null, cablePath: null })
        .where(eq(clients.id, dbId))
    } else {
      await db.update(devices)
        .set({ parentId: null })
        .where(eq(devices.parentId, id))
      await db.update(clients)
        .set({ odpId: null, odpPort: null, lat: null, lng: null, cablePath: null })
        .where(eq(clients.odpId, id))
      await db.delete(devices).where(eq(devices.id, id))
    }

    return c.json({ success: true, message: 'Perangkat berhasil dihapus' })
  } catch (e: any) {
    return c.json({ error: 'Gagal menghapus perangkat', details: e.message }, 500)
  }
})

export default app

