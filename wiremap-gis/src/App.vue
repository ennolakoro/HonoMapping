<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import LeafletMap from './components/Map.vue'
import AddDeviceModal from './components/AddDeviceModal.vue'
import LoginScreen from './components/LoginScreen.vue'
import RouterConfigModal from './components/RouterConfigModal.vue'
import { api } from './api'
import { store } from './store'

const isLoggedIn = ref(false)
const isRouterModalOpen = ref(false)
const isRouterConfigured = ref(true)
const queueCount = ref(0)

const handleQueueCount = (event) => {
  queueCount.value = event.detail?.count || 0
}

onMounted(() => {
  window.addEventListener('customer-queue-count', handleQueueCount)
  if (localStorage.getItem('wiremap_token')) {
    isLoggedIn.value = true
    checkConnectionSettings()
  }
})

onUnmounted(() => {
  window.removeEventListener('customer-queue-count', handleQueueCount)
})

const checkConnectionSettings = async (isSaveEvent = false) => {
  try {
    const settings = await api.getSettings()
    if (!settings.MIKROTIK_IP || !settings.MIKROTIK_USER || !settings.MIKROTIK_PASS) {
      isRouterModalOpen.value = true
      isRouterConfigured.value = false
    } else {
      isRouterConfigured.value = true
      if (isSaveEvent !== true) {
        isRouterModalOpen.value = false
      }
    }
  } catch (err) {
    if (err.message === 'Sesi berakhir' || err.message?.includes('Unauthorized')) {
      handleLogout()
    } else {
      isRouterModalOpen.value = true
      isRouterConfigured.value = false
    }
  }
}

const handleLoginSuccess = () => {
  isLoggedIn.value = true
  checkConnectionSettings()
}

const handleLogout = () => {
  api.logout()
  isLoggedIn.value = false
}

const handleSyncRequest = () => {
  window.dispatchEvent(new CustomEvent('sync-mikrotik'))
}

const openProvisioningQueue = () => {
  window.dispatchEvent(new CustomEvent('open-provisioning-queue'))
}

const handleSaveDevice = async (deviceData) => {
  try {
    const payload = {
      ...deviceData,
      cablePath: store.pendingCablePath ? JSON.stringify(store.pendingCablePath) : null
    }
    const res = await api.addDevice(payload)
    console.log('Device Saved: ', res)
    window.dispatchEvent(new CustomEvent('refresh-map'))
    if (deviceData.syncAfterSave) {
      window.dispatchEvent(new CustomEvent('sync-mikrotik'))
    }
  } catch (err) {
    alert('Gagal menyimpan perangkat: ' + err.message)
  }
}
</script>

