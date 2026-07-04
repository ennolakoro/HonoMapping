<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
const selectedOdpId = ref('')
const plotError = ref('')
const syncStatus = ref('')
const informStatus = ref('')
const isInformingAll = ref(false)
const isWorkflowOpen = ref(false)
const workflowSearch = ref('')
// Filter status plotting: 'UNMAPPED' | 'PLOTTED'
const queuePlotFilter = ref('UNMAPPED')

const syncProgressMap = ref({})
let pollInterval = null

const startProgressPolling = () => {
  if (pollInterval) return
  pollInterval = setInterval(async () => {
    try {
      const statusMap = await api.getModemSyncStatus()
      syncProgressMap.value = { ...syncProgressMap.value, ...statusMap }
      await loadDevices()

      const activeSyncs = Object.values(syncProgressMap.value).some(
        info => info.status === 'triggered' || info.status === 'connected' || info.status === 'fetching'
      )
      const waitingPersistedData = allDevicesData.value.some(device =>
        device.type === 'CLIENT' && !hasCoords(device) && isClientWaitingPersistedData(device)
      )

      if (!activeSyncs && !waitingPersistedData) {
        stopProgressPolling()
      }
    } catch (err) {
      console.error('Gagal poll status sinkronisasi:', err)
    }
  }, 1500)
}

const stopProgressPolling = () => {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

const isPublicIp = (ip) => {
  if (!ip || typeof ip !== 'string') return false
  const cleanIp = ip.trim()
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(cleanIp)) return false
  if (cleanIp.startsWith('10.')) return false
  if (cleanIp.startsWith('192.168.')) return false
  if (cleanIp.startsWith('172.')) {
    const second = parseInt(cleanIp.split('.')[1], 10)
    if (second >= 16 && second <= 31) return false
  }
  return true
}

const getSafeClientIp = (ip) => ip && !isPublicIp(ip) ? ip : null

// Helper: dapatkan triggerIp client. Jangan pakai IP publik NAT karena bisa sama untuk banyak ONT.
const getClientTriggerIp = (client) =>
  getSafeClientIp(client?.lanIp) ||
  getSafeClientIp(client?.triggerIp) ||
  getSafeClientIp(client?.wanIp) ||
  null

const getClientDisplayIp = (client) =>
  getClientTriggerIp(client) || 'IP manajemen belum ada'

const getSyncProgress = (client) => {
  const ip = getClientTriggerIp(client)
  if (!ip) return null
  const info = syncProgressMap.value[ip]
  if (!info) return null
  if (info.status === 'idle') return null
  if ((info.status === 'success' || info.status === 'failed') && Date.now() - (info.updatedAt || 0) > 90000) return null
  return info
}

const isClientSyncing = (client) => {
  const info = getSyncProgress(client)
  if (!info) return false
  return info.status === 'triggered' || info.status === 'connected' || info.status === 'fetching'
}

const getSyncProgressMessage = (info) => {
  if (info.status === 'triggered') return 'Menghubungi CPE...'
  if (info.status === 'connected') return 'Terhubung, mengautentikasi...'
  if (info.status === 'fetching') return 'Mengambil data...'
  if (info.status === 'success') return 'Selesai, memuat data tersimpan...'
  if (info.status === 'failed') return `Gagal: ${info.error || 'Fault/Timeout'}`
  return ''
}

const informSingleClient = async (client) => {
  if (isClientReadyForPlot(client)) {
    informStatus.value = `${client.name} sudah selesai Inform. Silakan langsung Plot.`
    return
  }
  const ip = getClientTriggerIp(client)
  if (!ip) return
  try {
    syncProgressMap.value[ip] = {
      id: client.id,
      username: client.name,
      progress: 10,
      status: 'triggered',
      updatedAt: Date.now()
    }
    await api.syncModem(ip, client.id)
    startProgressPolling()
  } catch (err) {
    console.error(`Gagal sync modem ${client.name}:`, err)
    syncProgressMap.value[ip] = {
      id: client.id,
      username: client.name,
      progress: 100,
      status: 'failed',
      error: err.message || 'Gagal mengirim trigger',
      updatedAt: Date.now()
    }
  }
}

onUnmounted(() => {
  stopProgressPolling()
})

const activeEditDevice = ref(null)
let editHandles = []
let editPolyline = null

const clearEditHandles = () => {
  editHandles.forEach(h => {
    if (map) map.removeLayer(h)
  })
  editHandles = []
  activeEditDevice.value = null
  editPolyline = null
}

const renderEditHandles = () => {
  editHandles.forEach(h => {
    if (map) map.removeLayer(h)
  })
  editHandles = []

  if (!activeEditDevice.value || !editPolyline) return

  const coords = editPolyline.getLatLngs().map(ll => [ll.lat, ll.lng])

  // A. Main Handles untuk bend points (indeks 1 s.d length-2)
  for (let i = 1; i < coords.length - 1; i++) {
    const coord = coords[i]
    const handleIcon = L.divIcon({
      className: 'cable-edit-handle',
      html: '<div style="width:14px; height:14px; border-radius:50%; background:#fb923c; border:2.5px solid white; box-shadow:0 2px 6px rgba(0,0,0,0.4); cursor:pointer;"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    })

    const handle = L.marker(coord, {
      icon: handleIcon,
      draggable: true
    }).addTo(map)

    handle.on('drag', (ev) => {
      const newLatLng = ev.latlng
      coords[i] = [newLatLng.lat, newLatLng.lng]
      editPolyline.setLatLngs(coords)
      if (editPolyline.clickPolyline) {
        editPolyline.clickPolyline.setLatLngs(coords)
      }
      
      // Update label jarak real-time
      const distanceMeters = calculatePolylineLength(coords)
      const distanceStr = distanceMeters >= 1000
        ? `${(distanceMeters / 1000).toFixed(2)} km`
        : `${Math.round(distanceMeters)} m`
      const midpoint = getPolylineMidpoint(coords)
      if (midpoint && editPolyline.lengthMarker) {
        editPolyline.lengthMarker.setLatLng(midpoint)
        editPolyline.lengthMarker.setIcon(L.divIcon({
          className: 'cable-length-label',
          html: `<div>${distanceStr}</div>`,
          iconSize: [60, 20],
          iconAnchor: [30, 10]
        }))
      }
    })

    handle.on('dragend', () => {
      renderEditHandles()
    })

    handle.on('dblclick', (e) => {
      L.DomEvent.stopPropagation(e)
      if (coords.length > 2) {
        coords.splice(i, 1)
        editPolyline.setLatLngs(coords)
        if (editPolyline.clickPolyline) {
          editPolyline.clickPolyline.setLatLngs(coords)
        }
        renderEditHandles()
      }
    })

    editHandles.push(handle)
  }

  // B. Midpoint Handles untuk menyisipkan titik baru
  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i]
    const p2 = coords[i+1]
    const midLat = (p1[0] + p2[0]) / 2
    const midLng = (p1[1] + p2[1]) / 2

    const midIcon = L.divIcon({
      className: 'cable-mid-handle',
      html: '<div style="width:10px; height:10px; border-radius:50%; background:#fdba74; border:1.5px solid white; box-shadow:0 1px 4px rgba(0,0,0,0.3); opacity:0.8; cursor:pointer;"></div>',
      iconSize: [10, 10],
      iconAnchor: [5, 5]
    })

    const midMarker = L.marker([midLat, midLng], {
      icon: midIcon,
      draggable: true
    }).addTo(map)

    midMarker.on('dragstart', (ev) => {
      const startLatLng = ev.target.getLatLng()
      coords.splice(i + 1, 0, [startLatLng.lat, startLatLng.lng])
      editPolyline.setLatLngs(coords)
      if (editPolyline.clickPolyline) {
        editPolyline.clickPolyline.setLatLngs(coords)
      }
    })

    midMarker.on('drag', (ev) => {
      const newLatLng = ev.latlng
      coords[i + 1] = [newLatLng.lat, newLatLng.lng]
      editPolyline.setLatLngs(coords)
      if (editPolyline.clickPolyline) {
        editPolyline.clickPolyline.setLatLngs(coords)
      }
      
      const distanceMeters = calculatePolylineLength(coords)
      const distanceStr = distanceMeters >= 1000
        ? `${(distanceMeters / 1000).toFixed(2)} km`
        : `${Math.round(distanceMeters)} m`
      const midpoint = getPolylineMidpoint(coords)
      if (midpoint && editPolyline.lengthMarker) {
        editPolyline.lengthMarker.setLatLng(midpoint)
        editPolyline.lengthMarker.setIcon(L.divIcon({
          className: 'cable-length-label',
          html: `<div>${distanceStr}</div>`,
          iconSize: [60, 20],
          iconAnchor: [30, 10]
        }))
      }
    })

    midMarker.on('dragend', () => {
      renderEditHandles()
    })

    editHandles.push(midMarker)
  }
}

