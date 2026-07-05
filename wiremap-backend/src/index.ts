import { Hono } from 'hono'
import crypto from 'crypto'
import { cors } from 'hono/cors'
import { getDb } from './db'
import { devices, session as sessionTable, user as userTable } from './db/schema'
import { eq, and, ne, isNull, sql } from 'drizzle-orm'


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

let lastGarbageCleanupAt = 0
const GARBAGE_CLEANUP_INTERVAL_MS = 60000
let clientInventoryColumnsReady = false


app.use('*', cors())

app.get('/', (c) => {
  return c.text('WireMap GIS API Server (Hono + Turso) is Running!')
})

const ensureClientInventoryColumns = async (db: any) => {
  if (clientInventoryColumnsReady) return
  const columns = [
    ['last_inform_at', 'text'],
    ['wan_config_json', 'text'],
    ['wifi_config_json', 'text'],
    ['admin_username', 'text'],
    ['admin_password', 'text'],
    ['raw_modem_params_json', 'text'],
    ['modem_profile', 'text'],
  ]

  for (const [name, type] of columns) {
    try {
      await db.run(sql.raw(`ALTER TABLE clients ADD COLUMN ${name} ${type}`))
    } catch (err: any) {
      const message = String(err?.message || err)
      if (!/duplicate column|already exists/i.test(message)) {
        console.warn(`[DB] Gagal memastikan kolom clients.${name}: ${message}`)
      }
    }
  }
  clientInventoryColumnsReady = true
}

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

import { getPppoeActive, getPppoeSecrets, triggerModemCWMP, getDhcpLeases } from './mikrotik'
import { buildParameterRequestList, createInformResponse, createGetParameterValues, createSetParameterValues, createGetParameterNames, createAddObject, igdBaseParams, parseInform, parseGetParameterValuesResponse, parseGetParameterNamesResponse, parseHostsFromGetParameterValues, parseAllParameterNamesResponse, filterWanParameterNames, parseAddObjectResponse } from './cwmp'
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

// Cek apakah IP adalah IP Publik (untuk menghindari duplikasi IP NAT)
const isPublicIp = (ip: string): boolean => {
  if (!ip) return false
  const cleanIp = ip.trim()
  if (cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp === 'localhost') return false
  // IP lokal range (RFC 1918)
  if (cleanIp.startsWith('10.')) return false
  if (cleanIp.startsWith('192.168.')) return false
  if (cleanIp.startsWith('172.')) {
    const parts = cleanIp.split('.')
    if (parts.length >= 2) {
      const second = parseInt(parts[1], 10)
      if (second >= 16 && second <= 31) return false
    }
  }
  return true
}

// Bandingkan MAC address dengan toleransi 5 byte pertama (10 karakter)
// Digunakan untuk mencocokkan port PPPoE dan DHCP management di modem yang sama
const isSameDeviceMac = (mac1: string, mac2: string): boolean => {
  if (!mac1 || !mac2) return false
  const clean1 = mac1.toLowerCase().replace(/[^a-f0-9]/g, '')
  const clean2 = mac2.toLowerCase().replace(/[^a-f0-9]/g, '')
  if (clean1.length < 10 || clean2.length < 10) return false
  return clean1.slice(0, 10) === clean2.slice(0, 10)
}

// Fungsi membersihkan data sampah/duplikat dan IP Publik NAT yang tidak valid di DB
const cleanupOldGarbageData = async (db: any) => {
  try {
    const now = Date.now()
    if (now - lastGarbageCleanupAt < GARBAGE_CLEANUP_INTERVAL_MS) {
      return
    }
    lastGarbageCleanupAt = now
    console.log('[Cleanup] Memulai pembersihan IP Publik dan duplikat di DB...')
    
    // 1. Bersihkan IP Publik 36.75.220.32 dari semua data client (set ke null)
    await db.update(clients)
      .set({ wanIp: null })
      .where(eq(clients.wanIp, '36.75.220.32'))
    await db.update(clients)
      .set({ lanIp: null })
      .where(eq(clients.lanIp, '36.75.220.32'))

    // 2. Cari semua record di DB
    const all = await db.select().from(clients)
    
    // 3. Cari duplikat record ONT yang tidak memiliki koordinat (lat/lng kosong)
    // dan tidak memiliki data wifi, tapi kita sudah punya record lain dengan MAC/PPPoE username yang sama
    const toDeleteIds: number[] = []
    
    for (const c of all) {
      if (c.wanIp && isPublicIp(c.wanIp)) {
        await db.update(clients)
          .set({ wanIp: null })
          .where(eq(clients.id, c.id))
      }
      if (c.lanIp && isPublicIp(c.lanIp)) {
        await db.update(clients)
          .set({ lanIp: null })
          .where(eq(clients.id, c.id))
      }

      if (
        c.name.startsWith('ONT-') || c.name.startsWith('MODEM-') || c.clientType === 'HOTSPOT'
      ) {
        // Cek apakah ada record lain yang lebih valid (misalnya record PPPoE dengan MAC yang mirip, atau lanIp/wanIp yang sama)
        const betterDuplicate = all.find((other: any) =>
          other.id !== c.id && 
          (
            (c.snModem && other.snModem === c.snModem) ||
            (c.macAddress && other.macAddress && isSameDeviceMac(c.macAddress, other.macAddress)) ||
            (c.lanIp && other.lanIp && c.lanIp === other.lanIp) ||
            (c.wanIp && other.wanIp && c.wanIp === other.wanIp)
          ) &&
          // Jadikan 'other' sebagai master jika dia adalah akun PPPoE asli
          // ATAU jika 'other' sudah diplot sedangkan 'c' belum
          (other.pppoeUsername || (other.lat !== null && c.lat === null) || (other.clientType === 'PPPOE' && c.clientType !== 'PPPOE'))
        )

        if (betterDuplicate) {
          const merged = stripUndefined({
            snModem: betterDuplicate.snModem || c.snModem || undefined,
            wifiSsid: betterDuplicate.wifiSsid || c.wifiSsid || undefined,
            wifiPassword: betterDuplicate.wifiPassword || c.wifiPassword || undefined,
            wifiSsid5g: betterDuplicate.wifiSsid5g || c.wifiSsid5g || undefined,
            wifiPassword5g: betterDuplicate.wifiPassword5g || c.wifiPassword5g || undefined,
            lanStatus: betterDuplicate.lanStatus || c.lanStatus || undefined,
            associatedDevices: betterDuplicate.associatedDevices ?? c.associatedDevices ?? undefined,
            brand: betterDuplicate.brand || c.brand || undefined,
            modelName: betterDuplicate.modelName || c.modelName || undefined,
            hardwareVersion: betterDuplicate.hardwareVersion || c.hardwareVersion || undefined,
            softwareVersion: betterDuplicate.softwareVersion || c.softwareVersion || undefined,
            macAddress: betterDuplicate.macAddress || c.macAddress || undefined,
            wanIp: (betterDuplicate.wanIp && !isPublicIp(betterDuplicate.wanIp)) ? betterDuplicate.wanIp : (c.wanIp && !isPublicIp(c.wanIp) ? c.wanIp : undefined),
            lanIp: (betterDuplicate.lanIp && !isPublicIp(betterDuplicate.lanIp)) ? betterDuplicate.lanIp : (c.lanIp && !isPublicIp(c.lanIp) ? c.lanIp : undefined),
            rxPower: betterDuplicate.rxPower || c.rxPower || undefined,
            txPower: betterDuplicate.txPower || c.txPower || undefined,
            temperature: betterDuplicate.temperature || c.temperature || undefined,
            voltage: betterDuplicate.voltage || c.voltage || undefined,
            isOnline: betterDuplicate.isOnline || c.isOnline || undefined,
            lat: betterDuplicate.lat !== null ? betterDuplicate.lat : (c.lat !== null ? c.lat : undefined),
            lng: betterDuplicate.lng !== null ? betterDuplicate.lng : (c.lng !== null ? c.lng : undefined),
            odpId: betterDuplicate.odpId !== null ? betterDuplicate.odpId : (c.odpId !== null ? c.odpId : undefined),
            cablePath: betterDuplicate.cablePath || c.cablePath || undefined,
          })
          await db.update(clients)
            .set(merged)
            .where(eq(clients.id, betterDuplicate.id))
          console.log(`[Cleanup] Merge data modem dari ${c.name} ke ${betterDuplicate.name} sebelum hapus duplikat`)
          toDeleteIds.push(c.id)
        }
      }
    }

    if (toDeleteIds.length > 0) {
      console.log(`[Cleanup] Menghapus ${toDeleteIds.length} record duplikat yang tidak valid:`, toDeleteIds)
      for (const id of toDeleteIds) {
        await db.delete(clients).where(eq(clients.id, id))
      }
    }
    console.log('[Cleanup] Pembersihan selesai.')
  } catch (err) {
    console.error('[Cleanup] Gagal membersihkan data sampah:', err)
  }
}

// Global state untuk tracking CWMP session per IP client (multi-session)
interface CwmpSession {
  waitingForEmptyPost: boolean;
  currentModemSN: string;
  currentCwmpId: string;
  currentCwmpNamespace: string;
  currentParamsToRequest: string[];
  currentTriggeredClientId: number | null;
  currentProgressKeys: string[];
  currentClientIp: string | null;
  currentManufacturer: string | null;
  currentModelName: string | null;
  currentHardwareVersion: string | null;
  currentSoftwareVersion: string | null;
  currentModemProfile: string | null;
  currentRequestMode: 'inform' | 'discover-wan' | 'config';
  gponFaultRetried: boolean;
  updatedAt: number;
  // Multi-stage host fetching
  stage: 'params' | 'wan_names' | 'host_names' | 'host_values' | 'done';
  wanNameRoots?: string[];
  wanDiscoveredParams?: string[];
  pendingModemData?: any; // data dari stage 1 sementara disimpan
}

const cwmpSessions = new Map<string, CwmpSession>();

// Map: modem localIP -> connectionRequestUrl (disimpan dari data Inform)
const modemConnectionUrls = new Map<string, string>();

interface PendingConfig {
  clientId: number;
  modemIp: string;
  params: { name: string; value: string; type: string }[];
  status: 'pending' | 'adding' | 'sending' | 'success' | 'failed';
  operation?: 'set' | 'add-wan-ppp';
  addObjectCandidates?: string[];
  addObjectPayload?: any;
  error?: string;
  updatedAt: number;
}
const pendingConfigs = new Map<number, PendingConfig>();

interface SyncProgress {
  id: number | null;
  username: string;
  progress: number;
  status: 'idle' | 'triggered' | 'connected' | 'fetching' | 'success' | 'failed';
  mode?: 'inform' | 'discover-wan' | 'config';
  error?: string | null;
  updatedAt: number;
}

