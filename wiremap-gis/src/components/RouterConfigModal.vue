<script setup>
import { ref, watch } from 'vue'
import { api } from '../api'

const props = defineProps({
  isOpen: Boolean
})

const emit = defineEmits(['close', 'saved', 'open-map', 'settings-deleted'])

const settings = ref({
  MIKROTIK_IP: '',
  MIKROTIK_USER: '',
  MIKROTIK_PASS: ''
})

const isReadOnly = ref(false)
const isLoading = ref(false)
const isSaving = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const fetchSettings = async () => {
  try {
    isLoading.value = true
    errorMessage.value = ''
    successMessage.value = ''
    const data = await api.getSettings()
    settings.value = {
      MIKROTIK_IP: data.MIKROTIK_IP || '',
      MIKROTIK_USER: data.MIKROTIK_USER || '',
      MIKROTIK_PASS: data.MIKROTIK_PASS || ''
    }
    // Jika data sudah diisi, default ke read-only view
    if (settings.value.MIKROTIK_IP && settings.value.MIKROTIK_USER) {
      isReadOnly.value = true
    } else {
      isReadOnly.value = false
    }
  } catch (err) {
    errorMessage.value = 'Gagal memuat konfigurasi: ' + err.message
  } finally {
    isLoading.value = false
  }
}

watch(() => props.isOpen, (newVal) => {
  if (newVal) {
    fetchSettings()
  }
})

const handleOpenMap = () => {
  emit('open-map')
  emit('close')
}

const handleDeleteSettings = async () => {
  if (!confirm('Apakah Anda yakin ingin menghapus konfigurasi Router API? Peta akan dinonaktifkan.')) return
  try {
    isSaving.value = true
    errorMessage.value = ''
    successMessage.value = ''
    
    // Kirim objek kosong ke backend untuk menghapus
    await api.saveSettings({
      MIKROTIK_IP: '',
      MIKROTIK_USER: '',
      MIKROTIK_PASS: ''
    })
    
    settings.value = {
      MIKROTIK_IP: '',
      MIKROTIK_USER: '',
      MIKROTIK_PASS: ''
    }
    
    successMessage.value = 'Konfigurasi berhasil dihapus.'
    isReadOnly.value = false
    emit('settings-deleted')
    
    setTimeout(() => {
      successMessage.value = ''
      emit('close')
    }, 1500)
  } catch (err) {
    errorMessage.value = 'Gagal menghapus konfigurasi: ' + err.message
  } finally {
    isSaving.value = false
  }
}