const saveAndExitEditPath = async () => {
  if (activeEditDevice.value && editPolyline) {
    const finalCoords = editPolyline.getLatLngs().map(ll => [ll.lat, ll.lng])
    try {
      await api.updateDevice(activeEditDevice.value.id, {
        type: activeEditDevice.value.type,
        name: activeEditDevice.value.name,
        cablePath: JSON.stringify(finalCoords)
      })
      activeEditDevice.value.cablePath = JSON.stringify(finalCoords)
    } catch (err) {
      console.error("Gagal menyimpan rute kabel:", err)
    }
  }
  clearEditHandles()
}

let lightLayer = null
let darkLayer = null
let satelliteLayer = null
const activeMapLayer = ref('light')

const setMapLayer = (mode) => {
  activeMapLayer.value = mode
  if (!map) return
  
  if (map.hasLayer(lightLayer)) map.removeLayer(lightLayer)
  if (map.hasLayer(darkLayer)) map.removeLayer(darkLayer)
  if (map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer)
  
  if (mode === 'light') {
    lightLayer.addTo(map)
  } else if (mode === 'dark') {
    darkLayer.addTo(map)
  } else if (mode === 'satellite') {
    satelliteLayer.addTo(map)
  }
}

let autoRefreshInterval = null
const previousOnlineStatuses = {}

const playOutageAlarm = () => {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    
    // Suara Chime Peringatan (Dua Nada Berurutan)
    const osc1 = audioCtx.createOscillator()
    const gain1 = audioCtx.createGain()
    osc1.connect(gain1)
    gain1.connect(audioCtx.destination)
    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(880, audioCtx.currentTime) // Nada A5
    gain1.gain.setValueAtTime(0.12, audioCtx.currentTime)
    gain1.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3)
    
    const osc2 = audioCtx.createOscillator()
    const gain2 = audioCtx.createGain()
    osc2.connect(gain2)
    gain2.connect(audioCtx.destination)
    osc2.type = 'sine'
    osc2.frequency.setValueAtTime(587.33, audioCtx.currentTime + 0.12) // Nada D5
    gain2.gain.setValueAtTime(0.12, audioCtx.currentTime + 0.12)
    gain2.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.42)
    
    osc1.start()
    osc1.stop(audioCtx.currentTime + 0.3)
    osc2.start(audioCtx.currentTime + 0.12)
    osc2.stop(audioCtx.currentTime + 0.42)
  } catch (err) {
    console.warn('Audio alarm blocked by browser autoplay policy:', err)
  }
}

const startAutoRefresh = () => {
  if (autoRefreshInterval) return
  // Selalu jalankan pembaruan data status secara konstan setiap 8 detik
  autoRefreshInterval = setInterval(async () => {
    if (!activeEditDevice.value) {
      try {
        await loadDevices()
      } catch (err) {
        console.error("Auto-refresh real-time status failed:", err)
      }
    }
  }, 8000)
}

const stopAutoRefresh = () => {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval)
    autoRefreshInterval = null
  }
}

const hasCoords = (device) => {
  const lat = Number(device?.lat)
  const lng = Number(device?.lng)
  return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0
}

const unmappedClients = computed(() =>
  allDevicesData.value.filter(device => device.type === 'CLIENT' && !hasCoords(device))
)

const allClients = computed(() =>
  allDevicesData.value.filter(device => device.type === 'CLIENT')
)

const plottedClients = computed(() =>
  allClients.value.filter(device => hasCoords(device))
)

const hasModemData = (device) => [
  device?.wifiSsid,
  device?.wifiSsid5g,
  device?.lanStatus,
  device?.brand,
  device?.modelName,
  device?.hardwareVersion,
  device?.softwareVersion,
  device?.rxPower,
  device?.txPower,
  device?.temperature,
  device?.voltage
].some(value => value !== null && value !== undefined && value !== '')

const isClientWaitingPersistedData = (device) =>
  !hasModemData(device) && getSyncProgress(device)?.status === 'success'

const isClientReadyForPlot = (device) => hasModemData(device)

const matchesWorkflowSearch = (device) => {
  const query = workflowSearch.value.trim().toLowerCase()
  if (!query) return true
  return [
    device?.name,
    device?.pppoeUsername,
    device?.wanIp,
    device?.lanIp,
    device?.snModem
  ].some(value => String(value || '').toLowerCase().includes(query))
}

const getQueuePriority = (device) => {
  let score = 0
  if (hasCoords(device)) score += 120
  if (isClientReadyForPlot(device)) score += 100
  if (device?.pppoeUsername) score += 40
  if (device?.snModem) score += 30
  if (device?.clientType !== 'HOTSPOT') score += 20
  if (String(device?.name || '').startsWith('ONT-')) score += 10
  return score
}

const visibleWorkflowClients = computed(() => {
  const filtered = allClients.value.filter(d => {
    if (!matchesWorkflowSearch(d)) return false
    if (queuePlotFilter.value === 'UNMAPPED' && hasCoords(d)) return false
    if (queuePlotFilter.value === 'PLOTTED' && !hasCoords(d)) return false
    return true
  })

  const byIdentity = new Map()
  for (const client of filtered) {
    const key = getClientTriggerIp(client) || client.snModem || client.macAddress || `id:${client.id}`
    const existing = byIdentity.get(key)
    if (!existing || getQueuePriority(client) > getQueuePriority(existing)) {
      byIdentity.set(key, client)
    }
  }

  return Array.from(byIdentity.values())
})

const visibleUnmappedClients = computed(() =>
  visibleWorkflowClients.value.filter(device => !hasCoords(device))
)

const informableClients = computed(() =>
  visibleWorkflowClients.value.filter(device => !!getClientTriggerIp(device) && !isClientReadyForPlot(device) && !isClientSyncing(device))
)

const odpOptions = computed(() =>
  allDevicesData.value.filter(device => device.type === 'ODP' && hasCoords(device))
)

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const calculatePolylineLength = (latlngs) => {
  let totalDistance = 0
  for (let i = 0; i < latlngs.length - 1; i++) {
    const p1 = L.latLng(latlngs[i])
    const p2 = L.latLng(latlngs[i+1])
    totalDistance += p1.distanceTo(p2)
  }
  return totalDistance
}

const getPolylineMidpoint = (latlngs) => {
  if (!latlngs || !latlngs.length) return null
  const midIdx = Math.floor(latlngs.length / 2)
  if (latlngs.length % 2 === 0 && midIdx > 0) {
    const p1 = latlngs[midIdx - 1]
    const p2 = latlngs[midIdx]
    const lat1 = typeof p1.lat === 'number' ? p1.lat : p1[0]
    const lng1 = typeof p1.lng === 'number' ? p1.lng : p1[1]
    const lat2 = typeof p2.lat === 'number' ? p2.lat : p2[0]
    const lng2 = typeof p2.lng === 'number' ? p2.lng : p2[1]
    return [(lat1 + lat2) / 2, (lng1 + lng2) / 2]
  }
  const p = latlngs[midIdx]
  const lat = typeof p.lat === 'number' ? p.lat : p[0]
  const lng = typeof p.lng === 'number' ? p.lng : p[1]
  return [lat, lng]
}

const handleLihatDetailEvent = (e) => {
  const deviceId = parseInt(e.detail, 10)
  const device = allDevicesData.value.find(d => d.id === deviceId)
  if (device) {
    selectedClient.value = device
    isClientModalOpen.value = true
  }
}

const getClientHealth = (device) => {
  if (!device?.isOnline) {
    if (device?.offlineReason === 'POWER_FAILURE') return 'power_failure'
    return 'offline'
  }
  const rx = parseFloat(device.rxPower)
  if (Number.isNaN(rx)) return 'good'
  if (rx <= -28) return 'offline'
  if (rx <= -26) return 'warning'
  return 'good'
}

const handleOpenProvisioningQueue = () => {
  isWorkflowOpen.value = true
}

