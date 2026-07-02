<script setup>
import { ref, computed, watch } from 'vue'
import { api } from '../api'

const props = defineProps({
  isOpen: Boolean,
  device: Object,
  allDevices: Array
})

const emit = defineEmits(['close'])

const isLoadingPppoe = ref(false)
const pppoeStatus = ref(null)

const isLoadingWifi = ref(false)
const wifiSyncStatus = ref('')

const isEditing = ref(false)
const isSavingDetails = ref(false)
const editForm = ref({
  name: '',
  pppoeUsername: '',
  snModem: '',
  wifiSsid: '',
  wifiPassword: '',
  wifiSsid5g: '',
  wifiPassword5g: '',
  lat: 0,
  lng: 0,
  capacity: '',
  portsCount: '',
  parentId: ''
})

// Populate editForm when device changes
watch(() => props.device, (newVal) => {
  if (newVal) {
    isEditing.value = false
    const currentParentId = newVal.type === 'CLIENT' ? newVal.parentId : newVal.parentId
    editForm.value = {
      name: newVal.name || '',
      pppoeUsername: newVal.pppoeUsername || '',
      snModem: newVal.snModem || '',
      wifiSsid: newVal.wifiSsid || '',
      wifiPassword: newVal.wifiPassword || '',
      wifiSsid5g: newVal.wifiSsid5g || '',
      wifiPassword5g: newVal.wifiPassword5g || '',
      lat: newVal.lat || 0,
      lng: newVal.lng || 0,
      capacity: newVal.capacity || '',
      portsCount: newVal.portsCount || '',
      parentId: newVal.type === 'CLIENT' ? newVal.parentId : newVal.parentId
    }
  }
}, { immediate: true })

// Hitung Alur (Path) dari OLT ke Perangkat ini
const devicePath = computed(() => {
  if (!props.device || !props.allDevices) return []
  
  const path = []
  let current = props.device
  
  // Mencegah infinite loop jika ada circular reference
  const visited = new Set()

  while (current) {
    if (visited.has(current.id)) break
    visited.add(current.id)
    
    path.unshift(current) // Tambahkan ke depan
    
    if (!current.parentId) break
    current = props.allDevices.find(d => d.id === current.parentId)
  }
  
  return path
})

// LAN Ports Status parser
const lanPortsList = computed(() => {
  if (!props.device?.lanStatus) {
    return [
      { name: 'LAN 1', isUp: false, speed: 'Disconnected' },
      { name: 'LAN 2', isUp: false, speed: 'Disconnected' },
      { name: 'LAN 3', isUp: false, speed: 'Disconnected' },
      { name: 'LAN 4', isUp: false, speed: 'Disconnected' }
    ]
  }
  return props.device.lanStatus.split(',').map(p => {
    const parts = p.trim().split(':');
    if (parts.length < 2) return null;
    const name = parts[0];
    const statusSpeed = parts[1];
    const isUp = statusSpeed.toLowerCase().includes('up') || statusSpeed.toLowerCase().includes('link');
    let speed = 'Down';
    if (isUp) {
      const speedMatch = statusSpeed.match(/\((.*?)\)/);
      speed = speedMatch ? speedMatch[1] : '100 Mbps'; // fallback
      if (speed === '1000Mbps' || speed === '1Gbps') speed = '1 Gbps';
      else if (speed === '100Mbps') speed = '100 Mbps';
      else if (speed === '10Mbps') speed = '10 Mbps';
    } else {
      speed = 'Disconnected';
    }
    return { name, isUp, speed };
  }).filter(Boolean);
})

// Filter compatible parents based on topology type
const compatibleParents = computed(() => {
  if (!props.device || !props.allDevices) return []
  if (props.device.type === 'CLIENT') {
    return props.allDevices.filter(d => d.type === 'ODP')
  }
  if (props.device.type === 'ODP') {
    return props.allDevices.filter(d => d.type === 'ODC')
  }
  if (props.device.type === 'ODC') {
    return props.allDevices.filter(d => d.type === 'OLT')
  }
  return []
})

// Formatting helpers
const formatTemp = (val) => {
  if (!val) return 'N/A';
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  if (num > 1000) return (num / 1000).toFixed(1) + ' °C';
  if (num > 150) return (num / 10).toFixed(1) + ' °C';
  return num.toFixed(1) + ' °C';
}

