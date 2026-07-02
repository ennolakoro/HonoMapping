<script setup>
import { ref, onMounted } from 'vue'
import LeafletMap from './components/Map.vue'
import AddDeviceModal from './components/AddDeviceModal.vue'
import LoginScreen from './components/LoginScreen.vue'
import RouterConfigModal from './components/RouterConfigModal.vue'
import { api } from './api'
import { store } from './store'

const isLoggedIn = ref(false)
const isRouterModalOpen = ref(false)

onMounted(() => {
  // Cek token saat muat ulang
  if (localStorage.getItem('wiremap_token')) {
    isLoggedIn.value = true
  }
})

const handleLogout = () => {
  api.logout()
  isLoggedIn.value = false
}

const handleSaveDevice = async (deviceData) => {
  try {
    const res = await api.addDevice(deviceData)
    console.log("Device Saved: ", res)
    window.dispatchEvent(new CustomEvent('refresh-map'))
  } catch (err) {
    alert('Gagal menyimpan perangkat: ' + err.message)
  }
}
</script>

<template>
  <LoginScreen v-if="!isLoggedIn" @login-success="isLoggedIn = true" />

  <template v-else>
    <!-- TopNavBar -->
    <header class="bg-surface-container-lowest border-b border-outline-variant flex justify-between items-center px-4 w-full h-16 z-30 flex-shrink-0 relative">
      <div class="flex items-center gap-6">
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined text-primary text-2xl">device_hub</span>
          <h1 class="text-xl font-bold text-primary tracking-tight">WireMap GIS</h1>
        </div>
      </div>
      
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-2 border-r border-outline-variant pr-4">
          <button @click="isRouterModalOpen = true" class="flex items-center gap-1.5 bg-surface-container hover:bg-surface-container-high border border-outline-variant text-on-surface px-3 py-1.5 rounded-lg text-xs font-semibold shadow-sm transition-colors cursor-pointer">
            <span class="material-symbols-outlined text-[16px] text-primary font-semibold">settings_ethernet</span>
            Router API
          </button>
        </div>
        <div @click="handleLogout" class="w-8 h-8 rounded-full bg-surface-container border border-outline-variant overflow-hidden flex-shrink-0 cursor-pointer hover:border-error transition-colors" title="Logout">
          <img src="https://ui-avatars.com/api/?name=Admin&background=0D8ABC&color=fff" alt="User Profile" class="w-full h-full object-cover" />
        </div>
      </div>
    </header>

    <!-- Main Content Area -->
    <main class="flex-1 min-w-0 relative h-full flex flex-col">
      <!-- Status Banner -->
      <div v-if="store.mapMode === 'ADD_DEVICE'" class="bg-primary text-white text-center py-2 font-medium z-20 shadow-md">
        📍 Mode Tambah Perangkat: Silakan klik lokasi di peta.
        <button @click="store.cancelAdd()" class="ml-4 underline text-sm hover:text-white/80">Batal</button>
      </div>
      <div v-if="store.mapMode === 'ADD_CABLE'" class="bg-orange-600 text-white text-center py-2 font-medium z-20 shadow-md">
        🔗 Mode Tambah Kabel: Silakan klik lokasi ujung kabel di peta (Induk: {{ store.selectedParentId }}).
        <button @click="store.cancelAdd()" class="ml-4 underline text-sm hover:text-white/80">Batal</button>
      </div>

      <LeafletMap class="flex-1" />

      <!-- Big Add Button (Bottom Right) - Bulat Keren -->
      <button 
        v-if="store.mapMode === 'VIEW'"
        @click="store.startAddDevice()"
        class="absolute bottom-6 right-6 z-20 w-14 h-14 rounded-full bg-primary hover:bg-primary-fixed text-white flex items-center justify-center shadow-lg transition-all hover:scale-110 active:scale-95 cursor-pointer"
        title="Tambah Perangkat Baru"
      >
        <span class="material-symbols-outlined text-[28px] font-bold">add_location_alt</span>
      </button>
    </main>

    <!-- Modals -->
    <AddDeviceModal 
      @save="handleSaveDevice"
    />

    <RouterConfigModal 
      :is-open="isRouterModalOpen"
      @close="isRouterModalOpen = false"
    />
  </template>
</template>