let tempPathCoords = []
let tempPolyline = null

const getIconForType = (type, device = null) => {
  let bgColor = '#0050cb'
  let svgContent = ''
  
  if (type === 'OLT') {
    bgColor = '#0050cb'
    svgContent = `
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0px 3px 6px rgba(0, 80, 203, 0.45));">
        <rect x="2" y="2" width="20" height="20" rx="4" fill="${bgColor}" stroke="white" stroke-width="1.5"/>
        <rect x="5" y="6" width="14" height="3" rx="0.75" fill="rgba(255,255,255,0.2)"/>
        <circle cx="7.5" cy="7.5" r="0.75" fill="#10b981"/>
        <circle cx="10" cy="7.5" r="0.75" fill="#10b981"/>
        <line x1="13" y1="7.5" x2="17.5" y2="7.5" stroke="white" stroke-width="1" stroke-linecap="round" opacity="0.8"/>
        <rect x="5" y="11" width="14" height="3" rx="0.75" fill="rgba(255,255,255,0.2)"/>
        <circle cx="7.5" cy="12.5" r="0.75" fill="#10b981"/>
        <circle cx="10" cy="12.5" r="0.75" fill="#10b981"/>
        <line x1="13" y1="12.5" x2="17.5" y2="12.5" stroke="white" stroke-width="1" stroke-linecap="round" opacity="0.8"/>
        <rect x="5" y="16" width="14" height="3" rx="0.75" fill="rgba(255,255,255,0.2)"/>
        <circle cx="7.5" cy="17.5" r="0.75" fill="#10b981"/>
        <circle cx="10" cy="17.5" r="0.75" fill="#10b981"/>
        <line x1="13" y1="17.5" x2="17.5" y2="17.5" stroke="white" stroke-width="1" stroke-linecap="round" opacity="0.8"/>
      </svg>
    `
    return L.divIcon({
      className: 'custom-olt-icon',
      html: svgContent,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    })
  }
  
  if (type === 'ODC' || type === 'ODP') {
    let isMassLos = false
    if (type === 'ODP' && device) {
      const odpClients = allDevicesData.value.filter(d => d.type === 'CLIENT' && d.parentId === device.id)
      isMassLos = odpClients.length >= 3 && odpClients.every(c => !c.isOnline)
    }

    const bgColor = type === 'ODC' ? '#64748b' : (isMassLos ? '#dc2626' : '#d97706')
    const glowColor = type === 'ODC' ? 'rgba(100, 116, 139, 0.45)' : (isMassLos ? 'rgba(220, 38, 38, 0.85)' : 'rgba(217, 119, 6, 0.45)')
    
    svgContent = `
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0px 2px 4px ${glowColor});">
        <rect x="2" y="4" width="20" height="16" rx="3" fill="${bgColor}" stroke="white" stroke-width="1.5"/>
        <rect x="5" y="7" width="14" height="3" rx="0.5" fill="rgba(255,255,255,0.2)"/>
        <circle cx="7" cy="8.5" r="0.6" fill="#10b981"/>
        <line x1="10" y1="8.5" x2="17" y2="8.5" stroke="white" stroke-width="0.75" stroke-linecap="round" opacity="0.8"/>
        <rect x="5" y="12" width="14" height="3" rx="0.5" fill="rgba(255,255,255,0.2)"/>
        <circle cx="7" cy="13.5" r="0.6" fill="#10b981"/>
        <line x1="10" y1="13.5" x2="17" y2="13.5" stroke="white" stroke-width="0.75" stroke-linecap="round" opacity="0.8"/>
      </svg>
    `
    const blinkClass = isMassLos ? 'odp-mass-los-blink' : ''
    return L.divIcon({
      className: `custom-node-icon ${blinkClass}`,
      html: svgContent,
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    })
  }
  
  if (type === 'CLIENT') {
    const health = getClientHealth(device)
    let bgColor = '#16a34a' // Green
    let glowColor = 'rgba(22, 163, 74, 0.45)'
    let svgIcon = `
      <path d="M12 15h.01M9.5 12.5a3.5 3.5 0 0 1 5 0M7 10a7 7 0 0 1 10 0" stroke="white" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
    `
    
    if (health === 'warning') {
      bgColor = '#f59e0b'
      glowColor = 'rgba(245, 158, 11, 0.45)'
    } else if (health === 'offline') {
      bgColor = '#dc2626' // Red
      glowColor = 'rgba(220, 38, 38, 0.45)'
    } else if (health === 'power_failure') {
      bgColor = '#dc2626' // Red (offline)
      glowColor = 'rgba(220, 38, 38, 0.45)'
      svgIcon = `
        <path d="M10 14V17.5M14 14V17.5M8 10V12C8 13.1 8.9 14 10 14H14C15.1 14 16 13.1 16 12V10M12 17.5V20.5" stroke="white" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
      `
    }
    
    svgContent = `
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0px 2px 4px ${glowColor});">
        <circle cx="12" cy="12" r="10" fill="${bgColor}" stroke="white" stroke-width="1.5"/>
        ${svgIcon}
      </svg>
    `
    const blinkClass = health === 'offline' ? 'client-offline-blink' : ''
    
    return L.divIcon({
      className: `custom-client-icon ${blinkClass}`,
      html: svgContent,
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    })
  }
}

// Global handler untuk klik tombol "Tambah Kabel" di dalam popup Leaflet
const handleTambahKabelEvent = (e) => {
  store.startAddCable(e.detail)
  map.closePopup()
}

const startRouteFromDevice = (device) => {
  if (!device || device.type === 'CLIENT') return
  isClientModalOpen.value = false
  store.startAddCable(device.id)
}

const deleteDevice = async (device) => {
  if (!device) return
  const confirmed = confirm(`Hapus ${device.type} "${device.name}"? Route anak perangkat akan dilepas.`)
  if (!confirmed) return
  try {
    await api.deleteDevice(device.id, device.type)
    isClientModalOpen.value = false
    selectedClient.value = null
    await loadDevices()
  } catch (err) {
    alert('Gagal menghapus perangkat: ' + err.message)
  }
}

