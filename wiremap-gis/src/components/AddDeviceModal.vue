<script setup>
import { ref, watch } from 'vue'
import { store } from '../store'

const emit = defineEmits(['save'])

const form = ref({
  type: 'ODC',
  induk: '',
  nama: '',
  keterangan: '',
  jumlahPort: ''
})

// Ketika modal dibuka, otomatis isi Lat Lng dan Induk (jika mode Add Cable)
watch(() => store.isAddModalOpen, (isOpen) => {
  if (isOpen) {
    form.value.induk = store.selectedParentId || ''
    
    // Default ODC/ODP jika tambah kabel, default OLT jika tidak ada induk
    if (store.selectedParentId) {
      form.value.type = 'ODC'
    } else {
      form.value.type = 'OLT'
    }
  }
})

const submitForm = () => {
  emit('save', { 
    ...form.value, 
    lat: store.pendingCoords?.lat,
    lng: store.pendingCoords?.lng
  })
  store.cancelAdd()
  // Reset form
  form.value = { type: 'ODC', induk: '', nama: '', keterangan: '', jumlahPort: '' }
}
</script>

<template>
  <div v-if="store.isAddModalOpen" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
    <div class="bg-surface-container-lowest border border-outline-variant w-full max-w-md rounded-xl shadow-lg overflow-hidden flex flex-col">
      <!-- Header -->
      <div class="px-6 py-4 border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
        <h3 class="text-xl font-bold text-on-surface">Tambah Perangkat</h3>
        <button @click="store.cancelAdd()" class="text-on-surface-variant hover:text-error p-1 rounded-md transition-colors">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      
      <!-- Form Body -->
      <form @submit.prevent="submitForm" class="p-6 flex flex-col gap-4">
        <!-- Type -->
        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">Type</label>
          <select v-model="form.type" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-on-surface focus:ring-1 focus:ring-primary outline-none">
            <option value="OLT">OLT (Induk Utama)</option>
            <option value="ODC">ODC (Optical Distribution Cabinet)</option>
            <option value="ODP">ODP (Optical Distribution Point)</option>
            <option value="CLIENT">CLIENT</option>
          </select>
        </div>

        <!-- Nama -->
        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">Nama</label>
          <input v-model="form.nama" type="text" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-on-surface focus:ring-1 focus:ring-primary outline-none" placeholder="Contoh: ODP-SU-05" required />
        </div>

        <!-- Induk (Semua Butuh Induk Sesuai Permintaan) -->
        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">
            {{ form.type === 'OLT' ? 'Induk (Opsional)' : 'Induk / Uplink (ODP/ODC)' }}
          </label>
          <input v-model="form.induk" type="text" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-on-surface focus:ring-1 focus:ring-primary outline-none" placeholder="ID Perangkat Induk..." :required="form.type !== 'OLT'" :disabled="!!store.selectedParentId" />
          <span v-if="store.selectedParentId" class="text-[10px] text-green-500">*Terisi otomatis dari Tambah Kabel</span>
        </div>

        <!-- Dynamic Fields untuk ODC/ODP -->
        <div v-if="['ODC', 'ODP'].includes(form.type)" class="flex flex-col gap-1.5">
          <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">Jumlah Port (Kapasitas)</label>
          <input v-model="form.jumlahPort" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-on-surface focus:ring-1 focus:ring-primary outline-none" placeholder="Contoh: 8" required />
        </div>

        <!-- Dynamic Fields untuk CLIENT -->
        <div v-if="form.type === 'CLIENT'" class="grid grid-cols-2 gap-4">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase text-blue-500">PPPoE Username</label>
            <input v-model="form.pppoeUsername" type="text" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-on-surface focus:ring-1 focus:ring-blue-500 outline-none" placeholder="user@mikrotik" />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase text-green-500">SN Modem (CWMP)</label>
            <input v-model="form.snModem" type="text" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-on-surface focus:ring-1 focus:ring-green-500 outline-none" placeholder="ZTEGC... (Opsional)" />
          </div>
        </div>

        <!-- Keterangan -->
        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">Keterangan</label>
          <textarea v-model="form.keterangan" rows="2" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-on-surface focus:ring-1 focus:ring-primary outline-none resize-none" placeholder="Catatan tambahan..."></textarea>
        </div>

        <div class="bg-surface-container p-2 rounded-lg text-xs text-on-surface-variant text-center border border-outline-variant">
          📍 Lokasi: {{ store.pendingCoords?.lat.toFixed(5) }}, {{ store.pendingCoords?.lng.toFixed(5) }}
        </div>

        <!-- Actions -->
        <div class="flex gap-3 mt-4">
          <button @click="store.cancelAdd()" type="button" class="flex-1 py-2.5 border border-outline-variant text-on-surface font-medium rounded-lg hover:bg-surface-container transition-colors">Batal</button>
          <button type="submit" class="flex-1 py-2.5 bg-primary text-white font-medium rounded-lg hover:opacity-90 shadow-sm">Simpan</button>
        </div>
      </form>
    </div>
  </div>
</template>