const syncProgress = new Map<string, SyncProgress>();
const ACTIVE_SYNC_TIMEOUT_MS = 120000;
const FINISHED_SYNC_RETENTION_MS = 60000;

const normalizeProgressKeys = (keys: Array<string | null | undefined>) =>
  [...new Set(keys.filter((key): key is string => Boolean(key)))]

const getProgressKeysForClient = (clientId: number | null, keys: Array<string | null | undefined>) => {
  const allKeys = new Set(normalizeProgressKeys(keys))
  if (clientId) {
    for (const [key, progress] of syncProgress.entries()) {
      if (progress.id === clientId) allKeys.add(key)
    }
  }
  return [...allKeys]
}

const getFirstProgress = (keys: string[]) => {
  for (const key of keys) {
    const progress = syncProgress.get(key)
    if (progress) return progress
  }
  return null
}

const setProgressForKeys = (keys: string[], progress: SyncProgress) => {
  for (const key of keys) {
    syncProgress.set(key, { ...progress })
  }
}

const getWanDiscoveryRoots = (profile?: string | null) => {
  const tr181Roots = [
    'Device.PPP.',
    'Device.IP.',
    'Device.Ethernet.VLANTermination.',
    'Device.NAT.',
  ]
  const tr098Roots = ['InternetGatewayDevice.WANDevice.']
  return profile === 'Device'
    ? [...tr181Roots, ...tr098Roots]
    : [...tr098Roots, ...tr181Roots]
}

const requestNextWanNameRoot = (session: CwmpSession) => {
  const nextRoot = session.wanNameRoots?.shift()
  if (!nextRoot) return null
  session.updatedAt = Date.now()
  return createGetParameterNames(session.currentCwmpId, session.currentCwmpNamespace, nextRoot, false)
}

const getWanPppAddObjectCandidates = (profile?: string | null) => {
  const tr098: string[] = []
  for (let wanDevice = 1; wanDevice <= 2; wanDevice++) {
    for (let wanConn = 1; wanConn <= 4; wanConn++) {
      tr098.push(`InternetGatewayDevice.WANDevice.${wanDevice}.WANConnectionDevice.${wanConn}.WANPPPConnection.`)
    }
  }
  const tr181 = [
    'Device.PPP.Interface.',
  ]
  return profile === 'Device' ? [...tr181, ...tr098] : [...tr098, ...tr181]
}

const buildWanPppSetParams = (objectPath: string, instanceNumber: string, payload: any) => {
  const base = `${objectPath}${instanceNumber}.`
  const params: { name: string; value: string; type: string }[] = []
  const push = (field: string, value: any, type = 'string') => {
    const text = String(value ?? '').trim()
    if (text) params.push({ name: `${base}${field}`, value: text, type })
  }

  const isTr181 = objectPath.startsWith('Device.')
  push('Name', payload.connectionName || `INTERNET_VID_${payload.vlanId || 'PPP'}`)
  push('Username', payload.username)
  push('Password', payload.password)
  push('Enable', payload.enable ?? '1', 'boolean')

  if (!isTr181) {
    push('NATEnabled', payload.nat ?? '1', 'boolean')
    push('ServiceList', payload.serviceType || 'INTERNET')
    push('ConnectionType', 'IP_Routed')
    push('X_HW_VLAN', payload.vlanId, 'unsignedInt')
    push('X_ZTE-COM_VLANID', payload.vlanId, 'unsignedInt')
    push('VLANID', payload.vlanId, 'unsignedInt')
  }

  return params
}

const markPendingConfigFailed = (clientId: number | null | undefined, error: string) => {
  if (!clientId) return
  const pendingConfig = pendingConfigs.get(clientId)
  if (!pendingConfig || pendingConfig.status === 'success') return
  pendingConfigs.set(clientId, {
    ...pendingConfig,
    status: 'failed',
    error,
    updatedAt: Date.now()
  })
}

const stripUndefined = (record: Record<string, any>) =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))

const inferModemInfoFromSn = (sn?: string | null) => {
  const normalized = (sn || '').toUpperCase()
  if (!normalized) return {}
  
  if (normalized.startsWith('485754') || normalized.startsWith('HWTC')) {
    return { brand: 'Huawei', modelName: 'EG8145V5' }
  }
  if (normalized.startsWith('5A5445') || normalized.startsWith('ZTEG')) {
    return { brand: 'ZTE', modelName: 'ZTE GPON ONT' }
  }
  if (normalized.startsWith('464854') || normalized.startsWith('FHTT')) {
    return { brand: 'Fiberhome', modelName: 'Fiberhome GPON ONT' }
  }
  if (normalized.startsWith('414C43') || normalized.startsWith('ALCL')) {
    return { brand: 'Nokia/Alcatel', modelName: 'Nokia GPON ONT' }
  }
  if (normalized.startsWith('56534F') || normalized.startsWith('VSOL')) {
    return { brand: 'VSOL', modelName: 'VSOL GPON ONT' }
  }
  if (normalized.startsWith('54504C') || normalized.startsWith('TPLG')) {
    return { brand: 'TP-Link', modelName: 'TP-Link GPON ONT' }
  }
  
  return {}
}

// Membersihkan sesi & progress kedaluwarsa secara berkala
const cleanExpiredSessions = () => {
  const now = Date.now()
  for (const [ip, session] of cwmpSessions.entries()) {
    if (now - session.updatedAt > 90000) { // 90 detik timeout
      cwmpSessions.delete(ip)
    }
  }
  for (const [ip, progress] of syncProgress.entries()) {
    const isConfigPush = Boolean(progress.id && pendingConfigs.has(progress.id))
    const isDiscovery = progress.mode === 'discover-wan'
    const isClientInform = progress.mode === 'inform' && Boolean(progress.id)
    let timeout = ACTIVE_SYNC_TIMEOUT_MS
    if (progress.status === 'success' || progress.status === 'failed') {
      timeout = FINISHED_SYNC_RETENTION_MS
    } else if (progress.status === 'triggered') {
      timeout = (isConfigPush || isDiscovery || isClientInform) ? ACTIVE_SYNC_TIMEOUT_MS : 15000
    } else if (progress.status === 'connected' || progress.status === 'fetching') {
      timeout = (isConfigPush || isDiscovery || isClientInform) ? ACTIVE_SYNC_TIMEOUT_MS : 30000
    }

    if (now - progress.updatedAt > timeout) {
      if (progress.status === 'triggered' || progress.status === 'connected' || progress.status === 'fetching') {
        console.warn(`[SYNC] Timeout menunggu Inform untuk ${ip} (${progress.username}) status=${progress.status}`)
        let errorMsg = 'Timeout menunggu modem mengirim Inform. Pastikan CPE online.'
        if (isConfigPush) {
          errorMsg = 'Timeout menunggu modem target mengirim Inform untuk menerapkan konfigurasi. Pastikan IP management modem bisa diakses dari Mikrotik/bridge dan ConnectionRequestURL benar.'
        } else if (isDiscovery) {
          errorMsg = 'Discovery WAN masuk antrian, tetapi modem belum mengirim Inform. Data akan diperbarui otomatis saat Inform berikutnya masuk.'
        } else if (isClientInform) {
          errorMsg = 'Inform masuk antrian, tetapi modem belum mengirim data terbaru. Data akan diperbarui otomatis saat Inform berikutnya masuk.'
        } else if (progress.status === 'triggered') {
          errorMsg = 'Modem tidak merespon colek (Connection Request) dalam 15 detik. Pastikan IP management dapat di-ping dari Mikrotik.'
        }
        syncProgress.set(ip, {
          ...progress,
          progress: 100,
          status: 'failed',
          error: errorMsg,
          updatedAt: now
        })
        markPendingConfigFailed(progress.id, errorMsg)
      } else {
        syncProgress.delete(ip)
      }
    }
  }

  for (const [clientId, pendingConfig] of pendingConfigs.entries()) {
    const elapsed = now - pendingConfig.updatedAt
    if ((pendingConfig.status === 'pending' || pendingConfig.status === 'sending') && elapsed > ACTIVE_SYNC_TIMEOUT_MS) {
      pendingConfigs.set(clientId, {
        ...pendingConfig,
        status: 'failed',
        error: 'Timeout menunggu modem target mengirim Inform untuk menerapkan konfigurasi.',
        updatedAt: now
      })
    } else if ((pendingConfig.status === 'success' || pendingConfig.status === 'failed') && elapsed > FINISHED_SYNC_RETENTION_MS) {
      pendingConfigs.delete(clientId)
    }
  }
}