const loadDevices = async () => {
  try {
    const devices = await api.getDevices()
    
    // Deteksi transisi status online -> offline untuk memicu alarm suara
    const isFirstLoad = Object.keys(previousOnlineStatuses).length === 0
    devices.forEach(device => {
      if (device.type === 'CLIENT') {
        const currentOnline = device.isOnline
        const prevOnline = previousOnlineStatuses[device.id]
        
        if (!isFirstLoad && prevOnline === true && currentOnline === false) {
          playOutageAlarm()
          console.log(`[ALARM] Client went offline: ${device.name}`)
        }
        previousOnlineStatuses[device.id] = currentOnline
      }
    })

    allDevicesData.value = devices
    if (selectedClient.value) {
      const refreshedClient = devices.find(d => d.id === selectedClient.value.id)
      if (refreshedClient) selectedClient.value = refreshedClient
    }
    
    if (deviceLayer) deviceLayer.clearLayers()
    else deviceLayer = L.layerGroup().addTo(map)

    if (polylineLayer) polylineLayer.clearLayers()
    else polylineLayer = L.layerGroup().addTo(map)

    // Buat map untuk referensi cepat
    const deviceMap = {}
    devices.forEach(d => { deviceMap[d.id] = d })

    devices.forEach(device => {
      if (hasCoords(device)) {
        // Cek apakah ada hubungan kabel ( uplink parent maupun downlink children )
        const hasParent = device.parentId !== null && device.parentId !== undefined && device.parentId !== '';
        const hasChildren = devices.some(d => d.parentId === device.id);
        const hasCable = hasParent || hasChildren;
        const isDraggable = !hasCable;

        const marker = L.marker([device.lat, device.lng], { 
          icon: getIconForType(device.type, device),
          draggable: isDraggable
        })
        
        const dragTip = isDraggable 
          ? ' <span style="color:#60a5fa; font-weight:bold;">(Geser Aktif)</span>' 
          : ' <span style="color:#94a3b8;">(Kabel Terhubung - Terkunci)</span>';
        
        marker.bindTooltip(`<b>${device.name}</b><br/>${dragTip}`, { 
          direction: 'top', 
          offset: [0, -10],
          html: true
        })
        
        marker.on('click', () => {
          if (store.mapMode !== 'VIEW') return;
          selectedClient.value = device
          isClientModalOpen.value = true
        })

        if (isDraggable) {
          marker.on('dragend', async (ev) => {
            const newLatLng = ev.target.getLatLng()
            try {
              if (device.type === 'CLIENT') {
                await api.updateDevice(device.id, {
                  type: 'CLIENT',
                  lat: newLatLng.lat,
                  lng: newLatLng.lng
                })
              } else {
                await api.updateDevice(device.id, {
                  type: device.type,
                  name: device.name,
                  lat: newLatLng.lat,
                  lng: newLatLng.lng,
                  capacity: device.capacity,
                  portsCount: device.portsCount,
                  cablePath: device.cablePath
                })
              }
              device.lat = newLatLng.lat
              device.lng = newLatLng.lng
              await loadDevices()
            } catch (err) {
              alert('Gagal memperbarui posisi koordinat: ' + err.message)
              await loadDevices()
            }
          })
        }
        
        marker.addTo(deviceLayer)

        // Gambar garis kabel ke induk
        if (device.parentId && deviceMap[device.parentId]) {
          const parent = deviceMap[device.parentId]
          if (hasCoords(parent)) {
            let latlngs = []
            if (device.cablePath) {
              try {
                latlngs = JSON.parse(device.cablePath)
              } catch (e) {
                console.error("Failed to parse cablePath for", device.name, e)
              }
            }
            if (!latlngs || !latlngs.length) {
              latlngs = [
                [parent.lat, parent.lng],
                [device.lat, device.lng]
              ]
            }

            const polyline = L.polyline(latlngs, {
              color: device.type === 'CLIENT' ? '#16a34a' : '#0066ff',
              weight: 4,
              opacity: 0.85,
              className: 'animated-cable'
            })

            // Thick invisible polyline for hit tolerance (easier clicks)
            const clickPolyline = L.polyline(latlngs, {
              color: 'transparent',
              weight: 16,
              opacity: 0,
              interactive: true
            })
            polyline.clickPolyline = clickPolyline

            let lengthMarker = null
            const updateLengthLabel = (coords) => {
              const distanceMeters = calculatePolylineLength(coords)
              const distanceStr = distanceMeters >= 1000
                ? `${(distanceMeters / 1000).toFixed(2)} km`
                : `${Math.round(distanceMeters)} m`
              
              const midpoint = getPolylineMidpoint(coords)
              if (midpoint) {
                if (lengthMarker) {
                  lengthMarker.setLatLng(midpoint)
                  lengthMarker.setIcon(L.divIcon({
                    className: 'cable-length-label',
                    html: `<div>${distanceStr}</div>`,
                    iconSize: [60, 20],
                    iconAnchor: [30, 10]
                  }))
                } else {
                  const lengthLabelIcon = L.divIcon({
                    className: 'cable-length-label',
                    html: `<div>${distanceStr}</div>`,
                    iconSize: [60, 20],
                    iconAnchor: [30, 10]
                  })
                  lengthMarker = L.marker(midpoint, { icon: lengthLabelIcon, interactive: false })
                  lengthMarker.addTo(polylineLayer)
                }
                polyline.lengthMarker = lengthMarker
              }
            }

            updateLengthLabel(latlngs)

            clickPolyline.on('click', (e) => {
              if (store.mapMode !== 'VIEW') return
              if (e.originalEvent) {
                e.originalEvent.stopPropagation()
              }

              clearEditHandles()
              activeEditDevice.value = device
              editPolyline = polyline
              renderEditHandles()
            })

            polyline.addTo(polylineLayer)
            clickPolyline.addTo(polylineLayer)
          }
        }
      }
    })
  } catch (err) {
    console.error("Gagal menarik data topology:", err)
  }
}

const triggerSync = async () => {
  syncStatus.value = 'Menarik data dari Mikrotik (PPPoE + DHCP)...'
  informStatus.value = ''
  try {
    // Jalankan PPPoE sync dan DHCP sync secara paralel
    const [pppoeResult, dhcpResult] = await Promise.allSettled([
      api.syncMikrotik(),
      api.syncDhcpLeases()
    ])

    const messages = []
    if (pppoeResult.status === 'fulfilled') {
      messages.push(pppoeResult.value?.message || 'PPPoE: sync selesai')
    } else {
      messages.push(`PPPoE gagal: ${pppoeResult.reason?.message || 'Error'}`)
    }
    if (dhcpResult.status === 'fulfilled') {
      const d = dhcpResult.value
      if (d?.created || d?.updated) {
        messages.push(`Hotspot: ${d.created || 0} baru, ${d.updated || 0} update`)
      } else {
        messages.push(d?.message || 'DHCP: sync selesai')
      }
    } else {
      messages.push(`DHCP: ${dhcpResult.reason?.message || 'Error (bridge /dhcp-leases belum tersedia?)'}`)
    }

    syncStatus.value = messages.join(' | ')
    await loadDevices()
  } catch (e) {
    syncStatus.value = 'Gagal sync: ' + e.message
  }
}

const handleRefreshQueue = async () => {
  await triggerSync()
  await loadDevices()
}

const informAllClients = async () => {
  const targets = informableClients.value
  if (!targets.length) {
    informStatus.value = 'Tidak ada ONT dengan IP untuk inform.'
    return
  }

  isInformingAll.value = true
  syncStatus.value = ''
  informStatus.value = `Mengirim trigger inform ke ${targets.length} ONT...`
  let success = 0
  let failed = 0
  const failureMessages = []

  for (let index = 0; index < targets.length; index++) {
    const client = targets[index]
    const ip = getClientTriggerIp(client)
    if (!ip) continue
    try {
      syncProgressMap.value[ip] = {
        id: client.id,
        username: client.name,
        progress: 10,
        status: 'triggered',
        updatedAt: Date.now()
      }
      await api.syncModem(ip, client.id)
      success += 1
    } catch (err) {
      console.error(`Gagal inform ${client.name}:`, err)
      failed += 1
      failureMessages.push(`${client.name}: ${err.message || 'Gagal trigger'}`)
      syncProgressMap.value[ip] = {
        id: client.id,
        username: client.name,
        progress: 100,
        status: 'failed',
        error: err.message || 'Gagal mengirim trigger',
        updatedAt: Date.now()
      }
    }
  }

  informStatus.value = failed
    ? `Trigger gagal ${failed}/${targets.length}. ${failureMessages.slice(0, 2).join(' | ')}`
    : `Trigger terkirim ke ${success} ONT. Mulai polling status...`
  isInformingAll.value = false
  
  startProgressPolling()
}

const startPlotClient = (client) => {
  if (!odpOptions.value.length) {
    informStatus.value = 'Belum ada ODP di peta. Tambahkan ODP dulu sebelum plotting pelanggan.'
    return
  }
  plotError.value = ''
  selectedOdpId.value = odpOptions.value[0]?.id || ''
  isWorkflowOpen.value = false
  store.startPlotClient(client)
}

const openPlottedClient = (client) => {
  isWorkflowOpen.value = false
  if (map && hasCoords(client)) {
    map.setView([Number(client.lat), Number(client.lng)], 20)
  }
}

const startAddDevicePlacement = () => {
  store.startAddDevice()
}

const cancelPlotClient = () => {
  selectedOdpId.value = ''
  plotError.value = ''
  store.cancelAdd()
}

