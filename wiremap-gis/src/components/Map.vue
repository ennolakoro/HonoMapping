<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { api } from '../api'
import ClientDetailModal from './ClientDetailModal.vue'
import { store } from '../store'

const mapContainer = ref(null)
let map = null
let deviceLayer = null
let polylineLayer = null

const isClientModalOpen = ref(false)
const selectedClient = ref(null)
const allDevicesData = ref([])

const handleLihatDetailEvent = (e) => {
  const deviceId = parseInt(e.detail, 10)
  const device = allDevicesData.value.find(d => d.id === deviceId)
  if (device) {
    selectedClient.value = device
    isClientModalOpen.value = true
  }
}

const getIconForType = (type) => {
  let bgColor = '#0060aa' // Default / OLT
  if (type === 'ODC') bgColor = '#6b4fa3'
  if (type === 'ODP') bgColor = '#d97706'
  if (type === 'CLIENT') bgColor = '#006d3a' // Hijau untuk Client
  
  return L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color:${bgColor}; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 4px rgba(0,0,0,0.5);"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  })
}

// Global handler untuk klik tombol "Tambah Kabel" di dalam popup Leaflet
const handleTambahKabelEvent = (e) => {
  store.startAddCable(e.detail)
  map.closePopup()
}

const loadDevices = async () => {
  try {
    const devices = await api.getDevices()
    allDevicesData.value = devices
    
    if (deviceLayer) deviceLayer.clearLayers()
    else deviceLayer = L.layerGroup().addTo(map)

    if (polylineLayer) polylineLayer.clearLayers()
    else polylineLayer = L.layerGroup().addTo(map)

    // Buat map untuk referensi cepat
    const deviceMap = {}
    devices.forEach(d => { deviceMap[d.id] = d })

    devices.forEach(device => {
      if (device.lat && device.lng) {
        const marker = L.marker([device.lat, device.lng], { icon: getIconForType(device.type) })
        
        // Popup HTML dengan tombol "Tambah Kabel" (kecuali untuk client yang merupakan ujung tombak)
        // Popup HTML dengan tombol "Tambah Kabel" dan "Lihat Detail"
        const popupHtml = `
          <div class="text-sm pb-1 min-w-[150px]">
            <b class="text-base text-gray-800 block mb-1">${device.name}</b>
            <span class="text-gray-500 block mb-2 font-medium">Tipe: ${device.type}</span>
            <div class="flex flex-col gap-1.5 mt-2">
              <button onclick="window.dispatchEvent(new CustomEvent('lihat-detail', {detail: '${device.id}'}))" class="bg-blue-500 text-white px-3 py-1.5 rounded-lg text-xs w-full hover:bg-blue-600 transition-colors shadow-sm cursor-pointer border-none font-semibold">🔍 Lihat Detail & Alur</button>
              ${device.type !== 'CLIENT' ? `<button onclick="window.dispatchEvent(new CustomEvent('tambah-kabel', {detail: '${device.id}'}))" class="bg-orange-500 text-white px-3 py-1.5 rounded-lg text-xs w-full hover:bg-orange-600 transition-colors shadow-sm cursor-pointer border-none font-semibold">🔗 Tarik Kabel Baru</button>` : ''}
            </div>
          </div>
        `
        
        marker.bindPopup(popupHtml)
        
        // Untuk client, kita bisa trigger detail dari klik marker langsung atau popup
        marker.on('click', () => {
          if (store.mapMode !== 'VIEW') return;
          if (device.type === 'CLIENT') {
             // Opsional: Buka modal secara otomatis untuk client
             // window.dispatchEvent(new CustomEvent('lihat-detail', {detail: device.id}))
          }
        })
        
        marker.addTo(deviceLayer)

        // Gambar garis kabel ke induk
        if (device.parentId && deviceMap[device.parentId]) {
          const parent = deviceMap[device.parentId]
          if (parent.lat && parent.lng) {
            L.polyline([
              [parent.lat, parent.lng],
              [device.lat, device.lng]
            ], {
              color: device.type === 'CLIENT' ? '#10b981' : '#f59e0b', // Hijau ke client, orange antar split
              weight: 2,
              opacity: 0.7,
              dashArray: device.type === 'CLIENT' ? '4, 6' : null
            }).addTo(polylineLayer)
          }
        }
      }
    })
  } catch (err) {
    console.error("Gagal menarik data topology:", err)
  }
}

const triggerSeed = async () => {
  try {
    const res = await fetch(`${window.__BACKEND_URL__}/api/seed`, { method: 'POST' })
    if (res.ok) {
      alert("Berhasil load data dummy! Peta akan dimuat ulang.")
      loadDevices()
    } else {
      alert("Gagal load data dummy. Pastikan backend jalan.")
    }
  } catch (e) {
    alert("Koneksi ke backend gagal: " + e.message)
  }
}