const formatVoltage = (val) => {
  if (!val) return 'N/A';
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  if (num > 1000000) return (num / 1000000).toFixed(2) + ' V';
  if (num > 1000) return (num / 1000).toFixed(2) + ' V';
  return num.toFixed(2) + ' V';
}

// Update Details & Connection (Jalur Kabel)
const handleSaveDetails = async () => {
  try {
    isSavingDetails.value = true
    
    // 1. Update parent/uplink if it changed
    const currentParentId = props.device.type === 'CLIENT' ? props.device.parentId : props.device.parentId
    if (editForm.value.parentId !== currentParentId) {
      await api.updateDeviceParent(props.device.id, editForm.value.parentId, props.device.type)
    }
    
    // 2. Update general details
    await api.updateDevice(props.device.id, {
      type: props.device.type,
      name: editForm.value.name,
      pppoeUsername: editForm.value.pppoeUsername,
      snModem: editForm.value.snModem,
      wifiSsid: editForm.value.wifiSsid,
      wifiPassword: editForm.value.wifiPassword,
      wifiSsid5g: editForm.value.wifiSsid5g,
      wifiPassword5g: editForm.value.wifiPassword5g,
      lat: editForm.value.lat,
      lng: editForm.value.lng,
      capacity: editForm.value.capacity,
      portsCount: editForm.value.portsCount
    })
    
    alert('Detail perangkat berhasil disimpan!')
    isEditing.value = false
    window.dispatchEvent(new CustomEvent('refresh-map'))
    emit('close')
  } catch (err) {
    alert('Gagal menyimpan detail: ' + err.message)
  } finally {
    isSavingDetails.value = false
  }
}

const handleGetPppoe = async () => {
  try {
    isLoadingPppoe.value = true
    pppoeStatus.value = null
    const data = await api.getPppoeStatus()
    
    if (Array.isArray(data)) {
      // Cari nama client yang mirip, atau tampilkan array
      const match = data.find(d => d.name === props.device?.name || true)
      pppoeStatus.value = match || { name: 'Unknown', address: '192.168.x.x', uptime: 'N/A' }
    } else {
      pppoeStatus.value = data
    }
  } catch (err) {
    alert(err.message)
  } finally {
    isLoadingPppoe.value = false
  }
}

