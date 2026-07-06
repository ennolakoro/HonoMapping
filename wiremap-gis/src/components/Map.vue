<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { api } from '../api'
import ClientDetailModal from './ClientDetailModal.vue'
import ClientInventoryModal from './ClientInventoryModal.vue'
import { store } from '../store'

const mapContainer = ref(null)
let map = null
let deviceLayer = null
let polylineLayer = null
let hasAutoFittedDevices = false

const isClientModalOpen = ref(false)
const isLegendOpen = ref(false)
const isOutageLogsOpen = ref(false)
const outageLogs = ref(JSON.parse(localStorage.getItem('wiremap_outage_logs') || '[]'))
const selectedClient = ref(null)
const allDevicesData = ref([])

const clearOutageLogs = () => {
  outageLogs.value = []
  localStorage.setItem('wiremap_outage_logs', '[]')
}
const selectedOdpId = ref('')
const plotError = ref('')
const syncStatus = ref('')
const informStatus = ref('')
const isInformingAll = ref(false)
const isWorkflowOpen = ref(false)
const isClientInventoryOpen = ref(false)
const workflowSearch = ref('')
const mapDataStatus = ref({
  total: 0,
  plotted: 0,
  error: '',
  lastLoadAt: null
})
// Filter status plotting: 'UNMAPPED' | 'PLOTTED'
const queuePlotFilter = ref('UNMAPPED')

// Floating Navbar State & Autocomplete
const searchQuery = ref('')
const showSearchResults = ref(false)
const isDeviceListOpen = ref(false)
const deviceListSearchQuery = ref('')
const deviceListTypeFilter = ref('ALL')

const searchType = ref('location')
const searchLat = ref('')
const searchLng = ref('')

const zoomToSearchCoords = () => {
  const lat = parseFloat(searchLat.value)
  const lng = parseFloat(searchLng.value)
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    alert('Format koordinat tidak valid!')
    return
  }
  if (map) {
    map.setView([lat, lng], 20)
    const highlightIcon = L.divIcon({
      className: 'search-highlight-marker',
      html: '<div style="width:24px; height:24px; border-radius:50%; background:rgba(59, 130, 246, 0.4); border:2px solid #3b82f6; box-shadow:0 0 10px #3b82f6; animation:ping 1.5s infinite; transform:translate(-5px,-5px);"></div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    })
    const tempMarker = L.marker([lat, lng], { icon: highlightIcon }).addTo(map)
    setTimeout(() => {
      map.removeLayer(tempMarker)
    }, 6000)
  }
}

const filteredSearchDevices = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return []
  return allDevicesData.value.filter(d => 
    String(d.name || '').toLowerCase().includes(query) ||
    String(d.pppoeUsername || '').toLowerCase().includes(query) ||
    String(d.snModem || '').toLowerCase().includes(query)
  ).slice(0, 10)
})

const filteredListDevices = computed(() => {
  const query = deviceListSearchQuery.value.trim().toLowerCase()
  let list = allDevicesData.value
  
  if (deviceListTypeFilter.value !== 'ALL') {
    list = list.filter(d => d.type === deviceListTypeFilter.value)
  }
  
  if (!query) return list
  return list.filter(d => 
    String(d.name || '').toLowerCase().includes(query) ||
    String(d.type || '').toLowerCase().includes(query) ||
    String(d.pppoeUsername || '').toLowerCase().includes(query)
  )
})

const selectSearchDevice = (dev) => {
  showSearchResults.value = false
  searchQuery.value = ''
  zoomToDevice(dev)
}

const zoomToDevice = (dev) => {
  if (map && hasCoords(dev)) {
    map.setView([Number(dev.lat), Number(dev.lng)], 20)
    if (dev.type === 'CLIENT') {
      selectedClient.value = dev
      isClientModalOpen.value = true
    }
  } else {
    alert('Perangkat tidak memiliki koordinat di peta.')
  }
}

const openRouterSettings = () => {
  window.dispatchEvent(new CustomEvent('open-router-settings'))
}

const logoutRequest = () => {
  if (confirm('Apakah Anda yakin ingin logout dari sistem?')) {
    window.dispatchEvent(new CustomEvent('logout-request'))
  }
}

const zoomIn = () => {
  if (map) map.zoomIn()
}

const zoomOut = () => {
  if (map) map.zoomOut()
}

const refreshVisibleMap = () => {
  if (!map) return
  map.invalidateSize({ animate: false })
}

// Refresh ukuran peta DAN muat ulang data perangkat (dipanggil saat peta pertama kali terlihat)
const refreshMapAndLoadDevices = async () => {
  if (!map) return
  map.invalidateSize({ animate: false })
  await loadDevices()
}

const normalizeSavedDevice = (device) => {
  if (!device) return null
  return {
    ...device,
    parentId: device.parentId ?? device.parent_id ?? null,
    portsCount: device.portsCount ?? device.ports_count ?? null,
    cablePath: device.cablePath ?? device.cable_path ?? null
  }
}

const fitMapToDevicesOnce = (devices) => {
  if (!map || hasAutoFittedDevices) return
  const points = devices
    .filter(hasCoords)
    .map(device => [Number(device.lat), Number(device.lng)])

  if (!points.length) return
  hasAutoFittedDevices = true

  setTimeout(() => {
    if (!map) return
    map.invalidateSize({ animate: false })
    if (points.length === 1) {
      map.setView(points[0], 19)
      return
    }
    map.fitBounds(L.latLngBounds(points), {
      padding: [64, 64],
      maxZoom: 19,
      animate: false
    })
  }, 120)
}

