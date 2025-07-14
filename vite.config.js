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
      },
    },
  },
})
