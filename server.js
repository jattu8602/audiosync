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
})

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'public', 'uploads')
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

// Track users by session ID instead of socket ID
const users = new Map() // Map sessionId -> { socketId, isHost, latency, ip, networkId }
let currentHost = null // Store the session ID of the current host

// Track network groups - map of networkId -> Set of sessionIds
const networks = new Map()

// Generate a network ID from IP address
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

  // For regular IPv4 addresses, use the first three octets
  if (ip.includes('.')) {
    return ip.split('.').slice(0, 3).join('.')
  }

  // For IPv6 addresses, use the first 4 segments
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 4).join(':')
  }

  // Fallback
  return 'unknown-' + ip
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

// Socket.IO connection handling
io.on('connection', (socket) => {
  // Get the session ID from auth
  const { sessionId, wasHost } = socket.handshake.auth

  // Get client IP address
  const ip = socket.handshake.address.replace('::ffff:', '') // Remove IPv6 prefix for IPv4 addresses
  const networkId = getNetworkId(ip)

  console.log(
    `User connected: ${sessionId} (socket: ${socket.id}, IP: ${ip}, Network: ${networkId})`
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
    }

    // Keep measuring latency periodically
    setTimeout(() => {
      if (socket.connected) {
        socket.emit('ping', { timestamp: Date.now() })
      }
    }, 10000) // Every 10 seconds
  })

  // Register user in our tracking map
  const existingUser = users.get(sessionId)

  if (existingUser) {
    // Update the existing user's socket ID and network info
    console.log(`Reconnected user with session: ${sessionId}`)

    // If network changed, update network membership
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

    // Send network information to client
    socket.emit('network-info', {
      networkId,
      userCount: networks.get(networkId)?.size || 1,
    })
  } else {
    // This is a new user
    users.set(sessionId, {
      socketId: socket.id,
      isHost: false,
      latency: 0,
      ip,
      networkId,
    })

    // Add to network group
    let network = networks.get(networkId)
    if (!network) {
      network = new Set()
      networks.set(networkId, network)
    }
    network.add(sessionId)

    // Send network information to client
    socket.emit('network-info', {
      networkId,
      userCount: networks.get(networkId)?.size || 1,
    })
  }

  // Handle host assignment per network
  let isHost = false

  // Check if this network already has a host
  const networkUsers = networks.get(networkId)
  let networkHasHost = false

  if (networkUsers) {
    for (const userId of networkUsers) {
      if (userId !== sessionId) {
        // Skip current user
        const user = users.get(userId)
        if (user && user.isHost) {
          networkHasHost = true
          break
        }
      }
    }
  }

  // If we don't have a host for this network, assign one
  if (!networkHasHost) {
    // If this user was previously a host, make them host again
    if (wasHost) {
      currentHost = sessionId
      users.get(sessionId).isHost = true
      isHost = true
      console.log(
        `Restored host status to user: ${sessionId} (Network: ${networkId})`
      )
    }
    // Otherwise, make the first user in the network a host
    else if (networkUsers && networkUsers.size === 1) {
      currentHost = sessionId
      users.get(sessionId).isHost = true
      isHost = true
      console.log(`Assigned new host: ${sessionId} (Network: ${networkId})`)
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

  // Send updated user list to everyone in the same network
  updateUsersInNetwork(networkId)

  // Handle audio control events from host
  socket.on('audio-control', (data) => {
    const user = users.get(sessionId)
    // Only the host can control the audio
    if (user && user.isHost) {
      console.log(
        `Host sent audio control: ${data.action}${
          data.fileName ? ' - File: ' + data.fileName : ''
        }`
      )
      // Only broadcast to users in the same network
      broadcastToNetwork(user.networkId, 'audio-control', data, sessionId)
    }
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
    updateUsersInNetwork(currentUser.networkId)

    console.log(`Host transfer complete: ${newHostId} is now the host`)
  })

  // Handle live audio streaming data
  socket.on('audio-stream', (data) => {
    const user = users.get(sessionId)
    // Only the host can stream audio
    if (user && user.isHost) {
      // Set high priority for audio data packets
      const options = { priority: 'high' }

      // Broadcast audio chunk to all clients in the same network
      const network = networks.get(user.networkId)
      if (!network) return

      // Track any delays for monitoring
      const serverTimestamp = Date.now()
      const audioData = {
        ...data,
        serverTimestamp,
        serverDelay: serverTimestamp - data.timestamp,
      }

      // Broadcast to clients with urgency
      for (const userId of network) {
        // Skip the host
        if (userId === sessionId) continue

        const clientUser = users.get(userId)
        if (!clientUser) continue

        const clientSocket = io.sockets.sockets.get(clientUser.socketId)
        if (clientSocket && clientSocket.connected) {
          // Emit with high priority
          clientSocket.emit('audio-stream', audioData, options)
        }
      }
    }
  })

  // Handle YouTube synchronization
  socket.on('youtube-sync', (data) => {
    const user = users.get(sessionId)
    // Only the host can initiate YouTube sync
    if (user && user.isHost) {
      console.log(`Host started YouTube sync for video: ${data.videoId}`)
      // Broadcast to all clients in the same network
      broadcastToNetwork(user.networkId, 'youtube-sync', data, sessionId)
    }
  })

  // Handle YouTube time updates
  socket.on('youtube-time-update', (data) => {
    const user = users.get(sessionId)
    // Only the host can send time updates
    if (user && user.isHost) {
      // Add server timestamp for more precise calculation
      const serverTimestamp = Date.now()
      const enhancedData = {
        ...data,
        serverTimestamp,
      }

      // Broadcast to clients in the same network
      for (const clientId of networks.get(user.networkId) || []) {
        // Skip the host
        if (clientId === sessionId) continue

        const clientData = users.get(clientId)
        if (!clientData) continue

        const clientSocket = io.sockets.sockets.get(clientData.socketId)
        if (clientSocket && clientSocket.connected) {
          clientSocket.emit('youtube-time-update', enhancedData)
        }
      }
    }
  })

  // Handle YouTube state changes (play/pause)
  socket.on('youtube-state-change', (data) => {
    const user = users.get(sessionId)
    // Only the host can control playback state
    if (user && user.isHost) {
      console.log(`Host changed YouTube state: ${data.state}`)
      // Broadcast to clients in the same network
      broadcastToNetwork(
        user.networkId,
        'youtube-state-change',
        data,
        sessionId
      )
    }
  })

  // Handle YouTube player close
  socket.on('youtube-close', () => {
    const user = users.get(sessionId)
    // Only the host can close the YouTube player
    if (user && user.isHost) {
      console.log('Host closed YouTube player')
      // Broadcast to clients in the same network
      broadcastToNetwork(user.networkId, 'youtube-close', {}, sessionId)
    }
  })

  // Host is starting a tab audio stream
  socket.on('tab-stream-start', (data) => {
    const user = users.get(sessionId)
    if (user && user.isHost) {
      console.log(
        `Host started tab audio stream: ${data.description || 'Unknown source'}`
      )
      // Let clients know to prepare for streaming audio
      broadcastToNetwork(
        user.networkId,
        'tab-stream-start',
        {
          description: data.description,
          sampleRate: data.sampleRate,
          channelCount: data.channelCount,
        },
        sessionId
      )
    }
  })

  // Host is stopping a tab audio stream
  socket.on('tab-stream-stop', () => {
    const user = users.get(sessionId)
    if (user && user.isHost) {
      console.log('Host stopped tab audio stream')
      broadcastToNetwork(user.networkId, 'tab-stream-stop', {}, sessionId)
    }
  })

  // When host sends audio time update
  socket.on('audio-time-update', (data) => {
    const user = users.get(sessionId)
    if (user && user.isHost) {
      // Add server timestamp for more precise calculation
      const serverTimestamp = Date.now()
      const enhancedData = {
        ...data,
        serverTimestamp,
      }

      // Check if this is a precision sync update (higher priority)
      const isPrecision = data.precision === true

      // Track delays for adaptive sync
      const messageAge =
        serverTimestamp - (data.clientTimestamp || serverTimestamp)

      // Only send to clients in the same network with their specific latency adjustment
      for (const clientId of networks.get(user.networkId) || []) {
        // Skip the host
        if (clientId === sessionId) continue

        const clientData = users.get(clientId)
        if (!clientData || clientData.isHost) continue

        const clientSocket = io.sockets.sockets.get(clientData.socketId)
        if (clientSocket && clientSocket.connected) {
          // Include this client's specific latency for accurate adjustment
          // Also include any server processing delay we observed
          clientSocket.emit(
            'audio-time-update',
            {
              ...enhancedData,
              latency: clientData.latency,
              serverDelay: messageAge,
            },
            {
              // If this is a precision update, use higher priority
              priority: isPrecision ? 'high' : undefined,
            }
          )
        }
      }
    }
  })

  // When a user disconnects
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${sessionId} (socket: ${socket.id})`)

    const user = users.get(sessionId)
    if (!user) return

    const userNetworkId = user.networkId

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
            `Host ${sessionId} did not reconnect, selecting new host for network ${userNetworkId}`
          )

          // If the host didn't reconnect, select a new host for that network
          // Remove the disconnected host
          users.delete(sessionId)

          // Remove from network group
          const network = networks.get(userNetworkId)
          if (network) {
            network.delete(sessionId)
            if (network.size === 0) {
              networks.delete(userNetworkId)
            } else {
              // Find a new host from remaining users in the same network
              const [newHostId] = network
              if (newHostId) {
                const newHost = users.get(newHostId)
                if (newHost) {
                  newHost.isHost = true
                  users.set(newHostId, newHost)

                  // Notify the new host
                  const newHostSocketId = newHost.socketId
                  io.to(newHostSocketId).emit('host-status', { isHost: true })
                  console.log(
                    `New host selected for network ${userNetworkId}: ${newHostId}`
                  )

                  // Update everyone in the network
                  updateUsersInNetwork(userNetworkId)
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

          // Remove from network
          const network = networks.get(userNetworkId)
          if (network) {
            network.delete(sessionId)
            if (network.size === 0) {
              networks.delete(userNetworkId)
            } else {
              // Update the user list for everyone in the network
              updateUsersInNetwork(userNetworkId)
            }
          }
        }
      }, 5000) // 5 seconds for regular users
    }
  })

  // Helper function to broadcast to all users in the same network
  function broadcastToNetwork(networkId, event, data, excludeSessionId = null) {
    const network = networks.get(networkId)
    if (!network) return

    for (const userId of network) {
      if (excludeSessionId && userId === excludeSessionId) continue

      const user = users.get(userId)
      if (!user) continue

      const userSocket = io.sockets.sockets.get(user.socketId)
      if (userSocket && userSocket.connected) {
        userSocket.emit(event, data)
      }
    }
  }

  // Helper function to update the user list for everyone in a network
  function updateUsersInNetwork(networkId) {
    const network = networks.get(networkId)
    if (!network) return

    // Create user list with network info
    const usersList = Array.from(network)
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

    // Send updated list to everyone in the network
    broadcastToNetwork(networkId, 'users-update', {
      users: usersList,
      networkId,
      sameNetwork: true,
    })
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
})

// Use environment variable for port or default to 3000
const PORT = process.env.PORT || 3000

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
