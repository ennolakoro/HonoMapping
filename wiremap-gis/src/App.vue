<script setup>
import { ref, onMounted } from 'vue'
import LeafletMap from './components/Map.vue'
import AddDeviceModal from './components/AddDeviceModal.vue'
import LoginScreen from './components/LoginScreen.vue'
import { api } from './api'
import { store } from './store'

const isLoggedIn = ref(false)

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
           <!-- Tools placeholder -->
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

      <!-- Big Add Button (Bottom Right) -->
      <button 
        v-if="store.mapMode === 'VIEW'"
        @click="store.startAddDevice()"
        class="absolute bottom-6 right-6 z-20 flex items-center gap-2 bg-primary hover:bg-primary-fixed text-white px-6 py-4 rounded-full shadow-lg transition-transform hover:scale-105"
      >
        <span class="material-symbols-outlined text-2xl">add_location_alt</span>
        <span class="font-semibold text-lg">Tambah Perangkat</span>
      </button>
    </main>

    <!-- Modals -->
    <AddDeviceModal 
      @save="handleSaveDevice"
    />
  </template>
</template>