<template>
  <LoginScreen v-if="!isLoggedIn" @login-success="handleLoginSuccess" />

  <template v-else>
    <header class="bg-surface-container-lowest border-b border-outline-variant shadow-sm flex justify-between items-center px-4 md:px-6 w-full h-header-height z-30 flex-shrink-0 relative">
      <div class="flex items-center gap-6 min-w-0">
        <div class="flex items-center gap-2 min-w-0">
          <span class="material-symbols-outlined text-primary text-2xl">account_tree</span>
          <h1 class="text-xl md:text-2xl font-bold text-primary whitespace-nowrap">WireMap GIS</h1>
        </div>
        <nav class="hidden md:flex items-center gap-1 h-full">
          <span class="text-primary border-b-2 border-primary px-3 py-2 text-xs font-semibold">Topology</span>
          <button @click="openProvisioningQueue" class="relative text-on-surface-variant hover:bg-surface-container-high px-3 py-2 rounded text-xs font-semibold transition-colors border-0 bg-transparent cursor-pointer">
            Fiber Queue
            <span v-if="queueCount" class="absolute -right-1 -top-1 min-w-[18px] h-[18px] rounded-full bg-primary text-on-primary text-[10px] font-black flex items-center justify-center px-1">
              {{ queueCount }}
            </span>
          </button>
          <span class="text-on-surface-variant hover:bg-surface-container-high px-3 py-2 rounded text-xs font-semibold transition-colors">Analytics</span>
        </nav>
      </div>

      <div class="flex items-center gap-2">
        <button @click="openProvisioningQueue" class="md:hidden relative w-9 h-9 rounded border border-outline-variant bg-surface-container-lowest hover:bg-surface-container-high text-on-surface-variant flex items-center justify-center transition-colors cursor-pointer" title="Fiber Queue">
          <span class="material-symbols-outlined text-[20px]">dynamic_feed</span>
          <span v-if="queueCount" class="absolute -right-1 -top-1 min-w-[17px] h-[17px] rounded-full bg-primary text-on-primary text-[9px] font-black flex items-center justify-center px-1">
            {{ queueCount }}
          </span>
        </button>
        <button @click="isRouterModalOpen = true" class="hidden sm:flex items-center gap-2 bg-surface-container-lowest hover:bg-surface-container-high border border-outline-variant text-on-surface px-3 py-2 rounded text-xs font-semibold shadow-sm transition-colors cursor-pointer">
          <span class="material-symbols-outlined text-[18px] text-primary">settings_ethernet</span>
          <span class="hidden lg:inline">Connection Settings</span>
          <span class="lg:hidden">Router</span>
        </button>
        <button @click="handleSyncRequest" class="w-9 h-9 rounded border border-outline-variant bg-surface-container-lowest hover:bg-surface-container-high text-on-surface-variant flex items-center justify-center transition-colors cursor-pointer" title="Auto-Sync Real Mikrotik">
          <span class="material-symbols-outlined text-[20px]">sync</span>
        </button>
        <button @click="handleLogout" class="w-9 h-9 rounded border border-outline-variant bg-surface-container-lowest hover:border-error hover:text-error text-on-surface-variant flex items-center justify-center transition-colors cursor-pointer" title="Logout">
          <span class="material-symbols-outlined text-[20px]">logout</span>
        </button>
      </div>
    </header>

    <main class="flex-1 min-w-0 relative h-full flex flex-col bg-background">
      <div v-if="store.mapMode === 'ADD_CABLE'" class="absolute top-4 left-1/2 -translate-x-1/2 bg-[#d97706] text-white px-4 py-2 rounded shadow-lg text-sm font-semibold z-20 flex items-center gap-3 border border-[#f59e0b] max-w-[calc(100%-2rem)]">
        <span class="material-symbols-outlined text-[18px]">cable</span>
        <span class="whitespace-nowrap">Mode Tambah Kabel: klik lokasi ujung kabel.</span>
        <button @click="store.cancelAdd()" class="underline text-xs hover:text-white/80">Batal</button>
      </div>

      <LeafletMap v-if="isRouterConfigured" class="flex-1" />
      <div v-else class="flex-1 flex flex-col items-center justify-center bg-slate-900 text-white gap-4 p-6">
        <span class="material-symbols-outlined text-6xl text-blue-500 animate-pulse">settings_ethernet</span>
        <h2 class="text-xl font-bold">Konfigurasi Router API Diperlukan</h2>
        <p class="text-slate-400 text-center max-w-md text-sm leading-relaxed">Anda harus mengisi kredensial API Mikrotik terlebih dahulu sebelum dapat mengakses peta GIS dan memproses data topologi pelanggan.</p>
        <button @click="isRouterModalOpen = true" class="bg-blue-600 hover:bg-blue-500 text-white px-5 py-2.5 rounded-lg font-bold shadow-md transition-all cursor-pointer">
          Buka Konfigurasi Router
        </button>
      </div>
    </main>

    <AddDeviceModal @save="handleSaveDevice" />

    <RouterConfigModal
      :is-open="isRouterModalOpen"
      @close="isRouterModalOpen = false"
      @saved="checkConnectionSettings(true)"
    />
  </template>
</template>
