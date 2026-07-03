<script setup>
import { computed, ref, watch } from 'vue'
import { api } from '../api'
import { store } from '../store'

const emit = defineEmits(['save'])

const form = ref({
  type: 'OLT',
  induk: '',
  nama: '',
  keterangan: '',
  jumlahPort: ''
})

const devices = ref([])
const isLoadingDevices = ref(false)
const loadError = ref('')

const resetForm = () => {
  form.value = {
    type: store.selectedParentId ? 'ODC' : 'OLT',
    induk: store.selectedParentId || '',
    nama: '',
    keterangan: '',
    jumlahPort: ''
  }
}

const loadDevices = async () => {
  try {
    isLoadingDevices.value = true
    loadError.value = ''
    devices.value = await api.getDevices()
  } catch (err) {
    loadError.value = 'Gagal memuat uplink: ' + err.message
  } finally {
    isLoadingDevices.value = false
  }
}

watch(() => store.isAddModalOpen, (isOpen) => {
  if (isOpen) {
    resetForm()
    loadDevices()
  }
})

watch(() => form.value.type, (type) => {
  if (type === 'OLT') {
    form.value.induk = ''
    form.value.jumlahPort = ''
    return
  }
  if (store.selectedParentId) {
    form.value.induk = store.selectedParentId
    return
  }
  if (!uplinkOptions.value.some(device => String(device.id) === String(form.value.induk))) {
    form.value.induk = uplinkOptions.value[0]?.id || ''
  }
})

const uplinkOptions = computed(() => {
  const plottedDevices = devices.value.filter(device => device.type !== 'CLIENT' && device.lat && device.lng)
  if (form.value.type === 'ODC') {
    return plottedDevices.filter(device => ['OLT', 'ODP'].includes(device.type))
  }
  if (form.value.type === 'ODP') {
    return plottedDevices.filter(device => ['OLT', 'ODC', 'ODP'].includes(device.type))
  }
  if (form.value.type === 'CLIENT') {
    return plottedDevices.filter(device => device.type === 'ODP')
  }
  return []
})

const submitForm = (syncAfterSave = false) => {
  emit('save', {
    ...form.value,
    syncAfterSave,
    lat: store.pendingCoords?.lat,
    lng: store.pendingCoords?.lng
  })
  store.cancelAdd()
  resetForm()
}
</script>

<template>
  <div v-if="store.isAddModalOpen" class="add-device-overlay">
    <article class="add-device-panel">
      <header class="add-device-header">
        <div class="header-main">
          <div class="header-icon">
            <span class="material-symbols-outlined">add_location_alt</span>
          </div>
          <div>
            <h2>Tambah Perangkat</h2>
            <p>Lokasi mengikuti titik yang dipilih di peta.</p>
          </div>
        </div>
        <button @click="store.cancelAdd()" class="icon-close" aria-label="Tutup modal">
          <span class="material-symbols-outlined">close</span>
        </button>
      </header>

      <form class="add-device-body" @submit.prevent="submitForm(false)">
        <label class="form-field">
          <span>Type</span>
          <select v-model="form.type">
            <option value="OLT">OLT</option>
            <option value="ODC">ODC</option>
            <option value="ODP">ODP</option>
            <option value="CLIENT">CLIENT</option>
          </select>
        </label>

        <label v-if="form.type !== 'OLT'" class="form-field">
          <span>Uplink / Induk</span>
          <select v-model="form.induk" :required="form.type !== 'OLT'" :disabled="!!store.selectedParentId || isLoadingDevices">
            <option value="">Pilih uplink</option>
            <option v-for="device in uplinkOptions" :key="device.id" :value="device.id">
              {{ device.name }} ({{ device.type }})
            </option>
          </select>
        </label>

        <label class="form-field">
          <span>Nama</span>
          <input v-model="form.nama" required placeholder="Contoh: ODP-01-A" />
        </label>

        <label v-if="['ODC', 'ODP'].includes(form.type)" class="form-field">
          <span>Port</span>
          <input v-model="form.jumlahPort" required type="number" min="1" placeholder="Contoh: 8" />
        </label>

        <label class="form-field">
          <span>Keterangan</span>
          <textarea v-model="form.keterangan" rows="3" placeholder="Catatan teknis atau lokasi tiang"></textarea>
        </label>

        <div class="location-note">
          <span class="material-symbols-outlined">my_location</span>
          <strong v-if="store.pendingCoords">
            {{ store.pendingCoords.lat.toFixed(6) }}, {{ store.pendingCoords.lng.toFixed(6) }}
          </strong>
          <strong v-else>Lokasi belum tersedia</strong>
        </div>

        <div v-if="loadError" class="form-alert">{{ loadError }}</div>
        <div v-if="form.type !== 'OLT' && !uplinkOptions.length && !isLoadingDevices" class="form-alert">
          Belum ada uplink yang bisa dipilih untuk type ini.
        </div>

        <div class="modal-actions">
          <button type="button" @click="store.cancelAdd()" class="secondary">Batal</button>
          <button
            v-if="form.type === 'OLT'"
            type="button"
            class="primary"
            :disabled="!form.nama || !store.pendingCoords"
            @click="submitForm(true)"
          >
            <span class="material-symbols-outlined">sync</span>
            Simpan OLT & Sync
          </button>
          <button
            v-else
            type="submit"
            class="primary"
            :disabled="!store.pendingCoords || (form.type !== 'OLT' && !form.induk)"
          >
            Simpan Perangkat
          </button>
        </div>
      </form>
    </article>
  </div>
