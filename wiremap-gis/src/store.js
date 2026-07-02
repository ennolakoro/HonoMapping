import { reactive } from 'vue'

export const store = reactive({
  mapMode: 'VIEW', // 'VIEW' | 'ADD_DEVICE' | 'ADD_CABLE'
  selectedParentId: null, // Terisi saat mode ADD_CABLE
  pendingCoords: null, // {lat, lng} saat user klik di peta
  isAddModalOpen: false,
  
  startAddDevice() {
    this.mapMode = 'ADD_DEVICE'
    this.selectedParentId = null
    this.pendingCoords = null
  },
  
  startAddCable(parentId) {
    this.mapMode = 'ADD_CABLE'
    this.selectedParentId = parentId
    this.pendingCoords = null
  },
  
  cancelAdd() {
    this.mapMode = 'VIEW'
    this.selectedParentId = null
    this.pendingCoords = null
    this.isAddModalOpen = false
  },
  
  openAddModal(lat, lng) {
    this.pendingCoords = { lat, lng }
    this.isAddModalOpen = true
  }
})
