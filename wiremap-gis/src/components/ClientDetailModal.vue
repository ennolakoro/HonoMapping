<script setup>
import { ref, computed, watch } from 'vue'
import { api } from '../api'

const props = defineProps({
  isOpen: Boolean,
  device: Object,
  allDevices: Array
})

const emit = defineEmits(['close', 'start-route', 'delete-device'])

const isSavingDetails = ref(false)
const saveMessage = ref('')
const routeParentId = ref('')
const routeMessage = ref('')

const detailForm = ref({
  name: '',
  phone: '',
  pppoeUsername: '',
  snModem: '',
  lat: 0,
  lng: 0,
  capacity: '',
  portsCount: ''
})

watch(() => props.device, (device) => {
  if (!device) return
  saveMessage.value = ''
  routeMessage.value = ''
  routeParentId.value = device.parentId || ''
  detailForm.value = {
    name: device.name || '',
    phone: device.phone || '',
    pppoeUsername: device.pppoeUsername || '',
    snModem: device.snModem || '',
    lat: device.lat || 0,
    lng: device.lng || 0,
    capacity: device.capacity || '',
    portsCount: device.portsCount || ''
  }
}, { immediate: true })

const displayValue = (value, fallback = 'N/A') => {
  if (value === null || value === undefined || value === '') return fallback
  return value
}

const passwordValue = (value) => displayValue(value, 'Tidak tersimpan')

const formatTemp = (val) => {
  if (!val) return 'N/A'
  const num = parseFloat(val)
  if (Number.isNaN(num)) return val
  if (num > 1000) return (num / 1000).toFixed(1) + ' C'
  if (num > 150) return (num / 10).toFixed(1) + ' C'
  return num.toFixed(1) + ' C'
}

const formatVoltage = (val) => {
  if (!val) return 'N/A'
  const num = parseFloat(val)
  if (Number.isNaN(num)) return val
  if (num > 1000000) return (num / 1000000).toFixed(2) + ' V'
  if (num > 1000) return (num / 1000).toFixed(2) + ' V'
  return num.toFixed(2) + ' V'
}

const devicePath = computed(() => {
  if (!props.device || !props.allDevices) return []

  const path = []
  let current = props.device
  const visited = new Set()

  while (current) {
    if (visited.has(current.id)) break
    visited.add(current.id)
    path.unshift(current)
    if (!current.parentId) break
    current = props.allDevices.find(d => d.id === current.parentId)
  }

  return path
})

const connectedChildren = computed(() => {
  if (!props.device || !props.allDevices) return []
  return props.allDevices.filter(device => device.parentId === props.device.id)
})

const compatibleParents = computed(() => {
  if (!props.device || !props.allDevices) return []
  const options = props.allDevices.filter(device =>
    device.type !== 'CLIENT' &&
    device.id !== props.device.id &&
    device.lat &&
    device.lng
  )
  if (props.device.type === 'CLIENT') return options.filter(device => device.type === 'ODP')
  if (props.device.type === 'ODP') return options.filter(device => ['OLT', 'ODC', 'ODP'].includes(device.type))
  if (props.device.type === 'ODC') return options.filter(device => ['OLT', 'ODP'].includes(device.type))
  return []
})

const topologyPortItems = computed(() => {
  const rawCount = parseInt(props.device?.portsCount || props.device?.capacity || '', 10)
  const count = Number.isFinite(rawCount) && rawCount > 0
    ? rawCount
    : Math.max(connectedChildren.value.length, 8)

  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    child: connectedChildren.value[index] || null
  }))
})

const lanPortsList = computed(() => {
  if (!props.device?.lanStatus) {
    return [
      { name: 'LAN1', isUp: false, speed: 'Disconnected' },
      { name: 'LAN2', isUp: false, speed: 'Disconnected' },
      { name: 'LAN3', isUp: false, speed: 'Disconnected' },
      { name: 'LAN4', isUp: false, speed: 'Disconnected' }
    ]
  }

  return props.device.lanStatus.split(',').map(port => {
    const [name, statusSpeed = ''] = port.trim().split(':')
    const normalized = statusSpeed.toLowerCase()
    const isUp = !normalized.includes('nolink') && (normalized.includes('up') || normalized.includes('link'))
    const speedMatch = statusSpeed.match(/\((.*?)\)/)
    let speed = isUp ? (speedMatch?.[1] || '100 Mbps') : 'Disconnected'
    if (speed === '1000Mbps' || speed === '1Gbps') speed = '1 Gbps'
    if (speed === '100Mbps') speed = '100 Mbps'
    if (speed === '10Mbps') speed = '10 Mbps'
    return { name, isUp, speed }
  }).filter(Boolean)
})