const saveModemDataToDb = async (c: any, db: any, session: CwmpSession, params: any, clientIp: string) => {
  if (session.currentModemSN) {
    try {
      await ensureClientInventoryColumns(db)
      let hosts = params.connectedHosts || []
      
      // Jika ada host terhubung, coba cross-ref dengan DHCP Leases Mikrotik untuk mendapatkan IP Hotspot / Hostname
      if (hosts.length > 0) {
        try {
          const env = await getEnv(c, db).catch(() => ({} as any))
          const MIKROTIK_IP = env.MIKROTIK_IP
          const MIKROTIK_USER = env.MIKROTIK_USER
          const MIKROTIK_PASS = env.MIKROTIK_PASS
          const MIKROTIK_BRIDGE_URL = env.MIKROTIK_BRIDGE_URL

          if (MIKROTIK_IP) {
            console.log(`[DB SAVE] Mencoba mencocokkan ${hosts.length} MAC WiFi dengan DHCP leases Mikrotik...`)
            const leases = await getDhcpLeases(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL).catch(() => [])
            console.log(`[DB SAVE] DHCP leases ditarik dari Mikrotik: ${leases.length}`)
            
            hosts = hosts.map((h: any) => {
              const normalizedMac = (h.mac || '').toLowerCase().replace(/[^a-f0-9]/g, '')
              const lease = leases.find((l: any) => {
                const leaseMac = (l['mac-address'] || '').toLowerCase().replace(/[^a-f0-9]/g, '')
                return leaseMac === normalizedMac
              })
              if (lease) {
                return {
                  ...h,
                  ip: lease.address || h.ip,
                  hostname: lease['host-name'] || h.hostname || 'WiFi Client',
                  active: true
                }
              }
              return h
            })
          }
        } catch (err: any) {
          console.error('[DB SAVE] Gagal cross-ref MAC WiFi ke Mikrotik DHCP leases:', err)
        }
      }

      const modemParams = stripUndefined({
        snModem: session.currentModemSN || undefined,
        wifiSsid: params.ssid ?? undefined,
        wifiPassword: params.password ?? undefined,
        wifiSsid5g: params.ssid5g ?? undefined,
        wifiPassword5g: params.password5g ?? undefined,
        lanStatus: params.lanStatus ?? undefined,
        associatedDevices: params.associatedDevices ?? undefined,
        connectedHosts: hosts.length > 0 ? JSON.stringify(hosts) : undefined,
        brand: params.brand ?? session.currentManufacturer ?? undefined,
        modelName: params.modelName ?? session.currentModelName ?? undefined,
        hardwareVersion: params.hardwareVersion ?? session.currentHardwareVersion ?? undefined,
        softwareVersion: params.softwareVersion ?? session.currentSoftwareVersion ?? undefined,
        macAddress: params.macAddress ?? undefined,
        wanIp: params.wanIp && !isPublicIp(params.wanIp) ? params.wanIp : undefined,
        lanIp: session.currentClientIp || (isPublicIp(clientIp) ? undefined : clientIp),
        rxPower: params.rxPower ?? undefined,
        txPower: params.txPower ?? undefined,
        temperature: params.temperature ?? undefined,
        voltage: params.voltage ?? undefined,
        lastInformAt: new Date().toISOString(),
        wanConfigJson: params.wanConfig ? JSON.stringify(params.wanConfig) : undefined,
        wifiConfigJson: params.wifiConfig ? JSON.stringify(params.wifiConfig) : undefined,
        rawModemParamsJson: params.rawParams ? JSON.stringify(params.rawParams) : undefined,
        modemProfile: session.currentModemProfile ?? undefined
      })

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
        const progressKeys = session.currentProgressKeys?.length ? session.currentProgressKeys : [clientIp]
        const prog = getFirstProgress(progressKeys)
        if (prog) {
          setProgressForKeys(progressKeys, {
            ...prog,
            progress: 100,
            status: 'failed',
            error: 'CPE tidak ditemukan di database',
            updatedAt: Date.now()
          })
        }
      } else {
        console.log(`[DB] Data modem ${session.currentModemSN} berhasil diupdate untuk client id: ${updatedRows.map(r=>r.id).join(',')}`)
        const progressKeys = session.currentProgressKeys?.length ? session.currentProgressKeys : [clientIp]
        const prog = getFirstProgress(progressKeys)
        if (prog) {
          setProgressForKeys(progressKeys, {
            ...prog,
            progress: 100,
            status: 'success',
            updatedAt: Date.now()
          })
        }
      }
    } catch (e: any) {
      console.error("Gagal update parameter ke DB:", e)
      const progressKeys = session.currentProgressKeys?.length ? session.currentProgressKeys : [clientIp]
      const prog = getFirstProgress(progressKeys)
      if (prog) {
        setProgressForKeys(progressKeys, {
          ...prog,
          progress: 100,
          status: 'failed',
          error: e.message || 'Gagal menyimpan ke database',
          updatedAt: Date.now()
        })
      }
    }
  }
}

