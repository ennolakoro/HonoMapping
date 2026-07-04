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
const pppoeCredential = ref(null)
const pppoeCredentialStatus = ref('')

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
  pppoeCredential.value = null
  pppoeCredentialStatus.value = ''
  routeParentId.value = device.parentId || ''
  detailForm.value = {
    name: device.name || '',
    phone: device.phone || '',
    pppoeUsername: device.pppoeUsername || '',
    snModem: device.snModem || '',
    lat: device.lat ? parseFloat(Number(device.lat).toFixed(6)) : 0,
    lng: device.lng ? parseFloat(Number(device.lng).toFixed(6)) : 0,
    capacity: device.capacity || '',
    portsCount: device.portsCount || ''
  }
}, { immediate: true })

watch(() => [props.isOpen, props.device?.pppoeUsername], async ([isOpen, username]) => {
  pppoeCredential.value = null
  pppoeCredentialStatus.value = ''
  if (!isOpen || !username) return

  try {
    pppoeCredentialStatus.value = 'Memuat PPPoE...'
    pppoeCredential.value = await api.getPppoeCredential(username)
    pppoeCredentialStatus.value = ''
  } catch (err) {
    pppoeCredentialStatus.value = err.message || 'Gagal mengambil PPPoE'
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

const connectedHostsList = computed(() =>
  Array.isArray(props.device?.connectedHosts) ? props.device.connectedHosts : []
)

const wifiActiveCount = computed(() => {
  const associated = Number(props.device?.associatedDevices)
  if (Number.isFinite(associated) && associated > 0) return associated
  return connectedHostsList.value.filter(host => host?.active !== false).length
})

const hasHostList = computed(() => connectedHostsList.value.length > 0)

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

const showConfigForm = ref(false)
const isPushingConfig = ref(false)
const configMessage = ref('')
const configForm = ref({
  pppoeUsername: '',
  pppoePassword: '',
  wifiSsid: '',
  wifiPassword: '',
  wifiSsid5g: '',
  wifiPassword5g: ''
})

const resetConfigFormFromDevice = (device = props.device) => {
  configForm.value = {
    pppoeUsername: device?.pppoeUsername || '',
    pppoePassword: '',
    wifiSsid: device?.wifiSsid || '',
    wifiPassword: device?.wifiPassword || '',
    wifiSsid5g: device?.wifiSsid5g || '',
    wifiPassword5g: device?.wifiPassword5g || ''
  }
}

watch(() => props.device?.id, () => {
  if (!showConfigForm.value) return
  resetConfigFormFromDevice()
  configMessage.value = ''
})

const handleOpenConfig = () => {
  showConfigForm.value = !showConfigForm.value
  if (showConfigForm.value) {
    resetConfigFormFromDevice()
    configMessage.value = ''
  }
}

const handlePushConfig = async () => {
  if (!props.device?.lanIp && !props.device?.wanIp) {
    configMessage.value = 'Gagal: IP Modem tidak diketahui.'
    return
  }

  isPushingConfig.value = true
  configMessage.value = 'Memproses...'

  try {
    const params = []
    
    if (configForm.value.pppoeUsername) {
      params.push({ name: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username', value: configForm.value.pppoeUsername, type: 'string' })
    }
    if (configForm.value.pppoePassword) {
      params.push({ name: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password', value: configForm.value.pppoePassword, type: 'string' })
    }
    if (configForm.value.wifiSsid) {
      params.push({ name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', value: configForm.value.wifiSsid, type: 'string' })
    }
    if (configForm.value.wifiPassword) {
      params.push({ name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', value: configForm.value.wifiPassword, type: 'string' })
    }
    if (configForm.value.wifiSsid5g) {
      params.push({ name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID', value: configForm.value.wifiSsid5g, type: 'string' })
    }
    if (configForm.value.wifiPassword5g) {
      params.push({ name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.PreSharedKey', value: configForm.value.wifiPassword5g, type: 'string' })
    }

    if (params.length === 0) {
      configMessage.value = 'Tidak ada parameter yang diisi.'
      isPushingConfig.value = false
      return
    }

    const payload = {
      deviceId: props.device.id,
      params
    }

    const targetIp = props.device.lanIp || props.device.wanIp
    const res = await api.pushModemConfig(targetIp, payload)
    
    configMessage.value = res.message || 'Konfigurasi terkirim.'
    // Sembunyikan form setelah 3 detik
    setTimeout(() => {
      showConfigForm.value = false
    }, 3000)
  } catch (err) {
    configMessage.value = 'Gagal mengirim: ' + err.message
  } finally {
    isPushingConfig.value = false
  }
}
</script>

<template>
  <div v-if="isOpen" class="client-detail-overlay" :class="{ 'is-client': device?.type === 'CLIENT' }">
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
        <!-- Status Online Client -->
        <div v-if="device?.type === 'CLIENT'" class="flex items-center justify-between mx-4 mt-2 mb-1.5 text-[11px] font-bold">
          <span class="text-slate-400">Status Koneksi</span>
          <strong :style="{ color: device?.isOnline ? '#34d399' : '#dc2626' }" class="uppercase font-black tracking-wider">
            ● {{ device?.isOnline ? 'ONLINE' : 'OFFLINE' }}
          </strong>
        </div>

        <!-- Compact Alur Topologi Diagram -->
        <div v-if="devicePath && devicePath.length" class="flex items-center flex-wrap gap-1 bg-white/5 border border-white/10 rounded-lg p-2.5 mb-4 text-[10px] text-slate-300 mx-4 mt-2">
          <span class="font-bold text-slate-400 mr-1 select-none flex items-center gap-0.5">
            <span class="material-symbols-outlined text-[12px] text-primary">account_tree</span>
            Topologi:
          </span>
          <template v-for="(node, index) in devicePath" :key="node.id">
            <span 
              class="font-black px-1.5 py-0.5 rounded text-[9px] cursor-pointer hover:bg-white/20 transition-all"
              :class="node.id === device?.id ? 'bg-primary text-white' : 'bg-white/10 text-slate-300'"
            >
              {{ node.name }}
            </span>
            <span v-if="index < devicePath.length - 1" class="text-slate-500 font-bold mx-0.5 select-none">➔</span>
          </template>
        </div>

        <section v-if="device?.type === 'CLIENT'" class="detail-card">
          <div class="section-title-row compact">
            <div>
              <span class="section-eyebrow">Pelanggan</span>
              <h3>Data Dasar</h3>
            </div>
            <span v-if="saveMessage" class="save-message" :class="{ 'is-error': saveMessage.startsWith('Gagal') }">
              {{ saveMessage }}
            </span>
          </div>

          <form @submit.prevent="handleSaveDetails" class="flex flex-col gap-2.5 mt-3">
            <div class="flex items-center text-[10px] gap-2">
              <span class="w-24 text-slate-400 font-bold text-left">Nama:</span>
              <input v-model="detailForm.name" required class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none transition-all" />
            </div>

            <div class="flex items-center text-[10px] gap-2">
              <span class="w-24 text-slate-400 font-bold text-left">Nomor Wa:</span>
              <input v-model="detailForm.phone" placeholder="08xxxxxxxxxx" class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none transition-all" />
            </div>



            <button type="submit" :disabled="isSavingDetails" class="save-button mt-2">
              <span v-if="isSavingDetails" class="material-symbols-outlined spin">refresh</span>
              <span v-else class="material-symbols-outlined">save</span>
              Simpan Perubahan
            </button>
          </form>
        </section>

        <!-- Konfigurasi TR-069 -->
        <section v-if="device?.type === 'CLIENT'" class="detail-card config-card">
          <div class="card-heading split">
            <div>
              <span class="material-symbols-outlined">settings_suggest</span>
              <h3>Konfigurasi CPE</h3>
            </div>
            <button @click="handleOpenConfig" class="icon-action outline" :class="{ 'is-active': showConfigForm }">
              <span class="material-symbols-outlined">{{ showConfigForm ? 'expand_less' : 'tune' }}</span>
            </button>
          </div>
          
          <div v-if="showConfigForm" class="config-form-container mt-3">
            <span v-if="configMessage" class="save-message mb-3" :class="{ 'is-error': configMessage.startsWith('Gagal') }">
              {{ configMessage }}
            </span>
            <form @submit.prevent="handlePushConfig" class="flex flex-col gap-2.5 mt-3">
              <div class="flex items-center text-[10px] gap-2">
                <span class="w-32 text-slate-400 font-bold text-left">PPPoE Username:</span>
                <input v-model="configForm.pppoeUsername" placeholder="username@isp" class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none transition-all" />
              </div>
              <div class="flex items-center text-[10px] gap-2">
                <span class="w-32 text-slate-400 font-bold text-left">PPPoE Password:</span>
                <input v-model="configForm.pppoePassword" type="password" placeholder="Biarkan kosong jika tidak diubah" class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none transition-all" />
              </div>
              
              <div class="divider-line my-1.5"></div>
              
              <div class="flex items-center text-[10px] gap-2">
                <span class="w-32 text-slate-400 font-bold text-left">SSID 2.4GHz:</span>
                <input v-model="configForm.wifiSsid" placeholder="Nama WiFi 2.4G" class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none transition-all" />
              </div>
              <div class="flex items-center text-[10px] gap-2">
                <span class="w-32 text-slate-400 font-bold text-left">Password 2.4GHz:</span>
                <input v-model="configForm.wifiPassword" type="text" placeholder="Biarkan kosong jika tidak diubah" class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none transition-all" />
              </div>

              <div class="flex items-center text-[10px] gap-2">
                <span class="w-32 text-slate-400 font-bold text-left">SSID 5GHz:</span>
                <input v-model="configForm.wifiSsid5g" placeholder="Nama WiFi 5G" class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none transition-all" />
              </div>
              <div class="flex items-center text-[10px] gap-2">
                <span class="w-32 text-slate-400 font-bold text-left">Password 5GHz:</span>
                <input v-model="configForm.wifiPassword5g" type="text" placeholder="Biarkan kosong jika tidak diubah" class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none transition-all" />
              </div>

              <button type="submit" :disabled="isPushingConfig" class="save-button push-btn mt-3 text-[10px]">
                <span v-if="isPushingConfig" class="material-symbols-outlined spin text-[12px]">refresh</span>
                <span v-else class="material-symbols-outlined text-[12px]">send</span>
                Push ke Modem (TR-069)
              </button>
            </form>
          </div>
        </section>

        <!-- Node ODP / ODC Section -->
        <section v-else-if="device?.type === 'ODC' || device?.type === 'ODP'" class="detail-card node-card">
          <div class="card-heading split">
            <div>
              <span class="material-symbols-outlined">hub</span>
              <h3>{{ device?.type }}</h3>
            </div>
            <span v-if="saveMessage" class="save-message" :class="{ 'is-error': saveMessage.startsWith('Gagal') }">
              {{ saveMessage }}
            </span>
          </div>

          <form @submit.prevent="handleSaveDetails" class="flex flex-col gap-2.5 mt-3 text-[10px]">
            <div class="flex items-center gap-2">
              <span class="w-20 text-slate-400 font-bold text-left">Nama:</span>
              <input v-model="detailForm.name" required class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none transition-all" />
            </div>
            
            <div class="flex items-center gap-2">
              <span class="w-20 text-slate-400 font-bold text-left">Uplink:</span>
              <div class="flex-1 route-editor-modern">
                <select v-model="routeParentId" @change="handleSaveRoute">
                  <option value="">Tanpa uplink</option>
                  <option v-for="parent in compatibleParents" :key="parent.id" :value="parent.id">
                    {{ parent.name }} ({{ parent.type }})
                  </option>
                </select>
                <button v-if="routeParentId" type="button" @click.prevent="handleRemoveRoute" title="Hapus Uplink" class="btn-remove-route">
                  <span class="material-symbols-outlined">link_off</span>
                </button>
              </div>
            </div>
            <div v-if="routeMessage" class="route-message mt-1" :class="{ 'is-error': routeMessage.startsWith('Gagal') }">
              {{ routeMessage }}
            </div>

            <div class="flex items-center gap-2">
              <span class="w-20 text-slate-400 font-bold text-left">Lat:</span>
              <input v-model.number="detailForm.lat" type="number" step="any" required class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none font-mono transition-all" />
            </div>

            <div class="flex items-center gap-2">
              <span class="w-20 text-slate-400 font-bold text-left">Long:</span>
              <input v-model.number="detailForm.lng" type="number" step="any" required class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none font-mono transition-all" />
            </div>

            <button type="submit" :disabled="isSavingDetails" class="save-button mt-2 text-[10px]">
              <span v-if="isSavingDetails" class="material-symbols-outlined spin text-[12px]">refresh</span>
              <span v-else class="material-symbols-outlined text-[12px]">save</span>
              Simpan
            </button>
          </form>

          <div class="port-section mt-4">
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
          </div>
        </section>

        <!-- OLT Section -->
        <section v-else class="detail-card node-card">
          <div class="card-heading split">
            <div>
              <span class="material-symbols-outlined">dns</span>
              <h3>Server OLT</h3>
            </div>
            <span v-if="saveMessage" class="save-message" :class="{ 'is-error': saveMessage.startsWith('Gagal') }">
              {{ saveMessage }}
            </span>
          </div>

          <form @submit.prevent="handleSaveDetails" class="flex flex-col gap-2.5 mt-3 text-[10px]">
            <div class="flex items-center gap-2">
              <span class="w-24 text-slate-400 font-bold text-left">Nama Server:</span>
              <input v-model="detailForm.name" required class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none transition-all" />
            </div>

            <div class="flex items-center gap-2">
              <span class="w-24 text-slate-400 font-bold text-left">Lat:</span>
              <input v-model.number="detailForm.lat" type="number" step="any" required class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none font-mono transition-all" />
            </div>

            <div class="flex items-center gap-2">
              <span class="w-24 text-slate-400 font-bold text-left">Long:</span>
              <input v-model.number="detailForm.lng" type="number" step="any" required class="flex-1 bg-white/5 hover:bg-white/10 focus:bg-white/15 border border-white/10 rounded px-2.5 py-1.5 text-[10px] text-white outline-none font-mono transition-all" />
            </div>

            <button type="submit" :disabled="isSavingDetails" class="save-button mt-2 text-[10px]">
              <span v-if="isSavingDetails" class="material-symbols-outlined spin text-[12px]">refresh</span>
              <span v-else class="material-symbols-outlined text-[12px]">save</span>
              Simpan
            </button>
          </form>
        </section>

        <section v-if="device?.type === 'CLIENT' && device?.pppoeUsername" class="info-card">
          <div class="card-heading split">
            <div>
              <span class="material-symbols-outlined">vpn_key</span>
              <h3>PPPoE Aktif</h3>
            </div>
            <strong :class="{ 'is-online': pppoeCredential?.isActive }">
              {{ pppoeCredential?.isActive ? 'Active' : 'Offline' }}
            </strong>
          </div>
          <div class="info-list">
            <div class="info-row"><span>User</span><strong class="mono">{{ displayValue(pppoeCredential?.username || device.pppoeUsername) }}</strong></div>
            <div class="info-row"><span>Password</span><strong class="mono" :title="pppoeCredential?.password">{{ passwordValue(pppoeCredential?.password) }}</strong></div>
            <div class="info-row"><span>IP Aktif</span><strong class="mono">{{ displayValue(pppoeCredential?.address || device.wanIp || device.lanIp) }}</strong></div>
            <div class="info-row"><span>Uptime</span><strong>{{ displayValue(pppoeCredential?.uptime) }}</strong></div>
          </div>
          <div v-if="pppoeCredentialStatus || pppoeCredential?.secretError || pppoeCredential?.activeError" class="credential-note">
            {{ pppoeCredentialStatus || pppoeCredential?.secretError || pppoeCredential?.activeError }}
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
              <div class="info-row"><span>SN Modem</span><strong class="mono" :title="device.snModem">{{ displayValue(device.snModem) }}</strong></div>
              <div class="info-row"><span>Hardware</span><strong>{{ displayValue(device.hardwareVersion) }}</strong></div>
              <div class="info-row"><span>Software</span><strong :title="device.softwareVersion">{{ displayValue(device.softwareVersion) }}</strong></div>
              <div class="info-row"><span>MAC</span><strong class="mono" :title="device.macAddress">{{ displayValue(device.macAddress) }}</strong></div>
              <div class="info-row"><span>WAN IP</span><strong class="mono">{{ displayValue(device.wanIp || pppoeCredential?.address) }}</strong></div>
              <div class="info-row"><span>Mgmt IP</span><strong class="mono">{{ displayValue(device.lanIp) }}</strong></div>
            </div>
          </section>

          <section class="info-card network-hosts-card">
            <div class="card-heading split">
              <div>
                <span class="material-symbols-outlined">devices</span>
                <h3>Perangkat Terhubung</h3>
              </div>
              <div class="host-count-badge">
                <strong>{{ wifiActiveCount }}</strong> WiFi Aktif
              </div>
            </div>
            
            <div class="lan-grid mb-3">
              <div v-for="port in lanPortsList" :key="port.name" class="lan-port" :class="{ 'is-up': port.isUp }">
                <span>{{ port.name }}</span>
                <strong>{{ port.speed }}</strong>
              </div>
            </div>

            <div v-if="hasHostList" class="hosts-list">
              <div v-for="(host, idx) in connectedHostsList" :key="idx" class="host-item" :class="{ 'is-active': host.active }">
                <div class="host-icon">
                  <span class="material-symbols-outlined">
                    {{ String(host.hostname || '').toLowerCase().includes('android') || String(host.hostname || '').toLowerCase().includes('iphone') || String(host.hostname || '').toLowerCase().includes('phone') ? 'smartphone' : 'laptop_mac' }}
                  </span>
                </div>
                <div class="host-details">
                  <div class="host-name">{{ host.hostname || 'Device' }}</div>
                  <div class="host-ip mono">{{ host.ip }}</div>
                  <div class="host-mac mono">{{ host.mac }}</div>
                </div>
                <div class="host-status">
                  <span class="status-dot"></span>
                </div>
              </div>
            </div>
            <div v-else-if="wifiActiveCount > 0" class="hosts-empty">
              {{ wifiActiveCount }} perangkat WiFi aktif terdeteksi, tetapi modem tidak membuka daftar nama/IP host melalui TR-069.
            </div>
            <div v-else class="hosts-empty">
              Tidak ada data perangkat yang ditarik dari modem. Coba Refresh.
            </div>
          </section>

          <!-- ACS Status / Parameter Modem moved here -->
          <section v-if="device?.type === 'CLIENT'" class="status-card mt-4">
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

          </section>
        </template>


      </div>
    </article>
  </div>
</template>

<style scoped>
.client-detail-overlay {
  position: fixed;
  top: 80px;
  right: 24px;
  bottom: 24px;
  width: 300px;
  max-width: calc(100vw - 48px);
  z-index: 1000;
  display: flex;
  justify-content: flex-end;
  pointer-events: none;
  transition: width 0.3s ease;
}

.client-detail-overlay.is-client {
  width: 340px;
}

.client-detail-panel {
  width: 100%;
  height: fit-content;
  max-height: 100%;
  overflow-y: auto;
  border: 1px solid rgba(59, 130, 246, 0.25);
  border-radius: 16px;
  background: rgba(10, 25, 47, 0.85);
  color: #e5edf8;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5), 0 0 40px rgba(59, 130, 246, 0.1);
  backdrop-filter: blur(25px) saturate(180%);
  display: flex;
  flex-direction: column;
  pointer-events: auto;
  animation: scaleInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes scaleInRight {
  from { transform: translateX(20px) scale(0.95); opacity: 0; }
  to { transform: translateX(0) scale(1); opacity: 1; }
}

.detail-header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px;
  background: rgba(15, 32, 66, 0.85);
  backdrop-filter: blur(10px);
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
  font-size: 12px;
  font-weight: 800;
  line-height: 1.15;
}

.header-meta {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  color: #94a3b8;
  font-size: 9px;
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
  font-size: 8px;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h3 {
  margin: 0;
  color: #f8fafc;
  font-size: 11px;
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
  font-size: 8px;
  font-weight: 900;
  text-transform: uppercase;
}

.metric-card strong {
  display: block;
  overflow: hidden;
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
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

.card-heading.split > strong.is-online {
  background: rgba(16, 185, 129, 0.14);
  color: #86efac;
}

.credential-note {
  margin-top: 10px;
  border-radius: 9px;
  background: rgba(245, 158, 11, 0.1);
  color: #fde68a;
  padding: 8px;
  font-size: 11px;
  font-weight: 800;
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
  font-size: 10px;
}

.info-row span {
  color: #94a3b8;
}

.info-row strong {
  min-width: 0;
  overflow: hidden;
  color: #f8fafc;
  font-size: 10px;
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
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 4px;
}

.port-box {
  display: grid;
  place-items: center;
  height: 20px;
  border: 1px solid rgba(52, 211, 153, 0.25);
  border-radius: 4px;
  background: rgba(16, 185, 129, 0.08);
  color: #a7f3d0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 9px;
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
  font-size: 9px;
  font-weight: 900;
}

.lan-port strong {
  overflow: hidden;
  color: #94a3b8;
  font-size: 8.5px;
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

/* Modern Form Elements */
.node-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.route-editor-modern {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 6px;
}

.route-editor-modern select {
  flex: 1;
  background: rgba(15, 32, 66, 0.4);
  border: 1px solid rgba(59, 130, 246, 0.3);
  color: #f8fafc;
  padding: 8px 12px;
  border-radius: 8px;
  outline: none;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.2s;
}

.route-editor-modern select:focus {
  border-color: #60a5fa;
  background: rgba(15, 32, 66, 0.8);
}

.btn-remove-route {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  background: rgba(239, 68, 68, 0.1);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-remove-route:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
}

.compact-btn {
  margin-top: 8px;
}

/* Topology Tree */
.topology-tree {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 4px 8px;
}

.tree-node {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  background: rgba(15, 32, 66, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  position: relative;
  transition: all 0.2s;
}

.tree-node.is-current {
  background: rgba(59, 130, 246, 0.15);
  border-color: rgba(96, 165, 250, 0.4);
  box-shadow: 0 4px 20px rgba(59, 130, 246, 0.2);
}

.tree-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
}

.tree-node.type-OLT .tree-icon { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
.tree-node.type-ODC .tree-icon { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }
.tree-node.type-ODP .tree-icon { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
.tree-node.type-CLIENT .tree-icon { background: rgba(16, 185, 129, 0.2); color: #34d399; }

.tree-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.tree-info strong {
  font-size: 12px;
  font-weight: 800;
  color: #f8fafc;
  text-transform: uppercase;
}

.tree-info span {
  font-size: 12px;
  color: #94a3b8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-line {
  width: 2px;
  height: 24px;
  background: linear-gradient(to bottom, rgba(59, 130, 246, 0.4), rgba(59, 130, 246, 0.1));
  margin: 0 0 0 31px;
}

/* Connected Hosts List */
.network-hosts-card {
  padding-bottom: 20px;
}
.host-count-badge {
  font-size: 11px;
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid rgba(16, 185, 129, 0.3);
}
.hosts-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.host-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(15, 32, 66, 0.5);
  border: 1px solid rgba(148, 163, 184, 0.1);
  border-radius: 8px;
  transition: all 0.2s;
}
.host-item:hover {
  background: rgba(59, 130, 246, 0.1);
  border-color: rgba(59, 130, 246, 0.3);
}
.host-item.is-active {
  border-left: 3px solid #10b981;
}
.host-icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  color: #94a3b8;
}
.host-icon .material-symbols-outlined {
  font-size: 15px;
}
.host-item.is-active .host-icon {
  color: #34d399;
  background: rgba(16, 185, 129, 0.1);
}
.host-details {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.host-name {
  font-size: 11px;
  font-weight: 700;
  color: #f8fafc;
}
.host-ip, .host-mac {
  font-size: 9.5px;
  color: #94a3b8;
}
.host-status {
  display: flex;
  align-items: center;
  justify-content: center;
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #64748b;
}
.host-item.is-active .status-dot {
  background: #10b981;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
}
.hosts-empty {
  text-align: center;
  padding: 12px;
  font-size: 10px;
  color: #64748b;
  background: rgba(15, 32, 66, 0.3);
  border-radius: 8px;
  margin-top: 8px;
}

/* Config TR-069 Section */
.config-card {
  border: 1px solid rgba(59, 130, 246, 0.3);
  background: linear-gradient(to bottom, rgba(59, 130, 246, 0.08), rgba(15, 32, 66, 0.8));
}
.config-form-container {
  padding-top: 12px;
  border-top: 1px dashed rgba(255, 255, 255, 0.1);
  animation: fadeIn 0.3s ease;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}
.divider-line {
  width: 100%;
  height: 1px;
  background: rgba(255, 255, 255, 0.1);
  margin: 14px 0;
}
.push-btn {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  width: 100%;
}
.push-btn:hover {
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
  box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4);
}
</style>