const updateMapDataStatus = (devices, error = '') => {
  const list = Array.isArray(devices) ? devices : []
  mapDataStatus.value = {
    total: list.length,
    plotted: list.filter(hasCoords).length,
    error,
    lastLoadAt: new Date().toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }
}

const addMarkerToLayer = (device, sourceDevices = allDevicesData.value) => {
  if (!map || !hasCoords(device)) return null
  if (!deviceLayer) deviceLayer = L.layerGroup().addTo(map)

  const hasParent = device.parentId !== null && device.parentId !== undefined && device.parentId !== ''
  const hasChildren = sourceDevices.some(d => d.parentId === device.id)
  const hasCable = hasParent || hasChildren
  const isDraggable = !hasCable
  const zIndexOffset = device.type === 'OLT' ? 1000 : device.type === 'ODC' ? 2000 : device.type === 'ODP' ? 3000 : 4000

  const marker = L.marker([Number(device.lat), Number(device.lng)], {
    icon: getIconForType(device.type, device),
    draggable: isDraggable,
    riseOnHover: true,
    zIndexOffset
  })

  const dragTip = isDraggable
    ? ' <span style="color:#60a5fa; font-weight:bold;">(Geser Aktif)</span>'
    : ' <span style="color:#94a3b8;">(Kabel Terhubung - Terkunci)</span>'

  marker.bindTooltip(`<b>${device.name}</b><br/>${dragTip}`, {
    direction: 'top',
    offset: [0, -10],
    html: true
  })

  marker.on('click', () => {
    if (store.mapMode !== 'VIEW') return
    selectedClient.value = device
    isClientModalOpen.value = true
  })

  marker.addTo(deviceLayer)
  return marker
}

const handleDeviceSaved = async (event) => {
  const saved = normalizeSavedDevice(event.detail)
  if (!saved?.id) {
    await refreshMapAndLoadDevices()
    return
  }

  const existingIndex = allDevicesData.value.findIndex(device => device.id === saved.id && device.type === saved.type)
  const nextDevices = [...allDevicesData.value]
  if (existingIndex >= 0) nextDevices.splice(existingIndex, 1, saved)
  else nextDevices.push(saved)
  allDevicesData.value = nextDevices

  if (hasCoords(saved) && map) {
    map.invalidateSize({ animate: false })
    addMarkerToLayer(saved, nextDevices)
    map.setView([Number(saved.lat), Number(saved.lng)], Math.max(map.getZoom(), 18), { animate: false })
  }
}

const handleDocClickForSearch = (e) => {
  if (showSearchResults.value && !e.target.closest('.search-container-box')) {
    showSearchResults.value = false
  }
}

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
const polylineMap = ref({})
let adjacentCables = []

// Helper: mendeteksi jika dua koordinat dekat (< 12 meter) untuk snapping & co-dragging
const getClosestPointOnSegment = (p, a, b) => {
  const x = p[0], y = p[1]
  const x1 = a[0], y1 = a[1]
  const x2 = b[0], y2 = b[1]
  
  const dx = x2 - x1
  const dy = y2 - y1
  
  if (dx === 0 && dy === 0) return a
  
  let t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
  t = Math.max(0, Math.min(1, t))
  
  return [x1 + t * dx, y1 + t * dy]
}

const getClosestPointOnPolyline = (p, coordsList) => {
  let closestPt = null
  let minDistance = Infinity
  
  for (let i = 0; i < coordsList.length - 1; i++) {
    const pt = getClosestPointOnSegment(p, coordsList[i], coordsList[i+1])
    const dist = Math.sqrt(Math.pow(p[0] - pt[0], 2) + Math.pow(p[1] - pt[1], 2))
    if (dist < minDistance) {
      minDistance = dist
      closestPt = pt
    }
  }
  return { point: closestPt, distance: minDistance }
}

const isCloseCoord = (c1, c2) => {
  if (!c1 || !c2) return false
  const latDiff = Math.abs(c1[0] - c2[0])
  const lngDiff = Math.abs(c1[1] - c2[1])
  return latDiff < 0.0001 && lngDiff < 0.0001
}