const savePlottedClient = async () => {
  if (!store.plottingClient || !store.pendingCoords) {
    plotError.value = 'Klik lokasi rumah pelanggan di peta terlebih dahulu.'
    return
  }
  if (!selectedOdpId.value) {
    plotError.value = 'Pilih ODP sebagai titik sambung pelanggan.'
    return
  }

  const odp = allDevicesData.value.find(d => d.id === selectedOdpId.value)
  const connectedClients = allDevicesData.value.filter(d => d.parentId === selectedOdpId.value)
  const maxCap = parseInt(odp?.capacity || odp?.portsCount || '8', 10)
  if (connectedClients.length >= maxCap) {
    const confirmPlot = confirm(`⚠️ Peringatan: ODP "${odp?.name || 'Terpilih'}" sudah penuh (${connectedClients.length}/${maxCap}). Menghubungkan pelanggan baru akan menyebabkan Over-subscription (cangkok paksa). Tetap lanjutkan?`)
    if (!confirmPlot) return
  }

  const client = store.plottingClient
  const coords = store.pendingCoords
  try {
    plotError.value = ''
    await api.updateDeviceParent(client.id, selectedOdpId.value, 'CLIENT')
    await api.updateDevice(client.id, {
      ...client,
      type: 'CLIENT',
      lat: coords.lat,
      lng: coords.lng,
      pppoeUsername: client.pppoeUsername,
      snModem: client.snModem
    })
    cancelPlotClient()
    await loadDevices()

    // Buka detail modal secara otomatis
    const savedClient = allDevicesData.value.find(d => d.id === client.id)
    if (savedClient) {
      selectedClient.value = savedClient
      isClientModalOpen.value = true
    }
  } catch (err) {
    plotError.value = 'Gagal menyimpan plotting: ' + err.message
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
    zoomControl: false,
    maxZoom: 22
  }).setView([-7.250445, 112.768845], 13) 

  L.control.zoom({ position: 'topright' }).addTo(map)

  lightLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 22,
    maxNativeZoom: 20
  })

  darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 22,
    maxNativeZoom: 20
  })

  satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    maxZoom: 22,
    maxNativeZoom: 19
  })

  // Set default map layer
  lightLayer.addTo(map)

  // Watcher untuk transisi mode tambah kabel
  watch(() => store.mapMode, (newMode) => {
    if (newMode !== 'ADD_CABLE') {
      if (tempPolyline) {
        if (map) map.removeLayer(tempPolyline)
        tempPolyline = null
      }
      tempPathCoords = []
      if (map) map.doubleClickZoom.enable()
    } else {
      if (map) map.doubleClickZoom.disable()
      // Inisialisasi rute dari induk
      const parentDevice = allDevicesData.value.find(d => d.id === store.selectedParentId)
      if (parentDevice && hasCoords(parentDevice)) {
        tempPathCoords = [[parentDevice.lat, parentDevice.lng]]
      }
    }
  })

  // Tangkap event klik di peta untuk koordinat (Mode Tambah Perangkat/Kabel/Plot)
  map.on('click', (e) => {
    // Klik di mana saja di peta akan keluar dari mode edit jalur kabel
    clearEditHandles()

    if (store.mapMode === 'VIEW') {
      if (isClientModalOpen.value) {
        isClientModalOpen.value = false
      }
      if (isWorkflowOpen.value) {
        isWorkflowOpen.value = false
      }
    } else if (store.mapMode === 'ADD_DEVICE') {
      store.openAddModal(e.latlng.lat, e.latlng.lng)
    } else if (store.mapMode === 'ADD_CABLE') {
      const parentDevice = allDevicesData.value.find(d => d.id === store.selectedParentId)
      if (!tempPathCoords.length && parentDevice && hasCoords(parentDevice)) {
        tempPathCoords.push([parentDevice.lat, parentDevice.lng])
      }
      tempPathCoords.push([e.latlng.lat, e.latlng.lng])
      
      if (tempPolyline) {
        tempPolyline.setLatLngs(tempPathCoords)
      } else {
        tempPolyline = L.polyline(tempPathCoords, {
          color: '#d97706',
          className: 'animated-cable',
          weight: 4,
          opacity: 0.8
        }).addTo(map)
      }
    } else if (store.mapMode === 'PLOT_CLIENT') {
      store.pendingCoords = { lat: e.latlng.lat, lng: e.latlng.lng }
    }
  })

  // Tangkap double click untuk menyelesaikan rute kabel
  map.on('dblclick', (e) => {
    if (store.mapMode === 'ADD_CABLE') {
      L.DomEvent.stopPropagation(e)
      
      if (tempPathCoords.length > 0) {
        // Tambahkan titik terakhir dari double-click
        tempPathCoords.push([e.latlng.lat, e.latlng.lng])
        store.pendingCablePath = [...tempPathCoords]
        
        // Buka modal di titik terakhir
        store.openAddModal(e.latlng.lat, e.latlng.lng)
      }
      
      if (tempPolyline) {
        map.removeLayer(tempPolyline)
        tempPolyline = null
      }
      tempPathCoords = []
    }
  })

  setTimeout(() => {
    map.invalidateSize()
  }, 100)

  window.addEventListener('refresh-map', loadDevices)
  window.addEventListener('tambah-kabel', handleTambahKabelEvent)
  window.addEventListener('lihat-detail', handleLihatDetailEvent)
  window.addEventListener('sync-mikrotik', triggerSync)
  window.addEventListener('open-provisioning-queue', handleOpenProvisioningQueue)
  
  loadDevices()
  startAutoRefresh()
})

onUnmounted(() => {
  stopAutoRefresh()
  window.removeEventListener('refresh-map', loadDevices)
  window.removeEventListener('tambah-kabel', handleTambahKabelEvent)
  window.removeEventListener('lihat-detail', handleLihatDetailEvent)
  window.removeEventListener('sync-mikrotik', triggerSync)
  window.removeEventListener('open-provisioning-queue', handleOpenProvisioningQueue)
})

watch(unmappedClients, (clients) => {
  window.dispatchEvent(new CustomEvent('customer-queue-count', {
    detail: { count: clients.length }
  }))
}, { immediate: true })
</script>