const hasSavedModemData = computed(() => {
  const device = props.device
  if (!device) return false
  return [
    device.wifiSsid,
    device.wifiSsid5g,
    device.lanStatus,
    device.brand,
    device.modelName,
    device.hardwareVersion,
    device.softwareVersion,
    device.rxPower,
    device.txPower,
    device.temperature,
    device.voltage
  ].some(value => value !== null && value !== undefined && value !== '')
})

const statusTone = computed(() => hasSavedModemData.value
  ? 'is-saved'
  : 'is-pending')

const rxPowerClass = computed(() => {
  const rx = parseFloat(props.device?.rxPower)
  if (Number.isNaN(rx)) return 'is-neutral'
  return rx > -27 ? 'is-good' : 'is-bad'
})

const metricItems = computed(() => [
  { label: 'RX', value: props.device?.rxPower ? `${props.device.rxPower} dBm` : 'N/A', className: rxPowerClass.value },
  { label: 'TX', value: props.device?.txPower ? `${props.device.txPower} dBm` : 'N/A', className: 'is-info' },
  { label: 'Temp', value: formatTemp(props.device?.temperature), className: 'is-neutral' },
  { label: 'Volt', value: formatVoltage(props.device?.voltage), className: 'is-neutral' }
])

const handleSaveDetails = async () => {
  if (!props.device) return
  try {
    isSavingDetails.value = true
    saveMessage.value = ''
    await api.updateDevice(props.device.id, {
      type: props.device.type,
      name: detailForm.value.name,
      phone: detailForm.value.phone,
      pppoeUsername: detailForm.value.pppoeUsername,
      snModem: detailForm.value.snModem,
      lat: detailForm.value.lat,
      lng: detailForm.value.lng,
      capacity: detailForm.value.capacity,
      portsCount: detailForm.value.portsCount
    })
    saveMessage.value = 'Detail tersimpan'
    window.dispatchEvent(new CustomEvent('refresh-map'))
  } catch (err) {
    saveMessage.value = 'Gagal menyimpan: ' + err.message
  } finally {
    isSavingDetails.value = false
  }
}

const handleSaveRoute = async () => {
  if (!props.device) return
  try {
    routeMessage.value = ''
    await api.updateDeviceParent(props.device.id, routeParentId.value || null, props.device.type)
    routeMessage.value = 'Route diperbarui'
    window.dispatchEvent(new CustomEvent('refresh-map'))
  } catch (err) {
    routeMessage.value = 'Gagal update route: ' + err.message
  }
}

const handleRemoveRoute = async () => {
  if (!props.device) return
  const confirmed = confirm(`Putus route ${props.device.name}?`)
  if (!confirmed) return
  try {
    routeMessage.value = ''
    routeParentId.value = ''
    await api.updateDeviceParent(props.device.id, null, props.device.type)
    routeMessage.value = 'Route dilepas'
    window.dispatchEvent(new CustomEvent('refresh-map'))
  } catch (err) {
    routeMessage.value = 'Gagal hapus route: ' + err.message
  }
}
</script>

