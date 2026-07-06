const API_URL = (window.__BACKEND_URL__ || 'http://127.0.0.1:8787') + '/api';

// State sederhana untuk menyimpan token secara lokal
let authToken = localStorage.getItem('wiremap_token') || null;

const CLIENT_ENDPOINT_MISSING =
  'Endpoint Daftar Client belum tersedia di backend yang sedang berjalan. Restart/deploy backend terbaru lalu coba lagi.';

export const api = {
  setToken(token) {
    authToken = token;
    localStorage.setItem('wiremap_token', token);
  },
  
  logout() {
    authToken = null;
    localStorage.removeItem('wiremap_token');
  },

  async login(email, password) {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    
    if (!res.ok) throw new Error('Login gagal');
    const data = await res.json();
    this.setToken(data.token);
    return data;
  },

  async getDevices() {
    let res;
    let networkError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(`${API_URL}/protected/devices`, {
          headers: {
            'Authorization': `Bearer ${authToken}`
          }
        });
        break;
      } catch (err) {
        networkError = err;
        if (attempt === 0) {
          await new Promise(resolve => setTimeout(resolve, 700));
        }
      }
    }

    if (!res) {
      throw new Error(networkError?.message || 'Gagal menghubungi backend perangkat');
    }
    
    if (res.status === 401) {
      this.logout();
      throw new Error('Sesi berakhir');
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.details || errData.error || `Gagal mengambil perangkat (${res.status})`);
    }
    
    return res.json();
  },

  async addDevice(deviceData) {
    const res = await fetch(`${API_URL}/protected/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(deviceData)
    });
    
    if (res.status === 401) {
      this.logout();
      throw new Error('Sesi berakhir');
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.details || errData.error || `Gagal menyimpan perangkat (${res.status})`);
    }

    return res.json();
  },

  async getPppoeStatus() {
    const res = await fetch(`${API_URL}/protected/mikrotik/pppoe-status`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    if (!res.ok) throw new Error('Gagal menarik data PPPoE');
    return res.json();
  },

  async getPppoeCredential(username) {
    const res = await fetch(`${API_URL}/protected/mikrotik/pppoe-credential/${encodeURIComponent(username)}`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    const raw = await res.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }
    if (!res.ok) throw new Error(data.details || data.error || raw || 'Gagal mengambil credential PPPoE');
    return data;
  },

  async syncMikrotik() {
    const res = await fetch(`${API_URL}/protected/sync-real-mikrotik`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    const raw = await res.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('Endpoint sync tidak ditemukan. Backend Hono yang sedang jalan belum update/restart.')
      }
      if (res.status === 401) {
        throw new Error('Sesi login habis. Silakan login ulang.')
      }
      throw new Error(data.details || data.error || raw || `Gagal sync Mikrotik (${res.status})`);
    }
    return data;
  },

  // Sync DHCP lease - deteksi modem non-PPPoE (HOTSPOT)
  async syncDhcpLeases() {
    const res = await fetch(`${API_URL}/protected/sync-dhcp-leases`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    const raw = await res.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      throw new Error(data.details || data.error || raw || `Gagal sync DHCP (${res.status})`);
    }
    return data;
  },

  // Trigger CWMP sync ke modem berdasarkan IP (wanIp untuk PPPoE, lanIp untuk HOTSPOT)
  async syncModem(ip, deviceId = null) {
    const res = await fetch(`${API_URL}/protected/modem/${ip}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ deviceId })
    });
    const raw = await res.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      throw new Error(data.details || data.error || raw || `Gagal sync modem (${res.status})`);
    }
    return data;
  },

  async getModemSyncStatus() {
    const res = await fetch(`${API_URL}/protected/modem/sync-status`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    if (!res.ok) throw new Error('Gagal mengambil status sinkronisasi');
    return res.json();
  },

  async getClients(search = '') {
    const suffix = search ? `?search=${encodeURIComponent(search)}` : '';
    const res = await fetch(`${API_URL}/protected/clients${suffix}`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    if (res.status === 404) throw new Error(CLIENT_ENDPOINT_MISSING);
    if (!res.ok) throw new Error('Gagal mengambil daftar client');
    return res.json();
  },

  async getClientDetail(id) {
    const res = await fetch(`${API_URL}/protected/clients/${id}/detail`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error(CLIENT_ENDPOINT_MISSING);
    if (!res.ok) throw new Error(data.details || data.error || 'Gagal mengambil detail client');
    return data;
  },

  async informClient(id) {
    const res = await fetch(`${API_URL}/protected/clients/${id}/inform`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error(CLIENT_ENDPOINT_MISSING);
    if (!res.ok) throw new Error(data.details || data.error || 'Gagal trigger inform client');
    return data;
  },

  async discoverClientWan(id) {
    const res = await fetch(`${API_URL}/protected/clients/${id}/discover-wan`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error(CLIENT_ENDPOINT_MISSING);
    if (!res.ok) throw new Error(data.details || data.error || 'Gagal discovery WAN');
    return data;
  },

  async saveClientAdminConfig(id, payload) {
    const res = await fetch(`${API_URL}/protected/clients/${id}/admin-config`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error(CLIENT_ENDPOINT_MISSING);
    if (!res.ok) throw new Error(data.details || data.error || 'Gagal menyimpan admin config');
    return data;
  },

  async createClientWanPpp(id, payload) {
    const res = await fetch(`${API_URL}/protected/clients/${id}/create-wan-ppp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error(CLIENT_ENDPOINT_MISSING);
    if (!res.ok) throw new Error(data.details || data.error || 'Gagal membuat WAN PPP');
    return data;
  },

  async getSettings() {
    const res = await fetch(`${API_URL}/protected/settings`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    if (res.status === 401) {
      this.logout();
      throw new Error('Sesi berakhir');
    }
    if (!res.ok) throw new Error('Gagal mengambil konfigurasi');
    return res.json();
  },

  async saveSettings(settingsData) {
    const res = await fetch(`${API_URL}/protected/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(settingsData)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      this.logout();
      throw new Error('Sesi berakhir');
    }
    if (!res.ok) throw new Error(data.details || data.error || 'Gagal menyimpan konfigurasi');
    return data;
  },

  async testSettings(settingsData) {
    const res = await fetch(`${API_URL}/protected/settings/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(settingsData)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      this.logout();
      throw new Error('Sesi berakhir');
    }
    if (!res.ok || data.connected === false) {
      throw new Error(data.details || data.error || 'Gagal menguji koneksi Router API');
    }
    return data;
  },

  async clearMap() {
    const res = await fetch(`${API_URL}/protected/clear-map`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      this.logout();
      throw new Error('Sesi berakhir');
    }
    if (!res.ok) throw new Error(data.details || data.error || 'Gagal menghapus data peta');
    return data;
  },

  async updateDeviceParent(id, parentId, type) {
    const res = await fetch(`${API_URL}/protected/devices/${id}/update-parent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ parentId, type })
    });
    if (!res.ok) throw new Error('Gagal memperbarui jalur kabel');
    return res.json();
  },

  async updateDevice(id, deviceData) {
    const res = await fetch(`${API_URL}/protected/devices/${id}/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(deviceData)
    });
    if (!res.ok) throw new Error('Gagal memperbarui detail perangkat');
    return res.json();
  },

  async deleteDevice(id, type) {
    const res = await fetch(`${API_URL}/protected/devices/${id}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ type })
    });
    if (!res.ok) throw new Error('Gagal menghapus perangkat');
    return res.json();
  },

  async pushModemConfig(ip, configData) {
    const res = await fetch(`${API_URL}/protected/modem/${ip}/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(configData)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.details || data.error || 'Gagal mengirim konfigurasi ke modem');
    }
    return data;
  }
};
