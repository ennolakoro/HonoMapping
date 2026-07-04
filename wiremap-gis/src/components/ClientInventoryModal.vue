<script setup>
import { computed, ref, watch } from 'vue'
import { api } from '../api'

const props = defineProps({
  isOpen: Boolean
})

const emit = defineEmits(['close'])

const clients = ref([])
const selectedClient = ref(null)
const search = ref('')
const isLoading = ref(false)
const listError = ref('')
const actionMessage = ref('')
const actionState = ref('idle')
const actionProgress = ref(0)
const isDiscovering = ref(false)
const isInforming = ref(false)
const isPushingConfig = ref(false)
const isSavingAdmin = ref(false)

const cpeForm = ref({
  pppoeUsername: '',
  pppoePassword: '',
  wifiSsid: '',
  wifiPassword: '',
  wifiSsid5g: '',
  wifiPassword5g: ''
})

const adminForm = ref({
  username: '',
  password: ''
})

let pollTimer = null

const display = (value, fallback = 'N/A') => {
  if (value === null || value === undefined || value === '') return fallback
  return value
}

const masked = (value) => value ? '••••••••' : 'Tidak tersimpan'

const formatDate = (value) => {
  if (!value) return 'Belum Inform'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const normalize = (value) => String(value ?? '').trim()

const selectedWanRows = computed(() => Array.isArray(selectedClient.value?.wanConfig) ? selectedClient.value.wanConfig : [])
const selectedWifiRows = computed(() => {
  const configRadios = selectedClient.value?.wifiConfig?.radios
  if (Array.isArray(configRadios) && configRadios.length) return configRadios
  if (!selectedClient.value) return []
  return [
    {
      band: '2.4G',
      ssid: selectedClient.value.wifiSsid,
      password: selectedClient.value.wifiPassword,
      associatedDevices: selectedClient.value.associatedDevices
    },
    {
      band: '5G',
      ssid: selectedClient.value.wifiSsid5g,
      password: selectedClient.value.wifiPassword5g,
      associatedDevices: null
    }
  ]
})

const syncFormsFromClient = () => {
  const client = selectedClient.value
  cpeForm.value = {
    pppoeUsername: client?.pppoeUsername || '',
    pppoePassword: '',
    wifiSsid: client?.wifiSsid || '',
    wifiPassword: '',
    wifiSsid5g: client?.wifiSsid5g || '',
    wifiPassword5g: ''
  }
  adminForm.value = {
    username: client?.adminUsername || '',
    password: client?.adminPassword || ''
  }
}

const loadClients = async () => {
  isLoading.value = true
  listError.value = ''
  try {
    clients.value = await api.getClients(search.value)
    if (selectedClient.value) {
      const current = clients.value.find(client => client.id === selectedClient.value.id)
      if (current) selectedClient.value = { ...selectedClient.value, ...current }
    }
  } catch (err) {
    listError.value = err.message || 'Gagal mengambil daftar client'
  } finally {
    isLoading.value = false
  }
}

const selectClient = async (client) => {
  actionMessage.value = ''
  actionState.value = 'idle'
  actionProgress.value = 0
  try {
    selectedClient.value = await api.getClientDetail(client.id)
    syncFormsFromClient()
  } catch (err) {
    actionMessage.value = 'Gagal buka detail: ' + err.message
    actionState.value = 'failed'
  }
}

const waitForClientSync = async (client, label = 'Menunggu modem Inform...') => {
  const keys = [client.triggerIp, String(client.id)].filter(Boolean)
  const timeoutAt = Date.now() + 120000
  while (Date.now() < timeoutAt) {
    await new Promise(resolve => setTimeout(resolve, 2500))
    const statusMap = await api.getModemSyncStatus()
    const status = keys.map(key => statusMap[key]).find(Boolean)
    if (!status) {
      actionMessage.value = label
      actionProgress.value = Math.max(actionProgress.value, 15)
      actionState.value = 'waiting'
      continue
    }
    actionProgress.value = Number(status.progress || actionProgress.value || 10)
    actionState.value = status.status || 'waiting'
    if (status.status === 'failed') throw new Error(status.error || 'Modem tidak mengirim Inform')
    if (status.status === 'success') {
      actionProgress.value = 100
      actionState.value = 'success'
      selectedClient.value = await api.getClientDetail(client.id)
      await loadClients()
      syncFormsFromClient()
      return
    }
    actionMessage.value = status.status === 'fetching'
      ? 'Modem mengirim data, menyimpan konfigurasi...'
      : 'Menghubungi modem...'
  }
  throw new Error('Timeout menunggu modem mengirim data')
}

const discoverWan = async () => {
  if (!selectedClient.value) return
  const clientId = selectedClient.value.id
  isDiscovering.value = true
  actionMessage.value = 'Mengirim trigger discovery WAN...'
  actionProgress.value = 10
  actionState.value = 'triggered'
  try {
    const response = await api.discoverClientWan(clientId)
    if (response?.queued) {
      actionMessage.value = 'Trigger masuk antrian. Menunggu Inform berikutnya dari modem...'
    }
    await waitForClientSync(selectedClient.value, 'Menunggu modem mengirim WAN configuration...')
    actionMessage.value = 'WAN configuration diperbarui'
  } catch (err) {
    const message = err.message || ''
    try {
      selectedClient.value = await api.getClientDetail(clientId)
      await loadClients()
      syncFormsFromClient()
    } catch (_) {}

    const hasWanData = Array.isArray(selectedClient.value?.wanConfig) && selectedClient.value.wanConfig.length > 0
    const isInformDelay = /Inform|Timeout|antrian|colek|Connection Request/i.test(message)
    if (isInformDelay) {
      actionMessage.value = hasWanData
        ? 'Modem belum mengirim Inform terbaru. Data WAN terakhir tetap ditampilkan.'
        : 'Discovery WAN sudah diantrikan. Data WAN akan muncul setelah modem mengirim Inform berikutnya.'
      actionProgress.value = hasWanData ? 100 : Math.max(actionProgress.value, 35)
      actionState.value = hasWanData ? 'success' : 'waiting'
      return
    }

    actionMessage.value = 'Gagal ambil data WAN: ' + message
    actionProgress.value = 100
    actionState.value = 'failed'
  } finally {
    isDiscovering.value = false
  }
}

const informClient = async () => {
  if (!selectedClient.value) return
  const clientId = selectedClient.value.id
  isInforming.value = true
  actionMessage.value = 'Mengirim trigger Inform...'
  actionProgress.value = 10
  actionState.value = 'triggered'
  try {
    const response = await api.informClient(clientId)
    if (response?.queued) {
      actionMessage.value = 'Trigger masuk antrian. Menunggu Inform berikutnya dari modem...'
    }
    await waitForClientSync(selectedClient.value, 'Menunggu modem mengirim data terbaru...')
    actionMessage.value = 'Data modem diperbarui'
  } catch (err) {
    const message = err.message || ''
    try {
      selectedClient.value = await api.getClientDetail(clientId)
      await loadClients()
      syncFormsFromClient()
    } catch (_) {}

    if (/Inform|Timeout|antrian|colek|Connection Request/i.test(message)) {
      actionMessage.value = 'Inform sudah diantrikan. Data akan diperbarui otomatis saat modem mengirim Inform berikutnya.'
      actionProgress.value = Math.max(actionProgress.value, 35)
      actionState.value = 'waiting'
      return
    }

    actionMessage.value = 'Gagal Inform: ' + message
    actionProgress.value = 100
    actionState.value = 'failed'
  } finally {
    isInforming.value = false
  }
}

const addChangedParam = (params, formValue, currentValue, name) => {
  const next = normalize(formValue)
  if (!next || next === normalize(currentValue)) return
  params.push({ name, value: next, type: 'string' })
}

const pushCpeConfig = async () => {
  const client = selectedClient.value
  if (!client?.triggerIp) {
    actionMessage.value = 'Gagal: IP management modem belum tersedia'
    actionState.value = 'failed'
    actionProgress.value = 100
    return
  }

  const params = []
  addChangedParam(params, cpeForm.value.pppoeUsername, client.pppoeUsername, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username')
  if (cpeForm.value.pppoePassword) {
    params.push({ name: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password', value: normalize(cpeForm.value.pppoePassword), type: 'string' })
  }
  addChangedParam(params, cpeForm.value.wifiSsid, client.wifiSsid, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID')
  if (cpeForm.value.wifiPassword) {
    params.push({ name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', value: normalize(cpeForm.value.wifiPassword), type: 'string' })
  }
  addChangedParam(params, cpeForm.value.wifiSsid5g, client.wifiSsid5g, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID')
  if (cpeForm.value.wifiPassword5g) {
    params.push({ name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase', value: normalize(cpeForm.value.wifiPassword5g), type: 'string' })
  }

  if (!params.length) {
    actionMessage.value = 'Tidak ada perubahan untuk dikirim'
    actionState.value = 'idle'
    actionProgress.value = 0
    return
  }

  isPushingConfig.value = true
  actionMessage.value = 'Mengirim konfigurasi CPE...'
  actionProgress.value = 10
  actionState.value = 'triggered'
  try {
    await api.pushModemConfig(client.triggerIp, { deviceId: client.pseudoId, params })
    await waitForClientSync(client, 'Menunggu modem menerapkan konfigurasi...')
    actionMessage.value = 'Konfigurasi CPE berhasil diterapkan'
  } catch (err) {
    actionMessage.value = 'Gagal push konfigurasi: ' + err.message
    actionProgress.value = 100
    actionState.value = 'failed'
  } finally {
    isPushingConfig.value = false
  }
}

const saveAdminConfig = async () => {
  if (!selectedClient.value) return
  isSavingAdmin.value = true
  actionMessage.value = ''
  try {
    await api.saveClientAdminConfig(selectedClient.value.id, adminForm.value)
    selectedClient.value = await api.getClientDetail(selectedClient.value.id)
    await loadClients()
    syncFormsFromClient()
    actionMessage.value = 'Admin config tersimpan'
    actionState.value = 'success'
  } catch (err) {
    actionMessage.value = 'Gagal simpan admin config: ' + err.message
    actionState.value = 'failed'
  } finally {
    isSavingAdmin.value = false
  }
}

watch(() => props.isOpen, (isOpen) => {
  if (isOpen) {
    loadClients()
  } else if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<template>
  <div v-if="isOpen" class="client-inventory-overlay" @click.self="emit('close')">
    <section class="client-inventory-panel">
      <header class="client-inventory-header">
        <div class="client-inventory-title">
          <span class="material-symbols-outlined">manage_accounts</span>
          <div>
            <h2>Daftar Client</h2>
            <p>Inventori modem, WAN, WiFi, dan konfigurasi CPE</p>
          </div>
        </div>
        <button class="client-close" type="button" @click="emit('close')">
          <span class="material-symbols-outlined">close</span>
        </button>
      </header>

      <div class="client-inventory-toolbar">
        <label class="client-search">
          <span class="material-symbols-outlined">search</span>
          <input v-model="search" @keyup.enter="loadClients" placeholder="Cari Client" />
        </label>
        <button type="button" @click="loadClients" :disabled="isLoading">
          <span class="material-symbols-outlined" :class="{ spin: isLoading }">refresh</span>
          Refresh
        </button>
      </div>

      <div v-if="listError" class="client-alert is-error">{{ listError }}</div>

      <div class="client-inventory-layout">
        <div class="client-table-wrap">
          <table class="client-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>PPP Username</th>
                <th>RX Power</th>
                <th>Uptime</th>
                <th>IP WAN</th>
                <th>SN</th>
                <th>Product</th>
                <th>Last Inform</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!clients.length">
                <td colspan="9" class="empty-cell">Tidak ada client.</td>
              </tr>
              <tr
                v-for="client in clients"
                :key="client.id"
                :class="{ active: selectedClient?.id === client.id }"
              >
                <td><span class="status-pill" :class="client.isOnline ? 'online' : 'offline'">{{ client.status }}</span></td>
                <td class="mono">{{ display(client.pppoeUsername, '-') }}</td>
                <td class="mono" :class="{ good: parseFloat(client.rxPower) > -27 }">{{ client.rxPower ? `${client.rxPower} dBm` : '-' }}</td>
                <td>{{ display(client.uptime, '-') }}</td>
                <td class="mono">{{ display(client.wanIp || client.lanIp, '-') }}</td>
                <td class="mono">{{ display(client.snModem, '-') }}</td>
                <td>{{ display(client.product, '-') }}</td>
                <td>{{ formatDate(client.lastInformAt) }}</td>
                <td><button type="button" class="view-btn" @click="selectClient(client)">Lihat</button></td>
              </tr>
            </tbody>
          </table>
        </div>

        <aside class="client-detail-side">
          <div v-if="!selectedClient" class="client-detail-empty">
            <span class="material-symbols-outlined">touch_app</span>
            <strong>Pilih client</strong>
            <p>Klik Lihat pada tabel untuk membuka detail modem.</p>
          </div>

          <template v-else>
            <div class="detail-head">
              <div>
                <span class="eyebrow">{{ selectedClient.clientType }}</span>
                <h3>{{ selectedClient.name }}</h3>
              </div>
              <div class="detail-head-actions">
                <button type="button" @click="informClient" :disabled="isInforming">
                  <span class="material-symbols-outlined" :class="{ spin: isInforming }">sensors</span>
                  Inform
                </button>
                <span class="status-pill" :class="selectedClient.isOnline ? 'online' : 'offline'">{{ selectedClient.status }}</span>
              </div>
            </div>

            <div v-if="actionMessage" class="client-action-state" :class="`is-${actionState}`">
              <div class="action-line">
                <span>{{ actionMessage }}</span>
                <strong>{{ Math.round(actionProgress) }}%</strong>
              </div>
              <div class="action-track"><div :style="{ width: `${actionProgress}%` }"></div></div>
            </div>

            <section class="detail-section">
              <h4>Detail Perangkat</h4>
              <div class="detail-grid">
                <span>Brand</span><strong>{{ display(selectedClient.brand) }}</strong>
                <span>Model</span><strong>{{ display(selectedClient.modelName) }}</strong>
                <span>SN</span><strong class="mono">{{ display(selectedClient.snModem) }}</strong>
                <span>Software</span><strong>{{ display(selectedClient.softwareVersion) }}</strong>
                <span>MAC</span><strong class="mono">{{ display(selectedClient.macAddress) }}</strong>
              </div>
            </section>

            <section class="detail-section">
              <div class="section-split">
                <h4>WAN Config</h4>
                <button type="button" @click="discoverWan" :disabled="isDiscovering">
                  <span class="material-symbols-outlined" :class="{ spin: isDiscovering }">download</span>
                  Ambil Data
                </button>
              </div>
              <div v-if="!selectedWanRows.length" class="empty-wan">WAN PPP belum ditemukan.</div>
              <table v-else class="mini-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Conn Name</th>
                    <th>VLAN</th>
                    <th>Username</th>
                    <th>Password</th>
                    <th>NAT</th>
                    <th>Status</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(wan, index) in selectedWanRows" :key="wan.path || index">
                    <td>{{ display(wan.type, '-') }}</td>
                    <td>{{ display(wan.name, '-') }}</td>
                    <td>{{ display(wan.vlanId, '-') }}</td>
                    <td class="mono">{{ display(wan.username, '-') }}</td>
                    <td class="mono">{{ masked(wan.password) }}</td>
                    <td>{{ display(wan.nat, '-') }}</td>
                    <td>{{ display(wan.status || wan.enable, '-') }}</td>
                    <td class="mono">{{ display(wan.ipAddress, '-') }}</td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section class="detail-section">
              <h4>WiFi Config</h4>
              <table class="mini-table">
                <thead>
                  <tr>
                    <th>Band</th>
                    <th>SSID</th>
                    <th>Password</th>
                    <th>Client</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="wifi in selectedWifiRows" :key="wifi.band">
                    <td>{{ wifi.band }}</td>
                    <td>{{ display(wifi.ssid, '-') }}</td>
                    <td>{{ masked(wifi.password) }}</td>
                    <td>{{ display(wifi.associatedDevices, '-') }}</td>
                  </tr>
                </tbody>
              </table>

              <form class="cpe-form" @submit.prevent="pushCpeConfig">
                <input v-model="cpeForm.pppoeUsername" placeholder="PPPoE Username" />
                <input v-model="cpeForm.pppoePassword" type="password" placeholder="PPPoE Password baru" />
                <input v-model="cpeForm.wifiSsid" placeholder="SSID 2.4GHz" />
                <input v-model="cpeForm.wifiPassword" placeholder="Password 2.4GHz baru" />
                <input v-model="cpeForm.wifiSsid5g" placeholder="SSID 5GHz" />
                <input v-model="cpeForm.wifiPassword5g" placeholder="Password 5GHz baru" />
                <button type="submit" :disabled="isPushingConfig">
                  <span class="material-symbols-outlined" :class="{ spin: isPushingConfig }">send</span>
                  Push ke Modem
                </button>
              </form>
            </section>

            <section class="detail-section">
              <h4>Admin Config</h4>
              <form class="admin-form" @submit.prevent="saveAdminConfig">
                <input v-model="adminForm.username" placeholder="Username login modem" />
                <input v-model="adminForm.password" placeholder="Password login modem" />
                <button type="submit" :disabled="isSavingAdmin">
                  <span class="material-symbols-outlined" :class="{ spin: isSavingAdmin }">save</span>
                  Simpan Admin
                </button>
              </form>
            </section>
          </template>
        </aside>
      </div>
    </section>
  </div>
</template>

<style scoped>
.client-inventory-overlay {
  position: fixed;
  inset: 0;
  z-index: 140;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: rgba(2, 6, 23, 0.58);
  backdrop-filter: blur(8px);
}

.client-inventory-panel {
  width: min(1360px, 96vw);
  height: min(760px, 90vh);
  overflow: hidden;
  border: 1px solid rgba(125, 211, 252, 0.2);
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(15, 23, 42, 0.94), rgba(8, 47, 73, 0.9));
  color: #e2e8f0;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
}

.client-inventory-header,
.client-inventory-toolbar,
.section-split,
.detail-head,
.action-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.client-inventory-header {
  height: 64px;
  padding: 0 18px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
}

.client-inventory-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.client-inventory-title > span {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border: 1px solid rgba(56, 189, 248, 0.24);
  border-radius: 12px;
  background: rgba(14, 165, 233, 0.12);
  color: #67e8f9;
}

.client-inventory-title h2,
.detail-head h3 {
  margin: 0;
  font-size: 18px;
}

.client-inventory-title p {
  margin: 2px 0 0;
  color: #94a3b8;
  font-size: 11px;
}

.client-close,
.client-inventory-toolbar button,
.section-split button,
.detail-head-actions button,
.view-btn,
.cpe-form button,
.admin-form button {
  border: 0;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 900;
}

.client-close {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  background: rgba(15, 23, 42, 0.75);
  color: #cbd5e1;
}

.client-inventory-toolbar {
  padding: 12px 18px;
}

.client-search {
  display: flex;
  align-items: center;
  flex: 1;
  gap: 8px;
  max-width: 420px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.68);
  padding: 8px 10px;
}

.client-search input {
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: #e2e8f0;
  font-size: 12px;
}

.client-inventory-toolbar button,
.section-split button,
.detail-head-actions button,
.cpe-form button,
.admin-form button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: #0ea5e9;
  color: white;
  font-size: 11px;
}

.detail-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.client-inventory-layout {
  display: grid;
  grid-template-columns: minmax(620px, 1fr) 470px;
  gap: 14px;
  height: calc(100% - 120px);
  padding: 0 18px 18px;
}

.client-table-wrap,
.client-detail-side {
  min-width: 0;
  overflow: auto;
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.52);
}

.client-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.client-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: rgba(15, 23, 42, 0.98);
  color: #7dd3fc;
  text-align: left;
  text-transform: uppercase;
  font-size: 9px;
}

.client-table th,
.client-table td {
  padding: 10px 9px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.1);
  white-space: nowrap;
}

.client-table tr.active,
.client-table tbody tr:hover {
  background: rgba(14, 165, 233, 0.1);
}

.status-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 9px;
  font-weight: 900;
}

.status-pill.online {
  background: rgba(16, 185, 129, 0.16);
  color: #6ee7b7;
}

.status-pill.offline {
  background: rgba(248, 113, 113, 0.14);
  color: #fca5a5;
}

.view-btn {
  background: rgba(59, 130, 246, 0.2);
  color: #bfdbfe;
  padding: 6px 10px;
}

.client-detail-side {
  padding: 14px;
}

.client-detail-empty {
  display: grid;
  height: 100%;
  place-items: center;
  align-content: center;
  gap: 8px;
  color: #94a3b8;
  text-align: center;
}

.detail-section {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 10px;
  background: rgba(2, 6, 23, 0.28);
}

.detail-section h4 {
  margin: 0 0 10px;
  color: #bae6fd;
  font-size: 12px;
}

.detail-grid {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 7px 10px;
  font-size: 11px;
}

.detail-grid span {
  color: #94a3b8;
}

.detail-grid strong,
.mono {
  min-width: 0;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-overflow: ellipsis;
}

.mini-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
}

.mini-table th,
.mini-table td {
  padding: 7px 6px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.1);
  text-align: left;
}

.mini-table th {
  color: #93c5fd;
  font-size: 9px;
}

.empty-wan,
.empty-cell,
.client-alert {
  padding: 14px;
  color: #94a3b8;
  font-size: 12px;
}

.client-alert.is-error {
  color: #fca5a5;
}

.cpe-form,
.admin-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.cpe-form input,
.admin-form input {
  min-width: 0;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 8px;
  outline: 0;
  background: rgba(15, 23, 42, 0.65);
  color: #e2e8f0;
  padding: 8px 10px;
  font-size: 11px;
}

.cpe-form button,
.admin-form button {
  grid-column: 1 / -1;
  justify-content: center;
}

.client-action-state {
  margin-top: 10px;
  padding: 10px;
  border: 1px solid rgba(56, 189, 248, 0.2);
  border-radius: 10px;
  background: rgba(14, 165, 233, 0.08);
  font-size: 11px;
}

.client-action-state.is-failed {
  border-color: rgba(248, 113, 113, 0.24);
  background: rgba(248, 113, 113, 0.08);
}

.action-track {
  height: 6px;
  overflow: hidden;
  margin-top: 8px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.8);
}

.action-track div {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #0ea5e9, #22d3ee, #34d399);
  transition: width 0.35s ease;
}

.eyebrow {
  color: #38bdf8;
  font-size: 9px;
  font-weight: 900;
  text-transform: uppercase;
}

.good {
  color: #6ee7b7;
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 980px) {
  .client-inventory-layout {
    grid-template-columns: 1fr;
  }

  .client-detail-side {
    min-height: 420px;
  }
}
</style>