<template>
  <div class="relative w-full h-full" :class="{ 
    'is-placing-device': store.mapMode === 'ADD_DEVICE' || store.mapMode === 'PLOT_CLIENT'
  }">
    <div ref="mapContainer" class="absolute inset-0 z-0"></div>

    <!-- Map Layer Switcher (Top Right) -->
    <div class="absolute top-4 right-14 z-10 flex bg-white/95 border border-slate-200/80 p-0.5 rounded-lg shadow-md backdrop-blur-sm pointer-events-auto">
      <button 
        type="button"
        @click="setMapLayer('light')" 
        class="px-2.5 py-1.5 rounded-md text-[10px] font-bold uppercase transition-all border-0 cursor-pointer flex items-center gap-1"
        :class="activeMapLayer === 'light' ? 'bg-primary text-white' : 'bg-transparent text-slate-700 hover:bg-slate-100'"
      >
        <span class="material-symbols-outlined text-[14px]">light_mode</span>
        Light
      </button>
      <button 
        type="button"
        @click="setMapLayer('dark')" 
        class="px-2.5 py-1.5 rounded-md text-[10px] font-bold uppercase transition-all border-0 cursor-pointer flex items-center gap-1"
        :class="activeMapLayer === 'dark' ? 'bg-primary text-white' : 'bg-transparent text-slate-700 hover:bg-slate-100'"
      >
        <span class="material-symbols-outlined text-[14px]">dark_mode</span>
        Dark
      </button>
      <button 
        type="button"
        @click="setMapLayer('satellite')" 
        class="px-2.5 py-1.5 rounded-md text-[10px] font-bold uppercase transition-all border-0 cursor-pointer flex items-center gap-1"
        :class="activeMapLayer === 'satellite' ? 'bg-primary text-white' : 'bg-transparent text-slate-700 hover:bg-slate-100'"
      >
        <span class="material-symbols-outlined text-[14px]">satellite</span>
        Satelit
      </button>
    </div>

    <button
      v-if="store.mapMode === 'VIEW'"
      @click="startAddDevicePlacement"
      class="floating-add-node"
      title="Tambah perangkat"
    >
      <span class="material-symbols-outlined">add</span>
    </button>

    <div v-if="store.mapMode === 'PLOT_CLIENT'" class="absolute top-4 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-blue-200 bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg">
      Klik lokasi rumah {{ store.plottingClient?.name || 'pelanggan' }} di peta
    </div>

    <div v-if="store.mapMode === 'ADD_DEVICE'" class="placement-hint">
      <span class="material-symbols-outlined">add_location_alt</span>
      <span>Klik titik perangkat di peta</span>
      <button @click="store.cancelAdd()">Batal</button>
    </div>

    <!-- Banner Info Edit Rute Kabel -->
    <div v-if="activeEditDevice" class="absolute top-4 left-1/2 z-20 -translate-x-1/2 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-4 text-white flex items-center gap-4 max-w-[calc(100%-2rem)] w-full md:w-auto">
      <span class="material-symbols-outlined text-orange-400 text-2xl flex-shrink-0">timeline</span>
      <div class="flex-1 min-w-0">
        <h4 class="text-xs font-bold text-slate-300">Mengedit Jalur Kabel: {{ activeEditDevice.name }}</h4>
        <p class="text-[10px] text-slate-400 mt-0.5 leading-relaxed">Geser titik jingga untuk membelokkan rute. Tarik titik jingga kecil untuk menyisipkan titik baru. Klik ganda titik untuk menghapus.</p>
      </div>
      <button @click="saveAndExitEditPath" class="bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-2 rounded-lg text-xs font-black transition-all shadow-md flex-shrink-0 cursor-pointer">
        Simpan Jalur
      </button>
    </div>

    <div v-if="isWorkflowOpen" class="workflow-modal-backdrop" @click.self="isWorkflowOpen = false">
      <aside class="workflow-panel">
        <header class="workflow-toggle">
          <div class="workflow-title">
            <span class="material-symbols-outlined">dynamic_feed</span>
            <div>
              <strong>Fiber Queue</strong>
              <small>{{ unmappedClients.length }} Pending • {{ plottedClients.length }} Done</small>
            </div>
          </div>
          <button type="button" class="workflow-close" @click="isWorkflowOpen = false" aria-label="Tutup Fiber Queue">
            <span class="material-symbols-outlined">close</span>
          </button>
        </header>

      <div class="workflow-body">
        <div v-if="syncStatus || informStatus" class="workflow-status">{{ informStatus || syncStatus }}</div>
        <label class="workflow-search">
          <span class="material-symbols-outlined">search</span>
          <input v-model="workflowSearch" placeholder="Cari nama / IP / SN" />
        </label>

        <div class="queue-filter-bar is-plot-filter">
          <button :class="{ active: queuePlotFilter === 'UNMAPPED' }" @click="queuePlotFilter = 'UNMAPPED'">
            <span class="material-symbols-outlined">pending_actions</span>Pending
          </button>
          <button :class="{ active: queuePlotFilter === 'PLOTTED' }" @click="queuePlotFilter = 'PLOTTED'">
            <span class="material-symbols-outlined">where_to_vote</span>Done
          </button>
        </div>

        <div v-if="!visibleWorkflowClients.length" class="workflow-empty">Tidak ada client sesuai filter.</div>
        <article
          v-for="client in visibleWorkflowClients"
          :key="client.id"
          class="workflow-client"
          :class="{ 'is-plotted': hasCoords(client), 'is-clickable': hasCoords(client) }"
          @click="hasCoords(client) ? openPlottedClient(client) : null"
          :title="hasCoords(client) ? 'Klik untuk menuju client di peta' : ''"
        >
          <!-- Baris 1: Nama & Aksi -->
          <div class="workflow-client-header">
            <div class="client-title-area">
              <span class="material-symbols-outlined client-icon" :class="client.clientType === 'HOTSPOT' ? 'hotspot' : 'pppoe'">
                {{ client.clientType === 'HOTSPOT' ? 'wifi' : 'settings_ethernet' }}
              </span>
              <strong class="client-name" :title="client.name">{{ client.name }}</strong>
            </div>
            
            <div class="client-actions">
              <!-- Tombol Sync (Jika belum siap / belum di-sync) -->
              <button 
                v-if="!isClientReadyForPlot(client)"
                type="button" 
                class="btn-sync-icon"
                @click.stop="informSingleClient(client)" 
                :disabled="!getClientTriggerIp(client) || isClientSyncing(client) || isClientWaitingPersistedData(client)"
                :title="isClientWaitingPersistedData(client) ? 'Menunggu data tersimpan' : (isClientSyncing(client) ? 'Sedang sinkronisasi...' : 'Tarik data inform modem')"
              >
                <span class="material-symbols-outlined text-[13px]" :class="{ spin: isClientSyncing(client) }">sensors</span>
                <span>Sync</span>
              </button>
              
              <!-- Tombol Plot (Jika siap/bisa di-plot) -->
              <button
                v-if="!hasCoords(client)"
                class="btn-plot"
                @click.stop="startPlotClient(client)"
                :disabled="!odpOptions.length"
                title="Plot pelanggan ke peta"
              >
                <span class="material-symbols-outlined text-[13px]">location_on</span>
                <span>Plot</span>
              </button>
            </div>
          </div>

          <!-- Baris 2: Detail IP & Tipe Koneksi -->
          <div class="workflow-client-info">
            <span class="info-ip">{{ getClientDisplayIp(client) || 'No IP' }}</span>
            <span class="info-divider">•</span>
            <span class="info-type" :class="client.clientType === 'HOTSPOT' ? 'hotspot' : 'pppoe'">
              {{ client.clientType === 'HOTSPOT' ? 'Hotspot' : 'PPPoE' }}
            </span>
          </div>

          <!-- Baris 3: Lencana Status -->
          <div class="workflow-client-badges">
            <span class="status-badge" :class="hasCoords(client) ? 'plotted' : 'unmapped'">
              {{ hasCoords(client) ? 'Done' : 'Pending' }}
            </span>
          </div>

          <!-- Progress Bar Sinkronisasi Modem -->
          <div v-if="getSyncProgress(client)" class="workflow-progress-container mt-1">
            <div class="workflow-progress-bg">
              <div class="workflow-progress-bar" :style="{ width: `${getSyncProgress(client).progress}%` }"></div>
              <span class="workflow-progress-text">{{ getSyncProgress(client).progress }}%</span>
            </div>
            <div class="workflow-progress-status">
              <span class="material-symbols-outlined spin text-[10px]">sync</span>
              <span>{{ getSyncProgressMessage(getSyncProgress(client)) }}</span>
            </div>
          </div>
        </article>

        <div class="workflow-actions">
          <button type="button" @click="handleRefreshQueue">
            <span class="material-symbols-outlined">refresh</span>
            Refresh
          </button>
          <button type="button" class="primary" @click="informAllClients" :disabled="isInformingAll || !informableClients.length">
            <span class="material-symbols-outlined" :class="{ spin: isInformingAll }">sensors</span>
            Inform
          </button>
        </div>
      </div>
      </aside>
    </div>

    <section v-if="store.mapMode === 'PLOT_CLIENT' && store.pendingCoords" class="plot-confirm">
      <div class="plot-title">
        <span class="material-symbols-outlined">add_location_alt</span>
        <div>
          <h3>Simpan Titik Rumah</h3>
          <p>{{ store.plottingClient?.name }}</p>
        </div>
      </div>
      <label>
        Tersambung ke ODP
        <select v-model="selectedOdpId">
          <option value="">Pilih ODP</option>
          <option v-for="odp in odpOptions" :key="odp.id" :value="odp.id">
            {{ odp.name }}
          </option>
        </select>
      </label>
      <div class="coord-preview">
        {{ store.pendingCoords.lat.toFixed(6) }}, {{ store.pendingCoords.lng.toFixed(6) }}
      </div>
      <div v-if="plotError" class="plot-error">{{ plotError }}</div>
      <div class="plot-actions">
        <button type="button" @click="cancelPlotClient">Batal</button>
        <button type="button" class="primary" @click="savePlottedClient">Simpan & Tarik Line</button>
      </div>
    </section>
    
    <!-- Floating Map Controls & Legend -->
    <div class="absolute left-4 bottom-4 md:left-6 md:bottom-6 z-10 w-[calc(100%-2rem)] max-w-[280px] pointer-events-auto">
       <div class="bg-transparent px-4 py-3 text-slate-800">
          <div class="flex flex-col gap-2.5 text-[11px] font-bold text-slate-900 bg-white/40 backdrop-blur-[3px] p-2.5 rounded-lg border border-slate-300/30">
            <!-- Header Legend -->
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-700 border-b border-slate-300/20 pb-1.5 mb-0.5">
              Legend
            </div>
            <!-- OLT -->
            <div class="flex items-center gap-2.5">
              <div class="w-4 h-4 bg-[#0050cb] rounded border border-white shadow-sm flex items-center justify-center font-bold text-[8px] text-white">OLT</div>
              <span>OLT (Pusat)</span>
            </div>
            <!-- ODC -->
            <div class="flex items-center gap-2.5">
              <div class="w-4 h-3 bg-[#64748b] rounded border border-white shadow-sm"></div>
              <span>ODC (Splitter 1)</span>
            </div>
            <!-- ODP (Normal) -->
            <div class="flex items-center gap-2.5">
              <div class="w-4 h-3 bg-[#d97706] rounded border border-white shadow-sm"></div>
              <span>ODP (Normal)</span>
            </div>
            <!-- ODP Mass LOS -->
            <div class="flex items-center gap-2.5">
              <div class="w-4 h-3 bg-[#dc2626] rounded border border-white shadow-sm animate-pulse"></div>
              <span class="text-red-600 font-bold">ODP Mass LOS (Putus)</span>
            </div>
            <!-- Client Online -->
            <div class="flex items-center gap-2.5">
              <div class="w-3.5 h-3.5 bg-[#16a34a] rounded-full border border-white shadow-sm"></div>
              <span>Client (Online)</span>
            </div>
            <!-- Client Warning -->
            <div class="flex items-center gap-2.5">
              <div class="w-3.5 h-3.5 bg-[#f59e0b] rounded-full border border-white shadow-sm"></div>
              <span>Sinyal Lemah (&gt;-27dB)</span>
            </div>
            <!-- Client Offline -->
            <div class="flex items-center gap-2.5">
              <div class="w-3.5 h-3.5 bg-[#dc2626] rounded-full border border-white shadow-sm animate-pulse"></div>
              <span class="text-red-600 font-bold">LOS (Kabel Putus)</span>
            </div>
            <!-- Client Mati Listrik -->
            <div class="flex items-center gap-2.5">
              <div class="w-3.5 h-3.5 bg-[#dc2626] rounded-full border border-white shadow-sm flex items-center justify-center text-[9px]">🔌</div>
              <span>CPE Mati Listrik</span>
            </div>
          </div>
       </div>
    </div>
    
    <!-- Device Detail & Alur Modal -->
    <ClientDetailModal 
      :is-open="isClientModalOpen"
      :device="selectedClient"
      :all-devices="allDevicesData"
      @start-route="startRouteFromDevice"
      @delete-device="deleteDevice"
      @close="isClientModalOpen = false"
    />
  </div>