<template>
  <div v-if="isOpen" class="client-detail-overlay">
    <article class="client-detail-panel">
      <header class="detail-header">
        <div class="header-main">
          <div class="header-icon">
            <span class="material-symbols-outlined">{{ device?.type === 'CLIENT' ? 'router' : 'account_tree' }}</span>
          </div>
          <div class="header-copy">
            <h2>Detail Perangkat</h2>
            <div class="header-meta">
              <span>{{ device?.type || 'Unknown' }}</span>
              <span>{{ device?.name || 'Unknown' }}</span>
            </div>
          </div>
        </div>
        <div class="header-actions">
          <button
            v-if="device?.type !== 'CLIENT'"
            @click="emit('start-route', device)"
            class="icon-action"
            title="Tambah route dari perangkat ini"
          >
            <span class="material-symbols-outlined">route</span>
          </button>
          <button @click="emit('delete-device', device)" class="icon-action danger" title="Hapus perangkat">
            <span class="material-symbols-outlined">delete</span>
          </button>
          <button @click="emit('close')" class="icon-close" aria-label="Tutup detail">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
      </header>

      <div class="detail-body">
        <section v-if="device?.type === 'CLIENT'" class="status-card">
          <div class="section-title-row">
            <div>
              <span class="section-eyebrow">ACS Status</span>
              <h3>Parameter Modem</h3>
            </div>
            <span v-if="device?.type === 'CLIENT'" class="status-pill" :class="statusTone">
              {{ hasSavedModemData ? 'Tersimpan' : 'Belum inform' }}
            </span>
          </div>

          <div class="metric-grid">
            <div v-for="item in metricItems" :key="item.label" class="metric-card">
              <span>{{ item.label }}</span>
              <strong :class="item.className">{{ item.value }}</strong>
            </div>
          </div>

          <div class="status-line">
            <span>Status</span>
            <strong>ONLINE</strong>
          </div>
        </section>

        <section class="detail-card">
          <div class="section-title-row compact">
            <div>
              <span class="section-eyebrow">Pelanggan</span>
              <h3>Data Dasar</h3>
            </div>
            <span v-if="saveMessage" class="save-message" :class="{ 'is-error': saveMessage.startsWith('Gagal') }">
              {{ saveMessage }}
            </span>
          </div>

          <form @submit.prevent="handleSaveDetails" class="customer-form">
            <label class="form-field full">
              <span>Nama</span>
              <input v-model="detailForm.name" required />
            </label>

            <label v-if="device?.type === 'CLIENT'" class="form-field full">
              <span>No. WA</span>
              <input v-model="detailForm.phone" placeholder="08xxxxxxxxxx" />
            </label>

            <label v-if="device?.type === 'CLIENT'" class="form-field">
              <span>PPPoE</span>
              <input v-model="detailForm.pppoeUsername" />
            </label>

            <label v-if="device?.type === 'CLIENT'" class="form-field">
              <span>SN Modem</span>
              <input v-model="detailForm.snModem" class="mono" />
            </label>

            <button type="submit" :disabled="isSavingDetails" class="save-button">
              <span v-if="isSavingDetails" class="material-symbols-outlined spin">refresh</span>
              <span v-else class="material-symbols-outlined">save</span>
              Simpan Perubahan
            </button>
          </form>
        </section>

        <section v-if="device?.type !== 'OLT'" class="route-card">
          <div class="card-heading split">
            <div>
              <span class="material-symbols-outlined">route</span>
              <h3>Route</h3>
            </div>
            <button type="button" @click="handleRemoveRoute" :disabled="!device?.parentId" title="Hapus route">
              <span class="material-symbols-outlined">link_off</span>
            </button>
          </div>
          <div class="route-editor">
            <select v-model="routeParentId">
              <option value="">Tanpa uplink</option>
              <option v-for="parent in compatibleParents" :key="parent.id" :value="parent.id">
                {{ parent.name }} ({{ parent.type }})
              </option>
            </select>
            <button type="button" @click="handleSaveRoute">
              <span class="material-symbols-outlined">done</span>
            </button>
          </div>
          <div v-if="routeMessage" class="route-message" :class="{ 'is-error': routeMessage.startsWith('Gagal') }">
            {{ routeMessage }}
          </div>
        </section>

        <template v-if="device?.type === 'CLIENT'">
          <section class="info-card">
            <div class="card-heading">
              <span class="material-symbols-outlined">wifi</span>
              <h3>Wi-Fi</h3>
            </div>
            <div class="info-list">
              <div class="info-row"><span>SSID 2.4G</span><strong :title="device.wifiSsid">{{ displayValue(device.wifiSsid) }}</strong></div>
              <div class="info-row"><span>Password 2.4G</span><strong :title="device.wifiPassword">{{ passwordValue(device.wifiPassword) }}</strong></div>
              <div class="info-row"><span>SSID 5G</span><strong :title="device.wifiSsid5g">{{ displayValue(device.wifiSsid5g) }}</strong></div>
              <div class="info-row"><span>Password 5G</span><strong :title="device.wifiPassword5g">{{ passwordValue(device.wifiPassword5g) }}</strong></div>
            </div>
          </section>

          <section class="info-card">
            <div class="card-heading">
              <span class="material-symbols-outlined">memory</span>
              <h3>Modem</h3>
            </div>
            <div class="info-list">
              <div class="info-row"><span>Brand</span><strong :title="device.brand">{{ displayValue(device.brand) }}</strong></div>
              <div class="info-row"><span>Model</span><strong :title="device.modelName">{{ displayValue(device.modelName) }}</strong></div>
              <div class="info-row"><span>Hardware</span><strong>{{ displayValue(device.hardwareVersion) }}</strong></div>
              <div class="info-row"><span>Software</span><strong :title="device.softwareVersion">{{ displayValue(device.softwareVersion) }}</strong></div>
              <div class="info-row"><span>MAC</span><strong class="mono" :title="device.macAddress">{{ displayValue(device.macAddress) }}</strong></div>
              <div class="info-row"><span>WAN IP</span><strong class="mono">{{ displayValue(device.wanIp) }}</strong></div>
            </div>
          </section>

          <section class="info-card">
            <div class="card-heading split">
              <div>
                <span class="material-symbols-outlined">settings_ethernet</span>
                <h3>LAN & Session</h3>
              </div>
              <strong>{{ displayValue(device.associatedDevices, 0) }} device</strong>
            </div>
            <div class="lan-grid">
              <div v-for="port in lanPortsList" :key="port.name" class="lan-port" :class="{ 'is-up': port.isUp }">
                <span>{{ port.name }}</span>
                <strong>{{ port.speed }}</strong>
              </div>
            </div>
          </section>
        </template>

        <section v-else-if="device?.type === 'ODC' || device?.type === 'ODP'" class="info-card">
          <div class="card-heading">
            <span class="material-symbols-outlined">hub</span>
            <h3>Port {{ device?.type }}</h3>
          </div>
          <div class="port-box-grid">
            <span
              v-for="port in topologyPortItems"
              :key="port.number"
              class="port-box"
              :class="{ 'is-used': port.child }"
              :title="port.child ? `${port.child.type} - ${port.child.name}` : 'Kosong'"
            >
              {{ port.number }}
            </span>
          </div>
          <div class="info-list compact-info">
            <div class="info-row"><span>Koordinat</span><strong class="mono">{{ displayValue(device?.lat) }}, {{ displayValue(device?.lng) }}</strong></div>
          </div>
        </section>

        <section v-else class="info-card">
          <div class="card-heading">
            <span class="material-symbols-outlined">router</span>
            <h3>OLT</h3>
          </div>
          <div class="info-list">
            <div class="info-row"><span>Type</span><strong>{{ displayValue(device?.type) }}</strong></div>
            <div class="info-row"><span>Nama</span><strong>{{ displayValue(device?.name) }}</strong></div>
            <div class="info-row"><span>Koordinat</span><strong class="mono">{{ displayValue(device?.lat) }}, {{ displayValue(device?.lng) }}</strong></div>
          </div>
        </section>

        <section class="topology-card">
          <div class="card-heading">
            <span class="material-symbols-outlined">account_tree</span>
            <h3>Alur Topologi</h3>
          </div>
          <div class="topology-flow">
            <template v-for="(node, index) in devicePath" :key="node.id">
              <div class="flow-node" :class="`type-${node.type}`">
                <span class="flow-dot"></span>
                <strong>{{ node.type }}</strong>
                <small>{{ node.name }}</small>
              </div>
              <span v-if="index < devicePath.length - 1" class="flow-link">
                <span class="material-symbols-outlined">east</span>
              </span>
            </template>
          </div>
        </section>
      </div>
    </article>
  </div>