// Endpoint Mini ACS (Terbuka untuk Modem / CPE)
const cwmpHandler = async (c: any) => {
  const bodyText = await c.req.text()
  const db = getDb(c.env)
  await ensureClientInventoryColumns(db)
  const clientIp = getClientIp(c)
  
  cleanExpiredSessions()

  console.log(`\n=============================================================`)
  console.log(`[DEBUG TR-069] Menerima request baru dari IP: ${clientIp}`)
  console.log(`[DEBUG TR-069] Method: ${c.req.method} | URL: ${c.req.url}`)
  console.log(`[DEBUG TR-069] Body Length: ${bodyText.length} karakter`)
  console.log(`=============================================================\n`)

  // Parse Cookie untuk mencocokkan Session ID unik (untuk menangani multiple modem di belakang NAT IP Publik yang sama)
  const cookieHeader = c.req.header('Cookie') || ''
  const cookieMatch = cookieHeader.match(/session=([^;]+)/)
  const cookieSessionId = cookieMatch ? cookieMatch[1].trim() : null

  // Cari session: prioritas dari cookieSessionId, fallback ke clientIp
  let sessionKey = cookieSessionId && cwmpSessions.has(cookieSessionId) ? cookieSessionId : clientIp
  let session = cwmpSessions.get(sessionKey)

  console.log(`[DEBUG TR-069] cookieHeader: "${cookieHeader}" | cookieSessionId: "${cookieSessionId}" | sessionKey: "${sessionKey}" | sessionFound: ${!!session}`)

  if (bodyText.includes('Inform')) {
    // 1. Terima event Inform dari Modem
    const informData = parseInform(bodyText)
    console.log(`Mini ACS Menerima Inform dari Modem [${clientIp}]:`, informData)

    const isDyingGasp = bodyText.includes('Dying Gasp') || bodyText.includes('DyingGasp')
    
    // Tentukan sessionKey unik menggunakan SerialNumber agar tidak bertabrakan di IP Publik yang sama
    if (informData.SerialNumber) {
      sessionKey = informData.SerialNumber
      session = cwmpSessions.get(sessionKey)
    }

    let clientId: number | null = null
    let clientName = informData.SerialNumber ? `ONT-${informData.SerialNumber}` : `ONT-${clientIp}`
    let currentClientIp: string | null = null

    if (informData.SerialNumber) {
      // Cari apakah client dengan serial number ini sudah terdaftar
      let existing = await db.select()
        .from(clients)
        .where(eq(clients.snModem, informData.SerialNumber))
        .limit(1)
      
      const connectionRequestIp = (() => {
        const url = informData.connectionRequestUrl
        if (!url) return null
        try {
          const host = new URL(url).hostname
          return host && !isPublicIp(host) ? host : null
        } catch {
          const match = url.match(/https?:\/\/([^/:]+)/i)
          const host = match?.[1]
          return host && !isPublicIp(host) ? host : null
        }
      })()

      // Tentukan IP modem yang valid. Jangan gunakan IP Publik jika ada alternatif IP lokal
      currentClientIp = informData.ipAddress && !isPublicIp(informData.ipAddress)
        ? informData.ipAddress
        : connectionRequestIp || (isPublicIp(clientIp) ? null : clientIp)

      if (currentClientIp) {
        const existingByLanIp = await db.select()
          .from(clients)
          .where(eq(clients.lanIp, currentClientIp))
          .limit(1)
        if (
          existingByLanIp[0] &&
          (
            !existing[0] ||
            existingByLanIp[0].pppoeUsername ||
            (existing[0].name?.startsWith('ONT-') && !existing[0].pppoeUsername)
          )
        ) {
          existing = existingByLanIp
          console.log(`[MiniACS] SN ${informData.SerialNumber} diprioritaskan ke client ${existing[0].name} berdasarkan lanIp ${currentClientIp}`)
        }
      }

      // Simpan connectionRequestUrl ke memory Map agar trigger bisa digunakan langsung
      if (informData.connectionRequestUrl && currentClientIp) {
        modemConnectionUrls.set(currentClientIp, informData.connectionRequestUrl)
        console.log(`[ACS] Saved CR URL for ${currentClientIp}: ${informData.connectionRequestUrl}`)
      }

      const updatePayload: Record<string, any> = {
        isOnline: !isDyingGasp,
        offlineReason: isDyingGasp ? 'POWER_FAILURE' : null,
        snModem: informData.SerialNumber,
        brand: informData.manufacturer || undefined,
        modelName: informData.modelName || undefined,
        hardwareVersion: informData.hardwareVersion || undefined,
        softwareVersion: informData.softwareVersion || undefined,
        connectionRequestUrl: informData.connectionRequestUrl || undefined,
        lastInformAt: new Date().toISOString(),
        modemProfile: informData.rootDataModel || undefined,
      }

      // Lindungi wanIp / lanIp agar tidak ter-NAT menjadi IP Publik yang sama.
      if (currentClientIp) {
        updatePayload.lanIp = currentClientIp
      }

      if (existing[0]) {
        clientId = existing[0].id
        clientName = existing[0].name
        // Update status online/offline & basic info
        await db.update(clients)
          .set(stripUndefined(updatePayload))
          .where(eq(clients.id, clientId))
        console.log(`[DB] Metadata Inform disimpan untuk ${clientName}: brand=${informData.manufacturer || 'N/A'}, model=${informData.modelName || 'N/A'}, hw=${informData.hardwareVersion || 'N/A'}, sw=${informData.softwareVersion || 'N/A'}`)
      } else {
        // Auto-Discovery: CPE belum terdaftar! Auto insert ke tabel clients!
        const inserted = await db.insert(clients).values({
          name: clientName,
          snModem: informData.SerialNumber,
          wanIp: null,
          lanIp: currentClientIp || null,
          isOnline: !isDyingGasp,
          offlineReason: isDyingGasp ? 'POWER_FAILURE' : null,
          brand: informData.manufacturer || null,
          modelName: informData.modelName || null,
          hardwareVersion: informData.hardwareVersion || null,
          softwareVersion: informData.softwareVersion || null,
          lastInformAt: new Date().toISOString(),
          modemProfile: informData.rootDataModel || null,
          lat: null,
          lng: null,
          odpId: null
        }).returning()
        
        clientId = inserted[0].id
        console.log(`[MiniACS] Auto-created client record for unknown Serial Number: ${informData.SerialNumber}`)
      }
    }

    if (isDyingGasp) {
      console.log(`[CWMP] Sesi diakhiri secara instan karena menerima Dying Gasp (Mati Listrik) dari ${clientName}`)
      cwmpSessions.delete(sessionKey)
      
      const progressKeys = getProgressKeysForClient(clientId, [clientIp, currentClientIp])
      const prog = getFirstProgress(progressKeys)
      if (prog) {
        setProgressForKeys(progressKeys, {
          ...prog,
          progress: 100,
          status: 'failed',
          error: 'Modem mati daya (Dying Gasp)',
          updatedAt: Date.now()
        })
      }

      const responseXml = createInformResponse(informData.cwmpId || '', informData.cwmpNamespace || 'urn:dslforum-org:cwmp-1-0')
      return new Response(responseXml, {
        headers: {
          'Content-Type': 'text/xml',
          'Server': 'Hono-MiniACS'
        }
      })
    }

    if (session) {
      session.currentCwmpId = informData.cwmpId || ''
      session.currentCwmpNamespace = informData.cwmpNamespace || 'urn:dslforum-org:cwmp-1-0'
      session.currentTriggeredClientId = clientId
      session.currentProgressKeys = getProgressKeysForClient(clientId, [clientIp, currentClientIp])
      session.currentClientIp = currentClientIp
      session.currentModemSN = informData.SerialNumber || session.currentModemSN
      session.currentManufacturer = informData.manufacturer || session.currentManufacturer
      session.currentModelName = informData.modelName || session.currentModelName
      session.currentHardwareVersion = informData.hardwareVersion || session.currentHardwareVersion
      session.currentSoftwareVersion = informData.softwareVersion || session.currentSoftwareVersion
      session.currentModemProfile = informData.rootDataModel || session.currentModemProfile
      session.updatedAt = Date.now()
      cwmpSessions.set(sessionKey, session)
    } else {
      const paramsToReq = buildParameterRequestList(informData.manufacturer, informData.SerialNumber, informData.rootDataModel)
      console.log(`[CWMP] Profile ${informData.rootDataModel || 'InternetGatewayDevice'} untuk ${informData.manufacturer || informData.SerialNumber || clientName}: ${paramsToReq.length} parameter`)
 
      const progressKeys = getProgressKeysForClient(clientId, [clientIp, currentClientIp])
      const existingProgress = getFirstProgress(progressKeys)
      const requestMode = existingProgress?.mode || 'inform'

      session = {
        waitingForEmptyPost: true,
        currentModemSN: informData.SerialNumber || '',
        currentCwmpId: informData.cwmpId || '',
        currentCwmpNamespace: informData.cwmpNamespace || 'urn:dslforum-org:cwmp-1-0',
        currentParamsToRequest: paramsToReq,
        currentTriggeredClientId: clientId,
        currentProgressKeys: progressKeys,
        currentClientIp,
        currentManufacturer: informData.manufacturer || null,
        currentModelName: informData.modelName || null,
        currentHardwareVersion: informData.hardwareVersion || null,
        currentSoftwareVersion: informData.softwareVersion || null,
        currentModemProfile: informData.rootDataModel || null,
        currentRequestMode: requestMode,
        gponFaultRetried: false,
        updatedAt: Date.now(),
        stage: 'params',
        wanNameRoots: [],
        wanDiscoveredParams: [],
        pendingModemData: undefined,
      }
      cwmpSessions.set(sessionKey, session)

      setProgressForKeys(progressKeys, {
        id: clientId,
        username: existingProgress?.username || clientName,
        progress: 40,
        status: 'connected',
        mode: existingProgress?.mode || 'inform',
        updatedAt: Date.now()
      })
    }

    const responseXml = createInformResponse(session ? session.currentCwmpId : '', session ? session.currentCwmpNamespace : undefined)
    return new Response(responseXml, {
      headers: {
        'Content-Type': 'text/xml',
        'Server': 'Hono-MiniACS',
        'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
      }
    })
  }

  if (session) {
    if (bodyText.trim() === '' && session.waitingForEmptyPost) {
      const clientId = session.currentTriggeredClientId;
      const pendingConfig = clientId ? pendingConfigs.get(clientId) : null;

      session.waitingForEmptyPost = false;
      session.updatedAt = Date.now()
      cwmpSessions.set(sessionKey, session)

      if (clientId && pendingConfig && pendingConfig.status === 'pending') {
        if (pendingConfig.operation === 'add-wan-ppp') {
          const candidate = pendingConfig.addObjectCandidates?.shift()
          if (!candidate) {
            markPendingConfigFailed(clientId, 'Tidak ada kandidat path AddObject WAN PPP yang tersedia untuk modem ini.')
            return new Response('', { status: 200, headers: { 'Content-Length': '0' } })
          }
          pendingConfig.status = 'adding'
          pendingConfig.addObjectPayload = {
            ...(pendingConfig.addObjectPayload || {}),
            objectPath: candidate
          }
          pendingConfig.updatedAt = Date.now()
          pendingConfigs.set(clientId, pendingConfig)

          const progressKeys = session.currentProgressKeys?.length ? session.currentProgressKeys : [clientIp]
          const prog = getFirstProgress(progressKeys)
          if (prog) {
            setProgressForKeys(progressKeys, {
              ...prog,
              progress: 45,
              status: 'fetching',
              updatedAt: Date.now()
            })
          }

          console.log(`[WAN ADD] Mencoba AddObject ${candidate} untuk clientId=${clientId}`)
          const responseXml = createAddObject(session.currentCwmpId, session.currentCwmpNamespace, candidate)
          return new Response(responseXml, {
            headers: {
              'Content-Type': 'text/xml',
              'Server': 'Hono-MiniACS',
              'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
            }
          })
        }

        pendingConfig.status = 'sending'; // Tandai sebagai 'sedang dikirim', bukan 'success' dulu
        pendingConfigs.set(clientId, pendingConfig);

        const progressKeys = session.currentProgressKeys?.length ? session.currentProgressKeys : [clientIp]
        const prog = getFirstProgress(progressKeys)
        if (prog) {
          setProgressForKeys(progressKeys, {
            ...prog,
            progress: 60,
            status: 'fetching',
            updatedAt: Date.now()
          })
        }

        console.log(`[CONFIG] Mengirimkan SetParameterValues untuk clientId=${clientId} (${session.currentModemSN})`);
        const responseXml = createSetParameterValues(session.currentCwmpId, session.currentCwmpNamespace, pendingConfig.params);
        return new Response(responseXml, {
          headers: {
            'Content-Type': 'text/xml',
            'Server': 'Hono-MiniACS',
            'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
          }
        })
      }

      const progressKeys = session.currentProgressKeys?.length ? session.currentProgressKeys : [clientIp]
      const prog = getFirstProgress(progressKeys)
      if (prog) {
        setProgressForKeys(progressKeys, {
          ...prog,
          progress: 70,
          status: 'fetching',
          updatedAt: Date.now()
        })
      }

      if (session.currentRequestMode === 'discover-wan') {
        session.stage = 'wan_names'
        session.wanNameRoots = getWanDiscoveryRoots(session.currentModemProfile)
        session.wanDiscoveredParams = []
        const responseXml = requestNextWanNameRoot(session)
        cwmpSessions.set(sessionKey, session)
        if (responseXml) {
          console.log(`[CWMP] Discovery WAN names dimulai untuk ${session.currentModemSN}: ${session.currentModemProfile || 'InternetGatewayDevice'}`)
          return new Response(responseXml, {
            headers: {
              'Content-Type': 'text/xml',
              'Server': 'Hono-MiniACS',
              'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
            }
          })
        }
      }

      const responseXml = createGetParameterValues(session.currentCwmpId, session.currentCwmpNamespace, session.currentParamsToRequest);
      return new Response(responseXml, {
        headers: {
          'Content-Type': 'text/xml',
          'Server': 'Hono-MiniACS',
          'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
        }
      })
    }
     
    if (bodyText.includes('AddObjectResponse')) {
      const clientId = session.currentTriggeredClientId
      const pendingConfig = clientId ? pendingConfigs.get(clientId) : null
      const addResult = parseAddObjectResponse(bodyText)
      const progressKeys = session.currentProgressKeys?.length ? session.currentProgressKeys : [clientIp]
      const prog = getFirstProgress(progressKeys)

      if (!clientId || !pendingConfig || pendingConfig.operation !== 'add-wan-ppp' || !addResult.instanceNumber) {
        const message = 'AddObject WAN PPP tidak mengembalikan InstanceNumber.'
        markPendingConfigFailed(clientId, message)
        if (prog) {
          setProgressForKeys(progressKeys, { ...prog, progress: 100, status: 'failed', error: message, updatedAt: Date.now() })
        }
        cwmpSessions.delete(sessionKey)
        return new Response('', { status: 200, headers: { 'Content-Length': '0' } })
      }

      const objectPath = pendingConfig.addObjectPayload?.objectPath || ''
      pendingConfig.params = buildWanPppSetParams(objectPath, addResult.instanceNumber, pendingConfig.addObjectPayload || {})
      pendingConfig.status = 'sending'
      pendingConfig.updatedAt = Date.now()
      pendingConfigs.set(clientId, pendingConfig)

      if (prog) {
        setProgressForKeys(progressKeys, { ...prog, progress: 65, status: 'fetching', updatedAt: Date.now() })
      }

      console.log(`[WAN ADD] AddObject berhasil path=${objectPath} instance=${addResult.instanceNumber}. Mengirim SetParameterValues (${pendingConfig.params.length} params).`)
      const responseXml = createSetParameterValues(session.currentCwmpId, session.currentCwmpNamespace, pendingConfig.params)
      return new Response(responseXml, {
        headers: {
          'Content-Type': 'text/xml',
          'Server': 'Hono-MiniACS',
          'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
        }
      })
    }

    if (bodyText.includes('SetParameterValuesResponse')) {
      const progressKeys = session.currentProgressKeys?.length ? session.currentProgressKeys : [clientIp]
      const prog = getFirstProgress(progressKeys)
      if (prog) {
        setProgressForKeys(progressKeys, {
          ...prog,
          progress: 80,
          status: 'fetching',
          updatedAt: Date.now()
        })
      }

      // PENTING: Reset stage ke 'params' agar GetParameterValuesResponse
      // berikutnya menyimpan data terbaru (incl. SSID baru) ke database.
      session.stage = 'params';
      session.pendingModemData = undefined;
      session.updatedAt = Date.now();
      cwmpSessions.set(sessionKey, session);

      // Tandai pendingConfig sebagai 'success' setelah modem konfirmasi via SetParameterValuesResponse
      if (session.currentTriggeredClientId) {
        const pc = pendingConfigs.get(session.currentTriggeredClientId)
        if (pc && pc.status === 'sending') {
          pc.status = 'success'
          pc.updatedAt = Date.now()
          pendingConfigs.set(session.currentTriggeredClientId, pc)
          console.log(`[CONFIG] SetParameterValuesResponse diterima & dikonfirmasi untuk clientId=${session.currentTriggeredClientId}. Menyimpan config ke DB langsung...`)

          // === SIMPAN LANGSUNG KE DB DARI params yang dikirim ===
          // Ini penting karena modem mungkin menutup koneksi TCP setelah menerapkan config
          // (misalnya saat WiFi restart), sehingga GetParameterValues berikutnya tidak terbalaskan.
          try {
            const directUpdate: Record<string, any> = {}
            const currentRows = await db.select().from(clients).where(eq(clients.id, session.currentTriggeredClientId)).limit(1)
            const currentWanConfig = safeParseJson((currentRows[0] as any)?.wanConfigJson, [])
            let wanConfigChanged = false
            for (const p of pc.params) {
              if (p.name.includes('WLANConfiguration.1.SSID')) directUpdate.wifiSsid = p.value
              else if (p.name.includes('WLANConfiguration.5.SSID')) directUpdate.wifiSsid5g = p.value
              else if (p.name.includes('WLANConfiguration.1.KeyPassphrase') || p.name.includes('WLANConfiguration.1.PreSharedKey')) directUpdate.wifiPassword = p.value
              else if (p.name.includes('WLANConfiguration.5.KeyPassphrase') || p.name.includes('WLANConfiguration.5.PreSharedKey')) directUpdate.wifiPassword5g = p.value
              else if (p.name.includes('WANPPPConnection') && p.name.endsWith('.Username')) directUpdate.pppoeUsername = p.value
              else if (p.name.includes('Device.PPP.Interface') && p.name.endsWith('.Username')) directUpdate.pppoeUsername = p.value

              for (const row of currentWanConfig) {
                const fieldPaths = row.fieldPaths || {}
                for (const [key, path] of Object.entries(fieldPaths)) {
                  if (path === p.name) {
                    row[key] = p.value
                    wanConfigChanged = true
                  }
                }
              }
            }
            if (wanConfigChanged) directUpdate.wanConfigJson = JSON.stringify(currentWanConfig)

            if (Object.keys(directUpdate).length > 0) {
              await db.update(clients)
                .set(directUpdate)
                .where(eq(clients.id, session.currentTriggeredClientId))
              console.log(`[CONFIG] Konfigurasi berhasil disimpan langsung ke DB untuk clientId=${session.currentTriggeredClientId}:`, directUpdate)

              // Update progress ke success agar frontend refresh data
              setProgressForKeys(progressKeys, {
                id: prog?.id ?? null,
                username: prog?.username ?? '',
                progress: 100,
                status: 'success',
                updatedAt: Date.now()
              })
            }
          } catch (dbErr: any) {
            console.error(`[CONFIG] Gagal simpan langsung ke DB:`, dbErr.message)
          }
        }
      }

      const pendingConfig = session.currentTriggeredClientId ? pendingConfigs.get(session.currentTriggeredClientId) : null
      const verifyParams = pendingConfig?.params?.map(param => param.name).filter(Boolean) || []
      const responseXml = createGetParameterValues(
        session.currentCwmpId,
        session.currentCwmpNamespace,
        verifyParams.length ? verifyParams : session.currentParamsToRequest
      );
      return new Response(responseXml, {
        headers: {
          'Content-Type': 'text/xml',
          'Server': 'Hono-MiniACS',
          'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
        }
      })
    }
    
    if (bodyText.includes('GetParameterValuesResponse')) {
      const currentStage = session.stage || 'params';
      
      if (currentStage === 'params') {
        const params = parseGetParameterValuesResponse(bodyText)
        session.pendingModemData = params;
        session.stage = 'host_names';
        session.updatedAt = Date.now();
        cwmpSessions.set(sessionKey, session);
        
        const progressKeys = session.currentProgressKeys?.length ? session.currentProgressKeys : [clientIp]
        const prog = getFirstProgress(progressKeys)
        if (prog) {
          setProgressForKeys(progressKeys, {
            ...prog,
            progress: 80,
            status: 'fetching',
            updatedAt: Date.now()
          })
        }
        
        const hostRootPath = session.currentParamsToRequest?.some(param => param.startsWith('Device.'))
          ? 'Device.'
          : 'InternetGatewayDevice.LANDevice.1.'
        const responseXml = createGetParameterNames(session.currentCwmpId, session.currentCwmpNamespace, hostRootPath, false);
        return new Response(responseXml, {
          headers: {
            'Content-Type': 'text/xml',
            'Server': 'Hono-MiniACS',
            'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
          }
        })
      } else if (currentStage === 'host_values') {
        const hosts = parseHostsFromGetParameterValues(bodyText)
        const params = session.pendingModemData || {}
        params.connectedHosts = hosts;
        
        await saveModemDataToDb(c, db, session, params, clientIp)
        
        cwmpSessions.delete(sessionKey)
        return new Response('', { status: 200, headers: { 'Content-Length': '0' } })
      }
    }
    
    if (bodyText.includes('GetParameterNamesResponse')) {
      if (session.stage === 'wan_names') {
        const names = parseAllParameterNamesResponse(bodyText)
        const wanParams = filterWanParameterNames(names)
        session.wanDiscoveredParams = [...new Set([...(session.wanDiscoveredParams || []), ...wanParams])]
        console.log(`[CWMP] Discovery WAN names ${session.currentModemSN}: +${wanParams.length}, total=${session.wanDiscoveredParams.length}`)

        const nextXml = requestNextWanNameRoot(session)
        if (nextXml) {
          cwmpSessions.set(sessionKey, session)
          return new Response(nextXml, {
            headers: {
              'Content-Type': 'text/xml',
              'Server': 'Hono-MiniACS',
              'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
            }
          })
        }

        session.stage = 'params'
        session.updatedAt = Date.now()
        cwmpSessions.set(sessionKey, session)

        if (session.wanDiscoveredParams.length > 0) {
          const responseXml = createGetParameterValues(session.currentCwmpId, session.currentCwmpNamespace, session.wanDiscoveredParams);
          return new Response(responseXml, {
            headers: {
              'Content-Type': 'text/xml',
              'Server': 'Hono-MiniACS',
              'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
            }
          })
        }

        const params = { rawParams: {}, wanConfig: [], connectedHosts: [] }
        await saveModemDataToDb(c, db, session, params, clientIp)
        cwmpSessions.delete(sessionKey)
        return new Response('', { status: 200, headers: { 'Content-Length': '0' } })
      }

      if (session.stage === 'host_names') {
        const hostParams = parseGetParameterNamesResponse(bodyText)
        
        if (hostParams.length === 0) {
          const params = session.pendingModemData || {}
          params.connectedHosts = []
          
          await saveModemDataToDb(c, db, session, params, clientIp)
          
          cwmpSessions.delete(sessionKey)
          return new Response('', { status: 200, headers: { 'Content-Length': '0' } })
        }
        
        session.stage = 'host_values';
        session.updatedAt = Date.now();
        cwmpSessions.set(sessionKey, session);
        
        const progressKeys = session.currentProgressKeys?.length ? session.currentProgressKeys : [clientIp]
        const prog = getFirstProgress(progressKeys)
        if (prog) {
          setProgressForKeys(progressKeys, {
            ...prog,
            progress: 90,
            status: 'fetching',
            updatedAt: Date.now()
          })
        }
        
        const responseXml = createGetParameterValues(session.currentCwmpId, session.currentCwmpNamespace, hostParams);
        return new Response(responseXml, {
          headers: {
            'Content-Type': 'text/xml',
            'Server': 'Hono-MiniACS',
            'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
          }
        })
      }
    }

    if (bodyText.includes('Fault') || bodyText.includes('fault')) {
      const faultCode = (bodyText.match(/<FaultCode>(\d+)<\/FaultCode>/) || [])[1] || '?';

      if (session.currentTriggeredClientId) {
        const pendingConfig = pendingConfigs.get(session.currentTriggeredClientId)
        if (pendingConfig?.operation === 'add-wan-ppp' && pendingConfig.status === 'adding') {
          const nextCandidate = pendingConfig.addObjectCandidates?.shift()
          if (nextCandidate) {
            pendingConfig.addObjectPayload = {
              ...(pendingConfig.addObjectPayload || {}),
              objectPath: nextCandidate
            }
            pendingConfig.updatedAt = Date.now()
            pendingConfigs.set(session.currentTriggeredClientId, pendingConfig)
            console.warn(`[WAN ADD] AddObject fault ${faultCode}, mencoba kandidat berikutnya: ${nextCandidate}`)
            const responseXml = createAddObject(session.currentCwmpId, session.currentCwmpNamespace, nextCandidate)
            return new Response(responseXml, {
              headers: {
                'Content-Type': 'text/xml',
                'Server': 'Hono-MiniACS',
                'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
              }
            })
          }

          const faultString = (bodyText.match(/<FaultString>([^<]+)<\/FaultString>/) || [])[1] || ''
          const faultMessage = `Semua kandidat AddObject WAN PPP gagal. Fault ${faultCode}${faultString ? `: ${faultString}` : ''}`
          markPendingConfigFailed(session.currentTriggeredClientId, faultMessage)
          const progressKeys = session.currentProgressKeys?.length ? session.currentProgressKeys : [clientIp]
          const prog = getFirstProgress(progressKeys)
          if (prog) {
            setProgressForKeys(progressKeys, {
              ...prog,
              progress: 100,
              status: 'failed',
              error: faultMessage,
              updatedAt: Date.now()
            })
          }
          cwmpSessions.delete(sessionKey)
          return new Response('', { status: 200, headers: { 'Content-Length': '0' } })
        }
      }

      if (faultCode === '9005' && session.stage === 'wan_names') {
        console.warn(`[CWMP] Root WAN tidak didukung oleh ${session.currentModemSN}, mencoba root berikutnya.`)
        const nextXml = requestNextWanNameRoot(session)
        if (nextXml) {
          cwmpSessions.set(sessionKey, session)
          return new Response(nextXml, {
            headers: {
              'Content-Type': 'text/xml',
              'Server': 'Hono-MiniACS',
              'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
            }
          })
        }

        session.stage = 'params'
        session.updatedAt = Date.now()
        cwmpSessions.set(sessionKey, session)
        if ((session.wanDiscoveredParams || []).length > 0) {
          const responseXml = createGetParameterValues(session.currentCwmpId, session.currentCwmpNamespace, session.wanDiscoveredParams || []);
          return new Response(responseXml, {
            headers: {
              'Content-Type': 'text/xml',
              'Server': 'Hono-MiniACS',
              'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
            }
          })
        }

        const params = { rawParams: {}, wanConfig: [], connectedHosts: [] }
        await saveModemDataToDb(c, db, session, params, clientIp)
        cwmpSessions.delete(sessionKey)
        return new Response('', { status: 200, headers: { 'Content-Length': '0' } })
      }
      
      if (faultCode === '9005' && (session.stage === 'host_names' || session.stage === 'host_values')) {
        const params = session.pendingModemData || {}
        params.connectedHosts = []
        await saveModemDataToDb(c, db, session, params, clientIp)
        cwmpSessions.delete(sessionKey)
        return new Response('', { status: 200, headers: { 'Content-Length': '0' } })
      }
      
      if (faultCode === '9005' && !session.gponFaultRetried && session.currentModemSN) {
        session.gponFaultRetried = true;
        session.updatedAt = Date.now()
        cwmpSessions.set(sessionKey, session)
        
        const retryXml = createGetParameterValues(session.currentCwmpId, session.currentCwmpNamespace, igdBaseParams);
        return new Response(retryXml, {
          headers: {
            'Content-Type': 'text/xml',
            'Server': 'Hono-MiniACS',
            'Set-Cookie': `session=${sessionKey}; Path=/; HttpOnly`
          }
        })
      }
      
      const progressKeys = session.currentProgressKeys?.length ? session.currentProgressKeys : [clientIp]
      const prog = getFirstProgress(progressKeys)
      const faultString = (bodyText.match(/<FaultString>([^<]+)<\/FaultString>/) || [])[1] || ''
      const faultMessage = `Fault ${faultCode} dari modem${faultString ? `: ${faultString}` : ''}`
      if (prog) {
        setProgressForKeys(progressKeys, {
          ...prog,
          progress: 100,
          status: 'failed',
          error: faultMessage,
          updatedAt: Date.now()
        })
      }
      markPendingConfigFailed(session.currentTriggeredClientId, faultMessage)
      cwmpSessions.delete(sessionKey)
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
      mode: progress.mode,
      error: progress.error,
      updatedAt: progress.updatedAt
    }
  }
  for (const [clientId, pendingConfig] of pendingConfigs.entries()) {
    const progress =
      pendingConfig.status === 'success' ? 100 :
      pendingConfig.status === 'failed' ? 100 :
      pendingConfig.status === 'sending' ? 70 :
      pendingConfig.status === 'adding' ? 45 :
      10
    const status =
      pendingConfig.status === 'success' ? 'success' :
      pendingConfig.status === 'failed' ? 'failed' :
      pendingConfig.status === 'sending' || pendingConfig.status === 'adding' ? 'fetching' :
      'triggered'
    const item = {
      id: clientId,
      username: `Client-${clientId}`,
      progress,
      status,
      error: pendingConfig.error,
      updatedAt: pendingConfig.updatedAt,
      configStatus: pendingConfig.status
    }
    data[pendingConfig.modemIp] = data[pendingConfig.modemIp] || item
    data[String(clientId)] = data[String(clientId)] || item
  }
  return c.json(data)
})