const saveSettings = async () => {
  try {
    isSaving.value = true
    errorMessage.value = ''
    successMessage.value = ''
    await api.saveSettings(settings.value)
    successMessage.value = 'Konfigurasi Mikrotik berhasil disimpan!'
    emit('saved')
    setTimeout(() => {
      isReadOnly.value = true
      successMessage.value = ''
    }, 1500)
  } catch (err) {
    errorMessage.value = 'Gagal menyimpan konfigurasi: ' + err.message
  } finally {
    isSaving.value = false
  }
}
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-[110] flex items-center justify-center bg-black bg-opacity-40 backdrop-blur-sm p-4">
    <div class="bg-surface-container-lowest p-6 rounded-lg shadow-xl w-full max-w-md border border-outline-variant">
      <!-- Header -->
      <div class="flex justify-between items-center mb-6">
        <h3 class="text-xl font-bold text-on-surface flex items-center gap-2">
          <span class="material-symbols-outlined text-primary">settings_ethernet</span>
          Konfigurasi Router API
        </h3>
        <button @click="emit('close')" class="text-on-surface-variant hover:text-error transition-colors p-1">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div v-if="isLoading" class="flex flex-col items-center justify-center py-8 text-on-surface-variant gap-2">
        <span class="material-symbols-outlined animate-spin text-3xl">refresh</span>
        <span class="text-sm">Memuat konfigurasi...</span>
      </div>

      <div v-else>
        <!-- Tampilan A: Mode Read-Only (Jika Data Sudah Tersimpan) -->
        <div v-if="isReadOnly" class="flex flex-col gap-5">
          <!-- Banner Deskripsi Sukses -->
          <div class="bg-green-500 bg-opacity-5 p-3 rounded-lg border border-green-500 border-opacity-20 text-xs text-green-600 leading-relaxed flex gap-2.5">
            <span class="material-symbols-outlined text-green-600 text-[18px] flex-shrink-0">check_circle</span>
            <span>Konfigurasi Router API Mikrotik terdeteksi aktif di sistem database.</span>
          </div>

          <!-- Data Summary -->
          <div class="flex flex-col gap-3 bg-surface-container border border-outline-variant p-4 rounded-xl text-sm">
            <div class="flex justify-between items-center border-b border-outline-variant pb-2">
              <span class="text-xs text-on-surface-variant font-semibold">IP Address Router</span>
              <span class="text-xs font-bold text-on-surface font-mono">{{ settings.MIKROTIK_IP }}</span>
            </div>
            <div class="flex justify-between items-center border-b border-outline-variant pb-2">
              <span class="text-xs text-on-surface-variant font-semibold">Username API</span>
              <span class="text-xs font-bold text-on-surface font-mono">{{ settings.MIKROTIK_USER }}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-xs text-on-surface-variant font-semibold">Password API</span>
              <span class="text-xs font-bold text-on-surface">••••••••</span>
            </div>
          </div>

          <!-- Feedback Alerts -->
          <div v-if="errorMessage" class="bg-error bg-opacity-10 text-error p-3 rounded border border-error border-opacity-35 text-xs flex gap-2">
            <span class="material-symbols-outlined text-[16px]">warning</span>
            <span>{{ errorMessage }}</span>
          </div>
          <div v-if="successMessage" class="bg-green-500 bg-opacity-10 text-green-500 p-3 rounded border border-green-500 border-opacity-35 text-xs flex gap-2">
            <span class="material-symbols-outlined text-[16px]">check_circle</span>
            <span>{{ successMessage }}</span>
          </div>

          <!-- Actions: Open, Edit, Hapus -->
          <div class="flex flex-col gap-2.5 mt-2">
            <button @click="handleOpenMap" class="w-full py-2.5 bg-primary hover:bg-primary-fixed text-white font-bold rounded-lg hover:opacity-90 shadow-sm text-sm transition-all flex items-center justify-center gap-2 cursor-pointer border-0">
              <span class="material-symbols-outlined text-sm">map</span>
              Open (Buka Peta)
            </button>
            
            <div class="flex gap-2">
              <button @click="isReadOnly = false" class="flex-1 py-2 border border-outline-variant bg-transparent text-on-surface font-semibold rounded-lg hover:bg-surface-container text-xs transition-colors cursor-pointer flex items-center justify-center gap-1">
                <span class="material-symbols-outlined text-xs">edit</span>
                Edit
              </button>
              <button @click="handleDeleteSettings" :disabled="isSaving" class="flex-1 py-2 border border-red-500 border-opacity-25 bg-transparent text-red-500 hover:bg-red-500 hover:bg-opacity-5 font-semibold rounded-lg text-xs transition-colors cursor-pointer flex items-center justify-center gap-1 disabled:opacity-50">
                <span class="material-symbols-outlined text-xs">delete</span>
                Hapus
              </button>
            </div>
          </div>
        </div>

        <!-- Tampilan B: Form Input (Jika Belum Tersimpan atau Masuk Mode Edit) -->
        <form v-else @submit.prevent="saveSettings" class="flex flex-col gap-4">
          <!-- Banner Deskripsi -->
          <div class="bg-primary bg-opacity-5 p-3 rounded border border-primary border-opacity-20 text-xs text-on-surface-variant leading-relaxed flex gap-2">
            <span class="material-symbols-outlined text-primary text-[18px] flex-shrink-0">info</span>
            <span>Konfigurasikan kredensial Mikrotik lokal / CHR agar sistem GIS dapat menarik data PPPoE aktif dan memicu modem (TR-069) secara real-time.</span>
          </div>

          <!-- MIKROTIK IP -->
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">IP Address Router (REST API/Bridge)</label>
            <input v-model="settings.MIKROTIK_IP" type="text" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:ring-1 focus:ring-primary outline-none" placeholder="Contoh: 192.168.30.1" required />
          </div>

          <!-- MIKROTIK USER -->
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">Username API</label>
            <input v-model="settings.MIKROTIK_USER" type="text" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:ring-1 focus:ring-primary outline-none" placeholder="Contoh: restoe" required />
          </div>

          <!-- MIKROTIK PASS -->
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">Password API</label>
            <input v-model="settings.MIKROTIK_PASS" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:ring-1 focus:ring-primary outline-none" placeholder="••••••••" required />
          </div>

          <!-- Feedback Alerts -->
          <div v-if="errorMessage" class="bg-error bg-opacity-10 text-error p-3 rounded border border-error border-opacity-35 text-xs flex gap-2">
            <span class="material-symbols-outlined text-[16px]">warning</span>
            <span>{{ errorMessage }}</span>
          </div>
          <div v-if="successMessage" class="bg-green-500 bg-opacity-10 text-green-500 p-3 rounded border border-green-500 border-opacity-35 text-xs flex gap-2">
            <span class="material-symbols-outlined text-[16px]">check_circle</span>
            <span>{{ successMessage }}</span>
          </div>

          <!-- Actions -->
          <div class="flex gap-3 mt-4">
            <button @click="emit('close')" type="button" class="flex-1 py-2.5 border border-outline-variant bg-transparent text-on-surface font-semibold rounded-lg hover:bg-surface-container text-sm transition-colors cursor-pointer">Batal</button>
            <button type="submit" :disabled="isSaving" class="flex-1 py-2.5 bg-primary text-white font-semibold rounded-lg hover:opacity-90 shadow-sm text-sm disabled:opacity-50 flex items-center justify-center gap-2 border-0 cursor-pointer">
              <span v-if="isSaving" class="material-symbols-outlined animate-spin text-sm">refresh</span>
              Simpan Konfigurasi
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