</template>

<style scoped>
.client-detail-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
  background: rgba(15, 23, 42, 0.4);
  backdrop-filter: blur(6px);
}

.client-detail-panel {
  width: min(420px, calc(100vw - 24px));
  max-height: calc(100vh - 40px);
  overflow: hidden;
  border: 1px solid rgba(59, 130, 246, 0.25);
  border-radius: 16px;
  background: rgba(10, 25, 47, 0.65);
  color: #e5edf8;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 40px rgba(59, 130, 246, 0.1);
  backdrop-filter: blur(25px) saturate(180%);
  display: flex;
  flex-direction: column;
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  background: rgba(15, 32, 66, 0.45);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.header-main,
.card-heading {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 10px;
}

.header-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  border-radius: 10px;
  background: rgba(59, 130, 246, 0.15);
  border: 1px solid rgba(96, 165, 250, 0.3);
  color: #93c5fd;
}

.header-icon .material-symbols-outlined,
.icon-close .material-symbols-outlined,
.icon-action .material-symbols-outlined {
  font-size: 20px;
}

.header-copy {
  min-width: 0;
}

.header-copy h2 {
  margin: 0;
  color: #f8fafc;
  font-size: 15px;
  font-weight: 800;
  line-height: 1.15;
}

.header-meta {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  color: #94a3b8;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.header-meta span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-transform: none;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
}