// Endpoint untuk Push Konfigurasi Modem (TR-069 Config)
app.post('/api/protected/modem/:ip/config', async (c) => {
  const modemIp = c.req.param('ip')
  const db = getDb(c.env)
  const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = await getEnv(c, db)
  
  try {
    const body = await c.req.json()
    const { deviceId, params } = body // params: { name: string; value: string; type: string }[]
    const pseudoDeviceId = deviceId ? parseInt(deviceId, 10) : null
    const clientId = pseudoDeviceId && pseudoDeviceId >= 1000000 ? pseudoDeviceId - 1000000 : null

    if (!clientId || !params || !Array.isArray(params)) {
      return c.json({ error: 'Invalid parameters' }, 400)
    }

    pendingConfigs.set(clientId, {
      clientId,
      modemIp,
      params,
      status: 'pending',
      updatedAt: Date.now()
    })

    console.log(`[CONFIG] Menyimpan konfigurasi tertunda untuk modemIp=${modemIp} clientId=${clientId}`)

    // Cari nama client & connectionRequestUrl dari memory/DB
    let clientName = `ONT-${modemIp}`
    let connectionRequestUrl: string | null = modemConnectionUrls.get(modemIp) || null
    const client = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1)
    if (client[0]) {
      clientName = client[0].name
      if (!connectionRequestUrl) {
        connectionRequestUrl = (client[0] as any).connectionRequestUrl || null
      }
    }

    // Set progress agar frontend bisa tracking status push config
    const progressKeys = [modemIp, String(clientId)]
    for (const key of progressKeys) {
      syncProgress.set(key, {
        id: clientId,
        username: clientName,
        progress: 10,
        status: 'triggered',
        mode: 'config',
        updatedAt: Date.now()
      })
    }

    console.log(`[CONFIG] Trigger modem ${clientName} (${modemIp}) crUrl=${connectionRequestUrl || 'NOT_FOUND_YET'}`)
    
    // Trigger modem agar segera Inform ke ACS (pakai connectionRequestUrl jika ada)
    const triggered = await triggerModemCWMP(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, modemIp, MIKROTIK_BRIDGE_URL, connectionRequestUrl)
    console.log(`[CONFIG] Trigger ${triggered ? 'berhasil' : 'gagal/timeout'} untuk ${clientName}`)
    
    return c.json({
      success: true,
      queued: true,
      triggered,
      message: triggered
        ? `Konfigurasi masuk antrian dan modem ${clientName} sudah diminta segera Inform untuk menerapkan setting.`
        : `Konfigurasi masuk antrian, tetapi trigger Inform ke ${clientName} timeout. Sistem tetap menunggu Inform berikutnya dari modem.`
    })
  } catch (err: any) {
    return c.json({ error: 'Gagal memproses konfigurasi', details: err.message }, 500)
  }
})