</template>

<style scoped>
/* Any specific leaflet overrides can go here */
:deep(.leaflet-container) {
  background-color: #f8f9fa;
}

.floating-add-node {
  position: absolute;
  right: 24px;
  bottom: 24px;
  z-index: 20;
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border: 1px solid rgba(255, 255, 255, 0.75);
  border-radius: 999px;
  background: #0050cb;
  color: #fff;
  box-shadow: 0 18px 36px rgba(0, 80, 203, 0.34);
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease;
}

.floating-add-node:hover {
  transform: translateY(-2px);
  box-shadow: 0 22px 42px rgba(0, 80, 203, 0.42);
}

.floating-add-node .material-symbols-outlined {
  font-size: 30px;
}

.is-placing-device :deep(.leaflet-container),
.is-placing-device :deep(.leaflet-interactive),
.is-placing-device :deep(.leaflet-grab),
.is-placing-device :deep(.leaflet-marker-icon) {
  cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="%233b82f6" stroke="%23ffffff" stroke-width="2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>') 16 32, crosshair !important;
}

.placement-hint {
  position: absolute;
  top: 16px;
  left: 50%;
  z-index: 20;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100% - 24px);
  transform: translateX(-50%);
  border: 1px solid rgba(191, 219, 254, 0.7);
  border-radius: 999px;
  background: rgba(0, 80, 203, 0.94);
  color: #fff;
  padding: 10px 12px 10px 14px;
  box-shadow: 0 14px 32px rgba(15, 23, 42, 0.22);
  font-size: 13px;
  font-weight: 900;
  white-space: nowrap;
}

.placement-hint .material-symbols-outlined {
  font-size: 18px;
}

.placement-hint button {
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  padding: 4px 9px;
  font-size: 11px;
  font-weight: 900;
  cursor: pointer;
}

:deep(.network-marker) {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--marker-color);
  border: 3px solid #fff;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.28);
}

:deep(.network-marker.client-warning) {
  box-shadow: 0 0 0 5px rgba(245, 158, 11, 0.2), 0 4px 14px rgba(15, 23, 42, 0.28);
}

:deep(.client-offline-blink) {
  animation: client-blink 1.1s ease-in-out infinite;
}

:deep(.odp-mass-los-blink) {
  animation: odp-blink 1.2s ease-in-out infinite;
}

@keyframes client-blink {
  0%, 100% {
    opacity: 1;
    box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.45), 0 4px 14px rgba(15, 23, 42, 0.28);
  }
  50% {
    opacity: 0.45;
    box-shadow: 0 0 0 8px rgba(220, 38, 38, 0.1), 0 4px 14px rgba(15, 23, 42, 0.28);
  }
}

@keyframes odp-blink {
  0%, 100% {
    filter: drop-shadow(0px 3px 8px rgba(220, 38, 38, 0.9));
    transform: scale(1);
  }
  50% {
    filter: drop-shadow(0px 0px 0px rgba(220, 38, 38, 0));
    transform: scale(1.12);
  }
}

.workflow-modal-backdrop {
  position: fixed;
  top: 80px;
  left: 24px;
  bottom: 24px;
  width: 640px;
  max-width: calc(100vw - 48px);
  z-index: 1000;
  display: flex;
  pointer-events: none;
}

.workflow-panel {
  width: 100%;
  height: fit-content;
  max-height: 100%;
  overflow-y: auto;
  border: 1px solid rgba(148, 163, 184, 0.15);
  border-radius: 16px;
  background: #0f172a; /* Slate 900 solid, no background bleed-through */
  box-shadow: 0 10px 40px rgba(2, 6, 23, 0.55);
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  animation: scaleInLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes scaleInLeft {
  from { transform: translateX(-20px) scale(0.95); opacity: 0; }
  to { transform: translateX(0) scale(1); opacity: 1; }
}

.workflow-toggle {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(8, 18, 32, 0.42);
  color: #e5edf8;
  padding: 14px 16px;
}

.workflow-title {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 10px;
}

.workflow-title > .material-symbols-outlined {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  border: 1px solid rgba(96, 165, 250, 0.34);
  border-radius: 12px;
  background: rgba(37, 99, 235, 0.18);
  color: #93c5fd;
  font-size: 21px;
}

.workflow-title strong {
  display: block;
  color: #f8fafc;
  font-size: 17px;
  font-weight: 900;
}

.workflow-title small {
  display: block;
  margin-top: 2px;
  color: #94a3b8;
  font-size: 11px;
  font-weight: 800;
}

.workflow-close {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.52);
  color: #cbd5e1;
  cursor: pointer;
}

.workflow-close:hover {
  border-color: rgba(248, 113, 113, 0.58);
  color: #fca5a5;
}

.workflow-close .material-symbols-outlined {
  font-size: 19px;
}

.workflow-body {
  display: grid;
  grid-template-columns: 1fr;
  max-height: calc(min(82vh, 720px) - 68px);
  gap: 8px;
  overflow-y: auto;
  padding: 12px;
}

.workflow-status,
.workflow-empty,
.workflow-search,
.queue-filter-bar,
.workflow-actions {
  grid-column: 1 / -1;
}

.workflow-status,
.workflow-empty {
  border: 1px solid rgba(96, 165, 250, 0.16);
  border-radius: 9px;
  background: rgba(37, 99, 235, 0.12);
  color: #bfdbfe;
  padding: 7px 8px;
  font-size: 11px;
  font-weight: 800;
}

.workflow-empty {
  background: rgba(13, 26, 44, 0.48);
  color: #94a3b8;
}

/* Filter bar antrian - status plotting */
.queue-filter-bar {
  display: flex;
  gap: 4px;
  padding: 2px;
  background: rgba(2, 6, 23, 0.34);
  border: 1px solid rgba(148, 163, 184, 0.12);
  border-radius: 9px;
}

.queue-filter-bar button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #94a3b8;
  font-size: 10px;
  font-weight: 700;
  padding: 4px 6px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.queue-filter-bar button.active {
  background: rgba(37, 99, 235, 0.25);
  color: #93c5fd;
}

.queue-filter-bar button:hover:not(.active) {
  background: rgba(255, 255, 255, 0.05);
  color: #cbd5e1;
}

.queue-filter-bar.is-plot-filter .material-symbols-outlined {
  font-size: 13px;
}

