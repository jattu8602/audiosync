document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const connectionStatus = document.getElementById('connection-status')
  const roleStatus = document.getElementById('role-status')
  const hostControls = document.getElementById('host-controls')
  const clientMessage = document.getElementById('client-message')
  const clientStatus = document.getElementById('client-status')
  const loadingIndicator = document.getElementById('loading-indicator')
  const playerContainer = document.getElementById('player-container')
  const audioPlayer = document.getElementById('audio-player')
  const audioFileInput = document.getElementById('audio-file-input')
  const progressBar = document.getElementById('progress-bar')
  const currentTimeDisplay = document.getElementById('current-time')
  const durationDisplay = document.getElementById('duration')
  const usersList = document.getElementById('users-list')
  const acceptAudioContainer = document.getElementById('accept-audio-container')
  const acceptAudioButton = document.getElementById('accept-audio-button')

  // Room Management Elements
  const roomStatus = document.getElementById('room-status')
  const roomCodeDisplay = document.getElementById('room-code')
  const createRoomBtn = document.getElementById('create-room-btn')
  const joinRoomBtn = document.getElementById('join-room-btn')
  const roomCodeInput = document.getElementById('room-code-input')

  // Tab streaming controls
  const streamTabButton = document.getElementById('stream-tab-audio')
  const stopStreamingButton = document.getElementById('stop-streaming')
  const streamStatus = document.getElementById('stream-status')

  // Network info elements
  const networkIdElement = document.getElementById('network-id')
  const networkUsersElement = document
    .getElementById('network-users')
    .querySelector('span')

  // Get or create persistent session ID
  let sessionId = localStorage.getItem('soundsync_session_id')
  if (!sessionId) {
    sessionId = generateSessionId()
    localStorage.setItem('soundsync_session_id', sessionId)
  }

  // Get stored room code if any
  let currentRoomCode = localStorage.getItem('soundsync_room_code')

  // Socket.IO connection with auth
  const socket = io({
    auth: {
      sessionId,
      wasHost: localStorage.getItem('soundsync_was_host') === 'true',
      roomCode: currentRoomCode,
    },
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 20000,
  })

  // Variables
  let isHost = false
  let isSyncingTime = false
  let users = {}
  let currentAudioSource = null
  let networkLatency = 0 // Track network latency
  let currentNetworkId = null
  let onSameNetwork = true
  let audioAccepted = false // Track if client has accepted audio
  let isStreaming = false // Track if host is streaming tab audio

  // Store current audio state in case of reconnection
  if (localStorage.getItem('soundsync_current_audio')) {
    currentAudioSource = localStorage.getItem('soundsync_current_audio')
  }

  // Add WebAudio API context for precision timing
  let audioContext
  let audioSource
  let syncController

  // Higher precision sync settings
  const SYNC_INTERVAL = 200 // More frequent updates (ms)
  const SYNC_THRESHOLD_TIGHT = 0.05 // 50ms threshold for tight sync
  const MAX_PLAYBACK_RATE = 1.15 // Allow more aggressive rate adjustment
  const MIN_PLAYBACK_RATE = 0.85

  // Audio streaming variables
  let mediaStream = null
  let mediaRecorder = null
  let streamProcessor = null
  let clientAudioContext = null
  let clientAudioSource = null
  let clientStreamProcessor = null

  // Add streaming buffer variables
  let audioStreamBuffer = [] // Buffer for incoming audio chunks
  let isBuffering = false // Track if we're in buffering mode
  const STREAM_BUFFER_SIZE = 5 // Number of chunks to buffer before playing
  const MAX_STREAM_BUFFER = 15 // Maximum buffer size to prevent memory issues

  // Initialize audio context when user interacts
  function initAudioContext() {
    if (audioContext) return // Already initialized

    try {
      // Create audio context with best available options
      const AudioContext = window.AudioContext || window.webkitAudioContext
      audioContext = new AudioContext({
        latencyHint: 'interactive',
      })

      console.log(
        'Audio context initialized, sample rate:',
        audioContext.sampleRate
      )

      // Resume context if suspended (important for iOS/Safari)
      if (audioContext.state === 'suspended') {
        audioContext
          .resume()
          .then(() => {
            console.log('AudioContext resumed successfully')
          })
          .catch((err) => {
            console.error('Failed to resume AudioContext:', err)
          })
      }

      // Create a sync controller for precision timing
      syncController = new SyncController(audioContext)

      // Connect audio player if it exists and has a source
      if (audioPlayer && audioPlayer.src) {
        connectAudioElement()
      }
    } catch (e) {
      console.error('Could not create audio context:', e)
    }
  }

  // Function to connect audio element to WebAudio context
  function connectAudioElement() {
    if (!audioContext || !syncController) return

    try {
      console.log('Connecting audio element to WebAudio API')
      syncController.connect(audioPlayer)
    } catch (e) {
      console.error('Error connecting audio element:', e)
    }
  }

  // Initialize audio on first interaction
  const initAudioOnInteraction = () => {
    console.log('User interaction detected, initializing audio context')
    initAudioContext()
    // Remove listeners after first interaction
    document.body.removeEventListener('click', initAudioOnInteraction)
    document.body.removeEventListener('touchstart', initAudioOnInteraction)
  }

  // Handle user interaction to initialize audio context
  document.body.addEventListener('click', initAudioOnInteraction)
  document.body.addEventListener('touchstart', initAudioOnInteraction)

  // Connect audio player once loaded
  audioPlayer.addEventListener('loadeddata', () => {
    console.log('Audio element loaded data, connecting to context')
    // Make sure audio context is ready
    initAudioContext()
    // Connect element to context
    connectAudioElement()
  })

  // SyncController class for precise audio synchronization
  class SyncController {
    constructor(context) {
      this.context = context
      this.syncOffset = 0
      this.lastSyncTime = 0
      this.syncData = []
      this.frameId = null
      this.connected = false
    }

    // Connect to an audio element for precise control
    connect(audioElement) {
      if (!this.context) return this

      try {
        // If already connected, disconnect first
        if (this.connected && this.source) {
          console.log('Disconnecting existing audio source')
          this.source.disconnect()
        }

        // Create media element source from audio element
        console.log('Creating media element source for audio element')
        this.source = this.context.createMediaElementSource(audioElement)

        // Connect to destination (speakers)
        this.source.connect(this.context.destination)
        this.connected = true
        console.log('Successfully connected audio to WebAudio API')

        // Start animation frame loop for precise timing
        this.startSyncLoop()
      } catch (e) {
        console.error('Error connecting audio element to WebAudio API:', e)

        // If already connected by another process, just set connected flag
        if (e.message && e.message.includes('already connected')) {
          console.log(
            'Audio element already connected to context, continuing...'
          )
          this.connected = true
          this.startSyncLoop()
        }
      }

      return this
    }

    // Start the high-precision sync loop using requestAnimationFrame
    startSyncLoop() {
      if (this.frameId) {
        console.log('Sync loop already running')
        return
      }

      console.log('Starting sync loop for precision timing')
      const syncLoop = () => {
        this.applyPrecisionSync()
        this.frameId = requestAnimationFrame(syncLoop)
      }

      this.frameId = requestAnimationFrame(syncLoop)
    }

    // Stop the sync loop
    stopSyncLoop() {
      if (this.frameId) {
        console.log('Stopping sync loop')
        cancelAnimationFrame(this.frameId)
        this.frameId = null
      }
    }

    // Update with new target time from host
    updateSyncTarget(targetTime, networkLatency) {
      const now = this.context.currentTime

      // Log sync update
      console.log(
        `Sync update - Target: ${targetTime.toFixed(
          3
        )}s, Latency: ${networkLatency}ms`
      )

      // Add to sync data window (keep last 5 points)
      this.syncData.push({
        localTime: now,
        targetTime,
        networkLatency,
      })

      // Keep only the last 5 data points for smoothing
      if (this.syncData.length > 5) {
        this.syncData.shift()
      }

      // Calculate median offset for stability
      const offsets = this.syncData.map((data) => {
        // Convert network latency from ms to seconds
        const latencySeconds = data.networkLatency / 1000
        return (
          data.targetTime +
          latencySeconds -
          (data.localTime - (now - data.localTime))
        )
      })

      // Sort offsets and take the median value
      offsets.sort((a, b) => a - b)
      this.syncOffset = offsets[Math.floor(offsets.length / 2)]

      console.log(`Calculated sync offset: ${this.syncOffset.toFixed(3)}s`)
      this.lastSyncTime = now
    }

    // Apply precision sync using animation frame timing
    applyPrecisionSync() {
      if (
        !audioPlayer ||
        !audioPlayer.src ||
        audioPlayer.paused ||
        audioPlayer.ended ||
        !this.connected
      ) {
        return
      }

      // Current precise time
      const now = this.context.currentTime

      // Only apply micro-adjustments when actively playing and synced recently
      if (now - this.lastSyncTime < 5) {
        // Only sync if we received data in last 5 seconds

        // Current vs expected position
        const currentTime = audioPlayer.currentTime
        const expectedTime = currentTime + this.syncOffset
        const diff = Math.abs(currentTime - expectedTime)

        // For very small differences, use playbackRate for smooth correction
        if (diff < 0.3) {
          // Use a gentler correction for smoother playback
          // Reduce the correction factor from 0.25 to 0.1 for smoother changes
          const correction =
            1.0 +
            Math.sign(expectedTime - currentTime) * Math.min(diff * 0.1, 0.05)

          // Use narrower playback rate range for smoother audio
          const smootherMaxRate = 1.05
          const smootherMinRate = 0.95

          // Clamp to gentler playback rate range
          audioPlayer.playbackRate = Math.max(
            smootherMinRate,
            Math.min(smootherMaxRate, correction)
          )
        }
        // For medium differences, use a more gradual seek approach
        else if (diff > SYNC_THRESHOLD_TIGHT && diff < 0.5) {
          // Instead of immediate seeking, adjust slightly more aggressively
          const correction =
            1.0 +
            Math.sign(expectedTime - currentTime) * Math.min(diff * 0.2, 0.1)

          audioPlayer.playbackRate = Math.max(
            MIN_PLAYBACK_RATE,
            Math.min(MAX_PLAYBACK_RATE, correction)
          )

          console.log(
            `Medium sync diff (${diff.toFixed(
              3
            )}s), using rate ${correction.toFixed(3)}`
          )
        }
        // Only for large differences, seek directly
        else if (diff >= 0.5) {
          console.log(
            `Large sync difference (${diff.toFixed(
              3
            )}s), seeking to ${expectedTime.toFixed(3)}s`
          )
          audioPlayer.currentTime = expectedTime
        }
      } else {
        // Reset playback rate if we haven't synced recently
        audioPlayer.playbackRate = 1.0
      }
    }
  }

  // Enhanced time sync from host
  socket.on('audio-time-update', (data) => {
    if (!isHost && audioPlayer.readyState >= 2) {
      // Update our stored latency value if provided
      if (data.latency !== undefined) {
        networkLatency = data.latency
      }

      // If using WebAudio precision timing
      if (audioContext && syncController && !isSyncingTime) {
        syncController.updateSyncTarget(data.currentTime, networkLatency)
        return // Let the precision system handle it
      }

      // Rest of the existing sync code as fallback...
      // Calculate time difference with the host, accounting for network delay
      let hostTime = data.currentTime

      // More accurate latency adjustment
      if (data.serverTimestamp && data.clientTimestamp) {
        // Calculate how long the message took to get from host → server → client
        const serverDelay = data.serverTimestamp - data.clientTimestamp

        // Adjust the host time by adding the calculated delay
        hostTime += (serverDelay + networkLatency) / 1000 // Convert ms to seconds
      } else if (networkLatency > 0) {
        // Simpler fallback using just the measured latency
        hostTime += networkLatency / 1000
      }

      const timeDiff = audioPlayer.currentTime - hostTime
      const absDiff = Math.abs(timeDiff)

      // Existing sync code with tighter thresholds
      // ...
    }
  })

  // Setup more frequent sync for host
  function setupPrecisionSync() {
    if (isHost) {
      // Set up very frequent sync updates
      setInterval(() => {
        if (audioPlayer.paused || audioPlayer.ended || !audioPlayer.duration)
          return

        socket.emit('audio-time-update', {
          currentTime: audioPlayer.currentTime,
          clientTimestamp: Date.now(),
          precision: true,
        })
      }, SYNC_INTERVAL)
    }
  }

  // Set up precision sync when becoming host
  socket.on('host-status', (data) => {
    isHost = data.isHost

    // Store host status for reconnections
    localStorage.setItem('soundsync_was_host', isHost.toString())

    if (isHost) {
      roleStatus.textContent = 'Host'
      hostControls.classList.remove('hidden')
      clientMessage.classList.add('hidden')

      // Enable controls for host
      if (audioPlayer) {
        audioPlayer.controls = true
        // Remove any "controls locked" message if it exists
        const lockMessage = document.querySelector('.controls-locked')
        if (lockMessage) {
          lockMessage.remove()
        }
      }

      // Clean up client-side streaming
      if (clientStreamProcessor) {
        clientStreamProcessor.disconnect()
        clientStreamProcessor = null
      }

      if (clientAudioContext) {
        clientAudioContext
          .close()
          .catch((e) => console.error('Error closing client audio context:', e))
        clientAudioContext = null
      }

      // Set up precision sync as host
      setupPrecisionSync()
    } else {
      // If we were streaming as host, stop
      if (isStreaming) {
        stopTabAudioStream()
      }

      roleStatus.textContent = 'Client'
      hostControls.classList.add('hidden')
      clientMessage.classList.remove('hidden')

      // Check if we previously accepted audio
      audioAccepted =
        localStorage.getItem('soundsync_audio_accepted') === 'true'

      if (!audioAccepted) {
        // Hide audio accept container until needed
        acceptAudioContainer.classList.add('hidden')
      } else {
        // Already accepted, show status
        clientStatus.textContent = 'Audio accepted - waiting for host to play'
      }

      // Hide player until needed for clients
      playerContainer.classList.add('hidden')

      // Disable controls for clients
      if (audioPlayer) {
        audioPlayer.controls = false
      }
    }

    // For YouTube handling
    if (youtubePlayer) {
      closeYouTubePlayer()
    }
  })

  // Accept Audio button click handler
  acceptAudioButton.addEventListener('click', function () {
    audioAccepted = true
    localStorage.setItem('soundsync_audio_accepted', 'true')
    acceptAudioContainer.classList.add('hidden')
    clientStatus.textContent = 'Audio accepted - connecting to host audio...'

    // Initialize audio context immediately on user interaction (important for iOS/Safari)
    initAudioContext()

    // Also initialize client audio context for tab streaming if not already created
    if (!clientAudioContext) {
      clientAudioContext = new (window.AudioContext ||
        window.webkitAudioContext)()

      // Resume context immediately while we have user gesture
      if (clientAudioContext.state === 'suspended') {
        clientAudioContext
          .resume()
          .then(() => {
            console.log('Client audio context resumed successfully')
          })
          .catch((err) => {
            console.error('Failed to resume client audio context:', err)
          })
      }
    }

    // If we already have audio waiting to be played
    if (currentAudioSource) {
      // Show loading indicator
      loadingIndicator.classList.remove('hidden')
      clientStatus.textContent = 'Loading audio...'

      // Load audio and play
      preloadAndPlayHostAudio(currentAudioSource)
    } else {
      clientStatus.textContent = 'Waiting for host to play audio...'
    }
  })

  // Function to show accept audio prompt
  function showAcceptAudioPrompt() {
    if (!isHost && !audioAccepted) {
      acceptAudioContainer.classList.remove('hidden')
      // Auto-accept for testing if debug mode is enabled
      if (window.debugSync) {
        console.log('Debug mode: auto-accepting audio')
        setTimeout(() => acceptAudioButton.click(), 500)
      }
    }
  }

  // Handle audio control events from host
  socket.on('audio-control', (data) => {
    if (!isHost) {
      // Always store the current source
      if (data.fileUrl) {
        currentAudioSource = data.fileUrl
        localStorage.setItem('soundsync_current_audio', data.fileUrl)
      }

      // If audio hasn't been accepted yet, show prompt
      if (!audioAccepted) {
        showAcceptAudioPrompt()
        return // Don't process commands until audio is accepted
      }

      switch (data.action) {
        case 'play':
          if (data.fileUrl) {
            clientStatus.textContent = 'Loading audio file...'
            loadingIndicator.classList.remove('hidden')

            // Preload and play the audio sent by host
            preloadAndPlayHostAudio(data.fileUrl, data.time)
          } else if (audioPlayer.src) {
            // Just play existing audio using native method
            audioPlayer.play().catch((error) => {
              console.error('Error playing audio:', error)
              showManualPlayButton()
            })
          }
          break
        case 'pause':
          // Use the native pause method
          audioPlayer.pause()
          break
        case 'seek':
          audioPlayer.currentTime = data.time
          // If we're supposed to be playing, make sure we're playing
          if (!audioPlayer.paused) {
            audioPlayer.play().catch(() => {
              console.log('Auto-resume after seek failed - browser policy')
            })
          }
          break
      }
    }
  })

  // Preload and play audio from host command
  function preloadAndPlayHostAudio(url, startTime) {
    console.log(
      `Loading audio from URL: ${url}, starting at: ${startTime || 0}s`
    )

    // Make audio player visible
    playerContainer.classList.remove('hidden')

    // Ensure audio context is initialized
    initAudioContext()

    // Set source directly first
    audioPlayer.src = url
    audioPlayer.load()

    // On iOS/Safari, we need to play as a direct result of user interaction
    // Try to play immediately in case we're in a user-gesture context
    if (window.debugSync) {
      console.log('Debug: trying immediate play')
      audioPlayer
        .play()
        .catch((e) =>
          console.log('Initial auto-play failed (expected):', e.message)
        )
    }

    // Define minimum buffer before playing
    const MIN_BUFFER_TIME_MS = 1500 // Wait at least 1.5 seconds before playing
    const MIN_BUFFER_SECONDS = 3 // Try to buffer at least 3 seconds of audio
    const bufferingStartTime = Date.now()

    // Show buffer progress
    const loadingInterval = setInterval(() => {
      try {
        const buffered = audioPlayer.buffered
        if (buffered.length > 0) {
          // Calculate how much has been buffered
          const bufferedEnd = buffered.end(buffered.length - 1)
          const duration = audioPlayer.duration || 1
          const percentLoaded = Math.min(
            100,
            Math.round((bufferedEnd / duration) * 100)
          )

          // Update UI with loading progress
          clientStatus.textContent = `Loading audio: ${percentLoaded}%`

          // Calculate buffer time to ensure smooth playback
          const bufferWaitTime = Date.now() - bufferingStartTime
          const hasMinimumBuffer = bufferWaitTime >= MIN_BUFFER_TIME_MS
          const hasEnoughData =
            (startTime && bufferedEnd >= startTime + MIN_BUFFER_SECONDS) ||
            bufferedEnd >= (startTime || 0) + MIN_BUFFER_SECONDS

          // If we've buffered enough or the entire file, proceed
          if ((percentLoaded >= 99 || hasEnoughData) && hasMinimumBuffer) {
            clearInterval(loadingInterval)
            finishLoading()
          }
        }
      } catch (e) {
        console.error('Error checking buffer:', e)
      }
    }, 200)

    // Events for completion
    audioPlayer.oncanplaythrough = () => {
      // Don't clear the interval immediately - ensure minimum buffer time
      const bufferWaitTime = Date.now() - bufferingStartTime
      if (bufferWaitTime >= MIN_BUFFER_TIME_MS) {
        clearInterval(loadingInterval)
        console.log('Audio can play through, ready to start')
        finishLoading()
      } else {
        console.log('Can play through but waiting for minimum buffer time')
        // Will be handled by the interval
      }
    }

    // Handle errors
    audioPlayer.onerror = (e) => {
      clearInterval(loadingInterval)
      console.error('Audio error:', audioPlayer.error)
      clientStatus.textContent = 'Error loading audio. Try again.'
      loadingIndicator.classList.add('hidden')

      // Show retry button
      const retryButton = document.createElement('button')
      retryButton.textContent = 'Retry'
      retryButton.className = 'play-button'
      retryButton.onclick = () => {
        retryButton.remove()
        preloadAndPlayHostAudio(url, startTime)
      }
      clientMessage.appendChild(retryButton)
    }

    // Function to finish loading and start playback
    function finishLoading() {
      // Set initial time position if provided
      if (startTime) {
        console.log(`Setting initial time position to ${startTime}s`)
        audioPlayer.currentTime = startTime
      }

      // Update UI
      clientStatus.textContent = 'Audio ready - playing'
      loadingIndicator.classList.add('hidden')

      // Disable controls for clients
      audioPlayer.controls = false

      // Create a visual indicator that controls are locked
      if (!document.querySelector('.controls-locked')) {
        const lockMessage = document.createElement('div')
        lockMessage.className = 'controls-locked'
        lockMessage.textContent = 'Playback controlled by host'
        playerContainer.appendChild(lockMessage)
      }

      // Play using native method with multiple attempts
      console.log('Attempting to play audio...')
      const playAttempt = audioPlayer.play()

      if (playAttempt) {
        playAttempt
          .then(() => {
            console.log('Audio playback started successfully')
            clientStatus.textContent = 'Playing audio'

            // Set a slightly higher volume for better audio perception
            audioPlayer.volume = 0.85
          })
          .catch((error) => {
            console.error('Audio playback blocked:', error)
            clientStatus.textContent =
              'Playback blocked by browser. Click to play.'
            showManualPlayButton()
          })
      } else {
        // Old browsers might not return a promise
        console.log(
          'Browser did not return play promise, assuming playback started'
        )
        clientStatus.textContent = 'Playing audio'
      }
    }
  }

  // Helper function to show manual play button
  function showManualPlayButton() {
    // Add play button if not already present
    if (!document.querySelector('.manual-play-button')) {
      const playButton = document.createElement('button')
      playButton.textContent = 'Play Audio'
      playButton.className = 'play-button manual-play-button'
      playButton.onclick = () => {
        audioPlayer
          .play()
          .then(() => {
            playButton.remove()
            clientStatus.textContent = 'Playing audio'
          })
          .catch((e) => console.error('Manual play failed:', e))
      }
      clientMessage.appendChild(playButton)
    }
  }

  // Add keyboard event listeners to block client keyboard controls
  document.addEventListener('keydown', (event) => {
    // Block space bar (play/pause) and media keys for clients
    if (
      !isHost &&
      (event.code === 'Space' ||
        event.code === 'MediaPlayPause' ||
        event.code === 'MediaPlay' ||
        event.code === 'MediaPause')
    ) {
      event.preventDefault()
      return false
    }
  })

  // Connect to Socket.IO server
  socket.on('connect', () => {
    connectionStatus.textContent = 'Connected'
    connectionStatus.style.color = 'green'

    // Add current user to the list
    users[socket.id] = {
      id: socket.id,
      sessionId,
      isHost: false,
    }

    // Reset network info display
    networkIdElement.textContent = 'Detecting network...'
    networkUsersElement.textContent = '1' // At least yourself

    // Update room status
    if (currentRoomCode) {
      roomStatus.textContent = `Reconnecting to room...`
    } else {
      roomStatus.textContent = 'Not in a room'
    }

    // Try to initialize audio context early
    initAudioContext()

    // Restore audio player state after reconnection if we were playing something
    if (isHost && currentAudioSource) {
      const lastPosition = parseFloat(
        localStorage.getItem('soundsync_audio_position') || '0'
      )
      if (currentAudioSource && lastPosition) {
        audioPlayer.src = currentAudioSource
        playerContainer.classList.remove('hidden')

        // Wait for metadata to load before seeking
        audioPlayer.onloadedmetadata = () => {
          audioPlayer.currentTime = lastPosition

          // Notify others about our current audio
          socket.emit('audio-control', {
            action: 'play',
            fileUrl: currentAudioSource,
            time: lastPosition,
          })
        }
      }
    } else if (!isHost && audioAccepted && currentAudioSource) {
      // If client has already accepted audio, try to restore it
      clientStatus.textContent = 'Reconnected - restoring audio...'
      setTimeout(() => {
        preloadAndPlayHostAudio(currentAudioSource)
      }, 1000) // Slight delay to ensure connection is fully established
    }
  })

  // Network information received
  socket.on('network-info', (data) => {
    currentNetworkId = data.networkId

    // Update room code if received
    if (data.roomCode) {
      currentRoomCode = data.roomCode
      localStorage.setItem('soundsync_room_code', currentRoomCode)
      roomStatus.textContent = `In room:`
      roomCodeDisplay.textContent = currentRoomCode
      roomCodeDisplay.classList.remove('hidden')
    } else {
      roomStatus.textContent = 'Not in a room'
      roomCodeDisplay.classList.add('hidden')
      currentRoomCode = null
      localStorage.removeItem('soundsync_room_code')
    }

    // Update network display
    let networkDisplay = 'Network: '

    // Format the network ID to make it more user-friendly
    if (data.networkId === 'local-development') {
      networkDisplay += 'Local Development Environment'
    } else if (data.networkId.startsWith('unknown-')) {
      networkDisplay += 'Unknown Network'
    } else if (data.networkId.includes('.')) {
      // For IPv4, show first two parts
      networkDisplay += data.networkId.split('.').slice(0, 2).join('.') + '.*.*'
    } else {
      // For IPv6, show abbreviated version
      networkDisplay += data.networkId.substring(0, 12) + '...'
    }

    networkIdElement.textContent = networkDisplay
    networkUsersElement.textContent = data.userCount || 1

    // Show a friendly message based on the network/room
    if (data.networkId === 'local-development') {
      networkIdElement.innerHTML +=
        ' <span class="same-network">(Local testing)</span>'
    } else if (data.roomCode) {
      networkIdElement.innerHTML +=
        ' <span class="same-network">(In Room)</span>'
    }

    // Room creation response
    socket.on('room-created', (data) => {
      if (data.roomCode) {
        currentRoomCode = data.roomCode
        localStorage.setItem('soundsync_room_code', currentRoomCode)

        roomStatus.textContent = `Room created:`
        roomCodeDisplay.textContent = currentRoomCode
        roomCodeDisplay.classList.remove('hidden')

        // Update host status
        if (data.isHost) {
          isHost = true
          localStorage.setItem('soundsync_was_host', 'true')
          roleStatus.textContent = 'Role: Host'
          hostControls.classList.remove('hidden')
          clientMessage.classList.add('hidden')
        }

        connectionStatus.textContent = 'Connected'
      }
    })

    // Room join response
    socket.on('room-join-result', (data) => {
      if (data.success) {
        currentRoomCode = data.roomCode
        localStorage.setItem('soundsync_room_code', currentRoomCode)

        roomStatus.textContent = `Joined room:`
        roomCodeDisplay.textContent = currentRoomCode
        roomCodeDisplay.classList.remove('hidden')

        // Reset host status
        isHost = false
        localStorage.setItem('soundsync_was_host', 'false')

        connectionStatus.textContent = 'Connected'
        roomCodeInput.value = ''
      } else {
        alert(`Failed to join room: ${data.error || 'Room not found'}`)
        connectionStatus.textContent = 'Connected'
      }
    })
  })

  // Users list update received
  socket.on('users-update', (data) => {
    // Update flag for network status
    onSameNetwork = data.sameNetwork

    // Update user count
    networkUsersElement.textContent = data.users.length

    // Save the users for our UI
    updateUsersList(data.users)
  })

  // Network latency measurement
  socket.on('ping', (data) => {
    // Respond immediately to calculate round-trip time
    socket.emit('pong', data)
  })

  // Handle disconnect
  socket.on('disconnect', () => {
    connectionStatus.textContent = 'Disconnected'
    connectionStatus.style.color = 'red'

    // Clean up streaming resources if disconnected
    if (isStreaming) {
      stopTabAudioStream()
    }

    // Clean up client streaming
    if (clientStreamProcessor) {
      clientStreamProcessor.disconnect()
      clientStreamProcessor = null
    }

    if (clientAudioContext) {
      clientAudioContext
        .close()
        .catch((e) => console.error('Error closing client audio context:', e))
      clientAudioContext = null
    }
  })

  // Audio player events - ensure only host can control
  audioPlayer.addEventListener('play', () => {
    if (isHost) {
      socket.emit('audio-control', { action: 'play' })
    } else if (!audioAccepted) {
      // If client tries to play before accepting
      audioPlayer.pause()
      showAcceptAudioPrompt()
    }
  })

  audioPlayer.addEventListener('pause', () => {
    if (isHost) {
      socket.emit('audio-control', { action: 'pause' })
    }
  })

  audioPlayer.addEventListener('seeked', () => {
    if (isHost) {
      socket.emit('audio-control', {
        action: 'seek',
        time: audioPlayer.currentTime,
      })
    }
  })

  // File input change (for host)
  audioFileInput.addEventListener('change', async (e) => {
    if (!isHost || !e.target.files.length) return

    const file = e.target.files[0]
    console.log(`Host selected file: ${file.name}, size: ${file.size} bytes`)

    // Check file size (limit to 15MB)
    const MAX_FILE_SIZE = 15 * 1024 * 1024 // 15MB
    if (file.size > MAX_FILE_SIZE) {
      alert('File is too large. Please select an audio file smaller than 15MB.')
      return
    }

    // Show loading message
    connectionStatus.textContent = 'Uploading audio...'

    try {
      // Read file as data URL (base64)
      console.log('Reading file as data URL...')
      const audioData = await readFileAsDataURL(file)

      // Upload file to server
      console.log('Uploading file to server...')
      const response = await fetch('/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audioData,
          fileName: file.name,
        }),
      })

      const result = await response.json()

      if (result.success) {
        console.log(`File uploaded successfully: ${result.fileUrl}`)
        // Set audio source for host
        audioPlayer.src = result.fileUrl
        playerContainer.classList.remove('hidden')

        // Remember current audio
        currentAudioSource = result.fileUrl
        localStorage.setItem('soundsync_current_audio', result.fileUrl)

        // Play on host side
        audioPlayer
          .play()
          .then(() => {
            console.log('Host playback started')
          })
          .catch((error) => {
            console.error('Host playback failed:', error)
            alert('Please click play to start audio')
          })

        // Send the file URL to all clients
        console.log('Notifying clients about new audio')
        socket.emit('audio-control', {
          action: 'play',
          fileUrl: result.fileUrl,
          fileName: file.name,
        })

        connectionStatus.textContent = 'Connected'
      } else {
        throw new Error(result.error || 'Upload failed')
      }
    } catch (error) {
      console.error('Error uploading audio:', error)
      connectionStatus.textContent = 'Error uploading audio'
      setTimeout(() => {
        connectionStatus.textContent = 'Connected'
      }, 3000)
    }
  })

  // Read file as data URL
  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  }

  // Generate a random session ID
  function generateSessionId() {
    return (
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15)
    )
  }

  // Format time for display
  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`
  }

  // Update time displays and progress bar
  audioPlayer.addEventListener('timeupdate', () => {
    const currentTime = audioPlayer.currentTime
    const duration = audioPlayer.duration || 0

    // Save current position for reconnection
    if (isHost && currentAudioSource) {
      localStorage.setItem('soundsync_audio_position', currentTime.toString())
    }

    // Update progress bar
    const progressPercent = (currentTime / duration) * 100
    progressBar.style.width = `${progressPercent}%`

    // Update time displays
    currentTimeDisplay.textContent = formatTime(currentTime)
    durationDisplay.textContent = formatTime(duration)

    // If host, send time updates frequently for tighter sync
    if (isHost) {
      // Send update every 500ms for tighter sync
      if (!audioPlayer.paused && Math.floor(currentTime * 2) % 1 === 0) {
        socket.emit('audio-time-update', {
          currentTime,
          clientTimestamp: Date.now(), // Include client timestamp for latency calculation
        })
      }
    }
  })

  // Update the users list display
  function updateUsersList(networkUsers) {
    usersList.innerHTML = ''

    if (!networkUsers || networkUsers.length === 0) {
      const li = document.createElement('li')
      li.textContent = 'No other users connected to your network'
      li.className = 'no-users'
      usersList.appendChild(li)
      return
    }

    networkUsers.forEach((user) => {
      const li = document.createElement('li')

      // Create user display with IP suffix for identification
      let userDisplay = `User ${user.id.substring(0, 6)}...`

      if (user.ipSuffix) {
        userDisplay += ` (IP: ...${user.ipSuffix})`
      }

      if (user.isHost) {
        userDisplay += ' (Host)'
        li.className = 'host-user'
      }

      if (user.id === sessionId) {
        userDisplay += ' (You)'
        li.className += ' current-user'
      }

      // Create a text span for the user display
      const textSpan = document.createElement('span')
      textSpan.textContent = userDisplay
      li.appendChild(textSpan)

      // Add transfer host button if the current user is host and this is another user
      if (isHost && user.id !== sessionId) {
        const transferButton = document.createElement('button')
        transferButton.textContent = 'Make Host'
        transferButton.className = 'transfer-host-button'
        transferButton.addEventListener('click', () => {
          transferHostTo(user.id)
        })
        li.appendChild(transferButton)
      }

      usersList.appendChild(li)
    })
  }

  // Function to transfer host status to another user
  function transferHostTo(userId) {
    if (!isHost) return // Only the host can transfer host status

    if (
      confirm(
        `Are you sure you want to transfer host control to User ${userId.substring(
          0,
          6
        )}...?`
      )
    ) {
      console.log(`Transferring host status to ${userId}`)

      // Notify server about host transfer
      socket.emit('transfer-host', { newHostId: userId })

      // Show transfer in progress
      connectionStatus.textContent = 'Transferring host status...'
    }
  }

  // Listen for host transfer result
  socket.on('host-transfer-result', (data) => {
    if (data.success) {
      // If this was initiated by us (previous host)
      if (data.previousHostId === sessionId) {
        alert('Host status transferred successfully')
        connectionStatus.textContent = 'Connected'
      }

      // If this is a broadcast to all users, the host-status event
      // will handle updating UI appropriately
    } else {
      if (data.previousHostId === sessionId) {
        alert(
          `Failed to transfer host status: ${data.error || 'Unknown error'}`
        )
        connectionStatus.textContent = 'Connected'
      }
    }
  })

  // Define a getter for the playing state
  Object.defineProperty(HTMLMediaElement.prototype, 'playing', {
    get: function () {
      return !!(
        this.currentTime > 0 &&
        !this.paused &&
        !this.ended &&
        this.readyState > 2
      )
    },
  })

  // Enable debug mode with URL parameter ?debug=1
  window.debugSync = new URLSearchParams(window.location.search).has('debug')

  // Show latency info if debugging
  if (window.debugSync) {
    // Create debug display
    const debugDiv = document.createElement('div')
    debugDiv.className = 'debug-info'
    debugDiv.innerHTML = '<h3>Debug Info</h3><div id="debug-content"></div>'
    document.querySelector('.container').appendChild(debugDiv)

    // Update debug info periodically
    setInterval(() => {
      if (document.getElementById('debug-content')) {
        document.getElementById('debug-content').innerHTML = `
          <p>Network Latency: ${networkLatency}ms</p>
          <p>PlaybackRate: ${audioPlayer.playbackRate.toFixed(2)}</p>
          <p>Syncing: ${isSyncingTime ? 'Yes' : 'No'}</p>
        `
      }
    }, 500)
  }

  // Tab Stream Controls
  streamTabButton.addEventListener('click', startTabAudioStream)
  stopStreamingButton.addEventListener('click', stopTabAudioStream)

  // Add YouTube sync controls
  const youtubeUrlInput = document.createElement('input')
  youtubeUrlInput.type = 'text'
  youtubeUrlInput.placeholder = 'Enter YouTube URL'
  youtubeUrlInput.className = 'youtube-url-input'

  const syncYoutubeButton = document.createElement('button')
  syncYoutubeButton.textContent = 'Sync YouTube'
  syncYoutubeButton.className = 'control-button'
  syncYoutubeButton.id = 'sync-youtube-button'

  // Add YouTube elements to host controls
  hostControls.appendChild(document.createElement('br'))
  hostControls.appendChild(document.createElement('br'))
  const youtubeLabel = document.createElement('div')
  youtubeLabel.textContent = 'YouTube Sync:'
  youtubeLabel.className = 'control-label'
  hostControls.appendChild(youtubeLabel)
  hostControls.appendChild(youtubeUrlInput)
  hostControls.appendChild(syncYoutubeButton)

  // YouTube player containers
  const youtubeContainer = document.createElement('div')
  youtubeContainer.id = 'youtube-container'
  youtubeContainer.className = 'hidden'
  document.querySelector('.container').appendChild(youtubeContainer)

  let youtubePlayer = null
  let isYoutubeReady = false
  let youtubeSyncing = false

  // Load YouTube API
  function loadYouTubeAPI() {
    if (window.YT) return Promise.resolve() // Already loaded

    return new Promise((resolve) => {
      // Create script tag
      const tag = document.createElement('script')
      tag.src = 'https://www.youtube.com/iframe_api'
      const firstScriptTag = document.getElementsByTagName('script')[0]
      firstScriptTag.parentNode.insertBefore(tag, firstScriptTag)

      // When API is ready
      window.onYouTubeIframeAPIReady = function () {
        console.log('YouTube API loaded')
        isYoutubeReady = true
        resolve()
      }
    })
  }

  // Initialize YouTube player
  function initYouTubePlayer(videoId, startTime = 0, startMuted = false) {
    return new Promise((resolve, reject) => {
      if (!isYoutubeReady) {
        reject(new Error('YouTube API not ready'))
        return
      }

      // Create player container if needed
      let playerDiv = document.getElementById('youtube-player')
      if (!playerDiv) {
        playerDiv = document.createElement('div')
        playerDiv.id = 'youtube-player'
        youtubeContainer.appendChild(playerDiv)
      }

      // If player exists, destroy it
      if (youtubePlayer) {
        youtubePlayer.destroy()
      }

      // Track last time we received a sync update
      window.lastYouTubeSyncData = {
        localTimestamp: Date.now(),
        hostTime: startTime,
        predictedTime: startTime,
      }

      // Create new player with updated options
      youtubePlayer = new YT.Player('youtube-player', {
        height: '360',
        width: '640',
        videoId: videoId,
        playerVars: {
          start: Math.floor(startTime),
          autoplay: 1,
          mute: startMuted ? 1 : 0, // Start muted if requested (for clients to bypass autoplay)
          controls: isHost ? 1 : 0, // Only host can control
          rel: 0,
          fs: 1,
          modestbranding: 1,
          playsinline: 1, // Important for mobile autoplay
        },
        events: {
          onReady: (event) => {
            console.log('YouTube player ready')
            youtubeContainer.classList.remove('hidden')

            // Hide audio player when YouTube is active
            playerContainer.classList.add('hidden')

            // Ensure video plays (sometimes needed for client autoplay)
            event.target.playVideo()

            if (isHost) {
              // Start sending sync updates for YouTube
              startYouTubeSyncing()
            } else {
              // Disable controls for clients
              event.target.getIframe().style.pointerEvents = 'none'

              // Add overlay explanation
              const controlsLockedMsg = document.createElement('div')
              controlsLockedMsg.className = 'controls-locked youtube-locked'
              controlsLockedMsg.textContent = 'Playback controlled by host'
              youtubeContainer.appendChild(controlsLockedMsg)

              // Start predictive sync for clients
              if (!window.youtubePredictiveSync) {
                startPredictiveYouTubeSync()
              }
            }

            resolve(event.target)
          },
          onStateChange: (event) => {
            // If video fails to play on client, try again
            if (!isHost && event.data === YT.PlayerState.CUED) {
              console.log('Video cued but not playing, trying to play...')
              setTimeout(() => {
                event.target.playVideo()
              }, 500)
            }

            if (isHost) {
              // When host changes state, tell clients
              if (
                event.data === YT.PlayerState.PLAYING ||
                event.data === YT.PlayerState.PAUSED
              ) {
                socket.emit('youtube-state-change', {
                  state: event.data,
                  time: youtubePlayer.getCurrentTime(),
                })
              }
            }
          },
          onError: (event) => {
            console.error('YouTube player error:', event.data)
            reject(new Error(`YouTube error code: ${event.data}`))
          },
        },
      })
    })
  }

  // Start predictive sync for YouTube (clients only)
  function startPredictiveYouTubeSync() {
    if (isHost || window.youtubePredictiveSync) return

    // Run micro-adjustments every 100ms to stay in sync
    window.youtubePredictiveSync = setInterval(() => {
      if (
        !youtubePlayer ||
        youtubePlayer.getPlayerState() !== YT.PlayerState.PLAYING
      )
        return

      const syncData = window.lastYouTubeSyncData
      if (!syncData) return

      // Calculate how much time has passed since our last sync
      const timeSinceSync = (Date.now() - syncData.localTimestamp) / 1000

      // Predict where the host should be now
      const predictedHostTime = syncData.hostTime + timeSinceSync

      // Get our current time
      const currentTime = youtubePlayer.getCurrentTime()

      // Calculate drift
      const drift = currentTime - predictedHostTime
      const absDrift = Math.abs(drift)

      // Store this prediction for next time
      syncData.predictedTime = predictedHostTime

      // For tiny drifts, do nothing (avoid unnecessary adjustments)
      if (absDrift < 0.1) return

      // For small drifts, adjust playback rate subtly
      if (absDrift < 0.5) {
        // If we're ahead, slow down slightly; if behind, speed up slightly
        const rate = drift > 0 ? 0.98 : 1.02
        youtubePlayer.setPlaybackRate(rate)

        // Log occasionally
        if (Math.random() < 0.1) {
          console.log(
            `Predictive sync: Adjusting rate ${rate} for drift ${drift.toFixed(
              3
            )}s`
          )
        }

        // Reset rate after a short time if we only need a brief correction
        setTimeout(() => {
          youtubePlayer.setPlaybackRate(1.0)
        }, 800)
      }
      // For moderate drifts that are getting worse, do a smooth seek
      else if (absDrift > 0.5 && absDrift < 2.0) {
        // Only seek if timing is critical or randomly to avoid constant seeking
        if (Math.random() < 0.2) {
          console.log(
            `Predictive sync: Seeking to fix drift of ${drift.toFixed(3)}s`
          )
          youtubePlayer.seekTo(predictedHostTime, true)
        }
      }
      // For large drifts, seek immediately
      else if (absDrift >= 2.0) {
        console.log(
          `Predictive sync: Emergency seek for drift of ${drift.toFixed(3)}s`
        )
        youtubePlayer.seekTo(predictedHostTime, true)
      }
    }, 100)

    console.log('Started predictive YouTube sync')
  }

  // Stop predictive sync
  function stopPredictiveYouTubeSync() {
    if (window.youtubePredictiveSync) {
      clearInterval(window.youtubePredictiveSync)
      window.youtubePredictiveSync = null
      console.log('Stopped predictive YouTube sync')
    }
  }

  // Close YouTube player (for both host and clients)
  function closeYouTubePlayer() {
    if (youtubePlayer) {
      youtubePlayer.stopVideo()
      youtubePlayer.destroy()
      youtubePlayer = null
    }

    youtubeContainer.classList.add('hidden')

    // Remove any overlays
    const overlays = youtubeContainer.querySelectorAll('.youtube-locked')
    overlays.forEach((overlay) => overlay.remove())

    // Show regular player again if we have audio
    if (currentAudioSource) {
      playerContainer.classList.remove('hidden')
    }

    // Stop syncing
    stopYouTubeSyncing()
    stopPredictiveYouTubeSync()
  }

  // Handle YouTube state change from host
  socket.on('youtube-state-change', (data) => {
    if (isHost || !youtubePlayer) return

    console.log('YouTube state change:', data)

    // Apply state change
    if (data.state === YT.PlayerState.PLAYING) {
      // Add network delay compensation
      const networkDelay = 0.5 // 500ms default compensation
      const targetTime = data.time + networkDelay

      // First seek to correct position
      youtubePlayer.seekTo(targetTime, true)

      // Then ensure video is playing after the seek completes
      setTimeout(() => {
        youtubePlayer.playVideo()

        // If currently muted, show the unmute button
        if (youtubePlayer.isMuted && youtubePlayer.isMuted()) {
          addUnmuteButton()
        }
      }, 200)
    } else if (data.state === YT.PlayerState.PAUSED) {
      youtubePlayer.pauseVideo()
    }
  })

  // Send YouTube sync updates to clients
  function startYouTubeSyncing() {
    if (!isHost || !youtubePlayer || youtubeSyncing) return

    youtubeSyncing = true

    // Send updates more frequently (200ms instead of 500ms) for ultra-tight sync
    const syncInterval = setInterval(() => {
      if (!youtubePlayer || !youtubeSyncing) {
        clearInterval(syncInterval)
        return
      }

      const playerState = youtubePlayer.getPlayerState()
      // Only send updates when playing
      if (playerState === YT.PlayerState.PLAYING) {
        socket.emit('youtube-time-update', {
          time: youtubePlayer.getCurrentTime(),
          timestamp: Date.now(),
          rate: youtubePlayer.getPlaybackRate(),
        })
      }
    }, 200) // Ultra-frequent updates for real-time sync

    // Store interval for cleanup
    window.youtubeSyncInterval = syncInterval
  }

  // Stop YouTube syncing
  function stopYouTubeSyncing() {
    youtubeSyncing = false
    if (window.youtubeSyncInterval) {
      clearInterval(window.youtubeSyncInterval)
      window.youtubeSyncInterval = null
    }
  }

  // Add a close button for YouTube
  const closeYoutubeButton = document.createElement('button')
  closeYoutubeButton.textContent = '×'
  closeYoutubeButton.className = 'close-youtube'
  closeYoutubeButton.title = 'Close YouTube player'
  youtubeContainer.appendChild(closeYoutubeButton)

  closeYoutubeButton.addEventListener('click', () => {
    if (isHost) {
      // Host broadcasts close to everyone
      socket.emit('youtube-close')
      closeYouTubePlayer()
    }
  })

  // Client handlers for YouTube sync

  // Receive YouTube sync from host
  socket.on('youtube-sync', async (data) => {
    if (isHost) return // Host doesn't need to receive their own sync

    console.log('Received YouTube sync:', data)

    try {
      // Show YouTube is loading
      clientStatus.textContent = 'Loading YouTube video...'

      // Load YouTube API if needed
      if (!isYoutubeReady) {
        await loadYouTubeAPI()
      }

      // Initialize player with the video ID
      // Start muted to bypass autoplay restrictions
      await initYouTubePlayer(data.videoId, 0, true)

      clientStatus.textContent = 'Playing YouTube video'

      // Add unmute button for clients
      addUnmuteButton()
    } catch (error) {
      console.error('Error playing YouTube:', error)
      clientStatus.textContent = 'Error loading YouTube'
    }
  })

  // Add unmute button for clients to bypass autoplay restrictions
  function addUnmuteButton() {
    // Only add if not already present
    if (document.querySelector('.unmute-button')) return

    const unmuteButton = document.createElement('button')
    unmuteButton.textContent = '🔇 Click to Unmute'
    unmuteButton.className = 'unmute-button'
    unmuteButton.addEventListener('click', () => {
      if (youtubePlayer) {
        youtubePlayer.unMute()
        youtubePlayer.setVolume(80) // Set to reasonable volume
        unmuteButton.remove()
      }
    })

    youtubeContainer.appendChild(unmuteButton)
  }

  // Extract YouTube video ID from URL
  function getYouTubeVideoId(url) {
    // Handle various YouTube URL formats
    let videoId = null
    const regexps = [
      /youtube\.com\/watch\?v=([^&]+)/,
      /youtube\.com\/embed\/([^?]+)/,
      /youtube\.com\/v\/([^?]+)/,
      /youtu\.be\/([^?]+)/,
    ]

    for (const regex of regexps) {
      const match = url.match(regex)
      if (match) {
        videoId = match[1]
        break
      }
    }

    return videoId
  }

  // Sync YouTube button click handler
  syncYoutubeButton.addEventListener('click', async () => {
    if (!isHost) return

    const youtubeUrl = youtubeUrlInput.value.trim()
    if (!youtubeUrl) {
      alert('Please enter a YouTube URL')
      return
    }

    const videoId = getYouTubeVideoId(youtubeUrl)
    if (!videoId) {
      alert('Invalid YouTube URL. Please enter a valid YouTube video URL.')
      return
    }

    try {
      connectionStatus.textContent = 'Loading YouTube...'

      // Load YouTube API if not already loaded
      if (!isYoutubeReady) {
        await loadYouTubeAPI()
      }

      // Initialize player for host
      await initYouTubePlayer(videoId)

      // Send to clients
      socket.emit('youtube-sync', {
        videoId: videoId,
        url: youtubeUrl,
      })

      connectionStatus.textContent = 'Connected'
    } catch (error) {
      console.error('Error syncing YouTube:', error)
      connectionStatus.textContent = 'YouTube sync error'

      setTimeout(() => {
        connectionStatus.textContent = 'Connected'
      }, 3000)
    }
  })

  // Start streaming audio from a browser tab
  async function startTabAudioStream() {
    if (isStreaming) return

    try {
      streamStatus.textContent = 'Requesting tab access...'

      // Check if getDisplayMedia is supported
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        throw new Error(
          'Your browser does not support screen capture. Try Chrome, Edge or Firefox.'
        )
      }

      // Request audio from a browser tab
      mediaStream = await navigator.mediaDevices
        .getDisplayMedia({
          video: { mandatory: { chromeMediaSource: 'tab' } },
          audio: true,
          preferCurrentTab: true, // For Chrome 113+
        })
        .catch(async (err) => {
          // Fallback for browsers that don't support tab-only capture
          console.log(
            'Tab-only capture not supported, falling back to full screen capture'
          )
          return await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          })
        })

      // Check if user canceled the prompt
      if (!mediaStream || !mediaStream.getAudioTracks().length) {
        streamStatus.textContent =
          'No audio track found. Make sure you select "Share audio" when choosing a tab.'
        return
      }

      // Create audio context if not already created
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)()
      }

      // Resume context if suspended (iOS/Safari)
      if (audioContext.state === 'suspended') {
        await audioContext.resume()
      }

      // Connect the stream to audio context
      audioSource = audioContext.createMediaStreamSource(mediaStream)

      // Get stream details
      const streamSettings = mediaStream.getAudioTracks()[0].getSettings()
      const tabDescription = getTabDescription(mediaStream)

      // Create script processor for handling audio data
      // Note: ScriptProcessorNode is deprecated but still has better browser support than AudioWorklet
      const bufferSize = 4096
      streamProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1)

      // Connect the processor
      audioSource.connect(streamProcessor)
      streamProcessor.connect(audioContext.destination)

      // Set up data handling
      streamProcessor.onaudioprocess = processAudioForStreaming

      // Update UI
      isStreaming = true
      streamTabButton.classList.add('hidden')
      stopStreamingButton.classList.remove('hidden')
      streamStatus.innerHTML = `
        <div class="streaming-active">
          <span class="streaming-indicator"></span>
          Streaming audio from: ${tabDescription}
          <div class="stream-info">Make sure audio is playing in your selected tab</div>
        </div>`

      // Notify server and clients
      socket.emit('tab-stream-start', {
        description: tabDescription,
        sampleRate: audioContext.sampleRate,
        channelCount: 1, // We're downmixing to mono for bandwidth
      })

      console.log('Tab audio streaming started:', {
        sampleRate: audioContext.sampleRate,
        channelCount: 1,
        tabDescription: tabDescription,
      })

      // Add listener for when sharing stops via browser UI
      mediaStream.getVideoTracks()[0].onended = () => {
        console.log('Screen sharing ended via browser UI')
        stopTabAudioStream()
      }
    } catch (error) {
      console.error('Error starting tab audio capture:', error)
      streamStatus.innerHTML = `
        <div class="error-message">
          Error: ${error.message || 'Could not access tab audio'}.
          <div>Make sure to select "Share audio" option when choosing a tab to share.</div>
        </div>`
    }
  }

  // Process audio data for streaming
  let lastStreamSendTime = 0
  function processAudioForStreaming(event) {
    if (!isStreaming) return

    // Throttle the send rate to avoid overloading the network
    const now = Date.now()
    if (now - lastStreamSendTime < 50) {
      // 50ms throttling (20 packets/second)
      return
    }
    lastStreamSendTime = now

    // Get audio data from input channel (downmix to mono if stereo)
    const inputBuffer = event.inputBuffer
    const leftChannel = inputBuffer.getChannelData(0)

    // Create a copy of the data - can't send the original buffer directly
    const audioData = leftChannel.slice(0)

    // Send the data to the server
    socket.emit('audio-stream', {
      audio: encodeAudioData(audioData),
      timestamp: now,
    })
  }

  // Helper function to get tab description from stream
  function getTabDescription(stream) {
    const videoTrack = stream.getVideoTracks()[0]
    const audioTrack = stream.getAudioTracks()[0]

    let description = 'Browser Tab'

    if (videoTrack && videoTrack.label) {
      description = videoTrack.label
    } else if (audioTrack && audioTrack.label) {
      description = audioTrack.label
    }

    return description
  }

  // Encode audio data for transmission (simple base64 encoding)
  function encodeAudioData(audioData) {
    // Convert to 16-bit PCM for smaller size
    const pcmData = new Int16Array(audioData.length)
    for (let i = 0; i < audioData.length; i++) {
      // Convert float32 to int16
      pcmData[i] = Math.max(-1, Math.min(1, audioData[i])) * 0x7fff
    }

    // Create binary string
    let binary = ''
    const bytes = new Uint8Array(pcmData.buffer)
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }

    // Return as base64 encoded string
    return btoa(binary)
  }

  // Stop tab audio streaming
  function stopTabAudioStream() {
    if (!isStreaming) return

    // Stop media tracks
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop())
    }

    // Disconnect audio processing
    if (streamProcessor && audioSource) {
      streamProcessor.onaudioprocess = null
      audioSource.disconnect()
      streamProcessor.disconnect()
    }

    // Reset state
    isStreaming = false
    mediaStream = null
    audioSource = null
    streamProcessor = null

    // Update UI
    streamTabButton.classList.remove('hidden')
    stopStreamingButton.classList.add('hidden')
    streamStatus.textContent = 'Audio streaming stopped'

    // Notify server and clients
    socket.emit('tab-stream-stop')

    console.log('Tab audio streaming stopped')
  }

  // CLIENT-SIDE STREAM HANDLING

  // Host is starting a tab audio stream
  socket.on('tab-stream-start', (data) => {
    if (isHost) return // Host doesn't need to receive their own stream

    console.log('Host started tab audio stream:', data)
    clientStatus.textContent = `Host is streaming audio from: ${data.description}`

    // Show player if it's hidden
    playerContainer.classList.remove('hidden')

    // Check if client has accepted audio permission
    if (!audioAccepted) {
      showAcceptAudioPrompt()
      return
    }

    // Initialize client-side audio context
    initClientStreamPlayback(data)
  })

  // Initialize client-side audio streaming playback
  function initClientStreamPlayback(streamData) {
    try {
      // Create audio context if needed
      if (!clientAudioContext) {
        clientAudioContext = new (window.AudioContext ||
          window.webkitAudioContext)()

        // Resume context if suspended (for iOS/Safari)
        if (clientAudioContext.state === 'suspended') {
          clientAudioContext.resume().catch((err) => {
            console.error('Failed to resume client audio context:', err)
          })
        }
      }

      // Add indicator for streaming
      const streamIndicator = document.createElement('div')
      streamIndicator.className = 'streaming-active'
      streamIndicator.innerHTML = `<span class="streaming-indicator"></span> Receiving audio stream: ${streamData.description}`

      // Add to player container
      if (!document.querySelector('.streaming-active')) {
        playerContainer.appendChild(streamIndicator)
      }

      console.log('Client stream playback initialized:', {
        sampleRate: clientAudioContext.sampleRate,
        originalSampleRate: streamData.sampleRate,
      })

      clientStatus.textContent = 'Receiving live audio from host...'
    } catch (error) {
      console.error('Error initializing client audio streaming:', error)
      clientStatus.textContent = `Error initializing audio stream: ${error.message}`
    }
  }

  // Receiving audio stream data
  socket.on('audio-stream', (data) => {
    if (isHost || !audioAccepted || !clientAudioContext) return

    try {
      // Decode the audio data
      const audioData = decodeAudioData(data.audio)

      // Play the audio data
      playStreamedAudio(audioData, data.timestamp)
    } catch (error) {
      console.error('Error processing audio stream data:', error)
    }
  })

  // Decode audio data from base64 back to audio buffer
  function decodeAudioData(encodedData) {
    try {
      // Decode base64 string to binary
      const binaryString = atob(encodedData)
      const bytes = new Uint8Array(binaryString.length)

      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }

      // Convert to Int16Array first
      const int16Data = new Int16Array(bytes.buffer)

      // Convert Int16 back to Float32 for audio playback
      const floatData = new Float32Array(int16Data.length)
      for (let i = 0; i < int16Data.length; i++) {
        floatData[i] = int16Data[i] / 0x7fff
      }

      return floatData
    } catch (error) {
      console.error('Error decoding audio data:', error)
      return new Float32Array(0)
    }
  }

  // Play streamed audio data
  function playStreamedAudio(audioData, timestamp) {
    if (!clientAudioContext) return

    try {
      // Add incoming data to buffer
      audioStreamBuffer.push({
        data: audioData,
        timestamp: timestamp,
      })

      // Limit buffer size to prevent memory issues
      if (audioStreamBuffer.length > MAX_STREAM_BUFFER) {
        // Remove oldest items when buffer gets too large
        audioStreamBuffer.splice(
          0,
          audioStreamBuffer.length - MAX_STREAM_BUFFER
        )
        console.log('Stream buffer overflow, trimming to', MAX_STREAM_BUFFER)
      }

      // If we're buffering, check if we have enough data
      if (isBuffering) {
        // Show buffering status
        if (Math.random() < 0.2) {
          // Only update UI occasionally to avoid flicker
          clientStatus.textContent = `Buffering: ${audioStreamBuffer.length}/${STREAM_BUFFER_SIZE}`
        }

        // If we've buffered enough, start playback
        if (audioStreamBuffer.length >= STREAM_BUFFER_SIZE) {
          isBuffering = false
          clientStatus.textContent = 'Streaming audio resumed'
        } else {
          return // Still buffering, don't play yet
        }
      }

      // Once we have enough buffer, start playing
      if (audioStreamBuffer.length > 0) {
        // Take oldest item from buffer
        const streamItem = audioStreamBuffer.shift()
        const bufferAudioData = streamItem.data
        const itemTimestamp = streamItem.timestamp

        // Create buffer (mono)
        const buffer = clientAudioContext.createBuffer(
          1,
          bufferAudioData.length,
          clientAudioContext.sampleRate
        )
        buffer.getChannelData(0).set(bufferAudioData)

        // Create source and gain nodes
        const source = clientAudioContext.createBufferSource()
        source.buffer = buffer

        // Add a slight gain to improve audibility
        const gainNode = clientAudioContext.createGain()
        gainNode.gain.value = 1.2 // Boost volume slightly

        // Connect and play
        source.connect(gainNode)
        gainNode.connect(clientAudioContext.destination)
        source.start(0) // Play immediately

        // Calculate streaming latency - if it gets too high, start buffering again
        const currentLatency = Date.now() - itemTimestamp

        // If buffer is getting low and latency is high, start buffering again
        if (audioStreamBuffer.length < 2 && currentLatency > 300) {
          isBuffering = true
          clientStatus.textContent = 'Network delay detected, rebuffering...'
          console.log(
            `High stream latency: ${currentLatency}ms, starting rebuffer`
          )
        }

        // Log metrics occasionally
        if (Math.random() < 0.05) {
          console.log(
            `Stream metrics: latency=${currentLatency}ms, buffer=${audioStreamBuffer.length} chunks`
          )
        }
      }
    } catch (error) {
      console.error('Error playing streamed audio:', error)
      // Try to recover by clearing buffer and starting fresh
      audioStreamBuffer = []
      isBuffering = true
    }
  }

  // Host is stopping tab audio stream
  socket.on('tab-stream-stop', () => {
    if (isHost) return

    console.log('Host stopped tab audio stream')
    clientStatus.textContent = 'Host stopped audio streaming'

    // Clean up streaming resources
    if (clientStreamProcessor) {
      clientStreamProcessor.disconnect()
      clientStreamProcessor = null
    }

    // Remove streaming indicator
    const streamIndicator = document.querySelector('.streaming-active')
    if (streamIndicator) {
      streamIndicator.remove()
    }
  })

  // Handle YouTube close from host
  socket.on('youtube-close', () => {
    if (isHost) return

    console.log('Host closed YouTube player')
    closeYouTubePlayer()
    clientStatus.textContent = 'Host ended YouTube playback'
  })

  // Receive YouTube time update from host - store sync data for predictive sync
  socket.on('youtube-time-update', (data) => {
    if (isHost || !youtubePlayer) return

    // Store sync data for predictive algorithm
    window.lastYouTubeSyncData = {
      localTimestamp: Date.now(),
      hostTime: data.time,
      serverTimestamp: data.serverTimestamp,
      originTimestamp: data.timestamp,
      hostRate: data.rate || 1.0,
    }

    // Calculate network delay with server timestamp for higher accuracy
    const clientReceiveTime = Date.now()
    const totalDelay = (clientReceiveTime - data.timestamp) / 1000

    // Get more accurate delay using server timestamp if available
    let delay = totalDelay
    if (data.serverTimestamp) {
      const serverToClientDelay =
        (clientReceiveTime - data.serverTimestamp) / 1000
      const clientToServerDelay = (data.serverTimestamp - data.timestamp) / 1000
      delay = serverToClientDelay + clientToServerDelay
    }

    // Get current time and calculate difference
    const currentTime = youtubePlayer.getCurrentTime()
    const targetTime = data.time + delay // Add network delay compensation
    const diff = currentTime - targetTime
    const absDiff = Math.abs(diff)

    // For smaller differences, use playback rate adjustment (smoother)
    if (absDiff > 0.3 && absDiff < 1.0) {
      // Calculate adjustment factor: slower if ahead, faster if behind
      const adjustmentFactor = diff > 0 ? 0.95 : 1.05 // 5% adjustment

      // Apply the adjusted rate, preserving host's base rate
      const baseRate = data.rate || 1.0
      const newRate = baseRate * adjustmentFactor

      // Apply rate adjustment with limits
      youtubePlayer.setPlaybackRate(Math.max(0.8, Math.min(1.5, newRate)))

      console.log(
        `YouTube sync: Adjusting rate to ${newRate.toFixed(
          2
        )} (diff: ${diff.toFixed(2)}s)`
      )

      // Reset rate after brief adjustment period
      setTimeout(() => {
        // Only reset if we're still significantly synced
        if (
          Math.abs(youtubePlayer.getCurrentTime() - (targetTime + 0.5)) < 0.5
        ) {
          youtubePlayer.setPlaybackRate(baseRate)
        }
      }, 2000)
    }
    // Only seek for larger differences or if very precise sync needed
    else if (absDiff >= 1.0 || (Math.random() < 0.1 && absDiff > 0.5)) {
      console.log(
        `YouTube sync: current=${currentTime.toFixed(
          2
        )}, target=${targetTime.toFixed(2)}, diff=${diff.toFixed(2)}`
      )
      youtubePlayer.seekTo(targetTime, true)

      // Restore host's playback rate after seeking
      if (data.rate && data.rate !== 1.0) {
        youtubePlayer.setPlaybackRate(data.rate)
      }
    }

    // Every 10 updates, log sync status for debugging
    if (Math.random() < 0.1) {
      console.log(
        `YouTube sync status: diff=${diff.toFixed(2)}s, delay=${delay.toFixed(
          2
        )}s`
      )
    }
  })

  // Create room button click handler
  createRoomBtn.addEventListener('click', () => {
    connectionStatus.textContent = 'Creating room...'
    socket.emit('create-room')
  })

  // Join room button click handler
  joinRoomBtn.addEventListener('click', () => {
    const roomCode = roomCodeInput.value.trim().toUpperCase()

    if (!roomCode) {
      alert('Please enter a room code')
      return
    }

    connectionStatus.textContent = 'Joining room...'
    socket.emit('join-room', { roomCode })
  })

  // Allow entering on input field
  roomCodeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      joinRoomBtn.click()
    }
  })
})