// Endpoint untuk Vue 3 (Memicu Modem secara Real-time)
app.post('/api/protected/modem/:ip/sync', async (c) => {
  const modemIp = c.req.param('ip')
  const db = getDb(c.env)
  const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = await getEnv(c, db)
  
  cleanExpiredSessions()
  console.log(`[SYNC] Request trigger Inform diterima untuk modemIp=${modemIp} bridge=${MIKROTIK_BRIDGE_URL || 'http://127.0.0.1:3005'}`)

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
    // Cari connectionRequestUrl: prioritas dari memory Map (dari Inform terbaru), fallback ke DB
    let connectionRequestUrl: string | null = modemConnectionUrls.get(modemIp) || null
    if (clientId) {
      const client = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1)
      if (client[0]) {
        clientName = client[0].name
        // Gunakan DB hanya jika memory tidak ada
        if (!connectionRequestUrl) {
          connectionRequestUrl = (client[0] as any).connectionRequestUrl || null
        }
      }
    }
    console.log(`[SYNC] Target client=${clientName} id=${clientId || 'N/A'} ip=${modemIp} crUrl=${connectionRequestUrl || 'NOT_FOUND_YET'}`)

    // Set progress awal (10%)
    syncProgress.set(modemIp, {
      id: clientId,
      username: clientName,
      progress: 10,
      status: 'triggered',
      mode: 'inform',
      updatedAt: Date.now()
    })

    // Menyuruh Mikrotik "mencolek" modem. Bridge lama bisa timeout 10 detik,
    // tetapi Inform dari ONT masih bisa masuk setelah request ini selesai.
    let triggered = false
    let triggerError: string | null = null
    try {
      triggered = await triggerModemCWMP(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, modemIp, MIKROTIK_BRIDGE_URL, connectionRequestUrl)
    } catch (err: any) {
      triggerError = err.message || 'Trigger modem timeout'
      console.warn(`[SYNC] Trigger timeout/gagal untuk ${clientName} (${modemIp}), tetap menunggu Inform berikutnya:`, triggerError)
    }
    console.log(`[SYNC] Trigger ${triggered ? 'terkirim' : 'ditunggu/queued'} untuk ${clientName} (${modemIp})`)
    return c.json({
      message: triggered
        ? `Sinyal trigger dikirim ke modem ${modemIp} via Mikrotik Lokal`
        : `Trigger modem ${modemIp} masuk antrian. Sistem tetap menunggu Inform berikutnya dari modem.`,
      queued: !triggered,
      triggerError
    })
  } catch (err: any) {
    console.error(`[SYNC] Gagal trigger Inform untuk ${modemIp}:`, err)
    syncProgress.set(modemIp, {
      id: null,
      username: `ONT-${modemIp}`,
      progress: 100,
      status: 'failed',
      mode: 'inform',
      error: err.message || 'Gagal mengirim trigger',
      updatedAt: Date.now()
    })
    return c.json({ error: 'Gagal men-trigger modem', details: err.message }, 502)
  }
})

const safeParseJson = (value: any, fallback: any) => {
  if (!value) return fallback
  try {
    return typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    return fallback
  }
}

const findRawParamValue = (raw: Record<string, any>, patterns: RegExp[]) => {
  for (const [name, value] of Object.entries(raw || {})) {
    if (value === null || value === undefined || value === '') continue
    if (patterns.some(pattern => pattern.test(name))) return String(value)
  }
  return null
}

const inferAdminUsername = (raw: Record<string, any>) =>
  findRawParamValue(raw, [
    /UserInterface\..*(UserName|Username)$/i,
    /User\.\d+\.(UserName|Username)$/i,
    /X_.*Web.*(UserName|Username)$/i,
    /X_.*Admin.*(UserName|Username)$/i,
  ])

const inferAdminPassword = (raw: Record<string, any>) =>
  findRawParamValue(raw, [
    /UserInterface\..*Password$/i,
    /User\.\d+\.Password$/i,
    /X_.*Web.*Password$/i,
    /X_.*Admin.*Password$/i,
  ])

const getClientTriggerIpFromRow = (client: any) => {
  const safeWanIp = client.wanIp && !isPublicIp(client.wanIp) ? client.wanIp : null
  return client.lanIp || safeWanIp || null
}

const toClientInventoryDto = (client: any, activeByUsername: Map<string, any> = new Map()) => {
  const active = client.pppoeUsername ? activeByUsername.get(client.pppoeUsername) : null
  const safeWanIp = client.wanIp && !isPublicIp(client.wanIp) ? client.wanIp : null
  const rawParams = safeParseJson(client.rawModemParamsJson, {})
  return {
    id: client.id,
    pseudoId: client.id + 1000000,
    name: client.name,
    phone: client.phone,
    status: client.isOnline ? 'ONLINE' : 'OFFLINE',
    isOnline: client.isOnline,
    pppoeUsername: client.pppoeUsername,
    rxPower: client.rxPower,
    uptime: active?.uptime || active?.['uptime'] || null,
    wanIp: safeWanIp || active?.address || active?.['remote-address'] || null,
    lanIp: client.lanIp,
    triggerIp: getClientTriggerIpFromRow(client),
    snModem: client.snModem,
    product: client.modelName || client.brand || null,
    brand: client.brand,
    modelName: client.modelName,
    softwareVersion: client.softwareVersion,
    hardwareVersion: client.hardwareVersion,
    macAddress: client.macAddress,
    lastInformAt: client.lastInformAt,
    modemProfile: client.modemProfile,
    clientType: client.clientType || 'PPPOE',
    wifiSsid: client.wifiSsid,
    wifiPassword: client.wifiPassword,
    wifiSsid5g: client.wifiSsid5g,
    wifiPassword5g: client.wifiPassword5g,
    wifiConfig: safeParseJson(client.wifiConfigJson, null),
    wanConfig: safeParseJson(client.wanConfigJson, []),
    connectedHosts: safeParseJson(client.connectedHosts, []),
    adminUsername: client.adminUsername || inferAdminUsername(rawParams) || 'admin',
    adminPassword: client.adminPassword || inferAdminPassword(rawParams),
  }
}

let activePppoeCache: { data: Map<string, any>; updatedAt: number } = {
  data: new Map(),
  updatedAt: 0
}

const getActivePppoeMap = async (c: any, db: any, options: { cacheOnly?: boolean } = {}) => {
  const map = new Map<string, any>()
  const now = Date.now()
  const cacheFresh = now - activePppoeCache.updatedAt < 15000
  if (cacheFresh || options.cacheOnly) {
    return new Map(activePppoeCache.data)
  }

  try {
    const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = await getEnv(c, db)
    if (!MIKROTIK_IP) return map
    const active = await getPppoeActive(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL)
    for (const row of active || []) {
      const username = row.name || row.user || row.username
      if (username) map.set(username, row)
    }
    activePppoeCache = { data: new Map(map), updatedAt: Date.now() }
  } catch (err: any) {
    console.warn('[Clients] Gagal enrich uptime PPPoE:', err.message || err)
    return new Map(activePppoeCache.data)
  }
  return map
}