.icon-close,
.icon-action {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 9px;
  background: rgba(15, 23, 42, 0.6);
  color: #cbd5e1;
  cursor: pointer;
  outline: none;
}

.icon-action {
  color: #93c5fd;
}

.icon-action:hover {
  border-color: rgba(96, 165, 250, 0.5);
  color: #bfdbfe;
}

.icon-action.danger {
  color: #fca5a5;
}

.icon-action.danger:hover {
  border-color: rgba(248, 113, 113, 0.6);
  color: #fecaca;
}

.icon-close:hover {
  border-color: rgba(248, 113, 113, 0.6);
  color: #fca5a5;
}

.detail-body {
  flex: 1;
  max-height: calc(100vh - 110px);
  overflow-x: hidden;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.status-card,
.detail-card,
.info-card,
.topology-card,
.route-card {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.03);
  padding: 14px;
  backdrop-filter: blur(10px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.section-title-row,
.card-heading.split {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.section-title-row.compact {
  margin-bottom: 10px;
}

.section-eyebrow {
  display: block;
  margin-bottom: 3px;
  color: #60a5fa;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h3 {
  margin: 0;
  color: #f8fafc;
  font-size: 13px;
  font-weight: 800;
}

.status-pill {
  flex: 0 0 auto;
  border-radius: 999px;
  border: 1px solid;
  padding: 3px 8px;
  font-size: 9px;
  font-weight: 900;
  text-transform: uppercase;
}

.status-pill.is-saved {
  border-color: rgba(52, 211, 153, 0.4);
  background: rgba(16, 185, 129, 0.12);
  color: #6ee7b7;
}

.status-pill.is-pending {
  border-color: rgba(251, 191, 36, 0.4);
  background: rgba(245, 158, 11, 0.12);
  color: #fde68a;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 12px;
}

.metric-card {
  min-width: 0;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.2);
  padding: 10px;
}

.metric-card span,
.form-field span {
  display: block;
  margin-bottom: 5px;
  color: #94a3b8;
  font-size: 10px;
  font-weight: 900;
  text-transform: uppercase;
}

.metric-card strong {
  display: block;
  overflow: hidden;
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  font-weight: 900;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.is-good {
  color: #34d399 !important;
}

.is-bad {
  color: #f87171 !important;
}

.is-info {
  color: #93c5fd !important;
}

.is-neutral {
  color: #e2e8f0 !important;
}

.status-line {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  color: #94a3b8;
  font-size: 12px;
}

.status-line strong {
  color: #34d399;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.save-message {
  max-width: 140px;
  overflow: hidden;
  color: #6ee7b7;
  font-size: 11px;
  font-weight: 800;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.save-message.is-error {
  color: #fca5a5;
}

.customer-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-field {
  min-width: 0;
}

.form-field input {
  width: 100%;
  min-width: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.25);
  color: #f8fafc;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 600;
  outline: none;
  transition: all 0.2s ease;
}

.form-field input::placeholder {
  color: #64748b;
}

.form-field input:focus {
  border-color: rgba(59, 130, 246, 0.6);
  background: rgba(0, 0, 0, 0.4);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.save-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 0;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
  font-size: 12px;
  font-weight: 900;
  min-height: 38px;
  margin-top: 4px;
  transition: background-color 0.2s ease;
}

.save-button:hover {
  background: #1d4ed8;
}

.save-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.save-button .material-symbols-outlined {
  font-size: 17px;
}

.route-editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 36px;
  gap: 7px;
}

.route-editor select {
  width: 100%;
  min-width: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.25);
  color: #f8fafc;
  padding: 10px;
  font-size: 12px;
  font-weight: 600;
  outline: none;
}

.route-editor button,
.card-heading.split > button {
  display: grid;
  place-items: center;
  border: 1px solid rgba(52, 211, 153, 0.25);
  border-radius: 10px;
  background: rgba(16, 185, 129, 0.15);
  color: #86efac;
  cursor: pointer;
}

.card-heading.split > button {
  width: 32px;
  height: 32px;
  border-color: rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.15);
  color: #fca5a5;
}

