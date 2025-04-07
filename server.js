const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  maxHttpBufferSize: 20 * 1024 * 1024, // 20MB max message size
  pingTimeout: 60000, // Increased timeout
  pingInterval: 5000, // More frequent pings for better connection maintenance
  transports: ['websocket', 'polling'], // Prefer WebSocket for lower latency
  upgrade: true, // Allow transport upgrade
  connectTimeout: 20000, // Increase connection timeout
  cors: {
    origin: '*', // Allow all origins for better compatibility
    methods: ['GET', 'POST'],
  },
})

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'public', 'uploads')
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

// Track users by session ID instead of socket ID
const users = new Map() // Map sessionId -> { socketId, isHost, latency, ip, networkId, roomCode }
let currentHost = null // Store the session ID of the current host

// Track room groups - map of roomCode -> Set of sessionIds
const rooms = new Map()

// Track network groups - map of networkId -> Set of sessionIds (kept for backward compatibility)
const networks = new Map()

// Generate a random room code
function generateRoomCode() {
  // Generate a 6-character alphanumeric code
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

// Generate a network ID from IP address (kept for backward compatibility)
function getNetworkId(ip) {
  // For local development, special case for localhost and local IPs
  if (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === 'localhost' ||
    ip === '::ffff:127.0.0.1'
  ) {
    return 'local-development'
  }

  // For regular IPv4 addresses, use more specific network identification
  if (ip.includes('.')) {
    const parts = ip.split('.')

    // Check for common mobile hotspot ranges (192.168.43.x, 192.168.42.x)
    if (
      parts[0] === '192' &&
      parts[1] === '168' &&
      (parts[2] === '42' || parts[2] === '43')
    ) {
      return 'mobile-hotspot'
    }

    // For other IPv4, use only the first two octets to be more permissive in network matching
    // This will help group more devices on the same network
    return parts.slice(0, 2).join('.')
  }

  // For IPv6 addresses, use the first 4 segments
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 4).join(':')
  }

  // Fallback
  return 'unknown-' + ip
}

// Helper to get the last part of an IP address
function getLastPart(ip) {
  if (ip.includes('.')) {
    return ip.split('.').pop()
  }
  if (ip.includes(':')) {
    return ip.split(':').pop()
  }
  return ip
}

// Middleware for parsing JSON and urlencoded form data
app.use(express.json({ limit: '20mb' }))
app.use(express.urlencoded({ extended: true, limit: '20mb' }))

// Optimize audio file streaming
app.get('/uploads/:filename', (req, res) => {
  const filename = req.params.filename
  const filePath = path.join(uploadsDir, filename)

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found')
  }

  // Determine the MIME type based on file extension
  const getMimeType = (fileName) => {
    const ext = path.extname(fileName).toLowerCase()
    const mimeTypes = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.m4a': 'audio/mp4',
      '.webm': 'audio/webm',
    }
    return mimeTypes[ext] || 'application/octet-stream'
  }

  const mimeType = getMimeType(filename)

  // Get file stats for content-length
  const stat = fs.statSync(filePath)
  const fileSize = stat.size

  // Parse Range header if present for seeking
  const range = req.headers.range

  if (range) {
    // Parse Range header
    const parts = range.replace(/bytes=/, '').split('-')
    const start = parseInt(parts[0], 10)
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
    const chunkSize = end - start + 1

    // Create read stream for the range
    const fileStream = fs.createReadStream(filePath, { start, end })

    // Set headers for partial content
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
    })

    // Pipe the file stream to response
    fileStream.pipe(res)
  } else {
    // Serve the entire file
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
    })

    // Create read stream for the entire file
    const fileStream = fs.createReadStream(filePath)

    // Pipe the file stream to response
    fileStream.pipe(res)
  }
})

// Serve static files
app.use(express.static(path.join(__dirname, 'public')))

// Add manifest.json for PWA
app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'SoundSync',
    short_name: 'SoundSync',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#3498db',
    icons: [
      {
        src: '/images/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/images/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  })
})

