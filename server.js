const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 1e6, // 1MB max payload
  cors: {
    origin: "*"
  }
});

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
console.log("Serving static files from:", path.join(__dirname, 'public'));

// Rate limiting per user
const userRateLimits = new Map();
const RATE_LIMIT_WINDOW = 1000; // 1 second
const MAX_REQUESTS_PER_WINDOW = 1;

// Physics settings
let physicsSettings = {
  gravity: 1,
  elasticity: 0.8,
  dropping: false,
  countdownActive: false,
  countdownSeconds: 0
};

// Helper function to generate Gravatar URL
function getGravatarUrl(email) {
  const hash = crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=80&d=identicon`;
}

// Rate limiting middleware for socket events
function checkRateLimit(socketId) {
  const now = Date.now();
  const userLimit = userRateLimits.get(socketId);
  
  if (!userLimit) {
    userRateLimits.set(socketId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  if (now > userLimit.resetTime) {
    userRateLimits.set(socketId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  if (userLimit.count >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  
  userLimit.count++;
  return true;
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [socketId, limit] of userRateLimits.entries()) {
    if (now > limit.resetTime + 60000) { // Clean up after 1 minute
      userRateLimits.delete(socketId);
    }
  }
}, 60000);

// Helper function to count connected users
function getUserCount() {
  const sockets = io.sockets.sockets;
  let count = 0;
  for (const [id, socket] of sockets) {
    if (socket.rooms.has('users')) {
      count++;
    }
  }
  return count;
}

// Broadcast user count to welcome screens
function broadcastUserCount() {
  const count = getUserCount();
  io.to('welcome').emit('users:count', { count });
}

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  
  // Admin authentication and room joining
  socket.on('admin:login', (data) => {
    if (data.password === ADMIN_PASSWORD) {
      socket.join('controllers');
      socket.join('display');
      socket.emit('admin:authenticated', { success: true });
      
      // Send current physics settings
      socket.emit('physics:update', physicsSettings);
      console.log('Admin authenticated:', socket.id);
    } else {
      socket.emit('admin:authenticated', { success: false, error: 'Invalid password' });
    }
  });
  
  // Welcome screen joining
  socket.on('welcome:join', () => {
    socket.join('welcome');
    const count = getUserCount();
    socket.emit('users:count', { count });
    console.log('Welcome screen joined:', socket.id);
  });
  
  // Request user count
  socket.on('welcome:requestCount', () => {
    if (socket.rooms.has('welcome')) {
      const count = getUserCount();
      socket.emit('users:count', { count });
    }
  });
  
  // User joining
  socket.on('user:join', (data) => {
    if (!data || !data.email || typeof data.email !== 'string' || data.email.length > 100) {
      socket.emit('user:error', { error: 'Invalid email' });
      return;
    }
    
    socket.join('users');
    const gravatarUrl = getGravatarUrl(data.email);
    socket.data.email = data.email;
    socket.data.gravatarUrl = gravatarUrl;
    
    socket.emit('user:joined', { 
      email: data.email,
      gravatarUrl: gravatarUrl,
      dropping: physicsSettings.dropping,
      countdownActive: physicsSettings.countdownActive
    });
    
    console.log('User joined:', data.email);
    
    // Broadcast updated user count to welcome screens
    broadcastUserCount();
  });
  
  // User dropping a ball
  socket.on('user:drop', (data) => {
    // Verify user is in users room
    if (!socket.rooms.has('users')) {
      return;
    }
    
    // Check if dropping is allowed
    if (!physicsSettings.dropping) {
      socket.emit('user:error', { error: 'Dropping not allowed currently' });
      return;
    }
    
    // Rate limiting
    if (!checkRateLimit(socket.id)) {
      socket.emit('user:error', { error: 'Rate limit exceeded. Wait 1 second between drops.' });
      return;
    }
    
    // Generate random color for each ball
    const color = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
    
    const ballData = {
      gravatarUrl: socket.data.gravatarUrl,
      color: color,
      timestamp: Date.now()
    };
    
    // Send only to display room
    io.to('display').emit('ball:add', ballData);
    socket.emit('user:dropped', { success: true, nextDropTime: Date.now() + 1000 });
    
    console.log('Ball dropped by:', socket.data.email);
  });
  
  // Admin controls - only from controllers room
  socket.on('admin:updatePhysics', (data) => {
    if (!socket.rooms.has('controllers')) {
      return;
    }
    
    if (typeof data.gravity === 'number' && data.gravity >= 0 && data.gravity <= 5) {
      physicsSettings.gravity = data.gravity;
    }
    
    if (typeof data.elasticity === 'number' && data.elasticity >= 0 && data.elasticity <= 1) {
      physicsSettings.elasticity = data.elasticity;
    }
    
    // Broadcast to display
    io.to('display').emit('physics:update', physicsSettings);
    console.log('Physics updated:', physicsSettings);
  });
  
  socket.on('admin:toggleDropping', (data) => {
    if (!socket.rooms.has('controllers')) {
      return;
    }
    
    physicsSettings.dropping = data.dropping;
    
    // Notify all users and displays
    io.to('users').emit('dropping:changed', { dropping: physicsSettings.dropping });
    io.to('display').emit('dropping:changed', { dropping: physicsSettings.dropping });
    console.log('Dropping toggled:', physicsSettings.dropping);
  });
  
  socket.on('admin:startCountdown', (data) => {
    if (!socket.rooms.has('controllers')) {
      return;
    }
    
    if (typeof data.seconds !== 'number' || data.seconds <= 0 || data.seconds > 3600) {
      return;
    }
    
    physicsSettings.countdownActive = true;
    physicsSettings.countdownSeconds = data.seconds;
    
    // Broadcast countdown to all
    io.emit('countdown:start', { seconds: data.seconds });
    console.log('Countdown started:', data.seconds);
    
    // Auto-disable dropping when countdown ends (handled client-side, but backup here)
    setTimeout(() => {
      if (physicsSettings.countdownActive) {
        physicsSettings.dropping = false;
        physicsSettings.countdownActive = false;
        io.to('users').emit('dropping:changed', { dropping: false });
        io.to('display').emit('dropping:changed', { dropping: false });
        io.emit('countdown:end');
      }
    }, data.seconds * 1000);
  });
  
  socket.on('admin:reset', () => {
    if (!socket.rooms.has('controllers')) {
      return;
    }
    
    // Tell display to remove floor and reset
    io.to('display').emit('world:reset');
    console.log('World reset triggered');
  });
  
  socket.on('disconnect', () => {
    const wasUser = socket.rooms.has('users');
    userRateLimits.delete(socket.id);
    console.log('Disconnected:', socket.id);
    
    // Broadcast updated user count if a user disconnected
    if (wasUser) {
      setTimeout(() => broadcastUserCount(), 100);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
