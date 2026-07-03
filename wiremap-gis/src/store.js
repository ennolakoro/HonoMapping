import { reactive } from 'vue'

export const store = reactive({
  mapMode: 'VIEW', // 'VIEW' | 'ADD_DEVICE' | 'ADD_CABLE' | 'PLOT_CLIENT'
  selectedParentId: null, // Terisi saat mode ADD_CABLE
  plottingClient: null,
  pendingCoords: null, // {lat, lng} saat user klik di peta
  pendingCablePath: null, // Array koordinat rute [[lat, lng], ...]
  isAddModalOpen: false,
  
  startAddDevice() {
    this.mapMode = 'ADD_DEVICE'
    this.selectedParentId = null
    this.plottingClient = null
    this.pendingCoords = null
    this.pendingCablePath = null
    this.isAddModalOpen = false
  },
  
  startAddCable(parentId) {
    this.mapMode = 'ADD_CABLE'
    this.selectedParentId = parentId
    this.plottingClient = null
    this.pendingCoords = null
    this.pendingCablePath = null
  },

  startPlotClient(client) {
    this.mapMode = 'PLOT_CLIENT'
    this.selectedParentId = null
    this.plottingClient = client
    this.pendingCoords = null
    this.pendingCablePath = null
    this.isAddModalOpen = false
  },
  
  cancelAdd() {
    this.mapMode = 'VIEW'
    this.selectedParentId = null
    this.plottingClient = null
    this.pendingCoords = null
    this.pendingCablePath = null
    this.isAddModalOpen = false
  },
  
  openAddModal(lat, lng) {
    this.pendingCoords = { lat, lng }
    this.isAddModalOpen = true
  }
})