const handleSyncWifi = async () => {
  if (!pppoeStatus.value?.address) {
    alert("Tarik data PPPoE terlebih dahulu untuk mendapatkan IP Modem!")
    return
  }
  
  try {
    isLoadingWifi.value = true
    wifiSyncStatus.value = "Mengirim sinyal ke Mikrotik..."
    const res = await api.syncModem(pppoeStatus.value.address)
    wifiSyncStatus.value = res.message || "Sinyal TR-069 berhasil dikirim. Menunggu balasan Modem..."
  } catch (err) {
    wifiSyncStatus.value = err.message
  } finally {
    isLoadingWifi.value = false
  }
}
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-[100] flex items-center justify-center bg-black bg-opacity-60 backdrop-blur-sm p-4">
    <div class="bg-surface-container-lowest p-6 rounded-2xl shadow-xl w-full max-w-lg border border-outline-variant max-h-[90vh] overflow-y-auto">
      
      <!-- Modal Header -->
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-2xl font-bold text-on-surface flex items-center gap-2">
          <span class="material-symbols-outlined text-primary">
            {{ isEditing ? 'edit_note' : 'info' }}
          </span>
          {{ isEditing ? 'Edit Detail Perangkat' : 'Detail Perangkat & Alur' }}
        </h2>
        <div class="flex items-center gap-2">
          <!-- Edit Toggle Button -->
          <button v-if="!isEditing" @click="isEditing = true" class="text-primary hover:bg-surface-container p-2 rounded-full transition-colors flex items-center justify-center border-none bg-transparent cursor-pointer" title="Edit Detail / Jalur Kabel">
            <span class="material-symbols-outlined text-[20px]">edit</span>
          </button>
          <button @click="emit('close')" class="text-on-surface-variant hover:text-error transition-colors p-2 rounded-full flex items-center justify-center border-none bg-transparent cursor-pointer">
            <span class="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
      </div>

      <!-- ================= EDIT MODE ================= -->
      <form v-if="isEditing" @submit.prevent="handleSaveDetails" class="flex flex-col gap-4">
        <!-- Nama Perangkat -->
        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">Nama Perangkat</label>
          <input v-model="editForm.name" type="text" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:ring-1 focus:ring-primary outline-none" required />
        </div>

        <!-- Lat & Lng -->
        <div class="grid grid-cols-2 gap-4">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">Latitude</label>
            <input v-model="editForm.lat" type="number" step="any" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:ring-1 focus:ring-primary outline-none" required />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">Longitude</label>
            <input v-model="editForm.lng" type="number" step="any" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:ring-1 focus:ring-primary outline-none" required />
          </div>
        </div>

        <!-- EDIT JALUR KABEL (UPLINK PARENT SELECT) -->
        <div class="flex flex-col gap-1.5" v-if="device?.type !== 'OLT'">
          <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase text-orange-500">Edit Jalur Kabel (Uplink Induk)</label>
          <select v-model="editForm.parentId" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:ring-1 focus:ring-orange-500 outline-none">
            <option value="">-- Putus Kabel (Tanpa Induk) --</option>
            <option v-for="p in compatibleParents" :key="p.id" :value="p.id">
              {{ p.name }} ({{ p.type }})
            </option>
          </select>
          <span class="text-[10px] text-on-surface-variant">*Merubah induk akan langsung memindahkan garis jalur kabel di peta.</span>
        </div>

        <!-- Dynamic ODC/ODP Fields -->
        <div v-if="device?.type === 'ODC'" class="flex flex-col gap-1.5">
          <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">Kapasitas (Core)</label>
          <input v-model="editForm.capacity" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:ring-1 focus:ring-primary outline-none" placeholder="Contoh: 144" />
        </div>
        <div v-if="device?.type === 'ODP'" class="flex flex-col gap-1.5">
          <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">Jumlah Port Splitter</label>
          <input v-model="editForm.portsCount" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:ring-1 focus:ring-primary outline-none" placeholder="Contoh: 8" />
        </div>

        <!-- Dynamic CLIENT Fields -->
        <div v-if="device?.type === 'CLIENT'" class="flex flex-col gap-4">
          <div class="grid grid-cols-2 gap-4">
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase text-blue-500">PPPoE Username</label>
              <input v-model="editForm.pppoeUsername" type="text" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:ring-1 focus:ring-blue-500 outline-none" />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase text-green-500">SN Modem (CWMP)</label>
              <input v-model="editForm.snModem" type="text" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:ring-1 focus:ring-green-500 outline-none" />
            </div>
          </div>

          <!-- Form Edit Wi-Fi 2.4G & 5G -->
          <div class="border-t border-outline-variant pt-3 flex flex-col gap-3">
            <span class="text-xs font-bold text-on-surface-variant uppercase tracking-wider block">Form Edit Wi-Fi (SSID/Password)</span>
            <div class="grid grid-cols-2 gap-4">
              <!-- 2.4G SSID -->
              <div class="flex flex-col gap-1.5">
                <label class="text-[10px] font-semibold text-on-surface-variant uppercase">Wi-Fi 2.4G SSID</label>
                <input v-model="editForm.wifiSsid" type="text" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-xs text-on-surface focus:ring-1 focus:ring-primary outline-none" />
              </div>
              <!-- 2.4G Pass -->
              <div class="flex flex-col gap-1.5">
                <label class="text-[10px] font-semibold text-on-surface-variant uppercase">Wi-Fi 2.4G Password</label>
                <input v-model="editForm.wifiPassword" type="text" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-xs text-on-surface focus:ring-1 focus:ring-primary outline-none" />
              </div>
              <!-- 5G SSID -->
              <div class="flex flex-col gap-1.5">
                <label class="text-[10px] font-semibold text-on-surface-variant uppercase">Wi-Fi 5G SSID</label>
                <input v-model="editForm.wifiSsid5g" type="text" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-xs text-on-surface focus:ring-1 focus:ring-primary outline-none" />
              </div>
              <!-- 5G Pass -->
              <div class="flex flex-col gap-1.5">
                <label class="text-[10px] font-semibold text-on-surface-variant uppercase">Wi-Fi 5G Password</label>
                <input v-model="editForm.wifiPassword5g" type="text" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-xs text-on-surface focus:ring-1 focus:ring-primary outline-none" />
              </div>
            </div>
          </div>
        </div>

        <!-- Edit Mode Actions -->
        <div class="flex gap-3 mt-4">
          <button @click="isEditing = false" type="button" class="flex-1 py-2.5 border border-outline-variant text-on-surface font-semibold rounded-lg hover:bg-surface-container text-sm transition-colors border-solid cursor-pointer">Batal</button>
          <button type="submit" :disabled="isSavingDetails" class="flex-1 py-2.5 bg-primary text-white font-semibold rounded-lg hover:opacity-90 shadow-sm text-sm disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer border-none">
            <span v-if="isSavingDetails" class="material-symbols-outlined animate-spin text-sm">refresh</span>
            Simpan Perubahan
          </button>
        </div>
      </form>

      <!-- ================= VIEW MODE ================= -->
      <div v-else class="flex flex-col gap-4">
        <!-- Info Dasar -->
        <div class="flex gap-4 items-start pb-4 border-b border-outline-variant border-dashed">
          <div class="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0"
               :class="{
                 'bg-blue-500/20 text-blue-500': device?.type === 'OLT',
                 'bg-purple-500/20 text-purple-500': device?.type === 'ODC',
                 'bg-orange-500/20 text-orange-500': device?.type === 'ODP',
                 'bg-green-500/20 text-green-500': device?.type === 'CLIENT',
               }">
             <span class="material-symbols-outlined font-bold text-2xl">
               {{ device?.type === 'OLT' ? 'dns' : device?.type === 'CLIENT' ? 'router' : 'hub' }}
             </span>
          </div>
          <div>
            <h3 class="text-xl font-bold text-on-surface">{{ device?.name || 'Unknown' }}</h3>
            <p class="text-xs font-semibold uppercase tracking-wider" 
               :class="{
                 'text-blue-500': device?.type === 'OLT',
                 'text-purple-500': device?.type === 'ODC',
                 'text-orange-500': device?.type === 'ODP',
                 'text-green-500': device?.type === 'CLIENT',
               }">
               {{ device?.type || 'Unknown' }}
            </p>
          </div>
        </div>

        <!-- UI layout for OLT, ODC, ODP (Infrastructure Modal) -->
        <div v-if="device?.type !== 'CLIENT'" class="flex flex-col gap-4">
          <!-- Spesifikasi Box -->
          <div class="bg-surface-container-low p-4 rounded-xl border border-outline-variant shadow-sm">
            <h4 class="font-bold text-on-surface mb-3 flex items-center gap-2">
               <span class="material-symbols-outlined text-[18px]">info</span> Informasi Infrastruktur
            </h4>
            <div class="grid grid-cols-2 gap-y-3 gap-x-4 text-sm font-mono">
              <div v-if="device?.capacity">
                <span class="text-on-surface-variant block text-[10px] font-sans font-semibold uppercase">Kapasitas Core</span>
                <span class="font-bold text-on-surface text-base">{{ device.capacity }} Core</span>
              </div>
              <div v-if="device?.portsCount">
                <span class="text-on-surface-variant block text-[10px] font-sans font-semibold uppercase">Port Splitter</span>
                <span class="font-bold text-on-surface text-base">{{ device.portsCount }} Port</span>
              </div>
              <div class="col-span-2 border-t border-outline-variant pt-2">
                <span class="text-on-surface-variant block text-[10px] font-sans font-semibold uppercase">Koordinat Peta</span>
                <span class="font-medium text-on-surface text-xs">{{ device?.lat }}, {{ device?.lng }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- UI layout for CLIENT (Gorgeous Modem Detail Dashboard) -->
        <div v-else class="flex flex-col gap-4">
          <!-- Real-Time Metrics -->
          <div class="bg-surface-container-low p-4 rounded-xl border border-outline-variant shadow-sm">
            <h4 class="font-bold text-on-surface mb-3 flex items-center gap-2">
              <span class="material-symbols-outlined text-green-500">analytics</span> Metrik Real-Time (Modem)
            </h4>
            
            <!-- Warning Metrik Belum Sinkron -->
            <div v-if="!device.rxPower && !device.wifiSsid" class="bg-amber-500/10 text-amber-700 border border-amber-500/30 p-3 rounded-xl flex gap-2.5 text-xs leading-relaxed mb-4">
              <span class="material-symbols-outlined text-[20px] flex-shrink-0 text-amber-600 font-bold">warning</span>
              <div>
                <strong class="font-bold text-amber-800 block text-xs mb-0.5">⚠️ Metrik Belum Tersinkronisasi</strong>
                <span class="opacity-90">Modem ini terdaftar namun belum menerima data sensor TR-069. Silakan ikuti langkah troubleshooting berikut:</span>
                <ol class="list-decimal pl-4 mt-1.5 space-y-1 opacity-90 font-medium">
                  <li>Klik tombol <strong>Tarik Data</strong> PPPoE di bawah untuk mendeteksi IP modem.</li>
                  <li>Klik tombol <strong>Force Inform</strong> untuk memicu modem agar memperbarui data.</li>
                </ol>
              </div>
            </div>
            
            <!-- Grid Metrik Utama -->
            <div class="grid grid-cols-2 gap-3 mb-4">
              <!-- Redaman -->
              <div class="bg-surface-container-lowest p-3 rounded-lg border border-outline-variant flex flex-col justify-between shadow-sm">
                <span class="text-on-surface-variant block text-xs">Redaman (Rx Power)</span>
                <span class="font-bold font-mono text-base mt-1" :class="(!device.rxPower) ? 'text-on-surface' : (parseFloat(device.rxPower) > -27 ? 'text-green-500' : 'text-error')">
                  {{ device.rxPower ? device.rxPower + ' dBm' : 'N/A' }}
                </span>
              </div>
              <!-- Laser Keluar -->
              <div class="bg-surface-container-lowest p-3 rounded-lg border border-outline-variant flex flex-col justify-between shadow-sm">
                <span class="text-on-surface-variant block text-xs">Laser Out (Tx Power)</span>
                <span class="font-bold font-mono text-base text-blue-500 mt-1">
                  {{ device.txPower ? parseFloat(device.txPower).toFixed(2) + ' dBm' : 'N/A' }}
                </span>
              </div>
              <!-- Suhu -->
              <div class="bg-surface-container-lowest p-3 rounded-lg border border-outline-variant flex flex-col justify-between shadow-sm">
                <span class="text-on-surface-variant block text-xs">Suhu Internal</span>
                <span class="font-bold font-mono text-base mt-1" :class="(!device.temperature) ? 'text-on-surface' : (parseFloat(device.temperature) < 60 ? 'text-green-500' : 'text-error')">
                  {{ formatTemp(device.temperature) }}
                </span>
              </div>
              <!-- Tegangan -->
              <div class="bg-surface-container-lowest p-3 rounded-lg border border-outline-variant flex flex-col justify-between shadow-sm">
                <span class="text-on-surface-variant block text-xs">Tegangan Adaptor</span>
                <span class="font-bold font-mono text-base text-yellow-500 mt-1">
                  {{ formatVoltage(device.voltage) }}
                </span>
              </div>
            </div>

            <!-- Total User -->
            <div class="bg-surface-container-lowest p-3 rounded-lg border border-outline-variant flex items-center justify-between mb-4 shadow-sm">
              <div class="flex items-center gap-2">
                <span class="material-symbols-outlined text-purple-500">devices</span>
                <span class="text-sm font-semibold">Perangkat Terkoneksi</span>
              </div>
              <span class="bg-purple-500/20 text-purple-600 font-bold px-3 py-1 rounded-full text-xs">
                {{ device.associatedDevices || 0 }} User Active
              </span>
            </div>

            <!-- Port LAN Status Grid -->
            <div class="mb-4">
              <span class="text-on-surface-variant block text-xs mb-2 font-semibold uppercase tracking-wider">Status Port LAN Fisik</span>
              <div class="grid grid-cols-4 gap-2">
                <div v-for="port in lanPortsList" :key="port.name" 
                     class="p-2 rounded-lg border flex flex-col items-center justify-center text-center text-xs font-semibold shadow-sm"
                     :class="port.isUp ? 'bg-green-500/10 border-green-500 text-green-600' : 'bg-surface-container-lowest border-outline-variant text-on-surface-variant'">
                  <span class="material-symbols-outlined text-lg mb-1">settings_ethernet</span>
                  <span>{{ port.name }}</span>
                  <span class="text-[9px] font-normal block truncate w-full mt-0.5" :class="port.isUp ? 'text-green-500' : 'text-on-surface-variant'">
                    {{ port.speed }}
                  </span>
                </div>
                <div v-if="!lanPortsList || lanPortsList.length === 0" class="col-span-4 text-center py-2 text-xs text-on-surface-variant bg-surface-container-lowest rounded-lg border border-outline-variant">
                  Tidak ada data LAN port yang aktif
                </div>
              </div>
            </div>

            <!-- Wi-Fi Details -->
            <div class="grid grid-cols-2 gap-3">
              <!-- 2.4GHz -->
              <div class="bg-surface-container-lowest p-3 rounded-lg border border-outline-variant shadow-sm">
                <span class="bg-blue-500/10 text-blue-500 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider mb-2 inline-block font-sans font-semibold">WLAN 2.4 GHz</span>
                <div class="text-sm font-bold truncate text-on-surface" :title="device.wifiSsid">{{ device.wifiSsid || 'N/A' }}</div>
                <div class="text-xs text-on-surface-variant font-mono mt-1.5 select-all cursor-pointer truncate" title="Klik untuk salin password">
                  🔑: {{ device.wifiPassword || 'None' }}
                </div>
              </div>
              <!-- 5GHz -->
              <div class="bg-surface-container-lowest p-3 rounded-lg border border-outline-variant shadow-sm">
                <span class="bg-purple-500/10 text-purple-500 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider mb-2 inline-block font-sans font-semibold">WLAN 5 GHz</span>
                <div class="text-sm font-bold truncate text-on-surface" :title="device.wifiSsid5g">{{ device.wifiSsid5g || 'N/A' }}</div>
                <div class="text-xs text-on-surface-variant font-mono mt-1.5 select-all cursor-pointer truncate" title="Klik untuk salin password">
                  🔑: {{ device.wifiPassword5g || 'None' }}
                </div>
              </div>
            </div>

          </div>

          <!-- Spesifikasi Hardware Modem -->
          <div v-if="device.brand || device.modelName || device.macAddress" class="bg-surface-container-low p-4 rounded-xl border border-outline-variant shadow-sm">
            <h4 class="font-bold text-on-surface mb-3 flex items-center gap-2">
              <span class="material-symbols-outlined text-blue-500">memory</span> Spesifikasi Hardware Perangkat
            </h4>
            <div class="grid grid-cols-2 gap-y-3 gap-x-4 text-xs font-mono">
              <div>
                <span class="text-on-surface-variant block text-[10px]">Brand / Merk</span>
                <span class="font-semibold text-on-surface text-sm">{{ device.brand || 'N/A' }}</span>
              </div>
              <div>
                <span class="text-on-surface-variant block text-[10px]">Model / Seri</span>
                <span class="font-semibold text-on-surface text-sm">{{ device.modelName || 'N/A' }}</span>
              </div>
              <div class="col-span-2">
                <span class="text-on-surface-variant block text-[10px]">MAC Address</span>
                <span class="font-semibold text-on-surface text-xs select-all">{{ device.macAddress || 'N/A' }}</span>
              </div>
              <div>
                <span class="text-on-surface-variant block text-[10px]">Hardware Version</span>
                <span class="font-semibold text-on-surface truncate block" :title="device.hardwareVersion">{{ device.hardwareVersion || 'N/A' }}</span>
              </div>
              <div>
                <span class="text-on-surface-variant block text-[10px]">Software Version</span>
                <span class="font-semibold text-on-surface truncate block" :title="device.softwareVersion">{{ device.softwareVersion || 'N/A' }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ALUR JARINGAN (PATH) -->
        <div class="bg-surface-container-low p-4 rounded-xl border border-outline-variant shadow-sm">
          <h4 class="font-bold text-on-surface mb-3 flex items-center gap-2">
             <span class="material-symbols-outlined text-[18px]">account_tree</span> Alur Topologi (Uplink)
          </h4>
          
          <div class="flex flex-col gap-2 relative">
            <div v-for="(node, index) in devicePath" :key="node.id" class="flex gap-3 relative z-10">
               <!-- Ikon Garis Penghubung -->
               <div class="flex flex-col items-center">
                  <div class="w-3 h-3 rounded-full mt-1.5"
                       :class="{
                         'bg-blue-500': node.type === 'OLT',
                         'bg-purple-500': node.type === 'ODC',
                         'bg-orange-500': node.type === 'ODP',
                         'bg-green-500': node.type === 'CLIENT',
                       }"></div>
                  <div v-if="index < devicePath.length - 1" class="w-0.5 h-full bg-outline-variant mt-1"></div>
               </div>
               <!-- Info Node -->
               <div class="pb-3 text-sm flex items-center gap-2">
                  <span class="font-semibold text-on-surface">{{ node.name }}</span>
                  <span class="bg-surface-container text-on-surface-variant text-[10px] font-bold px-2 py-0.5 rounded-full uppercase">{{ node.type }}</span>
               </div>
            </div>
          </div>
        </div>

        <!-- BAGIAN TR-069 & MIKROTIK (HANYA UNTUK CLIENT) -->
        <div v-if="device?.type === 'CLIENT'">
          <div class="flex items-center gap-2 mb-3">
             <div class="h-px bg-outline-variant flex-1"></div>
             <span class="text-xs font-bold text-on-surface-variant uppercase tracking-wider">Troubleshooting Client</span>
             <div class="h-px bg-outline-variant flex-1"></div>
          </div>
          
          <!-- PPPoE Section -->
          <div class="bg-surface-container-low p-4 rounded-xl mb-4 border border-outline-variant shadow-sm">
            <div class="flex justify-between items-center mb-3">
              <h4 class="font-medium text-on-surface flex items-center gap-2">
                <span class="material-symbols-outlined text-blue-500">router</span>
                Status PPPoE Mikrotik
              </h4>
              <button @click="handleGetPppoe" :disabled="isLoadingPppoe" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs flex items-center gap-1 disabled:opacity-50 border-none cursor-pointer font-semibold shadow-sm">
                <span v-if="isLoadingPppoe" class="material-symbols-outlined animate-spin text-sm">refresh</span>
                <span v-else class="material-symbols-outlined text-sm">sync</span>
                Tarik Data
              </button>
            </div>
            
            <div v-if="pppoeStatus" class="grid grid-cols-2 gap-4 text-sm mt-3 bg-surface-container-lowest p-3 rounded-lg border border-outline-variant font-mono">
              <div>
                <span class="text-on-surface-variant block text-[10px] font-sans font-semibold uppercase">IP Address</span>
                <span class="font-medium text-on-surface">{{ pppoeStatus.address || 'N/A' }}</span>
              </div>
              <div>
                <span class="text-on-surface-variant block text-[10px] font-sans font-semibold uppercase">Uptime</span>
                <span class="font-medium text-on-surface">{{ pppoeStatus.uptime || 'N/A' }}</span>
              </div>
            </div>
          </div>

          <!-- TR-069 Section -->
          <div class="bg-surface-container-low p-4 rounded-xl border border-outline-variant shadow-sm">
            <div class="flex justify-between items-center mb-3">
              <h4 class="font-medium text-on-surface flex items-center gap-2">
                <span class="material-symbols-outlined text-green-500">wifi</span>
                Info Wi-Fi Modem (TR-069)
              </h4>
              <button @click="handleSyncWifi" :disabled="isLoadingWifi" class="bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg text-xs flex items-center gap-1 disabled:opacity-50 border-none cursor-pointer font-semibold shadow-sm">
                <span v-if="isLoadingWifi" class="material-symbols-outlined animate-spin text-sm">refresh</span>
                <span v-else class="material-symbols-outlined text-sm">sensors</span>
                Force Inform
              </button>
            </div>
            
            <div v-if="wifiSyncStatus" class="mt-2 text-sm p-3 rounded-lg border" :class="wifiSyncStatus.includes('Gagal') ? 'bg-error bg-opacity-10 text-error border-error border-opacity-30' : 'bg-green-500 bg-opacity-10 text-green-400 border-green-500 border-opacity-30'">
              {{ wifiSyncStatus }}
            </div>
          </div>
        </div>
      </div>
      
    </div>
  </div>
</template>