// Endpoint for file upload
app.post('/upload', (req, res) => {
  try {
    const { audioData, fileName } = req.body

    // Extract base64 data
    const base64Data = audioData.split(';base64,').pop()

    // Generate unique filename
    const fileExt = fileName.substring(fileName.lastIndexOf('.'))
    const uniqueFileName = `${crypto.randomBytes(8).toString('hex')}${fileExt}`
    const filePath = path.join(uploadsDir, uniqueFileName)

    // Save file
    fs.writeFileSync(filePath, base64Data, { encoding: 'base64' })

    // Send back the URL of the file
    res.json({
      success: true,
      fileUrl: `/uploads/${uniqueFileName}`,
    })
  } catch (error) {
    console.error('Error uploading file:', error)
    res.status(500).json({ success: false, error: 'Failed to upload file' })
  }
})

// Helper function to handle audio control
function handleAudioControl(socket, data) {
  const sessionId = socket.handshake.auth.sessionId
  const user = users.get(sessionId)

  // Only the host can control the audio
  if (user && user.isHost) {
    console.log(
      `Host sent audio control: ${data.action}${
        data.fileName ? ' - File: ' + data.fileName : ''
      }`
    )

    // Get recipients
    const recipients = getRecipientsForUser(user)

    // Forward to all recipients (except sender)
    recipients.forEach((recipientId) => {
      if (recipientId !== sessionId) {
        const recipientSocketId = users.get(recipientId)?.socketId
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('audio-control', data)
        }
      }
    })
  }
}

