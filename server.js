{
  "name": "led17-server",
  "version": "1.0.0",
  "description": "LeD17 Casino Live — Serveur backend + Bot DLive",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "mongoose": "^7.6.3",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "ws": "^8.14.2",
    "graphql-ws": "^5.14.2",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2"
  }
}
