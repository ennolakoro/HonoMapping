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
const isRouterConfigured = ref(false)
const isValidatingSettings = ref(false)
const queueCount = ref(0)
const routerValidationError = ref('')

const handleQueueCount = (event) => {
  queueCount.value = event.detail?.count || 0
}

onMounted(() => {
  window.addEventListener('customer-queue-count', handleQueueCount)
  window.addEventListener('open-router-settings', handleOpenRouterSettings)
  window.addEventListener('logout-request', handleLogout)
  if (localStorage.getItem('wiremap_token')) {
    isLoggedIn.value = true
    checkConnectionSettings()
  }
})

onUnmounted(() => {
  window.removeEventListener('customer-queue-count', handleQueueCount)
  window.removeEventListener('open-router-settings', handleOpenRouterSettings)
  window.removeEventListener('logout-request', handleLogout)
})

const handleOpenRouterSettings = () => {
  isRouterModalOpen.value = true
}

const checkConnectionSettings = async ({ openOnSuccess = false } = {}) => {
  try {
    isValidatingSettings.value = true
    routerValidationError.value = ''
    const settings = await api.getSettings()
    if (!settings.MIKROTIK_IP || !settings.MIKROTIK_USER || !settings.MIKROTIK_PASS) {
      isRouterModalOpen.value = true
      isRouterConfigured.value = false
    } else {
      await api.testSettings(settings)
      isRouterConfigured.value = openOnSuccess
      isRouterModalOpen.value = false
    }
  } catch (err) {
    if (err.message === 'Sesi berakhir' || err.message?.includes('Unauthorized')) {
      handleLogout()
    } else {
      routerValidationError.value = err.message || 'Koneksi Router API gagal.'
      isRouterModalOpen.value = true
      isRouterConfigured.value = false
    }
  } finally {
    isValidatingSettings.value = false
  }
}

const handleLoginSuccess = () => {
  isLoggedIn.value = true
  checkConnectionSettings()
}

const handleSettingsSaved = () => {
  checkConnectionSettings({ openOnSuccess: true })
}

const handleOpenMap = () => {
  isRouterConfigured.value = true
  routerValidationError.value = ''
}

const handleSettingsDeleted = () => {
  isRouterConfigured.value = false
  routerValidationError.value = ''
  window.dispatchEvent(new CustomEvent('refresh-map'))
}

const handleLogout = () => {
  api.logout()
  isLoggedIn.value = false
  isRouterConfigured.value = false
  isValidatingSettings.value = false
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

    <main class="flex-1 min-w-0 relative h-full flex flex-col bg-background">
      <div v-if="store.mapMode === 'ADD_CABLE'" class="absolute top-4 left-1/2 -translate-x-1/2 bg-[#d97706] text-white px-4 py-2 rounded shadow-lg text-sm font-semibold z-20 flex items-center gap-3 border border-[#f59e0b] max-w-[calc(100%-2rem)]">
        <span class="material-symbols-outlined text-[18px]">cable</span>
        <span class="whitespace-nowrap">Mode Tambah Kabel: klik lokasi ujung kabel.</span>
        <button @click="store.cancelAdd()" class="underline text-xs hover:text-white/80">Batal</button>
      </div>

      <!-- Status Memuat Validasi -->
      <div v-if="isValidatingSettings" class="flex-1 flex flex-col items-center justify-center bg-slate-900 text-white gap-3 p-6">
        <span class="material-symbols-outlined text-5xl text-blue-500 animate-spin">refresh</span>
        <h2 class="text-lg font-bold">Memverifikasi Konfigurasi Jaringan...</h2>
        <p class="text-slate-400 text-xs">Menghubungkan ke database dan memeriksa kredensial router...</p>
      </div>

      <LeafletMap v-else-if="isRouterConfigured" class="flex-1" />
      <div v-else class="flex-1 flex flex-col items-center justify-center bg-slate-900 text-white gap-6 p-6">
        <div class="relative flex items-center justify-center w-20 h-20 bg-blue-500 bg-opacity-10 rounded-full border border-blue-500 border-opacity-20 shadow-inner">
          <span class="material-symbols-outlined text-4xl text-blue-500 animate-pulse">settings_ethernet</span>
        </div>
        <div class="text-center max-w-md">
          <h2 class="text-xl font-bold tracking-tight">WireMap GIS Dashboard</h2>
          <p class="text-slate-400 text-xs mt-2 leading-relaxed">
            Peta topologi dinonaktifkan secara default saat Anda login. Silakan kelola konfigurasi Router API Anda untuk memuat visualisasi rute kabel secara real-time.
          </p>
          <p v-if="routerValidationError" class="text-red-300 text-xs mt-3 leading-relaxed">
            {{ routerValidationError }}
          </p>
        </div>
        <button @click="isRouterModalOpen = true" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-6 py-2.5 rounded-xl shadow-lg transition-all flex items-center gap-2 border-0 cursor-pointer text-xs">
          <span class="material-symbols-outlined text-xs">settings_ethernet</span>
          Kelola Konfigurasi Router
        </button>
      </div>
    </main>

    <AddDeviceModal @save="handleSaveDevice" />

    <RouterConfigModal
      :is-open="isRouterModalOpen"
      @close="isRouterModalOpen = false"
      @saved="handleSettingsSaved"
      @open-map="handleOpenMap"
      @settings-deleted="handleSettingsDeleted"
    />
  </template>
</template>