// Helper function to get appropriate recipients for a user
function getRecipientsForUser(user) {
  // If user is in a room, get room users
  if (user.roomCode) {
    return Array.from(rooms.get(user.roomCode) || [])
  }

  // Otherwise use network users
  return Array.from(networks.get(user.networkId) || [])
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  // Get the session ID from auth
  const { sessionId, wasHost, roomCode: joinRoom } = socket.handshake.auth

  // Get client IP address
  const ip = socket.handshake.address.replace('::ffff:', '') // Remove IPv6 prefix for IPv4 addresses
  const networkId = getNetworkId(ip)

  // For hosted version, prioritize room code over network ID
  let userRoomCode = joinRoom || null

  console.log(
    `User connected: ${sessionId} (socket: ${
      socket.id
    }, IP: ${ip}, Network: ${networkId}, Room: ${userRoomCode || 'None'})`
  )

  // Start measuring latency right away
  socket.emit('ping', { timestamp: Date.now() })

  // Calculate latency when client responds
  socket.on('pong', (data) => {
    const latency = (Date.now() - data.timestamp) / 2 // RTT / 2 = approximate one-way latency

    // Store latency with the user data
    const userData = users.get(sessionId)
    if (userData) {
      userData.latency = latency
      users.set(sessionId, userData)
      console.log(`Measured latency for ${sessionId}: ${latency}ms`)

      // Send the latency back to client for display
      socket.emit('pong-response', { latency })
    }

    // Keep measuring latency more frequently for better responsiveness
    setTimeout(() => {
      if (socket.connected) {
        socket.emit('ping', { timestamp: Date.now() })
      }
    }, 3000) // Every 3 seconds instead of 10 for more responsive updates
  })

  // Register user in our tracking map
  const existingUser = users.get(sessionId)

  if (existingUser) {
    // Update the existing user's socket ID and network info
    console.log(`Reconnected user with session: ${sessionId}`)

    // If user is rejoining with a room code, prioritize that
    if (userRoomCode) {
      // Remove from old room if they had one
      if (existingUser.roomCode) {
        const oldRoom = rooms.get(existingUser.roomCode)
        if (oldRoom) {
          oldRoom.delete(sessionId)
          // Clean up empty rooms
          if (oldRoom.size === 0) {
            rooms.delete(existingUser.roomCode)
          }
        }
      }

      // Add to new room
      let room = rooms.get(userRoomCode)
      if (!room) {
        room = new Set()
        rooms.set(userRoomCode, room)
      }
      room.add(sessionId)

      // Update user's room code
      existingUser.roomCode = userRoomCode
    }

    // For backward compatibility, also maintain network groups
    if (existingUser.networkId && existingUser.networkId !== networkId) {
      // Remove from old network
      const oldNetwork = networks.get(existingUser.networkId)
      if (oldNetwork) {
        oldNetwork.delete(sessionId)
        // Clean up empty networks
        if (oldNetwork.size === 0) {
          networks.delete(existingUser.networkId)
        }
      }

      // Add to new network
      let network = networks.get(networkId)
      if (!network) {
        network = new Set()
        networks.set(networkId, network)
      }
      network.add(sessionId)
    }

    existingUser.socketId = socket.id
    existingUser.ip = ip
    existingUser.networkId = networkId
    users.set(sessionId, existingUser)

    // Get the network set for notifications
    let network = networks.get(networkId)
    if (!network) {
      network = new Set()
      networks.set(networkId, network)
    }

    // Notify all users on the same network that a new user has joined
    for (const userId of network) {
      const otherUser = users.get(userId)
      if (otherUser && otherUser.socketId !== socket.id) {
        io.to(otherUser.socketId).emit('network-info', {
          networkId,
          roomCode: otherUser.roomCode,
          userCount: network.size,
        })
      }
    }

    // Send network/room information to client
    socket.emit('network-info', {
      networkId,
      roomCode: existingUser.roomCode,
      userCount: existingUser.roomCode
        ? rooms.get(existingUser.roomCode)?.size || 1
        : networks.get(networkId)?.size || 1,
    })
  } else {
    // This is a new user
    const userData = {
      socketId: socket.id,
      isHost: false,
      latency: 0,
      ip,
      networkId,
      roomCode: userRoomCode,
    }

    users.set(sessionId, userData)

    // Add to room group if they have a room code
    if (userRoomCode) {
      let room = rooms.get(userRoomCode)
      if (!room) {
        room = new Set()
        rooms.set(userRoomCode, room)
      }
      room.add(sessionId)
    }

    // For backward compatibility, also add to network group
    let network = networks.get(networkId)
    if (!network) {
      network = new Set()
      networks.set(networkId, network)
    }
    network.add(sessionId)

    // Notify all users on the same network that a new user has joined
    for (const userId of network) {
      const otherUser = users.get(userId)
      if (otherUser && otherUser.socketId !== socket.id) {
        io.to(otherUser.socketId).emit('network-info', {
          networkId,
          roomCode: otherUser.roomCode,
          userCount: network.size,
        })
      }
    }

    // Send network/room information to client
    socket.emit('network-info', {
      networkId,
      roomCode: userRoomCode,
      userCount: userRoomCode
        ? rooms.get(userRoomCode)?.size || 1
        : networks.get(networkId)?.size || 1,
    })
  }

  // Handle host assignment per room/network
  let isHost = false

  // Determine which group to use (room or network)
  const userGroup =
    existingUser?.roomCode || userRoomCode
      ? rooms.get(existingUser?.roomCode || userRoomCode)
      : networks.get(networkId)

  let groupHasHost = false

  if (userGroup) {
    for (const userId of userGroup) {
      if (userId !== sessionId) {
        // Skip current user
        const user = users.get(userId)
        if (user && user.isHost) {
          groupHasHost = true
          break
        }
      }
    }
  }

  // If we don't have a host for this group, assign one
  if (!groupHasHost) {
    // If this user was previously a host, make them host again
    if (wasHost) {
      currentHost = sessionId
      users.get(sessionId).isHost = true
      isHost = true
      console.log(
        `Restored host status to user: ${sessionId} (${
          userRoomCode ? 'Room: ' + userRoomCode : 'Network: ' + networkId
        })`
      )
    }
    // Otherwise, make the first user in the group a host
    else if (userGroup && userGroup.size === 1) {
      currentHost = sessionId
      users.get(sessionId).isHost = true
      isHost = true
      console.log(
        `Assigned new host: ${sessionId} (${
          userRoomCode ? 'Room: ' + userRoomCode : 'Network: ' + networkId
        })`
      )
    }
  }
  // If this session is the current host, restore their host status
  else if (sessionId === currentHost) {
    users.get(sessionId).isHost = true
    isHost = true
    console.log(`Recognized existing host: ${sessionId}`)
  }

  // Inform the client whether they are the host
  socket.emit('host-status', { isHost })

  // Send updated user list to everyone in the same group
  const userGroup2 =
    existingUser?.roomCode || userRoomCode
      ? existingUser?.roomCode || userRoomCode
      : networkId

  // Update user list for this user first to ensure they have the latest data
  updateUsersInGroup(userGroup2)

  // Send an immediate users list update to this user specifically
  const isRoomCode = rooms.has(userGroup2)
  const group = isRoomCode ? rooms.get(userGroup2) : networks.get(userGroup2)

  if (group) {
    const usersList = Array.from(group)
      .map((userId) => {
        const user = users.get(userId)
        if (!user) return null

        return {
          id: userId,
          isHost: user.isHost,
          ipSuffix: getLastPart(user.ip),
        }
      })
      .filter(Boolean)

    socket.emit('users-update', {
      users: usersList,
      groupId: userGroup2,
      sameNetwork: true,
    })
  }

  // Generate room
  socket.on('create-room', () => {
    const user = users.get(sessionId)
    if (!user) return

    // Generate a room code
    const newRoomCode = generateRoomCode()

    // Remove from old room if any
    if (user.roomCode) {
      const oldRoom = rooms.get(user.roomCode)
      if (oldRoom) {
        oldRoom.delete(sessionId)
        if (oldRoom.size === 0) {
          rooms.delete(user.roomCode)
        }
      }
    }

    // Create and add to new room
    const newRoom = new Set([sessionId])
    rooms.set(newRoomCode, newRoom)

    // Update user data
    user.roomCode = newRoomCode
    users.set(sessionId, user)

    // Make this user the host of their room
    user.isHost = true
    currentHost = sessionId

    // Send room info to client
    socket.emit('room-created', {
      roomCode: newRoomCode,
      isHost: true,
    })

    // Update network info
    socket.emit('network-info', {
      networkId: user.networkId,
      roomCode: newRoomCode,
      userCount: 1,
    })

    console.log(`User ${sessionId} created room ${newRoomCode}`)
  })

  // Join room
  socket.on('join-room', (data) => {
    const roomCode = data.roomCode.toUpperCase()
    const user = users.get(sessionId)

    if (!user) return

    // Check if room exists
    if (!rooms.has(roomCode)) {
      socket.emit('room-join-result', {
        success: false,
        error: 'Room not found',
      })
      return
    }

    // Remove from old room if any
    if (user.roomCode) {
      const oldRoom = rooms.get(user.roomCode)
      if (oldRoom) {
        oldRoom.delete(sessionId)
        if (oldRoom.size === 0) {
          rooms.delete(user.roomCode)
        } else {
          // Update the user list for everyone in the old room
          updateUsersInGroup(user.roomCode)
        }
      }
    }

    // Add to new room
    const room = rooms.get(roomCode)
    room.add(sessionId)

    // Update user data
    user.roomCode = roomCode
    user.isHost = false // Not a host when joining
    users.set(sessionId, user)

    // Send success response
    socket.emit('room-join-result', {
      success: true,
      roomCode: roomCode,
    })

    // Update network info
    socket.emit('network-info', {
      networkId: user.networkId,
      roomCode: roomCode,
      userCount: room.size,
    })

    // Update host status
    socket.emit('host-status', { isHost: false })

    // Update user list for everyone in the room
    updateUsersInGroup(roomCode)

    console.log(`User ${sessionId} joined room ${roomCode}`)
  })

  // Auto-join host session
  socket.on('auto-join-host', (data) => {
    const user = users.get(sessionId)
    if (!user) return

    const hostId = data.hostId
    const hostUser = users.get(hostId)

    // Check if the host exists and is actually a host
    if (!hostUser || !hostUser.isHost) {
      socket.emit('auto-join-result', {
        success: false,
        error: 'Host not found or not a host',
      })
      return
    }

    // Check if host has a room code
    if (!hostUser.roomCode) {
      // Create a room code for the host first
      const newRoomCode = generateRoomCode()

      // Add host to the room
      let room = new Set([hostId])
      rooms.set(newRoomCode, room)

      // Update host data
      hostUser.roomCode = newRoomCode
      users.set(hostId, hostUser)

      // Notify host about the new room
      const hostSocket = io.sockets.sockets.get(hostUser.socketId)
      if (hostSocket && hostSocket.connected) {
        hostSocket.emit('room-created', {
          roomCode: newRoomCode,
          isHost: true,
          autoCreated: true,
        })

        hostSocket.emit('network-info', {
          networkId: hostUser.networkId,
          roomCode: newRoomCode,
          userCount: 1,
        })
      }
    }

    // Now join the host's room
    const roomCode = hostUser.roomCode

    // Remove from old room if any
    if (user.roomCode) {
      const oldRoom = rooms.get(user.roomCode)
      if (oldRoom) {
        oldRoom.delete(sessionId)
        if (oldRoom.size === 0) {
          rooms.delete(user.roomCode)
        } else {
          updateUsersInGroup(user.roomCode)
        }
      }
    }

    // Add to host's room
    let room = rooms.get(roomCode)
    if (!room) {
      room = new Set()
      rooms.set(roomCode, room)
    }
    room.add(sessionId)

    // Update user data
    user.roomCode = roomCode
    user.isHost = false
    users.set(sessionId, user)

    // Send success response
    socket.emit('auto-join-result', {
      success: true,
      roomCode: roomCode,
    })

    // Update network info
    socket.emit('network-info', {
      networkId: user.networkId,
      roomCode: roomCode,
      userCount: room.size,
    })

    // Update host status
    socket.emit('host-status', { isHost: false })

    // Update user lists
    updateUsersInGroup(roomCode)

    console.log(
      `User ${sessionId} auto-joined host ${hostId}'s room ${roomCode}`
    )
  })

  // Handle audio control messages
  socket.on('audio-control', (data) => {
    handleAudioControl(socket, data)
  })

  // Handle YouTube stream start
  socket.on('youtube-stream-start', (data) => {
    const user = users.get(sessionId)
    if (!user || !user.isHost) {
      console.log(`Non-host user ${sessionId} tried to start YouTube stream`)
      return
    }

    // Get network or room users
    const recipients = getRecipientsForUser(user)

    console.log(
      `Host ${sessionId} started YouTube stream, video ID: ${data.videoId}`
    )

    // Forward to all recipients (except sender)
    recipients.forEach((recipientId) => {
      if (recipientId !== sessionId) {
        const recipientSocketId = users.get(recipientId)?.socketId
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('youtube-stream-start', data)
        }
      }
    })
  })

  // Handle YouTube control commands
  socket.on('youtube-control', (data) => {
    const user = users.get(sessionId)
    if (!user || !user.isHost) {
      console.log(`Non-host user ${sessionId} tried to control YouTube`)
      return
    }

    // Get network or room users
    const recipients = getRecipientsForUser(user)

    // Forward to all recipients (except sender)
    recipients.forEach((recipientId) => {
      if (recipientId !== sessionId) {
        const recipientSocketId = users.get(recipientId)?.socketId
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('youtube-control', data)
        }
      }
    })
  })

  // Handle YouTube sync (fallback method)
  socket.on('youtube-sync', (data) => {
    const user = users.get(sessionId)
    if (!user || !user.isHost) {
      console.log(`Non-host user ${sessionId} tried to sync YouTube`)
      return
    }

    // Get network or room users
    const recipients = getRecipientsForUser(user)

    console.log(
      `Host ${sessionId} sent YouTube sync, video ID: ${data.videoId}`
    )

    // Forward to all recipients (except sender)
    recipients.forEach((recipientId) => {
      if (recipientId !== sessionId) {
        const recipientSocketId = users.get(recipientId)?.socketId
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('youtube-sync', data)
        }
      }
    })
  })

  // Handle host transfer request
  socket.on('transfer-host', (data) => {
    const currentUser = users.get(sessionId)

    // Check if the requester is actually the host
    if (!currentUser || !currentUser.isHost) {
      socket.emit('host-transfer-result', {
        success: false,
        error: 'Only the current host can transfer host status',
        previousHostId: sessionId,
      })
      return
    }

    // Get the new host by session ID
    const newHostId = data.newHostId
    const newHost = users.get(newHostId)

    // Check if the new host exists and is on the same network
    if (!newHost) {
      socket.emit('host-transfer-result', {
        success: false,
        error: 'User not found',
        previousHostId: sessionId,
      })
      return
    }

    // Check if both users are on the same network
    if (newHost.networkId !== currentUser.networkId) {
      socket.emit('host-transfer-result', {
        success: false,
        error: 'Cannot transfer host to a user on a different network',
        previousHostId: sessionId,
      })
      return
    }

    console.log(`Transferring host from ${sessionId} to ${newHostId}`)

    // Remove host status from current host
    currentUser.isHost = false
    users.set(sessionId, currentUser)

    // Give host status to new host
    newHost.isHost = true
    users.set(newHostId, newHost)

    // Update the current host reference
    currentHost = newHostId

    // Notify both users about the change
    socket.emit('host-status', { isHost: false })
    io.to(newHost.socketId).emit('host-status', { isHost: true })

    // Send transfer result to previous host
    socket.emit('host-transfer-result', {
      success: true,
      previousHostId: sessionId,
      newHostId: newHostId,
    })

    // Update user list for everyone in the network
    updateUsersInGroup(currentUser.networkId)

    console.log(`Host transfer complete: ${newHostId} is now the host`)
  })

  // Handle audio time updates
  socket.on('audio-time-update', (data) => {
    const user = users.get(sessionId)
    if (user && user.isHost) {
      // Add server timestamp for more precise calculation
      const serverTimestamp = Date.now()

      // Priority processing for sync messages
      process.nextTick(() => {
        const enhancedData = {
          ...data,
          serverTimestamp,
          priority: true,
        }

        // Check if this is a precision sync update (higher priority)
        const isPrecision = data.precision === true

        // Track delays for adaptive sync
        const messageAge =
          serverTimestamp - (data.clientTimestamp || serverTimestamp)

        // Only send to clients in the same group with their specific latency adjustment
        for (const clientId of networks.get(user.networkId) || []) {
          // Skip the host
          if (clientId === sessionId) continue

          const clientData = users.get(clientId)
          if (!clientData || clientData.isHost) continue

          const clientSocket = io.sockets.sockets.get(clientData.socketId)
          if (clientSocket && clientSocket.connected) {
            // Include this client's specific latency for accurate adjustment
            // Also include any server processing delay we observed
            clientSocket.volatile.emit(
              'audio-time-update',
              {
                ...enhancedData,
                latency: clientData.latency,
                serverDelay: messageAge,
                adaptiveSyncEnabled: true,
              },
              {
                // If this is a precision update, use higher priority
                priority: isPrecision ? 'high' : undefined,
              }
            )
          }
        }
      })
    }
  })

  // When a user disconnects
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${sessionId} (socket: ${socket.id})`)

    const user = users.get(sessionId)
    if (!user) return

    const userGroupId = user.roomCode || user.networkId

    // We don't immediately remove the user from our Map
    // This allows them to reconnect with the same session ID

    // But if the host disconnects, we need to handle that after a delay
    // to allow for brief reconnections
    if (user.isHost) {
      setTimeout(() => {
        // Check if the host reconnected
        const updatedUser = users.get(sessionId)
        if (updatedUser && updatedUser.socketId === socket.id) {
          console.log(
            `Host ${sessionId} did not reconnect, selecting new host for group ${userGroupId}`
          )

          // If the host didn't reconnect, select a new host for that group
          // Remove the disconnected host
          users.delete(sessionId)

          // Get the correct group (room or network)
          const group = user.roomCode
            ? rooms.get(user.roomCode)
            : networks.get(user.networkId)

          if (group) {
            group.delete(sessionId)
            if (group.size === 0) {
              if (user.roomCode) {
                rooms.delete(user.roomCode)
              } else {
                networks.delete(user.networkId)
              }
            } else {
              // Find a new host from remaining users in the same group
              const [newHostId] = group
              if (newHostId) {
                const newHost = users.get(newHostId)
                if (newHost) {
                  newHost.isHost = true
                  users.set(newHostId, newHost)

                  // Notify the new host
                  const newHostSocketId = newHost.socketId
                  io.to(newHostSocketId).emit('host-status', { isHost: true })
                  console.log(
                    `New host selected for group ${userGroupId}: ${newHostId}`
                  )

                  // Update everyone in the group
                  updateUsersInGroup(userGroupId)
                }
              }
            }
          }
        }
      }, 10000) // Wait 10 seconds before selecting a new host
    } else {
      // For non-host users, we clean up after a shorter delay
      setTimeout(() => {
        const updatedUser = users.get(sessionId)
        if (updatedUser && updatedUser.socketId === socket.id) {
          // User didn't reconnect within the timeout
          users.delete(sessionId)

          // Remove from the appropriate group
          const group = user.roomCode
            ? rooms.get(user.roomCode)
            : networks.get(user.networkId)

          if (group) {
            group.delete(sessionId)
            if (group.size === 0) {
              if (user.roomCode) {
                rooms.delete(user.roomCode)
              } else {
                networks.delete(user.networkId)
              }
            } else {
              // Update the user list for everyone in the group
              updateUsersInGroup(userGroupId)
            }
          }
        }
      }, 5000) // 5 seconds for regular users
    }
  })

  // Helper function to broadcast to all users in the same group (room or network)
  function broadcastToGroup(groupId, event, data, excludeSessionId = null) {
    // Determine if groupId is a room code or network ID
    const isRoomCode = rooms.has(groupId)
    const group = isRoomCode ? rooms.get(groupId) : networks.get(groupId)

    if (!group) return

    for (const userId of group) {
      if (excludeSessionId && userId === excludeSessionId) continue

      const user = users.get(userId)
      if (!user) continue

      const userSocket = io.sockets.sockets.get(user.socketId)
      if (userSocket && userSocket.connected) {
        userSocket.emit(event, data)
      }
    }
  }

  // Helper function to update the user list for everyone in a group
  function updateUsersInGroup(groupId) {
    // Determine if groupId is a room code or network ID
    const isRoomCode = rooms.has(groupId)
    const group = isRoomCode ? rooms.get(groupId) : networks.get(groupId)

    if (!group) return

    // Create user list with group info
    const usersList = Array.from(group)
      .map((userId) => {
        const user = users.get(userId)
        if (!user) return null

        return {
          id: userId,
          isHost: user.isHost,
          // Only share the last octet/part of the IP for privacy
          ipSuffix: getLastPart(user.ip),
        }
      })
      .filter(Boolean) // Remove null entries

    // Send updated list to everyone in the group
    broadcastToGroup(groupId, 'users-update', {
      users: usersList,
      groupId: groupId,
      sameNetwork: true,
    })
  }
})

// Add a new function for automatic user discovery
function broadcastNetworkUsers() {
  // For each network, broadcast active users to everyone in that network
  for (const [networkId, usersInNetwork] of networks.entries()) {
    if (usersInNetwork.size > 1) {
      // If there are multiple users in this network

      // Create a list of users for this network
      const networkUsersList = Array.from(usersInNetwork)
        .map((userId) => {
          const user = users.get(userId)
          if (!user) return null

          return {
            id: userId,
            isHost: user.isHost,
            ipSuffix: getLastPart(user.ip),
          }
        })
        .filter(Boolean)

      // Broadcast to all users in this network
      for (const userId of usersInNetwork) {
        const user = users.get(userId)
        if (!user) continue

        const userSocket = io.sockets.sockets.get(user.socketId)
        if (userSocket && userSocket.connected) {
          userSocket.emit('auto-discovery', {
            networkId,
            users: networkUsersList,
          })
        }
      }
    }
  }
}

// Set up periodic broadcasts of network users
const AUTO_DISCOVERY_INTERVAL = 5000 // 5 seconds
setInterval(broadcastNetworkUsers, AUTO_DISCOVERY_INTERVAL)

// Use environment variable for port or default to 3000
const PORT = process.env.PORT || 3000

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