const isSameCoord = (c1, c2) => {
  if (!c1 || !c2) return false
  const latDiff = Math.abs(c1[0] - c2[0])
  const lngDiff = Math.abs(c1[1] - c2[1])
  return latDiff < 0.00001 && lngDiff < 0.00001
}

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

    let dragStartCoord = [...coords[i]]

    handle.on('dragstart', () => {
      dragStartCoord = [...coords[i]]
    })

    handle.on('drag', (ev) => {
      const newLatLng = ev.latlng
      const newCoord = [newLatLng.lat, newLatLng.lng]
      
      // Snapping ke segmen garis kabel terdekat
      let snappedCoord = newCoord
      let minDistance = Infinity
      
      for (const adj of adjacentCables) {
        if (adj.coords.length >= 2) {
          const result = getClosestPointOnPolyline(newCoord, adj.coords)
          if (result.point && result.distance < minDistance) {
            minDistance = result.distance
            snappedCoord = result.point
          }
        }
      }
      if (minDistance > 0.000025) {
        snappedCoord = newCoord
      }
      
      coords[i] = snappedCoord
      editPolyline.setLatLngs(coords)
      if (editPolyline.clickPolyline) {
        editPolyline.clickPolyline.setLatLngs(coords)
      }

      // Geser bersama (co-drag) kabel tetangga yang posisinya berimpitan dengan koordinat dragStart
      adjacentCables.forEach(adj => {
        let changed = false
        adj.coords.forEach((pt, idx) => {
          // Lewati titik ujung (0 dan length-1) agar posisi fisik ODP / CPE tidak bergeser
          if (idx > 0 && idx < adj.coords.length - 1) {
            if (isSameCoord(pt, dragStartCoord)) {
              adj.coords[idx] = snappedCoord
              changed = true
            }
          }
        })
        if (changed) {
          adj.polyline.setLatLngs(adj.coords)
          if (adj.polyline.clickPolyline) {
            adj.polyline.clickPolyline.setLatLngs(adj.coords)
          }
          // Update label panjang kabel tetangga
          if (adj.polyline.lengthMarker) {
            const distM = calculatePolylineLength(adj.coords)
            const distStr = distM >= 1000 ? `${(distM / 1000).toFixed(2)} km` : `${Math.round(distM)} m`
            const mid = getPolylineMidpoint(adj.coords)
            if (mid) {
              adj.polyline.lengthMarker.setLatLng(mid)
              adj.polyline.lengthMarker.setIcon(L.divIcon({
                className: 'cable-length-label',
                html: `<div>${distStr}</div>`,
                iconSize: [60, 20],
                iconAnchor: [30, 10]
              }))
            }
          }
        }
      })
      
      dragStartCoord = [...snappedCoord]
      
      // Update label jarak real-time utama
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
      const newCoord = [newLatLng.lat, newLatLng.lng]
      
      // Snapping ke segmen garis kabel terdekat
      let snappedCoord = newCoord
      let minDistance = Infinity
      
      for (const adj of adjacentCables) {
        if (adj.coords.length >= 2) {
          const result = getClosestPointOnPolyline(newCoord, adj.coords)
          if (result.point && result.distance < minDistance) {
            minDistance = result.distance
            snappedCoord = result.point
          }
        }
      }
      if (minDistance > 0.000025) {
        snappedCoord = newCoord
      }

      coords[i + 1] = snappedCoord
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
      // 1. Simpan rute kabel utama
      await api.updateDevice(activeEditDevice.value.id, {
        type: activeEditDevice.value.type,
        name: activeEditDevice.value.name,
        cablePath: JSON.stringify(finalCoords)
      })
      activeEditDevice.value.cablePath = JSON.stringify(finalCoords)

      // 2. Simpan kabel tetangga (se-induk) yang ikut bergeser secara otomatis
      for (const adj of adjacentCables) {
        const hasChanged = JSON.stringify(adj.coords) !== JSON.stringify(adj.originalCoords)
        if (hasChanged) {
          await api.updateDevice(adj.device.id, {
            type: adj.device.type,
            name: adj.device.name,
            cablePath: JSON.stringify(adj.coords)
          })
          adj.device.cablePath = JSON.stringify(adj.coords)
        }
      }

      await loadDevices() // Menggambar ulang seluruh rute yang telah diperbarui
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

  const hasParent = device.parentId !== null && device.parentId !== undefined && device.parentId !== '';
  const hasChildren = allDevicesData.value.some(d => d.parentId === device.id);

  if (hasParent || hasChildren) {
    alert(`Perangkat "${device.name}" tidak dapat dihapus karena masih memiliki sambungan aktif (uplink/downlink). Silakan putuskan sambungan/route terlebih dahulu!`);
    return;
  }

  const confirmed = confirm(`Hapus ${device.type} "${device.name}"?`)
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
    
    if (!Array.isArray(devices)) {
      throw new Error('Data perangkat yang diterima dari server tidak valid (bukan array).');
    }
    updateMapDataStatus(devices)
    
    // Deteksi transisi status online -> offline (atau pemulihan) untuk log gangguan & alarm suara
    const isFirstLoad = Object.keys(previousOnlineStatuses).length === 0
    devices.forEach((device) => {
      if (device.type === 'CLIENT') {
        const currentOnline = device.isOnline
        const prevOnline = previousOnlineStatuses[device.id]
        
        if (!isFirstLoad && prevOnline !== undefined && prevOnline !== currentOnline) {
          let logMessage = ''
          let status = 'Down'
          
          if (currentOnline === false) {
            status = 'Down'
            const health = getClientHealth(device)
            if (health === 'power_failure') {
              logMessage = 'Mati Listrik (Dying Gasp)'
            } else {
              logMessage = 'LOS (Kabel Putus / Offline)'
            }
            playOutageAlarm()
          } else {
            status = 'Up'
            logMessage = 'Koneksi Pulih (Online)'
          }

          // Tambahkan ke riwayat log gangguan
          const nowStr = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          const newLog = {
            deviceName: device.name,
            status,
            message: logMessage,
            time: nowStr,
            timestamp: Date.now()
          }
          
          outageLogs.value.unshift(newLog)
          if (outageLogs.value.length > 100) {
            outageLogs.value = outageLogs.value.slice(0, 100)
          }
          localStorage.setItem('wiremap_outage_logs', JSON.stringify(outageLogs.value))
          console.log(`[LOG SINKRON] ${device.name} is ${status}: ${logMessage}`)
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

    // 1. Parsing awal semua koordinat kabel ke dalam memori
    const devicePaths = {}
    devices.forEach(device => {
      if (device.parentId && deviceMap[device.parentId] && hasCoords(device)) {
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
          if (!Array.isArray(latlngs) || !latlngs.length) {
            latlngs = [
              [Number(parent.lat), Number(parent.lng)],
              [Number(device.lat), Number(device.lng)]
            ]
          }
          const validPath = latlngs.every(point => {
            const lat = Number(point?.lat ?? point?.[0])
            const lng = Number(point?.lng ?? point?.[1])
            return Number.isFinite(lat) && Number.isFinite(lng)
          })
          if (validPath) devicePaths[device.id] = latlngs
        }
      }
    })

    // 2. Alinyemen otomatis (Auto-Snapping) secara dinamis pada saat rendering:
    // Jika ada koordinat vertex dari dua kabel se-induk yang berjarak dekat (< 5 meter),
    // sejajarkan mereka agar berimpit sempurna menjadi satu garis di peta.
    const pathKeys = Object.keys(devicePaths)
    for (let i = 0; i < pathKeys.length; i++) {
      const id1 = pathKeys[i]
      const dev1 = deviceMap[id1]
      const latlngs1 = devicePaths[id1]
      
      for (let j = i + 1; j < pathKeys.length; j++) {
        const id2 = pathKeys[j]
        const dev2 = deviceMap[id2]
        const latlngs2 = devicePaths[id2]
        
        // Hanya sejajarkan jika berasal dari induk (parent) yang sama
        if (dev1.parentId === dev2.parentId) {
          // Bandingkan vertex (abaikan titik terakhir karena itu rumah pelanggan)
          for (let idx1 = 0; idx1 < latlngs1.length - 1; idx1++) {
            for (let idx2 = 0; idx2 < latlngs2.length - 1; idx2++) {
              if (isSameCoord(latlngs1[idx1], latlngs2[idx2])) {
                latlngs2[idx2] = [...latlngs1[idx1]]
              }
            }
          }
        }
      }
    }

    devices.forEach(device => {
      if (hasCoords(device)) {
        // Cek apakah ada hubungan kabel ( uplink parent maupun downlink children )
        const hasParent = device.parentId !== null && device.parentId !== undefined && device.parentId !== '';
        const hasChildren = devices.some(d => d.parentId === device.id);
        const hasCable = hasParent || hasChildren;
        const isDraggable = !hasCable;

        const zIndexOffset = device.type === 'OLT' ? 1000 : device.type === 'ODC' ? 2000 : device.type === 'ODP' ? 3000 : 4000;
        const marker = L.marker([device.lat, device.lng], { 
          icon: getIconForType(device.type, device),
          draggable: isDraggable,
          riseOnHover: true,
          zIndexOffset: zIndexOffset
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
            const latlngs = devicePaths[device.id]
            if (latlngs) {

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

            polylineMap.value[device.id] = polyline

            clickPolyline.on('click', (e) => {
              if (store.mapMode !== 'VIEW') return
              
              // Hentikan propagasi agar tidak memicu event klik map dasar
              L.DomEvent.stopPropagation(e)
              if (e.originalEvent) {
                L.DomEvent.stopPropagation(e.originalEvent)
              }

              clearEditHandles()
              activeEditDevice.value = device
              editPolyline = polyline

              // Cari seluruh kabel lain yang terhubung ke ODP/Induk yang sama
              const siblings = allDevicesData.value.filter(d => 
                d.id !== device.id && 
                d.parentId === device.parentId && 
                hasCoords(d)
              )

              adjacentCables = siblings.map(sib => {
                const sibPoly = polylineMap.value[sib.id]
                let sibCoords = []
                if (sibPoly) {
                  sibCoords = sibPoly.getLatLngs().map(ll => [ll.lat, ll.lng])
                }
                return {
                  device: sib,
                  polyline: sibPoly,
                  coords: sibCoords,
                  originalCoords: JSON.parse(JSON.stringify(sibCoords))
                }
              }).filter(item => item.polyline !== undefined)

              renderEditHandles()
            })

            polyline.addTo(polylineLayer)
            clickPolyline.addTo(polylineLayer)
            }
          }
        }
      }
    })

    fitMapToDevicesOnce(devices)
  } catch (err) {
    updateMapDataStatus([], err.message || 'Gagal memuat perangkat')
    console.error("Gagal menarik data topology:", err)
    if (Object.keys(previousOnlineStatuses).length === 0) {
      alert("Gagal memuat perangkat dari database server: " + err.message)
    }
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
    attributionControl: false,
    maxZoom: 22
  }).setView([-7.250445, 112.768845], 13)

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
  window.addEventListener('wiremap-map-visible', refreshMapAndLoadDevices)
  window.addEventListener('device-saved', handleDeviceSaved)
  
  document.addEventListener('click', handleDocClickForSearch)
  startAutoRefresh()
  // Tunda loadDevices() sedikit agar DOM map benar-benar siap & modal config sudah tertutup
  setTimeout(() => {
    map.invalidateSize()
    loadDevices()
  }, 300)
  setTimeout(() => {
    map.invalidateSize()
    loadDevices()
  }, 900)
})

onUnmounted(() => {
  stopAutoRefresh()
  document.removeEventListener('click', handleDocClickForSearch)
  window.removeEventListener('refresh-map', loadDevices)
  window.removeEventListener('tambah-kabel', handleTambahKabelEvent)
  window.removeEventListener('lihat-detail', handleLihatDetailEvent)
  window.removeEventListener('sync-mikrotik', triggerSync)
  window.removeEventListener('open-provisioning-queue', handleOpenProvisioningQueue)
  window.removeEventListener('wiremap-map-visible', refreshMapAndLoadDevices)
  window.removeEventListener('device-saved', handleDeviceSaved)
})

watch(unmappedClients, (clients) => {
  window.dispatchEvent(new CustomEvent('customer-queue-count', {
    detail: { count: clients.length }
  }))
}, { immediate: true })

watch(allDevicesData, (newData) => {
  if (selectedClient.value) {
    const fresh = newData.find(d => d.id === selectedClient.value.id)
    if (fresh) {
      selectedClient.value = fresh
    }
  }
})
</script>

<template>
  <div class="relative w-full h-full" :class="{ 
    'is-placing-device': store.mapMode === 'ADD_DEVICE' || store.mapMode === 'PLOT_CLIENT'
  }">
    <div ref="mapContainer" class="absolute inset-0 z-0"></div>

    <!-- Floating Navigation Row (No Background Header Container!) -->
    <div class="absolute top-4 left-4 right-4 z-[99] pointer-events-none flex flex-wrap gap-2 items-center justify-between">
      
      <!-- Left controls (Logo, Search, List Perangkat, Queue) -->
      <div class="flex items-center gap-2 pointer-events-auto">
        <!-- Logo Badge -->
        <div class="flex items-center gap-1.5 bg-white/95 border border-slate-200/80 px-3 py-1.5 rounded-lg shadow-md backdrop-blur-sm select-none">
          <span class="material-symbols-outlined text-primary text-[18px] font-bold">account_tree</span>
          <span class="text-xs font-black text-primary tracking-wide">WireMap GIS</span>
        </div>

        <!-- Search Box (Single horizontal row!) -->
        <div class="relative search-container-box flex items-center bg-white/95 border border-slate-200/80 rounded-lg shadow-md p-1 px-1.5 w-[270px] max-w-[270px] backdrop-blur-sm pointer-events-auto gap-1.5 h-9">
          <!-- Left side: Inputs -->
          <div class="flex-1 min-w-0">
            <!-- Location Lat/Long Inputs -->
            <div class="flex items-center gap-1 w-full">
              <input 
                v-model="searchLat" 
                placeholder="Lat" 
                class="bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-[10px] w-20 outline-none font-mono text-slate-800 text-center" 
              />
              <input 
                v-model="searchLng" 
                placeholder="Long" 
                class="bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-[10px] w-20 outline-none font-mono text-slate-800 text-center" 
              />
            </div>
          </div>

          <!-- Right: Search Symbol + Cari button -->
          <button 
            type="button" 
            @click.stop="zoomToSearchCoords" 
            class="bg-primary text-white border-0 rounded px-2.5 py-1 text-[10px] font-bold cursor-pointer hover:bg-primary-hover flex items-center gap-1 shrink-0 h-7"
          >
            <span class="material-symbols-outlined text-[13px] font-bold">search</span>
            Cari
          </button>
        </div>

        <!-- Main Menus (List Perangkat & Fiber Queue) -->
        <div class="flex bg-white/95 border border-slate-200/80 p-0.5 rounded-lg shadow-md backdrop-blur-sm">
          <button 
            type="button"
            @click="isDeviceListOpen = true" 
            class="px-2.5 py-1.5 rounded-md text-[10px] font-bold uppercase transition-all border-0 bg-transparent text-slate-700 hover:bg-slate-100 flex items-center gap-1 cursor-pointer"
          >
            <span class="material-symbols-outlined text-[14px]">format_list_bulleted</span>
            List Perangkat
          </button>
          <button 
            type="button"
            @click="isClientInventoryOpen = true" 
            class="px-2.5 py-1.5 rounded-md text-[10px] font-bold uppercase transition-all border-0 bg-transparent text-slate-700 hover:bg-slate-100 flex items-center gap-1 cursor-pointer"
          >
            <span class="material-symbols-outlined text-[14px]">manage_accounts</span>
            Daftar Client
          </button>
          <button 
            type="button"
            @click="isWorkflowOpen = true" 
            class="px-2.5 py-1.5 rounded-md text-[10px] font-bold uppercase transition-all border-0 bg-transparent text-slate-700 hover:bg-slate-100 flex items-center gap-1.5 relative cursor-pointer"
          >
            <span class="material-symbols-outlined text-[14px]">dynamic_feed</span>
            Queue
            <span v-if="unmappedClients.length" class="min-w-[15px] h-[15px] rounded-full bg-primary text-white text-[9px] font-black flex items-center justify-center px-0.5">
              {{ unmappedClients.length }}
            </span>
          </button>
        </div>
      </div>

      <!-- Right controls (Log Gangguan, Map Layers, Router Settings, Sync, Logout) -->
      <div class="flex items-center gap-2 pointer-events-auto">
        <!-- Log Gangguan -->
        <div class="flex bg-white/95 border border-slate-200/80 p-0.5 rounded-lg shadow-md backdrop-blur-sm">
          <button 
            type="button"
            @click="isOutageLogsOpen = !isOutageLogsOpen" 
            class="px-2.5 py-1.5 rounded-md text-[10px] font-bold uppercase transition-all border-0 cursor-pointer flex items-center gap-1 text-red-600 bg-transparent hover:bg-red-50"
            :class="{ 'bg-red-600 text-white hover:bg-red-700': isOutageLogsOpen }"
          >
            <span class="material-symbols-outlined text-[14px]">warning</span>
            Log Gangguan
          </button>
        </div>

        <!-- Map Layer Switcher (Light, Dark, Satellite) -->
        <div class="flex bg-white/95 border border-slate-200/80 p-0.5 rounded-lg shadow-md backdrop-blur-sm">
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

        <!-- System controls (Settings, Sync, Logout) -->
        <div class="flex items-center bg-white/95 border border-slate-200/80 p-0.5 rounded-lg shadow-md backdrop-blur-sm gap-1">
          <button 
            type="button"
            @click="openRouterSettings" 
            class="p-1.5 rounded-md hover:bg-slate-100 text-primary border-0 bg-transparent cursor-pointer flex items-center" 
            title="Koneksi Router API"
          >
            <span class="material-symbols-outlined text-[16px]">settings_ethernet</span>
          </button>
          <button 
            type="button"
            @click="triggerSync" 
            class="p-1.5 rounded-md hover:bg-slate-100 text-slate-700 border-0 bg-transparent cursor-pointer flex items-center" 
            title="Sync Mikrotik"
          >
            <span class="material-symbols-outlined text-[16px]">sync</span>
          </button>
          <button 
            type="button"
            @click="logoutRequest" 
            class="p-1.5 rounded-md hover:bg-red-50 text-red-600 border-0 bg-transparent cursor-pointer flex items-center" 
            title="Logout"
          >
            <span class="material-symbols-outlined text-[16px]">logout</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Vertical Zoom controls (floated right below the logout block) -->
    <div class="absolute top-20 right-5 z-[99] pointer-events-auto flex flex-col bg-white/95 border border-slate-200/80 p-0.5 rounded-lg shadow-md backdrop-blur-sm gap-0.5 items-center">
      <button 
        type="button"
        @click="zoomIn"
        class="p-1.5 rounded-md hover:bg-slate-100 text-slate-700 border-0 bg-transparent cursor-pointer flex items-center"
        title="Zoom In"
      >
        <span class="material-symbols-outlined text-[15px] font-bold">add</span>
      </button>
      <div class="h-[1px] w-3 bg-slate-200 select-none"></div>
      <button 
        type="button"
        @click="zoomOut"
        class="p-1.5 rounded-md hover:bg-slate-100 text-slate-700 border-0 bg-transparent cursor-pointer flex items-center"
        title="Zoom Out"
      >
        <span class="material-symbols-outlined text-[15px] font-bold">remove</span>
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

    <div
      v-if="mapDataStatus.error || mapDataStatus.total === 0 || mapDataStatus.plotted === 0"
      class="map-data-status"
      :class="{ 'is-error': mapDataStatus.error }"
    >
      <span class="material-symbols-outlined">{{ mapDataStatus.error ? 'error' : 'info' }}</span>
      <div>
        <strong v-if="mapDataStatus.error">{{ mapDataStatus.error }}</strong>
        <strong v-else-if="mapDataStatus.total === 0">Data peta kosong</strong>
        <strong v-else>Belum ada perangkat berkoordinat</strong>
        <small>
          Total: {{ mapDataStatus.total }} | Koordinat: {{ mapDataStatus.plotted }}
          <template v-if="mapDataStatus.lastLoadAt"> | {{ mapDataStatus.lastLoadAt }}</template>
        </small>
      </div>
      <button type="button" @click="refreshMapAndLoadDevices">
        <span class="material-symbols-outlined">refresh</span>
      </button>
    </div>

    <div v-if="store.mapMode === 'PLOT_CLIENT'" class="absolute top-20 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-blue-200 bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg">
      Klik lokasi rumah {{ store.plottingClient?.name || 'pelanggan' }} di peta
    </div>

    <div v-if="store.mapMode === 'ADD_DEVICE'" class="placement-hint !top-20">
      <span class="material-symbols-outlined">add_location_alt</span>
      <span>Klik titik perangkat di peta</span>
      <button @click="store.cancelAdd()">Batal</button>
    </div>

    <!-- Banner Info Edit Rute Kabel -->
    <div v-if="activeEditDevice" class="absolute top-20 left-1/2 z-20 -translate-x-1/2 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-4 text-white flex items-center gap-4 max-w-[calc(100%-2rem)] w-full md:w-auto">
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

    <!-- Outage Logs Panel (Sliding Drawer on Right) -->
    <div v-if="isOutageLogsOpen" class="workflow-modal-backdrop" @click.self="isOutageLogsOpen = false">
      <aside class="workflow-panel">
        <header class="workflow-toggle">
          <div class="workflow-title">
            <span class="material-symbols-outlined text-red-600">warning</span>
            <div>
              <strong>Log Gangguan</strong>
              <small>Riwayat Gangguan & Trouble Perangkat</small>
            </div>
          </div>
          <button type="button" class="workflow-close" @click="isOutageLogsOpen = false" aria-label="Tutup Log">
            <span class="material-symbols-outlined">close</span>
          </button>
        </header>

        <div class="workflow-body flex flex-col h-[calc(100%-60px)]">
          <div class="flex justify-between items-center px-4 py-2 border-b border-slate-300/20">
            <span class="text-xs text-slate-500 font-bold">Total Log: {{ outageLogs.length }}</span>
            <button @click="clearOutageLogs" class="text-xs text-red-500 hover:text-red-700 bg-transparent border-0 cursor-pointer font-bold flex items-center gap-1">
              <span class="material-symbols-outlined text-[14px]">delete</span>
              Hapus Semua
            </button>
          </div>

          <!-- Logs List -->
          <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5">
            <div v-if="outageLogs.length === 0" class="flex flex-col items-center justify-center py-12 text-slate-500 gap-2">
              <span class="material-symbols-outlined text-3xl">check_circle</span>
              <span class="text-xs">Tidak ada riwayat gangguan. Jaringan aman!</span>
            </div>
            
            <div 
              v-for="(log, idx) in outageLogs" 
              :key="idx" 
              class="p-3 rounded-lg border text-[11px] leading-relaxed flex flex-col gap-1.5"
              :class="log.status === 'Down' ? 'bg-red-500/5 border-red-500/20' : 'bg-green-500/5 border-green-500/20'"
            >
              <div class="flex justify-between items-center font-bold">
                <span class="text-slate-800 text-[12px]">{{ log.deviceName }}</span>
                <span 
                  class="px-2 py-0.5 rounded-full text-[9px] uppercase font-bold tracking-wider"
                  :class="log.status === 'Down' ? 'bg-red-500 text-white animate-pulse' : 'bg-green-500 text-white'"
                >
                  {{ log.status }}
                </span>
              </div>
              <div class="text-slate-500 font-medium flex justify-between">
                <span>{{ log.message }}</span>
                <span class="text-slate-400 text-[10px] font-mono">{{ log.time }}</span>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>

    <!-- List Perangkat Panel (Sliding Drawer on Right) -->
    <div v-if="isDeviceListOpen" class="workflow-modal-backdrop" @click.self="isDeviceListOpen = false">
      <aside class="workflow-panel w-[280px] max-w-[280px]">
        <header class="workflow-toggle">
          <div class="workflow-title">
            <span class="material-symbols-outlined text-primary">format_list_bulleted</span>
            <div>
              <strong>Daftar Perangkat</strong>
              <small>Total: {{ allDevicesData.length }} Perangkat</small>
            </div>
          </div>
          <button type="button" class="workflow-close" @click="isDeviceListOpen = false" aria-label="Tutup List">
            <span class="material-symbols-outlined">close</span>
          </button>
        </header>

        <div class="workflow-body flex flex-col h-[calc(100%-60px)] bg-slate-900/95 text-white">
          <div class="p-3 flex flex-col gap-2 border-b border-white/10">
            <label class="workflow-search">
              <span class="material-symbols-outlined">search</span>
              <input v-model="deviceListSearchQuery" placeholder="Cari Nama / IP / Tipe..." class="w-full text-xs" />
            </label>
            <!-- Pill Filter Tipe Perangkat -->
            <div class="flex flex-wrap gap-1">
              <button 
                v-for="type in ['ALL', 'OLT', 'ODC', 'ODP', 'CLIENT']" 
                :key="type"
                type="button"
                @click="deviceListTypeFilter = type"
                class="px-2 py-0.5 rounded text-[8px] font-black uppercase transition-all cursor-pointer border-0"
                :class="deviceListTypeFilter === type ? 'bg-primary text-white' : 'bg-white/10 text-slate-300 hover:bg-white/20'"
              >
                {{ type }}
              </button>
            </div>
          </div>

          <!-- Device List items (compact & borderless list items) -->
          <div class="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5">
            <div v-if="filteredListDevices.length === 0" class="text-xs text-slate-400 text-center py-8">Tidak ada perangkat ditemukan.</div>
            <button 
              v-for="d in filteredListDevices" 
              :key="d.id"
              type="button"
              @click="zoomToDevice(d); isDeviceListOpen = false"
              class="w-full text-left py-2.5 px-2 hover:bg-white/5 cursor-pointer flex flex-col gap-1 border-b border-white/5 last:border-b-0 bg-transparent transition-colors border-t-0 border-x-0 outline-none rounded"
            >
              <!-- Baris 1: Status & Nama & Tipe -->
              <div class="flex items-center justify-between w-full">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span 
                    v-if="d.type === 'CLIENT'"
                    class="w-2 h-2 rounded-full flex-shrink-0"
                    :class="d.isOnline ? 'bg-green-500 shadow-[0_0_6px_#22c55e]' : 'bg-red-500'"
                  ></span>
                  <span class="font-bold text-slate-100 text-[11px] truncate block">{{ d.name }}</span>
                </div>
                <span 
                  class="px-1.5 py-0.5 rounded text-[8px] font-black uppercase flex-shrink-0"
                  :class="d.type === 'OLT' ? 'bg-blue-900/50 text-blue-300 border border-blue-800/30' : d.type === 'ODC' ? 'bg-slate-800 text-slate-300 border border-slate-700/50' : d.type === 'ODP' ? 'bg-yellow-900/50 text-yellow-300 border border-yellow-800/30' : 'bg-green-900/50 text-green-300 border border-green-800/30'"
                >
                  {{ d.type }}
                </span>
              </div>
              
              <!-- Baris 2: Sub-info PPPoE / IP / SN / Model (Berdasarkan Tipe) -->
              <div class="flex flex-wrap items-center gap-x-2 text-[9px] text-slate-400 font-mono">
                <!-- PPPoE -->
                <span v-if="d.pppoeUsername" class="text-sky-400 font-bold">
                  {{ d.pppoeUsername }}
                </span>
                <span v-if="d.pppoeUsername && (d.lanIp || d.wanIp)" class="text-slate-600">|</span>
                <!-- IP -->
                <span v-if="d.lanIp || d.wanIp">
                  {{ d.lanIp || d.wanIp }}
                </span>
                <span v-if="(d.lanIp || d.wanIp) && d.snModem" class="text-slate-600">|</span>
                <!-- Model / SN -->
                <span v-if="d.snModem || d.modelName" class="truncate max-w-[120px]" :title="d.snModem">
                  {{ d.modelName || 'Modem' }} ({{ d.snModem ? d.snModem.slice(-6) : 'N/A' }})
                </span>
              </div>
              
              <!-- Baris 3: Status Redaman (Khusus CLIENT) -->
              <div v-if="d.type === 'CLIENT'" class="flex items-center justify-between w-full mt-0.5">
                <div class="flex items-center gap-1.5 text-[9px]">
                  <span class="text-slate-500 font-bold">Redaman RX:</span>
                  <strong 
                    :class="parseFloat(d.rxPower) > -27 ? 'text-green-400' : 'text-red-400 font-bold'"
                    class="font-mono text-[10px]"
                  >
                    {{ d.rxPower ? `${d.rxPower} dBm` : 'N/A' }}
                  </strong>
                </div>
                <div v-if="d.associatedDevices !== undefined && d.associatedDevices !== null" class="text-[8px] text-slate-500 font-black bg-white/5 px-1 py-0.5 rounded">
                  📱 {{ d.associatedDevices }} Dev
                </div>
              </div>
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
    <div class="absolute left-4 bottom-4 z-10 w-fit max-w-[150px] pointer-events-auto select-none">
      <div class="flex flex-col gap-1 text-[9px] font-bold text-slate-800 bg-white/95 border border-slate-200/80 p-2 rounded-lg shadow-md backdrop-blur-sm">
        <!-- Header Legend -->
        <div 
          @click.stop="isLegendOpen = !isLegendOpen" 
          class="flex items-center justify-between text-[9px] font-black uppercase tracking-wider text-slate-700 cursor-pointer gap-2"
        >
          <span>Legend</span>
          <span class="material-symbols-outlined text-[13px] transition-transform duration-200" :class="{ 'rotate-180': !isLegendOpen }">
            keyboard_arrow_down
          </span>
        </div>
        
        <!-- Legend Items Container -->
        <div v-show="isLegendOpen" class="flex flex-col gap-1.5 mt-1 border-t border-slate-200/60 pt-1.5">
          <!-- OLT -->
          <div class="flex items-center gap-2">
            <div class="w-3 h-3 bg-[#0050cb] rounded border border-white shadow-sm flex items-center justify-center font-black text-[6px] text-white">OLT</div>
            <span>OLT (Pusat)</span>
          </div>
          <!-- ODC -->
          <div class="flex items-center gap-2">
            <div class="w-3 h-2 bg-[#64748b] rounded border border-white shadow-sm"></div>
            <span>ODC</span>
          </div>
          <!-- ODP -->
          <div class="flex items-center gap-2">
            <div class="w-3 h-2 bg-[#d97706] rounded border border-white shadow-sm"></div>
            <span>ODP</span>
          </div>
          <!-- ODP Mass LOS -->
          <div class="flex items-center gap-2">
            <div class="w-3 h-2 bg-[#dc2626] rounded border border-white shadow-sm animate-pulse"></div>
            <span class="text-red-600 font-bold">ODP LOS</span>
          </div>
          <!-- Client Online -->
          <div class="flex items-center gap-2">
            <div class="w-2.5 h-2.5 bg-[#16a34a] rounded-full border border-white shadow-sm"></div>
            <span>Online</span>
          </div>
          <!-- Client Lemah -->
          <div class="flex items-center gap-2">
            <div class="w-2.5 h-2.5 bg-[#f59e0b] rounded-full border border-white shadow-sm"></div>
            <span>&gt;-27dB</span>
          </div>
          <!-- Client Offline -->
          <div class="flex items-center gap-2">
            <div class="w-2.5 h-2.5 bg-[#dc2626] rounded-full border border-white shadow-sm animate-pulse"></div>
            <span class="text-red-600 font-bold">LOS</span>
          </div>
          <!-- Client Mati Listrik -->
          <div class="flex items-center gap-2">
            <div class="w-2.5 h-2.5 bg-[#dc2626] rounded-full border border-white shadow-sm flex items-center justify-center text-[7px]">🔌</div>
            <span>Mati Listrik</span>
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
      @start-polling="startProgressPolling"
    />
    <ClientInventoryModal
      :is-open="isClientInventoryOpen"
      @close="isClientInventoryOpen = false"
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
  width: 40px;
  height: 40px;
  border: 1px solid rgba(255, 255, 255, 0.75);
  border-radius: 999px;
  background: #0050cb;
  color: #fff;
  box-shadow: 0 8px 20px rgba(0, 80, 203, 0.3);
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease;
}

.floating-add-node:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 24px rgba(0, 80, 203, 0.38);
}

.floating-add-node .material-symbols-outlined {
  font-size: 22px;
}

.map-data-status {
  position: absolute;
  right: 76px;
  bottom: 24px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(360px, calc(100vw - 112px));
  border: 1px solid rgba(14, 165, 233, 0.28);
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.86);
  color: #e0f2fe;
  padding: 10px 12px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.32);
  backdrop-filter: blur(10px);
}

.map-data-status.is-error {
  border-color: rgba(248, 113, 113, 0.4);
  color: #fecaca;
}

.map-data-status > .material-symbols-outlined {
  flex: 0 0 auto;
  font-size: 20px;
}

.map-data-status div {
  min-width: 0;
}

.map-data-status strong,
.map-data-status small {
  display: block;
}

.map-data-status strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 900;
}

.map-data-status small {
  margin-top: 2px;
  color: #93c5fd;
  font-size: 9px;
  font-weight: 800;
}

.map-data-status button {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid rgba(125, 211, 252, 0.28);
  border-radius: 8px;
  background: rgba(14, 165, 233, 0.16);
  color: #bae6fd;
  cursor: pointer;
}

.map-data-status button .material-symbols-outlined {
  font-size: 16px;
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