const triggerSync = async () => {
  try {
    const res = await fetch(`${window.__BACKEND_URL__}/api/sync-real-mikrotik`, { method: 'POST' })
    if (res.ok) {
      alert("Berhasil menarik data Mikrotik! Peta akan dimuat ulang.")
      loadDevices()
    } else {
      const data = await res.json()
      alert("Gagal sync: " + data.error + "\n\nDetail: " + (data.details || 'Tidak ada detail'))
    }
  } catch (e) {
    alert("Koneksi ke backend gagal: " + e.message)
  }
}

const triggerClear = async () => {
  if (!confirm("Apakah Anda yakin ingin MENGHAPUS SEMUA DATA di peta ini?")) return;
  try {
    const res = await fetch(`${window.__BACKEND_URL__}/api/clear`, { method: 'POST' })
    if (res.ok) {
      alert("Peta berhasil dibersihkan!")
      loadDevices()
    } else {
      alert("Gagal membersihkan peta.")
    }
  } catch (e) {
    alert("Koneksi ke backend gagal: " + e.message)
  }
}

onMounted(() => {
  // Initialize map
  map = L.map(mapContainer.value, {
    zoomControl: false 
  }).setView([-7.250445, 112.768845], 13) 

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map)

  // Tangkap event klik di peta untuk koordinat (Mode Tambah Perangkat/Kabel)
  map.on('click', (e) => {
    if (store.mapMode === 'ADD_DEVICE' || store.mapMode === 'ADD_CABLE') {
      store.openAddModal(e.latlng.lat, e.latlng.lng)
    }
  })

  setTimeout(() => {
    map.invalidateSize()
  }, 100)

  window.addEventListener('refresh-map', loadDevices)
  window.addEventListener('tambah-kabel', handleTambahKabelEvent)
  window.addEventListener('lihat-detail', handleLihatDetailEvent)
  
  loadDevices()
})

onUnmounted(() => {
  window.removeEventListener('refresh-map', loadDevices)
  window.removeEventListener('tambah-kabel', handleTambahKabelEvent)
  window.removeEventListener('lihat-detail', handleLihatDetailEvent)
})
</script>

<template>
  <div class="relative w-full h-full">
    <div ref="mapContainer" class="absolute inset-0 z-0"></div>
    
    <!-- Floating Map Controls -->
    <div class="absolute bottom-6 left-6 z-10">
       <div class="bg-surface-container-lowest border border-outline-variant rounded-lg p-2 shadow-md bg-opacity-95 flex items-center gap-4 text-xs font-medium">
          <div class="flex items-center gap-1 text-on-surface-variant">
             <div class="w-3 h-3 bg-[#0060aa] rounded-sm"></div> OLT
          </div>
          <div class="flex items-center gap-1 text-on-surface-variant">
             <div class="w-3 h-3 bg-[#6b4fa3] rounded-sm"></div> ODC
          </div>
          <div class="flex items-center gap-1 text-on-surface-variant">
             <div class="w-3 h-3 bg-[#d97706] rounded-sm"></div> ODP
          </div>
          <div class="flex items-center gap-1 text-on-surface-variant">
             <div class="w-3 h-3 bg-[#006d3a] rounded-sm"></div> Client On
          </div>
       </div>
       
       <div class="mt-3 flex flex-col gap-2">
          <button @click="triggerSeed" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-lg text-xs font-semibold shadow-md flex items-center justify-center gap-2 cursor-pointer border-none transition-colors">
            <span class="material-symbols-outlined text-[16px]">database</span> Load Data Dummy (Seed)
          </button>
          <button @click="triggerSync" class="bg-green-600 hover:bg-green-700 text-white px-3 py-2 rounded-lg text-xs font-semibold shadow-md flex items-center justify-center gap-2 cursor-pointer border-none transition-colors">
            <span class="material-symbols-outlined text-[16px]">sync</span> Auto-Sync Real Mikrotik
          </button>
          <button @click="triggerClear" class="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-lg text-xs font-semibold shadow-md flex items-center justify-center gap-2 cursor-pointer border-none transition-colors mt-1">
            <span class="material-symbols-outlined text-[14px]">delete</span> Kosongkan Peta
          </button>
       </div>
    </div>
    
    <!-- Device Detail & Alur Modal -->
    <ClientDetailModal 
      :is-open="isClientModalOpen"
      :device="selectedClient"
      :all-devices="allDevicesData"
      @close="isClientModalOpen = false"
    />
  </div>
</template>

<style scoped>
/* Any specific leaflet overrides can go here */
:deep(.leaflet-container) {
  background-color: #0b141c; /* To match dark theme closely before tiles load */
}
</style>
