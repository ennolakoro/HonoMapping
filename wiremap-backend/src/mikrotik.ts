// Helper function untuk memanggil RouterOS REST API (Tersedia di RouterOS v7.1+)

function getHeaders(username: string, password: string) {
  const credentials = btoa(`${username}:${password}`);
  return {
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/json'
  };
}

export interface MikrotikDhcpLease {
  address: string;          // IP yang diberikan modem (172.16.200.45)
  'mac-address': string;    // MAC Address modem
  server: string;           // Nama DHCP pool (VLAN200-HOTSPOT, dll)
  'host-name'?: string;     // Hostname dari DHCP request
  status: string;           // 'bound' = aktif
  comment?: string;
}

const BRIDGE_READ_TIMEOUT_MS = parseInt(
  (typeof process !== 'undefined' && process.env.BRIDGE_READ_TIMEOUT_MS) || '45000',
  10
);

function getBridgeHeaders(mikrotikIp: string, user: string, pass: string, extra: Record<string, string> = {}) {
  return {
    'x-wiremap-mikrotik-ip': mikrotikIp || '',
    'x-wiremap-mikrotik-user': user || '',
    'x-wiremap-mikrotik-pass': pass || '',
    ...extra
  };
}

/**
 * Mengambil daftar PPPoE Active dari Mikrotik.
 */
export async function getPppoeActive(
  mikrotikIp: string,
  user: string,
  pass: string,
  bridgeUrl?: string,
  timeoutMs = BRIDGE_READ_TIMEOUT_MS,
  noCache = false
): Promise<any[]> {
  // Karena Mikrotik V6 tidak punya REST API, kita pakai Bridge yang ditentukan atau default ke port 3005
  const url = `${bridgeUrl || 'http://127.0.0.1:3005'}/active`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: getBridgeHeaders(mikrotikIp, user, pass, noCache ? { 'x-wiremap-no-cache': '1' } : {}),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw new Error(`Bridge PPPoE active error: ${response.status} ${response.statusText}${raw ? `: ${raw}` : ''}`);
    }
    
    return await response.json(); // Array of objects
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError' || error.message.includes('abort')) {
      throw new Error(`Timeout ${Math.round(timeoutMs / 1000)} detik membaca PPPoE active dari bridge. Pastikan bridge berjalan dan API RouterOS port 8728 bisa diakses.`);
    }
    console.error("Gagal menarik data PPPoE:", error);
    throw error;
  }
}

/**
 * Mengambil daftar PPPoE Secret dari Mikrotik Bridge.
 * Dipakai untuk menampilkan username/password PPPoE di detail pelanggan.
 */
export async function getPppoeSecrets(mikrotikIp: string, user: string, pass: string, bridgeUrl?: string): Promise<any[]> {
  const url = `${bridgeUrl || 'http://127.0.0.1:3005'}/ppp-secrets`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BRIDGE_READ_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: getBridgeHeaders(mikrotikIp, user, pass),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw new Error(`Bridge PPP secret error: ${response.status} ${response.statusText}${raw ? `: ${raw}` : ''}`);
    }

    return await response.json();
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Timeout ${Math.round(BRIDGE_READ_TIMEOUT_MS / 1000)} detik membaca PPP secret dari bridge. Pastikan endpoint /ppp-secrets tersedia dan bridge bisa akses Mikrotik.`);
    }
    console.error("Gagal menarik PPP secret:", error);
    throw error;
  }
}

/**
 * Mengambil semua DHCP Lease aktif dari Mikrotik via Bridge.
 * Bridge menggunakan RouterOS API v6 (port 8728) dengan node-routeros.
 * Field kunci: 'mac-address', 'address', 'server', 'status'
 */
export async function getDhcpLeases(
  mikrotikIp: string,
  user: string,
  pass: string,
  bridgeUrl?: string
): Promise<MikrotikDhcpLease[]> {
  const url = `${bridgeUrl || 'http://127.0.0.1:3005'}/dhcp-leases`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BRIDGE_READ_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: getBridgeHeaders(mikrotikIp, user, pass),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw new Error(`Bridge DHCP Error: ${response.status} ${response.statusText}${raw ? `: ${raw}` : ''}`);
    }

    const leases: MikrotikDhcpLease[] = await response.json();
    // Hanya kembalikan yang berstatus 'bound' (aktif)
    return leases.filter(l => l.status === 'bound');
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Timeout ${Math.round(BRIDGE_READ_TIMEOUT_MS / 1000)} detik mengambil DHCP lease dari bridge. Pastikan bridge berjalan dan endpoint /dhcp-leases tersedia.`);
    }
    console.error("Gagal menarik data DHCP lease:", error);
    throw error;
  }
}

/**
 * Workaround: Menyuruh Mikrotik "mencolek" modem via /tool fetch
 * agar modem langsung mengirimkan request Inform ke Mini ACS kita.
 * Sekarang mendukung direct HTTP ke connectionRequestUrl sebagai Metode 1.
 */
export async function triggerModemCWMP(
  mikrotikIp: string,
  user: string,
  pass: string,
  modemIp: string,
  bridgeUrl?: string,
  connectionRequestUrl?: string | null
) {
  // Karena Mikrotik V6, kita arahkan ke jembatan yang ditentukan atau default ke 3005
  const url = `${bridgeUrl || 'http://127.0.0.1:3005'}/trigger-modem`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getBridgeHeaders(mikrotikIp, user, pass)
      },
      body: JSON.stringify({
        ip: modemIp,
        connectionRequestUrl: connectionRequestUrl || null,
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      const timeoutLike = response.status === 502 && /timed out|timeout|gagal trigger modem/i.test(raw);
      if (timeoutLike) {
        console.warn(`Bridge trigger-modem timeout untuk ${modemIp}. Inform tetap ditunggu dari modem. Detail: ${raw}`);
        return false;
      }
      throw new Error(`Bridge trigger-modem gagal (${response.status} ${response.statusText})${raw ? `: ${raw}` : ''}`);
    }
    
    return true;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.warn(`Timeout 30 detik saat memanggil bridge /trigger-modem untuk ${modemIp}. Inform tetap ditunggu dari modem.`);
      return false;
    }
    console.error("Gagal eksekusi tool fetch di Bridge:", error);
    throw error;
  }
}