</template>

<style scoped>
.add-device-overlay {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
  background: rgba(2, 6, 23, 0.58);
  backdrop-filter: blur(6px);
}

.add-device-panel {
  width: clamp(340px, 92vw, 430px);
  overflow: hidden;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 14px;
  background: #07111f;
  color: #e5edf8;
  box-shadow: 0 22px 70px rgba(2, 6, 23, 0.58);
}

.add-device-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  background: linear-gradient(135deg, #0b1730 0%, #10233f 100%);
}

.header-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.header-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  border: 1px solid rgba(96, 165, 250, 0.35);
  border-radius: 10px;
  background: rgba(59, 130, 246, 0.18);
  color: #93c5fd;
}

.header-icon .material-symbols-outlined,
.icon-close .material-symbols-outlined {
  font-size: 20px;
}

.add-device-header h2 {
  margin: 0;
  color: #f8fafc;
  font-size: 16px;
  font-weight: 900;
}

.add-device-header p {
  margin: 3px 0 0;
  color: #94a3b8;
  font-size: 11px;
  font-weight: 700;
}

.icon-close {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border: 1px solid rgba(148, 163, 184, 0.26);
  border-radius: 9px;
  background: rgba(15, 23, 42, 0.7);
  color: #cbd5e1;
  cursor: pointer;
}

.add-device-body {
  display: grid;
  gap: 10px;
  padding: 12px;
  background:
    radial-gradient(circle at top right, rgba(59, 130, 246, 0.12), transparent 34%),
    #07111f;
}

.form-field {
  display: grid;
  gap: 6px;
}

.form-field span {
  color: #94a3b8;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.form-field input,
.form-field select,
.form-field textarea {
  width: 100%;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 10px;
  background: #06101d;
  color: #f8fafc;
  padding: 10px 11px;
  font-size: 13px;
  font-weight: 700;
  outline: none;
}

.form-field textarea {
  resize: vertical;
  min-height: 82px;
}

.form-field input:focus,
.form-field select:focus,
.form-field textarea:focus {
  border-color: #60a5fa;
  box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.15);
}

.location-note,
.form-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 10px;
  background: #0d1a2c;
  color: #cbd5e1;
  padding: 10px;
  font-size: 12px;
}

.location-note .material-symbols-outlined {
  color: #93c5fd;
  font-size: 18px;
}

.form-alert {
  background: rgba(120, 53, 15, 0.3);
  color: #fde68a;
  font-weight: 800;
}

.modal-actions {
  display: grid;
  grid-template-columns: 1fr 1.5fr;
  gap: 8px;
  margin-top: 2px;
}

.modal-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 40px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 900;
  cursor: pointer;
}

.modal-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.modal-actions .secondary {
  border: 1px solid rgba(148, 163, 184, 0.24);
  background: #0d1a2c;
  color: #e2e8f0;
}

.modal-actions .primary {
  border: 1px solid rgba(96, 165, 250, 0.35);
  background: #2563eb;
  color: #fff;
}

.modal-actions .material-symbols-outlined {
  font-size: 17px;
}
</style>
