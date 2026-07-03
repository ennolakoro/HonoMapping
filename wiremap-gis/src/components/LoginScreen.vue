<script setup>
import { ref } from 'vue'
import { api } from '../api'

const emit = defineEmits(['login-success'])

const email = ref('')
const password = ref('')
const errorMsg = ref('')
const isLoading = ref(false)

const handleLogin = async () => {
  try {
    isLoading.value = true
    errorMsg.value = ''
    await api.login(email.value, password.value)
    emit('login-success')
  } catch (err) {
    errorMsg.value = err.message || 'Login gagal, periksa email/password'
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-surface-container-lowest">
    <div class="bg-surface-container-low p-8 rounded-2xl shadow-xl border border-outline-variant w-full max-w-md">
      <div class="flex items-center justify-center gap-2 mb-8">
        <span class="material-symbols-outlined text-primary text-4xl">device_hub</span>
        <h1 class="text-3xl font-bold text-primary tracking-tight">WireMap</h1>
      </div>
      
      <form @submit.prevent="handleLogin" class="flex flex-col gap-4">
        <div>
          <label class="block text-sm font-medium text-on-surface-variant mb-1">Email</label>
          <input 
            v-model="email" 
            type="email" 
            required
            class="w-full bg-surface-container border border-outline-variant text-on-surface rounded-lg px-4 py-2 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
        </div>
        
        <div>
          <label class="block text-sm font-medium text-on-surface-variant mb-1">Password</label>
          <input 
            v-model="password" 
            type="password" 
            required
            class="w-full bg-surface-container border border-outline-variant text-on-surface rounded-lg px-4 py-2 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
        </div>

        <div v-if="errorMsg" class="text-error text-sm font-medium p-2 bg-error bg-opacity-10 rounded-lg">
          {{ errorMsg }}
        </div>
        
        <button 
          type="submit" 
          :disabled="isLoading"
          class="mt-4 w-full bg-primary hover:bg-primary-fixed text-white font-semibold py-3 rounded-lg transition-colors flex justify-center items-center gap-2 disabled:opacity-70"
        >
          <span v-if="!isLoading">Masuk ke Dashboard</span>
          <span v-else class="material-symbols-outlined animate-spin">progress_activity</span>
        </button>
      </form>
    </div>
  </div>
</template>
