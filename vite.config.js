// vite.config.js
import { resolve } from 'path'
import { defineConfig } from 'vite'


export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        CreateChatbot: resolve(__dirname, 'CreateChatbot.html'),
        ChatbotList: resolve(__dirname, 'ChatbotList.html'),
        AfterLogIn: resolve(__dirname, 'AfterLogIn.html'),
        Admin: resolve(__dirname, 'Admin.html'),
        Math: resolve(__dirname, 'Math.html'),
        Korean: resolve(__dirname, 'Korean.html'),
        English: resolve(__dirname, 'English.html'),
        Education: resolve(__dirname, 'Education.html'),
        French: resolve(__dirname, 'French.html'),
        Physics: resolve(__dirname, 'Physics.html'),
        Geography: resolve(__dirname, 'Geography.html'),
        Biology: resolve(__dirname, 'Biology.html')
      },
    },
  },
})
