// Helper function untuk memanggil RouterOS REST API (Tersedia di RouterOS v7.1+)

function getHeaders(username: string, password: string) {
  const credentials = btoa(`${username}:${password}`);
  return {
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/json'
  };
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