app.get('/api/protected/clients', async (c) => {
  try {
    const db = getDb(c.env)
    await ensureClientInventoryColumns(db)
    const search = (c.req.query('search') || '').trim().toLowerCase()
    const activeByUsername = await getActivePppoeMap(c, db)
    const rows = await db.select().from(clients)
    const filtered = search
      ? rows.filter((client: any) =>
          [client.name, client.pppoeUsername, client.wanIp, client.lanIp, client.snModem, client.modelName]
            .some(value => String(value || '').toLowerCase().includes(search))
        )
      : rows
    return c.json(filtered.map((client: any) => toClientInventoryDto(client, activeByUsername)))
  } catch (err: any) {
    return c.json({ error: 'Gagal mengambil daftar client', details: err.message }, 500)
  }
})

app.get('/api/protected/clients/:id/detail', async (c) => {
  try {
    const db = getDb(c.env)
    await ensureClientInventoryColumns(db)
    const id = parseInt(c.req.param('id'), 10)
    const rows = await db.select().from(clients).where(eq(clients.id, id)).limit(1)
    if (!rows[0]) return c.json({ error: 'Client tidak ditemukan' }, 404)
    const activeByUsername = await getActivePppoeMap(c, db, { cacheOnly: true })
    return c.json({
      ...toClientInventoryDto(rows[0], activeByUsername),
      rawModemParams: safeParseJson((rows[0] as any).rawModemParamsJson, {}),
    })
  } catch (err: any) {
    return c.json({ error: 'Gagal mengambil detail client', details: err.message }, 500)
  }
})

const triggerClientInformById = async (c: any, mode: 'inform' | 'discover-wan') => {
  const db = getDb(c.env)
  await ensureClientInventoryColumns(db)
  const id = parseInt(c.req.param('id'), 10)
  const rows = await db.select().from(clients).where(eq(clients.id, id)).limit(1)
  const client = rows[0] as any
  if (!client) return c.json({ error: 'Client tidak ditemukan' }, 404)
  const modemIp = getClientTriggerIpFromRow(client)
  if (!modemIp) return c.json({ error: 'IP management modem belum tersedia' }, 400)
  const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = await getEnv(c, db)
  const connectionRequestUrl = client.connectionRequestUrl || modemConnectionUrls.get(modemIp) || null
  syncProgress.set(modemIp, {
    id,
    username: client.name,
    progress: 10,
    status: 'triggered',
    mode,
    updatedAt: Date.now()
  })
  syncProgress.set(String(id), {
    id,
    username: client.name,
    progress: 10,
    status: 'triggered',
    mode,
    updatedAt: Date.now()
  })
  let triggered = false
  let triggerError: string | null = null
  try {
    triggered = await triggerModemCWMP(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, modemIp, MIKROTIK_BRIDGE_URL, connectionRequestUrl)
  } catch (err: any) {
    triggerError = err.message || 'Trigger modem timeout'
    console.warn(`[Clients] Trigger ${mode} untuk ${client.name} (${modemIp}) timeout/gagal, tetap menunggu Inform berikutnya:`, triggerError)
  }
  return c.json({
    success: true,
    mode,
    triggered,
    queued: !triggered,
    triggerError,
    message: mode === 'discover-wan'
      ? (triggered
          ? 'Discovery WAN dikirim. Menunggu modem Inform dan mengirim parameter WAN.'
          : 'Discovery WAN masuk antrian. Sistem akan memakai Inform berikutnya dari modem.')
      : (triggered
          ? 'Inform dikirim. Menunggu modem mengirim data terbaru.'
          : 'Inform masuk antrian. Sistem akan memakai Inform berikutnya dari modem.')
  })
}

app.post('/api/protected/clients/:id/inform', async (c) => {
  try {
    return await triggerClientInformById(c, 'inform')
  } catch (err: any) {
    return c.json({ error: 'Gagal trigger Inform client', details: err.message }, 500)
  }
})

app.post('/api/protected/clients/:id/discover-wan', async (c) => {
  try {
    return await triggerClientInformById(c, 'discover-wan')
  } catch (err: any) {
    return c.json({ error: 'Gagal discovery WAN', details: err.message }, 500)
  }
})

app.patch('/api/protected/clients/:id/admin-config', async (c) => {
  try {
    const db = getDb(c.env)
    await ensureClientInventoryColumns(db)
    const id = parseInt(c.req.param('id'), 10)
    const body = await c.req.json()
    await db.update(clients)
      .set({
        adminUsername: body.username || null,
        adminPassword: body.password || null,
      })
      .where(eq(clients.id, id))
    return c.json({ success: true })
  } catch (err: any) {
    return c.json({ error: 'Gagal menyimpan admin config', details: err.message }, 500)
  }
})

app.post('/api/protected/clients/:id/create-wan-ppp', async (c) => {
  try {
    const db = getDb(c.env)
    await ensureClientInventoryColumns(db)
    const id = parseInt(c.req.param('id'), 10)
    const body = await c.req.json()
    const rows = await db.select().from(clients).where(eq(clients.id, id)).limit(1)
    const client = rows[0] as any
    if (!client) return c.json({ error: 'Client tidak ditemukan' }, 404)

    const modemIp = getClientTriggerIpFromRow(client)
    if (!modemIp) return c.json({ error: 'IP management modem belum tersedia' }, 400)

    const payload = {
      vlanId: body.vlanId,
      username: body.username || client.pppoeUsername,
      password: body.password,
      nat: body.nat ?? '1',
      enable: body.enable ?? '1',
      serviceType: body.serviceType || 'INTERNET',
      connectionName: body.connectionName || `INTERNET_VID_${body.vlanId || 'PPP'}`
    }

    if (!payload.username || !payload.password || !payload.vlanId) {
      return c.json({ error: 'VLAN ID, username PPPoE, dan password wajib diisi' }, 400)
    }

    const candidates = getWanPppAddObjectCandidates(client.modemProfile)
    pendingConfigs.set(id, {
      clientId: id,
      modemIp,
      params: [],
      status: 'pending',
      operation: 'add-wan-ppp',
      addObjectCandidates: candidates,
      addObjectPayload: payload,
      updatedAt: Date.now()
    })

    const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = await getEnv(c, db)
    const connectionRequestUrl = client.connectionRequestUrl || modemConnectionUrls.get(modemIp) || null
    const progressKeys = [modemIp, String(id)]
    for (const key of progressKeys) {
      syncProgress.set(key, {
        id,
        username: client.name,
        progress: 10,
        status: 'triggered',
        mode: 'config',
        updatedAt: Date.now()
      })
    }

    let triggered = false
    let triggerError: string | null = null
    try {
      triggered = await triggerModemCWMP(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, modemIp, MIKROTIK_BRIDGE_URL, connectionRequestUrl)
    } catch (err: any) {
      triggerError = err.message || 'Trigger modem timeout'
      console.warn(`[WAN ADD] Trigger timeout/gagal untuk ${client.name} (${modemIp}), tetap menunggu Inform berikutnya:`, triggerError)
    }

    return c.json({
      success: true,
      queued: !triggered,
      triggered,
      triggerError,
      message: triggered
        ? 'Create WAN PPP masuk antrian dan modem diminta Inform.'
        : 'Create WAN PPP masuk antrian. Sistem menunggu Inform berikutnya dari modem.'
    })
  } catch (err: any) {
    return c.json({ error: 'Gagal membuat WAN PPP', details: err.message }, 500)
  }
})