.filter-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.filter-dot.pppoe { background: #3b82f6; }
.filter-dot.hotspot { background: #f97316; }

/* Badge tipe koneksi client */
.client-type-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 8px;
  font-weight: 800;
  padding: 1px 5px;
  border-radius: 999px;
  letter-spacing: 0.03em;
  line-height: 1.5;
  white-space: nowrap;
}

.client-type-badge.pppoe {
  background: rgba(59, 130, 246, 0.18);
  color: #93c5fd;
  border: 1px solid rgba(59, 130, 246, 0.3);
}

.client-type-badge.hotspot {
  background: rgba(249, 115, 22, 0.18);
  color: #fdba74;
  border: 1px solid rgba(249, 115, 22, 0.3);
}

.workflow-search {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 10px;
  background: rgba(2, 6, 23, 0.34);
  padding: 7px 8px;
}

.workflow-search .material-symbols-outlined {
  color: #7dd3fc;
  font-size: 16px;
}

.workflow-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: #e5edf8;
  font-size: 11px;
  font-weight: 800;
  outline: none;
}

.workflow-search input::placeholder {
  color: #64748b;
}

.workflow-client {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(108px, 0.55fr) minmax(168px, 0.8fr);
  align-items: center;
  gap: 8px;
  border: 1px solid rgba(148, 163, 184, 0.12);
  border-radius: 10px;
  background: rgba(30, 41, 59, 0.45);
  padding: 9px 10px;
  transition: border-color 0.2s, background-color 0.2s;
}

.workflow-client.is-plotted {
  border-color: rgba(16, 185, 129, 0.16);
  background: rgba(15, 35, 38, 0.42);
}

.workflow-client.is-clickable {
  cursor: pointer;
}

.workflow-client.is-clickable:hover {
  border-color: rgba(16, 185, 129, 0.34);
  background: rgba(15, 35, 38, 0.58);
}

.workflow-client:hover {
  border-color: rgba(96, 165, 250, 0.25);
  background: rgba(30, 41, 59, 0.65);
}

.workflow-client-header {
  grid-column: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.client-title-area {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.client-icon {
  font-size: 16px;
  flex-shrink: 0;
}
.client-icon.pppoe {
  color: #60a5fa;
}
.client-icon.hotspot {
  color: #fb923c;
}

.client-name {
  color: #f8fafc;
  font-size: 12px;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.client-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.btn-sync-icon,
.btn-plot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px !important;
  height: 24px;
  padding: 0 10px !important;
  border-radius: 6px !important;
  font-size: 10px !important;
  font-weight: 800 !important;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.btn-sync-icon {
  border: 1px solid rgba(59, 130, 246, 0.3) !important;
  background: rgba(59, 130, 246, 0.1) !important;
  color: #60a5fa !important;
}
.btn-sync-icon:hover:not(:disabled) {
  background: rgba(59, 130, 246, 0.25) !important;
  color: #ffffff !important;
}

.btn-plot {
  background: #2563eb !important;
  color: #ffffff !important;
  border: 0 !important;
}
.btn-plot:hover:not(:disabled) {
  background: #1d4ed8 !important;
}

.workflow-client-info {
  grid-column: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: #94a3b8;
  font-size: 10px;
  font-weight: 600;
  min-width: 0;
}

.info-ip {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.info-divider {
  opacity: 0.4;
}
.info-type {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.info-type.pppoe {
  color: #93c5fd;
}
.info-type.hotspot {
  color: #fdba74;
}

.workflow-client-badges {
  grid-column: 3;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.status-badge {
  font-size: 9px;
  font-weight: 800;
  padding: 2px 7px;
  border-radius: 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.status-badge.ready {
  background: rgba(16, 185, 129, 0.12);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.2);
}
.status-badge.syncing {
  background: rgba(14, 165, 233, 0.12);
  color: #38bdf8;
  border: 1px solid rgba(14, 165, 233, 0.2);
}
.status-badge.waiting {
  background: rgba(245, 158, 11, 0.12);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.2);
}

.status-badge.saved {
  background: rgba(99, 102, 241, 0.12);
  color: #818cf8;
  border: 1px solid rgba(99, 102, 241, 0.2);
}
.status-badge.pending {
  background: rgba(148, 163, 184, 0.1);
  color: #94a3b8;
  border: 1px solid rgba(148, 163, 184, 0.18);
}

.status-badge.plotted {
  background: rgba(16, 185, 129, 0.12);
  color: #6ee7b7;
  border: 1px solid rgba(16, 185, 129, 0.22);
}

.status-badge.unmapped {
  background: rgba(245, 158, 11, 0.1);
  color: #fcd34d;
  border: 1px solid rgba(245, 158, 11, 0.18);
}

.workflow-progress-container {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.workflow-progress-bg {
  position: relative;
  width: 100%;
  height: 10px;
  background: rgba(2, 6, 23, 0.6);
  border: 1px solid rgba(148, 163, 184, 0.1);
  border-radius: 999px;
  overflow: hidden;
}

.workflow-progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #06b6d4, #3b82f6);
  border-radius: 999px;
  transition: width 0.3s ease;
}

.workflow-progress-text {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 8px;
  font-weight: 800;
  color: #22d3ee;
  line-height: 1;
}

.workflow-progress-status {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 9px;
  font-weight: 700;
  color: #22d3ee;
}

.workflow-progress-status .material-symbols-outlined {
  font-size: 11px;
}

.workflow-informed {
  display: grid;
  gap: 5px;
  margin-top: 2px;
}

.workflow-label {
  color: #7dd3fc;
  font-size: 9px;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.workflow-informed-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  border: 1px solid rgba(52, 211, 153, 0.14);
  border-radius: 9px;
  background: rgba(6, 78, 59, 0.16);
  padding: 6px 7px;
}

.workflow-informed-row strong,
.workflow-informed-row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workflow-informed-row strong {
  color: #e2e8f0;
  font-size: 11px;
  font-weight: 900;
}

.workflow-informed-row small {
  color: #86efac;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  font-weight: 800;
}

.workflow-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
  margin-top: 2px;
}

.workflow-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.5);
  color: #dbeafe;
  cursor: pointer;
  font-size: 11px;
  font-weight: 900;
}

.workflow-actions button.primary {
  border-color: rgba(52, 211, 153, 0.2);
  background: rgba(5, 150, 105, 0.72);
  color: #ecfdf5;
}

.workflow-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.workflow-actions .material-symbols-outlined {
  font-size: 16px;
}

.spin {
  animation: map-spin 0.9s linear infinite;
}

@keyframes map-spin {
  to {
    transform: rotate(360deg);
  }
}

.plot-confirm {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 20;
  width: min(360px, calc(100% - 32px));
  border: 1px solid #bfdbfe;
  border-radius: 12px;
  background: #fff;
  padding: 14px;
  box-shadow: 0 18px 46px rgba(15, 23, 42, 0.18);
}

.plot-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.plot-title > .material-symbols-outlined {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: #dbeafe;
  color: #1d4ed8;
}

.plot-title h3 {
  margin: 0;
  color: #111827;
  font-size: 15px;
  font-weight: 900;
}

.plot-title p {
  margin: 2px 0 0;
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
}

.plot-confirm label {
  display: grid;
  gap: 6px;
  color: #475569;
  font-size: 11px;
  font-weight: 900;
  text-transform: uppercase;
}

.plot-confirm select {
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 9px;
  background: #fff;
  color: #111827;
  padding: 9px 10px;
  font-size: 13px;
  font-weight: 700;
  outline: none;
}

.coord-preview {
  margin-top: 10px;
  border-radius: 9px;
  background: #f8fafc;
  color: #475569;
  padding: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 800;
}

.plot-error {
  margin-top: 8px;
  color: #b91c1c;
  font-size: 12px;
  font-weight: 800;
}

.plot-actions {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 8px;
  margin-top: 12px;
}

.plot-actions button {
  border: 1px solid #d1d5db;
  border-radius: 9px;
  background: #fff;
  color: #334155;
  padding: 9px 10px;
  font-size: 12px;
  font-weight: 900;
}

.plot-actions button.primary {
  border-color: #0050cb;
  background: #0050cb;
  color: #fff;
}

@media (max-width: 768px) {
  .workflow-modal-backdrop {
    align-items: stretch;
    padding: 10px;
  }

  .workflow-panel {
    width: 100%;
    max-height: 100%;
  }

  .workflow-body {
    grid-template-columns: 1fr;
    max-height: calc(100vh - 92px);
  }

  .workflow-client {
    grid-template-columns: 1fr;
  }

  .workflow-client-header,
  .workflow-client-info,
  .workflow-client-badges,
  .workflow-progress-container {
    grid-column: 1;
  }

  .workflow-client-badges {
    justify-content: flex-start;
  }

  .plot-confirm {
    right: 12px;
    bottom: 12px;
    left: 12px;
    width: auto;
  }
}
</style>
