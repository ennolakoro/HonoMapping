<script setup>
import { ref, computed } from 'vue'
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
      
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-2xl font-bold text-on-surface">Detail Perangkat & Alur</h2>
        <button @click="emit('close')" class="text-on-surface-variant hover:text-error transition-colors p-1">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      
      <!-- Info Dasar -->
      <div class="mb-6 flex gap-4 items-start">
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
          <p class="text-sm font-medium" 
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

      <!-- Tabel Detail Spesifikasi -->
      <div class="bg-surface-container-low p-4 rounded-xl mb-6 border border-outline-variant">
        <h4 class="font-bold text-on-surface mb-3 flex items-center gap-2">
           <span class="material-symbols-outlined text-[18px]">info</span> Informasi Teknis
        </h4>
        <div class="grid grid-cols-2 gap-y-3 gap-x-4 text-sm">
          <div v-if="device?.capacity">
            <span class="text-on-surface-variant block text-xs">Kapasitas (Port Utama)</span>
            <span class="font-medium text-on-surface">{{ device.capacity }} Core</span>
          </div>
          <div v-if="device?.portsCount">
            <span class="text-on-surface-variant block text-xs">Jumlah Port Splitter</span>
            <span class="font-medium text-on-surface">{{ device.portsCount }} Port</span>
          </div>
          <div v-if="device?.type === 'CLIENT'">
            <span class="text-on-surface-variant block text-xs">SN Modem (CWMP)</span>
            <span class="font-medium text-on-surface font-mono text-green-500">{{ device.snModem || 'Belum di-set' }}</span>
          </div>
          <div v-if="device?.type === 'CLIENT'">
            <span class="text-on-surface-variant block text-xs">Redaman (Rx Power)</span>
            <span class="font-medium font-mono" :class="(!device.rxPower) ? 'text-on-surface' : (parseFloat(device.rxPower) > -24 ? 'text-green-500' : 'text-error')">{{ device.rxPower ? device.rxPower + ' dBm' : 'Unknown' }}</span>
          </div>
          <div class="col-span-2">
            <span class="text-on-surface-variant block text-xs">Koordinat Peta</span>
            <span class="font-medium text-on-surface font-mono">{{ device?.lat }}, {{ device?.lng }}</span>
          </div>
          <div class="col-span-2" v-if="device?.keterangan || true">
             <!-- Keterangan akan diambil dari database jika ada -->
            <span class="text-on-surface-variant block text-xs">Keterangan / Catatan</span>
            <span class="font-medium text-on-surface italic">{{ device?.keterangan || 'Tidak ada catatan.' }}</span>
          </div>
        </div>
      </div>

      <!-- ALUR JARINGAN (PATH) -->
      <div class="bg-surface-container-low p-4 rounded-xl mb-6 border border-outline-variant">
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
             <div class="pb-3 text-sm">
                <span class="font-semibold text-on-surface">{{ node.name }}</span>
                <span class="text-on-surface-variant text-xs ml-2">({{ node.type }})</span>
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
        <div class="bg-surface-container-low p-4 rounded-xl mb-4 border border-outline-variant">
          <div class="flex justify-between items-center mb-3">
            <h4 class="font-medium text-on-surface flex items-center gap-2">
              <span class="material-symbols-outlined text-blue-500">router</span>
              Status PPPoE Mikrotik
            </h4>
            <button @click="handleGetPppoe" :disabled="isLoadingPppoe" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-sm flex items-center gap-1 disabled:opacity-50">
              <span v-if="isLoadingPppoe" class="material-symbols-outlined animate-spin text-sm">refresh</span>
              <span v-else class="material-symbols-outlined text-sm">sync</span>
              Tarik Data
            </button>
          </div>
          
          <div v-if="pppoeStatus" class="grid grid-cols-2 gap-4 text-sm mt-3 bg-surface-container-lowest p-3 rounded-lg border border-outline-variant">
            <div>
              <span class="text-on-surface-variant block text-xs">IP Address</span>
              <span class="font-medium text-on-surface">{{ pppoeStatus.address || 'N/A' }}</span>
            </div>
            <div>
              <span class="text-on-surface-variant block text-xs">Uptime</span>
              <span class="font-medium text-on-surface">{{ pppoeStatus.uptime || 'N/A' }}</span>
            </div>
          </div>
        </div>

        <!-- TR-069 Section -->
        <div class="bg-surface-container-low p-4 rounded-xl border border-outline-variant">
          <div class="flex justify-between items-center mb-3">
            <h4 class="font-medium text-on-surface flex items-center gap-2">
              <span class="material-symbols-outlined text-green-500">wifi</span>
              Info Wi-Fi Modem (TR-069)
            </h4>
            <button @click="handleSyncWifi" :disabled="isLoadingWifi" class="bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg text-sm flex items-center gap-1 disabled:opacity-50">
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
</template>
