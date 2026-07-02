const API_URL = (window.__BACKEND_URL__ || 'http://127.0.0.1:8787') + '/api';

// State sederhana untuk menyimpan token secara lokal
let authToken = localStorage.getItem('wiremap_token') || null;

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
    const res = await fetch(`${API_URL}/protected/devices`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    
    if (res.status === 401) {
      this.logout();
      throw new Error('Sesi berakhir');
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

  async syncModem(ip) {
    const res = await fetch(`${API_URL}/protected/modem/${ip}/sync`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    if (!res.ok) throw new Error('Gagal sync modem');
    return res.json();
  },

  async getSettings() {
    const res = await fetch(`${API_URL}/protected/settings`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
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
    if (!res.ok) throw new Error('Gagal menyimpan konfigurasi');
    return res.json();
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
  }
};