// Endpoint Topologi
app.get('/api/protected/devices', async (c) => {
  try {
    const db = getDb(c.env)
    await ensureClientInventoryColumns(db)
    await cleanupOldGarbageData(db)
    const allDevices = await db.select().from(devices)
    const allClients = await db.select().from(clients)

    // Mapping client agar kompatibel dengan data topology (node tree map)
    const mappedClients = allClients.map(client => {
      const cType = client.clientType || 'PPPOE'
      // triggerIp: IP yang dipakai untuk trigger CWMP
      // Modem HOTSPOT tidak punya wanIp (PPPoE), pakai lanIp
      const safeWanIp = client.wanIp && !isPublicIp(client.wanIp) ? client.wanIp : null
      const triggerIp = client.lanIp || safeWanIp
      const inferredModem = inferModemInfoFromSn(client.snModem)
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
        connectedHosts: client.connectedHosts ? JSON.parse(client.connectedHosts) : [],
        brand: client.brand || inferredModem.brand || null,
        modelName: client.modelName || inferredModem.modelName || null,
        hardwareVersion: client.hardwareVersion,
        softwareVersion: client.softwareVersion,
        macAddress: client.macAddress,
        wanIp: safeWanIp,
        lanIp: client.lanIp,
        clientType: cType,
        triggerIp,
        rxPower: client.rxPower,
        txPower: client.txPower,
        temperature: client.temperature,
        voltage: client.voltage,
        isOnline: client.isOnline,
        offlineReason: client.offlineReason,
        cablePath: client.cablePath,
        lastInformAt: (client as any).lastInformAt,
        modemProfile: (client as any).modemProfile,
        wanConfig: safeParseJson((client as any).wanConfigJson, []),
        wifiConfig: safeParseJson((client as any).wifiConfigJson, null),
        adminUsername: (client as any).adminUsername,
        adminPassword: (client as any).adminPassword
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

app.get('/api/protected/mikrotik/pppoe-credential/:username', async (c) => {
  try {
    const username = decodeURIComponent(c.req.param('username'))
    const db = getDb(c.env)
    const { MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL } = await getEnv(c, db)

    if (!username) {
      return c.json({ error: 'Username PPPoE kosong' }, 400)
    }
    if (!MIKROTIK_IP || !MIKROTIK_USER || !MIKROTIK_PASS) {
      return c.json({ error: 'Kredensial Mikrotik belum dikonfigurasi di server' }, 500)
    }

    const [activeResult, secretResult] = await Promise.allSettled([
      getPppoeActive(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL),
      getPppoeSecrets(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL)
    ])

    const activeList = activeResult.status === 'fulfilled' ? activeResult.value : []
    const secretList = secretResult.status === 'fulfilled' ? secretResult.value : []
    const active = activeList.find((item: any) =>
      String(item.name || item.user || item.username || '').toLowerCase() === username.toLowerCase()
    )
    const secret = secretList.find((item: any) =>
      String(item.name || '').toLowerCase() === username.toLowerCase()
    )

    return c.json({
      username,
      password: secret?.password || null,
      profile: secret?.profile || null,
      service: secret?.service || active?.service || null,
      isActive: !!active,
      address: active?.address || active?.['remote-address'] || active?.remoteAddress || null,
      uptime: active?.uptime || null,
      secretError: secretResult.status === 'rejected' ? secretResult.reason?.message : null,
      activeError: activeResult.status === 'rejected' ? activeResult.reason?.message : null
    })
  } catch (err: any) {
    return c.json({ error: 'Gagal mengambil credential PPPoE', details: err.message }, 502)
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

    // === Langkah 1: Kumpulkan data PPPoE Active ===
    interface PppoeClientInfo {
      username: string;
      mac: string;
      ip: string;
    }
    let pppoeClients: PppoeClientInfo[] = []

    console.log(`[DHCP Sync] Mulai tarik PPPoE active dan DHCP lease via bridge=${MIKROTIK_BRIDGE_URL || 'http://127.0.0.1:3005'}`)
    const [pppoeResult, dhcpResult] = await Promise.allSettled([
      getPppoeActive(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL),
      getDhcpLeases(MIKROTIK_IP, MIKROTIK_USER, MIKROTIK_PASS, MIKROTIK_BRIDGE_URL)
    ])

    if (pppoeResult.status === 'fulfilled') {
      const pppoeList = pppoeResult.value
      for (const p of pppoeList) {
        const username = p.name || p.user || p.username || ''
        const mac = (p['caller-id'] || p.callerId || p.macAddress || p.mac || '').toLowerCase().trim()
        const ip = p.address || p['remote-address'] || p.remoteAddress || ''
        if (mac || username) {
          pppoeClients.push({ username, mac, ip })
        }
      }
      console.log(`[DHCP Sync] PPPoE Clients terkumpul: ${pppoeClients.length}`)
    } else {
      console.warn('[DHCP Sync] Gagal mengambil PPPoE active (lanjut tanpa cross-ref):', pppoeResult.reason)
    }

    // === Langkah 2: Ambil semua DHCP Leases aktif ===
    if (dhcpResult.status === 'rejected') {
      console.error('[DHCP Sync] Gagal mengambil DHCP lease:', dhcpResult.reason)
      return c.json({
        error: 'Gagal mengambil DHCP lease dari bridge',
        details: dhcpResult.reason?.message || String(dhcpResult.reason)
      }, 502)
    }

    const leases = dhcpResult.value
    if (!leases || leases.length === 0) {
      return c.json({ message: 'Tidak ada DHCP lease aktif.', total: 0, created: 0, updated: 0, skipped: 0 })
    }

    console.log(`[DHCP Sync] Total DHCP lease aktif dari router: ${leases.length}`)

    // Setel semua client Hotspot menjadi offline terlebih dahulu sebelum meng-update yang aktif
    await db.update(clients)
      .set({ isOnline: false })
      .where(eq(clients.clientType, 'HOTSPOT'))

    let created = 0, updated = 0, skipped = 0

    for (const lease of leases) {
      const mac = (lease['mac-address'] || '').toLowerCase().trim()
      const ip = lease.address
      const hostName = lease['host-name'] || ''
      const serverName = (lease.server || '').toLowerCase()

      if (!mac || !ip) {
        skipped++
        continue
      }

      // === ATURAN FILTER KETAT: Exclude HP/Laptop Hotspot User biasa ===
      // Hanya terima lease dari server DHCP khusus TR-069 / management
      // Exclude pool hotspot (seperti dhcp2, hotspot, hs-vlan, dll.)
      const isMgmtPool = serverName.includes('tr069') || serverName.includes('tr-069') || 
                         serverName.includes('mgmt') || serverName.includes('management') || 
                         serverName.includes('olt') || serverName.includes('pon') || 
                         ip.startsWith('192.168.30.') // Subnet management dari screenshot

      const isClientHotspotPool = serverName.includes('hotspot') || serverName.includes('hs-') || 
                                  serverName.includes('dhcp2') || ip.startsWith('172.16.') // Pool HP hotspot user

      if (isClientHotspotPool && !isMgmtPool) {
        // Exclude HP client dari antrian modem
        skipped++
        continue
      }

      if (!isMgmtPool) {
        // Jika bukan di pool management, skip demi keamanan data
        skipped++
        continue
      }

      // === Langkah 3: Cross-Reference MAC DHCP vs PPPoE Active ===
      // Cari apakah MAC DHCP ini cocok (atau mirip 5-byte pertama) dengan PPPoE active
      const matchedPppoe = pppoeClients.find(p => isSameDeviceMac(p.mac, mac))

      if (matchedPppoe) {
        // MAC ini milik PPPoE user yang aktif. Ini modem yang sama!
        // Cari entri client di database berdasarkan PPPoE username atau MAC
        const existing = await db.select()
          .from(clients)
          .where(eq(clients.pppoeUsername, matchedPppoe.username))
          .limit(1)

        if (existing[0]) {
          // Update lanIp (IP management lokal) untuk client PPPoE yang sudah ada
          await db.update(clients)
            .set({ 
              lanIp: ip, 
              macAddress: existing[0].macAddress || mac, // Lengkapi MAC jika kosong
              isOnline: true 
            })
            .where(eq(clients.id, existing[0].id))
          updated++
          console.log(`[DHCP Sync] Satukan modem PPPoE & DHCP: ${existing[0].name} (PPPoE: ${matchedPppoe.username}) -> set lanIp: ${ip}`)
        } else {
          skipped++
        }
        continue
      }

      // === MAC tidak ada di PPPoE active → ini modem HOTSPOT / Non-PPPoE ===
      const clientName = hostName
        ? hostName.replace(/[^a-zA-Z0-9\-_. ]/g, '').trim()
        : `MODEM-${mac.toUpperCase().replace(/:/g, '').slice(-6)}`

      // Cek apakah sudah ada berdasarkan MAC address (atau MAC toleran)
      const existingClients = await db.select().from(clients)
      const existingByLanIp = existingClients.find(c => c.lanIp === ip)
      const existingByMac = existingClients.find(c => isSameDeviceMac(c.macAddress || '', mac))

      if (existingByLanIp) {
        await db.update(clients)
          .set({
            lanIp: ip,
            macAddress: existingByLanIp.macAddress || mac,
            clientType: existingByLanIp.pppoeUsername || existingByLanIp.snModem ? (existingByLanIp.clientType || 'PPPOE') : 'HOTSPOT',
            isOnline: true
          })
          .where(eq(clients.id, existingByLanIp.id))

        if (existingByLanIp.pppoeUsername || existingByLanIp.snModem) {
          await db.delete(clients)
            .where(and(
              eq(clients.lanIp, ip),
              eq(clients.clientType, 'HOTSPOT'),
              ne(clients.id, existingByLanIp.id),
              isNull(clients.lat),
              isNull(clients.lng)
            ))
        }

        updated++
        console.log(`[DHCP Sync] Lease ${ip} digabung ke record yang sudah ada: ${existingByLanIp.name}`)
      } else if (existingByMac) {
        // Update data modem hotspot yang sudah ada
        await db.update(clients)
          .set({
            lanIp: ip,
            clientType: existingByMac.pppoeUsername || existingByMac.snModem ? (existingByMac.clientType || 'PPPOE') : 'HOTSPOT',
            isOnline: true
          })
          .where(eq(clients.id, existingByMac.id))
        updated++
        console.log(`[DHCP Sync] HOTSPOT updated: ${existingByMac.name} → ${ip}`)
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
    
    // Setel semua client PPPoE menjadi offline terlebih dahulu sebelum meng-update yang aktif
    await db.update(clients)
      .set({ isOnline: false })
      .where(eq(clients.clientType, 'PPPOE'))

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

      // Bersihkan IP Publik dari record lama (agar tidak mengganggu visualisasi di UI)
      await db.update(clients)
        .set({ wanIp: null })
        .where(eq(clients.wanIp, '36.75.220.32'))

      // Filter IP Publik: jangan simpan IP Publik NAT sebagai wanIp Mikrotik
      const validWanIp = wanIp && !isPublicIp(wanIp) ? wanIp : null

      // Cari client berdasarkan pppoeUsername
      const existingByUsername = await db.select()
        .from(clients)
        .where(eq(clients.pppoeUsername, username))
        .limit(1)

      // Cari client berdasarkan MAC Address toleransi 5-byte
      const allClients = await db.select().from(clients)
      const existingByMac = macAddress ? allClients.find(c => isSameDeviceMac(c.macAddress || '', macAddress)) : null

      if (existingByUsername[0]) {
        // Update client yang sudah ada via PPPoE username
        await db.update(clients)
          .set({
            wanIp: validWanIp || existingByUsername[0].wanIp,
            macAddress: existingByUsername[0].macAddress || macAddress,
            isOnline: true
          })
          .where(eq(clients.id, existingByUsername[0].id))
        updated++
      } else if (existingByMac) {
        // SATUKAN! Jika data Inform ACS sudah masuk dengan MAC yang sama,
        // hubungkan dengan PPPoE username dari Mikrotik. Jangan buat data baru!
        await db.update(clients)
          .set({
            pppoeUsername: username,
            name: username, // Update nama menggunakan user PPPoE
            wanIp: validWanIp || existingByMac.wanIp,
            macAddress: existingByMac.macAddress || macAddress,
            isOnline: true
          })
          .where(eq(clients.id, existingByMac.id))
        
        // Hapus duplikat potensial jika ada record lain dengan username yang sama tapi kosong
        if (username) {
          await db.delete(clients)
            .where(and(
              eq(clients.pppoeUsername, username),
              ne(clients.id, existingByMac.id),
              isNull(clients.snModem)
            ))
        }
        updated++
        console.log(`[PPPoE Sync] Satukan data ACS (SN: ${existingByMac.snModem}) dengan PPPoE ${username} berdasarkan MAC`)
      } else {
        // Insert baru ke antrian jika benar-benar baru
        await db.insert(clients).values({
          name: username,
          pppoeUsername: username,
          wanIp: validWanIp,
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
      if (body.lanStatus !== undefined) clientUpdate.lanStatus = body.lanStatus || null
      if (body.associatedDevices !== undefined) clientUpdate.associatedDevices = body.associatedDevices ?? null
      if (body.brand !== undefined) clientUpdate.brand = body.brand || null
      if (body.modelName !== undefined) clientUpdate.modelName = body.modelName || null
      if (body.hardwareVersion !== undefined) clientUpdate.hardwareVersion = body.hardwareVersion || null
      if (body.softwareVersion !== undefined) clientUpdate.softwareVersion = body.softwareVersion || null
      if (body.rxPower !== undefined) clientUpdate.rxPower = body.rxPower || null
      if (body.txPower !== undefined) clientUpdate.txPower = body.txPower || null
      if (body.temperature !== undefined) clientUpdate.temperature = body.temperature || null
      if (body.voltage !== undefined) clientUpdate.voltage = body.voltage || null
      if (body.wanIp !== undefined) clientUpdate.wanIp = body.wanIp || null
      if (body.lanIp !== undefined) clientUpdate.lanIp = body.lanIp || null
      if (body.clientType !== undefined) clientUpdate.clientType = body.clientType || null
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