.card-heading.split > button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.route-editor .material-symbols-outlined,
.card-heading.split > button .material-symbols-outlined {
  font-size: 17px;
}

.route-message {
  margin-top: 10px;
  color: #86efac;
  font-size: 11px;
  font-weight: 800;
}

.route-message.is-error {
  color: #fca5a5;
}

.card-heading {
  margin-bottom: 10px;
  color: #93c5fd;
}

.card-heading h3 {
  font-size: 13px;
}

.card-heading .material-symbols-outlined {
  font-size: 18px;
}

.card-heading.split > div {
  display: flex;
  align-items: center;
  gap: 10px;
}

.card-heading.split > strong {
  flex: 0 0 auto;
  border-radius: 999px;
  background: rgba(59, 130, 246, 0.14);
  color: #bfdbfe;
  padding: 4px 8px;
  font-size: 11px;
}

.info-list {
  display: grid;
  gap: 7px;
}

.info-row {
  display: grid;
  grid-template-columns: minmax(90px, 0.8fr) minmax(0, 1.2fr);
  align-items: center;
  gap: 12px;
  font-size: 12px;
}

.info-row span {
  color: #94a3b8;
}

.info-row strong {
  min-width: 0;
  overflow: hidden;
  color: #f8fafc;
  font-size: 12px;
  font-weight: 800;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compact-info {
  margin-top: 10px;
}

.port-box-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 6px;
}

.port-box {
  display: grid;
  place-items: center;
  min-height: 28px;
  border: 1px solid rgba(52, 211, 153, 0.25);
  border-radius: 6px;
  background: rgba(16, 185, 129, 0.08);
  color: #a7f3d0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 700;
}

.port-box.is-used {
  border-color: rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.08);
  color: #fecaca;
}

.lan-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.lan-port {
  display: grid;
  gap: 4px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.2);
  padding: 8px 10px;
}

.lan-port span {
  color: #e2e8f0;
  font-size: 11px;
  font-weight: 900;
}

.lan-port strong {
  overflow: hidden;
  color: #94a3b8;
  font-size: 10px;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lan-port.is-up {
  border-color: rgba(52, 211, 153, 0.38);
  background: rgba(16, 185, 129, 0.1);
}

.lan-port.is-up strong {
  color: #6ee7b7;
}

.topology-flow {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}

.flow-node {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.15);
  padding: 8px 12px;
}

.flow-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #60a5fa;
  box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.1);
  flex-shrink: 0;
}

.flow-node.type-ODC .flow-dot {
  background: #a78bfa;
  box-shadow: 0 0 0 4px rgba(167, 139, 250, 0.1);
}

.flow-node.type-ODP .flow-dot {
  background: #fb923c;
  box-shadow: 0 0 0 4px rgba(251, 146, 60, 0.1);
}

.flow-node.type-CLIENT .flow-dot {
  background: #34d399;
  box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.1);
}

.flow-node strong {
  color: #f8fafc;
  font-size: 11px;
  font-weight: 900;
  text-transform: uppercase;
}

.flow-node small {
  color: #94a3b8;
  font-size: 11px;
  font-weight: 800;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}

.flow-link {
  display: flex;
  justify-content: center;
  color: rgba(59, 130, 246, 0.5);
  transform: rotate(90deg);
  margin: -4px 0;
}

.flow-link .material-symbols-outlined {
  font-size: 16px;
}

.spin {
  animation: detail-spin 0.9s linear infinite;
}

@keyframes detail-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
