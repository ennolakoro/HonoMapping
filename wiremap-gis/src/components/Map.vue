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
const isWorkflowOpen = ref(true)
const workflowSearch = ref('')
// Filter antrian: 'ALL' | 'PPPOE' | 'HOTSPOT'
const queueFilter = ref('ALL')

const syncProgressMap = ref({})
let pollInterval = null

const startProgressPolling = () => {
  if (pollInterval) return
  pollInterval = setInterval(async () => {
    try {
      const statusMap = await api.getModemSyncStatus()
      syncProgressMap.value = { ...syncProgressMap.value, ...statusMap }

      const activeSyncs = Object.values(syncProgressMap.value).some(
        info => info.status === 'triggered' || info.status === 'connected' || info.status === 'fetching'
      )

      if (activeSyncs) {
        await loadDevices()
      } else {
        stopProgressPolling()
        await loadDevices()
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

// Helper: dapatkan triggerIp client (lanIp untuk HOTSPOT, wanIp untuk PPPoE)
const getClientTriggerIp = (client) => client.triggerIp || client.lanIp || client.wanIp || null

const getSyncProgress = (client) => {
  const ip = getClientTriggerIp(client)
  if (!ip) return null
  const info = syncProgressMap.value[ip]
  if (!info) return null
  if (info.status === 'idle') return null
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
  if (info.status === 'success') return 'Selesai!'
  if (info.status === 'failed') return `Gagal: ${info.error || 'Fault/Timeout'}`
  return ''
}

const informSingleClient = async (client) => {
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

const hasCoords = (device) => {
  const lat = Number(device?.lat)
  const lng = Number(device?.lng)
  return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0
}

const unmappedClients = computed(() =>
  allDevicesData.value.filter(device => device.type === 'CLIENT' && !hasCoords(device))
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

const informedClients = computed(() =>
  allDevicesData.value.filter(device => device.type === 'CLIENT' && hasModemData(device))
)

const matchesWorkflowSearch = (device) => {
  const query = workflowSearch.value.trim().toLowerCase()
  if (!query) return true
  return [
    device?.name,
    device?.pppoeUsername,
    device?.wanIp,
    device?.snModem
  ].some(value => String(value || '').toLowerCase().includes(query))
}

const visibleUnmappedClients = computed(() => {
  return unmappedClients.value.filter(d => {
    if (!matchesWorkflowSearch(d)) return false
    if (queueFilter.value === 'PPPOE') return (d.clientType || 'PPPOE') === 'PPPOE'
    if (queueFilter.value === 'HOTSPOT') return d.clientType === 'HOTSPOT'
    return true
  })
})

const visibleInformedClients = computed(() =>
  informedClients.value.filter(matchesWorkflowSearch)
)

const informableClients = computed(() =>
  visibleUnmappedClients.value.filter(device => !!getClientTriggerIp(device))
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
  if (!device?.isOnline) return 'offline'
  const rx = parseFloat(device.rxPower)
  if (Number.isNaN(rx)) return 'good'
  if (rx <= -28) return 'offline'
  if (rx <= -26) return 'warning'
  return 'good'
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
    bgColor = type === 'ODC' ? '#64748b' : '#d97706'
    const glowColor = type === 'ODC' ? 'rgba(100, 116, 139, 0.45)' : 'rgba(217, 119, 6, 0.45)'
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
    return L.divIcon({
      className: 'custom-node-icon',
      html: svgContent,
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    })
  }
  
  if (type === 'CLIENT') {
    const health = getClientHealth(device)
    bgColor = health === 'warning' ? '#f59e0b' : health === 'offline' ? '#dc2626' : '#16a34a'
    const glowColor = health === 'warning' ? 'rgba(245, 158, 11, 0.45)' : health === 'offline' ? 'rgba(220, 38, 38, 0.45)' : 'rgba(22, 163, 74, 0.45)'
    
    svgContent = `
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0px 2px 4px ${glowColor});">
        <circle cx="12" cy="12" r="10" fill="${bgColor}" stroke="white" stroke-width="1.5"/>
        <path d="M12 15h.01M9.5 12.5a3.5 3.5 0 0 1 5 0M7 10a7 7 0 0 1 10 0" stroke="white" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
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
              }
            }

            updateLengthLabel(latlngs)

            polyline.on('click', (e) => {
              if (store.mapMode !== 'VIEW') return
              if (e.originalEvent) {
                e.originalEvent.stopPropagation()
              }

              clearEditHandles()
              activeEditDevice.value = device
              editPolyline = polyline

              const currentCoords = polyline.getLatLngs().map(latlng => [latlng.lat, latlng.lng])

              currentCoords.forEach((coord, idx) => {
                const handleIcon = L.divIcon({
                  className: 'cable-edit-handle',
                  html: '<div style="width:12px; height:12px; border-radius:50%; background:#fb923c; border:2px solid white; box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>',
                  iconSize: [12, 12],
                  iconAnchor: [6, 6]
                })

                const handle = L.marker(coord, {
                  icon: handleIcon,
                  draggable: true
                }).addTo(map)

                handle.on('drag', (ev) => {
                  const newLatLng = ev.latlng
                  currentCoords[idx] = [newLatLng.lat, newLatLng.lng]
                  polyline.setLatLngs(currentCoords)
                  updateLengthLabel(currentCoords)
                })

                handle.on('dragend', async () => {
                  try {
                    await api.updateDevice(device.id, {
                      type: device.type,
                      name: device.name,
                      cablePath: JSON.stringify(currentCoords)
                    })
                    device.cablePath = JSON.stringify(currentCoords)
                  } catch (err) {
                    console.error("Failed to save edited path:", err)
                  }
                })

                editHandles.push(handle)
              })
            })

            polyline.addTo(polylineLayer)
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
    ? `Trigger terkirim: ${success} berhasil, ${failed} gagal. Mulai polling status...`
    : `Trigger terkirim ke ${success} ONT. Mulai polling status...`
  isInformingAll.value = false
  
  startProgressPolling()
}

const startPlotClient = (client) => {
  plotError.value = ''
  selectedOdpId.value = odpOptions.value[0]?.id || ''
  store.startPlotClient(client)
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
    zoomControl: false
  }).setView([-7.250445, 112.768845], 13) 

  L.control.zoom({ position: 'topright' }).addTo(map)

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map)

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

    if (store.mapMode === 'ADD_DEVICE') {
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
  
  loadDevices()
})

onUnmounted(() => {
  window.removeEventListener('refresh-map', loadDevices)
  window.removeEventListener('tambah-kabel', handleTambahKabelEvent)
  window.removeEventListener('lihat-detail', handleLihatDetailEvent)
  window.removeEventListener('sync-mikrotik', triggerSync)
})
</script>

<template>
  <div class="relative w-full h-full" :class="{ 
    'is-placing-device': store.mapMode === 'ADD_DEVICE' || store.mapMode === 'PLOT_CLIENT'
  }">
    <div ref="mapContainer" class="absolute inset-0 z-0"></div>

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

    <aside class="workflow-panel">
      <button class="workflow-toggle" @click="isWorkflowOpen = !isWorkflowOpen" title="Buka/tutup antrian">
        <span class="text-xs font-bold uppercase tracking-wider text-blue-300">Antrian Pelanggan Baru</span>
        <span class="material-symbols-outlined text-[18px] text-blue-300">{{ isWorkflowOpen ? 'keyboard_arrow_up' : 'keyboard_arrow_down' }}</span>
      </button>

      <div v-if="isWorkflowOpen" class="workflow-body">
        <div v-if="syncStatus || informStatus" class="workflow-status">{{ informStatus || syncStatus }}</div>
        <label class="workflow-search">
          <span class="material-symbols-outlined">search</span>
          <input v-model="workflowSearch" placeholder="Cari nama / IP / SN" />
        </label>

        <!-- Filter Toggle Tipe Client -->
        <div class="queue-filter-bar">
          <button :class="{ active: queueFilter === 'ALL' }" @click="queueFilter = 'ALL'">Semua</button>
          <button :class="{ active: queueFilter === 'PPPOE' }" @click="queueFilter = 'PPPOE'"
            title="Client dengan koneksi PPPoE">
            <span class="filter-dot pppoe"></span>PPPoE
          </button>
          <button :class="{ active: queueFilter === 'HOTSPOT' }" @click="queueFilter = 'HOTSPOT'"
            title="Modem tanpa PPPoE (Hotspot/LAN)">
            <span class="filter-dot hotspot"></span>Hotspot
          </button>
        </div>

        <div v-if="!visibleUnmappedClients.length" class="workflow-empty">Tidak ada antrian plotting.</div>
        <article v-for="client in visibleUnmappedClients" :key="client.id" class="workflow-client flex-col items-stretch gap-1">
          <div class="flex items-center justify-between w-full">
            <div class="workflow-client-main">
              <span class="client-node-dot" :class="{ 'is-informed': hasModemData(client) }"></span>
              <div class="client-copy">
                <strong>{{ client.name }}</strong>
                <div class="flex items-center gap-1 mt-0.5">
                  <span class="text-[9px] px-1 py-0.5 rounded font-bold uppercase tracking-wider leading-none"
                    :class="hasModemData(client) ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-500/20' : 'bg-amber-950/80 text-amber-400 border border-amber-500/20'">
                    {{ hasModemData(client) ? 'Informed' : 'Belum Inform' }}
                  </span>
                  <!-- Badge tipe koneksi -->
                  <span class="client-type-badge" :class="client.clientType === 'HOTSPOT' ? 'hotspot' : 'pppoe'">
                    {{ client.clientType === 'HOTSPOT' ? '📶 Hotspot' : '🔵 PPPoE' }}
                  </span>
                  <span class="text-slate-400 text-[10px] truncate max-w-[90px]">
                    {{ client.triggerIp || client.wanIp || client.lanIp || 'IP belum aktif' }}
                  </span>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-1">
              <button 
                type="button" 
                class="workflow-sync-btn"
                @click="informSingleClient(client)" 
                :disabled="!getClientTriggerIp(client) || isClientSyncing(client)"
                :title="isClientSyncing(client) ? 'Sedang sinkronisasi...' : 'Tarik data inform modem'"
              >
                <span class="material-symbols-outlined text-sm" :class="{ spin: isClientSyncing(client) }">sensors</span>
              </button>
              <button @click="startPlotClient(client)" :disabled="!odpOptions.length || !hasModemData(client)" :title="!hasModemData(client) ? 'Tarik inform data modem terlebih dahulu untuk mem-plot client' : 'Plot pelanggan ke peta'">
                <span class="material-symbols-outlined">location_on</span>
                Plot
              </button>
            </div>
          </div>

          <!-- Progress Bar Sinkronisasi Modem -->
          <div v-if="getSyncProgress(client)" class="workflow-progress-container mt-1">
            <div class="workflow-progress-bg">
              <div class="workflow-progress-bar" :style="{ width: `${getSyncProgress(client).progress}%` }"></div>
              <span class="workflow-progress-text">{{ getSyncProgress(client).progress }}%</span>
            </div>
            <div class="workflow-progress-status">
              <span class="material-symbols-outlined spin">sync</span>
              <span>{{ getSyncProgressMessage(getSyncProgress(client)) }}</span>
            </div>
          </div>
        </article>

        <div v-if="visibleInformedClients.length" class="workflow-informed">
          <div class="workflow-label">Sudah Inform</div>
          <div v-for="client in visibleInformedClients" :key="`informed-${client.id}`" class="workflow-informed-row">
            <span class="client-node-dot is-informed"></span>
            <strong>{{ client.name }}</strong>
            <span class="client-type-badge text-[8px]" :class="client.clientType === 'HOTSPOT' ? 'hotspot' : 'pppoe'">{{ client.clientType === 'HOTSPOT' ? 'Hotspot' : 'PPPoE' }}</span>
            <small>{{ client.triggerIp || client.wanIp || client.snModem || 'Data modem tersimpan' }}</small>
          </div>
        </div>

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
    
    <!-- Floating Map Controls -->
    <div class="absolute left-4 bottom-4 md:left-6 md:bottom-6 z-10 w-[calc(100%-2rem)] max-w-[360px]">
       <div class="bg-surface-container-lowest/95 border border-outline-variant rounded-lg shadow-md backdrop-blur px-4 py-3">
          <div class="flex items-center justify-between gap-3 mb-3">
            <div>
              <div class="text-xs font-semibold text-on-surface">Network Topology</div>
              <div class="text-[11px] text-on-surface-variant">Layer perangkat dan jalur fiber</div>
            </div>
            <button @click="loadDevices" class="w-8 h-8 rounded border border-outline-variant bg-surface-container-lowest hover:bg-surface-container-high text-on-surface-variant flex items-center justify-center transition-colors cursor-pointer" title="Refresh map">
              <span class="material-symbols-outlined text-[18px]">refresh</span>
            </button>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-medium mb-3">
            <div class="flex items-center gap-1.5 text-on-surface-variant">
              <div class="w-3 h-3 bg-[#0050cb] rounded-full border-2 border-white shadow-sm"></div> OLT
            </div>
            <div class="flex items-center gap-1.5 text-on-surface-variant">
              <div class="w-3 h-3 bg-[#525b62] rounded-full border-2 border-white shadow-sm"></div> ODC
            </div>
            <div class="flex items-center gap-1.5 text-on-surface-variant">
              <div class="w-3 h-3 bg-[#d97706] rounded-full border-2 border-white shadow-sm"></div> ODP
            </div>
            <div class="flex items-center gap-1.5 text-on-surface-variant">
              <div class="w-3 h-3 bg-[#006e25] rounded-full border-2 border-white shadow-sm"></div> Client
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button @click="triggerSync" class="bg-primary-container hover:opacity-90 text-on-primary-container px-3 py-2 rounded text-xs font-semibold shadow-sm flex items-center justify-center gap-2 cursor-pointer transition-opacity border border-primary-container">
              <span class="material-symbols-outlined text-[16px]">sync</span> Sync PPPoE
            </button>
            <button @click="triggerClear" class="bg-surface-container-lowest hover:bg-error-container text-error px-3 py-2 rounded text-xs font-semibold shadow-sm flex items-center justify-center gap-2 cursor-pointer transition-colors border border-outline-variant">
              <span class="material-symbols-outlined text-[16px]">delete</span> Clear
            </button>
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

:deep(.network-marker.client-offline) {
  animation: client-blink 1.1s ease-in-out infinite;
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

.workflow-panel {
  position: absolute;
  top: 88px;
  right: 12px;
  z-index: 10;
  width: min(268px, calc(100% - 24px));
  overflow: hidden;
  border: 1px solid rgba(125, 211, 252, 0.18);
  border-radius: 14px;
  background:
    linear-gradient(135deg, rgba(8, 18, 32, 0.68), rgba(4, 12, 24, 0.46)),
    radial-gradient(circle at 90% 0%, rgba(59, 130, 246, 0.18), transparent 34%);
  box-shadow: 0 16px 44px rgba(2, 6, 23, 0.22);
  backdrop-filter: blur(12px) saturate(1.1);
}



.workflow-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  border: 0;
  background: rgba(8, 18, 32, 0.54);
  color: #e5edf8;
  padding: 8px 9px;
  cursor: pointer;
}

.workflow-toggle strong {
  display: grid;
  place-items: center;
  min-width: 22px;
  height: 22px;
  border-radius: 999px;
  background: rgba(37, 99, 235, 0.72);
  color: #fff;
  font-size: 11px;
  font-weight: 900;
}

.workflow-toggle .material-symbols-outlined {
  color: #bfdbfe;
  font-size: 20px;
}

.workflow-body {
  display: grid;
  max-height: min(360px, calc(100vh - 150px));
  gap: 7px;
  overflow-y: auto;
  padding: 8px;
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

/* Filter bar antrian - toggle PPPoE / Hotspot */
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
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 10px;
  background: rgba(8, 19, 34, 0.6);
  padding: 8px;
}

.workflow-sync-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid rgba(59, 130, 246, 0.3) !important;
  border-radius: 8px;
  background: rgba(59, 130, 246, 0.1) !important;
  color: #60a5fa !important;
  cursor: pointer;
  transition: all 0.2s ease;
}

.workflow-sync-btn:hover:not(:disabled) {
  background: rgba(59, 130, 246, 0.25) !important;
  color: #fff !important;
  border-color: rgba(59, 130, 246, 0.5) !important;
}

.workflow-sync-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.workflow-progress-container {
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

.workflow-client-main {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 9px;
}

.client-node-dot {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: #f59e0b;
  box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.12);
}

.client-node-dot.is-informed {
  width: 8px;
  height: 8px;
  background: #34d399;
  box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.12);
}

.client-copy {
  min-width: 0;
}

.client-copy strong,
.client-copy span,
.client-copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.client-copy strong {
  color: #f8fafc;
  font-size: 12px;
  font-weight: 900;
}

.client-copy span {
  color: #94a3b8;
  font-size: 11px;
  font-weight: 700;
}

.workflow-client button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  padding: 7px 8px;
  font-size: 11px;
  font-weight: 900;
  cursor: pointer;
}

.workflow-client button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.workflow-client button .material-symbols-outlined {
  font-size: 16px;
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
  .workflow-panel {
    top: 82px;
    right: 10px;
    width: min(258px, calc(100% - 20px));
  }



  .plot-confirm {
    right: 12px;
    bottom: 12px;
    left: 12px;
    width: auto;
  }
}
</style>
