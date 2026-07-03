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

/**
 * Mengambil daftar PPPoE Active dari Mikrotik.
 */
export async function getPppoeActive(mikrotikIp: string, user: string, pass: string, bridgeUrl?: string): Promise<any[]> {
  // Karena Mikrotik V6 tidak punya REST API, kita pakai Bridge yang ditentukan atau default ke port 3005
  const url = `${bridgeUrl || 'http://127.0.0.1:3005'}/active`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 detik timeout

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`Mikrotik API Error: ${response.statusText}`);
    }
    
    return await response.json(); // Array of objects
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError' || error.message.includes('abort')) {
      throw new Error(`Koneksi ke Mikrotik RTO (Timeout 8 detik). Pastikan port REST API sudah benar (Biasanya 80/443, bukan 2001) dan tidak terblokir firewall.`);
    }
    console.error("Gagal menarik data PPPoE:", error);
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
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Bridge DHCP Error: ${response.status} ${response.statusText}`);
    }

    const leases: MikrotikDhcpLease[] = await response.json();
    // Hanya kembalikan yang berstatus 'bound' (aktif)
    return leases.filter(l => l.status === 'bound');
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Timeout saat mengambil DHCP lease dari bridge. Pastikan bridge berjalan dan endpoint /dhcp-leases tersedia.');
    }
    console.error("Gagal menarik data DHCP lease:", error);
    throw error;
  }
}

/**
 * Workaround: Menyuruh Mikrotik "mencolek" modem via /tool fetch
 * agar modem langsung mengirimkan request Inform ke Mini ACS kita.
 */
export async function triggerModemCWMP(mikrotikIp: string, user: string, pass: string, modemIp: string, bridgeUrl?: string) {
  // Karena Mikrotik V6, kita arahkan ke jembatan yang ditentukan atau default ke 3005
  const url = `${bridgeUrl || 'http://127.0.0.1:3005'}/trigger-modem`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: modemIp }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Gagal men-trigger modem: ${response.statusText}`);
    }
    
    return true;
  } catch (error: any) {
    clearTimeout(timeoutId);
    console.error("Gagal eksekusi tool fetch di Bridge:", error);
    throw error;
  }
}
